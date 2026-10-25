#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use chrono::{SecondsFormat, Utc};
use fs2::available_space;
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GITHUB_API: &str = "https://api.github.com";
const CHECKSUM_LIMIT: u64 = 1024;

#[derive(Debug)]
struct UpdateError {
    stage: &'static str,
    message: String,
}

impl UpdateError {
    fn new(stage: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, UpdateError>;

#[cfg(any(test, feature = "acceptance-api"))]
fn acceptance_mutex_diagnostic(result: Result<String>) -> (String, bool) {
    match result {
        Ok(name) => (format!("OK\n{}", name), true),
        Err(error) => (format!("ERROR {}: {}", error.stage, error.message), false),
    }
}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        Self::new("running", error.to_string())
    }
}

impl From<serde_json::Error> for UpdateError {
    fn from(error: serde_json::Error) -> Self {
        Self::new("running", error.to_string())
    }
}

#[derive(Debug)]
struct Args {
    install_root: PathBuf,
    release_root: PathBuf,
    update_id: String,
    target_version: String,
    repository: String,
}

#[derive(Debug, Deserialize)]
struct Asset {
    id: u64,
    name: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallConfig {
    install_root: PathBuf,
    active_release: PathBuf,
    data_root: PathBuf,
}

#[derive(Debug, Deserialize)]
struct ReleaseMetadata {
    version: String,
}

fn main() -> ExitCode {
    #[cfg(all(feature = "acceptance-api", windows))]
    if let Some(code) = run_acceptance_diagnostic() {
        return code;
    }
    if let Err(error) = run() {
        if let Ok(args) = parse_args() {
            let log_path = update_log_path(&args.install_root, &args.update_id);
            let _ = append_log(
                &log_path,
                &format!("FAILED {}: {}", error.stage, redact(&error.message)),
            );
            let _ = finish_failed(&args, &error);
        }
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let log_path = update_log_path(&args.install_root, &args.update_id);
    fs::create_dir_all(log_path.parent().expect("log directory"))?;
    append_log(&log_path, "Updater process started.")?;

    let context = validate_install(&args)?;
    write_progress(
        &args,
        "running",
        "checking",
        json!({
            "previousVersion": context.current_version,
            "latestVersion": format!("v{}", args.target_version),
            "executorConfirmed": true,
            "executorPid": std::process::id(),
            "executorPath": env::current_exe()?.to_string_lossy(),
            "operation": "online-update",
        }),
    )?;
    append_log(&log_path, "Startup handshake confirmed.")?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| UpdateError::new("checking", error.to_string()))?;
    let token = github_token(&args.release_root);
    let release = get_release(&client, &args, token.as_deref())?;
    validate_release(&release, &args)?;
    if release.draft && token.is_none() {
        return Err(UpdateError::new(
            "checking",
            "A draft GitHub Release requires authenticated access.",
        ));
    }

    let tag = format!("v{}", args.target_version);
    let installer_name = format!("ngt-studio-windows-setup-{}.exe", tag);
    let checksum_name = format!("{}.sha256", installer_name);
    let installer_asset = find_asset(&release, &installer_name)?;
    let checksum_asset = find_asset(&release, &checksum_name)?;
    let download_root = args.install_root.join(".local").join("updates");
    fs::create_dir_all(&download_root)?;
    let installer_path = download_root.join(format!("{}-{}", args.update_id, installer_name));
    let partial_path = installer_path.with_extension("exe.partial");

    write_progress(
        &args,
        "downloading",
        "downloading",
        json!({
            "bytesDownloaded": 0,
            "totalBytes": installer_asset.size,
            "progressKnown": true,
        }),
    )?;
    check_install_space(&args, &context, installer_asset.size)?;
    append_log(
        &log_path,
        &format!(
            "Downloading {} ({} bytes).",
            installer_name, installer_asset.size
        ),
    )?;

    let result = download_asset(
        &client,
        &args,
        installer_asset,
        token.as_deref(),
        &partial_path,
        &log_path,
    );
    let downloaded_hash = match result {
        Ok(hash) => hash,
        Err(error) => {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
    };
    fs::rename(&partial_path, &installer_path)
        .map_err(|error| UpdateError::new("downloading", error.to_string()))?;

    write_progress(
        &args,
        "verifying",
        "verifying",
        json!({
            "bytesDownloaded": installer_asset.size,
            "totalBytes": installer_asset.size,
            "progressKnown": true,
        }),
    )?;
    let checksum_path = download_root.join(format!("{}-{}", args.update_id, checksum_name));
    let checksum_partial = checksum_path.with_extension("sha256.partial");
    download_small_asset(
        &client,
        &args,
        checksum_asset,
        token.as_deref(),
        &checksum_partial,
    )?;
    let checksum_text = fs::read_to_string(&checksum_partial)?;
    fs::rename(&checksum_partial, &checksum_path)?;
    let expected_hash = parse_checksum(&checksum_text, &installer_name)?;
    if !digest_matches(&downloaded_hash, &expected_hash)
        || installer_asset.digest.as_deref().is_some_and(|digest| {
            !digest.eq_ignore_ascii_case(&format!("sha256:{}", expected_hash))
        })
    {
        let _ = fs::remove_file(&installer_path);
        let _ = fs::remove_file(&checksum_path);
        return Err(UpdateError::new(
            "verifying",
            "The installer checksum does not match the verified Release metadata.",
        ));
    }
    append_log(&log_path, "Installer size and SHA-256 verified.")?;

    write_progress(
        &args,
        "installing",
        "installing",
        json!({
            "bytesDownloaded": installer_asset.size,
            "totalBytes": installer_asset.size,
            "progressKnown": true,
        }),
    )?;
    let setup_result = run_installer(&args, &installer_path, &log_path)?;
    if let Err(error) = ensure_installer_succeeded(&args, &setup_result) {
        let _ = append_log(
            &log_path,
            &format!(
                "Inno Setup failed with exit code {}.",
                exit_code(&setup_result)
            ),
        );
        return Err(error);
    }
    append_log(
        &log_path,
        &format!("Inno Setup exited with code {}.", exit_code(&setup_result)),
    )?;

    write_progress(&args, "validating", "validating", json!({}))?;
    verify_installed_release(&args, &client)?;
    append_log(
        &log_path,
        "Installed release and application health verified.",
    )?;
    let cleanup_warning = remove_owned_downloads(&args.install_root, &args.update_id)
        .err()
        .map(|error| redact(&format!("{}: {}", error.stage, error.message)));
    write_progress(
        &args,
        "complete",
        "complete",
        json!({
            "actualVersion": args.target_version,
            "currentVersion": args.target_version,
            "executorAlive": false,
            "executorConfirmed": true,
            "progressKnown": false,
            "cleanupWarning": cleanup_warning.clone(),
        }),
    )?;
    if let Some(warning) = cleanup_warning {
        let _ = append_log(
            &log_path,
            &format!("Post-update cleanup warning: {}", warning),
        );
    }
    Ok(())
}

#[derive(Debug)]
struct InstallContext {
    current_version: String,
    active_release: PathBuf,
    data_root: PathBuf,
}

fn validate_install(args: &Args) -> Result<InstallContext> {
    let config: InstallConfig = read_json(&args.install_root.join(".local").join("studio.json"))?;
    if canonical(&config.install_root)? != canonical(&args.install_root)? {
        return Err(UpdateError::new(
            "checking",
            "The installed configuration points to a different installation directory.",
        ));
    }
    if canonical(&config.active_release)? != canonical(&args.release_root)? {
        return Err(UpdateError::new(
            "checking",
            "The running release is no longer the active installed release.",
        ));
    }
    let metadata: ReleaseMetadata = read_json(&args.release_root.join("studio-release.json"))?;
    let current = semver::Version::parse(&metadata.version)
        .map_err(|_| UpdateError::new("checking", "The installed version metadata is invalid."))?;
    let target = semver::Version::parse(&args.target_version)
        .map_err(|_| UpdateError::new("checking", "The requested target version is invalid."))?;
    if target <= current {
        return Err(UpdateError::new(
            "checking",
            "Downgrades and same-version online updates are not supported.",
        ));
    }
    let lock_path = args.install_root.join("update.lock");
    let lock: Value = read_json(&lock_path)?;
    if lock["updateId"] != args.update_id {
        return Err(UpdateError::new(
            "starting",
            "The updater task does not own the installed update lock.",
        ));
    }
    Ok(InstallContext {
        current_version: metadata.version,
        active_release: config.active_release,
        data_root: config.data_root,
    })
}

fn validate_release(release: &Release, args: &Args) -> Result<()> {
    let expected_tag = format!("v{}", args.target_version);
    if release.tag_name != expected_tag {
        return Err(UpdateError::new(
            "checking",
            "The selected GitHub Release tag changed after confirmation.",
        ));
    }
    if let Some(body) = &release.body {
        let marker = body
            .lines()
            .find(|line| line.contains("ngt-release-build:v1"))
            .unwrap_or_default()
            .trim()
            .trim_start_matches("<!--")
            .trim_end_matches("-->")
            .trim();
        let fields = marker
            .split_whitespace()
            .skip(1)
            .filter_map(|field| field.split_once('='))
            .collect::<BTreeMap<_, _>>();
        if !marker.starts_with("ngt-release-build:v1")
            || fields.get("tag") != Some(&expected_tag.as_str())
            || fields.get("version") != Some(&args.target_version.as_str())
            || !fields
                .get("sha")
                .is_some_and(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
            || !fields.get("identity").is_some_and(|identity| {
                identity.len() == 64 && identity.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(UpdateError::new(
                "checking",
                "The Release build identity marker is missing or does not match the requested version.",
            ));
        }
    } else {
        return Err(UpdateError::new(
            "checking",
            "The Release build identity marker is missing.",
        ));
    }
    let names = release
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect::<Vec<_>>();
    let mut expected = vec![
        format!("ngt-studio-windows-{}.zip", expected_tag),
        format!("ngt-studio-windows-{}.zip.sha256", expected_tag),
        format!("ngt-studio-runtime-{}.zip", expected_tag),
        format!("ngt-studio-runtime-{}.zip.sha256", expected_tag),
        format!("ngt-studio-windows-setup-{}.exe", expected_tag),
        format!("ngt-studio-windows-setup-{}.exe.sha256", expected_tag),
    ];
    expected.sort();
    let mut actual = names
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    actual.sort();
    if actual != expected || release.assets.iter().any(|asset| asset.size == 0) {
        return Err(UpdateError::new(
            "checking",
            "The Release asset inventory is incomplete or inconsistent.",
        ));
    }
    Ok(())
}

fn get_release(client: &Client, args: &Args, token: Option<&str>) -> Result<Release> {
    let url = format!(
        "{}/repos/{}/releases/tags/v{}",
        github_api_base(),
        args.repository,
        args.target_version
    );
    let mut request = client
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(USER_AGENT, "NGT-Studio-Updater");
    if let Some(token) = token {
        request = request.header(AUTHORIZATION, format!("Bearer {}", token));
    }
    let response = request
        .send()
        .map_err(|error| UpdateError::new("checking", error.to_string()))?;
    if !response.status().is_success() {
        return Err(UpdateError::new(
            "checking",
            format!(
                "GitHub Release lookup failed with HTTP {}.",
                response.status()
            ),
        ));
    }
    response
        .json()
        .map_err(|error| UpdateError::new("checking", error.to_string()))
}

fn github_token(release_root: &Path) -> Option<String> {
    if github_api_base() != GITHUB_API {
        return None;
    }
    let bundled = release_root.join("runtime").join("gh.exe");
    let cli = if bundled.exists() {
        bundled.to_string_lossy().into_owned()
    } else {
        "gh".to_owned()
    };
    let mut command = Command::new(cli);
    command.args(["auth", "token", "--hostname", "github.com"]);
    hide_console(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!token.is_empty()).then_some(token)
}

fn find_asset<'a>(release: &'a Release, name: &str) -> Result<&'a Asset> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name && asset.size > 0)
        .ok_or_else(|| {
            UpdateError::new(
                "checking",
                format!("The Release is missing required asset {}.", name),
            )
        })
}

fn download_asset(
    client: &Client,
    args: &Args,
    asset: &Asset,
    token: Option<&str>,
    destination: &Path,
    log_path: &Path,
) -> Result<String> {
    let response = send_asset_request(client, args, asset, token)?;
    if !response.status().is_success() {
        return Err(UpdateError::new(
            "downloading",
            format!("Installer download failed with HTTP {}.", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size != asset.size)
    {
        return Err(UpdateError::new(
            "downloading",
            "The installer response size does not match the Release asset size.",
        ));
    }
    let mut reader = response;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| UpdateError::new("downloading", error.to_string()))?;
    let mut writer = BufWriter::with_capacity(256 * 1024, file);
    let mut buffer = vec![0; 256 * 1024];
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_update = Instant::now();
    let mut last_reported_bytes = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| UpdateError::new("downloading", error.to_string()))?;
        if count == 0 {
            break;
        }
        downloaded += count as u64;
        if downloaded > asset.size {
            return Err(UpdateError::new(
                "downloading",
                "The installer download exceeded its declared size.",
            ));
        }
        hasher.update(&buffer[..count]);
        writer
            .write_all(&buffer[..count])
            .map_err(|error| UpdateError::new("downloading", error.to_string()))?;
        if last_update.elapsed() >= Duration::from_millis(500) {
            let elapsed = last_update.elapsed().as_secs_f64();
            let bytes_per_second =
                ((downloaded - last_reported_bytes) as f64 / elapsed).round() as u64;
            let eta_seconds = (asset.size - downloaded).checked_div(bytes_per_second);
            write_progress(
                args,
                "downloading",
                "downloading",
                json!({
                    "bytesDownloaded": downloaded,
                    "totalBytes": asset.size,
                    "bytesPerSecond": bytes_per_second,
                    "etaSeconds": eta_seconds,
                    "progressKnown": true,
                }),
            )?;
            last_update = Instant::now();
            last_reported_bytes = downloaded;
        }
    }
    writer
        .flush()
        .and_then(|_| writer.get_ref().sync_all())
        .map_err(|error| UpdateError::new("downloading", error.to_string()))?;
    if downloaded != asset.size {
        return Err(UpdateError::new(
            "downloading",
            format!(
                "The installer download was incomplete: received {} of {} bytes.",
                downloaded, asset.size
            ),
        ));
    }
    let digest = hex_digest(&hasher.finalize());
    append_log(log_path, &format!("Downloaded {} bytes.", downloaded))?;
    Ok(digest)
}

fn download_small_asset(
    client: &Client,
    args: &Args,
    asset: &Asset,
    token: Option<&str>,
    destination: &Path,
) -> Result<()> {
    if asset.size > CHECKSUM_LIMIT {
        return Err(UpdateError::new(
            "verifying",
            "The Release checksum sidecar is unexpectedly large.",
        ));
    }
    let response = send_asset_request(client, args, asset, token)?;
    if !response.status().is_success() {
        return Err(UpdateError::new(
            "verifying",
            format!(
                "Release checksum download failed with HTTP {}.",
                response.status()
            ),
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| UpdateError::new("verifying", error.to_string()))?;
    if bytes.len() as u64 != asset.size {
        return Err(UpdateError::new(
            "verifying",
            "The checksum sidecar size does not match the Release metadata.",
        ));
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| UpdateError::new("verifying", error.to_string()))?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|error| UpdateError::new("verifying", error.to_string()))
}

fn send_asset_request(
    client: &Client,
    args: &Args,
    asset: &Asset,
    token: Option<&str>,
) -> Result<Response> {
    let url = format!(
        "{}/repos/{}/releases/assets/{}",
        github_api_base(),
        args.repository,
        asset.id
    );
    let mut request = client
        .get(url)
        .header(ACCEPT, "application/octet-stream")
        .header(USER_AGENT, "NGT-Studio-Updater");
    if let Some(token) = token {
        request = request.header(AUTHORIZATION, format!("Bearer {}", token));
    }
    request
        .send()
        .map_err(|error| UpdateError::new("downloading", error.to_string()))
}

fn github_api_base() -> String {
    #[cfg(feature = "acceptance-api")]
    if env::var("GITHUB_ACTIONS").as_deref() == Ok("true") {
        if let Ok(value) = env::var("NGT_TEST_RELEASE_API_URL") {
            if let Some(port) = value.strip_prefix("http://127.0.0.1:") {
                if port.parse::<u16>().is_ok_and(|port| port > 0) {
                    return value;
                }
            }
        }
    }
    GITHUB_API.to_owned()
}

fn parse_checksum(contents: &str, expected_filename: &str) -> Result<String> {
    let mut fields = contents.split_whitespace();
    let hash = fields.next().unwrap_or_default();
    let filename = fields.next().unwrap_or_default().trim_start_matches('*');
    if fields.next().is_some()
        || hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || filename != expected_filename
    {
        return Err(UpdateError::new(
            "verifying",
            "The installer checksum sidecar is invalid.",
        ));
    }
    Ok(hash.to_ascii_lowercase())
}

fn check_install_space(args: &Args, context: &InstallContext, installer_size: u64) -> Result<()> {
    let release_size = directory_size(&context.active_release)?;
    let data_size = directory_size(&context.data_root.join("data"))?.saturating_add(
        fs::metadata(context.data_root.join("local-secrets.json"))
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    );
    let temp_dir = env::temp_dir();
    let mut required = installer_size
        .saturating_add(release_size)
        .saturating_add(release_size / 5);
    if same_volume(&args.install_root, &context.data_root) {
        required = required.saturating_add(data_size);
    }
    if same_volume(&args.install_root, &temp_dir) {
        required = required.saturating_add(release_size);
    }
    require_space(&args.install_root, required)?;
    if !same_volume(&args.install_root, &temp_dir) {
        require_space(&temp_dir, release_size.saturating_add(release_size / 5))?;
    }
    if !same_volume(&args.install_root, &context.data_root) {
        require_space(&context.data_root, data_size)?;
    }
    Ok(())
}

fn require_space(directory: &Path, required: u64) -> Result<()> {
    let available = available_space(directory)
        .map_err(|error| UpdateError::new("checking", error.to_string()))?;
    if available < required {
        return Err(UpdateError::new(
            "checking",
            format!(
                "There is not enough free disk space at {} ({} bytes available, at least {} required).",
                directory.display(),
                available,
                required
            ),
        ));
    }
    Ok(())
}

fn directory_size(directory: &Path) -> Result<u64> {
    let entries =
        fs::read_dir(directory).map_err(|error| UpdateError::new("checking", error.to_string()))?;
    let mut total = 0_u64;
    for entry in entries {
        let entry = entry.map_err(|error| UpdateError::new("checking", error.to_string()))?;
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|error| UpdateError::new("checking", error.to_string()))?;
        let size = if metadata.is_dir() {
            directory_size(&entry.path())?
        } else if metadata.is_file() {
            metadata.len()
        } else {
            0
        };
        total = total.saturating_add(size);
    }
    Ok(total)
}

fn same_volume(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::Component;
        let volume = |path: &Path| {
            path.components().find_map(|component| match component {
                Component::Prefix(prefix) => {
                    Some(prefix.as_os_str().to_string_lossy().to_lowercase())
                }
                _ => None,
            })
        };
        volume(left).is_some() && volume(left) == volume(right)
    }
    #[cfg(not(windows))]
    {
        let _ = (left, right);
        true
    }
}

fn run_installer(args: &Args, installer: &Path, log_path: &Path) -> Result<ExitStatus> {
    append_log(log_path, "Starting the verified Inno Setup installer.")?;
    let installer_log = log_path.with_file_name(format!("update-{}.inno.log", args.update_id));
    let mut command = Command::new(installer);
    command
        .arg("/VERYSILENT")
        .arg("/SUPPRESSMSGBOXES")
        .arg("/SP-")
        .arg("/NORESTART")
        .arg(format!("/LOG={}", installer_log.display()))
        .arg(format!("/NGTUpdateId={}", args.update_id));
    #[cfg(feature = "acceptance-api")]
    if let Some(stage) = take_acceptance_failure_stage(&args.install_root) {
        command.arg(format!("/NGTAcceptanceFailureStage={stage}"));
    }
    hide_console(&mut command);
    command
        .status()
        .map_err(|error| UpdateError::new("installing", error.to_string()))
}

#[cfg(feature = "acceptance-api")]
fn take_acceptance_failure_stage(install_root: &Path) -> Option<String> {
    if env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted")
    {
        return None;
    }
    let marker = install_root.join(".local").join("acceptance-failure-stage");
    let stage = fs::read_to_string(&marker).ok()?.trim().to_owned();
    if stage != "release-deployment" || fs::remove_file(marker).is_err() {
        return None;
    }
    Some(stage)
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn verify_installed_release(args: &Args, client: &Client) -> Result<()> {
    let config: InstallConfig = read_json(&args.install_root.join(".local").join("studio.json"))?;
    let active_release = canonical(&config.active_release)?;
    let expected_release = canonical(
        &args
            .install_root
            .join("releases")
            .join(format!("v{}", args.target_version)),
    )?;
    if active_release != expected_release {
        return Err(UpdateError::new(
            "validating",
            "The installed configuration does not point to the requested release.",
        ));
    }
    let metadata: ReleaseMetadata = read_json(&active_release.join("studio-release.json"))?;
    if metadata.version != args.target_version {
        return Err(UpdateError::new(
            "validating",
            "The active application release version does not match the requested version.",
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    let mut delay = Duration::from_secs(1);
    while Instant::now() < deadline {
        if let Ok(response) = client
            .get("http://127.0.0.1:3000/api/health")
            .timeout(Duration::from_secs(10))
            .send()
        {
            if response.status().is_success() {
                if let Ok(body) = response.json::<Value>() {
                    if body["status"] == "ok" && body["currentVersion"] == args.target_version {
                        return Ok(());
                    }
                }
            }
        }
        thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(15));
    }
    Err(UpdateError::new(
        "validating",
        "The updated application did not pass its versioned health check within ten minutes.",
    ))
}

fn ensure_installer_succeeded(args: &Args, installer: &ExitStatus) -> Result<()> {
    if installer.success() {
        return Ok(());
    }
    Err(installer_exit_error(
        &args.install_root,
        &args.update_id,
        exit_code(installer),
    ))
}

fn installer_exit_error(install_root: &Path, update_id: &str, exit_code: String) -> UpdateError {
    UpdateError::new(
        "installing",
        format!(
            "Inno Setup exited with code {}. See {} and install-preflight.log for the original installer diagnostics.",
            exit_code,
            update_log_path(install_root, update_id)
                .with_file_name(format!("update-{}.inno.log", update_id)).display()
        ),
    )
}

fn write_progress(
    args: &Args,
    status: &'static str,
    stage: &'static str,
    fields: Value,
) -> Result<()> {
    with_update_mutex(&args.install_root, || {
        let lock_path = args.install_root.join("update.lock");
        let mut lock: Value = read_json(&lock_path)?;
        if lock["updateId"] != args.update_id {
            return Err(UpdateError::new(
                stage,
                "The updater no longer owns the current update task.",
            ));
        }
        lock["executorPid"] = json!(std::process::id());
        lock["executorPath"] = json!(env::current_exe()?.to_string_lossy());
        lock["operation"] = json!("online-update");
        write_json_atomic(&lock_path, &lock)?;

        let status_path = args.install_root.join("update-status.json");
        let mut state: Value = read_json(&status_path)?;
        if state["updateId"] != args.update_id {
            return Err(UpdateError::new(
                stage,
                "The saved task status belongs to a different update.",
            ));
        }
        state["status"] = json!(status);
        state["stage"] = json!(stage);
        state["operation"] = json!("online-update");
        state["updateId"] = json!(args.update_id);
        state["targetVersion"] = json!(args.target_version);
        state["latestVersion"] = json!(format!("v{}", args.target_version));
        state["executorPid"] = json!(std::process::id());
        state["executorPath"] = json!(env::current_exe()?.to_string_lossy());
        state["executorAlive"] = json!(true);
        state["updatedAt"] = json!(now());
        if let Value::Object(fields) = fields {
            for (key, value) in fields {
                state[key] = value;
            }
        }
        write_json_atomic(&status_path, &state)
    })
}

fn finish_failed(args: &Args, error: &UpdateError) -> Result<()> {
    if !args.install_root.exists() {
        return Ok(());
    }
    with_update_mutex(&args.install_root, || {
        let status_path = args.install_root.join("update-status.json");
        let mut state: Value = match read_json(&status_path) {
            Ok(value) => value,
            Err(_) => return Ok(()),
        };
        if state["updateId"] != args.update_id {
            return Ok(());
        }
        if state["status"] == "complete" {
            return Ok(());
        }
        let installer_stage = failure_stage(&state, error);
        state["status"] = json!("failed");
        state["stage"] = json!(installer_stage);
        state["failedStage"] = json!(installer_stage);
        if state["message"].as_str().is_none_or(str::is_empty) {
            state["message"] = json!(redact(&error.message));
        } else if let Some(message) = state["message"].as_str() {
            state["message"] = json!(redact(message));
        }
        state["exitReason"] = json!(redact(&error.message));
        state["executorAlive"] = json!(false);
        state["executorConfirmed"] = json!(true);
        state["updatedAt"] = json!(now());
        if state["recoveryStatus"].is_null() {
            state["recoveryStatus"] = json!("not-started");
        }
        if state["recoveryStatus"] == "failed"
            || args
                .install_root
                .join(".local")
                .join("update-maintenance.json")
                .exists()
        {
            state["manualReview"] = json!(true);
        }
        write_json_atomic(&status_path, &state)?;
        let _ = remove_owned_downloads(&args.install_root, &args.update_id);
        Ok(())
    })
}

fn failure_stage(state: &Value, error: &UpdateError) -> String {
    state["failedStage"]
        .as_str()
        .or_else(|| {
            (state["status"] == "failed")
                .then(|| state["stage"].as_str())
                .flatten()
        })
        .filter(|stage| !stage.is_empty())
        .unwrap_or(error.stage)
        .to_owned()
}

fn remove_owned_downloads(install_root: &Path, update_id: &str) -> Result<()> {
    let directory = install_root.join(".local").join("updates");
    if !directory.exists() {
        return Ok(());
    }
    let prefix = format!("{}-", update_id);
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let owned_name = path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(&prefix));
        let owned_download = path.extension().is_some_and(|extension| {
            extension == "exe" || extension == "sha256" || extension == "partial"
        });
        if owned_name && owned_download && path.is_file() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut values = BTreeMap::new();
    let mut arguments = env::args_os().skip(1);
    while let Some(key) = arguments.next() {
        let key = key.to_string_lossy().into_owned();
        if !key.starts_with("--") {
            return Err(UpdateError::new(
                "starting",
                "Updater arguments are invalid.",
            ));
        }
        let value = arguments
            .next()
            .ok_or_else(|| UpdateError::new("starting", "Updater arguments are incomplete."))?;
        values.insert(key, value);
    }
    let take_path = |values: &mut BTreeMap<String, std::ffi::OsString>, key: &str| {
        values.remove(key).map(PathBuf::from)
    };
    let install_root = take_path(&mut values, "--install-root")
        .ok_or_else(|| UpdateError::new("starting", "The install root is required."))?;
    let release_root = take_path(&mut values, "--release-root")
        .ok_or_else(|| UpdateError::new("starting", "The active release root is required."))?;
    let take_text = |values: &mut BTreeMap<String, std::ffi::OsString>, key: &str| {
        values
            .remove(key)
            .and_then(|value| value.into_string().ok())
    };
    let update_id = take_text(&mut values, "--update-id")
        .filter(|value| is_uuid(value))
        .ok_or_else(|| UpdateError::new("starting", "The update ID is invalid."))?;
    let target_version = take_text(&mut values, "--target-version")
        .filter(|value| semver::Version::parse(value).is_ok())
        .ok_or_else(|| UpdateError::new("starting", "The target version is invalid."))?;
    let repository = take_text(&mut values, "--repository")
        .filter(|value| {
            let mut parts = value.split('/');
            matches!(
                (parts.next(), parts.next(), parts.next()),
                (Some(owner), Some(repo), None)
                    if !owner.is_empty()
                        && !repo.is_empty()
                        && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                        && repo.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            )
        })
        .ok_or_else(|| UpdateError::new("starting", "The Release repository is invalid."))?;
    if !values.is_empty() {
        return Err(UpdateError::new(
            "starting",
            "Updater arguments contain unknown values.",
        ));
    }
    Ok(Args {
        install_root,
        release_root,
        update_id,
        target_version,
        repository,
    })
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).map_err(|error| {
        UpdateError::new(
            "starting",
            format!("Unable to read {}: {}", path.display(), error),
        )
    })?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|error| {
        UpdateError::new(
            "starting",
            format!("Unable to parse {}: {}", path.display(), error),
        )
    })
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| UpdateError::new("running", "Update state has no parent directory."))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(UpdateError::new(
            "running",
            "Unable to atomically save update state.",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination).map_err(|error| UpdateError::new("running", error.to_string()))
}

fn with_update_mutex<T>(install_root: &Path, action: impl FnOnce() -> Result<T>) -> Result<T> {
    #[cfg(windows)]
    let _guard = WindowsMutex::acquire(install_root)?;
    #[cfg(not(windows))]
    let _ = install_root;
    action()
}

#[cfg(windows)]
struct WindowsMutex(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl WindowsMutex {
    fn acquire(install_root: &Path) -> Result<Self> {
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        let mutex_name = update_mutex_name(install_root)?;
        let name: Vec<u16> = mutex_name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(UpdateError::new(
                "running",
                "Unable to create the update mutex.",
            ));
        }
        let result = unsafe { WaitForSingleObject(handle, 15_000) };
        if result != WAIT_OBJECT_0 && result != WAIT_ABANDONED {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(UpdateError::new(
                "running",
                if result == windows_sys::Win32::Foundation::WAIT_TIMEOUT {
                    "Timed out waiting for the update mutex after 15 seconds."
                } else {
                    "Unable to acquire the update mutex."
                },
            ));
        }
        Ok(Self(handle))
    }
}

fn update_mutex_name(install_root: &Path) -> Result<String> {
    let path = canonical(install_root)?;
    let identity = normalize_mutex_root(&path.to_string_lossy());
    let digest = hex_digest(&Sha256::digest(identity.as_bytes()));
    Ok(format!("Global\\NGTStudioUpdate-{}", digest))
}

fn normalize_mutex_root(path: &str) -> String {
    let mut root = path.replace('/', "\\");
    if root
        .get(..8)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\UNC\\"))
    {
        root = format!("\\\\{}", &root[8..]);
    } else if root
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("\\\\?\\"))
    {
        root = root[4..].to_owned();
    }
    root.trim_end_matches('\\').to_lowercase()
}

#[cfg(windows)]
impl Drop for WindowsMutex {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            ReleaseMutex(self.0);
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn append_log(path: &Path, message: &str) -> Result<()> {
    fs::create_dir_all(path.parent().expect("log directory"))?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{} {}", now(), redact(message))?;
    file.sync_data()?;
    Ok(())
}

fn update_log_path(install_root: &Path, update_id: &str) -> PathBuf {
    install_root
        .join("logs")
        .join(format!("update-{}.log", update_id))
}

fn canonical(path: &Path) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|error| {
        UpdateError::new(
            "checking",
            format!("Unable to resolve installation path: {}", error),
        )
    })
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn digest_matches(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected)
}

fn exit_code(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

fn redact(message: &str) -> String {
    const GITHUB_TOKEN_PREFIXES: [&str; 6] =
        ["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
    let bytes = message.as_bytes();
    let mut output = String::with_capacity(message.len());
    let mut index = 0;
    while index < bytes.len() {
        if let Some((end, replacement)) = redact_header_value(message, index) {
            output.push_str(&replacement);
            index = end;
            continue;
        }
        if let Some((end, replacement)) = redact_sensitive_assignment(message, index) {
            output.push_str(&replacement);
            index = end;
            continue;
        }
        if let Some(prefix) = GITHUB_TOKEN_PREFIXES
            .iter()
            .find(|prefix| ascii_starts_with_ignore_case(message, index, prefix))
        {
            let mut end = index + prefix.len();
            while end < bytes.len() && is_token_byte(bytes[end]) {
                end += 1;
            }
            output.push_str("[redacted]");
            index = end;
            continue;
        }
        if let Some((end, replacement)) = redact_url_credentials(message, index) {
            output.push_str(&replacement);
            index = end;
            continue;
        }
        let character = message[index..]
            .chars()
            .next()
            .expect("valid UTF-8 boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn redact_header_value(message: &str, index: usize) -> Option<(usize, String)> {
    let header = ["proxy-authorization", "authorization"]
        .into_iter()
        .find(|header| ascii_starts_with_ignore_case(message, index, header))?;
    let bytes = message.as_bytes();
    let mut cursor = index + header.len();
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor == bytes.len() || !matches!(bytes[cursor], b':' | b'=') {
        return None;
    }
    let delimiter = bytes[cursor] as char;
    cursor += 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let scheme = ["Bearer", "Basic"]
        .into_iter()
        .find(|scheme| ascii_starts_with_ignore_case(message, cursor, scheme));
    let original_header = &message[index..index + header.len()];
    let mut replacement = format!("{}{}", original_header, delimiter);
    if let Some(scheme) = scheme {
        let after_scheme = cursor + scheme.len();
        if after_scheme < bytes.len() && bytes[after_scheme].is_ascii_whitespace() {
            let mut value_start = after_scheme;
            while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                value_start += 1;
            }
            replacement.push(' ');
            replacement.push_str(scheme);
            replacement.push(' ');
            let (end, redacted) = redact_value(message, value_start);
            replacement.push_str(&redacted);
            cursor = end;
            return Some((cursor, replacement));
        }
    }
    let (end, redacted) = redact_value(message, cursor);
    replacement.push_str(&redacted);
    cursor = end;
    Some((cursor, replacement))
}

fn redact_sensitive_assignment(message: &str, index: usize) -> Option<(usize, String)> {
    let bytes = message.as_bytes();
    if index > 0 && is_identifier_byte(bytes[index - 1]) {
        return None;
    }
    let mut cursor = index;
    while cursor < bytes.len() && (is_identifier_byte(bytes[cursor]) || bytes[cursor] == b'-') {
        cursor += 1;
    }
    if cursor == index {
        return None;
    }
    let key = message[index..cursor]
        .to_ascii_lowercase()
        .replace('-', "_");
    let sensitive = [
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "credential",
        "private_key",
        "privatekey",
        "api_key",
        "apikey",
        "client_secret",
        "clientsecret",
        "database_url",
        "databaseurl",
        "db_url",
        "dburl",
    ]
    .iter()
    .any(|marker| key.contains(marker));
    if !sensitive {
        return None;
    }
    if index > 0
        && matches!(bytes[index - 1], b'\'' | b'"')
        && bytes.get(cursor) == Some(&bytes[index - 1])
    {
        cursor += 1;
    }
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor == bytes.len() || !matches!(bytes[cursor], b'=' | b':') {
        return None;
    }
    cursor += 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let (end, redacted) = redact_value(message, cursor);
    if end == cursor {
        return None;
    }
    Some((end, format!("{}{}", &message[index..cursor], redacted)))
}

fn redact_value(message: &str, start: usize) -> (usize, String) {
    let bytes = message.as_bytes();
    if start >= bytes.len() {
        return (start, String::new());
    }
    if matches!(bytes[start], b'\'' | b'"') {
        let quote = bytes[start];
        let mut end = start + 1;
        while end < bytes.len() {
            if bytes[end] == b'\\' && end + 1 < bytes.len() {
                end += 2;
                continue;
            }
            if bytes[end] == quote {
                return (
                    end + 1,
                    format!("{}[redacted]{}", quote as char, quote as char),
                );
            }
            end += 1;
        }
        return (end, format!("{}[redacted]", quote as char));
    }
    let mut end = start;
    while end < bytes.len() && !is_secret_delimiter(bytes[end]) {
        end += 1;
    }
    if end == start {
        (end, String::new())
    } else {
        (end, "[redacted]".to_owned())
    }
}

fn redact_url_credentials(message: &str, index: usize) -> Option<(usize, String)> {
    if index > 0 && is_identifier_byte(message.as_bytes()[index - 1]) {
        return None;
    }
    let bytes = message.as_bytes();
    let mut authority_start = index;
    if !bytes.get(authority_start)?.is_ascii_alphabetic() {
        return None;
    }
    authority_start += 1;
    while authority_start < bytes.len()
        && (bytes[authority_start].is_ascii_alphanumeric()
            || matches!(bytes[authority_start], b'+' | b'-' | b'.'))
    {
        authority_start += 1;
    }
    if message.get(authority_start..authority_start + 3)? != "://" {
        return None;
    }
    let start_of_authority = authority_start + 3;
    let mut end = start_of_authority;
    while end < bytes.len()
        && !matches!(
            bytes[end],
            b'/' | b'?' | b'#' | b' ' | b'\t' | b'\r' | b'\n' | b'\'' | b'"' | b')'
        )
    {
        end += 1;
    }
    let authority = &message[start_of_authority..end];
    let user_info_end = authority.rfind('@')?;
    let user_info = &authority[..user_info_end];
    if !user_info.contains(':') {
        return None;
    }
    Some((
        end,
        format!(
            "{}://[redacted]@{}",
            &message[index..authority_start],
            &authority[user_info_end + 1..]
        ),
    ))
}

fn ascii_starts_with_ignore_case(value: &str, index: usize, needle: &str) -> bool {
    value
        .as_bytes()
        .get(index..index.saturating_add(needle.len()))
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(needle.as_bytes()))
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn is_secret_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b',' | b';' | b'\'' | b'"' | b')')
}

#[cfg(all(feature = "acceptance-api", windows))]
fn run_acceptance_diagnostic() -> Option<ExitCode> {
    use std::ffi::OsStr;
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next()?;
    if command != OsStr::new("--test-mutex-name") {
        return None;
    }
    let Some(root) = arguments.next().map(PathBuf::from) else {
        return Some(ExitCode::FAILURE);
    };
    let Some(output_path) = arguments.next().map(PathBuf::from) else {
        return Some(ExitCode::FAILURE);
    };
    if arguments.next().is_some() {
        return Some(ExitCode::FAILURE);
    }
    let (diagnostic, success) = acceptance_mutex_diagnostic(update_mutex_name(&root));
    match fs::write(output_path, diagnostic) {
        Ok(()) => Some(if success {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }),
        Err(_) => Some(ExitCode::from(2)),
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn same_volume_compares_drive_prefix_case_insensitively() {
        assert!(same_volume(
            Path::new(r"C:\NGT\Install"),
            Path::new(r"c:\NGT\Data"),
        ));
        assert!(!same_volume(
            Path::new(r"C:\NGT\Install"),
            Path::new(r"D:\NGT\Data"),
        ));
        assert!(!same_volume(
            Path::new("relative"),
            Path::new(r"C:\NGT\Data"),
        ));
    }

    #[test]
    fn acceptance_mutex_diagnostic_preserves_success_and_failure_details() {
        assert_eq!(
            acceptance_mutex_diagnostic(Ok("Global\\NGTStudioUpdate-test".to_owned())),
            ("OK\nGlobal\\NGTStudioUpdate-test".to_owned(), true)
        );
        assert_eq!(
            acceptance_mutex_diagnostic(Err(UpdateError::new("checking", "path unavailable"))),
            ("ERROR checking: path unavailable".to_owned(), false)
        );
    }

    #[test]
    fn checksum_requires_matching_filename_and_sha256() {
        assert_eq!(
            parse_checksum(
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  update.exe",
                "update.exe"
            )
            .unwrap(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );
        assert!(parse_checksum("abcd  update.exe", "update.exe").is_err());
        assert!(parse_checksum(&format!("{}  other.exe", "a".repeat(64)), "update.exe").is_err());
        assert!(parse_checksum(
            &format!("{}  update.exe extra", "a".repeat(64)),
            "update.exe"
        )
        .is_err());
    }

    #[test]
    fn release_requires_the_exact_version_and_complete_asset_inventory() {
        let tag = "v2.1.0";
        let names = [
            format!("ngt-studio-windows-{}.zip", tag),
            format!("ngt-studio-windows-{}.zip.sha256", tag),
            format!("ngt-studio-runtime-{}.zip", tag),
            format!("ngt-studio-runtime-{}.zip.sha256", tag),
            format!("ngt-studio-windows-setup-{}.exe", tag),
            format!("ngt-studio-windows-setup-{}.exe.sha256", tag),
        ];
        let release = Release {
            tag_name: tag.to_owned(),
            body: Some(format!(
                "<!-- ngt-release-build:v1 tag={} sha={} version=2.1.0 identity={} -->",
                tag,
                "a".repeat(40),
                "b".repeat(64)
            )),
            draft: true,
            assets: names
                .iter()
                .enumerate()
                .map(|(id, name)| Asset {
                    id: id as u64,
                    name: name.clone(),
                    size: 10,
                    digest: None,
                })
                .collect(),
        };
        let args = Args {
            install_root: PathBuf::new(),
            release_root: PathBuf::new(),
            update_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            target_version: "2.1.0".to_owned(),
            repository: "JayWangsj/ngt1".to_owned(),
        };
        assert!(validate_release(&release, &args).is_ok());
        let mut incomplete = release;
        incomplete.assets.pop();
        assert!(validate_release(&incomplete, &args).is_err());
    }

    #[test]
    fn task_id_is_strictly_validated() {
        assert!(is_uuid("fbe63b6c-5400-41f4-b682-a83238ed879b"));
        assert!(!is_uuid("../bad"));
        assert!(!is_uuid("00000000-0000-0000-0000-000000000000/other"));
    }

    #[test]
    fn install_space_estimate_counts_nested_files() {
        let root = env::temp_dir().join(format!(
            "ngt-updater-size-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("small.bin"), b"12345").unwrap();
        fs::write(root.join("nested").join("larger.bin"), b"1234567890").unwrap();
        assert_eq!(directory_size(&root).unwrap(), 15);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installer_exit_failure_keeps_the_installer_stage_and_log_location() {
        let error = installer_exit_error(
            Path::new("C:\\NGT"),
            "00000000-0000-4000-8000-000000000001",
            "23".to_owned(),
        );
        assert_eq!(error.stage, "installing");
        assert!(error.message.contains("code 23"));
        assert!(error
            .message
            .contains("update-00000000-0000-4000-8000-000000000001.inno.log"));
        assert!(error.message.contains("install-preflight.log"));
    }

    #[test]
    fn updater_redacts_complete_secrets_and_quoted_values() {
        let message = redact(
            "Authorization: Bearer   abc123; password=\"hunter2\"; \"password\" : \"json-secret\"; \"databaseUrl\":\"postgres://dbuser:dbpass@example.com/app\" url=https://user:pass@example.com/path token=ghp_abcdefghijklmnopqrstuvwxyz",
        );
        assert!(message.contains("Authorization: Bearer [redacted]"));
        assert!(message.contains("password=\"[redacted]\""));
        assert!(message.contains("\"password\" : \"[redacted]\""));
        assert!(message.contains("\"databaseUrl\":\"[redacted]\""));
        assert!(message.contains("https://[redacted]@example.com/path"));
        assert!(message.contains("token=[redacted]"));
        for secret in [
            "abc123",
            "hunter2",
            "json-secret",
            "dbuser:dbpass",
            "user:pass",
            "ghp_abcdefghijklmnopqrstuvwxyz",
        ] {
            assert!(!message.contains(secret));
        }
    }

    #[test]
    fn installer_failure_does_not_inherit_a_stale_backup_stage() {
        let installer_error = UpdateError::new("installing", "installer failed");
        assert_eq!(
            failure_stage(
                &json!({ "status": "installing", "stage": "backing-up" }),
                &installer_error
            ),
            "installing"
        );
        assert_eq!(
            failure_stage(
                &json!({ "status": "failed", "stage": "preflight", "failedStage": "preflight" }),
                &installer_error
            ),
            "preflight"
        );
    }

    #[test]
    fn mutex_root_normalization_handles_verbatim_and_unc_paths() {
        assert_eq!(
            normalize_mutex_root(r"\\?\C:\NGT\Install\"),
            r"c:\ngt\install"
        );
        assert_eq!(
            normalize_mutex_root(r"\\?\UNC\server\share\NGT\"),
            r"\\server\share\ngt"
        );
    }

    #[test]
    fn completed_update_state_is_not_downgraded_by_late_failure() {
        let root = env::temp_dir().join(format!(
            "ngt-updater-complete-state-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".local")).unwrap();
        let update_id = "00000000-0000-4000-8000-000000000001";
        let state = root.join("update-status.json");
        fs::write(
            &state,
            json!({"status":"complete", "updateId":update_id, "stage":"complete"}).to_string(),
        )
        .unwrap();
        let args = Args {
            install_root: root.clone(),
            release_root: root.clone(),
            update_id: update_id.to_owned(),
            target_version: "2.1.0".to_owned(),
            repository: "JayWangsj/ngt1".to_owned(),
        };
        finish_failed(&args, &UpdateError::new("running", "late log failure")).unwrap();
        let saved: Value = read_json(&state).unwrap();
        assert_eq!(saved["status"], "complete");
        assert_eq!(saved["stage"], "complete");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_update_cleanup_removes_only_current_downloads() {
        let root = env::temp_dir().join(format!(
            "ngt-updater-owned-downloads-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let updates = root.join(".local").join("updates");
        fs::create_dir_all(&updates).unwrap();
        let update_id = "00000000-0000-4000-8000-000000000001";
        fs::write(
            updates.join(format!("{}-setup.exe", update_id)),
            b"installer",
        )
        .unwrap();
        fs::write(
            updates.join(format!("{}-setup.exe.sha256", update_id)),
            b"checksum",
        )
        .unwrap();
        fs::write(
            updates.join("00000000-0000-4000-8000-000000000002-setup.exe"),
            b"other",
        )
        .unwrap();
        fs::write(updates.join(format!("{}-backup.zip", update_id)), b"backup").unwrap();
        remove_owned_downloads(&root, update_id).unwrap();
        assert!(!updates.join(format!("{}-setup.exe", update_id)).exists());
        assert!(!updates
            .join(format!("{}-setup.exe.sha256", update_id))
            .exists());
        assert!(updates
            .join("00000000-0000-4000-8000-000000000002-setup.exe")
            .exists());
        assert!(updates.join(format!("{}-backup.zip", update_id)).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
