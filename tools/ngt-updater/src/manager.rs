use crate::diagnostics::{self, Component as DiagnosticComponent, LogOwner, LogSession};
use crate::memory_sample;
use fs2::available_space;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TRANSACTION_VERSION: u32 = 3;
const CONFIG_VERSION: u32 = 1;
const DATABASE_PORT: u16 = 55432;
const APPLICATION_PORT: u16 = 3000;
const REQUIRED_RUNTIME_FILES: [&str; 17] = [
    "runtime/node.exe",
    "runtime/gh.exe",
    "runtime/postgres/bin/postgres.exe",
    "runtime/postgres/bin/initdb.exe",
    "runtime/postgres/bin/pg_ctl.exe",
    "runtime/postgres/bin/pg_controldata.exe",
    "tools/NGTManager.exe",
    "tools/NGTUpdater.exe",
    "assets/ngt-studio.ico",
    "assets/ngt-studio-light.ico",
    "assets/ngt-studio-dark.ico",
    "scripts/windows-db.mjs",
    "scripts/start.mjs",
    "scripts/runtime-start-gate.cjs",
    "scripts/postgres-runtime.mjs",
    "scripts/run-pg-ctl.mjs",
    "node_modules/prisma/build/index.js",
];

#[cfg(windows)]
static WINDOWS_SESSION_END: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static WINDOWS_SESSION_END_TICK: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static RUNTIME_UI_WINDOW: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_TITLE: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_LOGO: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_VERSION: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_HEADING: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_STATUS: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_DETAIL: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_STEP: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_PROGRESS: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_PHASE_STARTED_TICK: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static RUNTIME_HEALTHY: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static RUNTIME_UI_HIGH_CONTRAST: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static TRAY_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static MANAGED_BROWSER_WINDOW: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static MANAGED_BROWSER_PROCESS_ID: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static MANAGED_BROWSER_PROCESS_CREATED: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static BROWSER_OPENING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static BROWSER_WINDOW_EXPECTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static BROWSER_REQUEST: Mutex<Option<(BTreeSet<isize>, PathBuf)>> = Mutex::new(None);
#[cfg(windows)]
static PROVISIONAL_BROWSER_WINDOW: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static PROVISIONAL_BROWSER_PROCESS_ID: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static PROVISIONAL_BROWSER_PROCESS_CREATED: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static RUNTIME_UI_CARD: AtomicIsize = AtomicIsize::new(0);
#[cfg(windows)]
static RUNTIME_UI_CARD_BRUSH: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
const RUNTIME_UI_TRAY_MESSAGE: u32 = 0x8001;
#[cfg(windows)]
const RUNTIME_UI_PHASE_MESSAGE: u32 = 0x8002;
#[cfg(windows)]
const RUNTIME_UI_OPEN_MESSAGE: u32 = 0x8003;
#[cfg(windows)]
const RUNTIME_UI_SHOW_MESSAGE: u32 = 0x8004;
#[cfg(windows)]
const RUNTIME_UI_HIDE_MESSAGE: u32 = 0x8005;
#[cfg(windows)]
const RUNTIME_UI_REFLOW_MESSAGE: u32 = 0x8006;
#[cfg(windows)]
const RUNTIME_UI_SETTINGS_MESSAGE: u32 = 0x8007;
#[cfg(windows)]
const RUNTIME_UI_PHASE_CHECKING: usize = 1;
#[cfg(windows)]
const RUNTIME_UI_PHASE_DATABASE: usize = 2;
#[cfg(windows)]
const RUNTIME_UI_PHASE_APPLICATION: usize = 3;
#[cfg(windows)]
const RUNTIME_UI_PHASE_HEALTH: usize = 4;
#[cfg(windows)]
const RUNTIME_UI_PHASE_READY: usize = 5;
#[cfg(windows)]
const RUNTIME_UI_PHASE_BROWSER_BLOCKED: usize = 6;
#[cfg(windows)]
const RUNTIME_UI_PHASE_EXITING: usize = 7;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Operation {
    Install,
    Update,
    Repair,
    Uninstall,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Stage {
    Preparing,
    Staged,
    Maintenance,
    BackupCreating,
    BackupCreated,
    BackupVerifying,
    BackupVerified,
    Migrated,
    CandidateHealthy,
    Switching,
    Uninstalling,
    Committed,
    RollingBack,
    RolledBack,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    format_version: u32,
    operation_id: String,
    operation: Operation,
    stage: Stage,
    previous_release: Option<PathBuf>,
    candidate_release: Option<PathBuf>,
    backup_root: Option<PathBuf>,
    #[serde(default)]
    previous_config: Option<ManagerConfig>,
    #[serde(default)]
    migration_started: bool,
    #[serde(default)]
    database_was_present: bool,
    #[serde(default)]
    database_directory_was_empty: bool,
    #[serde(default)]
    database_initialization_directory: Option<PathBuf>,
    #[serde(default)]
    database_initialization_owned: bool,
    #[serde(default)]
    database_initialization_published: bool,
    failure: Option<String>,
    #[serde(default)]
    restore_verified: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PostgresDirectoryState {
    Missing,
    Empty,
    Initialized,
}

struct PreflightResult {
    root: PathBuf,
    package_bytes: u64,
    database_bytes: u64,
    manifest: ReleaseManifest,
}

fn inspect_postgres_directory(database: &Path) -> Result<PostgresDirectoryState, String> {
    let metadata = match fs::symlink_metadata(database) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PostgresDirectoryState::Missing)
        }
        Err(error) => return Err(format!("Unable to inspect the database directory: {error}")),
    };
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err("The database directory is not a regular directory.".to_owned());
    }

    match fs::symlink_metadata(database.join("PG_VERSION")) {
        Ok(version) if version.is_file() && !is_reparse(&version) => {
            Ok(PostgresDirectoryState::Initialized)
        }
        Ok(_) => Err("The existing database directory is incomplete; data was preserved for manual recovery.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut entries = fs::read_dir(database)
                .map_err(|error| format!("Unable to inspect the database directory: {error}"))?;
            match entries.next() {
                None => Ok(PostgresDirectoryState::Empty),
                Some(Ok(_)) => Err("The existing database directory is incomplete; data was preserved for manual recovery.".to_owned()),
                Some(Err(error)) => Err(format!("Unable to inspect database directory contents: {error}")),
            }
        }
        Err(error) => Err(format!("Unable to inspect database version: {error}")),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    version: String,
    commit: String,
    files: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagerConfig {
    format_version: u32,
    install_root: PathBuf,
    active_release: PathBuf,
    data_root: PathBuf,
    version: String,
    repository: String,
    maintenance: bool,
}

fn stable_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCALAPPDATA is unavailable for this user.".to_owned())?;
    Ok(PathBuf::from(local).join("NGTManager"))
}

fn verify_release(root: &Path) -> Result<ReleaseManifest, String> {
    verify_release_with_progress(root, None)
}

fn verify_release_with_progress(
    root: &Path,
    progress: Option<&InstallProgress>,
) -> Result<ReleaseManifest, String> {
    verify_release_until(root, progress, None)
}

fn verify_release_until(
    root: &Path,
    progress: Option<&InstallProgress>,
    deadline: Option<Instant>,
) -> Result<ReleaseManifest, String> {
    let manifest = load_release_manifest(root)?;
    if let Some(progress) = progress {
        progress.set_progress_totals(
            Some(manifest.files.len().min(u32::MAX as usize) as u32),
            None,
        );
    }
    let mut expected_paths = BTreeSet::new();
    let mut processed_bytes = 0u64;
    for (index, (relative, expected_hash)) in manifest.files.iter().enumerate() {
        if deadline.is_some_and(|end| Instant::now() >= end) {
            return Err("Release verification exceeded its time limit.".to_owned());
        }
        if let Some(progress) = progress {
            if index % 32 == 0 {
                progress.check_cancel()?;
            }
        }
        let relative_path = Path::new(relative);
        if relative.contains('\\')
            || relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || !expected_paths.insert(relative.to_ascii_lowercase())
        {
            return Err(format!("Release contains an unsafe path: {relative}"));
        }
        if expected_hash.len() != 64 || !expected_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!("Release contains an invalid SHA-256: {relative}"));
        }
        let file_path = root.join(relative_path);
        verify_path_components(root, relative_path, relative)?;
        let mut file = File::open(&file_path)
            .map_err(|error| format!("Unable to open release file {relative}: {error}"))?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            if deadline.is_some_and(|end| Instant::now() >= end) {
                return Err("Release verification exceeded its time limit.".to_owned());
            }
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("Unable to read release file {relative}: {error}"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
            processed_bytes = processed_bytes.saturating_add(count as u64);
            if let Some(progress) = progress {
                if processed_bytes % (1024 * 1024) < count as u64 {
                    progress.check_cancel()?;
                }
                progress.set_current_metrics(Some(index as u32), Some(processed_bytes));
            }
        }
        if let Some(progress) = progress {
            progress.set_current_metrics(Some((index + 1) as u32), Some(processed_bytes));
        }
        let actual = format!("{:x}", hash.finalize());
        if !actual.eq_ignore_ascii_case(expected_hash) {
            return Err(format!(
                "Release file failed integrity verification: {relative}"
            ));
        }
    }
    let actual_paths = release_files(root)?;
    if actual_paths != expected_paths {
        let missing = expected_paths.difference(&actual_paths).next();
        let unexpected = actual_paths.difference(&expected_paths).next();
        return Err(format!(
            "Release file inventory differs from its manifest (missing: {}; unexpected: {}).",
            missing.map_or("none", String::as_str),
            unexpected.map_or("none", String::as_str)
        ));
    }
    Ok(manifest)
}

fn load_release_manifest(root: &Path) -> Result<ReleaseManifest, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Release directory is unavailable: {error}"))?;
    if !root_metadata.is_dir() || is_reparse(&root_metadata) {
        return Err("Release root must be a regular directory.".to_owned());
    }
    let manifest_path = root.join("studio-release.json");
    let manifest_metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|error| format!("Release manifest is unavailable: {error}"))?;
    if !manifest_metadata.is_file() || is_reparse(&manifest_metadata) {
        return Err("Release manifest must be a regular file.".to_owned());
    }
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Unable to read release manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest_bytes = manifest_bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(&manifest_bytes);
    let manifest: ReleaseManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| format!("Release manifest is invalid: {error}"))?;
    if semver::Version::parse(&manifest.version).is_err()
        || manifest.commit.len() != 40
        || !manifest.commit.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Release manifest has an invalid version or commit.".to_owned());
    }
    if manifest.files.is_empty() {
        return Err("Release manifest does not contain a file inventory.".to_owned());
    }
    let mut normalized_paths = BTreeSet::new();
    for relative in manifest.files.keys() {
        let path = Path::new(relative);
        if relative.is_empty()
            || !path
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
            || !normalized_paths.insert(relative.to_ascii_lowercase())
        {
            return Err(format!(
                "Release contains an unsafe or duplicate path: {relative}"
            ));
        }
    }
    Ok(manifest)
}

fn verify_path_components(root: &Path, relative: &Path, display: &str) -> Result<(), String> {
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err(format!("Release contains an unsafe path: {display}"));
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| format!("Release file is missing: {display}"))?;
        if is_reparse(&metadata)
            || (index + 1 < components.len() && !metadata.is_dir())
            || (index + 1 == components.len() && !metadata.is_file())
        {
            return Err(format!("Release entry is not a regular file: {display}"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn release_files(root: &Path) -> Result<BTreeSet<String>, String> {
    fn visit(root: &Path, directory: &Path, files: &mut BTreeSet<String>) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("Unable to enumerate release files: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Unable to read release entry: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Unable to inspect release entry: {error}"))?;
            if is_reparse(&metadata) {
                return Err(format!(
                    "Release contains a symbolic link or reparse point: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                if path
                    .file_name()
                    .is_some_and(|name| name == "studio-release.json")
                {
                    continue;
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|error| format!("Invalid release path: {error}"))?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase();
                files.insert(relative);
            } else {
                return Err(format!(
                    "Release contains a non-file entry: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut files = BTreeSet::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn write_transaction(root: &Path, transaction: &Transaction) -> Result<(), String> {
    let state = root.join("state");
    fs::create_dir_all(&state)
        .map_err(|error| format!("Unable to create state directory: {error}"))?;
    let destination = state.join("transaction.json");
    let temporary = state.join(format!(
        "transaction-{}-{}.tmp",
        transaction.operation_id,
        unique_id()
    ));
    let serialized = serde_json::to_vec(transaction)
        .map_err(|error| format!("Unable to serialize operation state: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Unable to create operation state: {error}"))?;
    if let Err(error) = file.write_all(&serialized).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Unable to save operation state: {error}"));
    }
    drop(file);
    #[cfg(windows)]
    if destination.exists() {
        if let Err(error) = windows_replace(&temporary, &destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    } else {
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("Unable to commit operation state: {error}"))?;
    }
    #[cfg(not(windows))]
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Unable to commit operation state: {error}"))?;

    if let Some(logger) = manager_diagnostics(root) {
        logger.set_operation_id(&transaction.operation_id);
        let (component, event_code, severity, phase, error_code) = match &transaction.stage {
            Stage::Committed => (
                DiagnosticComponent::Installer,
                "installer.operation.committed",
                "info",
                "activation",
                "none",
            ),
            Stage::Migrated => (
                DiagnosticComponent::Migration,
                "database.migration.completed",
                "info",
                "migration-deploy",
                "none",
            ),
            Stage::RollingBack | Stage::RolledBack => (
                DiagnosticComponent::Installer,
                "installer.recovery.stage",
                "warning",
                match &transaction.stage {
                    Stage::RollingBack => "rolling-back",
                    _ => "rolled-back",
                },
                "none",
            ),
            Stage::Failed => (
                DiagnosticComponent::Installer,
                "installer.recovery.failed",
                "error",
                "recovery",
                "RECOVERY_FAILED",
            ),
            _ => (
                DiagnosticComponent::Installer,
                "installer.transaction.stage",
                "info",
                match &transaction.stage {
                    Stage::Preparing => "preparing",
                    Stage::Staged => "staged",
                    Stage::Maintenance => "maintenance",
                    Stage::BackupCreating => "backup-creating",
                    Stage::BackupCreated => "backup-created",
                    Stage::BackupVerifying => "backup-verifying",
                    Stage::BackupVerified => "backup-verified",
                    Stage::CandidateHealthy => "candidate-healthy",
                    Stage::Switching => "switching",
                    Stage::Uninstalling => "uninstalling",
                    _ => "operation-state",
                },
                "none",
            ),
        };
        logger.record(component, severity, event_code, phase, error_code);
    }
    Ok(())
}

fn is_lock_contention(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
        matches!(
            error.raw_os_error(),
            Some(code)
                if code == ERROR_LOCK_VIOLATION as i32
                    || code == ERROR_SHARING_VIOLATION as i32
        )
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn try_lock_state(root: &Path) -> Result<Option<File>, String> {
    let state = root.join("state");
    fs::create_dir_all(&state)
        .map_err(|error| format!("Unable to create state directory: {error}"))?;
    let lock_path = state.join("operation.lock");
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
    {
        Ok(lock) => lock,
        Err(error) if is_lock_contention(&error) => return Ok(None),
        Err(error) => return Err(format!("Unable to open operation lock: {error}")),
    };
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(lock)),
        Err(error) if is_lock_contention(&error) => Ok(None),
        Err(error) => Err(format!("Unable to acquire operation lock: {error}")),
    }
}

fn lock_state(root: &Path) -> Result<File, String> {
    try_lock_state(root)?
        .ok_or_else(|| "Another NGTManager operation is already running.".to_owned())
}

fn read_transaction(root: &Path) -> Result<Transaction, String> {
    let path = root.join("state").join("transaction.json");
    let contents =
        fs::read(&path).map_err(|error| format!("Unable to read operation state: {error}"))?;
    let transaction: Transaction = serde_json::from_slice(&contents)
        .map_err(|error| format!("Operation state is unreadable: {error}"))?;
    if transaction.format_version != TRANSACTION_VERSION {
        return Err(
            "Operation state version is unsupported; manual recovery is required.".to_owned(),
        );
    }
    Ok(transaction)
}

#[cfg(windows)]
fn windows_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            1,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(format!(
            "Unable to atomically replace operation state: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn unique_id() -> String {
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{ticks}", std::process::id())
}

fn config_path(root: &Path) -> PathBuf {
    root.join("state").join("studio.json")
}

fn read_config(root: &Path) -> Result<Option<ManagerConfig>, String> {
    let path = config_path(root);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to read manager configuration: {error}")),
    };
    let config: ManagerConfig = serde_json::from_slice(&contents)
        .map_err(|error| format!("Manager configuration is unreadable: {error}"))?;
    let releases = root.join("releases");
    if config.format_version != CONFIG_VERSION
        || config.install_root != root
        || config.data_root != root.join("data")
        || config.active_release.parent() != Some(releases.as_path())
        || semver::Version::parse(&config.version).is_err()
    {
        return Err("Manager configuration is invalid; manual recovery is required.".to_owned());
    }
    match fs::symlink_metadata(&config.active_release) {
        Ok(metadata) if !metadata.is_dir() || is_reparse(&metadata) => {
            return Err("The active release is not a regular directory.".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect the active release: {error}")),
    }
    Ok(Some(config))
}

fn write_config(root: &Path, config: &ManagerConfig) -> Result<(), String> {
    let path = config_path(root);
    let parent = path.parent().expect("state configuration parent");
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create manager state directory: {error}"))?;
    atomic_write(
        &path,
        &serde_json::to_vec(config)
            .map_err(|error| format!("Unable to serialize manager configuration: {error}"))?,
    )
}

fn write_maintenance(root: &Path, operation_id: &str, enabled: bool) -> Result<(), String> {
    let path = root.join("state").join("update-maintenance.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let marker: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
                "The maintenance marker is unreadable; it was preserved.".to_owned()
            })?;
            if marker["updateId"] != operation_id {
                return Err("Another operation owns the maintenance marker.".to_owned());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to read the maintenance marker: {error}")),
    }
    if enabled {
        let state = serde_json::json!({
            "formatVersion": 1,
            "updateId": operation_id,
            "operation": "install-core",
            "stage": "maintenance",
            "createdAt": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        });
        atomic_write(
            &path,
            &serde_json::to_vec(&state)
                .map_err(|error| format!("Unable to serialize maintenance state: {error}"))?,
        )
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Unable to clear maintenance state: {error}")),
        }
    }
}

fn atomic_write(destination: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create atomic state directory: {error}"))?;
    }
    let temporary = destination.with_file_name(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("state"),
        unique_id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Unable to create atomic state file: {error}"))?;
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Unable to save atomic state file: {error}"));
    }
    drop(file);
    #[cfg(windows)]
    if destination.exists() {
        return windows_replace(&temporary, destination);
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Unable to commit atomic state file: {error}"))
}

fn check_space(path: &Path, required: u64) -> Result<(), String> {
    let available = available_space(path).map_err(|error| {
        format!(
            "Unable to check free disk space at {}: {error}",
            path.display()
        )
    })?;
    if available < required {
        return Err(format!(
            "Insufficient disk space at {}: need {required} bytes, have {available}.",
            path.display()
        ));
    }
    Ok(())
}

fn validate_database_credentials(data_root: &Path) -> Result<(), String> {
    let path = data_root.join("local-secrets.json");
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Database credentials are missing; existing data was preserved.".to_owned())?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(
            "Database credentials are not a regular file; existing data was preserved.".to_owned(),
        );
    }
    let contents = fs::read(&path).map_err(|_| {
        "Database credentials are unreadable; existing data was preserved.".to_owned()
    })?;
    let secrets: serde_json::Value = serde_json::from_slice(&contents)
        .map_err(|_| "Database credentials are invalid; existing data was preserved.".to_owned())?;
    let valid_hex = |value: Option<&str>, expected_length| {
        value.is_some_and(|value| {
            value.len() == expected_length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    };
    if !valid_hex(
        secrets.get("password").and_then(serde_json::Value::as_str),
        48,
    ) || !valid_hex(
        secrets
            .get("authSecret")
            .and_then(serde_json::Value::as_str),
        64,
    ) {
        return Err("Database credentials are invalid; existing data was preserved.".to_owned());
    }
    Ok(())
}

fn directory_size(root: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Unable to inspect {}: {error}", root.display()))?;
    if is_reparse(&metadata) {
        return Err(format!(
            "Reparse points are not allowed: {}",
            root.display()
        ));
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err(format!("Expected a file or directory: {}", root.display()));
    }
    let mut size = 0u64;
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        size = size.saturating_add(directory_size(&path)?);
    }
    Ok(size)
}

fn copy_directory(source: &Path, destination: &Path, durable: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Unable to inspect {}: {error}", source.display()))?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(format!(
            "Expected a regular directory: {}",
            source.display()
        ));
    }
    fs::create_dir(destination)
        .map_err(|error| format!("Unable to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let entry_metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Unable to inspect {}: {error}", source_path.display()))?;
        if is_reparse(&entry_metadata) {
            return Err(format!(
                "Reparse point is not allowed: {}",
                source_path.display()
            ));
        }
        if entry_metadata.is_dir() {
            copy_directory(&source_path, &destination_path, durable)?;
        } else if entry_metadata.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to copy {}: {error}", source_path.display()))?;
            if durable {
                OpenOptions::new()
                    .write(true)
                    .open(&destination_path)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| {
                        format!(
                            "Unable to flush database copy (os error {}).",
                            error.raw_os_error().unwrap_or(0)
                        )
                    })?;
            }
        } else {
            return Err(format!("Unsupported entry: {}", source_path.display()));
        }
    }
    Ok(())
}

fn copy_release(
    source: &Path,
    destination: &Path,
    progress: &InstallProgress,
    manifest: &ReleaseManifest,
    total_bytes: u64,
) -> Result<ReleaseManifest, String> {
    let copy_started = Instant::now();
    let copied_file_total = total_bytes.saturating_sub(
        fs::metadata(source.join("studio-release.json"))
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    );
    if let Some(logger) = stable_root()
        .ok()
        .and_then(|root| manager_diagnostics(&root))
    {
        logger.record(
            DiagnosticComponent::Installer,
            "info",
            "installer.copy.started",
            "candidate_file_copy",
            "none",
        );
    }
    progress.set_phase_with_metrics("candidate_file_copy", None, None);
    progress.set_progress_totals(
        Some(manifest.files.len().min(u32::MAX as usize) as u32),
        Some(copied_file_total),
    );
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create candidate release: {error}"))?;
    let mut copied_bytes = 0u64;
    for (index, (relative, expected_hash)) in manifest.files.iter().enumerate() {
        if index % 32 == 0 {
            progress.check_cancel()?;
        }
        let relative_path = Path::new(relative);
        verify_path_components(source, relative_path, relative)?;
        let source_file = source.join(relative_path);
        let destination_file = destination.join(relative_path);
        if let Some(parent) = destination_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create candidate path: {error}"))?;
        }
        let copied = copy_release_file(
            &source_file,
            &destination_file,
            relative,
            expected_hash,
            progress,
            index,
            copied_bytes,
        )?;
        copied_bytes = copied_bytes.saturating_add(copied);
        progress.set_current_metrics(Some((index + 1) as u32), Some(copied_bytes));
    }
    fs::copy(
        source.join("studio-release.json"),
        destination.join("studio-release.json"),
    )
    .map_err(|error| format!("Unable to deploy release manifest: {error}"))?;
    progress.set_current_metrics(
        Some(manifest.files.len().min(u32::MAX as usize) as u32),
        Some(copied_bytes),
    );
    if let Some(logger) = stable_root()
        .ok()
        .and_then(|root| manager_diagnostics(&root))
    {
        logger.record_with_metrics(
            DiagnosticComponent::Installer,
            "info",
            "installer.copy.completed",
            "candidate_file_copy",
            "none",
            diagnostics::EventMetrics {
                elapsed_ms: Some(copy_started.elapsed().as_millis().min(u64::MAX as u128) as u64),
                phase_item_count: Some(manifest.files.len().min(u32::MAX as usize) as u32),
                phase_bytes: Some(copied_bytes),
            },
        );
    }
    progress.set_phase("candidate_verification");
    let inventory_started = Instant::now();
    let actual_paths = release_files(destination)?;
    let expected_paths = manifest
        .files
        .keys()
        .map(|path| path.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    if actual_paths != expected_paths {
        return Err("The deployed release inventory differs from its manifest.".to_owned());
    }
    verify_required_runtime_files(destination, manifest)?;
    if let Some(logger) = stable_root()
        .ok()
        .and_then(|root| manager_diagnostics(&root))
    {
        logger.record_with_metrics(
            DiagnosticComponent::Installer,
            "info",
            "installer.candidate_inventory.completed",
            "candidate_verification",
            "none",
            diagnostics::EventMetrics {
                elapsed_ms: Some(
                    inventory_started
                        .elapsed()
                        .as_millis()
                        .min(u64::MAX as u128) as u64,
                ),
                phase_item_count: Some(actual_paths.len().min(u32::MAX as usize) as u32),
                ..Default::default()
            },
        );
    }
    Ok(manifest.clone())
}

fn copy_release_file(
    source: &Path,
    destination: &Path,
    relative: &str,
    expected_hash: &str,
    progress: &InstallProgress,
    index: usize,
    previously_copied: u64,
) -> Result<u64, String> {
    let mut input = File::open(source)
        .map_err(|error| format!("Unable to open release file {relative}: {error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("Unable to deploy {relative}: {error}"))?;
    let mut hash = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        progress.check_cancel()?;
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read release file {relative}: {error}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Unable to deploy {relative}: {error}"))?;
        copied = copied.saturating_add(count as u64);
        progress.set_current_metrics(
            Some(index.min(u32::MAX as usize) as u32),
            Some(previously_copied.saturating_add(copied)),
        );
    }
    output
        .flush()
        .map_err(|error| format!("Unable to finish deploying {relative}: {error}"))?;
    if !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected_hash) {
        return Err(format!(
            "Release file changed while it was being deployed: {relative}"
        ));
    }
    Ok(copied)
}

fn verify_required_runtime_files(root: &Path, manifest: &ReleaseManifest) -> Result<(), String> {
    for relative in REQUIRED_RUNTIME_FILES {
        let expected_hash = manifest
            .files
            .get(relative)
            .ok_or_else(|| format!("Release is missing required runtime file: {relative}"))?;
        let relative_path = Path::new(relative);
        verify_path_components(root, relative_path, relative)?;
        let mut file = File::open(root.join(relative_path))
            .map_err(|error| format!("Unable to open required runtime file {relative}: {error}"))?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| {
                format!("Unable to read required runtime file {relative}: {error}")
            })?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected_hash) {
            return Err(format!(
                "Required runtime file failed integrity verification: {relative}"
            ));
        }
    }
    Ok(())
}

fn verify_release_for_startup(root: &Path, version: &str) -> Result<ReleaseManifest, String> {
    let manifest = load_release_manifest(root)?;
    if manifest.version != version {
        return Err("The active release version does not match the installation state.".to_owned());
    }
    verify_required_runtime_files(root, &manifest)?;
    Ok(manifest)
}

fn verify_pe_x64(path: &Path) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Required runtime component is missing: {error}"))?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).map_err(|_| {
        format!(
            "Runtime component is not a valid PE file: {}",
            path.display()
        )
    })?;
    if &dos[..2] != b"MZ" {
        return Err(format!(
            "Runtime component is not a PE file: {}",
            path.display()
        ));
    }
    let pe_offset = u32::from_le_bytes(dos[0x3c..0x40].try_into().unwrap()) as u64;
    file.seek(SeekFrom::Start(pe_offset))
        .map_err(|error| format!("Unable to inspect runtime architecture: {error}"))?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe).map_err(|_| {
        format!(
            "Runtime component has an invalid PE header: {}",
            path.display()
        )
    })?;
    if &pe[..4] != b"PE\0\0" || u16::from_le_bytes([pe[4], pe[5]]) != 0x8664 {
        return Err(format!("Runtime component is not x64: {}", path.display()));
    }
    Ok(())
}

fn validate_runtime(
    source: &Path,
    progress: Option<&InstallProgress>,
) -> Result<ReleaseManifest, String> {
    if let Some(progress) = progress {
        progress.set_phase("package_source_verification");
    }
    let manifest = verify_release_with_progress(source, progress)?;
    if let Some(progress) = progress {
        progress.set_current_metrics(
            Some(manifest.files.len().min(u32::MAX as usize) as u32),
            None,
        );
        progress.set_phase_with_metrics(
            "runtime_dependency_check",
            Some(REQUIRED_RUNTIME_FILES.len() as u32),
            None,
        );
    }
    for relative in REQUIRED_RUNTIME_FILES {
        if !manifest.files.contains_key(relative) {
            return Err(format!(
                "Release is missing required runtime file: {relative}"
            ));
        }
    }
    for relative in [
        "runtime/node.exe",
        "runtime/gh.exe",
        "runtime/postgres/bin/postgres.exe",
        "tools/NGTManager.exe",
        "tools/NGTUpdater.exe",
    ] {
        verify_pe_x64(&source.join(relative))?;
    }
    for (relative, args) in [
        ("runtime/node.exe", vec!["--version"]),
        ("runtime/gh.exe", vec!["--version"]),
        ("runtime/postgres/bin/postgres.exe", vec!["--version"]),
        ("runtime/postgres/bin/initdb.exe", vec!["--version"]),
        ("runtime/postgres/bin/pg_ctl.exe", vec!["--version"]),
        ("tools/NGTUpdater.exe", vec!["--invalid"]),
    ] {
        let output = hidden_command(source, source.join(relative), &args)
            .output()
            .map_err(|error| format!("Unable to run {relative}: {error}"))?;
        if relative != "tools/NGTUpdater.exe" && !output.status.success() {
            return Err(format!(
                "Required runtime component failed to start: {relative} (exit {}).",
                status_code(&output.status)
            ));
        }
    }
    let prisma = hidden_command(
        source,
        source.join("runtime/node.exe"),
        &["node_modules/prisma/build/index.js", "--version"],
    )
    .output()
    .map_err(|error| format!("Unable to run the bundled Prisma CLI: {error}"))?;
    if !prisma.status.success() {
        return Err(format!(
            "Bundled Prisma CLI failed to start (exit {}).",
            status_code(&prisma.status)
        ));
    }
    Ok(manifest)
}

fn preflight(
    source: &Path,
    requested_operation: &str,
    progress: Option<&InstallProgress>,
) -> Result<PreflightResult, String> {
    if let Some(progress) = progress {
        progress.record_package_extraction();
        progress.set_phase("windows_compatibility_check");
    }
    check_windows_build()?;
    let root = stable_root()?;
    #[cfg(windows)]
    {
        if let Some(progress) = progress {
            progress.set_phase("runtime_state_preflight");
        }
        preflight_runtime_state(&root)?;
    }
    let manifest = validate_runtime(source, progress)?;
    if let Some(progress) = progress {
        progress.set_phase("installation_path_check");
    }
    #[cfg(windows)]
    {
        let temporary = ascii_temp_directory()?;
        if !source.to_string_lossy().is_ascii() || !root.to_string_lossy().is_ascii() {
            let postgres_runtime_size =
                directory_size(&source.join("runtime/postgres"))?.saturating_add(128 * 1024 * 1024);
            check_space(&temporary, postgres_runtime_size)?;
        }
    }
    let parent = root
        .parent()
        .ok_or_else(|| "The per-user installation path is invalid.".to_owned())?;
    let root_exists = match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => true,
        Ok(_) => return Err("The installation directory is not a regular directory.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Unable to inspect the installation directory: {error}"
            ))
        }
    };
    if root_exists {
        for name in [
            "state",
            "state/runtime",
            "releases",
            "data",
            "backups",
            "logs",
            "tools",
            "assets",
        ] {
            match fs::symlink_metadata(root.join(name)) {
                Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
                Ok(_) => {
                    return Err(format!(
                        "The installation {name} path is not a regular directory."
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Unable to inspect the installation {name} path: {error}"
                    ))
                }
            }
        }
        for name in [
            "state/studio.json",
            "state/transaction.json",
            "state/update-maintenance.json",
            "state/operation.lock",
            "state/run.lock",
            "state/update.lock",
            "state/update-status.json",
            "state/application.env",
            "data/local-secrets.json",
            "logs/manager.log",
            "logs/application.log",
            "logs/database.log",
            "tools/NGTManager.exe",
            "tools/NGTUpdater.exe",
            "assets/ngt-studio.ico",
            "assets/ngt-studio-light.ico",
            "assets/ngt-studio-dark.ico",
        ] {
            match fs::symlink_metadata(root.join(name)) {
                Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {}
                Ok(_) => {
                    return Err(format!(
                        "The installation {name} path is not a regular file."
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Unable to inspect the installation {name} path: {error}"
                    ))
                }
            }
        }
    }
    let writable_directory = if root_exists { &root } else { parent };
    let probe = writable_directory.join(format!(".ngt-write-probe-{}", unique_id()));
    let probe_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("The installation directory is not writable: {error}"))?;
    drop(probe_file);
    fs::remove_file(&probe)
        .map_err(|error| format!("Unable to remove the installation permission check: {error}"))?;
    if let Some(progress) = progress {
        progress.set_phase("disk_usage_scan");
    }
    let release_size = directory_size(source)?;
    let data_root = root.join("data");
    match fs::symlink_metadata(&data_root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
        Ok(_) => return Err("The business data directory is not a regular directory.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Unable to inspect the business data directory: {error}"
            ))
        }
    }
    let database = data_root.join("postgres");
    let database_state = inspect_postgres_directory(&database)?;
    let database_size = match database_state {
        PostgresDirectoryState::Initialized => directory_size(&database)?,
        PostgresDirectoryState::Missing | PostgresDirectoryState::Empty => 0,
    };
    if let Some(progress) = progress {
        progress.set_current_metrics(None, Some(release_size.saturating_add(database_size)));
        progress.set_phase_with_metrics("disk_space_check", None, None);
    }
    let existing_config = read_config(&root)?;
    let recovery_pending = read_transaction_if_exists(&root)?
        .as_ref()
        .is_some_and(|transaction| !terminal(&transaction.stage));
    if matches!(
        database_state,
        PostgresDirectoryState::Empty | PostgresDirectoryState::Missing
    ) && !recovery_pending
        && (requested_operation != "install" || existing_config.is_some())
    {
        return Err(
            "The existing database directory is missing or incomplete; data was preserved for manual recovery."
                .to_owned(),
        );
    }
    if database_size > 0 {
        validate_database_credentials(&data_root)?;
    }
    if database_size > 0 && existing_config.is_none() {
        let transaction = read_transaction_if_exists(&root)?;
        let recoverable_initial_install = transaction.as_ref().is_some_and(|transaction| {
            transaction.operation == Operation::Install
                && transaction.stage == Stage::RolledBack
                && transaction.backup_root.is_none()
        });
        let recovery_pending = transaction
            .as_ref()
            .is_some_and(|transaction| !terminal(&transaction.stage));
        if !recoverable_initial_install && !recovery_pending {
            return Err(
                "An existing database has no NGTManager installation record. Export its business backup from the previous system and install into an empty manager directory; the existing database was preserved."
                    .to_owned(),
            );
        }
    }
    let required = required_space(release_size, database_size);
    check_space(if root.exists() { &root } else { parent }, required)?;
    Ok(PreflightResult {
        root,
        package_bytes: release_size,
        database_bytes: database_size,
        manifest,
    })
}

fn required_space(release_size: u64, database_size: u64) -> u64 {
    release_size
        .saturating_add(database_size.saturating_mul(3))
        .saturating_add(512 * 1024 * 1024)
}

fn hidden_command(working_directory: &Path, executable: PathBuf, args: &[&str]) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    command
}

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn status_code(status: &ExitStatus) -> String {
    status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_owned())
}

#[cfg(not(windows))]
fn check_windows_build() -> Result<(), String> {
    Err("NGTManager installation is supported only on Windows x64.".to_owned())
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
        format!(
            "Required local port {port} is occupied by a process that NGTManager cannot verify; it was left running."
        )
    })?;
    drop(listener);
    Ok(())
}

static MANAGER_DIAGNOSTICS: OnceLock<Option<LogSession>> = OnceLock::new();
static INSTALL_CANCEL_FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
static INSTALL_PROGRESS_FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
static INSTALL_EXTRACTION_METRICS: OnceLock<Option<(u64, u32)>> = OnceLock::new();

fn initialize_manager_diagnostics(args: &[String]) {
    let Some(root) = stable_root().ok() else {
        return;
    };
    let initial_operation = args
        .windows(3)
        .find(|window| window[0] == "install")
        .map(|window| window[2].clone())
        .or_else(|| {
            args.windows(3)
                .find(|window| window[0] == "update")
                .map(|window| window[2].clone())
        })
        .or_else(|| {
            read_transaction_if_exists(&root)
                .ok()
                .flatten()
                .map(|transaction| transaction.operation_id)
        })
        .unwrap_or_else(|| "none".to_owned());
    let version = candidate_package_version(args)
        .or_else(|| {
            read_config(&root)
                .ok()
                .flatten()
                .map(|config| config.version)
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let _ = MANAGER_DIAGNOSTICS.get_or_init(|| {
        LogSession::start(&root, &initial_operation, &version, LogOwner::Manager).ok()
    });
}

fn candidate_package_version(args: &[String]) -> Option<String> {
    if !args.first().is_some_and(|command| {
        matches!(
            command.as_str(),
            "preflight" | "install" | "update" | "repair" | "verify-release"
        )
    }) {
        return None;
    }
    let manifest_path = Path::new(args.get(1)?).join("studio-release.json");
    let file = File::open(manifest_path).ok()?;
    let mut bytes = Vec::with_capacity(1024);
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 16 * 1024 * 1024 {
        return None;
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    serde_json::from_slice::<ReleaseManifest>(bytes)
        .ok()
        .map(|manifest| manifest.version)
}

fn manager_diagnostics(root: &Path) -> Option<&'static LogSession> {
    MANAGER_DIAGNOSTICS
        .get()?
        .as_ref()
        .filter(|logger| logger.root() == root)
}

fn set_operation_id(root: &Path, operation_id: &str) {
    if let Some(logger) = manager_diagnostics(root) {
        logger.set_operation_id(operation_id);
    }
}

fn failure_code(message: &str) -> String {
    if message.starts_with("Release file inventory differs from its manifest") {
        return "RELEASE_INVENTORY_MISMATCH".to_owned();
    }
    if message.starts_with("Release file failed integrity verification") {
        return "RELEASE_FILE_HASH_MISMATCH".to_owned();
    }
    if message.starts_with("Release verification exceeded its time limit") {
        return "RELEASE_VERIFICATION_TIMEOUT".to_owned();
    }
    for (marker, prefix) in [("(os error ", "WIN32_"), ("(exit ", "EXIT_")] {
        if let Some(code) = message
            .split_once(marker)
            .and_then(|(_, suffix)| suffix.split_once(')'))
            .map(|(digits, _)| digits)
            .filter(|digits| {
                !digits.is_empty()
                    && digits.len() <= 5
                    && digits.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            return format!("{prefix}{code}");
        }
    }
    let message = message.to_ascii_lowercase();
    if message.contains("port") && (message.contains("occupied") || message.contains("use")) {
        "PORT_IN_USE"
    } else if message.contains("permission") || message.contains("access is denied") {
        "ACCESS_DENIED"
    } else if message.contains("space") || message.contains("disk full") {
        "DISK_SPACE_INSUFFICIENT"
    } else if message.contains("migration") {
        "DATABASE_MIGRATION_FAILED"
    } else if message.contains("exited repeatedly") {
        "RESTART_LIMIT_REACHED"
    } else if message.contains("another ngtmanager operation") {
        "OPERATION_IN_PROGRESS"
    } else if message.contains("did not become ready") {
        "RUNTIME_START_TIMEOUT"
    } else if message.contains("another operation did not finish") {
        "OPERATION_WAIT_TIMEOUT"
    } else if message.contains("previous runtime shutdown is unconfirmed") {
        "PREVIOUS_RUNTIME_UNCONFIRMED"
    } else if message.contains("runtime stop state version is unsupported") {
        "RUNTIME_STATE_VERSION_UNSUPPORTED"
    } else if message.contains("runtime stop state cannot be read") {
        "RUNTIME_STATE_UNREADABLE"
    } else if message.contains("runtime stop state is invalid")
        || message.contains("runtime stop state is not a regular file")
    {
        "RUNTIME_STATE_INVALID"
    } else if message.contains("status tool version does not match") {
        "POSTGRES_TOOL_VERSION_MISMATCH"
    } else if message.contains("legacy postgresql version cannot be read") {
        "POSTGRES_VERSION_UNREADABLE"
    } else if message.contains("database is still running") {
        "DATABASE_STILL_RUNNING"
    } else if message.contains("unable to determine whether the business database is running") {
        "POSTGRES_STATUS_UNKNOWN"
    } else if message.contains("inspection tool timed out") {
        "POSTGRES_STATUS_TIMEOUT"
    } else if message.contains("preserve the invalid runtime stop state")
        || message.contains("different invalid runtime stop state")
    {
        "RUNTIME_RECOVERY_STATE_WRITE_FAILED"
    } else if message.contains("integrity") || message.contains("checksum") {
        "PACKAGE_INTEGRITY_FAILED"
    } else if message.contains("manifest") || message.contains("package") {
        "PACKAGE_VALIDATION_FAILED"
    } else if message.contains("not found") || message.contains("missing") {
        "COMPONENT_MISSING"
    } else if message.contains("database") || message.contains("postgres") {
        "DATABASE_OPERATION_FAILED"
    } else {
        "MANAGER_OPERATION_FAILED"
    }
    .to_owned()
}

fn log_line(root: &Path, line: &str) {
    let Some(logger) = manager_diagnostics(root) else {
        return;
    };
    let lower = line.to_ascii_lowercase();
    let (component, event_code, phase, error_code) = if lower.contains("database runtime") {
        (
            DiagnosticComponent::Database,
            if lower.contains("started") {
                "database.runtime.started"
            } else {
                "database.runtime.state"
            },
            "runtime-start",
            "none",
        )
    } else if lower.contains("exited unexpectedly") {
        (
            DiagnosticComponent::Manager,
            "runtime.restart.scheduled",
            "supervision",
            "none",
        )
    } else if lower.contains("runtime is healthy") {
        (
            DiagnosticComponent::Application,
            "application.health_check.passed",
            "http-status-version-db-select1-workorder-read",
            "none",
        )
    } else if lower.contains("runtime stopped cleanly") {
        (
            DiagnosticComponent::Application,
            "application.shutdown.completed",
            "process-shutdown",
            "none",
        )
    } else {
        (
            DiagnosticComponent::Manager,
            "manager.state",
            "runtime",
            "none",
        )
    };
    let severity = if error_code == "none" {
        "info"
    } else {
        "error"
    };
    logger.record(component, severity, event_code, phase, error_code);
}

#[cfg(windows)]
fn log_child_exit(root: &Path, component: DiagnosticComponent, status: &std::process::ExitStatus) {
    let error_code = status
        .code()
        .map(|code| format!("EXIT_{code}"))
        .unwrap_or_else(|| "EXIT_UNKNOWN".to_owned());
    if let Some(logger) = manager_diagnostics(root) {
        logger.record(
            component,
            "error",
            "runtime.child.exited",
            "supervision",
            &error_code,
        );
    }
}

fn record_command_failure(root: &Path, arguments: &[String], message: &str) -> Option<String> {
    if let Some(logger) = manager_diagnostics(root) {
        let lower = message.to_ascii_lowercase();
        if matches!(arguments.first().map(String::as_str), Some("open" | "run")) {
            let phase = fs::read(root.join("state/runtime/run-state.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RuntimeRunRecord>(&bytes).ok())
                .map_or_else(|| "runtime-start".to_owned(), |state| state.phase);
            let component = if lower.contains("database") || lower.contains("postgres") {
                DiagnosticComponent::Database
            } else if lower.contains("application") || lower.contains("health") {
                DiagnosticComponent::Application
            } else {
                DiagnosticComponent::Manager
            };
            let code = failure_code(message);
            logger.detail(component, format!("{message}\n").as_bytes());
            return Some(logger.record(component, "error", "runtime.start.failed", &phase, &code));
        }
        let installer_command = arguments.first().is_some_and(|command| {
            matches!(
                command.as_str(),
                "preflight"
                    | "install"
                    | "update"
                    | "repair"
                    | "uninstall"
                    | "recover"
                    | "verify-release"
            )
        });
        let (component, event_code, phase) = if lower.contains("migration") {
            (
                DiagnosticComponent::Migration,
                "database.migration.failed",
                "migration-deploy",
            )
        } else if lower.contains("database") || lower.contains("postgres") {
            (
                DiagnosticComponent::Database,
                "database.operation.failed",
                "database-operation",
            )
        } else if installer_command {
            (
                DiagnosticComponent::Installer,
                "installer.operation.failed",
                arguments.first().map_or("command", String::as_str),
            )
        } else if lower.contains("exited repeatedly") {
            (
                DiagnosticComponent::Application,
                "application.restart_limit_reached",
                "supervision",
            )
        } else {
            (
                DiagnosticComponent::Manager,
                "manager.command.failed",
                "command",
            )
        };
        let code = failure_code(message);
        logger.detail(component, format!("{message}\n").as_bytes());
        return Some(logger.record(component, "error", event_code, phase, &code));
    } else {
        // Keep a safe breadcrumb when the structured logger itself is unavailable.
        if fs::create_dir_all(root.join("logs")).is_ok() {
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join("logs/manager.log"))
            {
                if file
                    .metadata()
                    .map_or(true, |metadata| metadata.len() < 1024 * 1024)
                {
                    let _ = writeln!(file, "diagnostics unavailable: MANAGER_OPERATION_FAILED");
                }
            }
        }
    }
    None
}

fn iso_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(windows)]
struct RuntimeJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl RuntimeJob {
    fn new() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "Unable to create the runtime process group: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(format!(
                "Unable to protect the runtime process group: {error}"
            ));
        }
        Ok(Self(handle))
    }

    fn spawn(&self, command: &mut Command) -> Result<Child, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let mut child = command
            .spawn()
            .map_err(|error| format!("Unable to start a required process: {error}"))?;
        let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as _) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Unable to track the required process tree: {error}"
            ));
        }
        Ok(child)
    }

    fn terminate_and_wait(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.0, 0) } == 0 {
            return Err(format!(
                "Unable to stop the candidate process group: {}",
                std::io::Error::last_os_error()
            ));
        }
        for _ in 0..200 {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("The candidate process group did not stop before activation.".to_owned())
    }

    fn active_processes(&self) -> Result<u32, String> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(format!(
                "Unable to inspect the managed process group: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(accounting.ActiveProcesses)
    }
}

#[cfg(windows)]
fn spawn_runtime_process(
    job: &RuntimeJob,
    command: &mut Command,
    root: &Path,
    component: DiagnosticComponent,
) -> Result<Child, String> {
    spawn_runtime_process_controlled(job, command, root, component, None, None)
}

#[cfg(windows)]
fn spawn_runtime_process_controlled(
    job: &RuntimeJob,
    command: &mut Command,
    root: &Path,
    component: DiagnosticComponent,
    stop: Option<&StopEvent>,
    deadline: Option<Instant>,
) -> Result<Child, String> {
    let runtime_state = root.join("state").join("runtime");
    fs::create_dir_all(&runtime_state)
        .map_err(|error| format!("Unable to create runtime state: {error}"))?;
    let gate = runtime_state.join(format!("start-{}.gate", unique_id()));
    command.env("NGT_RUNTIME_START_GATE", &gate);
    let mut gate_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&gate)
        .map_err(|error| format!("Unable to create the runtime startup gate: {error}"))?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Err(error) = gate_file
        .write_all(b"pending")
        .and_then(|_| gate_file.sync_all())
    {
        drop(gate_file);
        let _ = fs::remove_file(&gate);
        return Err(format!(
            "Unable to prepare the runtime startup gate: {error}"
        ));
    }
    let mut child = match job.spawn(command) {
        Ok(child) => child,
        Err(error) => {
            drop(gate_file);
            let _ = fs::remove_file(&gate);
            return Err(error);
        }
    };
    let readers_ready = (|| {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Unable to capture runtime standard output.".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Unable to capture runtime standard error.".to_owned())?;
        attach_runtime_reader(root, component, stdout, "stdout")?;
        attach_runtime_reader(root, component, stderr, "stderr")
    })();
    if let Err(error) = readers_ready {
        let _ = child.kill();
        let _ = child.wait();
        drop(gate_file);
        let _ = fs::remove_file(&gate);
        return Err(error);
    }
    // The stdout/stderr readers must be running before the startup gate opens.
    drop(gate_file);
    if let Err(error) = fs::write(&gate, b"ready") {
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_file(&gate);
        return Err(format!(
            "Unable to release the runtime startup gate: {error}"
        ));
    }
    for _ in 0..1600 {
        match fs::symlink_metadata(&gate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(child),
            Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {}
            Ok(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The runtime startup gate is not a regular file.".to_owned());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Unable to inspect the runtime startup gate: {error}"
                ));
            }
        }
        if stop.is_some_and(StopEvent::is_signaled)
            || deadline.is_some_and(|end| Instant::now() >= end)
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&gate);
            return Err(if stop.is_some_and(StopEvent::is_signaled) {
                "RUNTIME_STOP_REQUESTED_DURING_STARTUP".to_owned()
            } else {
                "RUNTIME_START_GATE_TIMEOUT".to_owned()
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = fs::remove_file(&gate);
                return Err(format!(
                    "The runtime process exited before startup was released (code {}).",
                    status_code(&status)
                ));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&gate);
                return Err(format!("Unable to monitor runtime startup: {error}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_file(&gate);
    Err("The runtime process did not acknowledge the startup gate.".to_owned())
}

#[cfg(windows)]
fn attach_runtime_reader<R: Read + Send + 'static>(
    root: &Path,
    component: DiagnosticComponent,
    reader: R,
    stream: &'static str,
) -> Result<(), String> {
    if let Some(logger) = manager_diagnostics(root) {
        logger
            .attach_reader(reader, component)
            .map_err(|_| "Unable to start a runtime output reader.".to_owned())
    } else {
        let (started_sender, started_receiver) = std::sync::mpsc::sync_channel(0);
        thread::Builder::new()
            .name(format!("ngt-discard-{stream}"))
            .spawn(move || {
                let mut reader = reader;
                let _ = started_sender.send(());
                let _ = io::copy(&mut reader, &mut io::sink());
            })
            .map(|_| ())
            .map_err(|_| "Unable to drain runtime output.".to_owned())?;
        started_receiver
            .recv()
            .map_err(|_| "Unable to start a runtime output reader.".to_owned())
    }
}

#[cfg(windows)]
impl Drop for RuntimeJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct StopEvent(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for StopEvent {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
impl StopEvent {
    fn is_signaled(&self) -> bool {
        unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0)
                == windows_sys::Win32::Foundation::WAIT_OBJECT_0
        }
    }
}

#[cfg(windows)]
struct SessionEndNotifier {
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}

#[cfg(windows)]
fn windows_system_uses_light_theme() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    };
    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let value_name: Vec<u16> = "SystemUsesLightTheme"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        let mut key = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return true;
        }
        let mut kind = 0u32;
        let mut value = 1u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let result = RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            &mut value as *mut u32 as *mut u8,
            &mut size,
        );
        RegCloseKey(key);
        if result == 0 && kind == REG_DWORD {
            value != 0
        } else {
            true
        }
    }
}

#[cfg(windows)]
fn refresh_owned_shortcut_icons(root: &Path, _light_theme: bool) {
    let target = root.join("tools/NGTManager.exe");
    let icon = root.join("assets/ngt-studio.ico");
    if !target.is_file() || !icon.is_file() {
        return;
    }
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$w=New-Object -ComObject WScript.Shell;$target=[IO.Path]::GetFullPath($env:NGT_SHORTCUT_TARGET);$root=[IO.Path]::GetFullPath($env:NGT_SHORTCUT_ROOT);$icon=[IO.Path]::GetFullPath($env:NGT_SHORTCUT_ICON);foreach($folder in @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs'))){if([string]::IsNullOrWhiteSpace($folder)){continue};$path=Join-Path $folder 'NGTManager.lnk';if(-not(Test-Path -LiteralPath $path -PathType Leaf)){continue};$s=$w.CreateShortcut($path);$working=if([string]::IsNullOrWhiteSpace($s.WorkingDirectory)){''}else{[IO.Path]::GetFullPath($s.WorkingDirectory)};if(([IO.Path]::GetFullPath($s.TargetPath) -ieq $target)-and($s.Arguments.Trim() -ieq 'open')-and($working -ieq $root)){$s.IconLocation=$icon+',0';$s.Save()}}",
        ])
        .env("NGT_SHORTCUT_TARGET", &target)
        .env("NGT_SHORTCUT_ROOT", root)
        .env("NGT_SHORTCUT_ICON", &icon)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let _ = command.spawn();
}

#[cfg(windows)]
impl SessionEndNotifier {
    fn start(root: &Path, show_startup: bool) -> Result<Self, String> {
        use windows_sys::Win32::Graphics::Gdi::{
            CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, GetMonitorInfoW,
            GetStockObject, GetSysColorBrush, MonitorFromPoint, SetWindowRgn, COLOR_WINDOW,
            DEFAULT_GUI_FONT, FW_NORMAL, FW_SEMIBOLD, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
        use windows_sys::Win32::UI::Controls::{
            InitCommonControlsEx, ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, PBM_SETBARCOLOR,
            PBM_SETPOS, PBM_SETRANGE32, PBS_SMOOTH,
        };
        use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
        use windows_sys::Win32::UI::Shell::{
            Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_MODIFY, NOTIFYICONDATAW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DispatchMessageW, GetCursorPos, GetMessageW, LoadCursorW, LoadImageW,
            RegisterClassW, SendMessageW, SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow,
            SystemParametersInfoW, TranslateMessage, CW_USEDEFAULT, HWND_NOTOPMOST, HWND_TOPMOST,
            IDC_ARROW, IMAGE_ICON, LR_LOADFROMFILE, SPI_GETHIGHCONTRAST, SWP_NOMOVE, SWP_NOSIZE,
            SW_HIDE, SW_RESTORE, WM_SETFONT, WM_SETICON, WNDCLASSW, WS_CAPTION, WS_CHILD,
            WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_VISIBLE,
        };
        let (sender, receiver) = mpsc::sync_channel::<Result<u32, String>>(1);
        let initial_light_theme = windows_system_uses_light_theme();
        refresh_owned_shortcut_icons(root, initial_light_theme);
        let light_icon_path = root.join("assets/ngt-studio-light.ico");
        let dark_icon_path = root.join("assets/ngt-studio-dark.ico");
        let surface_icon_path = if initial_light_theme {
            light_icon_path.clone()
        } else {
            dark_icon_path.clone()
        };
        let body_icon_path = root.join("assets/ngt-studio-light.ico");
        let version_text = read_config(root)
            .ok()
            .flatten()
            .map_or_else(String::new, |config| format!("v{}", config.version));
        let thread = thread::Builder::new()
            .name("ngt-runtime-ui".to_owned())
            .spawn(move || unsafe {
                let class_name: Vec<u16> = "NGTManager.RuntimeUi"
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let title = runtime_ui_text(
                    "NGTManager 正在启动",
                    "Avvio di NGTManager",
                    "NGTManager is starting",
                );
                let instance =
                    windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
                let mut class: WNDCLASSW = std::mem::zeroed();
                class.lpfnWndProc = Some(session_end_window_proc);
                class.hInstance = instance;
                class.lpszClassName = class_name.as_ptr();
                class.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
                class.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
                let registered = RegisterClassW(&class);
                if registered == 0
                    && windows_sys::Win32::Foundation::GetLastError()
                        != windows_sys::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS
                {
                    let _ = sender.send(Err(
                        "Unable to register the Windows session listener.".to_owned()
                    ));
                    return;
                }
                let window = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                    CW_USEDEFAULT,
                    CW_USEDEFAULT,
                    460,
                    190,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if window.is_null() {
                    let _ = sender.send(Err(
                        "Unable to create the Windows session listener.".to_owned()
                    ));
                    return;
                }
                RUNTIME_UI_WINDOW.store(window as isize, Ordering::SeqCst);
                let dpi = GetDpiForWindow(window).max(96);
                let scale = |value: i32| value * dpi as i32 / 96;
                let mut window_width = scale(600);
                let mut window_height = scale(260);
                let mut cursor = std::mem::zeroed();
                GetCursorPos(&mut cursor);
                let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
                let mut monitor_info: MONITORINFO = std::mem::zeroed();
                monitor_info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(monitor, &mut monitor_info) != 0 {
                    window_width = window_width
                        .min((monitor_info.rcWork.right - monitor_info.rcWork.left) * 7 / 10);
                    window_height = window_height
                        .min((monitor_info.rcWork.bottom - monitor_info.rcWork.top) * 6 / 10);
                    let x = monitor_info.rcWork.left
                        + (monitor_info.rcWork.right - monitor_info.rcWork.left - window_width) / 2;
                    let y = monitor_info.rcWork.top
                        + (monitor_info.rcWork.bottom - monitor_info.rcWork.top - window_height)
                            / 2;
                    SetWindowPos(
                        window,
                        std::ptr::null_mut(),
                        x,
                        y,
                        window_width,
                        window_height,
                        0,
                    );
                }
                let controls = INITCOMMONCONTROLSEX {
                    dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                    dwICC: ICC_PROGRESS_CLASS,
                };
                if InitCommonControlsEx(&controls) == 0 {
                    RUNTIME_UI_WINDOW.store(0, Ordering::SeqCst);
                    let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
                    let _ = sender.send(Err(
                        "Unable to initialize the NGTManager startup controls.".to_owned(),
                    ));
                    return;
                }
                let status_class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
                let card_brush = CreateSolidBrush(0x00f7fafb);
                let card = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE,
                    0,
                    0,
                    scale(750),
                    scale(272),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if !card.is_null() {
                    let region =
                        CreateRoundRectRgn(0, 0, scale(750), scale(272), scale(28), scale(28));
                    if !region.is_null() {
                        SetWindowRgn(card, region, 1);
                    }
                    ShowWindow(card, SW_HIDE);
                }
                RUNTIME_UI_CARD.store(card as isize, Ordering::SeqCst);
                RUNTIME_UI_CARD_BRUSH.store(card_brush as isize, Ordering::SeqCst);
                let title_text: Vec<u16> = "NGTManager".encode_utf16().chain(Some(0)).collect();
                let title = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    title_text.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(100),
                    scale(28),
                    scale(570),
                    scale(34),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let version_text: Vec<u16> = version_text.encode_utf16().chain(Some(0)).collect();
                let version = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    version_text.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(100),
                    scale(62),
                    scale(570),
                    scale(20),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let heading_text = runtime_ui_text(
                    "正在启动工作台",
                    "Avvio dell'area di lavoro",
                    "Starting your workspace",
                );
                let heading = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    heading_text.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(36),
                    scale(102),
                    scale(650),
                    scale(36),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let initial = runtime_ui_phase_text(RUNTIME_UI_PHASE_CHECKING);
                let status = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    initial.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(36),
                    scale(142),
                    scale(650),
                    scale(28),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let detail_text = runtime_ui_elapsed_text(0);
                let detail = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    detail_text.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(36),
                    scale(174),
                    scale(650),
                    scale(22),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                let progress_class: Vec<u16> =
                    "msctls_progress32".encode_utf16().chain(Some(0)).collect();
                let progress = CreateWindowExW(
                    0,
                    progress_class.as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | PBS_SMOOTH,
                    scale(36),
                    scale(220),
                    scale(654),
                    scale(10),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if !progress.is_null() {
                    if !RUNTIME_UI_HIGH_CONTRAST.load(Ordering::SeqCst) {
                        let empty = [0u16];
                        windows_sys::Win32::UI::Controls::SetWindowTheme(
                            progress,
                            empty.as_ptr(),
                            empty.as_ptr(),
                        );
                    }
                    let progress_region =
                        CreateRoundRectRgn(0, 0, scale(654), scale(10), scale(10), scale(10));
                    if !progress_region.is_null() {
                        SetWindowRgn(progress, progress_region, 1);
                    }
                }
                let step_text = runtime_ui_step_text(RUNTIME_UI_PHASE_CHECKING);
                let step = CreateWindowExW(
                    0,
                    status_class.as_ptr(),
                    step_text.as_ptr(),
                    WS_CHILD | WS_VISIBLE,
                    scale(36),
                    scale(240),
                    scale(654),
                    scale(22),
                    window,
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if card.is_null()
                    || card_brush.is_null()
                    || title.is_null()
                    || version.is_null()
                    || heading.is_null()
                    || status.is_null()
                    || detail.is_null()
                    || progress.is_null()
                    || step.is_null()
                {
                    RUNTIME_UI_WINDOW.store(0, Ordering::SeqCst);
                    let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
                    let _ = sender.send(Err(
                        "Unable to create the NGTManager startup window.".to_owned()
                    ));
                    return;
                }
                RUNTIME_UI_TITLE.store(title as isize, Ordering::SeqCst);
                RUNTIME_UI_VERSION.store(version as isize, Ordering::SeqCst);
                RUNTIME_UI_HEADING.store(heading as isize, Ordering::SeqCst);
                RUNTIME_UI_STATUS.store(status as isize, Ordering::SeqCst);
                RUNTIME_UI_DETAIL.store(detail as isize, Ordering::SeqCst);
                RUNTIME_UI_STEP.store(step as isize, Ordering::SeqCst);
                RUNTIME_UI_PROGRESS.store(progress as isize, Ordering::SeqCst);
                RUNTIME_UI_PHASE_STARTED_TICK.store(
                    windows_sys::Win32::System::SystemInformation::GetTickCount64(),
                    Ordering::SeqCst,
                );
                let face: Vec<u16> = "Segoe UI".encode_utf16().chain(Some(0)).collect();
                let mut title_font = CreateFontW(
                    -scale(20),
                    0,
                    0,
                    0,
                    FW_SEMIBOLD as i32,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    5,
                    0,
                    face.as_ptr(),
                );
                let mut status_font = CreateFontW(
                    -scale(14),
                    0,
                    0,
                    0,
                    FW_NORMAL as i32,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    5,
                    0,
                    face.as_ptr(),
                );
                let mut heading_font = CreateFontW(
                    -scale(18),
                    0,
                    0,
                    0,
                    FW_SEMIBOLD as i32,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    5,
                    0,
                    face.as_ptr(),
                );
                let mut detail_font = CreateFontW(
                    -scale(12),
                    0,
                    0,
                    0,
                    FW_NORMAL as i32,
                    0,
                    0,
                    0,
                    1,
                    0,
                    0,
                    5,
                    0,
                    face.as_ptr(),
                );
                let fallback_font = GetStockObject(DEFAULT_GUI_FONT);
                let title_font_handle = if title_font.is_null() {
                    fallback_font
                } else {
                    title_font
                };
                let status_font_handle = if status_font.is_null() {
                    fallback_font
                } else {
                    status_font
                };
                let heading_font_handle = if heading_font.is_null() {
                    fallback_font
                } else {
                    heading_font
                };
                let detail_font_handle = if detail_font.is_null() {
                    fallback_font
                } else {
                    detail_font
                };
                SendMessageW(title, WM_SETFONT, title_font_handle as usize, 1);
                SendMessageW(version, WM_SETFONT, detail_font_handle as usize, 1);
                SendMessageW(heading, WM_SETFONT, heading_font_handle as usize, 1);
                SendMessageW(status, WM_SETFONT, status_font_handle as usize, 1);
                SendMessageW(detail, WM_SETFONT, detail_font_handle as usize, 1);
                SendMessageW(step, WM_SETFONT, detail_font_handle as usize, 1);
                SendMessageW(progress, PBM_SETRANGE32, 0, 100);
                SendMessageW(
                    progress,
                    PBM_SETPOS,
                    runtime_ui_phase_progress(RUNTIME_UI_PHASE_CHECKING),
                    0,
                );
                let mut contrast: HIGHCONTRASTW = std::mem::zeroed();
                contrast.cbSize = std::mem::size_of::<HIGHCONTRASTW>() as u32;
                if SystemParametersInfoW(
                    SPI_GETHIGHCONTRAST,
                    contrast.cbSize,
                    &mut contrast as *mut HIGHCONTRASTW as *mut _,
                    0,
                ) == 0
                    || contrast.dwFlags & HCF_HIGHCONTRASTON == 0
                {
                    SendMessageW(progress, PBM_SETBARCOLOR, 0, 0x002DC6F4);
                    RUNTIME_UI_HIGH_CONTRAST.store(false, Ordering::SeqCst);
                } else {
                    RUNTIME_UI_HIGH_CONTRAST.store(true, Ordering::SeqCst);
                }
                SetTimer(window, 1, 1000, None);

                let surface_icon_wide: Vec<u16> = surface_icon_path
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let body_icon_wide: Vec<u16> = body_icon_path
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let mut small_icon = LoadImageW(
                    std::ptr::null_mut(),
                    surface_icon_wide.as_ptr(),
                    IMAGE_ICON,
                    scale(16),
                    scale(16),
                    LR_LOADFROMFILE,
                )
                    as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                let mut big_icon = LoadImageW(
                    std::ptr::null_mut(),
                    surface_icon_wide.as_ptr(),
                    IMAGE_ICON,
                    scale(32),
                    scale(32),
                    LR_LOADFROMFILE,
                )
                    as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                let mut logo_client = std::mem::zeroed();
                windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(
                    window,
                    &mut logo_client,
                );
                let logo_rect = runtime_ui_layout(logo_client.right, logo_client.bottom, dpi).logo;
                let body_size = logo_rect.right - logo_rect.left;
                let mut body_icon = LoadImageW(
                    std::ptr::null_mut(),
                    body_icon_wide.as_ptr(),
                    IMAGE_ICON,
                    body_size,
                    body_size,
                    LR_LOADFROMFILE,
                )
                    as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                if !small_icon.is_null() && !big_icon.is_null() && !body_icon.is_null() {
                    SendMessageW(window, WM_SETICON, 0, small_icon as isize);
                    SendMessageW(window, WM_SETICON, 1, big_icon as isize);
                    RUNTIME_UI_LOGO.store(body_icon as isize, Ordering::SeqCst);
                }

                let mut tray: NOTIFYICONDATAW = std::mem::zeroed();
                tray.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
                tray.hWnd = window;
                tray.uID = 1;
                tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
                tray.uCallbackMessage = RUNTIME_UI_TRAY_MESSAGE;
                tray.hIcon = small_icon;
                let tip: Vec<u16> = "NGTManager".encode_utf16().chain(Some(0)).collect();
                tray.szTip[..tip.len()].copy_from_slice(&tip);
                if small_icon.is_null()
                    || big_icon.is_null()
                    || body_icon.is_null()
                    || Shell_NotifyIconW(NIM_ADD, &tray) == 0
                {
                    RUNTIME_UI_STATUS.store(0, Ordering::SeqCst);
                    RUNTIME_UI_WINDOW.store(0, Ordering::SeqCst);
                    let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
                    let _ =
                        sender.send(Err("Unable to create the NGTManager tray icon.".to_owned()));
                    return;
                }
                if show_startup {
                    layout_runtime_ui(window);
                    ShowWindow(window, SW_RESTORE);
                    windows_sys::Win32::Graphics::Gdi::RedrawWindow(
                        window,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        windows_sys::Win32::Graphics::Gdi::RDW_INVALIDATE
                            | windows_sys::Win32::Graphics::Gdi::RDW_UPDATENOW
                            | windows_sys::Win32::Graphics::Gdi::RDW_ALLCHILDREN,
                    );
                    SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                    SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                    SetForegroundWindow(window);
                }
                let thread_id = GetCurrentThreadId();
                if sender.send(Ok(thread_id)).is_err() {
                    return;
                }
                let mut current_light_theme = initial_light_theme;
                let mut message = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    let dpi_changed = message.message == RUNTIME_UI_REFLOW_MESSAGE;
                    if dpi_changed {
                        let new_dpi = GetDpiForWindow(window).max(96) as i32;
                        for (font, controls, size, weight) in [
                            (&mut title_font, vec![title], 20, FW_SEMIBOLD),
                            (&mut heading_font, vec![heading], 18, FW_SEMIBOLD),
                            (&mut status_font, vec![status], 14, FW_NORMAL),
                            (&mut detail_font, vec![version, detail, step], 12, FW_NORMAL),
                        ] {
                            let replacement = CreateFontW(
                                -size * new_dpi / 96,
                                0,
                                0,
                                0,
                                weight as i32,
                                0,
                                0,
                                0,
                                1,
                                0,
                                0,
                                5,
                                0,
                                face.as_ptr(),
                            );
                            let handle = if replacement.is_null() {
                                GetStockObject(DEFAULT_GUI_FONT)
                            } else {
                                replacement
                            };
                            for control in controls {
                                SendMessageW(control, WM_SETFONT, handle as usize, 1);
                            }
                            if !font.is_null() {
                                DeleteObject(*font as _);
                            }
                            *font = replacement;
                        }
                        let mut logo_client = std::mem::zeroed();
                        windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect(
                            window,
                            &mut logo_client,
                        );
                        let logo_rect = runtime_ui_layout(
                            logo_client.right,
                            logo_client.bottom,
                            new_dpi as u32,
                        )
                        .logo;
                        let body_size = logo_rect.right - logo_rect.left;
                        let replacement = LoadImageW(
                            std::ptr::null_mut(),
                            body_icon_wide.as_ptr(),
                            IMAGE_ICON,
                            body_size,
                            body_size,
                            LR_LOADFROMFILE,
                        )
                            as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                        if !replacement.is_null() {
                            RUNTIME_UI_LOGO.store(replacement as isize, Ordering::SeqCst);
                            windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(body_icon);
                            body_icon = replacement;
                        }
                        layout_runtime_ui(window);
                    }
                    if message.message == RUNTIME_UI_SETTINGS_MESSAGE || dpi_changed {
                        if SystemParametersInfoW(
                            SPI_GETHIGHCONTRAST,
                            contrast.cbSize,
                            &mut contrast as *mut _ as _,
                            0,
                        ) != 0
                        {
                            let high_contrast = contrast.dwFlags & HCF_HIGHCONTRASTON != 0;
                            RUNTIME_UI_HIGH_CONTRAST.store(high_contrast, Ordering::SeqCst);
                            let empty = [0u16];
                            let theme = if high_contrast {
                                std::ptr::null()
                            } else {
                                empty.as_ptr()
                            };
                            windows_sys::Win32::UI::Controls::SetWindowTheme(
                                progress, theme, theme,
                            );
                            SendMessageW(
                                progress,
                                PBM_SETBARCOLOR,
                                0,
                                if high_contrast {
                                    0xff000000u32 as isize
                                } else {
                                    0x002dc6f4
                                },
                            );
                            windows_sys::Win32::Graphics::Gdi::InvalidateRect(
                                window,
                                std::ptr::null(),
                                0,
                            );
                        }
                        let current_dpi = GetDpiForWindow(window).max(96) as i32;
                        let scale = |value: i32| value * current_dpi / 96;
                        let light_theme = windows_system_uses_light_theme();
                        if light_theme == current_light_theme && !dpi_changed {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                            continue;
                        }
                        let icon_path = if light_theme {
                            &light_icon_path
                        } else {
                            &dark_icon_path
                        };
                        let icon_path: Vec<u16> = icon_path
                            .to_string_lossy()
                            .encode_utf16()
                            .chain(Some(0))
                            .collect();
                        let replacement_small = LoadImageW(
                            std::ptr::null_mut(),
                            icon_path.as_ptr(),
                            IMAGE_ICON,
                            scale(16),
                            scale(16),
                            LR_LOADFROMFILE,
                        )
                            as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                        let replacement_big = LoadImageW(
                            std::ptr::null_mut(),
                            icon_path.as_ptr(),
                            IMAGE_ICON,
                            scale(32),
                            scale(32),
                            LR_LOADFROMFILE,
                        )
                            as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
                        if !replacement_small.is_null() && !replacement_big.is_null() {
                            SendMessageW(window, WM_SETICON, 0, replacement_small as isize);
                            SendMessageW(window, WM_SETICON, 1, replacement_big as isize);
                            tray.hIcon = replacement_small;
                            let _ = Shell_NotifyIconW(NIM_MODIFY, &tray);
                            let previous_small = small_icon;
                            let previous_big = big_icon;
                            small_icon = replacement_small;
                            big_icon = replacement_big;
                            current_light_theme = light_theme;
                            let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(
                                previous_small,
                            );
                            let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(
                                previous_big,
                            );
                        } else {
                            for icon in [replacement_small, replacement_big] {
                                if !icon.is_null() {
                                    let _ =
                                        windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(
                                            icon,
                                        );
                                }
                            }
                        }
                    }
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                let _ = Shell_NotifyIconW(windows_sys::Win32::UI::Shell::NIM_DELETE, &tray);
                RUNTIME_UI_STATUS.store(0, Ordering::SeqCst);
                RUNTIME_UI_LOGO.store(0, Ordering::SeqCst);
                RUNTIME_UI_TITLE.store(0, Ordering::SeqCst);
                RUNTIME_UI_VERSION.store(0, Ordering::SeqCst);
                RUNTIME_UI_HEADING.store(0, Ordering::SeqCst);
                RUNTIME_UI_DETAIL.store(0, Ordering::SeqCst);
                RUNTIME_UI_STEP.store(0, Ordering::SeqCst);
                RUNTIME_UI_PROGRESS.store(0, Ordering::SeqCst);
                RUNTIME_UI_CARD.store(0, Ordering::SeqCst);
                RUNTIME_UI_WINDOW.store(0, Ordering::SeqCst);
                let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
                for icon in [small_icon, big_icon, body_icon] {
                    if !icon.is_null() {
                        let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(icon);
                    }
                }
                for font in [title_font, heading_font, status_font, detail_font] {
                    if !font.is_null() {
                        DeleteObject(font as _);
                    }
                }
                let card_brush = RUNTIME_UI_CARD_BRUSH.swap(0, Ordering::SeqCst);
                if card_brush != 0 {
                    DeleteObject(card_brush as _);
                }
                let _ = windows_sys::Win32::UI::WindowsAndMessaging::UnregisterClassW(
                    class_name.as_ptr(),
                    instance,
                );
            })
            .map_err(|error| format!("Unable to start the Windows session listener: {error}"))?;
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err("The Windows session listener did not start in time.".to_owned())
            }
        }
    }
}

#[cfg(windows)]
impl Drop for SessionEndNotifier {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                self.thread_id,
                windows_sys::Win32::UI::WindowsAndMessaging::WM_QUIT,
                0,
                0,
            );
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(windows)]
fn show_runtime_ui_window(window: windows_sys::Win32::Foundation::HWND, foreground: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE,
        SWP_NOSIZE, SW_RESTORE,
    };
    unsafe {
        ShowWindow(window, SW_RESTORE);
        if foreground {
            SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow(window);
        }
    }
}

#[cfg(windows)]
unsafe fn fit_runtime_ui_to_work_area(
    window: windows_sys::Win32::Foundation::HWND,
    mut bounds: windows_sys::Win32::Foundation::RECT,
) {
    use windows_sys::Win32::Graphics::Gdi::*;
    let monitor = MonitorFromRect(&bounds, MONITOR_DEFAULTTONEAREST);
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(monitor, &mut info) != 0 {
        let width =
            (bounds.right - bounds.left).min((info.rcWork.right - info.rcWork.left) * 7 / 10);
        let height =
            (bounds.bottom - bounds.top).min((info.rcWork.bottom - info.rcWork.top) * 6 / 10);
        bounds.left = bounds
            .left
            .max(info.rcWork.left)
            .min(info.rcWork.right - width);
        bounds.top = bounds
            .top
            .max(info.rcWork.top)
            .min(info.rcWork.bottom - height);
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
            window,
            std::ptr::null_mut(),
            bounds.left,
            bounds.top,
            width,
            height,
            windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
                | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE,
        );
    }
}

#[cfg(windows)]
struct RuntimeUiLayout {
    title: windows_sys::Win32::Foundation::RECT,
    version: windows_sys::Win32::Foundation::RECT,
    heading: windows_sys::Win32::Foundation::RECT,
    status: windows_sys::Win32::Foundation::RECT,
    elapsed: windows_sys::Win32::Foundation::RECT,
    progress: windows_sys::Win32::Foundation::RECT,
    step: windows_sys::Win32::Foundation::RECT,
    logo: windows_sys::Win32::Foundation::RECT,
}

#[cfg(windows)]
fn runtime_ui_layout(width: i32, height: i32, dpi: u32) -> RuntimeUiLayout {
    use windows_sys::Win32::Foundation::RECT;
    let scale = |v: i32| v * dpi.max(96) as i32 / 96;
    let compact = width < scale(580) || height < scale(220);
    let margin = scale(if compact { 12 } else { 24 });
    let tight = height < scale(176);
    let top = scale(if tight {
        8
    } else if compact {
        12
    } else {
        16
    });
    let logo = scale(if tight {
        24
    } else if compact {
        32
    } else {
        48
    });
    let text_left = margin + logo + scale(12);
    let heading_y = top + logo + scale(if tight { 8 } else { 12 });
    let status_y = heading_y + scale(28);
    let progress_y = height - scale(40);
    let elapsed_y = progress_y - scale(22);
    let row = |x, y, w: i32, h| RECT {
        left: x,
        top: y,
        right: x + w.max(1),
        bottom: y + h,
    };
    RuntimeUiLayout {
        title: row(
            text_left,
            top,
            width - text_left - margin - if tight { scale(72) } else { 0 },
            scale(26),
        ),
        version: row(
            if tight {
                width - margin - scale(64)
            } else {
                text_left
            },
            top + scale(if tight { 4 } else { 24 }),
            if tight {
                scale(64)
            } else {
                width - text_left - margin
            },
            scale(16),
        ),
        heading: row(margin, heading_y, width - 2 * margin, scale(26)),
        status: row(
            margin,
            status_y,
            width - 2 * margin,
            (elapsed_y - status_y - scale(2)).max(scale(16)),
        ),
        elapsed: row(margin, elapsed_y, width - 2 * margin, scale(18)),
        progress: row(margin, progress_y, width - 2 * margin, scale(8)),
        step: row(
            margin,
            progress_y + scale(12),
            width - 2 * margin,
            scale(18),
        ),
        logo: row(margin, top, logo, logo),
    }
}

#[cfg(windows)]
fn layout_runtime_ui(window: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let dpi = unsafe { windows_sys::Win32::UI::HiDpi::GetDpiForWindow(window) }.max(96);
    let mut area = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(window, &mut area) };
    let layout = runtime_ui_layout(area.right, area.bottom, dpi);
    for (control, rect) in [
        (&RUNTIME_UI_TITLE, layout.title),
        (&RUNTIME_UI_VERSION, layout.version),
        (&RUNTIME_UI_HEADING, layout.heading),
        (&RUNTIME_UI_STATUS, layout.status),
        (&RUNTIME_UI_DETAIL, layout.elapsed),
        (&RUNTIME_UI_PROGRESS, layout.progress),
        (&RUNTIME_UI_STEP, layout.step),
    ] {
        let handle = control.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
        if !handle.is_null() {
            unsafe {
                SetWindowPos(
                    handle,
                    std::ptr::null_mut(),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            if std::ptr::eq(control, &RUNTIME_UI_PROGRESS) {
                let region = unsafe {
                    windows_sys::Win32::Graphics::Gdi::CreateRoundRectRgn(
                        0,
                        0,
                        rect.right - rect.left,
                        rect.bottom - rect.top,
                        8 * dpi.max(96) as i32 / 96,
                        8 * dpi.max(96) as i32 / 96,
                    )
                };
                if !region.is_null() {
                    unsafe {
                        windows_sys::Win32::Graphics::Gdi::SetWindowRgn(handle, region, 1);
                    }
                }
            }
        }
    }
    unsafe {
        windows_sys::Win32::Graphics::Gdi::InvalidateRect(window, std::ptr::null(), 0);
    }
}

#[cfg(windows)]
unsafe fn paint_runtime_ui_logo(
    dc: windows_sys::Win32::Graphics::Gdi::HDC,
    client: &windows_sys::Win32::Foundation::RECT,
) {
    let icon = RUNTIME_UI_LOGO.load(Ordering::SeqCst)
        as windows_sys::Win32::UI::WindowsAndMessaging::HICON;
    if !icon.is_null() {
        let window =
            RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
        let dpi = windows_sys::Win32::UI::HiDpi::GetDpiForWindow(window).max(96);
        let rect = runtime_ui_layout(client.right, client.bottom, dpi).logo;
        windows_sys::Win32::UI::WindowsAndMessaging::DrawIconEx(
            dc,
            rect.left,
            rect.top,
            icon,
            rect.right - rect.left,
            rect.bottom - rect.top,
            0,
            std::ptr::null_mut(),
            windows_sys::Win32::UI::WindowsAndMessaging::DI_NORMAL,
        );
    }
}

#[cfg(windows)]
unsafe fn paint_runtime_ui_background(
    dc: windows_sys::Win32::Graphics::Gdi::HDC,
    client: &windows_sys::Win32::Foundation::RECT,
) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::*;
    let contrast = RUNTIME_UI_HIGH_CONTRAST.load(Ordering::SeqCst);
    let background = if contrast {
        GetSysColorBrush(COLOR_WINDOW)
    } else {
        CreateSolidBrush(0x00f7fafb)
    };
    FillRect(dc, client, background);
    if contrast {
        paint_runtime_ui_logo(dc, client);
        return;
    }
    let width = client.right;
    let height = client.bottom;
    let wave_back = CreateSolidBrush(0x00dcf7ff);
    let wave_front = CreateSolidBrush(0x00b8f0ff);
    let back_points = [
        POINT {
            x: width * 3 / 4,
            y: height / 2,
        },
        POINT {
            x: width * 4 / 5,
            y: height * 4 / 5,
        },
        POINT {
            x: width,
            y: height * 2 / 5,
        },
    ];
    let front_points = [
        POINT {
            x: width * 9 / 10,
            y: height * 4 / 5,
        },
        POINT {
            x: width * 9 / 10,
            y: height / 3,
        },
        POINT {
            x: width,
            y: height / 4,
        },
    ];
    let old = windows_sys::Win32::Graphics::Gdi::SelectObject(dc, wave_back as _);
    BeginPath(dc);
    MoveToEx(dc, width * 3 / 5, height, std::ptr::null_mut());
    PolyBezierTo(dc, back_points.as_ptr(), back_points.len() as u32);
    LineTo(dc, width, height);
    CloseFigure(dc);
    EndPath(dc);
    FillPath(dc);
    windows_sys::Win32::Graphics::Gdi::SelectObject(dc, wave_front as _);
    BeginPath(dc);
    MoveToEx(dc, width * 4 / 5, height, std::ptr::null_mut());
    PolyBezierTo(dc, front_points.as_ptr(), front_points.len() as u32);
    LineTo(dc, width, height);
    CloseFigure(dc);
    EndPath(dc);
    FillPath(dc);
    windows_sys::Win32::Graphics::Gdi::SelectObject(dc, old);
    DeleteObject(background as _);
    DeleteObject(wave_back as _);
    DeleteObject(wave_front as _);
    paint_runtime_ui_logo(dc, client);
}

#[cfg(windows)]
unsafe extern "system" fn session_end_window_proc(
    window: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        EndPaint, GetStockObject, IntersectClipRect, OffsetViewportOrgEx, RestoreDC, SaveDC,
        SelectObject, SetBkMode, SetTextColor, NULL_BRUSH, SRCCOPY, TRANSPARENT,
    };
    use windows_sys::Win32::UI::Controls::PBM_SETPOS;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, DefWindowProcW, DestroyMenu, GetClientRect, GetCursorPos,
        PostMessageW, SendMessageW, SetForegroundWindow, SetWindowTextW, ShowWindow,
        TrackPopupMenu, MF_SEPARATOR, MF_STRING, SW_HIDE, SW_SHOW, TPM_RETURNCMD, TPM_RIGHTBUTTON,
        WM_CLOSE, WM_CTLCOLORSTATIC, WM_ENDSESSION, WM_ERASEBKGND, WM_LBUTTONDBLCLK, WM_PAINT,
        WM_QUERYENDSESSION, WM_RBUTTONUP, WM_TIMER,
    };
    match message {
        windows_sys::Win32::UI::WindowsAndMessaging::WM_SIZE => {
            layout_runtime_ui(window);
            if wparam != windows_sys::Win32::UI::WindowsAndMessaging::SIZE_MINIMIZED as usize
                && RUNTIME_UI_LOGO.load(Ordering::SeqCst) != 0
            {
                PostMessageW(window, RUNTIME_UI_REFLOW_MESSAGE, 0, 0);
            }
            0
        }
        windows_sys::Win32::UI::WindowsAndMessaging::WM_DPICHANGED => {
            let suggested = *(lparam as *const windows_sys::Win32::Foundation::RECT);
            fit_runtime_ui_to_work_area(window, suggested);
            PostMessageW(window, RUNTIME_UI_REFLOW_MESSAGE, 0, 0);
            0
        }
        windows_sys::Win32::UI::WindowsAndMessaging::WM_SETTINGCHANGE => {
            let mut bounds = std::mem::zeroed();
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(window, &mut bounds);
            fit_runtime_ui_to_work_area(window, bounds);
            PostMessageW(window, RUNTIME_UI_SETTINGS_MESSAGE, 0, 0);
            0
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION if wparam != 0 => {
            WINDOWS_SESSION_END_TICK.store(
                windows_sys::Win32::System::SystemInformation::GetTickCount64(),
                Ordering::SeqCst,
            );
            WINDOWS_SESSION_END.store(true, Ordering::SeqCst);
            let _ = request_runtime_stop();
            0
        }
        WM_ERASEBKGND => 1,
        windows_sys::Win32::UI::WindowsAndMessaging::WM_PRINTCLIENT => {
            let mut client = std::mem::zeroed();
            GetClientRect(window, &mut client);
            paint_runtime_ui_background(wparam as _, &client);
            0
        }
        WM_PAINT => {
            let mut paint = std::mem::zeroed();
            let dc = BeginPaint(window, &mut paint);
            let mut client = std::mem::zeroed();
            GetClientRect(window, &mut client);
            let memory = CreateCompatibleDC(dc);
            let bitmap = CreateCompatibleBitmap(dc, client.right.max(1), client.bottom.max(1));
            if !memory.is_null() && !bitmap.is_null() {
                let previous = SelectObject(memory, bitmap as _);
                paint_runtime_ui_background(memory, &client);
                BitBlt(dc, 0, 0, client.right, client.bottom, memory, 0, 0, SRCCOPY);
                SelectObject(memory, previous);
            } else {
                paint_runtime_ui_background(dc, &client);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap as _);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            EndPaint(window, &paint);
            0
        }
        WM_CLOSE => {
            ShowWindow(window, SW_HIDE);
            0
        }
        WM_CTLCOLORSTATIC if !RUNTIME_UI_HIGH_CONTRAST.load(Ordering::SeqCst) => {
            let control = lparam;
            let title = RUNTIME_UI_TITLE.load(Ordering::SeqCst);
            let heading = RUNTIME_UI_HEADING.load(Ordering::SeqCst);
            SetBkMode(wparam as _, TRANSPARENT as i32);
            SetTextColor(
                wparam as _,
                if control == title || control == heading {
                    0x001f2729
                } else {
                    0x00576d70
                },
            );
            let dc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            let saved = SaveDC(dc);
            let mut origin = POINT { x: 0, y: 0 };
            windows_sys::Win32::Graphics::Gdi::MapWindowPoints(lparam as _, window, &mut origin, 1);
            let mut control_area = std::mem::zeroed();
            GetClientRect(lparam as _, &mut control_area);
            IntersectClipRect(dc, 0, 0, control_area.right, control_area.bottom);
            OffsetViewportOrgEx(dc, -origin.x, -origin.y, std::ptr::null_mut());
            let mut client = std::mem::zeroed();
            GetClientRect(window, &mut client);
            paint_runtime_ui_background(dc, &client);
            RestoreDC(dc, saved);
            GetStockObject(NULL_BRUSH) as isize
        }
        RUNTIME_UI_PHASE_MESSAGE => {
            let phase = wparam;
            RUNTIME_UI_PHASE_STARTED_TICK.store(
                windows_sys::Win32::System::SystemInformation::GetTickCount64(),
                Ordering::SeqCst,
            );
            let status =
                RUNTIME_UI_STATUS.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
            if !status.is_null() {
                let text = runtime_ui_phase_text(phase);
                SetWindowTextW(status, text.as_ptr());
            }
            let detail =
                RUNTIME_UI_DETAIL.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
            if !detail.is_null() {
                SetWindowTextW(detail, runtime_ui_elapsed_text(0).as_ptr());
            }
            let step =
                RUNTIME_UI_STEP.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
            if !step.is_null() {
                SetWindowTextW(step, runtime_ui_step_text(phase).as_ptr());
            }
            let progress =
                RUNTIME_UI_PROGRESS.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
            if !progress.is_null() {
                if phase == RUNTIME_UI_PHASE_EXITING {
                    ShowWindow(progress, SW_HIDE);
                } else {
                    ShowWindow(progress, SW_SHOW);
                    SendMessageW(progress, PBM_SETPOS, runtime_ui_phase_progress(phase), 0);
                }
            }
            if phase == RUNTIME_UI_PHASE_READY || phase == RUNTIME_UI_PHASE_BROWSER_BLOCKED {
                RUNTIME_HEALTHY.store(true, Ordering::SeqCst);
            } else {
                RUNTIME_HEALTHY.store(false, Ordering::SeqCst);
                if phase == RUNTIME_UI_PHASE_EXITING {
                    show_runtime_ui_window(window, true);
                }
            }
            0
        }
        WM_TIMER if wparam == 1 => {
            let started = RUNTIME_UI_PHASE_STARTED_TICK.load(Ordering::SeqCst);
            let elapsed = windows_sys::Win32::System::SystemInformation::GetTickCount64()
                .saturating_sub(started)
                / 1000;
            if elapsed >= 3 {
                let detail = RUNTIME_UI_DETAIL.load(Ordering::SeqCst)
                    as windows_sys::Win32::Foundation::HWND;
                if !detail.is_null() {
                    SetWindowTextW(detail, runtime_ui_elapsed_text(elapsed).as_ptr());
                }
            }
            0
        }
        RUNTIME_UI_OPEN_MESSAGE => {
            if RUNTIME_HEALTHY.load(Ordering::SeqCst) {
                queue_browser_open(None);
            } else {
                show_runtime_ui_window(window, true);
            }
            0
        }
        RUNTIME_UI_SHOW_MESSAGE => {
            if !RUNTIME_HEALTHY.load(Ordering::SeqCst) {
                show_runtime_ui_window(window, true);
            }
            0
        }
        RUNTIME_UI_HIDE_MESSAGE => {
            windows_sys::Win32::UI::WindowsAndMessaging::KillTimer(window, 2);
            ShowWindow(window, SW_HIDE);
            0
        }
        RUNTIME_UI_TRAY_MESSAGE if lparam as u32 == WM_LBUTTONDBLCLK => {
            PostMessageW(window, RUNTIME_UI_OPEN_MESSAGE, 0, 0);
            0
        }
        RUNTIME_UI_TRAY_MESSAGE if lparam as u32 == WM_RBUTTONUP => {
            let menu = CreatePopupMenu();
            if !menu.is_null() {
                let open = runtime_ui_text("打开 NGTManager", "Apri NGTManager", "Open NGTManager");
                let exit =
                    runtime_ui_text("退出 NGTManager", "Esci da NGTManager", "Exit NGTManager");
                AppendMenuW(menu, MF_STRING, 1, open.as_ptr());
                AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
                AppendMenuW(menu, MF_STRING, 2, exit.as_ptr());
                let mut point: POINT = std::mem::zeroed();
                GetCursorPos(&mut point);
                SetForegroundWindow(window);
                match TrackPopupMenu(
                    menu,
                    TPM_RIGHTBUTTON | TPM_RETURNCMD,
                    point.x,
                    point.y,
                    0,
                    window,
                    std::ptr::null(),
                ) {
                    1 => {
                        PostMessageW(window, RUNTIME_UI_OPEN_MESSAGE, 0, 0);
                    }
                    2 => {
                        TRAY_EXIT_REQUESTED.store(true, Ordering::SeqCst);
                        update_runtime_ui_phase(RUNTIME_UI_PHASE_EXITING);
                        let _ = thread::Builder::new()
                            .name("ngt-tray-exit".to_owned())
                            .spawn(|| {
                                let closed = stable_root()
                                    .map(|root| close_managed_browser_window(&root))
                                    .unwrap_or(false);
                                if closed {
                                    let _ = request_runtime_stop();
                                } else {
                                    TRAY_EXIT_REQUESTED.store(false, Ordering::SeqCst);
                                    update_runtime_ui_phase(RUNTIME_UI_PHASE_READY);
                                    show_browser_close_blocked();
                                }
                            });
                    }
                    _ => {}
                }
                DestroyMenu(menu);
            }
            0
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

#[cfg(windows)]
fn show_browser_close_blocked() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND,
    };
    let title = runtime_ui_text(
        "NGTManager 未退出",
        "NGTManager non è stato chiuso",
        "NGTManager is still running",
    );
    let message = runtime_ui_text(
        "应用窗口未能安全关闭。后台和业务数据仍在运行，请关闭窗口后从托盘重试。",
        "La finestra dell'app non si è chiusa in modo sicuro. NGTManager e i dati restano attivi; chiudi la finestra e riprova dal menu dell'area di notifica.",
        "The application window did not close safely. NGTManager and its data remain running; close the window and retry from the tray menu.",
    );
    unsafe {
        MessageBoxW(
            RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND,
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING | MB_SETFOREGROUND,
        );
    }
}

#[cfg(windows)]
fn runtime_ui_text(zh: &str, it: &str, en: &str) -> Vec<u16> {
    let language =
        unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() } & 0x03ff;
    let value = match language {
        0x04 => zh,
        0x10 => it,
        _ => en,
    };
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn runtime_ui_phase_text(phase: usize) -> Vec<u16> {
    match phase {
        RUNTIME_UI_PHASE_DATABASE => runtime_ui_text(
            "正在启动数据库…",
            "Avvio del database…",
            "Starting the database…",
        ),
        RUNTIME_UI_PHASE_APPLICATION => runtime_ui_text(
            "正在启动应用…",
            "Avvio dell'applicazione…",
            "Starting the application…",
        ),
        RUNTIME_UI_PHASE_HEALTH => runtime_ui_text(
            "正在检查系统是否可用…",
            "Verifica della disponibilità…",
            "Checking system readiness…",
        ),
        RUNTIME_UI_PHASE_READY => runtime_ui_text(
            "NGTManager 已就绪",
            "NGTManager è pronto",
            "NGTManager is ready",
        ),
        RUNTIME_UI_PHASE_BROWSER_BLOCKED => runtime_ui_text(
            "未能确认业务窗口，请检查 Chrome 或 Edge 后从托盘重试",
            "Impossibile confermare la finestra; controlla Chrome o Edge e riprova dall'area di notifica",
            "The app window could not be confirmed; check Chrome or Edge and retry from the tray",
        ),
        RUNTIME_UI_PHASE_EXITING => runtime_ui_text(
            "正在安全退出 NGTManager…",
            "Chiusura sicura di NGTManager…",
            "Safely exiting NGTManager…",
        ),
        _ => runtime_ui_text(
            "正在检查安装状态…",
            "Verifica dell'installazione…",
            "Checking the installation…",
        ),
    }
}

#[cfg(windows)]
fn runtime_ui_phase_progress(phase: usize) -> usize {
    match phase {
        RUNTIME_UI_PHASE_DATABASE => 35,
        RUNTIME_UI_PHASE_APPLICATION => 65,
        RUNTIME_UI_PHASE_HEALTH => 85,
        RUNTIME_UI_PHASE_BROWSER_BLOCKED => 90,
        RUNTIME_UI_PHASE_READY => 100,
        _ => 10,
    }
}

#[cfg(windows)]
fn runtime_ui_step_text(phase: usize) -> Vec<u16> {
    let step = match phase {
        RUNTIME_UI_PHASE_CHECKING => 1,
        RUNTIME_UI_PHASE_DATABASE => 2,
        RUNTIME_UI_PHASE_APPLICATION => 3,
        RUNTIME_UI_PHASE_HEALTH | RUNTIME_UI_PHASE_READY | RUNTIME_UI_PHASE_BROWSER_BLOCKED => 4,
        _ => 0,
    };
    if step == 0 {
        return runtime_ui_text(
            "安全退出进行中",
            "Chiusura sicura in corso",
            "Safe exit in progress",
        );
    }
    runtime_ui_text(
        &format!("步骤 {step}/4"),
        &format!("Passaggio {step}/4"),
        &format!("Step {step}/4"),
    )
}

#[cfg(windows)]
fn runtime_ui_elapsed_text(elapsed_seconds: u64) -> Vec<u16> {
    if elapsed_seconds < 3 {
        return vec![0];
    }
    runtime_ui_text(
        &format!("当前步骤已用时 {elapsed_seconds} 秒"),
        &format!("Tempo della fase: {elapsed_seconds} s"),
        &format!("Current step: {elapsed_seconds}s"),
    )
}

#[cfg(windows)]
fn update_runtime_ui_phase(phase: usize) {
    let window = RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    if !window.is_null() {
        unsafe {
            let mut result = 0usize;
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageTimeoutW(
                window,
                RUNTIME_UI_PHASE_MESSAGE,
                phase,
                0,
                windows_sys::Win32::UI::WindowsAndMessaging::SMTO_ABORTIFHUNG,
                1_000,
                &mut result,
            );
        }
    }
}

#[cfg(windows)]
fn complete_and_hide_runtime_ui() -> bool {
    use windows_sys::Win32::Graphics::Gdi::UpdateWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SendMessageTimeoutW, SMTO_ABORTIFHUNG,
    };
    let window = RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    if window.is_null() || TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
        return false;
    }
    let send = |message, wparam| unsafe {
        let mut result = 0usize;
        SendMessageTimeoutW(
            window,
            message,
            wparam,
            0,
            SMTO_ABORTIFHUNG,
            1_000,
            &mut result,
        ) != 0
    };
    if unsafe { IsWindowVisible(window) == 0 } {
        return true;
    }
    if !send(RUNTIME_UI_PHASE_MESSAGE, RUNTIME_UI_PHASE_READY) {
        return false;
    }
    unsafe { UpdateWindow(window) };
    thread::sleep(Duration::from_millis(300));
    if TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
        return false;
    }
    let hidden = send(RUNTIME_UI_HIDE_MESSAGE, 0) && unsafe { IsWindowVisible(window) == 0 };
    if hidden {
        record_browser_event("manager.startup.ui_completed", "info", "none");
    }
    record_browser_event(
        "manager.startup.window_hidden",
        if hidden { "info" } else { "error" },
        if hidden {
            "none"
        } else {
            "STARTUP_WINDOW_HIDE_UNCONFIRMED"
        },
    );
    hidden
}

#[cfg(windows)]
fn show_browser_attention() {
    use windows_sys::Win32::UI::Shell::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    update_runtime_ui_phase(RUNTIME_UI_PHASE_BROWSER_BLOCKED);
    let window = RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    let mut result = 0;
    let hidden = !window.is_null()
        && unsafe {
            SendMessageTimeoutW(
                window,
                RUNTIME_UI_HIDE_MESSAGE,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1_000,
                &mut result,
            ) != 0
                && IsWindowVisible(window) == 0
        };
    if hidden {
        if let Some(candidate) = provisional_browser_window() {
            let _ = restore_hidden_browser(candidate);
        }
    }
    let mut tray: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    tray.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    tray.hWnd = window;
    tray.uID = 1;
    tray.uFlags = NIF_INFO;
    let title = runtime_ui_text(
        "NGTManager 需要处理浏览器窗口",
        "NGTManager: controlla il browser",
        "NGTManager: check the browser window",
    );
    let text = runtime_ui_text(
        "后台仍在运行。请处理 Chrome 或 Edge 窗口，再从托盘打开。",
        "Il programma è attivo. Controlla Chrome o Edge e riapri dall'area di notifica.",
        "The backend is running. Check Chrome or Edge, then reopen from the tray.",
    );
    let title_len = title.len().min(tray.szInfoTitle.len() - 1);
    let text_len = text.len().min(tray.szInfo.len() - 1);
    tray.szInfoTitle[..title_len].copy_from_slice(&title[..title_len]);
    tray.szInfo[..text_len].copy_from_slice(&text[..text_len]);
    unsafe {
        Shell_NotifyIconW(NIM_MODIFY, &tray);
    }
}

#[cfg(windows)]
fn signal_existing_runtime_ui(message: u32) -> bool {
    signal_runtime_ui_class("NGTManager.RuntimeUi", message)
}

#[cfg(windows)]
fn signal_runtime_ui_class(class_name: &str, message: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW};
    let class: Vec<u16> = class_name.encode_utf16().chain(Some(0)).collect();
    for _ in 0..20 {
        let window = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
        if !window.is_null() {
            return unsafe { PostMessageW(window, message, 0, 0) != 0 };
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

#[cfg(windows)]
fn stop_event_name() -> Vec<u16> {
    "Local\\NGTManagerStop"
        .encode_utf16()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
fn create_stop_event() -> Result<StopEvent, String> {
    let name = stop_event_name();
    let handle = unsafe {
        windows_sys::Win32::System::Threading::CreateEventW(std::ptr::null(), 1, 0, name.as_ptr())
    };
    if handle.is_null() {
        return Err(format!(
            "Unable to create the runtime stop signal: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(StopEvent(handle))
}

#[cfg(windows)]
fn request_runtime_stop() -> Result<(), String> {
    use windows_sys::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
    let name = stop_event_name();
    let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(2) {
            return Ok(());
        }
        return Err(format!("Unable to contact the running manager: {error}"));
    }
    let signaled = unsafe { SetEvent(handle) };
    unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    if signaled == 0 {
        return Err(format!(
            "Unable to request a safe shutdown: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn request_runtime_stop_with_source(root: &Path, source: &str) -> Result<(), String> {
    if !matches!(source, "user-request" | "maintenance-operation") {
        return Err("The runtime stop source is invalid.".to_owned());
    }
    let run_state = fs::read(root.join("state/runtime/run-state.json"))
        .ok()
        .and_then(|contents| serde_json::from_slice::<serde_json::Value>(&contents).ok());
    let run_id = run_state
        .as_ref()
        .and_then(|value| value["runId"].as_str())
        .filter(|value| !value.is_empty());
    let path = root.join("state").join("runtime").join("stop-request.json");
    let contents = serde_json::to_vec(&serde_json::json!({
        "formatVersion": 1,
        "runId": run_id,
        "source": source,
        "requestedAtUtc": iso_timestamp(),
    }))
    .map_err(|_| "Unable to encode the runtime stop request.".to_owned())?;
    atomic_write(&path, &contents)?;
    request_runtime_stop()
}

#[cfg(windows)]
fn runtime_stop_source(root: &Path) -> &'static str {
    if WINDOWS_SESSION_END.load(Ordering::SeqCst) {
        return "windows-session-end";
    }
    if TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
        return "tray-exit";
    }
    let run_id = fs::read(root.join("state/runtime/run-state.json"))
        .ok()
        .and_then(|contents| serde_json::from_slice::<serde_json::Value>(&contents).ok())
        .and_then(|value| value["runId"].as_str().map(str::to_owned));
    let request = fs::read(root.join("state/runtime/stop-request.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    match request.as_ref().and_then(|value| {
        run_id
            .as_deref()
            .filter(|run_id| value["runId"].as_str() == Some(*run_id))
            .and_then(|_| value["source"].as_str())
    }) {
        Some("maintenance-operation") => "maintenance-operation",
        Some("user-request") => "user-request",
        _ => "requested",
    }
}

#[cfg(windows)]
fn wait_for_runtime_stop(
    root: &Path,
    probe_release: Option<&Path>,
    allow_verified_legacy_recovery: bool,
    recovery_operation_id: Option<&str>,
) -> Result<File, String> {
    let lock_path = root.join("state").join("run.lock");
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut next_request = Instant::now();
    while Instant::now() < deadline {
        let lock = match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
        {
            Ok(lock) => Some(lock),
            Err(error) if is_lock_contention(&error) => None,
            Err(error) => {
                return Err(format!(
                    "Unable to check whether the runtime stopped: {error}"
                ));
            }
        };
        if let Some(lock) = lock {
            match lock.try_lock_exclusive() {
                Ok(()) => {
                    ensure_port_available(APPLICATION_PORT)?;
                    ensure_port_available(DATABASE_PORT)?;
                    ensure_previous_runtime_confirmed_until(
                        root,
                        Instant::now() + Duration::from_secs(120),
                        probe_release,
                        allow_verified_legacy_recovery,
                        recovery_operation_id,
                    )?;
                    match fs::symlink_metadata(root.join("data/postgres/postmaster.pid")) {
                        Ok(_) if !allow_verified_legacy_recovery => return Err("A PostgreSQL process marker is still present; its shutdown could not be confirmed.".to_owned()),
                        Ok(_) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => return Err(format!("Unable to inspect the PostgreSQL process marker: {error}")),
                    }
                    return Ok(lock);
                }
                Err(error) if is_lock_contention(&error) => {}
                Err(error) => return Err(format!("Unable to check the runtime lock: {error}")),
            }
        }
        if Instant::now() >= next_request {
            request_runtime_stop_with_source(root, "maintenance-operation")?;
            next_request = Instant::now() + Duration::from_secs(5);
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("The running application did not stop safely; installation was cancelled.".to_owned())
}

#[cfg(windows)]
fn ensure_previous_runtime_confirmed(root: &Path) -> Result<(), String> {
    ensure_previous_runtime_confirmed_until(
        root,
        Instant::now() + Duration::from_secs(30),
        None,
        false,
        None,
    )
}

#[cfg(windows)]
fn preflight_runtime_state(root: &Path) -> Result<(), String> {
    let path = root.join("state/runtime/run-state.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
            "The previous runtime stop state cannot be read; installation was cancelled: {error}"
        ))
        }
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(
            "The previous runtime stop state is not a regular file; installation was cancelled."
                .to_owned(),
        );
    }
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "The previous runtime stop state cannot be read; installation was cancelled: {error}"
        )
    })?;
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if value
            .get("formatVersion")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|version| version != 1)
        {
            return Err(
                "The previous runtime stop state version is unsupported; installation was cancelled."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_previous_runtime_confirmed_until(
    root: &Path,
    deadline: Instant,
    probe_release: Option<&Path>,
    allow_verified_legacy_recovery: bool,
    recovery_operation_id: Option<&str>,
) -> Result<(), String> {
    let path = root.join("state/runtime/run-state.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => Some(metadata),
        Ok(_) => return Err(
            "The previous runtime stop state is not a regular file; installation was cancelled."
                .to_owned(),
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
            "The previous runtime stop state cannot be read; installation was cancelled: {error}"
        ))
        }
    };
    if metadata.is_none() {
        return ensure_legacy_runtime_confirmed(
            root,
            deadline,
            probe_release,
            allow_verified_legacy_recovery,
        );
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(format!(
            "The previous runtime stop state cannot be read; installation was cancelled: {error}"
        ))
        }
    };
    let mut record = match serde_json::from_slice::<RuntimeRunRecord>(&bytes) {
        Ok(record) => record,
        Err(_) if allow_verified_legacy_recovery => {
            let recovery_started = Instant::now();
            let operation_id = recovery_operation_id.ok_or_else(|| {
                "The previous runtime stop state is invalid; installation was cancelled.".to_owned()
            })?;
            preserve_invalid_runtime_state(root, operation_id, &bytes)?;
            ensure_legacy_runtime_confirmed(root, deadline, probe_release, true)?;
            let mut recovered =
                RuntimeRunRecord::new(format!("recovery-{operation_id}"), "maintenance-recovery");
            mark_runtime_recovered(
                &mut recovered,
                "invalid-state",
                "RUNTIME_RUN_STATE_INVALID_RECOVERED",
            );
            write_runtime_run_at(&path, &recovered)?;
            log_shutdown_phase(
                root,
                "warning",
                "runtime.shutdown.recovered",
                "invalid-state",
                "RUNTIME_RUN_STATE_INVALID_RECOVERED",
                recovery_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            );
            return Ok(());
        }
        Err(_) => {
            return Err(
                "The previous runtime stop state is invalid; installation was cancelled."
                    .to_owned(),
            )
        }
    };
    if record.format_version != 1 {
        return Err(
            "The previous runtime stop state version is unsupported; installation was cancelled."
                .to_owned(),
        );
    }
    if !known_runtime_phase(&record.phase) || record.source == "candidate-validation" {
        return Err(
            "The previous runtime stop state is invalid; installation was cancelled.".to_owned(),
        );
    }
    if record.phase == "completed" && record.ended_at_utc.is_some() {
        Ok(())
    } else if record.phase == "startup-failed" && record.ended_at_utc.is_some() {
        ensure_legacy_runtime_confirmed(
            root,
            deadline,
            probe_release,
            allow_verified_legacy_recovery,
        )
    } else if allow_verified_legacy_recovery {
        let recovery_started = Instant::now();
        let original_phase = record.phase.clone();
        ensure_legacy_runtime_confirmed(root, deadline, probe_release, true)?;
        mark_runtime_recovered(
            &mut record,
            &original_phase,
            "STALE_RUNTIME_STATE_VERIFIED_STOPPED",
        );
        write_runtime_run_at(&path, &record)?;
        log_shutdown_phase(
            root,
            "warning",
            "runtime.shutdown.recovered",
            &original_phase,
            "STALE_RUNTIME_STATE_VERIFIED_STOPPED",
            recovery_started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        );
        Ok(())
    } else {
        Err("The previous runtime shutdown is unconfirmed; start and stop NGTManager normally before installing, updating, repairing, or uninstalling.".to_owned())
    }
}

#[cfg(windows)]
fn known_runtime_phase(phase: &str) -> bool {
    matches!(
        phase,
        "starting"
            | "database-starting"
            | "database-started"
            | "running"
            | "application-stop-requested"
            | "database-stop-requested"
            | "failed"
            | "unconfirmed"
            | "startup-failed"
            | "completed"
    )
}

#[cfg(windows)]
fn mark_runtime_recovered(record: &mut RuntimeRunRecord, phase: &str, reason: &str) {
    let recovered_at = iso_timestamp();
    record.phase = "startup-failed".to_owned();
    record.ended_at_utc = Some(recovered_at.clone());
    record.recovered_from_phase = Some(phase.to_owned());
    record.recovered_at_utc = Some(recovered_at);
    record.recovery_reason = Some(reason.to_owned());
}

#[cfg(windows)]
fn preserve_invalid_runtime_state(
    root: &Path,
    operation_id: &str,
    contents: &[u8],
) -> Result<(), String> {
    let path = root
        .join("state/runtime")
        .join(format!("run-state.invalid-{operation_id}.json"));
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {}
                _ => {
                    return Err(
                        "The preserved invalid runtime stop state is not a regular file."
                            .to_owned(),
                    )
                }
            }
            return fs::read(&path)
                .map_err(|read_error| {
                    format!("Unable to read the preserved invalid runtime stop state: {read_error}")
                })
                .and_then(|existing| {
                    if existing == contents {
                        Ok(())
                    } else {
                        Err("A different invalid runtime stop state already belongs to this operation."
                            .to_owned())
                    }
                });
        }
        Err(error) => {
            return Err(format!(
                "Unable to preserve the invalid runtime stop state: {error}"
            ))
        }
    };
    if let Err(error) = file.write_all(contents).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!(
            "Unable to preserve the invalid runtime stop state: {error}"
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_legacy_runtime_confirmed(
    root: &Path,
    deadline: Instant,
    probe_release: Option<&Path>,
    allow_verified_recovery: bool,
) -> Result<(), String> {
    let Some(config) = read_config(root)? else {
        return Ok(());
    };
    let installed_root = fs::canonicalize(&config.install_root).map_err(|_| {
        "The legacy installation path cannot be verified; installation was cancelled.".to_owned()
    })?;
    let expected_root = fs::canonicalize(root).map_err(|_| {
        "The legacy installation path cannot be verified; installation was cancelled.".to_owned()
    })?;
    let data_root = fs::canonicalize(&config.data_root).map_err(|_| {
        "The legacy database location cannot be verified; installation was cancelled.".to_owned()
    })?;
    let data_metadata = fs::symlink_metadata(&config.data_root).map_err(|_| {
        "The legacy database location cannot be verified; installation was cancelled.".to_owned()
    })?;
    let expected_data_root = fs::canonicalize(root.join("data")).map_err(|_| {
        "The legacy database location cannot be verified; installation was cancelled.".to_owned()
    })?;
    let release_root = fs::canonicalize(root.join("releases")).map_err(|_| {
        "The legacy runtime location cannot be verified; installation was cancelled.".to_owned()
    })?;
    let release = fs::canonicalize(&config.active_release).map_err(|_| {
        "The legacy runtime location cannot be verified; installation was cancelled.".to_owned()
    })?;
    if installed_root != expected_root
        || !data_metadata.is_dir()
        || is_reparse(&data_metadata)
        || data_root != expected_data_root
        || !release.starts_with(&release_root)
    {
        return Err("The legacy runtime paths do not belong to this installation; installation was cancelled.".to_owned());
    }

    let manifest = verify_release_until(&release, None, Some(deadline))?;
    if manifest.version != config.version {
        return Err("The legacy runtime version does not match its installation record; installation was cancelled.".to_owned());
    }
    let database = data_root.join("postgres");
    if inspect_postgres_directory(&database)? != PostgresDirectoryState::Initialized {
        return Err(
            "The legacy database is not a complete cluster; installation was cancelled.".to_owned(),
        );
    }

    if Instant::now() >= deadline {
        return Err("The legacy shutdown check exceeded its time limit.".to_owned());
    }
    let job = RuntimeJob::new()?;
    if allow_verified_recovery {
        let control_release =
            legacy_control_release(&release, probe_release, "runtime/postgres/bin/pg_ctl.exe")?;
        if !legacy_database_is_stopped(&job, control_release, root, &database, deadline)? {
            return Err(
                "The legacy database is still running; installation was cancelled.".to_owned(),
            );
        }
        log_line(
            root,
            "Legacy PostgreSQL is stopped; its raw backup will be verified by starting, querying, and cleanly stopping a copy.",
        );
        return Ok(());
    }

    let control_release = legacy_control_release(
        &release,
        probe_release,
        "runtime/postgres/bin/pg_controldata.exe",
    )?;
    let tool = control_release.join("runtime/postgres/bin/pg_controldata.exe");
    let version = run_postgres_tool(
        &job,
        &tool,
        &[std::ffi::OsString::from("--version")],
        control_release,
        root,
        deadline,
    )?;
    let database_version = fs::read_to_string(database.join("PG_VERSION"))
        .map_err(|_| "The legacy PostgreSQL version cannot be read.".to_owned())?;
    if !version.status.success()
        || postgres_major_version(&version.stdout) != Some(database_version.trim())
    {
        return Err(
            "The control-data tool version does not match the legacy database; installation was cancelled."
                .to_owned(),
        );
    }

    let output = run_postgres_tool(
        &job,
        &tool,
        &[
            std::ffi::OsString::from("-D"),
            database.as_os_str().to_owned(),
        ],
        control_release,
        root,
        deadline,
    )?;
    if !output.status.success() {
        return Err(legacy_control_failure(root, &output.status, &output));
    }
    let control_output = String::from_utf8_lossy(&output.stdout);
    if !postgres_cluster_is_clean(&control_output) {
        let state = postgres_cluster_state(&control_output).unwrap_or("unrecognized");
        return Err(format!(
            "The legacy PostgreSQL cluster is not confirmed cleanly shut down (state: {state})."
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn run_postgres_tool(
    job: &RuntimeJob,
    tool: &Path,
    args: &[std::ffi::OsString],
    release: &Path,
    root: &Path,
    deadline: Instant,
) -> Result<Output, String> {
    let temp = ascii_temp_directory()?;
    let mut command = Command::new(tool);
    command.args(args).env("LC_ALL", "C").env("LANG", "C");
    configure_runtime_command(&mut command, release, root, &temp);
    hide_console(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = job
        .spawn(&mut command)
        .map_err(|error| format!("Unable to start the PostgreSQL inspection tool: {error}"))?;
    match wait_child_until(
        &mut child,
        deadline.min(Instant::now() + Duration::from_secs(10)),
    )? {
        Some(_) => child
            .wait_with_output()
            .map_err(|error| format!("Unable to read the PostgreSQL inspection result: {error}")),
        None => Err("The PostgreSQL inspection tool timed out.".to_owned()),
    }
}

fn postgres_major_version(output: &[u8]) -> Option<&str> {
    let output = std::str::from_utf8(output).ok()?;
    let start = output.find("(PostgreSQL) ")? + "(PostgreSQL) ".len();
    let version = output[start..].split_whitespace().next()?;
    version.split('.').next()
}

#[cfg(windows)]
fn legacy_database_is_stopped(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    database: &Path,
    deadline: Instant,
) -> Result<bool, String> {
    let database_version = fs::read_to_string(database.join("PG_VERSION"))
        .map_err(|_| "The legacy PostgreSQL version cannot be read.".to_owned())?;
    let version = run_postgres_tool(
        job,
        &release.join("runtime/postgres/bin/pg_ctl.exe"),
        &[std::ffi::OsString::from("--version")],
        release,
        root,
        deadline,
    )?;
    if !version.status.success()
        || postgres_major_version(&version.stdout) != Some(database_version.trim())
    {
        return Err(
            "The PostgreSQL status tool version does not match the legacy database; installation was cancelled."
                .to_owned(),
        );
    }
    let output = run_postgres_tool(
        job,
        &release.join("runtime/postgres/bin/pg_ctl.exe"),
        &[
            std::ffi::OsString::from("-D"),
            database.as_os_str().to_owned(),
            std::ffi::OsString::from("status"),
        ],
        release,
        root,
        deadline,
    )?;
    pg_ctl_status(output.status.code()).map(|running| !running)
}

#[cfg(windows)]
fn legacy_control_failure(root: &Path, exit: &ExitStatus, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let (error_code, message) = classify_legacy_control_failure(exit.code(), &stderr);
    if let Some(logger) = manager_diagnostics(root) {
        logger.record(
            DiagnosticComponent::Database,
            "error",
            "database.legacy_control.failed",
            "legacy-shutdown-check",
            error_code,
        );
        let detail = format!(
            "pg_controldata exit={}\nstdout:\n{}\nstderr:\n{}",
            status_code(exit),
            String::from_utf8_lossy(&output.stdout),
            stderr
        );
        logger.detail(
            DiagnosticComponent::Database,
            &detail.as_bytes()[..detail.len().min(8192)],
        );
    }
    format!(
        "{message} Installation was cancelled (exit {}).",
        status_code(exit)
    )
}

fn classify_legacy_control_failure(
    exit_code: Option<i32>,
    stderr: &str,
) -> (&'static str, &'static str) {
    let lower = stderr.to_ascii_lowercase();
    match exit_code {
        Some(41) => (
            "POSTGRES_CONTROL_VERSION_UNREADABLE",
            "Unable to read the installed PostgreSQL or control-data tool version.",
        ),
        Some(42) => (
            "POSTGRES_CONTROL_VERSION_MISMATCH",
            "The control-data tool version does not match the installed PostgreSQL or database.",
        ),
        _ if lower.contains("permission denied") || lower.contains("access is denied") => (
            "POSTGRES_CONTROL_ACCESS_DENIED",
            "Windows denied access to the legacy PostgreSQL control file.",
        ),
        _ if lower.contains("could not open file")
            || lower.contains("no such file")
            || lower.contains("read 0 of")
            || lower.contains("wrong size") => (
            "POSTGRES_CONTROL_INCOMPLETE",
            "The legacy PostgreSQL control file is missing or incomplete.",
        ),
        _ if lower.contains("checksum") => (
            "POSTGRES_CONTROL_CHECKSUM_INVALID",
            "The legacy PostgreSQL control file failed its checksum check.",
        ),
        _ if lower.contains("version number") || lower.contains("not compatible") => (
            "POSTGRES_CONTROL_VERSION_MISMATCH",
            "The legacy PostgreSQL control file is not compatible with the verified PostgreSQL tool.",
        ),
        _ => (
            "POSTGRES_CONTROL_CHECK_FAILED",
            "The legacy PostgreSQL control-data check failed.",
        ),
    }
}

#[cfg(windows)]
fn legacy_control_release<'a>(
    installed: &'a Path,
    candidate: Option<&'a Path>,
    tool: &str,
) -> Result<&'a Path, String> {
    if installed.join(tool).is_file() {
        return Ok(installed);
    }
    candidate.filter(|path| path.join(tool).is_file()).ok_or_else(||
        "The installed PostgreSQL has no required inspection tool and no verified installation candidate supplied one.".to_owned())
}

fn postgres_cluster_is_clean(output: &str) -> bool {
    postgres_cluster_state(output) == Some("shut down")
}

fn postgres_cluster_state(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let (name, state) = line.split_once(':')?;
        (name.trim() == "Database cluster state").then_some(state.trim())
    })
}

#[cfg(not(windows))]
fn request_runtime_stop() -> Result<(), String> {
    Err("Runtime control is supported only on Windows x64.".to_owned())
}

#[cfg(windows)]
fn ascii_temp_directory() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let original = std::env::temp_dir();
    let mut candidates = vec![original.clone()];
    let wide: Vec<u16> = original.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut short = vec![0u16; 32768];
    let length =
        unsafe { GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
    if length > 0 && (length as usize) < short.len() {
        let short_path = PathBuf::from(String::from_utf16_lossy(&short[..length as usize]));
        if short_path.to_string_lossy().is_ascii() {
            candidates.insert(0, short_path);
        }
    }
    for candidate in candidates {
        if !candidate.to_string_lossy().is_ascii() {
            continue;
        }
        if fs::create_dir_all(&candidate).is_err() {
            continue;
        }
        let probe = candidate.join(format!(".write-probe-{}", unique_id()));
        if OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok()
        {
            let _ = fs::remove_file(probe);
            return Ok(candidate);
        }
    }
    Err(
        "No writable ASCII temporary directory is available for the bundled database runtime."
            .to_owned(),
    )
}

#[cfg(not(windows))]
fn ascii_temp_directory() -> Result<PathBuf, String> {
    Err("Runtime control is supported only on Windows x64.".to_owned())
}

struct RuntimeChildren {
    database: Child,
    application: Child,
    application_job: RuntimeJob,
}

#[cfg(windows)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRunRecord {
    format_version: u8,
    run_id: String,
    source: String,
    started_at_utc: String,
    phase: String,
    application_exit_code: Option<i32>,
    application_elapsed_ms: Option<u64>,
    database_exit_code: Option<i32>,
    database_elapsed_ms: Option<u64>,
    ended_at_utc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovered_from_phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovered_at_utc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_reason: Option<String>,
}

#[cfg(windows)]
impl RuntimeRunRecord {
    fn new(run_id: String, source: &str) -> Self {
        Self {
            format_version: 1,
            run_id,
            source: source.to_owned(),
            started_at_utc: iso_timestamp(),
            phase: "starting".to_owned(),
            application_exit_code: None,
            application_elapsed_ms: None,
            database_exit_code: None,
            database_elapsed_ms: None,
            ended_at_utc: None,
            recovered_from_phase: None,
            recovered_at_utc: None,
            recovery_reason: None,
        }
    }
}

#[cfg(windows)]
fn runtime_run_path(root: &Path, record: &RuntimeRunRecord) -> PathBuf {
    let name = if record.source == "candidate-validation" {
        "candidate-run.json"
    } else {
        "run-state.json"
    };
    root.join("state").join("runtime").join(name)
}

#[cfg(windows)]
fn write_runtime_run(root: &Path, record: &RuntimeRunRecord) -> Result<(), String> {
    write_runtime_run_at(&runtime_run_path(root, record), record)
}

#[cfg(windows)]
fn write_runtime_run_at(path: &Path, record: &RuntimeRunRecord) -> Result<(), String> {
    let contents = serde_json::to_vec(record)
        .map_err(|_| "Unable to encode runtime stop state.".to_owned())?;
    atomic_write(path, &contents)
}

#[cfg(windows)]
fn log_shutdown_phase(
    root: &Path,
    severity: &str,
    event_code: &str,
    phase: &str,
    error: &str,
    elapsed_ms: u64,
) {
    if let Some(logger) = manager_diagnostics(root) {
        logger.record_with_metrics(
            DiagnosticComponent::Manager,
            severity,
            event_code,
            phase,
            error,
            diagnostics::EventMetrics {
                elapsed_ms: Some(elapsed_ms),
                ..Default::default()
            },
        );
    }
}

#[cfg(windows)]
fn report_unconfirmed_previous_run(root: &Path) {
    let path = root.join("state").join("runtime").join("run-state.json");
    let record = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<RuntimeRunRecord>(&bytes) {
            Ok(record) => Some(record),
            Err(_) => {
                log_shutdown_phase(
                    root,
                    "warning",
                    "runtime.shutdown.unconfirmed",
                    "state-read",
                    "RUNTIME_RUN_STATE_INVALID",
                    0,
                );
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if root.join("state/runtime/stop-request.json").exists() {
                log_shutdown_phase(
                    root,
                    "warning",
                    "runtime.shutdown.unconfirmed",
                    "unknown",
                    "EXIT_UNKNOWN",
                    0,
                );
            }
            None
        }
        Err(_) => {
            log_shutdown_phase(
                root,
                "warning",
                "runtime.shutdown.unconfirmed",
                "state-read",
                "RUNTIME_RUN_STATE_UNREADABLE",
                0,
            );
            None
        }
    };
    if let Some(mut record) = record {
        if record.ended_at_utc.is_none() {
            log_shutdown_phase(
                root,
                "warning",
                "runtime.shutdown.unconfirmed",
                &record.phase,
                if record.source == "windows-session-end" {
                    "WINDOWS_SESSION_END_UNCONFIRMED"
                } else {
                    "RUNTIME_EXIT_UNCONFIRMED"
                },
                0,
            );
            record.phase = "unconfirmed".to_owned();
            record.ended_at_utc = Some(iso_timestamp());
            let _ = write_runtime_run_at(&path, &record);
        }
    }
}

#[cfg(windows)]
fn configure_runtime_command(command: &mut Command, release: &Path, root: &Path, temp: &Path) {
    command
        .current_dir(release)
        .env("NGT_STUDIO_ROOT", release)
        .env("NGT_MANAGER_ROOT", root)
        .env("NGT_DATA_ROOT", root.join("data"))
        .env("NGT_DB_DIR", root.join("data").join("postgres"))
        .env("NGT_RUNTIME_STATE", root.join("state").join("runtime"))
        .env("NGT_ENV_FILE", root.join("state").join("application.env"))
        .env("NGT_DB_PORT", DATABASE_PORT.to_string())
        .env("TEMP", temp)
        .env("TMP", temp);
}

#[cfg(windows)]
fn spawn_pg_ctl(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    args: &[std::ffi::OsString],
) -> Result<Child, String> {
    spawn_pg_ctl_until(job, release, root, args, None)
}

#[cfg(windows)]
fn spawn_pg_ctl_until(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    args: &[std::ffi::OsString],
    deadline: Option<Instant>,
) -> Result<Child, String> {
    let temp = ascii_temp_directory()?;
    let mut command = Command::new(release.join("runtime/node.exe"));
    command
        .arg("--require")
        .arg("./scripts/runtime-start-gate.cjs")
        .arg("./scripts/run-pg-ctl.mjs")
        .args(args);
    configure_runtime_command(&mut command, release, root, &temp);
    hide_console(&mut command);
    spawn_runtime_process_controlled(
        job,
        &mut command,
        root,
        DiagnosticComponent::Database,
        None,
        deadline,
    )
}

#[cfg(windows)]
fn start_database(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    stop: Option<&StopEvent>,
    run_state: &mut RuntimeRunRecord,
) -> Result<Child, String> {
    run_state.phase = "database-starting".to_owned();
    write_runtime_run(root, run_state)?;
    let temp = ascii_temp_directory()?;
    let state = root.join("state").join("runtime");
    fs::create_dir_all(&state)
        .map_err(|error| format!("Unable to create runtime state: {error}"))?;
    let ready = state.join("database-ready.pid");
    match fs::remove_file(&ready) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Unable to clear the stale database readiness marker: {error}"
            ))
        }
    }
    let mut command = Command::new(release.join("runtime").join("node.exe"));
    command
        .args([
            "--require",
            "./scripts/runtime-start-gate.cjs",
            "./scripts/windows-db.mjs",
        ])
        .stdin(Stdio::piped());
    configure_runtime_command(&mut command, release, root, &temp);
    hide_console(&mut command);
    let mut database = match spawn_runtime_process_controlled(
        job,
        &mut command,
        root,
        DiagnosticComponent::Database,
        stop,
        None,
    ) {
        Ok(database) => database,
        Err(error) => {
            if stop.is_some_and(StopEvent::is_signaled) {
                run_state.source = runtime_stop_source(root).to_owned();
                let clean =
                    job.terminate_and_wait().is_ok() && job.active_processes().ok() == Some(0);
                run_state.phase = if clean {
                    "completed".to_owned()
                } else {
                    "database-stop-unconfirmed".to_owned()
                };
                run_state.database_elapsed_ms = Some(0);
                run_state.ended_at_utc = Some(iso_timestamp());
                let _ = write_runtime_run(root, run_state);
                log_shutdown_phase(
                    root,
                    if clean { "info" } else { "error" },
                    "runtime.shutdown.phase.completed",
                    "database-start-cancelled-before-ready",
                    if clean {
                        "none"
                    } else {
                        "DATABASE_START_CLEANUP_UNCONFIRMED"
                    },
                    0,
                );
            }
            return Err(error);
        }
    };
    for _ in 0..180 {
        if stop.is_some_and(StopEvent::is_signaled) {
            let outcome =
                stop_database_launcher(job, &mut database, release, root, Duration::from_secs(4));
            record_startup_database_stop(root, run_state, &outcome, true);
            return Err("Runtime stop was requested while the database was starting.".to_owned());
        }
        let ready_process_id = fs::read_to_string(&ready)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if ready_process_id == Some(database.id()) {
            run_state.phase = "database-started".to_owned();
            if let Err(error) = write_runtime_run(root, run_state) {
                let outcome = stop_database_launcher(
                    job,
                    &mut database,
                    release,
                    root,
                    Duration::from_secs(30),
                );
                record_startup_database_stop(root, run_state, &outcome, false);
                return Err(error);
            }
            log_line(root, "Database runtime started.");
            return Ok(database);
        }
        let process_status = match database.try_wait() {
            Ok(status) => status,
            Err(error) => {
                let outcome = stop_database_launcher(
                    job,
                    &mut database,
                    release,
                    root,
                    Duration::from_secs(30),
                );
                record_startup_database_stop(root, run_state, &outcome, false);
                return Err(format!("Unable to monitor the database runtime: {error}"));
            }
        };
        if let Some(status) = process_status {
            let error = format!(
                "Database runtime exited during startup (code {}).",
                status_code(&status)
            );
            let outcome =
                stop_database_launcher(job, &mut database, release, root, Duration::from_secs(30));
            record_startup_database_stop(root, run_state, &outcome, false);
            return Err(error);
        }
        thread::sleep(Duration::from_millis(500));
    }
    let outcome =
        stop_database_launcher(job, &mut database, release, root, Duration::from_secs(30));
    record_startup_database_stop(root, run_state, &outcome, false);
    Err("Database runtime did not become ready within 90 seconds.".to_owned())
}

#[cfg(windows)]
fn record_startup_database_stop(
    root: &Path,
    run_state: &mut RuntimeRunRecord,
    outcome: &StopOutcome,
    session_end: bool,
) {
    if session_end {
        run_state.source = runtime_stop_source(root).to_owned();
    }
    run_state.database_exit_code = outcome.exit_code;
    run_state.database_elapsed_ms = Some(outcome.elapsed_ms);
    let clean = outcome.confirmed && outcome.error_code.is_none();
    run_state.phase = if clean && session_end {
        "completed".to_owned()
    } else if clean {
        "startup-failed".to_owned()
    } else {
        "database-stop-unconfirmed".to_owned()
    };
    run_state.ended_at_utc = Some(iso_timestamp());
    let _ = write_runtime_run(root, run_state);
    log_shutdown_phase(
        root,
        if clean { "info" } else { "error" },
        "runtime.shutdown.phase.completed",
        "database-startup-cleanup",
        outcome.error_code.unwrap_or("none"),
        outcome.elapsed_ms,
    );
}

#[cfg(windows)]
fn start_application(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    stop: Option<&StopEvent>,
) -> Result<Child, String> {
    let temp = ascii_temp_directory()?;
    let mut command = Command::new(release.join("runtime").join("node.exe"));
    command
        .args([
            "--require",
            "./scripts/runtime-start-gate.cjs",
            "./scripts/start.mjs",
        ])
        .stdin(Stdio::piped())
        .env("APP_HOST", "127.0.0.1")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", APPLICATION_PORT.to_string());
    configure_runtime_command(&mut command, release, root, &temp);
    hide_console(&mut command);
    spawn_runtime_process_controlled(
        job,
        &mut command,
        root,
        DiagnosticComponent::Application,
        stop,
        None,
    )
}

#[cfg(windows)]
fn run_migrations(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    operation_id: &str,
) -> Result<(), String> {
    let temp = ascii_temp_directory()?;
    set_operation_id(root, operation_id);
    let mut command = Command::new(release.join("runtime").join("node.exe"));
    command
        .arg("--require")
        .arg("./scripts/runtime-start-gate.cjs")
        .arg(format!(
            "--env-file={}",
            root.join("state").join("application.env").display()
        ))
        .arg("./node_modules/prisma/build/index.js")
        .args(["migrate", "deploy"]);
    configure_runtime_command(&mut command, release, root, &temp);
    hide_console(&mut command);
    let status = spawn_runtime_process(job, &mut command, root, DiagnosticComponent::Migration)?
        .wait()
        .map_err(|error| format!("Unable to wait for database migration: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Database migration failed (exit {}). See the diagnostic export for safe details.",
            status_code(&status)
        ));
    }
    Ok(())
}

fn health_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Unable to initialize application health client: {error}"))
}

fn health_matches_at(client: &reqwest::blocking::Client, url: &str, version: &str) -> bool {
    let Ok(response) = client.get(url).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .map(|value| value["status"] == "ok" && value["currentVersion"] == version)
        .unwrap_or(false)
}

#[cfg(windows)]
fn health_matches(client: &reqwest::blocking::Client, version: &str) -> bool {
    health_matches_at(
        client,
        &format!("http://127.0.0.1:{APPLICATION_PORT}/api/health"),
        version,
    )
}

#[cfg(windows)]
fn wait_for_health(
    application: &mut Child,
    version: &str,
    stop: Option<&StopEvent>,
) -> Result<(), String> {
    let client = health_client()?;
    for _ in 0..180 {
        if stop.is_some_and(StopEvent::is_signaled) {
            return Err("Runtime stop was requested during application startup.".to_owned());
        }
        if health_matches(&client, version) {
            return Ok(());
        }
        if let Some(status) = application
            .try_wait()
            .map_err(|error| format!("Unable to monitor the application: {error}"))?
        {
            return Err(format!(
                "Application exited before health validation (code {}).",
                status_code(&status)
            ));
        }
        thread::sleep(Duration::from_secs(1));
    }
    Err("Application did not pass the versioned health check within three minutes.".to_owned())
}

#[cfg(windows)]
fn stop_children(
    job: &RuntimeJob,
    children: &mut RuntimeChildren,
    release: &Path,
    root: &Path,
    run_state: &mut RuntimeRunRecord,
    shutdown_started: Option<Instant>,
) -> Result<(), String> {
    let mut state_write_failed = false;
    let shutdown_started = shutdown_started.unwrap_or_else(Instant::now);
    let session_end = run_state.source == "windows-session-end";
    let application_budget = if session_end {
        Duration::from_secs(1).saturating_sub(shutdown_started.elapsed())
    } else {
        Duration::from_secs(10)
    };
    run_state.phase = "application-stop-requested".to_owned();
    if write_runtime_run(root, run_state).is_err() {
        state_write_failed = true;
    }
    log_shutdown_phase(
        root,
        "info",
        "runtime.shutdown.phase.started",
        "application",
        "none",
        0,
    );
    let application = stop_application(
        &mut children.application,
        &children.application_job,
        application_budget,
    );
    if WINDOWS_SESSION_END.load(Ordering::SeqCst) {
        run_state.source = "windows-session-end".to_owned();
    }
    run_state.application_exit_code = application.exit_code;
    run_state.application_elapsed_ms = Some(application.elapsed_ms);
    run_state.phase = if application.confirmed {
        "application-stopped".to_owned()
    } else {
        "application-stop-unconfirmed".to_owned()
    };
    if write_runtime_run(root, run_state).is_err() {
        state_write_failed = true;
    }
    log_shutdown_phase(
        root,
        if application.error_code.is_none() {
            "info"
        } else {
            "error"
        },
        "runtime.shutdown.phase.completed",
        "application",
        application.error_code.unwrap_or("none"),
        application.elapsed_ms,
    );
    if let Some(logger) = manager_diagnostics(root) {
        logger.detail(
            DiagnosticComponent::Manager,
            format!(
                "runtime.shutdown.application.exit_code={:?}\n",
                application.exit_code
            )
            .as_bytes(),
        );
    }
    if !application.confirmed {
        run_state.phase = "failed".to_owned();
        run_state.ended_at_utc = Some(iso_timestamp());
        let _ = write_runtime_run(root, run_state);
        log_shutdown_phase(
            root,
            "error",
            "runtime.shutdown.failed",
            "final",
            "APPLICATION_STOP_UNCONFIRMED",
            application.elapsed_ms,
        );
        return Err("The web application process group could not be confirmed stopped; the database remains running.".to_owned());
    }
    run_state.phase = "database-stop-requested".to_owned();
    if write_runtime_run(root, run_state).is_err() {
        state_write_failed = true;
    }
    log_shutdown_phase(
        root,
        "info",
        "runtime.shutdown.phase.started",
        "database",
        "none",
        0,
    );
    let database_budget = if session_end {
        Duration::from_secs(4).saturating_sub(shutdown_started.elapsed())
    } else {
        Duration::from_secs(30)
    };
    let database =
        stop_database_launcher(job, &mut children.database, release, root, database_budget);
    if WINDOWS_SESSION_END.load(Ordering::SeqCst) {
        run_state.source = "windows-session-end".to_owned();
    }
    run_state.database_exit_code = database.exit_code;
    run_state.database_elapsed_ms = Some(database.elapsed_ms);
    run_state.phase = if database.confirmed {
        "database-stopped".to_owned()
    } else {
        "database-stop-unconfirmed".to_owned()
    };
    if write_runtime_run(root, run_state).is_err() {
        state_write_failed = true;
    }
    log_shutdown_phase(
        root,
        if database.error_code.is_none() {
            "info"
        } else {
            "error"
        },
        "runtime.shutdown.phase.completed",
        "database",
        database.error_code.unwrap_or("none"),
        database.elapsed_ms,
    );
    if let Some(logger) = manager_diagnostics(root) {
        logger.detail(
            DiagnosticComponent::Manager,
            format!(
                "runtime.shutdown.database.exit_code={:?}\n",
                database.exit_code
            )
            .as_bytes(),
        );
    }
    let failures = [application.error_code, database.error_code]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !database.confirmed {
        run_state.phase = "failed".to_owned();
        run_state.ended_at_utc = Some(iso_timestamp());
        let _ = write_runtime_run(root, run_state);
        log_shutdown_phase(
            root,
            "error",
            "runtime.shutdown.failed",
            "final",
            "DATABASE_STOP_UNCONFIRMED",
            database.elapsed_ms,
        );
        return Err("The database process group could not be confirmed stopped.".to_owned());
    }
    if !failures.is_empty() || state_write_failed {
        if run_state.source == "runtime-exit" && !state_write_failed {
            run_state.phase = "completed".to_owned();
            run_state.ended_at_utc = Some(iso_timestamp());
            write_runtime_run(root, run_state)?;
            log_shutdown_phase(
                root,
                "warning",
                "runtime.shutdown.restart_cleanup",
                "final",
                &failures.join(","),
                0,
            );
            return Ok(());
        }
        run_state.phase = "failed".to_owned();
        run_state.ended_at_utc = Some(iso_timestamp());
        let _ = write_runtime_run(root, run_state);
        log_shutdown_phase(
            root,
            "error",
            "runtime.shutdown.failed",
            "final",
            "RUNTIME_STOP_UNCLEAN",
            0,
        );
        return Err(format!(
            "Runtime shutdown required forced cleanup or the stop result could not be saved ({}; application_exit_code={:?}; database_exit_code={:?}).",
            if state_write_failed {
                "STOP_RESULT_WRITE_FAILED".to_owned()
            } else {
                failures.join(",")
            },
            application.exit_code,
            database.exit_code
        ));
    }
    run_state.phase = "completed".to_owned();
    run_state.ended_at_utc = Some(iso_timestamp());
    write_runtime_run(root, run_state)?;
    log_shutdown_phase(
        root,
        "info",
        "runtime.shutdown.completed",
        "final",
        "none",
        0,
    );
    Ok(())
}

#[cfg(windows)]
struct StopOutcome {
    confirmed: bool,
    error_code: Option<&'static str>,
    exit_code: Option<i32>,
    elapsed_ms: u64,
}

#[cfg(windows)]
fn stop_application(application: &mut Child, job: &RuntimeJob, budget: Duration) -> StopOutcome {
    let started = Instant::now();
    let deadline = started + budget;
    let mut control_sent = false;
    let was_running = application.try_wait().ok().flatten().is_none();
    if was_running {
        if let Some(mut stdin) = application.stdin.take() {
            control_sent = stdin
                .write_all(b"shutdown\n")
                .and_then(|_| stdin.flush())
                .is_ok();
        }
    }
    loop {
        let launcher_stopped = application.try_wait().ok().flatten().is_some();
        let active = job.active_processes().ok();
        if launcher_stopped && active == Some(0) {
            let exit_code = application
                .try_wait()
                .ok()
                .flatten()
                .and_then(|status| status.code());
            let expected_exit = matches!(exit_code, Some(0 | 143));
            let already_exited = !was_running && exit_code == Some(0);
            return StopOutcome {
                confirmed: true,
                error_code: if already_exited || (control_sent && expected_exit) {
                    None
                } else {
                    Some("APPLICATION_EXIT_UNEXPECTED")
                },
                exit_code,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
        }
        if Instant::now() >= session_shutdown_deadline(deadline, 1_000) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let terminated = job.terminate_and_wait().is_ok();
    let exit_code = application.wait().ok().and_then(|status| status.code());
    StopOutcome {
        confirmed: terminated && job.active_processes().ok() == Some(0),
        error_code: Some("APPLICATION_SHUTDOWN_TIMEOUT"),
        exit_code,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(windows)]
fn session_shutdown_deadline(normal_deadline: Instant, budget_ms: u64) -> Instant {
    if !WINDOWS_SESSION_END.load(Ordering::SeqCst) {
        return normal_deadline;
    }
    let started = WINDOWS_SESSION_END_TICK.load(Ordering::SeqCst);
    if started == 0 {
        return normal_deadline;
    }
    let now_tick = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
    let remaining = budget_ms.saturating_sub(now_tick.saturating_sub(started));
    normal_deadline.min(Instant::now() + Duration::from_millis(remaining))
}

#[cfg(windows)]
fn wait_child_until_shutdown(
    child: &mut Child,
    normal_deadline: Instant,
    session_budget_ms: u64,
) -> Result<Option<ExitStatus>, String> {
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(Some(status));
        }
        if Instant::now() >= session_shutdown_deadline(normal_deadline, session_budget_ms) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
fn stop_database_launcher(
    job: &RuntimeJob,
    database: &mut Child,
    release: &Path,
    root: &Path,
    budget: Duration,
) -> StopOutcome {
    let started = Instant::now();
    let deadline = started + budget;
    let data = root.join("data").join("postgres");
    let was_running = database.try_wait().ok().flatten().is_none();
    let mut error_code = if was_running {
        let signaled = database.stdin.take().is_some_and(|mut stdin| {
            stdin
                .write_all(b"shutdown\n")
                .and_then(|_| stdin.flush())
                .is_ok()
        });
        (!signaled).then_some("DATABASE_STOP_SIGNAL_FAILED")
    } else {
        None
    };
    if data.join("PG_VERSION").is_file() {
        let status_args = vec![
            std::ffi::OsString::from("-D"),
            data.as_os_str().to_owned(),
            std::ffi::OsString::from("status"),
        ];
        let status = spawn_pg_ctl_until(
            job,
            release,
            root,
            &status_args,
            Some(session_shutdown_deadline(deadline, 4_000)),
        )
        .and_then(|mut child| wait_child_until_shutdown(&mut child, deadline, 4_000));
        let is_running = match status {
            Ok(Some(status)) => pg_ctl_status(status.code()).unwrap_or_else(|_| {
                error_code = Some("DATABASE_STATUS_UNKNOWN");
                false
            }),
            Ok(None) => {
                error_code = Some("DATABASE_STATUS_TIMEOUT");
                false
            }
            Err(_) => {
                error_code = Some("DATABASE_STATUS_FAILED");
                false
            }
        };
        if is_running {
            let stop_args = vec![
                std::ffi::OsString::from("-D"),
                data.as_os_str().to_owned(),
                std::ffi::OsString::from("-m"),
                std::ffi::OsString::from("fast"),
                std::ffi::OsString::from("-w"),
                std::ffi::OsString::from("-t"),
                std::ffi::OsString::from("30"),
                std::ffi::OsString::from("stop"),
            ];
            let status = spawn_pg_ctl_until(
                job,
                release,
                root,
                &stop_args,
                Some(session_shutdown_deadline(deadline, 4_000)),
            )
            .and_then(|mut child| wait_child_until_shutdown(&mut child, deadline, 4_000));
            if !matches!(status, Ok(Some(ref status)) if status.success()) {
                error_code.get_or_insert("DATABASE_FAST_STOP_FAILED");
            }
        }
    } else if job.active_processes().unwrap_or(0) > 0 {
        error_code = Some("DATABASE_CONTROL_DATA_MISSING");
    }

    loop {
        let launcher_stopped = database.try_wait().ok().flatten().is_some();
        let active = job.active_processes().ok();
        if launcher_stopped && active == Some(0) {
            let exit_code = database
                .try_wait()
                .ok()
                .flatten()
                .and_then(|status| status.code());
            let graceful = error_code.is_none() && exit_code == Some(0);
            return StopOutcome {
                confirmed: true,
                error_code: if graceful {
                    None
                } else {
                    error_code.or(Some("DATABASE_LAUNCHER_EXIT_UNEXPECTED"))
                },
                exit_code,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
        }
        if Instant::now() >= session_shutdown_deadline(deadline, 4_000) {
            error_code.get_or_insert("DATABASE_SHUTDOWN_TIMEOUT");
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let terminated = job.terminate_and_wait().is_ok();
    let exit_code = database.wait().ok().and_then(|status| status.code());
    StopOutcome {
        confirmed: terminated && job.active_processes().ok() == Some(0),
        error_code: error_code.or(Some("DATABASE_SHUTDOWN_TIMEOUT")),
        exit_code,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(windows)]
fn wait_child_until(child: &mut Child, deadline: Instant) -> Result<Option<ExitStatus>, String> {
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn pg_ctl_status(exit_code: Option<i32>) -> Result<bool, String> {
    match exit_code {
        Some(0) => Ok(true),
        Some(3) => Ok(false),
        _ => Err(format!(
            "Unable to determine whether the business database is running (pg_ctl status exit {}).",
            exit_code.map_or_else(|| "unknown".to_owned(), |code| code.to_string())
        )),
    }
}

#[cfg(windows)]
fn owned_autostart_command(command: &str, root: &Path, legacy_root: &Path) -> bool {
    let normalize = |value: &str| value.replace('/', "\\").to_ascii_lowercase();
    let mut command = normalize(command);
    for (variable, value) in [
        ("%localappdata%", std::env::var("LOCALAPPDATA").ok()),
        ("%windir%", std::env::var("WINDIR").ok()),
    ] {
        if let Some(value) = value {
            command = command.replace(variable, &normalize(&value));
        }
    }
    let command = command.trim();
    let (program, arguments) = if let Some(quoted) = command.strip_prefix('"') {
        let Some(end) = quoted.find('"') else {
            return false;
        };
        (&quoted[..end], quoted[end + 1..].trim())
    } else {
        command
            .split_once(char::is_whitespace)
            .map_or((command, ""), |(program, arguments)| {
                (program, arguments.trim())
            })
    };
    let current = normalize(&root.join("tools/NGTManager.exe").to_string_lossy());
    if program == current {
        return true;
    }
    let legacy = normalize(
        &legacy_root
            .join("service/windows-studio-launcher.vbs")
            .to_string_lossy(),
    );
    program == legacy
        || (Path::new(program)
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("wscript.exe"))
            && (arguments.trim_matches('"') == legacy
                || arguments.contains(&format!("\"{legacy}\""))))
}

#[cfg(windows)]
fn remove_owned_startup_shortcuts(
    root: &Path,
    legacy_root: &Path,
    blocked: &mut [bool; 2],
) -> Result<(), String> {
    let folders = [
        std::env::var_os("APPDATA")
            .map(|base| PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs/Startup")),
        std::env::var_os("ProgramData")
            .map(|base| PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs/Startup")),
    ];
    for folder in folders.into_iter().flatten() {
        for (index, name) in ["NGTManager", "NGT Management System"].iter().enumerate() {
            let shortcut = folder.join(format!("{name}.lnk"));
            if !shortcut.is_file() {
                continue;
            }
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$OutputEncoding=[Text.UTF8Encoding]::new($false);$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:NGT_SHORTCUT_PATH);[Console]::Write('\"'+$s.TargetPath+'\" '+$s.Arguments)",
                ])
                .env("NGT_SHORTCUT_PATH", &shortcut)
                .stdin(Stdio::null());
            hide_console(&mut command);
            let output = command.output().map_err(|error| {
                format!("Unable to inspect an NGTManager startup shortcut: {error}")
            })?;
            if output.status.success()
                && owned_autostart_command(
                    &String::from_utf8_lossy(&output.stdout),
                    root,
                    legacy_root,
                )
            {
                fs::remove_file(&shortcut).map_err(|error| {
                    format!("Unable to remove an NGTManager startup shortcut: {error}")
                })?;
            } else {
                blocked[index] = true;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn remove_legacy_autostart(root: &Path) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
    };
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let legacy_root = root.parent().unwrap_or(root).join("NGT");
    let names = ["NGTManager", "NGT Management System"];
    let mut blocked = [false; 2];
    for subkey in [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
    ] {
        let subkey = wide(subkey);
        let mut key: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut key,
            )
        };
        if status == 2 {
            continue;
        }
        if status != 0 {
            return Err(format!(
                "Unable to open startup registration (os error {status})."
            ));
        }
        for (index, name) in names.iter().enumerate() {
            let name_wide = wide(name);
            let mut actual = vec![0u16; 32_768];
            let mut size = (actual.len() * 2) as u32;
            let mut kind = 0;
            let status = unsafe {
                RegQueryValueExW(
                    key,
                    name_wide.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    actual.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if status == 0 && (kind == REG_SZ || kind == REG_EXPAND_SZ) {
                actual.truncate((size as usize / 2).min(actual.len()));
                let actual = String::from_utf16_lossy(&actual)
                    .trim_end_matches('\0')
                    .to_owned();
                if owned_autostart_command(&actual, root, &legacy_root) {
                    let deleted = unsafe { RegDeleteValueW(key, name_wide.as_ptr()) };
                    if deleted != 0 && deleted != 2 {
                        unsafe { RegCloseKey(key) };
                        return Err(format!(
                            "Unable to remove startup registration (os error {deleted})."
                        ));
                    }
                } else {
                    blocked[index] = true;
                }
            } else if status != 2 {
                blocked[index] = true;
            }
        }
        unsafe { RegCloseKey(key) };
    }

    remove_owned_startup_shortcuts(root, &legacy_root, &mut blocked)?;

    for subkey in [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32",
        "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder",
    ] {
        let subkey = wide(subkey);
        let mut key: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut key,
            )
        };
        if status == 2 {
            continue;
        }
        if status != 0 {
            return Err(format!(
                "Unable to open startup approval metadata (os error {status})."
            ));
        }
        for (index, name) in names.iter().enumerate() {
            if blocked[index] {
                continue;
            }
            let deleted = unsafe { RegDeleteValueW(key, wide(name).as_ptr()) };
            if deleted != 0 && deleted != 2 {
                unsafe { RegCloseKey(key) };
                return Err(format!(
                    "Unable to remove startup approval metadata (os error {deleted})."
                ));
            }
            let deleted = unsafe { RegDeleteValueW(key, wide(&format!("{name}.lnk")).as_ptr()) };
            if deleted != 0 && deleted != 2 {
                unsafe { RegCloseKey(key) };
                return Err(format!(
                    "Unable to remove startup approval metadata (os error {deleted})."
                ));
            }
        }
        unsafe { RegCloseKey(key) };
    }
    remove_legacy_startup_task(&legacy_root)?;
    Ok(())
}

#[cfg(windows)]
fn remove_legacy_startup_task(legacy_root: &Path) -> Result<(), String> {
    let output = Command::new("schtasks.exe")
        .args(["/Query", "/TN", "NGT Management System", "/XML"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Unable to inspect the legacy startup task: {error}"))?;
    if !output.status.success() {
        return Ok(());
    }
    let xml = decode_windows_command_output(&output.stdout).to_ascii_lowercase();
    let launcher = legacy_root
        .join("service/windows-studio-launcher.vbs")
        .to_string_lossy()
        .to_ascii_lowercase();
    if !xml.contains("wscript.exe") || !xml.contains(&launcher) {
        return Ok(());
    }
    let mut command = Command::new("schtasks.exe");
    command
        .args(["/Delete", "/TN", "NGT Management System", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let status = command
        .status()
        .map_err(|error| format!("Unable to remove the legacy startup task: {error}"))?;
    if !status.success() {
        return Err("Unable to remove the verified legacy startup task.".to_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn decode_windows_command_output(bytes: &[u8]) -> String {
    let utf16 =
        bytes.starts_with(&[0xff, 0xfe]) || (bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0);
    if utf16 {
        let start = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        let (pairs, _) = bytes[start..].as_chunks::<2>();
        let units = pairs
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(not(windows))]
fn remove_legacy_autostart(_root: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn read_build_number() -> Result<u32, String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
    };
    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let value: Vec<u16> = "CurrentBuildNumber".encode_utf16().chain(Some(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    let opened =
        unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, subkey.as_ptr(), 0, KEY_READ, &mut key) };
    if opened != 0 {
        return Err(format!(
            "Unable to read the Windows version (error {opened})."
        ));
    }
    let mut kind = 0;
    let mut bytes = [0u8; 64];
    let mut size = bytes.len() as u32;
    let queried = unsafe {
        RegQueryValueExW(
            key,
            value.as_ptr(),
            std::ptr::null(),
            &mut kind,
            bytes.as_mut_ptr(),
            &mut size,
        )
    };
    unsafe { RegCloseKey(key) };
    if queried != 0 || kind != REG_SZ {
        return Err("Unable to read the Windows build number.".to_owned());
    }
    let units =
        unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u16, size as usize / 2) };
    String::from_utf16_lossy(units)
        .trim_end_matches('\0')
        .parse::<u32>()
        .map_err(|_| "Windows build number is invalid.".to_owned())
}

#[cfg(windows)]
fn check_windows_build() -> Result<(), String> {
    if read_build_number()? < 19045 {
        return Err("NGTManager requires Windows 10 22H2 (build 19045) or newer.".to_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn database_backup_exists(root: &Path) -> bool {
    root.join("data")
        .join("postgres")
        .join("PG_VERSION")
        .is_file()
}

#[cfg(windows)]
fn backup_database(
    release: &Path,
    root: &Path,
    operation_id: &str,
    transaction: &mut Transaction,
) -> Result<(), String> {
    if !database_backup_exists(root) {
        return Ok(());
    }
    let backup_root = root.join("backups").join(operation_id);
    let backup_data = backup_root.join("database");
    transaction.backup_root = Some(backup_root.clone());
    advance_transaction(root, transaction, Stage::BackupCreating)?;
    fs::create_dir_all(&backup_root)
        .map_err(|error| format!("Unable to create operation backup: {error}"))?;
    copy_directory(&root.join("data/postgres"), &backup_data, true)?;
    advance_transaction(root, transaction, Stage::BackupCreated)?;
    advance_transaction(root, transaction, Stage::BackupVerifying)?;
    verify_database_copy(release, root, &backup_root, &backup_data)?;
    advance_transaction(root, transaction, Stage::BackupVerified)
}

#[cfg(windows)]
fn verify_database_copy(
    release: &Path,
    root: &Path,
    backup_root: &Path,
    backup_data: &Path,
) -> Result<(), String> {
    ensure_port_available(DATABASE_PORT + 1)?;
    let verification = backup_root.join("verification");
    copy_directory(backup_data, &verification, false)?;
    remove_stale_postmaster_marker(&verification)?;
    let log = backup_root.join("verification.log");
    verify_database_directory(release, root, &verification, &log)?;
    remove_owned_directory(backup_root, &verification)
}

#[cfg(windows)]
fn remove_stale_postmaster_marker(database: &Path) -> Result<(), String> {
    let marker = database.join("postmaster.pid");
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => fs::remove_file(&marker)
            .map_err(|error| {
                format!("Unable to remove the verified stale database marker: {error}")
            }),
        Ok(_) => Err("The database process marker is not a safe regular file.".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Unable to inspect the database process marker: {error}"
        )),
    }
}

#[cfg(windows)]
fn recover_legacy_database_after_backup(
    release: &Path,
    root: &Path,
    backup_root: &Path,
) -> Result<(), String> {
    let database = root.join("data/postgres");
    let job = RuntimeJob::new()?;
    if !legacy_database_is_stopped(
        &job,
        release,
        root,
        &database,
        Instant::now() + Duration::from_secs(10),
    )? {
        return Err("The legacy database is still running; recovery was not attempted.".to_owned());
    }
    remove_stale_postmaster_marker(&database)?;
    verify_database_directory(
        release,
        root,
        &database,
        &backup_root.join("legacy-recovery.log"),
    )?;
    log_line(
        root,
        "Legacy PostgreSQL crash recovery completed and shut down cleanly.",
    );
    Ok(())
}

#[cfg(windows)]
fn verify_database_directory(
    release: &Path,
    root: &Path,
    verification: &Path,
    log: &Path,
) -> Result<(), String> {
    ensure_port_available(DATABASE_PORT + 1)?;
    let job = RuntimeJob::new()?;
    let start_args = vec![
        std::ffi::OsString::from("-D"),
        verification.as_os_str().to_owned(),
        std::ffi::OsString::from("-o"),
        std::ffi::OsString::from("-h 127.0.0.1 -p 55433"),
        std::ffi::OsString::from("-w"),
        std::ffi::OsString::from("-t"),
        std::ffi::OsString::from("60"),
        std::ffi::OsString::from("start"),
        std::ffi::OsString::from("-l"),
        log.as_os_str().to_owned(),
    ];
    let mut start = spawn_pg_ctl(&job, release, root, &start_args)?;
    let start_status = wait_child_until(&mut start, Instant::now() + Duration::from_secs(70))
        .map_err(|error| format!("Unable to verify the database backup: {error}"))?
        .ok_or_else(|| "Backup database startup timed out.".to_owned())?;
    if !start_status.success() {
        return Err(format!(
            "Database backup verification failed (exit {}).",
            status_code(&start_status)
        ));
    }
    let query_result = (|| {
        let secret = fs::read(root.join("data/local-secrets.json"))
            .map_err(|_| "Unable to read database verification credentials.".to_owned())?;
        let secret: serde_json::Value = serde_json::from_slice(&secret)
            .map_err(|_| "Invalid database verification credentials.".to_owned())?;
        let password = secret["password"]
            .as_str()
            .ok_or_else(|| "Missing database verification credentials.".to_owned())?;
        let mut command = Command::new(release.join("runtime/node.exe"));
        let temp = ascii_temp_directory()?;
        configure_runtime_command(&mut command, release, root, &temp);
        command.env("PGPASSWORD", password).args(["--input-type=module", "-e", r#"
import pg from 'pg';
const client = new pg.Client({host:'127.0.0.1',port:55433,user:'ngt',database:'ngt',connectionTimeoutMillis:5000,statement_timeout:5000});
await client.connect();
try { await client.query('SELECT 1 FROM "WorkOrder" LIMIT 1'); }
finally { await client.end(); }
"#]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_console(&mut command);
        let mut child = job
            .spawn(&mut command)
            .map_err(|error| format!("Unable to start backup structure check: {error}"))?;
        match wait_child_until(&mut child, Instant::now() + Duration::from_secs(12)) {
            Ok(Some(status)) if status.success() => Ok(()),
            _ => Err("The backup database did not pass its structure check.".to_owned()),
        }
    })();
    let stop_args = vec![
        std::ffi::OsString::from("-D"),
        verification.as_os_str().to_owned(),
        std::ffi::OsString::from("-m"),
        std::ffi::OsString::from("fast"),
        std::ffi::OsString::from("-w"),
        std::ffi::OsString::from("-t"),
        std::ffi::OsString::from("30"),
        std::ffi::OsString::from("stop"),
    ];
    let mut stop = spawn_pg_ctl(&job, release, root, &stop_args)?;
    let stop_status = wait_child_until(&mut stop, Instant::now() + Duration::from_secs(40))
        .map_err(|error| format!("Unable to stop the verification database: {error}"))?
        .ok_or_else(|| "Verification database shutdown timed out.".to_owned())?;
    if !stop_status.success() {
        return Err(format!(
            "Verification database did not stop cleanly (exit {}).",
            status_code(&stop_status)
        ));
    }
    drop(job);
    query_result
}

#[cfg(windows)]
fn restore_database(
    root: &Path,
    backup_root: &Path,
    transaction: &mut Transaction,
) -> Result<(), String> {
    let operation_id = &transaction.operation_id;
    if operation_id.is_empty()
        || operation_id.len() > 64
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("The database recovery operation ID is invalid.".to_owned());
    }
    let data_root = root.join("data");
    let data = data_root.join("postgres");
    let backup = backup_root.join("database");
    let backup_metadata = fs::symlink_metadata(&backup).map_err(|_| {
        "The verified database backup is missing; original data was preserved.".to_owned()
    })?;
    let backup_version = fs::symlink_metadata(backup.join("PG_VERSION")).map_err(|_| {
        "The verified database backup is missing; original data was preserved.".to_owned()
    })?;
    if !backup_metadata.is_dir()
        || is_reparse(&backup_metadata)
        || !backup_version.is_file()
        || is_reparse(&backup_version)
    {
        return Err(
            "The verified database backup is missing; original data was preserved.".to_owned(),
        );
    }
    let preserved = data_root.join(format!("postgres-interrupted-{operation_id}"));
    let staging = data_root.join(format!("postgres-restoring-{operation_id}"));
    let directory_exists = |path: &Path| -> Result<bool, String> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            _ => Err("A recovery database path is unsafe or unreadable.".to_owned()),
        }
    };
    let preserved_exists = directory_exists(&preserved)?;
    let active_exists = directory_exists(&data)?;
    let staging_exists = directory_exists(&staging)?;
    if transaction.restore_verified && preserved_exists && active_exists && !staging_exists {
        if inspect_postgres_directory(&data)? != PostgresDirectoryState::Initialized {
            return Err(
                "The switched recovery database is incomplete; both copies were preserved."
                    .to_owned(),
            );
        }
        return Ok(());
    }
    if (preserved_exists && active_exists) || (!preserved_exists && !active_exists) {
        return Err("The database recovery copies do not match the recorded operation; all copies were preserved.".to_owned());
    }
    if !transaction.restore_verified {
        if preserved_exists {
            return Err(
                "A preserved database exists without a verified recovery record.".to_owned(),
            );
        }
        if staging_exists {
            remove_owned_directory(&data_root, &staging)?;
        }
        let previous = transaction
            .previous_config
            .as_ref()
            .ok_or_else(|| "The previous database runtime could not be verified.".to_owned())?;
        verify_release(&previous.active_release)?;
        check_space(
            &data_root,
            directory_size(&backup)?.saturating_add(128 * 1024 * 1024),
        )?;
        copy_directory(&backup, &staging, true)?;
        remove_stale_postmaster_marker(&staging)?;
        verify_database_directory(
            &previous.active_release,
            root,
            &staging,
            &backup_root.join("recovery-verification.log"),
        )?;
        transaction.restore_verified = true;
        write_transaction(root, transaction)?;
    } else if !staging_exists {
        return Err(
            "The verified recovery staging directory is missing; existing data was preserved."
                .to_owned(),
        );
    }
    if inspect_postgres_directory(&staging)? != PostgresDirectoryState::Initialized {
        return Err(
            "The verified recovery staging directory is incomplete; existing data was preserved."
                .to_owned(),
        );
    }
    if !preserved_exists {
        fs::rename(&data, &preserved).map_err(|error| {
            format!("Unable to preserve the current database before recovery: {error}")
        })?;
    }
    fs::rename(&staging, &data)
        .map_err(|error| format!("Unable to activate the recovered database: {error}"))?;
    Ok(())
}

fn remove_owned_directory(parent: &Path, target: &Path) -> Result<(), String> {
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Unable to verify cleanup directory: {error}"))?;
    let target_metadata = fs::symlink_metadata(target)
        .map_err(|error| format!("Unable to inspect cleanup target: {error}"))?;
    if !target_metadata.is_dir() || is_reparse(&target_metadata) {
        return Err("Cleanup target is not a regular directory.".to_owned());
    }
    let actual_parent = fs::canonicalize(target.parent().expect("cleanup target parent"))
        .map_err(|error| format!("Unable to verify cleanup target parent: {error}"))?;
    if actual_parent != parent {
        return Err("Cleanup target is outside the operation-owned directory.".to_owned());
    }
    fs::remove_dir_all(target)
        .map_err(|error| format!("Unable to clean up operation files: {error}"))
}

fn advance_transaction(
    root: &Path,
    transaction: &mut Transaction,
    next: Stage,
) -> Result<(), String> {
    require_transition(&transaction.stage, &next)?;
    transaction.stage = next;
    write_transaction(root, transaction)
}

fn copy_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "The runtime tool directory is invalid.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create the runtime tool directory: {error}"))?;
    let temporary = destination.with_file_name(format!(
        "{}.{}.tmp",
        destination.file_name().unwrap().to_string_lossy(),
        unique_id()
    ));
    fs::copy(source, &temporary)
        .map_err(|error| format!("Unable to deploy {}: {error}", source.display()))?;
    #[cfg(windows)]
    if destination.exists() {
        if let Err(error) = windows_replace(&temporary, destination) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        return Ok(());
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Unable to activate runtime tool: {error}"))
}

fn create_transaction(
    root: &Path,
    operation: Operation,
    operation_id: String,
    previous_config: Option<ManagerConfig>,
    database_state: PostgresDirectoryState,
) -> Result<Transaction, String> {
    if let Ok(previous) = read_transaction(root) {
        if !terminal(&previous.stage) {
            return Err(
                "An unfinished operation requires recovery before installation can start."
                    .to_owned(),
            );
        }
    }
    let transaction = Transaction {
        format_version: TRANSACTION_VERSION,
        operation_id,
        operation,
        stage: Stage::Preparing,
        previous_release: previous_config
            .as_ref()
            .map(|config| config.active_release.clone()),
        candidate_release: None,
        backup_root: None,
        previous_config,
        migration_started: false,
        database_was_present: database_state == PostgresDirectoryState::Initialized,
        database_directory_was_empty: database_state == PostgresDirectoryState::Empty,
        database_initialization_directory: None,
        database_initialization_owned: false,
        database_initialization_published: false,
        failure: None,
        restore_verified: false,
    };
    write_transaction(root, &transaction)?;
    Ok(transaction)
}

struct InstallProgress {
    operation_id: String,
    started: Instant,
    setup_elapsed_ms: u64,
    phase: Arc<Mutex<ProgressPhase>>,
    cancel_file: Option<PathBuf>,
    progress_file: Option<PathBuf>,
    stop_sender: mpsc::Sender<()>,
    heartbeat: Option<thread::JoinHandle<()>>,
    finished: Mutex<bool>,
}

struct ProgressPhase {
    name: String,
    started: Instant,
    item_count: Option<u32>,
    bytes: Option<u64>,
    total_item_count: Option<u32>,
    total_bytes: Option<u64>,
}

impl InstallProgress {
    fn new(operation_id: &str) -> Self {
        let operation_id = operation_id.to_owned();
        let cancel_file = INSTALL_CANCEL_FILE.get().cloned().flatten();
        let progress_file = INSTALL_PROGRESS_FILE.get().cloned().flatten();
        let setup_elapsed_ms = INSTALL_EXTRACTION_METRICS
            .get()
            .and_then(|metrics| metrics.as_ref())
            .map_or(0, |(elapsed_ms, _)| *elapsed_ms);
        let started = Instant::now();
        let phase = Arc::new(Mutex::new(ProgressPhase {
            name: "starting".to_owned(),
            started,
            item_count: None,
            bytes: None,
            total_item_count: None,
            total_bytes: None,
        }));
        let thread_phase = Arc::clone(&phase);
        let thread_id = operation_id.clone();
        let thread_started = started;
        let thread_cancel_file = cancel_file.clone();
        let thread_progress_file = progress_file.clone();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let heartbeat = thread::Builder::new()
            .name("ngt-install-progress".to_owned())
            .spawn(move || loop {
                match stop_receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let (current, phase_elapsed, files, bytes, total_files, total_bytes) = {
                            let current = thread_phase
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            (
                                current.name.clone(),
                                current.started.elapsed().as_secs(),
                                current.item_count,
                                current.bytes,
                                current.total_item_count,
                                current.total_bytes,
                            )
                        };
                        let cancel_pending = thread_cancel_file
                            .as_ref()
                            .filter(|path| cancel_file_exists(path, &thread_id))
                            .map_or(0, |_| if current == "commit_release" { 2 } else { 1 });
                        publish_install_progress(
                            thread_progress_file.as_deref(),
                            &format!(
                                "NGT_PROGRESS|{thread_id}|{current}|{phase_elapsed}|{}|{}|{}|{}|{}|{}",
                                setup_elapsed_ms / 1000 + thread_started.elapsed().as_secs(),
                                cancel_pending,
                                files.map(|v| v.to_string()).unwrap_or_default(),
                                bytes.map(|v| v.to_string()).unwrap_or_default(),
                                total_files.map(|v| v.to_string()).unwrap_or_default(),
                                total_bytes.map(|v| v.to_string()).unwrap_or_default()
                            ),
                        );
                    }
                }
            })
            .ok();
        let progress = Self {
            operation_id,
            started,
            setup_elapsed_ms,
            phase,
            cancel_file,
            progress_file,
            stop_sender,
            heartbeat,
            finished: Mutex::new(false),
        };
        progress.set_phase("environment_check");
        progress
    }

    fn set_phase(&self, phase: &str) {
        self.set_phase_with_metrics(phase, None, None);
    }

    fn set_current_metrics(&self, item_count: Option<u32>, bytes: Option<u64>) {
        let mut current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
        current.item_count = item_count;
        current.bytes = bytes;
    }

    fn set_progress_totals(&self, item_count: Option<u32>, bytes: Option<u64>) {
        let mut current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
        current.total_item_count = item_count;
        current.total_bytes = bytes;
    }

    fn set_phase_with_metrics(&self, phase: &str, item_count: Option<u32>, bytes: Option<u64>) {
        self.transition_phase(
            phase,
            item_count,
            bytes,
            "info",
            "installer.phase.completed",
            "none",
        );
    }

    fn set_phase_failure(&self, phase: &str) {
        self.set_phase_failure_with_code(phase, "INSTALL_PHASE_FAILED");
    }

    fn set_phase_failure_with_code(&self, phase: &str, error_code: &str) {
        self.transition_phase(
            phase,
            None,
            None,
            "error",
            "installer.phase.failed",
            error_code,
        );
    }

    fn transition_phase(
        &self,
        phase: &str,
        item_count: Option<u32>,
        bytes: Option<u64>,
        severity: &str,
        event_code: &str,
        error_code: &str,
    ) {
        if !phase
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return;
        }
        let (completed_name, elapsed_ms, completed_count, completed_bytes) = {
            let mut current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
            let previous = (
                current.name.clone(),
                current.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                current.item_count,
                current.bytes,
            );
            current.name = phase.to_owned();
            current.started = Instant::now();
            current.item_count = item_count;
            current.bytes = bytes;
            current.total_item_count = None;
            current.total_bytes = None;
            previous
        };
        if completed_name != "starting" {
            if let Some(logger) = stable_root()
                .ok()
                .and_then(|root| manager_diagnostics(&root))
            {
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    severity,
                    event_code,
                    &completed_name,
                    error_code,
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(elapsed_ms),
                        phase_item_count: completed_count,
                        phase_bytes: completed_bytes,
                    },
                );
            }
        }
        let phase_elapsed = self
            .phase
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .started
            .elapsed()
            .as_secs();
        publish_install_progress(
            self.progress_file.as_deref(),
            &format!(
                "NGT_PROGRESS|{}|{}|{}|{}|{}",
                self.operation_id,
                phase,
                phase_elapsed,
                self.setup_elapsed_ms / 1000 + self.started.elapsed().as_secs(),
                self.cancel_status()
            ),
        );
    }

    fn cancel_requested(&self) -> bool {
        self.cancel_file
            .as_ref()
            .is_some_and(|path| cancel_file_exists(path, &self.operation_id))
    }

    fn cancel_status(&self) -> u8 {
        if !self.cancel_requested() {
            return 0;
        }
        let phase = self
            .phase
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .name
            .clone();
        if phase == "commit_release" {
            2
        } else {
            1
        }
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel_requested() {
            Err("Installation cancellation was requested; the current safe operation was rolled back.".to_owned())
        } else {
            Ok(())
        }
    }

    fn finish(&self, outcome: &str) {
        self.set_phase(outcome);
        if let Some(logger) = stable_root()
            .ok()
            .and_then(|root| manager_diagnostics(&root))
        {
            if outcome == "complete" {
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    "info",
                    "installer.install.completed",
                    "complete",
                    "none",
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(self.total_elapsed_ms()),
                        ..Default::default()
                    },
                );
            } else {
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    "error",
                    if outcome == "recovery_failed" {
                        "installer.recovery.failed"
                    } else {
                        "installer.install.failed"
                    },
                    outcome,
                    if outcome == "recovery_failed" {
                        "RECOVERY_FAILED"
                    } else {
                        "INSTALL_FAILED"
                    },
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(self.total_elapsed_ms()),
                        ..Default::default()
                    },
                );
            }
        }
        *self
            .finished
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = true;
        let _ = self.stop_sender.send(());
    }

    fn finish_failure(&self, outcome: &str) {
        self.set_phase_failure(outcome);
        if let Some(logger) = stable_root()
            .ok()
            .and_then(|root| manager_diagnostics(&root))
        {
            logger.record_with_metrics(
                DiagnosticComponent::Installer,
                "error",
                "installer.recovery.failed",
                outcome,
                "RECOVERY_FAILED",
                diagnostics::EventMetrics {
                    elapsed_ms: Some(self.total_elapsed_ms()),
                    ..Default::default()
                },
            );
        }
        *self
            .finished
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = true;
        let _ = self.stop_sender.send(());
    }

    fn total_elapsed_ms(&self) -> u64 {
        self.setup_elapsed_ms
            .saturating_add(self.started.elapsed().as_millis().min(u64::MAX as u128) as u64)
    }

    fn record_package_extraction(&self) {
        let Some(logger) = stable_root()
            .ok()
            .and_then(|root| manager_diagnostics(&root))
        else {
            return;
        };
        if let Some(Some((elapsed_ms, item_count))) = INSTALL_EXTRACTION_METRICS.get() {
            logger.record_with_metrics(
                DiagnosticComponent::Installer,
                "info",
                "installer.package.extracted",
                "package-extraction",
                "none",
                diagnostics::EventMetrics {
                    elapsed_ms: Some(*elapsed_ms),
                    phase_item_count: Some(*item_count),
                    ..Default::default()
                },
            );
        }
    }
}

fn publish_install_progress(path: Option<&Path>, line: &str) {
    println!("{line}");
    if let Some(path) = path {
        let _ = fs::write(path, line.as_bytes());
    }
}

fn cancel_file_exists(path: &Path, operation_id: &str) -> bool {
    let expected_name = format!("NGTManager-{operation_id}.cancel");
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent) = fs::canonicalize(parent) else {
        return false;
    };
    let Ok(temp_root) = std::env::temp_dir().canonicalize() else {
        return false;
    };
    if !parent.starts_with(temp_root) {
        return false;
    }
    matches!(
        fs::symlink_metadata(path),
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata)
    )
}

impl Drop for InstallProgress {
    fn drop(&mut self) {
        if !*self
            .finished
            .lock()
            .unwrap_or_else(|error| error.into_inner())
        {
            let current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(logger) = stable_root()
                .ok()
                .and_then(|root| manager_diagnostics(&root))
            {
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    "error",
                    "installer.phase.failed",
                    &current.name,
                    "INSTALL_PHASE_FAILED",
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(
                            current.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        ),
                        phase_item_count: current.item_count,
                        phase_bytes: current.bytes,
                    },
                );
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    "error",
                    "installer.install.failed",
                    &current.name,
                    "INSTALL_FAILED",
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(self.total_elapsed_ms()),
                        ..Default::default()
                    },
                );
            }
        }
        let _ = self.stop_sender.send(());
        if let Some(heartbeat) = self.heartbeat.take() {
            let _ = heartbeat.join();
        }
    }
}

fn install_package(
    source: &Path,
    requested_operation: &str,
    requested_id: Option<&str>,
) -> Result<String, String> {
    let id = requested_id.map(str::to_owned).unwrap_or_else(unique_id);
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Operation ID must contain 1–64 ASCII letters, digits, or hyphens.".to_owned());
    }
    set_operation_id(&stable_root()?, &id);
    let progress = InstallProgress::new(&id);
    let preflight = preflight(source, requested_operation, Some(&progress))?;
    progress.set_phase_with_metrics("operation_lock", None, Some(preflight.package_bytes));
    let root = preflight.root;
    progress.check_cancel()?;
    fs::create_dir_all(root.join("state"))
        .map_err(|error| format!("Unable to create manager state: {error}"))?;
    let _operation_lock = lock_state(&root)?;
    progress.set_phase("recovery");
    recover_transaction(&root)?;
    let previous_config = read_config(&root)?;
    let database_state = inspect_postgres_directory(&root.join("data/postgres"))?;
    if previous_config.is_some() && database_state != PostgresDirectoryState::Initialized {
        return Err(
            "The existing database directory is missing or incomplete; current data was preserved for manual recovery."
                .to_owned(),
        );
    }
    let completed_update_retry = requested_operation == "update"
        && requested_id.is_some_and(|requested_id| {
            read_transaction_if_exists(&root)
                .ok()
                .flatten()
                .is_some_and(|transaction| {
                    transaction.operation_id == requested_id
                        && transaction.stage == Stage::Committed
                })
        })
        && previous_config.as_ref().is_some_and(|config| {
            verify_release(&config.active_release)
                .map(|active| (active, &preflight.manifest))
                .is_ok_and(|(active, candidate)| {
                    active.version == candidate.version
                        && active.commit == candidate.commit
                        && active.files == candidate.files
                })
        });
    if !completed_update_retry {
        ensure_update_operation(&root, requested_operation, requested_id)?;
    }
    progress.check_cancel()?;
    if requested_operation == "install" || completed_update_retry {
        if let Some(config) = previous_config
            .as_ref()
            .filter(|config| config.version == preflight.manifest.version)
        {
            let active = verify_release(&config.active_release)?;
            let candidate = &preflight.manifest;
            if active.version == candidate.version
                && active.commit == candidate.commit
                && active.files == candidate.files
            {
                remove_legacy_autostart(&root)?;
                drop(_operation_lock);
                if requested_operation == "update" && !runtime_is_active(&root)? {
                    if let Err(error) = launch_manager(&root, "run") {
                        log_line(
                            &root,
                            &format!("Unable to start the committed release: {error}"),
                        );
                    }
                }
                progress.finish("complete");
                return Ok(format!(
                    "NGTManager v{} is already installed; setup registration was retried without reinstalling data.",
                    config.version
                ));
            }
        }
    }
    let operation = match requested_operation {
        "install" if previous_config.is_none() => Operation::Install,
        "install" => Operation::Update,
        "update" => Operation::Update,
        "repair" => Operation::Repair,
        _ => return Err("Unknown installation operation.".to_owned()),
    };
    let fresh_install = operation == Operation::Install
        && previous_config.is_none()
        && read_transaction_if_exists(&root)?
            .as_ref()
            .is_none_or(|transaction| terminal(&transaction.stage));
    if matches!(
        database_state,
        PostgresDirectoryState::Empty | PostgresDirectoryState::Missing
    ) && !fresh_install
    {
        return Err(
            "The existing database directory is incomplete; data was preserved for manual recovery."
                .to_owned(),
        );
    }
    let mut transaction = create_transaction(
        &root,
        operation,
        id.clone(),
        previous_config.clone(),
        database_state,
    )?;
    let candidate_stage = root.join("releases").join(format!(".candidate-{id}"));
    let restart_runtime = runtime_is_active(&root)?;
    let result: Result<ManagerConfig, String> = (|| {
        progress.set_phase_with_metrics("deploy_candidate", None, Some(preflight.package_bytes));
        fs::create_dir_all(root.join("releases"))
            .map_err(|error| format!("Unable to create releases directory: {error}"))?;
        fs::create_dir(&candidate_stage)
            .map_err(|error| format!("Unable to create a new candidate directory: {error}"))?;
        transaction.candidate_release = Some(candidate_stage.clone());
        write_transaction(&root, &transaction)?;
        let manifest = copy_release(
            source,
            &candidate_stage,
            &progress,
            &preflight.manifest,
            preflight.package_bytes,
        )?;
        progress.set_current_metrics(
            Some(manifest.files.len().min(u32::MAX as usize) as u32),
            Some(preflight.package_bytes),
        );
        advance_transaction(&root, &mut transaction, Stage::Staged)?;
        progress.check_cancel()?;

        if database_state == PostgresDirectoryState::Initialized {
            ensure_port_available(DATABASE_PORT + 1)?;
            check_space(
                &root,
                required_space(0, directory_size(&root.join("data/postgres"))?),
            )?;
        }
        write_maintenance(&root, &id, true)?;
        progress.set_phase("stop_runtime");
        let _runtime_lock = wait_for_runtime_stop(&root, Some(&candidate_stage), true, Some(&id))?;
        progress.check_cancel()?;
        ensure_port_available(APPLICATION_PORT)?;
        ensure_port_available(DATABASE_PORT)?;
        if let Some(config) = previous_config.as_ref() {
            let mut maintenance = config.clone();
            maintenance.maintenance = true;
            write_config(&root, &maintenance)?;
        }
        advance_transaction(&root, &mut transaction, Stage::Maintenance)?;

        progress.set_phase_with_metrics("backup_database", None, Some(preflight.database_bytes));
        backup_database(&candidate_stage, &root, &id, &mut transaction)?;
        if let Some(backup_root) = transaction.backup_root.as_ref() {
            progress.set_phase("recover_legacy_database");
            recover_legacy_database_after_backup(&candidate_stage, &root, backup_root)?;
        }
        progress.check_cancel()?;
        transaction.migration_started = true;
        write_transaction(&root, &transaction)?;
        let candidate = &manifest;
        validate_candidate(
            &candidate_stage,
            &root,
            &id,
            &mut transaction,
            &progress,
            &candidate.version,
        )?;
        progress.check_cancel()?;
        advance_transaction(&root, &mut transaction, Stage::CandidateHealthy)?;

        let final_release = root.join("releases").join(format!(
            "v{}-{}-{}",
            candidate.version,
            &candidate.commit[..12],
            id
        ));
        transaction.candidate_release = Some(final_release.clone());
        progress.set_phase("commit_preparation");
        progress.check_cancel()?;
        advance_transaction(&root, &mut transaction, Stage::Switching)?;
        progress.set_phase("commit_release");
        activate_candidate(&candidate_stage, &final_release)?;
        copy_file_atomically(
            &source.join("tools/NGTManager.exe"),
            &root.join("tools/NGTManager.exe"),
        )?;
        copy_file_atomically(
            &source.join("tools/NGTUpdater.exe"),
            &root.join("tools/NGTUpdater.exe"),
        )?;
        copy_file_atomically(
            &source.join("assets/ngt-studio.ico"),
            &root.join("assets/ngt-studio.ico"),
        )?;
        copy_file_atomically(
            &source.join("assets/ngt-studio-light.ico"),
            &root.join("assets/ngt-studio-light.ico"),
        )?;
        copy_file_atomically(
            &source.join("assets/ngt-studio-dark.ico"),
            &root.join("assets/ngt-studio-dark.ico"),
        )?;

        let config = ManagerConfig {
            format_version: CONFIG_VERSION,
            install_root: root.clone(),
            active_release: final_release,
            data_root: root.join("data"),
            version: manifest.version,
            repository: previous_config
                .as_ref()
                .map(|config| config.repository.clone())
                .unwrap_or_else(|| "JayWangsj/ngt1".to_owned()),
            maintenance: false,
        };
        write_config(&root, &config)?;
        write_maintenance(&root, &id, false)?;
        remove_legacy_autostart(&root)?;
        advance_transaction(&root, &mut transaction, Stage::Committed)?;
        if let Err(error) = cleanup_committed_database_marker(&root, &transaction) {
            log_line(
                &root,
                &format!("Initial database marker cleanup was deferred: {error}"),
            );
        }
        Ok(config)
    })();

    match result {
        Ok(config) => {
            drop(_operation_lock);
            if restart_runtime && requested_operation == "update" {
                if let Err(error) = launch_manager(&root, "run") {
                    log_line(
                        &root,
                        &format!("Unable to start the committed release: {error}"),
                    );
                }
            }
            progress.finish("complete");
            Ok(format!(
                "NGTManager v{} installed successfully.",
                config.version
            ))
        }
        Err(error) => {
            progress.set_phase_failure_with_code("recovery", &failure_code(&error));
            let recovery = rollback_transaction(&root, &mut transaction);
            if let Err(recovery_error) = recovery {
                progress.finish_failure("recovery_failed");
                transaction.failure = Some("recovery_failed".to_owned());
                transaction.stage = Stage::Failed;
                let _ = write_transaction(&root, &transaction);
                return Err(format!("Installation failed: {error}\nRecovery needs attention: {recovery_error}\nData and backups were preserved."));
            }
            progress.finish("failed");
            drop(_operation_lock);
            if previous_config.is_some() && restart_runtime {
                let _ = launch_manager(&root, "run");
            }
            Err(error)
        }
    }
}

fn activate_candidate(candidate_stage: &Path, final_release: &Path) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 50;
    const RETRY_DELAY: Duration = Duration::from_millis(100);

    for attempt in 0..MAX_ATTEMPTS {
        if final_release.exists() {
            return Err(
                "Unable to activate the verified release: destination already exists.".to_owned(),
            );
        }
        match fs::rename(candidate_stage, final_release) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt + 1 < MAX_ATTEMPTS
                    && (matches!(error.raw_os_error(), Some(5 | 32 | 33))
                        || matches!(
                            error.kind(),
                            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                        )) =>
            {
                thread::sleep(RETRY_DELAY);
            }
            Err(error) => {
                return Err(format!(
                    "Unable to activate the verified release after {} attempt(s): {error}",
                    attempt + 1
                ));
            }
        }
    }
    unreachable!("the last activation attempt returns its result")
}

#[cfg(windows)]
fn validate_candidate(
    release: &Path,
    root: &Path,
    operation_id: &str,
    transaction: &mut Transaction,
    progress: &InstallProgress,
    version: &str,
) -> Result<(), String> {
    let job = RuntimeJob::new()?;
    let mut runtime_run = RuntimeRunRecord::new(unique_id(), "candidate-validation");
    write_runtime_run(root, &runtime_run)?;
    let validation = (|| {
        if should_initialize_database(transaction) {
            progress.set_phase("initialize_database");
            initialize_initial_database(&job, release, root, operation_id, transaction)?;
            progress.check_cancel()?;
        }
        progress.set_phase("database_ready");
        let mut database = start_database(&job, release, root, None, &mut runtime_run)?;
        progress.set_phase("database_migration");
        if let Err(error) = run_migrations(&job, release, root, operation_id) {
            let _ =
                stop_database_launcher(&job, &mut database, release, root, Duration::from_secs(30));
            return Err(error);
        }
        if let Err(error) = progress.check_cancel() {
            let _ =
                stop_database_launcher(&job, &mut database, release, root, Duration::from_secs(30));
            return Err(error);
        }
        advance_transaction(root, transaction, Stage::Migrated)?;
        progress.set_phase("application_health");
        let application_job = RuntimeJob::new()?;
        let mut application = match start_application(&application_job, release, root, None) {
            Ok(application) => application,
            Err(error) => {
                let _ = stop_database_launcher(
                    &job,
                    &mut database,
                    release,
                    root,
                    Duration::from_secs(30),
                );
                return Err(error);
            }
        };
        let health = wait_for_health(&mut application, version, None);
        runtime_run.phase = "running".to_owned();
        write_runtime_run(root, &runtime_run)?;
        let mut children = RuntimeChildren {
            database,
            application,
            application_job,
        };
        let stopped = stop_children(&job, &mut children, release, root, &mut runtime_run, None);
        health?;
        stopped
    })();
    let process_cleanup = job.terminate_and_wait();
    drop(job);
    if validation.is_err() && runtime_run.ended_at_utc.is_none() {
        runtime_run.phase = "failed".to_owned();
        runtime_run.ended_at_utc = Some(iso_timestamp());
        let _ = write_runtime_run(root, &runtime_run);
    }
    match (validation, process_cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(validation_error), Ok(())) => Err(validation_error),
        (Ok(()), Err(cleanup_error)) => Err(cleanup_error),
        (Err(validation_error), Err(cleanup_error)) => Err(format!(
            "{validation_error}; candidate process cleanup also failed: {cleanup_error}"
        )),
    }
}
#[cfg(not(windows))]
fn validate_candidate(
    _release: &Path,
    _root: &Path,
    _operation_id: &str,
    _transaction: &mut Transaction,
    _progress: &InstallProgress,
    _version: &str,
) -> Result<(), String> {
    Err("NGTManager runtime is supported only on Windows x64.".to_owned())
}

fn should_initialize_database(transaction: &Transaction) -> bool {
    transaction.operation == Operation::Install && !transaction.database_was_present
}

#[cfg(windows)]
fn initialize_initial_database(
    job: &RuntimeJob,
    release: &Path,
    root: &Path,
    operation_id: &str,
    transaction: &mut Transaction,
) -> Result<(), String> {
    let data_root = root.join("data");
    match fs::symlink_metadata(&data_root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
        Ok(_) => {
            return Err(
                "The business data directory is unsafe; database initialization was stopped."
                    .to_owned(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&data_root).map_err(|error| {
                format!("Unable to create the business data directory: {error}")
            })?;
        }
        Err(error) => {
            return Err(format!(
                "Unable to inspect the business data directory: {error}"
            ))
        }
    }
    let database = data_root.join("postgres");
    let initializing = data_root.join(format!("postgres.initializing-{operation_id}"));
    if transaction.database_initialization_directory.is_none() {
        match inspect_postgres_directory(&database)? {
            PostgresDirectoryState::Missing => {}
            PostgresDirectoryState::Empty if transaction.database_directory_was_empty => {}
            PostgresDirectoryState::Initialized => {
                return Err("A database appeared during first-install initialization; it was preserved.".to_owned())
            }
            PostgresDirectoryState::Empty => {
                return Err("The database directory changed during first-install initialization; it was preserved.".to_owned())
            }
        }
        match fs::symlink_metadata(&initializing) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err("The operation-owned database initialization path already exists; it was preserved.".to_owned()),
            Err(error) => return Err(format!("Unable to inspect the operation-owned database path: {error}")),
        }
        transaction.database_initialization_directory = Some(initializing.clone());
        write_transaction(root, transaction)?;
        fs::create_dir(&initializing).map_err(|error| {
            format!("Unable to create the operation-owned database directory: {error}")
        })?;
        transaction.database_initialization_owned = true;
        write_transaction(root, transaction)?;
    } else if transaction.database_initialization_directory.as_deref()
        != Some(initializing.as_path())
        || !transaction.database_initialization_owned
    {
        return Err("The database initialization transaction ownership is incomplete; its files were preserved.".to_owned());
    }

    if !transaction.database_initialization_published {
        let temp = ascii_temp_directory()?;
        let mut command = Command::new(release.join("runtime").join("node.exe"));
        command
            .arg("--require")
            .arg("./scripts/runtime-start-gate.cjs")
            .arg("./scripts/windows-db.mjs");
        configure_runtime_command(&mut command, release, root, &temp);
        command
            .env("NGT_DB_INIT_ONLY", "1")
            .env("NGT_DB_INIT_OPERATION_ID", operation_id)
            .env("NGT_DB_INIT_DIRECTORY", &initializing);
        hide_console(&mut command);
        let status = spawn_runtime_process(job, &mut command, root, DiagnosticComponent::Database)?
            .wait()
            .map_err(|error| format!("Unable to wait for PostgreSQL initialization: {error}"))?;
        if !status.success() {
            return Err(format!(
                "PostgreSQL initialization failed (exit {}). See the diagnostic export for safe details.",
                status_code(&status)
            ));
        }
        verify_operation_owned_database(&initializing, operation_id)?;
        match inspect_postgres_directory(&database)? {
            PostgresDirectoryState::Missing => {}
            PostgresDirectoryState::Empty if transaction.database_directory_was_empty => {
                fs::remove_dir(&database).map_err(|error| format!(
                    "Unable to replace the verified empty database directory: {error}"
                ))?;
            }
            _ => return Err("The original database path changed before publication; existing files were preserved.".to_owned()),
        }
        fs::rename(&initializing, &database)
            .map_err(|error| format!("Unable to publish the initialized database: {error}"))?;
        transaction.database_initialization_published = true;
        write_transaction(root, transaction)?;
    }
    verify_operation_owned_database(&database, operation_id)
}

#[cfg(windows)]
fn verify_operation_owned_database(database: &Path, operation_id: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(database.join("PG_VERSION"))
        .map_err(|error| format!("Initialized database version is unavailable: {error}"))?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("Initialized database version is not a regular file.".to_owned());
    }
    let owner = database.join(".ngt-install-owner");
    let metadata = fs::symlink_metadata(&owner).map_err(|error| {
        format!("Initialized database ownership marker is unavailable: {error}")
    })?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("Initialized database ownership marker is not a regular file.".to_owned());
    }
    let actual = fs::read_to_string(owner)
        .map_err(|error| format!("Unable to read database ownership marker: {error}"))?;
    if actual != operation_id {
        return Err("Initialized database ownership does not match this operation.".to_owned());
    }
    Ok(())
}

fn can_abandon_candidate(root: &Path, transaction: &Transaction) -> Result<bool, String> {
    if !matches!(
        transaction.operation,
        Operation::Install | Operation::Update | Operation::Repair
    ) || transaction.migration_started
        || transaction.backup_root.is_some()
        || transaction.database_initialization_directory.is_some()
        || transaction.database_initialization_owned
        || transaction.database_initialization_published
    {
        return Ok(false);
    }
    let candidate = root
        .join("releases")
        .join(format!(".candidate-{}", transaction.operation_id));
    if transaction
        .candidate_release
        .as_ref()
        .is_some_and(|path| path != &candidate)
    {
        return Ok(false);
    }
    let mut current = read_config(root)?;
    if let Some(config) = current.as_mut() {
        config.maintenance = false;
    }
    if current != transaction.previous_config {
        return Ok(false);
    }
    let database_state = inspect_postgres_directory(&root.join("data/postgres"))?;
    let expected = if transaction.database_was_present {
        PostgresDirectoryState::Initialized
    } else if transaction.database_directory_was_empty {
        PostgresDirectoryState::Empty
    } else {
        PostgresDirectoryState::Missing
    };
    if database_state != expected {
        return Ok(false);
    }
    if let Some(config) = current {
        if !config.active_release.starts_with(root.join("releases"))
            || config.active_release == candidate
        {
            return Ok(false);
        }
        for relative in [
            "tools/NGTManager.exe",
            "tools/NGTUpdater.exe",
            "assets/ngt-studio.ico",
            "assets/ngt-studio-light.ico",
            "assets/ngt-studio-dark.ico",
        ] {
            let active = fs::read(config.active_release.join(relative));
            let stable = fs::read(root.join(relative));
            if !matches!((active, stable), (Ok(a), Ok(b)) if a == b) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn rollback_transaction(root: &Path, transaction: &mut Transaction) -> Result<(), String> {
    if matches!(transaction.stage, Stage::Committed | Stage::RolledBack) {
        return Ok(());
    }
    if transaction.stage != Stage::RollingBack {
        if !valid_transition(&transaction.stage, &Stage::RollingBack) {
            return Err(format!(
                "Unable to recover from operation stage {:?}.",
                transaction.stage
            ));
        }
        transaction.stage = Stage::RollingBack;
        write_transaction(root, transaction)?;
    }
    let abandon = can_abandon_candidate(root, transaction)?;
    write_maintenance(root, &transaction.operation_id, true)?;
    #[cfg(windows)]
    let _runtime_lock = if abandon {
        None
    } else {
        Some(wait_for_runtime_stop(root, None, false, None)?)
    };
    if transaction.migration_started {
        if let Some(backup_root) = transaction.backup_root.clone() {
            if backup_root != root.join("backups").join(&transaction.operation_id) {
                return Err(
                    "The operation backup path is invalid; current and original data were preserved."
                        .to_owned(),
                );
            }
            if !backup_root.join("database/PG_VERSION").is_file() {
                return Err(
                    "The verified database backup is missing; current and original data were preserved."
                        .to_owned(),
                );
            }
            #[cfg(windows)]
            restore_database(root, &backup_root, transaction)?;
        } else if transaction.database_was_present {
            return Err(
                "A verified recovery backup is required; existing data was preserved.".to_owned(),
            );
        }
    }
    if !abandon && should_remove_initial_database(transaction) {
        cleanup_initial_database(root, transaction)?;
    }
    if let Some(previous) = transaction.previous_config.as_ref() {
        let mut restored = previous.clone();
        restored.maintenance = false;
        if !abandon {
            verify_release(&restored.active_release)?;
            for relative in [
                "tools/NGTManager.exe",
                "tools/NGTUpdater.exe",
                "assets/ngt-studio.ico",
                "assets/ngt-studio-light.ico",
                "assets/ngt-studio-dark.ico",
            ] {
                let source = restored.active_release.join(relative);
                let target = root.join(relative);
                if !matches!((fs::read(&source), fs::read(&target)), (Ok(a), Ok(b)) if a == b) {
                    copy_file_atomically(&source, &target)?;
                }
            }
        }
        write_config(root, &restored)?;
        remove_legacy_autostart(root)?;
    } else if let (Some(candidate), Some(current)) =
        (transaction.candidate_release.as_ref(), read_config(root)?)
    {
        if current.active_release == *candidate {
            fs::remove_file(config_path(root)).map_err(|error| {
                format!("Unable to clear the uncommitted manager configuration: {error}")
            })?;
            let _ = remove_legacy_autostart(root);
        }
    }
    write_maintenance(root, &transaction.operation_id, false)?;
    if let Some(candidate) = transaction.candidate_release.as_ref() {
        let releases = root.join("releases");
        if candidate.parent() == Some(releases.as_path()) && candidate.exists() {
            remove_owned_directory(&releases, candidate)?;
        }
    }
    advance_transaction(root, transaction, Stage::RolledBack)
}

fn should_remove_initial_database(transaction: &Transaction) -> bool {
    transaction.operation == Operation::Install
        && transaction.backup_root.is_none()
        && !transaction.database_was_present
}

fn cleanup_initial_database(root: &Path, transaction: &Transaction) -> Result<(), String> {
    if transaction.operation_id.is_empty()
        || transaction.operation_id.len() > 64
        || !transaction
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(
            "The database operation identifier is invalid; files were preserved.".to_owned(),
        );
    }
    let data_root = root.join("data");
    match fs::symlink_metadata(&data_root) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
        Ok(_) => {
            return Err("The initial database directory is not a regular directory.".to_owned())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Unable to inspect the initial database directory: {error}"
            ))
        }
    }
    let expected_initializing = data_root.join(format!(
        "postgres.initializing-{}",
        transaction.operation_id
    ));
    if let Some(recorded) = transaction.database_initialization_directory.as_ref() {
        if recorded != &expected_initializing {
            return Err(
                "The recorded database initialization path is invalid; files were preserved."
                    .to_owned(),
            );
        }
        if transaction.database_initialization_owned {
            match fs::symlink_metadata(recorded) {
                Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {
                    remove_owned_directory(&data_root, recorded)?;
                }
                Ok(_) => return Err("The operation-owned database initialization path is unsafe; files were preserved.".to_owned()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Unable to inspect operation-owned database files: {error}")),
            }
        } else {
            match fs::symlink_metadata(recorded) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => return Err("The database initialization path was not confirmed as operation-owned; files were preserved.".to_owned()),
                Err(error) => return Err(format!("Unable to inspect the unowned database initialization path: {error}")),
            }
        }
    }

    let database = data_root.join("postgres");
    match fs::symlink_metadata(&database) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {
            if transaction.database_initialization_owned
                && marker_matches(&database, &transaction.operation_id)?
            {
                remove_owned_directory(&data_root, &database)?;
            } else if !transaction.database_directory_was_empty
                || inspect_postgres_directory(&database)? != PostgresDirectoryState::Empty
            {
                return Err("The database is not proven to belong to this operation; data was preserved for manual recovery.".to_owned());
            } else {
                // The directory existed empty before this operation and must remain untouched.
            }
        }
        Ok(_) => return Err("The database path is unsafe; its contents were preserved.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Unable to inspect the initial database directory: {error}"
            ))
        }
    }
    if transaction.database_directory_was_empty
        && matches!(
            inspect_postgres_directory(&database)?,
            PostgresDirectoryState::Missing
        )
    {
        fs::create_dir(&database).map_err(|error| {
            format!("Unable to restore the original empty database directory: {error}")
        })?;
    }
    Ok(())
}

fn marker_matches(database: &Path, operation_id: &str) -> Result<bool, String> {
    let marker = database.join(".ngt-install-owner");
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Unable to inspect database ownership marker: {error}"
            ))
        }
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Ok(false);
    }
    let actual = fs::read_to_string(marker)
        .map_err(|error| format!("Unable to read database ownership marker: {error}"))?;
    Ok(actual == operation_id)
}

fn cleanup_committed_database_marker(root: &Path, transaction: &Transaction) -> Result<(), String> {
    if !transaction.database_initialization_owned {
        return Ok(());
    }
    let database = root.join("data/postgres");
    match fs::symlink_metadata(&database) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {}
        Ok(_) => return Err("The committed database path is unsafe.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Unable to inspect committed database path: {error}"
            ))
        }
    }
    if !marker_matches(&database, &transaction.operation_id)? {
        return Ok(());
    }
    let marker = database.join(".ngt-install-owner");
    fs::remove_file(marker).map_err(|error| {
        format!("Unable to remove the completed database ownership marker: {error}")
    })
}

fn recover_transaction(root: &Path) -> Result<String, String> {
    let transaction_path = root.join("state").join("transaction.json");
    let contents = match fs::read(&transaction_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok("No pending recovery.".to_owned())
        }
        Err(error) => return Err(format!("Unable to read operation state: {error}")),
    };
    let mut transaction: Transaction = serde_json::from_slice(&contents)
        .map_err(|error| format!("Operation state is unreadable: {error}"))?;
    if transaction.format_version != TRANSACTION_VERSION {
        return Err(
            "Operation state version is unsupported; manual recovery is required.".to_owned(),
        );
    }
    if terminal(&transaction.stage) {
        if transaction.stage == Stage::Committed {
            if let Err(error) = cleanup_committed_database_marker(root, &transaction) {
                log_line(
                    root,
                    &format!("Initial database marker cleanup was deferred: {error}"),
                );
            }
        }
        return Ok("No pending recovery.".to_owned());
    }
    if transaction.stage == Stage::Switching {
        if let (Some(candidate), Ok(Some(mut config))) =
            (transaction.candidate_release.as_ref(), read_config(root))
        {
            if &config.active_release == candidate && verify_release(candidate).is_ok() {
                config.maintenance = false;
                write_config(root, &config)?;
                write_maintenance(root, &transaction.operation_id, false)?;
                remove_legacy_autostart(root)?;
                advance_transaction(root, &mut transaction, Stage::Committed)?;
                return Ok("Completed the interrupted release switch.".to_owned());
            }
        }
    }
    rollback_transaction(root, &mut transaction)?;
    Ok("Recovered the interrupted installation and retained its backup.".to_owned())
}

#[cfg(windows)]
fn launch_manager(root: &Path, command: &str) -> Result<Child, String> {
    let executable = root.join("tools/NGTManager.exe");
    if !executable.is_file() {
        return Err("The stable manager executable is missing.".to_owned());
    }
    let mut child = Command::new(executable);
    child
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut child);
    child
        .spawn()
        .map_err(|error| format!("Unable to start NGTManager: {error}"))
}

#[cfg(not(windows))]
fn launch_manager(_root: &Path, _command: &str) -> Result<Child, String> {
    Err("NGTManager runtime is supported only on Windows x64.".to_owned())
}

fn runtime_is_active(root: &Path) -> Result<bool, String> {
    let path = root.join("state").join("run.lock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {}
        Ok(_) => return Err("The runtime lock is not a regular file.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Unable to inspect the runtime lock: {error}")),
    }
    let lock = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(lock) => lock,
        Err(error) if is_lock_contention(&error) => return Ok(true),
        Err(error) => return Err(format!("Unable to inspect the runtime lock: {error}")),
    };
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if is_lock_contention(&error) => Ok(true),
        Err(error) => Err(format!("Unable to inspect the runtime lock: {error}")),
    }
}

fn update_process_active(root: &Path, update_id: &str) -> Result<bool, String> {
    if update_id.is_empty()
        || update_id.len() > 64
        || !update_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Update ID is invalid.".to_owned());
    }
    let path = root
        .join("state")
        .join(format!("update-process-{update_id}.lock"));
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Unable to inspect update process state: {error}")),
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("The updater process lease is not a regular file.".to_owned());
    }
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if is_lock_contention(&error) => return Ok(true),
        Err(error) => return Err(format!("Unable to inspect update process state: {error}")),
    };
    match file.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if is_lock_contention(&error) => Ok(true),
        Err(error) => Err(format!("Unable to inspect update process state: {error}")),
    }
}

fn ensure_update_operation(
    root: &Path,
    requested_operation: &str,
    requested_id: Option<&str>,
) -> Result<(), String> {
    let path = update_lock_path(root);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Unable to inspect the update lock: {error}")),
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("The update lock is not a regular file.".to_owned());
    }
    let lock = read_update_value(&path)?;
    let update_id = lock["updateId"]
        .as_str()
        .ok_or_else(|| "The update lock has no task ID.".to_owned())?;
    let matching_online_update = requested_operation == "update"
        && requested_id == Some(update_id)
        && update_process_active(root, update_id)?
        && read_transaction_if_exists(root)?.is_none_or(|transaction| {
            transaction.operation_id != update_id || !terminal(&transaction.stage)
        });
    if matching_online_update {
        return Ok(());
    }
    if requested_operation != "update"
        && update_id_is_valid(update_id)
        && !update_process_active(root, update_id)?
        && !root.join("state/update-maintenance.json").exists()
        && read_transaction_if_exists(root)?.is_some_and(|transaction| {
            transaction.operation_id == update_id && transaction.stage == Stage::RolledBack
        })
    {
        let mut status = read_update_value(&update_status_path(root))?;
        if status["updateId"] == update_id
            && read_config(root)?.is_some_and(|config| status["previousVersion"] == config.version)
        {
            status["status"] = serde_json::json!("failed");
            status["recoveryStatus"] = serde_json::json!("succeeded");
            status["executorAlive"] = serde_json::json!(false);
            atomic_write(
                &update_status_path(root),
                &serde_json::to_vec(&status).map_err(|error| error.to_string())?,
            )?;
            fs::remove_file(path)
                .map_err(|error| format!("Unable to release the recovered update: {error}"))?;
            return Ok(());
        }
    }
    Err(
        "Another update task owns this installation; wait for it to finish or recover it first."
            .to_owned(),
    )
}

fn update_id_is_valid(update_id: &str) -> bool {
    update_id.len() == 36
        && update_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn update_lock_path(root: &Path) -> PathBuf {
    root.join("state").join("update.lock")
}

fn update_status_path(root: &Path) -> PathBuf {
    root.join("state").join("update-status.json")
}

fn read_update_value(path: &Path) -> Result<serde_json::Value, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Unable to inspect update state: {error}"))?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("Update state is not a regular file.".to_owned());
    }
    let bytes = fs::read(path).map_err(|error| format!("Unable to read update state: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Update state is invalid: {error}"))
}

fn safe_update_retry(status: &serde_json::Value, current_version: &str) -> bool {
    status["previousVersion"].as_str() == Some(current_version)
        && status["manualReview"] != true
        && !matches!(
            status["recoveryStatus"].as_str(),
            Some("failed" | "running")
        )
        && matches!(status["status"].as_str(), Some("failed" | "interrupted"))
        && matches!(
            status["stage"].as_str(),
            Some(
                "starting"
                    | "checking"
                    | "downloading"
                    | "downloaded"
                    | "verifying"
                    | "preparing-runtime"
            )
        )
}

fn clear_update_lock(root: &Path, update_id: &str, result: &str) -> Result<String, String> {
    if !update_id_is_valid(update_id) || !matches!(result, "complete" | "retry") {
        return Err("Update lock request is invalid.".to_owned());
    }
    let lock_path = update_lock_path(root);
    let lock = read_update_value(&lock_path)?;
    if lock["updateId"].as_str() != Some(update_id) {
        return Err("The update lock belongs to a different task.".to_owned());
    }
    if update_process_active(root, update_id)? {
        return Err("The update task still has an active executor.".to_owned());
    }
    let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    if config.maintenance || root.join("state/update-maintenance.json").exists() {
        return Err("The system is still in maintenance.".to_owned());
    }
    if read_transaction_if_exists(root)?
        .as_ref()
        .is_some_and(|transaction| !terminal(&transaction.stage))
    {
        return Err(
            "Installation recovery must finish before releasing the update lock.".to_owned(),
        );
    }
    let status = read_update_value(&update_status_path(root))?;
    if status["updateId"].as_str() != Some(update_id) {
        return Err("The update status belongs to a different task.".to_owned());
    }
    let manifest = verify_release(&config.active_release)?;
    if manifest.version != config.version {
        return Err("The active release does not match the installed version.".to_owned());
    }
    let safe = match result {
        "complete" => {
            status["status"] == "complete"
                && status["targetVersion"].as_str() == Some(config.version.as_str())
        }
        "retry" => safe_update_retry(&status, &config.version),
        _ => false,
    };
    if !safe {
        return Err("The update lock cannot be safely released.".to_owned());
    }
    fs::remove_file(lock_path)
        .map_err(|error| format!("Unable to release the update lock: {error}"))?;
    Ok("Update lock released.".to_owned())
}

fn reserve_update_state(
    root: &Path,
    config: &ManagerConfig,
    update_id: &str,
    target_version: &str,
) -> Result<String, String> {
    if !update_id_is_valid(update_id) {
        return Err("Update ID is invalid.".to_owned());
    }
    let current = semver::Version::parse(&config.version)
        .map_err(|_| "Installed version is invalid.".to_owned())?;
    let target = semver::Version::parse(target_version)
        .map_err(|_| "Update target version is invalid.".to_owned())?;
    if target <= current {
        return Err("Downgrades and same-version updates are not supported.".to_owned());
    }
    if config.maintenance || root.join("state/update-maintenance.json").exists() {
        return Err("The system is in maintenance and cannot be updated.".to_owned());
    }
    if read_transaction_if_exists(root)?
        .as_ref()
        .is_some_and(|transaction| !terminal(&transaction.stage))
    {
        return Err("Installation recovery must finish before an update can start.".to_owned());
    }
    let lock_path = update_lock_path(root);
    match fs::symlink_metadata(&lock_path) {
        Ok(_) => return Err("Another update task has not been released.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect the update lock: {error}")),
    }
    let status_path = update_status_path(root);
    match fs::symlink_metadata(&status_path) {
        Ok(metadata) if !metadata.is_file() || is_reparse(&metadata) => {
            return Err("Update status is not a regular file.".to_owned());
        }
        Ok(_) => {
            let status = read_update_value(&status_path)?;
            let previous_complete = status["status"] == "complete"
                && status["targetVersion"].as_str() == Some(config.version.as_str());
            if !previous_complete && !safe_update_retry(&status, &config.version) {
                return Err(
                    "The previous update task requires verification before retrying.".to_owned(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect update status: {error}")),
    }

    let created_at = iso_timestamp();
    let updater_path = root.join("tools/NGTUpdater.exe");
    let lock = serde_json::json!({
        "updateId": update_id,
        "targetVersion": target_version,
        "createdAt": created_at,
        "executorPath": updater_path,
        "operation": "online-update",
    });
    let mut lock_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|error| format!("Unable to reserve the update task: {error}"))?;
    let lock_contents = serde_json::to_vec(&lock)
        .map_err(|error| format!("Unable to serialize the update lock: {error}"))?;
    if let Err(error) = lock_file
        .write_all(&lock_contents)
        .and_then(|_| lock_file.sync_all())
    {
        drop(lock_file);
        let _ = fs::remove_file(&lock_path);
        return Err(format!("Unable to save the update lock: {error}"));
    }
    drop(lock_file);
    let status = serde_json::json!({
        "status": "starting",
        "stage": "starting",
        "updateId": update_id,
        "targetVersion": target_version,
        "previousVersion": config.version,
        "executorPath": updater_path,
        "createdAt": created_at,
        "updatedAt": created_at,
        "executorConfirmed": false,
        "operation": "online-update",
    });
    if let Err(error) = atomic_write(
        &status_path,
        &serde_json::to_vec(&status)
            .map_err(|error| format!("Unable to serialize update status: {error}"))?,
    ) {
        let _ = fs::remove_file(&lock_path);
        return Err(error);
    }
    Ok(status.to_string())
}

fn reserve_online_update(
    root: &Path,
    update_id: &str,
    target_version: &str,
) -> Result<String, String> {
    let _operation_lock = lock_state(root)?;
    let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    let current_release = verify_release(&config.active_release)?;
    if current_release.version != config.version {
        return Err("The active release does not match the installed version.".to_owned());
    }
    reserve_update_state(root, &config, update_id, target_version)
}

#[cfg(windows)]
fn start_online_update(root: &Path, update_id: &str) -> Result<String, String> {
    let _operation_lock = lock_state(root)?;
    let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    let current_release = verify_release(&config.active_release)?;
    if current_release.version != config.version {
        return Err("The active release does not match the installed version.".to_owned());
    }
    if config.maintenance || root.join("state/update-maintenance.json").exists() {
        return Err("The system is in maintenance and cannot be updated.".to_owned());
    }
    if read_transaction_if_exists(root)?
        .as_ref()
        .is_some_and(|transaction| !terminal(&transaction.stage))
    {
        return Err("Installation recovery must finish before an update can start.".to_owned());
    }
    if update_process_active(root, update_id)? {
        return Err("The update task already has an active executor.".to_owned());
    }
    let lock = read_update_value(&update_lock_path(root))?;
    let status = read_update_value(&update_status_path(root))?;
    let updater = root.join("tools/NGTUpdater.exe");
    if lock["updateId"].as_str() != Some(update_id)
        || status["updateId"].as_str() != Some(update_id)
        || status["status"] != "starting"
        || lock["targetVersion"] != status["targetVersion"]
        || status["previousVersion"].as_str() != Some(config.version.as_str())
        || lock["executorPath"].as_str() != Some(updater.to_string_lossy().as_ref())
        || status["executorPath"].as_str() != Some(updater.to_string_lossy().as_ref())
    {
        return Err("The update task is not ready to start.".to_owned());
    }
    let target_version = status["targetVersion"]
        .as_str()
        .ok_or_else(|| "Update target version is missing.".to_owned())?;
    let current_version = semver::Version::parse(&config.version)
        .map_err(|_| "Installed version is invalid.".to_owned())?;
    let target = semver::Version::parse(target_version)
        .map_err(|_| "Update target version is invalid.".to_owned())?;
    if target <= current_version {
        return Err("Downgrades and same-version updates are not supported.".to_owned());
    }
    let updater_metadata = fs::symlink_metadata(&updater)
        .map_err(|error| format!("The Rust updater is unavailable: {error}"))?;
    if !updater_metadata.is_file() || is_reparse(&updater_metadata) {
        return Err("The Rust updater is not a regular file.".to_owned());
    }
    let mut child = Command::new(&updater);
    child
        .arg("--install-root")
        .arg(root)
        .arg("--release-root")
        .arg(&config.active_release)
        .arg("--update-id")
        .arg(update_id)
        .arg("--target-version")
        .arg(target_version)
        .arg("--repository")
        .arg(&config.repository)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut child);
    let mut updater = match child.spawn() {
        Ok(child) => child,
        Err(error) => {
            mark_update_start_failed(root, update_id, &error.to_string())?;
            return Err(format!("Unable to start the Rust updater: {error}"));
        }
    };
    let pid = updater.id();
    let status_path = update_status_path(root);
    for _ in 0..150 {
        if let Ok(status) = read_update_value(&status_path) {
            if status["updateId"].as_str() == Some(update_id) && status["status"] == "failed" {
                return Err(status["message"]
                    .as_str()
                    .unwrap_or("The Rust updater failed before startup was confirmed.")
                    .to_owned());
            }
            if status["updateId"].as_str() == Some(update_id)
                && status["executorConfirmed"] == true
                && status["executorPid"].as_u64() == Some(u64::from(pid))
            {
                return Ok(status.to_string());
            }
        }
        if let Some(status) = updater
            .try_wait()
            .map_err(|error| format!("Unable to verify updater startup: {error}"))?
        {
            let message = format!(
                "The Rust updater exited before startup was confirmed (code {}).",
                status_code(&status)
            );
            mark_unconfirmed_update_failed(root, update_id, &message)?;
            return Err(message);
        }
        thread::sleep(Duration::from_millis(100));
    }
    let message = "The Rust updater did not confirm startup before the timeout.";
    mark_unconfirmed_update_failed(root, update_id, message)?;
    Err(message.to_owned())
}

fn mark_unconfirmed_update_failed(
    root: &Path,
    update_id: &str,
    message: &str,
) -> Result<(), String> {
    if update_process_active(root, update_id)? {
        return Ok(());
    }
    let status = read_update_value(&update_status_path(root))?;
    if status["updateId"].as_str() == Some(update_id)
        && status["status"] == "starting"
        && status["executorConfirmed"] != true
    {
        mark_update_start_failed(root, update_id, message)?;
    }
    Ok(())
}

fn mark_update_start_failed(root: &Path, update_id: &str, message: &str) -> Result<(), String> {
    let status_path = update_status_path(root);
    let mut status = read_update_value(&status_path)?;
    if status["updateId"].as_str() != Some(update_id)
        || status["status"] != "starting"
        || status["executorConfirmed"] == true
    {
        return Err("The update task changed before startup failure was recorded.".to_owned());
    }
    status["status"] = serde_json::json!("failed");
    status["stage"] = serde_json::json!("starting");
    status["failedStage"] = serde_json::json!("starting");
    status["message"] = serde_json::json!(message);
    status["executorConfirmed"] = serde_json::json!(true);
    status["executorAlive"] = serde_json::json!(false);
    status["updatedAt"] = serde_json::json!(iso_timestamp());
    atomic_write(
        &status_path,
        &serde_json::to_vec(&status)
            .map_err(|error| format!("Unable to serialize failed update state: {error}"))?,
    )?;
    let lock_path = update_lock_path(root);
    if fs::symlink_metadata(&lock_path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !is_reparse(&metadata))
    {
        let lock = read_update_value(&lock_path)?;
        if lock["updateId"].as_str() == Some(update_id) {
            fs::remove_file(lock_path)
                .map_err(|error| format!("Unable to clear failed update startup lock: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn start_online_update(_root: &Path, _update_id: &str) -> Result<String, String> {
    Err("Online updates are supported only on Windows x64.".to_owned())
}

#[cfg(windows)]
fn acquire_run_lock(root: &Path) -> Result<Option<File>, String> {
    acquire_runtime_file_lock(root, "run.lock")
}

#[cfg(windows)]
fn acquire_runtime_file_lock(root: &Path, name: &str) -> Result<Option<File>, String> {
    let state = root.join("state");
    fs::create_dir_all(&state)
        .map_err(|error| format!("Unable to create runtime state: {error}"))?;
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state.join(name))
    {
        Ok(lock) => lock,
        Err(error) if is_lock_contention(&error) => return Ok(None),
        Err(error) => return Err(format!("Unable to open runtime lock: {error}")),
    };
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(lock)),
        Err(error) if is_lock_contention(&error) => Ok(None),
        Err(error) => Err(format!("Unable to acquire runtime lock: {error}")),
    }
}

#[cfg(windows)]
fn start_supervised_runtime(
    config: &ManagerConfig,
    run_state: &mut RuntimeRunRecord,
    stop: &StopEvent,
) -> Result<(RuntimeJob, RuntimeChildren), String> {
    let root = &config.install_root;
    let verification_started = Instant::now();
    verify_release_for_startup(&config.active_release, &config.version)?;
    if let Some(logger) = manager_diagnostics(root) {
        logger.record_with_metrics(
            DiagnosticComponent::Manager,
            "info",
            "runtime.startup.lightweight_verification.completed",
            "startup-verification",
            "none",
            diagnostics::EventMetrics {
                elapsed_ms: Some(
                    verification_started
                        .elapsed()
                        .as_millis()
                        .min(u64::MAX as u128) as u64,
                ),
                phase_item_count: Some(REQUIRED_RUNTIME_FILES.len() as u32),
                ..Default::default()
            },
        );
    }
    ensure_port_available(APPLICATION_PORT)?;
    ensure_port_available(DATABASE_PORT)?;
    let job = RuntimeJob::new()?;
    update_runtime_ui_phase(RUNTIME_UI_PHASE_DATABASE);
    let mut database = start_database(&job, &config.active_release, root, Some(stop), run_state)?;
    let application_job = RuntimeJob::new()?;
    update_runtime_ui_phase(RUNTIME_UI_PHASE_APPLICATION);
    let mut application =
        match start_application(&application_job, &config.active_release, root, Some(stop)) {
            Ok(application) => application,
            Err(error) => {
                run_state.phase = "database-stop-requested".to_owned();
                let _ = write_runtime_run(root, run_state);
                let session_end = stop.is_signaled();
                if session_end {
                    run_state.source = runtime_stop_source(root).to_owned();
                }
                let database = stop_database_launcher(
                    &job,
                    &mut database,
                    &config.active_release,
                    root,
                    if session_end {
                        Duration::from_secs(4)
                    } else {
                        Duration::from_secs(30)
                    },
                );
                run_state.database_exit_code = database.exit_code;
                run_state.database_elapsed_ms = Some(database.elapsed_ms);
                run_state.phase =
                    if session_end && database.confirmed && database.error_code.is_none() {
                        "completed"
                    } else if database.confirmed {
                        "failed"
                    } else {
                        "database-stop-unconfirmed"
                    }
                    .to_owned();
                run_state.ended_at_utc = Some(iso_timestamp());
                let _ = write_runtime_run(root, run_state);
                return Err(error);
            }
        };
    update_runtime_ui_phase(RUNTIME_UI_PHASE_HEALTH);
    if let Err(error) = wait_for_health(&mut application, &config.version, Some(stop)) {
        let mut children = RuntimeChildren {
            database,
            application,
            application_job,
        };
        if stop.is_signaled() {
            run_state.source = runtime_stop_source(root).to_owned();
        }
        run_state.phase = "running".to_owned();
        let _ = write_runtime_run(root, run_state);
        let _ = stop_children(
            &job,
            &mut children,
            &config.active_release,
            root,
            run_state,
            Some(Instant::now()),
        );
        return Err(error);
    }
    Ok((
        job,
        RuntimeChildren {
            database,
            application,
            application_job,
        },
    ))
}

#[cfg(windows)]
fn run_supervisor(
    open_browser_after_health: bool,
    mut open_lock: Option<File>,
    operation_lock: Option<File>,
) -> Result<String, String> {
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    let root = stable_root()?;
    if let Err(error) = remove_legacy_autostart(&root) {
        log_line(&root, &format!("Deferred legacy startup cleanup: {error}"));
    }
    let stop = create_stop_event()?;
    WINDOWS_SESSION_END.store(false, Ordering::SeqCst);
    WINDOWS_SESSION_END_TICK.store(0, Ordering::SeqCst);
    RUNTIME_HEALTHY.store(false, Ordering::SeqCst);
    TRAY_EXIT_REQUESTED.store(false, Ordering::SeqCst);
    let _session_notifier = SessionEndNotifier::start(&root, open_browser_after_health)?;
    update_runtime_ui_phase(RUNTIME_UI_PHASE_CHECKING);
    let operation_lock = match operation_lock {
        Some(lock) => {
            recover_transaction(&root)?;
            lock
        }
        None => recover_runtime_before_start(&root)?,
    };
    let config = read_config(&root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    if config.maintenance {
        return Err("The system is in maintenance and cannot be started.".to_owned());
    }
    if root.join("state/update-maintenance.json").exists() {
        return Err(
            "Maintenance state is still active and the application cannot be started.".to_owned(),
        );
    }
    if read_transaction_if_exists(&root)?
        .as_ref()
        .is_some_and(|transaction| !terminal(&transaction.stage))
    {
        return Err(
            "An installation recovery must finish before the application can start.".to_owned(),
        );
    }
    let Some(_run_lock) = acquire_run_lock(&root)? else {
        drop(open_lock);
        drop(_session_notifier);
        return if open_browser_after_health {
            wait_for_runtime_and_open(&root)
        } else {
            Ok("NGTManager is already running.".to_owned())
        };
    };
    drop(operation_lock);
    report_unconfirmed_previous_run(&root);
    let mut memory_sampler = memory_sample::MemorySamplingSupervisor::new(&root);
    let mut restarts = 0;
    let mut should_open_browser = open_browser_after_health;
    loop {
        let startup_started = Instant::now();
        let mut run_state = RuntimeRunRecord::new(unique_id(), "supervised-runtime");
        write_runtime_run(&root, &run_state)?;
        let (job, mut children) = match start_supervised_runtime(&config, &mut run_state, &stop) {
            Ok(runtime) => runtime,
            Err(error) => {
                if stop.is_signaled() && run_state.phase == "completed" {
                    return Ok("NGTManager stopped during startup.".to_owned());
                }
                if run_state.ended_at_utc.is_none() {
                    run_state.phase = "startup-failed".to_owned();
                    run_state.ended_at_utc = Some(iso_timestamp());
                    let _ = write_runtime_run(&root, &run_state);
                }
                return Err(error);
            }
        };
        run_state.phase = "running".to_owned();
        write_runtime_run(&root, &run_state)?;
        log_line(&root, "NGTManager runtime is healthy.");
        if let Some(logger) = manager_diagnostics(&root) {
            logger.record_with_metrics(
                DiagnosticComponent::Manager,
                "info",
                "manager.startup.runtime_ready",
                "runtime-ready",
                "none",
                diagnostics::EventMetrics {
                    elapsed_ms: Some(
                        startup_started.elapsed().as_millis().min(u64::MAX as u128) as u64
                    ),
                    ..Default::default()
                },
            );
            logger.record(
                DiagnosticComponent::Manager,
                "info",
                "manager.build",
                env!("NGT_BUILD_COMMIT"),
                "none",
            );
        }
        RUNTIME_HEALTHY.store(true, Ordering::SeqCst);
        if should_open_browser {
            queue_browser_open(open_lock.take());
            should_open_browser = false;
        } else if complete_and_hide_runtime_ui() {
            recover_hidden_browser();
        }

        loop {
            if !TRAY_EXIT_REQUESTED.load(Ordering::SeqCst)
                && !BROWSER_OPENING.load(Ordering::SeqCst)
            {
                if let Some(window) = promote_provisional_browser_window() {
                    if complete_and_hide_runtime_ui() {
                        let _ = show_managed_browser_window(window);
                        record_browser_event("manager.startup.ui_completed", "info", "none");
                    }
                }
            }
            if unsafe { WaitForSingleObject(stop.0, 250) } == WAIT_OBJECT_0 {
                let shutdown_started = Instant::now();
                memory_sampler.interrupt_for_shutdown();
                run_state.source = runtime_stop_source(&root).to_owned();
                let result = stop_children(
                    &job,
                    &mut children,
                    &config.active_release,
                    &root,
                    &mut run_state,
                    Some(shutdown_started),
                );
                drop(job);
                result?;
                log_line(&root, "NGTManager runtime stopped cleanly.");
                return Ok("NGTManager stopped.".to_owned());
            }
            let (database_exit, application_exit) = match (
                children.database.try_wait(),
                children.application.try_wait(),
            ) {
                (Ok(database), Ok(application)) => (database, application),
                (database, application) => {
                    let error = database
                        .err()
                        .or_else(|| application.err())
                        .expect("at least one process status check failed");
                    let error_code = error
                        .raw_os_error()
                        .map(|code| format!("WIN32_{code}"))
                        .unwrap_or_else(|| "PROCESS_MONITOR_FAILED".to_owned());
                    log_shutdown_phase(
                        &root,
                        "error",
                        "runtime.process_monitor.failed",
                        "process-monitor",
                        &error_code,
                        0,
                    );
                    let shutdown_started = Instant::now();
                    run_state.source = if stop.is_signaled() {
                        runtime_stop_source(&root).to_owned()
                    } else {
                        "runtime-monitor-error".to_owned()
                    };
                    memory_sampler.interrupt_for_shutdown();
                    let stop_result = stop_children(
                        &job,
                        &mut children,
                        &config.active_release,
                        &root,
                        &mut run_state,
                        Some(shutdown_started),
                    );
                    drop(job);
                    return match stop_result {
                            Ok(()) => Err(format!(
                                "Unable to monitor runtime processes ({error}); the runtime was stopped."
                            )),
                            Err(stop_error) => Err(format!(
                                "Unable to monitor runtime processes ({error}); shutdown was not confirmed: {stop_error}"
                            )),
                        };
                }
            };
            if let Some(status) = database_exit.as_ref() {
                log_child_exit(&root, DiagnosticComponent::Database, status);
            }
            if let Some(status) = application_exit.as_ref() {
                log_child_exit(&root, DiagnosticComponent::Application, status);
            }
            if database_exit.is_some() || application_exit.is_some() {
                let shutdown_started = Instant::now();
                memory_sampler.interrupt_for_shutdown();
                run_state.source = if stop.is_signaled() {
                    runtime_stop_source(&root).to_owned()
                } else {
                    "runtime-exit".to_owned()
                };
                let result = stop_children(
                    &job,
                    &mut children,
                    &config.active_release,
                    &root,
                    &mut run_state,
                    Some(shutdown_started),
                );
                drop(job);
                result?;
                if restarts >= 3 {
                    log_line(&root, "Automatic runtime restart limit reached.");
                    return Err("The application exited repeatedly; automatic restart stopped after three attempts.".to_owned());
                }
                restarts += 1;
                log_line(
                    &root,
                    &format!("Runtime exited unexpectedly; retry {restarts} of 3."),
                );
                let wait_ms = 1000u32 * (1u32 << (restarts - 1));
                if unsafe { WaitForSingleObject(stop.0, wait_ms) } == WAIT_OBJECT_0 {
                    return Ok("NGTManager stopped.".to_owned());
                }
                break;
            }
            memory_sampler.tick(job.0, children.application_job.0, &config.version);
        }
    }
}

fn recover_runtime_before_start(root: &Path) -> Result<File, String> {
    let operation_lock = lock_state(root)?;
    recover_transaction(root)?;
    Ok(operation_lock)
}

#[cfg(not(windows))]
fn run_supervisor(
    _open_browser_after_health: bool,
    _open_lock: Option<File>,
    _operation_lock: Option<File>,
) -> Result<String, String> {
    Err("NGTManager runtime is supported only on Windows x64.".to_owned())
}

#[cfg(windows)]
fn stop_supervisor(root: &Path) -> Result<String, String> {
    if !runtime_is_active(root)? {
        ensure_previous_runtime_confirmed(root)?;
        return Ok("NGTManager is not running.".to_owned());
    }
    for attempt in 0..180 {
        if attempt % 2 == 0 {
            request_runtime_stop_with_source(root, "user-request")?;
        }
        if !runtime_is_active(root)? {
            let record = fs::read(root.join("state/runtime/run-state.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<RuntimeRunRecord>(&bytes).ok());
            return if record
                .is_some_and(|record| record.phase == "completed" && record.ended_at_utc.is_some())
            {
                Ok("NGTManager stopped.".to_owned())
            } else {
                Err("NGTManager stopped without a confirmed clean shutdown; inspect the diagnostic export before retrying.".to_owned())
            };
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("NGTManager did not stop before the timeout.".to_owned())
}

#[cfg(not(windows))]
fn stop_supervisor(_root: &Path) -> Result<String, String> {
    Err("Runtime control is supported only on Windows x64.".to_owned())
}

fn start_memory_sample(root: &Path, request_id: &str) -> Result<String, String> {
    if !memory_sample::valid_request_id(request_id) {
        return Err("Memory-sampling request ID is invalid.".to_owned());
    }
    #[cfg(windows)]
    {
        if let Some(mut status) = memory_sample::read_status(root, Some(request_id))? {
            if status.phase == "queued" {
                memory_sample::enqueue(root, request_id)?;
                status = memory_sample::read_status(root, Some(request_id))?.unwrap_or(status);
            }
            return Ok(serde_json::to_string(&status).unwrap_or_default());
        }
        if !runtime_is_active(root)? {
            return Err("NGTManager must be running before memory sampling can start.".to_owned());
        }
        let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
        if config.maintenance
            || root.join("state/update-maintenance.json").exists()
            || !health_matches(&health_client()?, &config.version)
        {
            return Err("Memory sampling requires a healthy, non-maintenance runtime.".to_owned());
        }
        memory_sample::probe_documents()?;
        memory_sample::enqueue(root, request_id)?;
        Ok("Memory-sampling request accepted.".to_owned())
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("Memory sampling is supported only on Windows x64.".to_owned())
    }
}

#[cfg(windows)]
fn browser_window_property() -> Vec<u16> {
    "NGTManager.ManagedBrowserWindow"
        .encode_utf16()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
fn provisional_browser_window_property() -> Vec<u16> {
    "NGTManager.ProvisionalBrowserWindow"
        .encode_utf16()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
fn set_browser_window_cloaked(window: isize, cloaked: bool) -> bool {
    let value = i32::from(cloaked);
    unsafe {
        windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
            window as windows_sys::Win32::Foundation::HWND,
            13,
            &value as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        ) >= 0
    }
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
struct HiddenBrowserRecord {
    window: isize,
    process_id: u32,
    created: u64,
    executable: PathBuf,
    rect: [i32; 4],
}

#[cfg(windows)]
fn hidden_browser_record_path() -> Result<PathBuf, String> {
    Ok(stable_root()?.join("state/runtime/browser-hidden.json"))
}

#[cfg(windows)]
fn browser_window_is_held(window: isize) -> bool {
    let mut cloaked = 0u32;
    let mut rect = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute(
            window as _,
            14,
            &mut cloaked as *mut _ as _,
            4,
        );
        cloaked != 0
            || (windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(window as _, &mut rect)
                != 0
                && rect.left <= -30000
                && rect.top <= -30000)
    }
}

#[cfg(all(windows, test))]
fn hold_browser_until_ready(window: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let Some((executable, process_id, created)) = browser_window_process_identity(window) else {
        return false;
    };
    let Ok(path) = hidden_browser_record_path() else {
        return false;
    };
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(record) = serde_json::from_slice::<HiddenBrowserRecord>(&bytes) {
            if record.window == window
                && record.process_id == process_id
                && record.created == created
                && browser_window_is_held(window)
            {
                return true;
            }
        }
    }
    let mut rect = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(window as _, &mut rect) } == 0 {
        return false;
    }
    let record = HiddenBrowserRecord {
        window,
        process_id,
        created,
        executable,
        rect: [rect.left, rect.top, rect.right, rect.bottom],
    };
    let Ok(bytes) = serde_json::to_vec(&record) else {
        return false;
    };
    if atomic_write(&path, &bytes).is_err() {
        return false;
    }
    let _ = set_browser_window_cloaked(window, true);
    let held = browser_window_is_held(window)
        || unsafe {
            SetWindowPos(
                window as _,
                std::ptr::null_mut(),
                -32000,
                -32000,
                0,
                0,
                SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE,
            ) != 0
        } && browser_window_is_held(window);
    record_browser_event(
        "manager.browser.window.hidden_until_ready",
        if held { "info" } else { "error" },
        if held {
            "none"
        } else {
            "BROWSER_WINDOW_HIDE_FAILED"
        },
    );
    held
}

#[cfg(windows)]
fn restore_hidden_browser(window: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let Ok(path) = hidden_browser_record_path() else {
        return false;
    };
    let Ok(bytes) = fs::read(&path) else {
        return true;
    };
    let Ok(record) = serde_json::from_slice::<HiddenBrowserRecord>(&bytes) else {
        return false;
    };
    let matches = record.window == window
        && browser_window_matches_identity(window, record.process_id, record.created)
        && browser_window_process_identity(window)
            .is_some_and(|(actual, _, _)| browser_executable_matches(&actual, &record.executable));
    if !matches {
        return false;
    }
    // Uncloak is harmless when the recoverable off-screen fallback was used.
    let _ = set_browser_window_cloaked(window, false);
    let restored = unsafe {
        SetWindowPos(
            window as _,
            std::ptr::null_mut(),
            record.rect[0],
            record.rect[1],
            record.rect[2] - record.rect[0],
            record.rect[3] - record.rect[1],
            SWP_NOZORDER | SWP_NOACTIVATE,
        ) != 0
    } && !browser_window_is_held(window);
    if restored {
        let _ = fs::remove_file(path);
    }
    record_browser_event(
        "manager.browser.window.hidden_recovered",
        if restored { "info" } else { "error" },
        if restored {
            "none"
        } else {
            "BROWSER_WINDOW_RESTORE_FAILED"
        },
    );
    restored
}

#[cfg(windows)]
fn recover_hidden_browser() {
    let Ok(path) = hidden_browser_record_path() else {
        return;
    };
    let Ok(bytes) = fs::read(&path) else {
        return;
    };
    let Ok(record) = serde_json::from_slice::<HiddenBrowserRecord>(&bytes) else {
        let _ = fs::remove_file(path);
        return;
    };
    if browser_window_matches_identity(record.window, record.process_id, record.created) {
        let _ = restore_hidden_browser(record.window);
    } else {
        let _ = fs::remove_file(path);
    }
}

#[cfg(windows)]
fn record_browser_event(event: &str, level: &str, error_code: &str) {
    let Ok(root) = stable_root() else {
        return;
    };
    if let Some(logger) = manager_diagnostics(&root) {
        logger.record(
            DiagnosticComponent::Manager,
            level,
            event,
            "browser-window",
            error_code,
        );
    }
}

#[cfg(windows)]
unsafe extern "system" fn collect_browser_window(
    window: windows_sys::Win32::Foundation::HWND,
    parameter: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    let windows = &mut *(parameter as *mut Vec<isize>);
    windows.push(window as isize);
    1
}

#[cfg(windows)]
fn top_level_windows() -> Vec<isize> {
    let mut windows = Vec::new();
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(collect_browser_window),
            &mut windows as *mut Vec<isize> as isize,
        );
    }
    windows
}

#[cfg(windows)]
fn browser_window_process_identity(window: isize) -> Option<(PathBuf, u32, u64)> {
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let mut process_id = 0u32;
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
            window as windows_sys::Win32::Foundation::HWND,
            &mut process_id,
        );
    }
    if process_id == 0 {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let empty_time = || windows_sys::Win32::Foundation::FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut created = empty_time();
    let mut exited = empty_time();
    let mut kernel = empty_time();
    let mut user = empty_time();
    let succeeded = unsafe {
        QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) != 0
            && GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0
    };
    unsafe { windows_sys::Win32::Foundation::CloseHandle(process) };
    succeeded.then(|| {
        (
            PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])),
            process_id,
            ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
        )
    })
}

#[cfg(windows)]
fn browser_window_matches_identity(window: isize, process_id: u32, created: u64) -> bool {
    window != 0
        && unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(
                window as windows_sys::Win32::Foundation::HWND,
            )
        } != 0
        && browser_window_process_identity(window).is_some_and(
            |(path, actual_process_id, actual_created)| {
                actual_process_id == process_id
                    && actual_created == created
                    && browser_candidates()
                        .iter()
                        .any(|browser| browser_executable_matches(&path, browser))
            },
        )
}

#[cfg(windows)]
fn browser_executable_matches(actual: &Path, requested: &Path) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let identity = |path: &Path| {
        let file = File::open(path).ok()?;
        let mut info = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return None;
        }
        Some((
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ))
    };
    match (identity(actual), identity(requested)) {
        (Some(actual), Some(requested)) => actual == requested,
        _ => false,
    }
}

#[cfg(windows)]
fn browser_window_was_destroyed(window: isize, process_id: u32, created: u64) -> bool {
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(window as _) } == 0 {
        return true;
    }
    process_id != 0
        && created != 0
        && browser_window_process_identity(window).is_some_and(|(_, actual_pid, actual_created)| {
            actual_pid != process_id || actual_created != created
        })
}

#[cfg(windows)]
fn browser_window_title_matches(window: isize) -> bool {
    browser_window_title(window)
        .to_ascii_lowercase()
        .contains("ngtmanager")
}

#[cfg(windows)]
fn is_chromium_application_window(window: isize) -> bool {
    let mut class = [0u16; 256];
    let length = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
            window as windows_sys::Win32::Foundation::HWND,
            class.as_mut_ptr(),
            class.len() as i32,
        )
    };
    length > 0 && String::from_utf16_lossy(&class[..length as usize]) == "Chrome_WidgetWin_1"
}

#[cfg(windows)]
fn clear_managed_browser_identity() {
    MANAGED_BROWSER_WINDOW.store(0, Ordering::SeqCst);
    MANAGED_BROWSER_PROCESS_ID.store(0, Ordering::SeqCst);
    MANAGED_BROWSER_PROCESS_CREATED.store(0, Ordering::SeqCst);
}

#[cfg(windows)]
fn clear_provisional_browser_identity() {
    let window = PROVISIONAL_BROWSER_WINDOW.load(Ordering::SeqCst);
    if window != 0 {
        let property = provisional_browser_window_property();
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::RemovePropW(
                window as windows_sys::Win32::Foundation::HWND,
                property.as_ptr(),
            );
        }
    }
    PROVISIONAL_BROWSER_WINDOW.store(0, Ordering::SeqCst);
    PROVISIONAL_BROWSER_PROCESS_ID.store(0, Ordering::SeqCst);
    PROVISIONAL_BROWSER_PROCESS_CREATED.store(0, Ordering::SeqCst);
}

#[cfg(windows)]
fn provisional_browser_window() -> Option<isize> {
    let mut window = PROVISIONAL_BROWSER_WINDOW.load(Ordering::SeqCst);
    if window == 0 {
        let property = provisional_browser_window_property();
        if let Some(found) = top_level_windows().into_iter().find(|candidate| {
            !unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetPropW(
                    *candidate as windows_sys::Win32::Foundation::HWND,
                    property.as_ptr(),
                )
            }
            .is_null()
                && browser_window_process_identity(*candidate).is_some_and(|(path, _, _)| {
                    browser_candidates()
                        .iter()
                        .any(|browser| browser_executable_matches(&path, browser))
                })
        }) {
            if let Some((_, process_id, created)) = browser_window_process_identity(found) {
                PROVISIONAL_BROWSER_WINDOW.store(found, Ordering::SeqCst);
                PROVISIONAL_BROWSER_PROCESS_ID.store(process_id as u64, Ordering::SeqCst);
                PROVISIONAL_BROWSER_PROCESS_CREATED.store(created, Ordering::SeqCst);
                window = found;
            }
        }
    }
    let process_id = PROVISIONAL_BROWSER_PROCESS_ID.load(Ordering::SeqCst) as u32;
    let created = PROVISIONAL_BROWSER_PROCESS_CREATED.load(Ordering::SeqCst);
    if browser_window_matches_identity(window, process_id, created) {
        Some(window)
    } else {
        clear_provisional_browser_identity();
        None
    }
}

#[cfg(windows)]
fn promote_provisional_browser_window() -> Option<isize> {
    let window = provisional_browser_window()?;
    if !browser_window_title_matches(window) {
        return None;
    }
    let (_, process_id, created) = browser_window_process_identity(window)?;
    let property = browser_window_property();
    if unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SetPropW(
            window as windows_sys::Win32::Foundation::HWND,
            property.as_ptr(),
            1usize as windows_sys::Win32::Foundation::HANDLE,
        )
    } == 0
    {
        return None;
    }
    MANAGED_BROWSER_WINDOW.store(window, Ordering::SeqCst);
    MANAGED_BROWSER_PROCESS_ID.store(process_id as u64, Ordering::SeqCst);
    MANAGED_BROWSER_PROCESS_CREATED.store(created, Ordering::SeqCst);
    clear_provisional_browser_identity();
    BROWSER_WINDOW_EXPECTED.store(true, Ordering::SeqCst);
    record_browser_event("manager.browser.window.confirmed", "info", "none");
    Some(window)
}

#[cfg(windows)]
fn is_managed_browser_window(window: isize) -> bool {
    if window == 0
        || unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::IsWindow(
                window as windows_sys::Win32::Foundation::HWND,
            )
        } == 0
    {
        return false;
    }
    let Some((path, process_id, created)) = browser_window_process_identity(window) else {
        return false;
    };
    if !browser_candidates()
        .iter()
        .any(|browser| browser_executable_matches(&path, browser))
    {
        return false;
    }
    let expected_process_id = MANAGED_BROWSER_PROCESS_ID.load(Ordering::SeqCst) as u32;
    let expected_created = MANAGED_BROWSER_PROCESS_CREATED.load(Ordering::SeqCst);
    if (expected_process_id != 0 && process_id != expected_process_id)
        || (expected_created != 0 && created != expected_created)
    {
        return false;
    }
    let property = browser_window_property();
    !unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetPropW(
            window as windows_sys::Win32::Foundation::HWND,
            property.as_ptr(),
        )
    }
    .is_null()
}

#[cfg(windows)]
fn find_managed_browser_window() -> Option<isize> {
    let cached = MANAGED_BROWSER_WINDOW.load(Ordering::SeqCst);
    if is_managed_browser_window(cached) {
        return Some(cached);
    }
    if cached != 0 {
        let closed = browser_window_was_destroyed(
            cached,
            MANAGED_BROWSER_PROCESS_ID.load(Ordering::SeqCst) as u32,
            MANAGED_BROWSER_PROCESS_CREATED.load(Ordering::SeqCst),
        );
        clear_managed_browser_identity();
        BROWSER_WINDOW_EXPECTED.store(!closed, Ordering::SeqCst);
    }
    let found = top_level_windows()
        .into_iter()
        .find(|window| is_managed_browser_window(*window));
    if let Some(found_window) = found {
        MANAGED_BROWSER_WINDOW.store(found_window, Ordering::SeqCst);
        if let Some((_, process_id, created)) = browser_window_process_identity(found_window) {
            MANAGED_BROWSER_PROCESS_ID.store(process_id as u64, Ordering::SeqCst);
            MANAGED_BROWSER_PROCESS_CREATED.store(created, Ordering::SeqCst);
        }
        BROWSER_WINDOW_EXPECTED.store(true, Ordering::SeqCst);
        record_browser_event("manager.browser.window.adopted", "info", "none");
        return Some(found_window);
    }
    promote_provisional_browser_window()
}

#[cfg(windows)]
fn show_managed_browser_window(window: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindow, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST,
        SWP_NOMOVE, SWP_NOSIZE, SW_RESTORE,
    };
    if !is_managed_browser_window(window) || !restore_hidden_browser(window) {
        return false;
    }
    let window = window as windows_sys::Win32::Foundation::HWND;
    unsafe {
        ShowWindow(window, SW_RESTORE);
        SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        let foreground = SetForegroundWindow(window) != 0;
        if !foreground {
            FlashWindow(window, 1);
        }
        foreground
    }
}

#[cfg(windows)]
fn browser_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for (variable, suffix) in [
        ("ProgramFiles", "Google/Chrome/Application/chrome.exe"),
        ("ProgramFiles(x86)", "Google/Chrome/Application/chrome.exe"),
        ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
        ("ProgramFiles(x86)", "Microsoft/Edge/Application/msedge.exe"),
        ("ProgramFiles", "Microsoft/Edge/Application/msedge.exe"),
    ] {
        if let Some(base) = std::env::var_os(variable) {
            let path = PathBuf::from(base).join(suffix);
            if path.is_file() && !candidates.iter().any(|item| item == &path) {
                candidates.push(path);
            }
        }
    }
    candidates
}

#[cfg(windows)]
fn browser_window_title(window: isize) -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    let window = window as windows_sys::Win32::Foundation::HWND;
    let length = unsafe { GetWindowTextLengthW(window) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

#[cfg(windows)]
enum BrowserLaunchOutcome {
    Managed(isize),
    LaunchedUnconfirmed,
}

#[cfg(windows)]
fn launch_managed_browser(app_url: &str) -> Result<BrowserLaunchOutcome, String> {
    let startup = RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
    if startup.is_null()
        || unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(startup) } != 0
    {
        return Err("The startup window must be hidden before creating the browser.".to_owned());
    }
    if TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
        return Ok(BrowserLaunchOutcome::LaunchedUnconfirmed);
    }
    record_browser_event("manager.browser.launch.requested", "info", "none");
    use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;
    let before = top_level_windows().into_iter().collect::<BTreeSet<_>>();
    for executable in browser_candidates() {
        let child = match Command::new(&executable)
            .args([&format!("--app={app_url}"), "--no-first-run"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => continue,
        };
        BROWSER_WINDOW_EXPECTED.store(true, Ordering::SeqCst);
        unsafe { AllowSetForegroundWindow(child.id()) };
        *BROWSER_REQUEST
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some((before.clone(), executable.clone()));
        return identify_browser_window(&before, &executable);
    }
    Err("Google Chrome or Microsoft Edge is required to open NGTManager.".to_owned())
}

#[cfg(windows)]
fn identify_browser_window(
    before: &BTreeSet<isize>,
    executable: &Path,
) -> Result<BrowserLaunchOutcome, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindowVisible, SetPropW};
    let mut rejected = BTreeSet::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
            return Ok(BrowserLaunchOutcome::LaunchedUnconfirmed);
        }
        if let Some(window) = promote_provisional_browser_window() {
            return Ok(BrowserLaunchOutcome::Managed(window));
        }
        if let Some(candidate) = provisional_browser_window() {
            let title = browser_window_title(candidate);
            if !title.is_empty() && !browser_window_title_matches(candidate) {
                return Ok(BrowserLaunchOutcome::LaunchedUnconfirmed);
            }
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        for window in top_level_windows() {
            if before.contains(&window) || !is_chromium_application_window(window) {
                continue;
            }
            if unsafe { IsWindowVisible(window as _) } == 0 {
                rejected.insert("not-visible");
                continue;
            }
            let Some(identity) = browser_window_process_identity(window) else {
                rejected.insert("process-query-failed");
                continue;
            };
            if !browser_executable_matches(&identity.0, executable) {
                rejected.insert("image-mismatch");
                continue;
            }
            let title = browser_window_title(window);
            if !title.is_empty() && !browser_window_title_matches(window) {
                rejected.insert("title-not-product");
                continue;
            }
            let (_, process_id, created) = identity;
            PROVISIONAL_BROWSER_WINDOW.store(window, Ordering::SeqCst);
            PROVISIONAL_BROWSER_PROCESS_ID.store(process_id as u64, Ordering::SeqCst);
            PROVISIONAL_BROWSER_PROCESS_CREATED.store(created, Ordering::SeqCst);
            let property = provisional_browser_window_property();
            if unsafe {
                SetPropW(
                    window as windows_sys::Win32::Foundation::HWND,
                    property.as_ptr(),
                    1usize as windows_sys::Win32::Foundation::HANDLE,
                )
            } == 0
            {
                clear_provisional_browser_identity();
                record_browser_event(
                    "manager.browser.window.property_failed",
                    "error",
                    "BROWSER_PROPERTY_FAILED",
                );
                return Err("The browser window ownership marker could not be set.".to_owned());
            }
            record_browser_event("manager.browser.window.provisional", "info", "none");
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    for reason in rejected {
        record_browser_event("manager.browser.window.candidate_rejected", "info", reason);
    }
    record_browser_event(
        "manager.browser.window.identification_timeout",
        "warning",
        "BROWSER_WINDOW_IDENTIFICATION_TIMEOUT",
    );
    Ok(BrowserLaunchOutcome::LaunchedUnconfirmed)
}

#[cfg(windows)]
fn queue_browser_open(open_lock: Option<File>) -> bool {
    if TRAY_EXIT_REQUESTED.load(Ordering::SeqCst)
        || BROWSER_OPENING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return false;
    }
    let spawned = thread::Builder::new()
        .name("ngt-open-browser".to_owned())
        .spawn(move || {
            let result = open_browser();
            BROWSER_OPENING.store(false, Ordering::SeqCst);
            drop(open_lock);
            if result.is_err() && !TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
                record_browser_event(
                    "manager.browser.open.failed",
                    "error",
                    "BROWSER_OPEN_FAILED",
                );
                show_browser_attention();
            }
        });
    if spawned.is_err() {
        BROWSER_OPENING.store(false, Ordering::SeqCst);
        record_browser_event(
            "manager.browser.open.failed",
            "error",
            "BROWSER_WORKER_FAILED",
        );
        show_browser_attention();
        return false;
    }
    true
}

#[cfg(windows)]
fn open_browser() -> Result<bool, String> {
    if !complete_and_hide_runtime_ui() {
        return Err("The startup window did not finish; no browser was launched.".to_owned());
    }
    recover_hidden_browser();
    let _ = promote_provisional_browser_window();
    if let Some(window) = find_managed_browser_window() {
        let _ = show_managed_browser_window(window);
        record_browser_event("manager.browser.window.restored", "info", "none");
        return Ok(true);
    }
    if provisional_browser_window().is_some()
        && BROWSER_REQUEST
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none()
    {
        BROWSER_WINDOW_EXPECTED.store(true, Ordering::SeqCst);
        show_browser_attention();
        return Ok(false);
    }
    let pending = BROWSER_REQUEST
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let result = if BROWSER_WINDOW_EXPECTED.load(Ordering::SeqCst) {
        match pending {
            Some((before, executable)) => identify_browser_window(&before, &executable),
            None => Ok(BrowserLaunchOutcome::LaunchedUnconfirmed),
        }
    } else {
        launch_managed_browser("http://127.0.0.1:3000")
    };
    match result? {
        BrowserLaunchOutcome::Managed(window) => {
            record_browser_event("manager.browser.window.created", "info", "none");
            let _ = show_managed_browser_window(window);
            Ok(true)
        }
        BrowserLaunchOutcome::LaunchedUnconfirmed => {
            if !TRAY_EXIT_REQUESTED.load(Ordering::SeqCst) {
                show_browser_attention();
            }
            Ok(false)
        }
    }
}

#[cfg(windows)]
fn close_managed_browser_window(root: &Path) -> bool {
    let budget_end = Instant::now() + Duration::from_secs(5);
    let opening_deadline = Instant::now() + Duration::from_secs(2);
    while BROWSER_OPENING.load(Ordering::SeqCst) && Instant::now() < opening_deadline {
        thread::sleep(Duration::from_millis(50));
    }
    let Some(window) = find_managed_browser_window() else {
        let expected = BROWSER_WINDOW_EXPECTED.load(Ordering::SeqCst)
            || provisional_browser_window().is_some()
            || BROWSER_OPENING.load(Ordering::SeqCst);
        if expected {
            if let Some(logger) = manager_diagnostics(root) {
                logger.record(
                    DiagnosticComponent::Manager,
                    "warning",
                    "manager.browser.window.close_unconfirmed",
                    "browser-window",
                    "BROWSER_WINDOW_IDENTITY_UNCONFIRMED",
                );
            }
            return false;
        }
        return true;
    };
    let Some((_, closing_pid, closing_created)) = browser_window_process_identity(window) else {
        return false;
    };
    let destroyed = || browser_window_was_destroyed(window, closing_pid, closing_created);
    let request_close = || unsafe {
        if !is_managed_browser_window(window) || Instant::now() >= budget_end {
            return;
        }
        let mut result = 0usize;
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageTimeoutW(
            window as windows_sys::Win32::Foundation::HWND,
            windows_sys::Win32::UI::WindowsAndMessaging::WM_CLOSE,
            0,
            0,
            windows_sys::Win32::UI::WindowsAndMessaging::SMTO_ABORTIFHUNG,
            budget_end
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(1_000) as u32,
            &mut result,
        );
    };
    record_browser_event(
        "manager.browser.window.close_requested",
        "info",
        "first-attempt",
    );
    request_close();
    let deadline = budget_end.min(Instant::now() + Duration::from_millis(1_500));
    while Instant::now() < deadline && !destroyed() {
        thread::sleep(Duration::from_millis(50));
    }
    if !destroyed() {
        record_browser_event(
            "manager.browser.window.close_requested",
            "warning",
            "second-attempt",
        );
        request_close();
        let deadline = budget_end;
        while Instant::now() < deadline && !destroyed() {
            thread::sleep(Duration::from_millis(50));
        }
    }
    let closed = destroyed();
    if closed {
        clear_managed_browser_identity();
        clear_provisional_browser_identity();
        BROWSER_WINDOW_EXPECTED.store(false, Ordering::SeqCst);
    }
    if let Some(logger) = manager_diagnostics(root) {
        logger.record(
            DiagnosticComponent::Manager,
            if closed { "info" } else { "warning" },
            if closed {
                "manager.browser.window.closed"
            } else {
                "manager.browser.window.close_unconfirmed"
            },
            "browser-window",
            if closed {
                "none"
            } else {
                "BROWSER_WINDOW_CLOSE_UNCONFIRMED"
            },
        );
    }
    closed
}

#[cfg(windows)]
fn wait_for_runtime_and_open(root: &Path) -> Result<String, String> {
    let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    let client = health_client()?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        if config.maintenance || root.join("state/update-maintenance.json").exists() {
            return Err("NGTManager is in maintenance. Try opening it after the current operation finishes.".to_owned());
        }
        if health_matches(&client, &config.version) {
            return if signal_existing_runtime_ui(RUNTIME_UI_OPEN_MESSAGE) {
                Ok("NGTManager open request sent to the running manager.".to_owned())
            } else {
                Err("The running NGTManager window could not receive the open request. Retry from the tray.".to_owned())
            };
        }
        if !runtime_is_active(root)? {
            break;
        }
        thread::sleep(Duration::from_secs(1));
    }
    let phase = fs::read(root.join("state/runtime/run-state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeRunRecord>(&bytes).ok())
        .map_or_else(|| "unknown".to_owned(), |state| state.phase);
    Err(format!("NGTManager did not become ready within 180 seconds (last phase: {phase}). See the diagnostic logs."))
}

#[cfg(windows)]
fn wait_for_start_owner(root: &Path, open_lock: File) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_secs(180);
    signal_existing_runtime_ui(RUNTIME_UI_SHOW_MESSAGE);
    while Instant::now() < deadline {
        if runtime_is_active(root)? {
            return wait_for_runtime_and_open(root);
        }
        if let Some(operation_lock) = try_lock_state(root)? {
            return run_supervisor(true, Some(open_lock), Some(operation_lock));
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("NGTManager could not start because another operation did not finish within 180 seconds. See the diagnostic logs.".to_owned())
}

#[cfg(windows)]
fn open_system(root: &Path) -> Result<String, String> {
    let Some(open_lock) = acquire_runtime_file_lock(root, "open.lock")? else {
        signal_existing_runtime_ui(RUNTIME_UI_SHOW_MESSAGE);
        return Ok("NGTManager is already being opened.".to_owned());
    };
    if runtime_is_active(root)? {
        signal_existing_runtime_ui(RUNTIME_UI_SHOW_MESSAGE);
        wait_for_runtime_and_open(root)
    } else {
        match try_lock_state(root)? {
            Some(operation_lock) => run_supervisor(true, Some(open_lock), Some(operation_lock)),
            None => wait_for_start_owner(root, open_lock),
        }
    }
}

#[cfg(not(windows))]
fn open_system(_root: &Path) -> Result<String, String> {
    Err("NGTManager runtime is supported only on Windows x64.".to_owned())
}

fn valid_transition(current: &Stage, next: &Stage) -> bool {
    matches!(
        (current, next),
        (
            Stage::Preparing,
            Stage::Staged | Stage::Uninstalling | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::Staged,
            Stage::Maintenance | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::Maintenance,
            Stage::BackupCreating | Stage::Migrated | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::BackupCreating,
            Stage::BackupCreated | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::BackupCreated,
            Stage::BackupVerifying | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::BackupVerifying,
            Stage::BackupVerified | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::BackupVerified,
            Stage::Migrated | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::Migrated,
            Stage::CandidateHealthy | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::CandidateHealthy,
            Stage::Switching | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::Switching,
            Stage::Committed | Stage::RollingBack | Stage::Failed
        ) | (
            Stage::Uninstalling,
            Stage::Committed | Stage::RollingBack | Stage::Failed
        ) | (Stage::RollingBack, Stage::RolledBack | Stage::Failed)
            | (Stage::Failed, Stage::RollingBack)
    )
}

fn terminal(stage: &Stage) -> bool {
    matches!(stage, Stage::Committed | Stage::RolledBack)
}

fn read_transaction_if_exists(root: &Path) -> Result<Option<Transaction>, String> {
    let path = root.join("state").join("transaction.json");
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Unable to read operation state: {error}")),
    };
    let transaction: Transaction = serde_json::from_slice(&contents)
        .map_err(|error| format!("Operation state is unreadable: {error}"))?;
    if transaction.format_version != TRANSACTION_VERSION {
        return Err(
            "Operation state version is unsupported; manual recovery is required.".to_owned(),
        );
    }
    Ok(Some(transaction))
}

fn status_json(root: &Path) -> Result<String, String> {
    let config = read_config(root)?;
    let transaction = read_transaction_if_exists(root)?;
    let installed = config.is_some();
    let maintenance_path = root.join("state").join("update-maintenance.json");
    let marker_exists = match fs::metadata(maintenance_path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Unable to read maintenance state: {error}")),
    };
    let maintenance = marker_exists || config.as_ref().is_some_and(|config| config.maintenance);
    let state = transaction
        .as_ref()
        .map(|transaction| format!("{:?}", transaction.stage));
    let active = runtime_is_active(root)?;
    serde_json::to_string(&serde_json::json!({
        "installed": installed,
        "version": config.as_ref().map(|config| config.version.as_str()),
        "activeRelease": config.as_ref().map(|config| config.active_release.to_string_lossy()),
        "dataRoot": config.as_ref().map(|config| config.data_root.to_string_lossy()),
        "maintenance": maintenance,
        "runtimeActive": active,
        "transaction": transaction,
        "transactionStage": state,
    }))
    .map_err(|error| format!("Unable to format manager status: {error}"))
}

fn diagnose_json(root: &Path) -> Result<String, String> {
    let config = read_config(root)?;
    let transaction = read_transaction_if_exists(root)?;
    let maintenance_path = root.join("state").join("update-maintenance.json");
    let maintenance_marker = match fs::symlink_metadata(maintenance_path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Unable to read maintenance state: {error}")),
    };
    serde_json::to_string(&serde_json::json!({
        "formatVersion": 1,
        "installed": config.is_some(),
        "version": config.as_ref().map(|config| config.version.as_str()),
        "maintenance": maintenance_marker || config.as_ref().is_some_and(|config| config.maintenance),
        "runtimeActive": runtime_is_active(root)?,
        "operation": transaction.as_ref().map(|transaction| format!("{:?}", transaction.operation)),
        "transactionStage": transaction.as_ref().map(|transaction| format!("{:?}", transaction.stage)),
    }))
    .map_err(|error| format!("Unable to format diagnostic state: {error}"))
}

fn run(args: &[String]) -> Result<String, String> {
    match args {
        [command] if command == "status" => {
            let root = stable_root()?;
            status_json(&root)
        }
        [command, source] if command == "verify-release" => {
            let manifest = verify_release(Path::new(source))?;
            Ok(format!(
                "Verified NGTManager v{} ({})",
                manifest.version, manifest.commit
            ))
        }
        [command, source]
            if command == "preflight" || command == "install" || command == "update" || command == "repair" =>
        {
            let source = Path::new(source);
            if command == "preflight" {
                let preflight = preflight(source, "install", None)?;
                return Ok(serde_json::json!({
                    "status": "ready",
                    "installRoot": preflight.root,
                    "packageBytes": preflight.package_bytes,
                    "databaseBytes": preflight.database_bytes,
                    "version": verify_release(source)?.version,
                })
                .to_string());
            }
            install_package(source, command, None)
        }
        [command, source, operation_id] if command == "install" => {
            if operation_id.is_empty()
                || operation_id.len() > 64
                || !operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("Operation ID must contain 1–64 ASCII letters, digits, or hyphens.".to_owned());
            }
            install_package(Path::new(source), command, Some(operation_id))
        }
        [command, source, operation_id] if command == "update" => {
            if operation_id.is_empty()
                || operation_id.len() > 64
                || !operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("Operation ID must contain 1–64 ASCII letters, digits, or hyphens.".to_owned());
            }
            install_package(Path::new(source), command, Some(operation_id))
        }
        [command] if command == "run" => run_supervisor(false, None, None),
        [command] if command == "open" => open_system(&stable_root()?),
        [command] if command == "stop" => stop_supervisor(&stable_root()?),
        [command] if command == "recover" => {
            let root = stable_root()?;
            let _lock = lock_state(&root)?;
            recover_transaction(&root)
        }
        [command] if command == "uninstall" => {
            let root = stable_root()?;
            let _lock = lock_state(&root)?;
            recover_transaction(&root)?;
            ensure_update_operation(&root, command, None)?;
            if !close_managed_browser_window(&root) {
                return Err(
                    "The NGTManager application window did not close; the runtime was left running."
                        .to_owned(),
                );
            }
            stop_supervisor(&root)?;
            let mut transaction = create_transaction(
                &root,
                Operation::Uninstall,
                unique_id(),
                read_config(&root)?,
                inspect_postgres_directory(&root.join("data/postgres"))?,
            )?;
            advance_transaction(&root, &mut transaction, Stage::Uninstalling)?;
            remove_legacy_autostart(&root)?;
            advance_transaction(&root, &mut transaction, Stage::Committed)?;
            Ok("NGTManager was stopped. Business data and backups were retained.".to_owned())
        }
        [command] if command == "diagnose" => diagnose_json(&stable_root()?),
        [command, output] if command == "diagnose-export" => {
            diagnostics::export_diagnostics(&stable_root()?, Path::new(output))
                .map_err(|_| "Unable to create the diagnostic export.".to_owned())?;
            Ok("Diagnostic export created.".to_owned())
        }
        [command, request_id] if command == "memory-sample-start" => {
            start_memory_sample(&stable_root()?, request_id)
        }
        [command, request_id, task_id] if command == "memory-sample-save" => {
            let path = memory_sample::save_report(&stable_root()?, request_id, task_id)?;
            serde_json::to_string(&path.to_string_lossy().to_string())
                .map_err(|_| "Unable to encode memory-sampling report path.".to_owned())
        }
        [command, request_id] if command == "memory-sample-retry-save" => {
            let status = memory_sample::retry_save(&stable_root()?, request_id)?;
            serde_json::to_string(&status)
                .map_err(|_| "Unable to encode memory-sampling status.".to_owned())
        }
        [command, root_pid, output, warmup, duration, interval]
            if command == "memory-sample-external" =>
        {
            let root_pid = root_pid
                .parse::<u32>()
                .map_err(|_| "External sample root PID is invalid.".to_owned())?;
            let warmup = warmup
                .parse::<u64>()
                .map_err(|_| "External sample warmup is invalid.".to_owned())?;
            let duration = duration
                .parse::<u64>()
                .map_err(|_| "External sample duration is invalid.".to_owned())?;
            let interval = interval
                .parse::<u64>()
                .map_err(|_| "External sample interval is invalid.".to_owned())?;
            let root = stable_root()?;
            let version = read_config(&root)?
                .map(|config| config.version)
                .unwrap_or_else(|| "unknown".to_owned());
            memory_sample::run_external(
                root_pid,
                Path::new(output),
                warmup,
                duration,
                interval,
                &root.join("tools").join("NGTManager.exe"),
                &version,
            )
        }
        [command, update_id] if command == "update-process" => {
            let root = stable_root()?;
            Ok(serde_json::json!({
                "active": update_process_active(&root, update_id)?,
            })
            .to_string())
        }
        [command, update_id, result] if command == "clear-update-lock" => {
            let root = stable_root()?;
            let _lock = lock_state(&root)?;
            clear_update_lock(&root, update_id, result)
        }
        [command, update_id, target_version] if command == "reserve-update" => {
            let root = stable_root()?;
            reserve_online_update(&root, update_id, target_version)
        }
        [command, update_id] if command == "start-update" => {
            let root = stable_root()?;
            start_online_update(&root, update_id)
        }
        [command, path, bytes] if command == "check-space" => {
            let required = bytes
                .parse::<u64>()
                .map_err(|_| "Required disk space must be an integer byte count.".to_owned())?;
            check_space(Path::new(path), required)?;
            Ok("Disk space check passed.".to_owned())
        }
        [command, operation_id, elapsed_ms, outcome] if command == "record-installer-registration" => {
            if operation_id.is_empty()
                || operation_id.len() > 64
                || !operation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("Operation ID is invalid.".to_owned());
            }
            let elapsed_ms = elapsed_ms
                .parse::<u64>()
                .ok()
                .filter(|value| *value <= 86_400_000)
                .ok_or_else(|| "Installer registration duration is invalid.".to_owned())?;
            let (severity, event_code, error_code) = match outcome.as_str() {
                "complete" => ("info", "installer.registration.completed", "none"),
                "incomplete" => (
                    "warning",
                    "installer.registration.incomplete",
                    "SETUP_REGISTRATION_INCOMPLETE",
                ),
                _ => return Err("Installer registration outcome is invalid.".to_owned()),
            };
            let root = stable_root()?;
            let _operation_lock = lock_state(&root)?;
            let config = read_config(&root)?.ok_or_else(|| "No committed version was found.".to_owned())?;
            let transaction = read_transaction(&root)?;
            if config.maintenance || transaction.stage != Stage::Committed {
                return Err("Setup registration requires a committed version.".to_owned());
            }
            if root.join("state/update.lock").exists()
                && read_update_value(&update_lock_path(&root))?["updateId"] != operation_id.as_str() {
                return Err("Another update owns setup registration.".to_owned());
            }
            let registration = serde_json::json!({
                "formatVersion": 1, "operationId": operation_id, "version": config.version, "outcome": outcome,
            });
            atomic_write(&root.join("state/installer-registration.json"), &serde_json::to_vec(&registration)
                .map_err(|error| error.to_string())?)?;
            set_operation_id(&root, operation_id);
            if let Some(logger) = manager_diagnostics(&root) {
                logger.record_with_metrics(
                    DiagnosticComponent::Installer,
                    severity,
                    event_code,
                    "inno-registration",
                    error_code,
                    diagnostics::EventMetrics {
                        elapsed_ms: Some(elapsed_ms),
                        ..Default::default()
                    },
                );
            }
            Ok("Installer registration result was recorded.".to_owned())
        }
        _ => Err("Usage: NGTManager.exe status | preflight <package> | install <package> [operationId] | update <package> [operationId] | repair <package> | reserve-update <id> <version> | start-update <id> | clear-update-lock <id> <complete|retry> | run | open | stop | recover | diagnose | diagnose-export <outputPath> | memory-sample-start <requestId> | memory-sample-save <requestId> <taskId> | memory-sample-retry-save <requestId> | memory-sample-external <rootPid> <outputDirectory> <warmupSeconds> <durationSeconds> <intervalSeconds> | update-process <id> | uninstall | verify-release <path> | check-space <path> <bytes> | record-installer-registration <id> <elapsedMs> <complete|incomplete>".to_owned()),
    }
}

fn require_transition(current: &Stage, next: &Stage) -> Result<(), String> {
    if valid_transition(current, next) {
        Ok(())
    } else {
        Err(format!(
            "Invalid operation transition: {current:?} → {next:?}."
        ))
    }
}

fn validate_result_file_path(path: &Path, arguments: &[String]) -> Result<(), String> {
    validate_setup_output_path(
        path,
        arguments,
        "NGTManager-setup-result-",
        ".txt",
        "install result",
    )
}

fn validate_progress_file_path(path: &Path, arguments: &[String]) -> Result<(), String> {
    validate_setup_output_path(
        path,
        arguments,
        "NGTManager-setup-progress-",
        ".txt",
        "install progress",
    )
}

fn validate_process_id_file_path(path: &Path, arguments: &[String]) -> Result<(), String> {
    validate_setup_output_path(
        path,
        arguments,
        "NGTManager-setup-process-",
        ".pid",
        "install process ID",
    )
}

fn validate_setup_output_path(
    path: &Path,
    arguments: &[String],
    prefix: &str,
    suffix: &str,
    description: &str,
) -> Result<(), String> {
    if !matches!(
        arguments.first().map(String::as_str),
        Some("install" | "update")
    ) {
        return Err(format!(
            "The {description} path is only valid for setup operations."
        ));
    }
    let operation_id = arguments
        .get(2)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(|| format!("A valid operation ID is required for the {description} file."))?;
    let expected_name = format!("{prefix}{operation_id}{suffix}");
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err(format!(
            "The {description} file name does not match its operation."
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {description} file directory is invalid."))?;
    let parent = fs::canonicalize(parent)
        .map_err(|_| format!("The {description} file directory is unavailable."))?;
    let temporary = fs::canonicalize(std::env::temp_dir())
        .map_err(|_| "The temporary directory is unavailable.".to_owned())?;
    if !parent.starts_with(temporary) {
        return Err(format!(
            "The {description} file must be inside the temporary directory."
        ));
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(format!(
            "The {description} file already exists; it was not overwritten."
        )),
        Err(_) => Err(format!(
            "The {description} file cannot be safely inspected."
        )),
    }
}

fn write_setup_result(path: &Path, contents: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(contents.as_bytes())
}

pub fn main() -> std::process::ExitCode {
    let mut arguments = Vec::new();
    let mut result_file = None;
    let mut cancel_file = None;
    let mut progress_file = None;
    let mut process_id_file = None;
    let mut extraction_elapsed_ms = None;
    let mut extracted_file_count = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--result-file" {
            if result_file.is_some() {
                eprintln!("The install result path was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            result_file = match args.next() {
                Some(path) => Some(PathBuf::from(path)),
                None => {
                    eprintln!("The install result path is missing.");
                    return std::process::ExitCode::FAILURE;
                }
            };
        } else if argument == "--cancel-file" {
            if cancel_file.is_some() {
                eprintln!("The install cancellation path was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            cancel_file = match args.next() {
                Some(path) => Some(PathBuf::from(path)),
                None => {
                    eprintln!("The install cancellation path is missing.");
                    return std::process::ExitCode::FAILURE;
                }
            };
        } else if argument == "--progress-file" {
            if progress_file.is_some() {
                eprintln!("The install progress path was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            progress_file = match args.next() {
                Some(path) => Some(PathBuf::from(path)),
                None => {
                    eprintln!("The install progress path is missing.");
                    return std::process::ExitCode::FAILURE;
                }
            };
        } else if argument == "--process-id-file" {
            if process_id_file.is_some() {
                eprintln!("The install process ID path was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            process_id_file = match args.next() {
                Some(path) => Some(PathBuf::from(path)),
                None => {
                    eprintln!("The install process ID path is missing.");
                    return std::process::ExitCode::FAILURE;
                }
            };
        } else if argument == "--package-extract-ms" {
            if extraction_elapsed_ms.is_some() {
                eprintln!("The package extraction duration was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            extraction_elapsed_ms = args
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value <= 86_400_000);
            if extraction_elapsed_ms.is_none() {
                eprintln!("The package extraction duration is invalid.");
                return std::process::ExitCode::FAILURE;
            }
        } else if argument == "--package-file-count" {
            if extracted_file_count.is_some() {
                eprintln!("The extracted package file count was supplied more than once.");
                return std::process::ExitCode::FAILURE;
            }
            extracted_file_count = args
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value <= 1_000_000);
            if extracted_file_count.is_none() {
                eprintln!("The extracted package file count is invalid.");
                return std::process::ExitCode::FAILURE;
            }
        } else {
            arguments.push(argument);
        }
    }
    let extraction_metrics = match (extraction_elapsed_ms, extracted_file_count) {
        (Some(elapsed_ms), Some(file_count)) => Some((elapsed_ms, file_count)),
        (None, None) => None,
        _ => {
            eprintln!("Package extraction metrics are incomplete.");
            return std::process::ExitCode::FAILURE;
        }
    };
    if let Some(path) = result_file.as_ref() {
        if let Err(error) = validate_result_file_path(path, &arguments) {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
    }
    if let Some(path) = progress_file.as_ref() {
        if let Err(error) = validate_progress_file_path(path, &arguments) {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
    }
    if let Some(path) = process_id_file.as_ref() {
        if let Err(error) = validate_process_id_file_path(path, &arguments) {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
        let process_id = std::process::id().to_string();
        if let Err(error) = write_setup_result(path, &process_id) {
            eprintln!("Unable to publish the install process ID: {error}");
            return std::process::ExitCode::FAILURE;
        }
    }
    let _ = INSTALL_EXTRACTION_METRICS.set(extraction_metrics);
    let _ = INSTALL_CANCEL_FILE.set(cancel_file);
    let _ = INSTALL_PROGRESS_FILE.set(progress_file);
    initialize_manager_diagnostics(&arguments);
    let result = run(&arguments);
    if let Err(message) = &result {
        let diagnostic_id = if let Ok(root) = stable_root() {
            let explicit_install_attempt =
                arguments.len() >= 3 && matches!(arguments[0].as_str(), "install" | "update");
            if !explicit_install_attempt {
                if let Ok(Some(transaction)) = read_transaction_if_exists(&root) {
                    set_operation_id(&root, &transaction.operation_id);
                }
            }
            record_command_failure(&root, &arguments, message)
        } else {
            None
        };
        #[cfg(not(windows))]
        let _ = diagnostic_id;
        #[cfg(windows)]
        if arguments == ["open"] && result_file.is_none() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            let message = match diagnostic_id {
                Some(id) => format!("{message}\nDiagnostic ID: {id}"),
                None => message.clone(),
            };
            let body: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "NGTManager".encode_utf16().chain(Some(0)).collect();
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    body.as_ptr(),
                    title.as_ptr(),
                    MB_OK | MB_ICONERROR,
                );
            }
        }
    }
    if let Some(path) = result_file {
        let contents = match &result {
            Ok(message) => format!("SUCCESS\n{message}"),
            Err(message) => format!("ERROR\n{message}"),
        };
        if let Err(error) = write_setup_result(&path, &contents) {
            eprintln!("Unable to write the install result: {error}");
            if let Ok(root) = stable_root() {
                if let Some(logger) = manager_diagnostics(&root) {
                    logger.record(
                        DiagnosticComponent::Installer,
                        "error",
                        "installer.result_file_write_failed",
                        "result-reporting",
                        "RESULT_FILE_WRITE_FAILED",
                    );
                }
            }
        }
    }
    let exit_code = match result {
        Ok(message) => {
            println!("{message}");
            std::process::ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::ExitCode::FAILURE
        }
    };
    if let Ok(root) = stable_root() {
        if let Some(logger) = manager_diagnostics(&root) {
            logger.finish();
        }
    }
    exit_code
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[cfg(windows)]
    #[test]
    fn scheduled_task_output_decodes_utf8_and_utf16() {
        let xml = "<Command>wscript.exe</Command>";
        assert_eq!(decode_windows_command_output(xml.as_bytes()), xml);
        let mut utf16 = vec![0xff, 0xfe];
        for unit in xml.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_windows_command_output(&utf16), xml);
    }

    #[cfg(windows)]
    #[test]
    fn login_start_ownership_accepts_only_product_paths() {
        let root = PathBuf::from(r"C:\Users\Test\AppData\Local\NGTManager");
        let legacy = PathBuf::from(r"C:\Users\Test\AppData\Local\NGT");
        assert!(owned_autostart_command(
            r#""C:\Users\Test\AppData\Local\NGTManager\tools\NGTManager.exe" run"#,
            &root,
            &legacy,
        ));
        assert!(owned_autostart_command(
            r#"wscript.exe //B //Nologo "C:\Users\Test\AppData\Local\NGT\service\windows-studio-launcher.vbs""#,
            &root,
            &legacy,
        ));
        assert!(!owned_autostart_command(
            r#"C:\Other\evil.exe "C:\Users\Test\AppData\Local\NGTManager\tools\NGTManager.exe""#,
            &root,
            &legacy,
        ));
        assert!(!owned_autostart_command(
            r#"C:\Other\NGTManager.exe"#,
            &root,
            &legacy,
        ));
    }

    #[test]
    fn startup_coordination_failures_keep_specific_codes() {
        assert_eq!(
            failure_code("Another NGTManager operation is already running."),
            "OPERATION_IN_PROGRESS"
        );
        assert_eq!(
            failure_code("NGTManager did not become ready within 180 seconds."),
            "RUNTIME_START_TIMEOUT"
        );
        assert_eq!(
            failure_code("another operation did not finish within 180 seconds"),
            "OPERATION_WAIT_TIMEOUT"
        );
        assert_eq!(
            failure_code("The previous runtime shutdown is unconfirmed."),
            "PREVIOUS_RUNTIME_UNCONFIRMED"
        );
        assert_eq!(
            failure_code("The previous runtime stop state version is unsupported."),
            "RUNTIME_STATE_VERSION_UNSUPPORTED"
        );
        assert_eq!(
            failure_code("The PostgreSQL status tool version does not match the legacy database."),
            "POSTGRES_TOOL_VERSION_MISMATCH"
        );
        assert_eq!(
            failure_code("Unable to determine whether the business database is running."),
            "POSTGRES_STATUS_UNKNOWN"
        );
    }

    #[cfg(windows)]
    #[test]
    fn recovered_runtime_state_remains_readable_by_the_previous_schema() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PreviousRuntimeRunRecord {
            format_version: u8,
            run_id: String,
            source: String,
            phase: String,
            ended_at_utc: Option<String>,
        }

        let mut record = RuntimeRunRecord::new("run-1".to_owned(), "supervised-runtime");
        mark_runtime_recovered(
            &mut record,
            "running",
            "STALE_RUNTIME_STATE_VERIFIED_STOPPED",
        );
        let encoded = serde_json::to_vec(&record).unwrap();
        let previous: PreviousRuntimeRunRecord = serde_json::from_slice(&encoded).unwrap();

        assert_eq!(previous.format_version, 1);
        assert_eq!(previous.run_id, "run-1");
        assert_eq!(previous.source, "supervised-runtime");
        assert_eq!(previous.phase, "startup-failed");
        assert!(previous.ended_at_utc.is_some());
        assert_eq!(record.recovered_from_phase.as_deref(), Some("running"));
    }

    #[cfg(windows)]
    #[test]
    fn runtime_recovery_accepts_only_known_version_one_phases() {
        for phase in [
            "starting",
            "database-starting",
            "database-started",
            "running",
            "application-stop-requested",
            "database-stop-requested",
            "failed",
            "unconfirmed",
            "startup-failed",
            "completed",
        ] {
            assert!(known_runtime_phase(phase), "missing phase {phase}");
        }
        assert!(!known_runtime_phase("recovered-stopped"));
        assert!(!known_runtime_phase("future-phase"));
    }

    #[cfg(windows)]
    #[test]
    fn invalid_runtime_state_evidence_is_idempotent_for_one_operation() {
        let root = std::env::temp_dir().join(format!("ngt-invalid-run-state-{}", unique_id()));
        fs::create_dir_all(root.join("state/runtime")).unwrap();

        preserve_invalid_runtime_state(&root, "attempt-1", b"{broken").unwrap();
        preserve_invalid_runtime_state(&root, "attempt-1", b"{broken").unwrap();
        assert!(preserve_invalid_runtime_state(&root, "attempt-1", b"different").is_err());
        assert_eq!(
            fs::read(root.join("state/runtime/run-state.invalid-attempt-1.json")).unwrap(),
            b"{broken"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn runtime_state_preflight_defers_malformed_legacy_state_but_rejects_future_versions() {
        let root = std::env::temp_dir().join(format!("ngt-run-state-preflight-{}", unique_id()));
        fs::create_dir_all(root.join("state/runtime")).unwrap();
        let path = root.join("state/runtime/run-state.json");

        fs::write(&path, b"{broken").unwrap();
        preflight_runtime_state(&root).unwrap();
        fs::write(&path, br#"{"phase":"running"}"#).unwrap();
        preflight_runtime_state(&root).unwrap();
        fs::write(&path, br#"{"formatVersion":2,"phase":"running"}"#).unwrap();
        assert!(preflight_runtime_state(&root)
            .unwrap_err()
            .contains("version is unsupported"));

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn legacy_database_probe_uses_verified_candidate_when_old_tool_is_missing() {
        let root = std::env::temp_dir().join(format!("ngt-legacy-probe-{}", unique_id()));
        let installed = root.join("installed");
        let candidate = root.join("candidate");
        for release in [&installed, &candidate] {
            fs::create_dir_all(release.join("runtime/postgres/bin")).unwrap();
        }
        let tool = "runtime/postgres/bin/pg_controldata.exe";
        assert!(legacy_control_release(&installed, None, tool).is_err());
        fs::write(candidate.join(tool), "").unwrap();
        assert_eq!(
            legacy_control_release(&installed, Some(&candidate), tool).unwrap(),
            candidate
        );
        fs::write(installed.join(tool), "").unwrap();
        assert_eq!(
            legacy_control_release(&installed, Some(&candidate), tool).unwrap(),
            installed
        );
        let status_tool = "runtime/postgres/bin/pg_ctl.exe";
        assert!(legacy_control_release(&installed, Some(&candidate), status_tool).is_err());
        fs::write(candidate.join(status_tool), "").unwrap();
        assert_eq!(
            legacy_control_release(&installed, Some(&candidate), status_tool).unwrap(),
            candidate
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_database_handoff_requires_a_clean_control_state() {
        assert!(postgres_cluster_is_clean(
            "Database cluster state:               shut down\n"
        ));
        assert!(!postgres_cluster_is_clean(
            "Database cluster state:               in production\n"
        ));
        assert!(!postgres_cluster_is_clean("control file is unreadable\n"));
        assert_eq!(
            postgres_cluster_state("Database cluster state: in production\n"),
            Some("in production")
        );
        assert_eq!(
            postgres_major_version(b"pg_controldata (PostgreSQL) 17.2\n"),
            Some("17")
        );
        assert_eq!(postgres_major_version(b"unexpected output\n"), None);
    }

    #[test]
    fn legacy_control_failures_keep_a_safe_specific_reason() {
        assert_eq!(
            classify_legacy_control_failure(
                Some(1),
                "pg_controldata: error: could not open file global/pg_control"
            )
            .0,
            "POSTGRES_CONTROL_INCOMPLETE"
        );
        assert_eq!(
            classify_legacy_control_failure(Some(1), "Permission denied").0,
            "POSTGRES_CONTROL_ACCESS_DENIED"
        );
        assert_eq!(
            classify_legacy_control_failure(Some(42), "").0,
            "POSTGRES_CONTROL_VERSION_MISMATCH"
        );
        assert_eq!(
            classify_legacy_control_failure(Some(1), "unexpected failure").0,
            "POSTGRES_CONTROL_CHECK_FAILED"
        );
    }

    #[test]
    fn setup_result_files_are_operation_scoped_and_never_overwritten() {
        let directory = std::env::temp_dir().join(format!("ngt-setup-result-{}", unique_id()));
        fs::create_dir(&directory).unwrap();
        let result_path = directory.join("NGTManager-setup-result-attempt-1.txt");
        let progress_path = directory.join("NGTManager-setup-progress-attempt-1.txt");
        let process_id_path = directory.join("NGTManager-setup-process-attempt-1.pid");
        let arguments = vec![
            "install".to_owned(),
            "package".to_owned(),
            "attempt-1".to_owned(),
        ];

        validate_result_file_path(&result_path, &arguments).unwrap();
        validate_progress_file_path(&progress_path, &arguments).unwrap();
        validate_process_id_file_path(&process_id_path, &arguments).unwrap();
        publish_install_progress(
            Some(&progress_path),
            "NGT_PROGRESS|attempt-1|starting|0|0|0",
        );
        assert_eq!(
            fs::read_to_string(&progress_path).unwrap(),
            "NGT_PROGRESS|attempt-1|starting|0|0|0"
        );
        write_setup_result(&result_path, "ERROR\ninstall failed").unwrap();
        assert!(validate_result_file_path(&result_path, &arguments).is_err());
        assert!(write_setup_result(&result_path, "ERROR\nreplacement").is_err());
        assert_eq!(
            fs::read_to_string(&result_path).unwrap(),
            "ERROR\ninstall failed"
        );

        let unrelated_path = std::env::temp_dir()
            .parent()
            .unwrap()
            .join("NGTManager-setup-result-attempt-1.txt");
        assert!(validate_result_file_path(&unrelated_path, &arguments).is_err());
        let wrong_name = directory.join("business-backup.json");
        assert!(validate_result_file_path(&wrong_name, &arguments).is_err());
        assert!(validate_progress_file_path(&wrong_name, &arguments).is_err());
        assert!(validate_process_id_file_path(&wrong_name, &arguments).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn atomic_state_write_creates_a_missing_parent_directory() {
        let root = std::env::temp_dir().join(format!("ngt-atomic-state-{}", unique_id()));
        fs::create_dir_all(root.join("state")).unwrap();
        let destination = root
            .join("state")
            .join("runtime")
            .join("candidate-run.json");

        assert!(!destination.parent().unwrap().exists());
        atomic_write(&destination, br#"{"phase":"running"}"#).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), br#"{"phase":"running"}"#);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn runtime_output_is_drained_before_startup_gate_release() {
        let root = std::env::temp_dir().join(format!("ngt-pipe-flood-{}", unique_id()));
        fs::create_dir_all(&root).unwrap();
        let script = root.join("pipe-flood.cmd");
        fs::write(
            &script,
            "@echo off\r\nfor /L %%N in (1,1,512) do echo NGT-MANAGER-PIPE-FLOOD-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n:wait\r\nfindstr /c:ready \"%NGT_RUNTIME_START_GATE%\" >nul\r\nif errorlevel 1 goto wait\r\ndel \"%NGT_RUNTIME_START_GATE%\"\r\nexit /b 0\r\n",
        )
        .unwrap();
        let logger =
            LogSession::start(&root, "pipe-flood-test", "test", LogOwner::Manager).unwrap();
        assert!(MANAGER_DIAGNOSTICS.set(Some(logger)).is_ok());
        let job = RuntimeJob::new().unwrap();
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c").arg(script);
        hide_console(&mut command);
        let mut child =
            spawn_runtime_process(&job, &mut command, &root, DiagnosticComponent::Application)
                .unwrap();
        assert!(child.wait().unwrap().success());
        drop(job);
        manager_diagnostics(&root).unwrap().finish();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn health_check_accepts_chunked_http_json() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let bytes_read = stream.read(&mut request).unwrap();
            assert!(bytes_read > 0, "health check client sent no request");
            let body = br#"{"status":"ok","currentVersion":"2.0.23"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{:X}\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
            stream.write_all(b"\r\n0\r\n\r\n").unwrap();
        });

        let client = health_client().unwrap();
        let url = format!("http://{address}/api/health");
        assert!(health_matches_at(&client, &url, "2.0.23"));
        server.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn candidate_activation_waits_for_validation_processes_to_exit() {
        let root = std::env::temp_dir().join(format!("ngt-manager-activation-{}", unique_id()));
        let candidate = root.join(".candidate");
        let release = root.join("v2.0.23");
        fs::create_dir_all(&candidate).unwrap();
        fs::write(candidate.join("held-open.bin"), b"candidate file").unwrap();

        let job = RuntimeJob::new().unwrap();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-Command",
            "$stream=[System.IO.File]::Open('held-open.bin',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);[System.IO.File]::WriteAllText('ready','ready');Start-Sleep -Seconds 60",
        ]);
        command.current_dir(&candidate);
        let mut child = job.spawn(&mut command).unwrap();
        let ready = candidate.join("ready");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !ready.exists() && std::time::Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        if !ready.exists() {
            let _ = job.terminate_and_wait();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&root);
            panic!("The candidate test process did not acquire its file.");
        }

        let rename_while_open = fs::rename(&candidate, &release);
        let process_cleanup = job.terminate_and_wait();
        drop(job);
        let child_status = child.wait().unwrap();
        if candidate.exists() {
            fs::rename(&candidate, &release).unwrap();
        }
        fs::remove_dir_all(&root).unwrap();

        assert!(
            rename_while_open.is_err(),
            "Windows should block activation while a candidate file is open."
        );
        process_cleanup.unwrap();
        assert!(child_status.code().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn candidate_activation_retries_temporary_file_locks() {
        use std::os::windows::fs::OpenOptionsExt;

        let root =
            std::env::temp_dir().join(format!("ngt-manager-activation-retry-{}", unique_id()));
        let candidate = root.join(".candidate");
        let release = root.join("v2.0.23");
        fs::create_dir_all(&candidate).unwrap();
        let held_path = candidate.join("held-open.bin");
        fs::write(&held_path, b"candidate file").unwrap();
        let held_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&held_path)
            .unwrap();
        let release_lock = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            drop(held_file);
        });

        let started = std::time::Instant::now();
        let activation = activate_candidate(&candidate, &release);
        let elapsed = started.elapsed();
        release_lock.join().unwrap();

        assert!(activation.is_ok(), "activation failed: {activation:?}");
        assert!(elapsed >= Duration::from_millis(200));
        assert!(release.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    fn create_test_install(version: &str) -> PathBuf {
        use sha2::{Digest, Sha256};

        let root = std::env::temp_dir().join(format!("ngt-manager-test-install-{}", unique_id()));
        let release = root.join("releases").join(format!("v{version}"));
        fs::create_dir_all(&release).unwrap();
        let file_contents = b"test release";
        fs::write(release.join("application.bin"), file_contents).unwrap();
        let manifest = ReleaseManifest {
            version: version.to_owned(),
            commit: "a".repeat(40),
            files: [(
                "application.bin".to_owned(),
                format!("{:x}", Sha256::digest(file_contents)),
            )]
            .into_iter()
            .collect(),
        };
        fs::write(
            release.join("studio-release.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let config = ManagerConfig {
            format_version: CONFIG_VERSION,
            install_root: root.clone(),
            active_release: release,
            data_root: root.join("data"),
            version: version.to_owned(),
            repository: "JayWangsj/ngt1".to_owned(),
            maintenance: false,
        };
        write_config(&root, &config).unwrap();
        root
    }

    #[test]
    fn streamed_release_copy_hashes_the_bytes_it_writes() {
        let root = std::env::temp_dir().join(format!("ngt-stream-copy-{}", unique_id()));
        let source = root.join("source.bin");
        let destination = root.join("destination.bin");
        fs::create_dir_all(&root).unwrap();
        let contents = vec![0x5a; 2 * 1024 * 1024 + 17];
        fs::write(&source, &contents).unwrap();
        let expected = format!("{:x}", Sha256::digest(&contents));
        let progress = InstallProgress::new("stream-copy-test");

        assert_eq!(
            copy_release_file(
                &source,
                &destination,
                "source.bin",
                &expected,
                &progress,
                0,
                0,
            )
            .unwrap(),
            contents.len() as u64
        );
        assert_eq!(fs::read(&destination).unwrap(), contents);

        let mismatched = root.join("mismatched.bin");
        assert!(copy_release_file(
            &source,
            &mismatched,
            "source.bin",
            &"0".repeat(64),
            &progress,
            0,
            0,
        )
        .unwrap_err()
        .contains("changed while it was being deployed"));
        progress.finish("complete");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn work_area_changes_do_not_resize_a_minimized_restore_placement() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_OVERLAPPEDWINDOW,
                20,
                20,
                400,
                240,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!window.is_null());
            let mut before: WINDOWPLACEMENT = std::mem::zeroed();
            before.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            assert_ne!(GetWindowPlacement(window, &mut before), 0);
            ShowWindow(window, SW_MINIMIZE);
            let mut minimized = std::mem::zeroed();
            GetWindowRect(window, &mut minimized);
            fit_runtime_ui_to_work_area(window, minimized);
            let mut after: WINDOWPLACEMENT = std::mem::zeroed();
            after.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            assert_ne!(GetWindowPlacement(window, &mut after), 0);
            let still_minimized = IsIconic(window) != 0;
            DestroyWindow(window);
            let rect = |r: windows_sys::Win32::Foundation::RECT| (r.left, r.top, r.right, r.bottom);
            assert!(still_minimized);
            assert_eq!(rect(before.rcNormalPosition), rect(after.rcNormalPosition));
        }
    }

    #[test]
    #[cfg(windows)]
    fn compact_startup_layout_fits_normalized_resolution_and_dpi_matrix() {
        for (w, h) in [(1024, 768), (1280, 720), (1366, 768), (1920, 1080)] {
            for dpi in [96u32, 144, 192] {
                let outer_w = (600 * dpi as i32 / 96).min(w * 7 / 10);
                let outer_h = (260 * dpi as i32 / 96).min((h - 40 * dpi as i32 / 96) * 6 / 10);
                let width = outer_w - 16 * dpi as i32 / 96;
                let height = outer_h - 40 * dpi as i32 / 96;
                let l = runtime_ui_layout(width, height, dpi);
                for rect in [
                    l.title, l.version, l.heading, l.status, l.elapsed, l.progress, l.step, l.logo,
                ] {
                    assert!(
                        rect.left >= 0
                            && rect.top >= 0
                            && rect.right <= width
                            && rect.bottom <= height,
                        "layout outside {w}x{h} at {dpi}: {} {} {} {}",
                        rect.left,
                        rect.top,
                        rect.right,
                        rect.bottom
                    );
                }
                assert!(l.heading.top >= l.logo.bottom);
                assert!(
                    l.status.bottom <= l.elapsed.top,
                    "status overlaps elapsed for {w}x{h} at {dpi}"
                );
                assert!(l.heading.top >= l.version.bottom);
                assert!(l.elapsed.bottom <= l.progress.top);
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn native_logo_composites_transparent_corners_onto_the_parent_surface() {
        use windows_sys::Win32::Graphics::Gdi::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        unsafe {
            let icon_path: Vec<u16> = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../assets/ngt-studio-light.ico")
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let icon = LoadImageW(
                std::ptr::null_mut(),
                icon_path.as_ptr(),
                IMAGE_ICON,
                48,
                48,
                LR_LOADFROMFILE,
            ) as HICON;
            assert!(!icon.is_null());
            assert_eq!(RUNTIME_UI_LOGO.swap(icon as isize, Ordering::SeqCst), 0);
            let screen = GetDC(std::ptr::null_mut());
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, 600, 228);
            let previous = SelectObject(dc, bitmap as _);
            let rect = windows_sys::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: 600,
                bottom: 228,
            };
            paint_runtime_ui_background(dc, &rect);
            let logo = runtime_ui_layout(600, 228, 96).logo;
            let corners = [
                (logo.left, logo.top),
                (logo.right - 1, logo.top),
                (logo.left, logo.bottom - 1),
                (logo.right - 1, logo.bottom - 1),
            ]
            .map(|(x, y)| GetPixel(dc, x, y));
            let yellow = GetPixel(dc, (logo.left + logo.right) / 2, logo.top + 2);
            SelectObject(dc, previous);
            DeleteObject(bitmap as _);
            DeleteDC(dc);
            ReleaseDC(std::ptr::null_mut(), screen);
            RUNTIME_UI_LOGO.store(0, Ordering::SeqCst);
            DestroyIcon(icon);
            assert_eq!(
                corners, [0x00f7fafb; 4],
                "the transparent logo corners must show the warm parent background"
            );
            assert_eq!(yellow, 0x002dc6f4);
        }
    }

    #[cfg(windows)]
    unsafe fn capture_runtime_ui_fixture(window: windows_sys::Win32::Foundation::HWND, name: &str) {
        use windows_sys::Win32::Graphics::Gdi::*;
        #[link(name = "user32")]
        extern "system" {
            fn PrintWindow(
                window: windows_sys::Win32::Foundation::HWND,
                dc: HDC,
                flags: u32,
            ) -> i32;
        }
        let mut rect = std::mem::zeroed();
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(window, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let screen = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(dc, bitmap as _);
        RedrawWindow(
            window,
            std::ptr::null(),
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN,
        );
        let printed = PrintWindow(window, dc, 2);
        SelectObject(dc, previous);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = 40;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(
            screen,
            bitmap,
            0,
            height as u32,
            pixels.as_mut_ptr() as _,
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteObject(bitmap as _);
        DeleteDC(dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        assert_ne!(printed, 0);
        assert_eq!(rows, height);
        for pixel in pixels.as_chunks_mut::<4>().0 {
            pixel[3] = 255;
        }
        let mut bytes = vec![0u8; 54];
        bytes[0..2].copy_from_slice(b"BM");
        bytes[2..6].copy_from_slice(&(54 + pixels.len() as u32).to_le_bytes());
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..54].copy_from_slice(std::slice::from_raw_parts(
            &info.bmiHeader as *const _ as *const u8,
            40,
        ));
        bytes.extend_from_slice(&pixels);
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/native-ui-review");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(name), bytes).unwrap();
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "opens a real Chromium application window against a disposable local HTTP fixture"]
    fn real_chromium_starts_only_after_startup_hidden_and_closes_owned_window() {
        use std::net::TcpListener;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IsWindow, IsWindowVisible, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_CLOSE,
        };
        assert!(
            !browser_candidates().is_empty(),
            "Chrome or Edge is required"
        );
        let root = create_test_install("2.0.25");
        fs::create_dir_all(root.join("assets")).unwrap();
        for name in [
            "ngt-studio.ico",
            "ngt-studio-light.ico",
            "ngt-studio-dark.ico",
        ] {
            fs::copy(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../assets")
                    .join(name),
                root.join("assets").join(name),
            )
            .unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server = thread::spawn(move || {
            while !server_stop.load(Ordering::SeqCst) {
                if let Ok((mut stream, _)) = listener.accept() {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let mut buffer = [0; 4096];
                    let _ = stream.read(&mut buffer);
                    let body =
                        "<!doctype html><title>NGTManager fixture</title><h1>NGTManager</h1>";
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                } else {
                    thread::sleep(Duration::from_millis(10));
                }
            }
        });
        let before_regular = top_level_windows().into_iter().collect::<BTreeSet<_>>();
        let mut ordinary_child = Command::new(&browser_candidates()[0])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .args(["--new-window", "--no-first-run", &url])
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let regular = loop {
            if let Some(window) = top_level_windows().into_iter().find(|window| {
                !before_regular.contains(window)
                    && is_chromium_application_window(*window)
                    && browser_window_title_matches(*window)
            }) {
                break window;
            }
            assert!(
                Instant::now() < deadline,
                "ordinary browser fixture did not appear"
            );
            thread::sleep(Duration::from_millis(50));
        };
        let (_, regular_pid, regular_created) = browser_window_process_identity(regular).unwrap();
        let notifier = SessionEndNotifier::start(&root, true).unwrap();
        unsafe {
            let window =
                RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as windows_sys::Win32::Foundation::HWND;
            let mut bounds = std::mem::zeroed();
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(window, &mut bounds);
            capture_runtime_ui_fixture(window, "startup-standard.bmp");
            let dpi = windows_sys::Win32::UI::HiDpi::GetDpiForWindow(window).max(96) as i32;
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
                window,
                std::ptr::null_mut(),
                0,
                0,
                380 * dpi / 96,
                218 * dpi / 96,
                windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
                    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE,
            );
            thread::sleep(Duration::from_millis(80));
            capture_runtime_ui_fixture(window, "startup-compact.bmp");
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
                window,
                std::ptr::null_mut(),
                bounds.left,
                bounds.top,
                bounds.right - bounds.left,
                bounds.bottom - bounds.top,
                windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
                    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE,
            );
            thread::sleep(Duration::from_millis(80));
        }
        assert!(
            launch_managed_browser(&url).is_err(),
            "browser creation must be rejected while startup is visible"
        );
        let completed = complete_and_hide_runtime_ui();
        let startup_hidden =
            unsafe { IsWindowVisible(RUNTIME_UI_WINDOW.load(Ordering::SeqCst) as _) } == 0;
        let outcome = launch_managed_browser(&url);
        let window = match outcome.unwrap() {
            BrowserLaunchOutcome::Managed(window) => window,
            BrowserLaunchOutcome::LaunchedUnconfirmed => panic!("real browser was not identified"),
        };
        let displayed_once =
            !browser_window_is_held(window) && !hidden_browser_record_path().unwrap().exists();
        let _ = show_managed_browser_window(window);
        let mut same = find_managed_browser_window() == Some(window);
        for _ in 0..3 {
            assert!(queue_browser_open(None));
            let deadline = Instant::now() + Duration::from_secs(3);
            while BROWSER_OPENING.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            same &= !BROWSER_OPENING.load(Ordering::SeqCst)
                && find_managed_browser_window() == Some(window);
        }
        let held_again = hold_browser_until_ready(window);
        recover_hidden_browser();
        let recovered =
            !browser_window_is_held(window) && !hidden_browser_record_path().unwrap().exists();
        // Simulate the user's application X before reopening through the shared path.
        let mut close_result = 0;
        unsafe {
            SendMessageTimeoutW(
                window as _,
                WM_CLOSE,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1000,
                &mut close_result,
            );
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while unsafe { IsWindow(window as _) } != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let manual_closed = find_managed_browser_window().is_none()
            && !BROWSER_WINDOW_EXPECTED.load(Ordering::SeqCst);
        let reopened = match launch_managed_browser(&url).unwrap() {
            BrowserLaunchOutcome::Managed(window) => {
                complete_and_hide_runtime_ui() && {
                    let _ = show_managed_browser_window(window);
                    true
                }
            }
            _ => false,
        };
        let closed = close_managed_browser_window(&root);
        let regular_untouched =
            browser_window_matches_identity(regular, regular_pid, regular_created)
                && unsafe { IsWindowVisible(regular as _) } != 0;
        if regular_untouched {
            unsafe {
                SendMessageTimeoutW(
                    regular as _,
                    WM_CLOSE,
                    0,
                    0,
                    SMTO_ABORTIFHUNG,
                    1000,
                    &mut close_result,
                );
            }
        }
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
        let _ = ordinary_child.try_wait();
        drop(notifier);
        let _ = fs::remove_dir_all(root);
        assert!(
            displayed_once,
            "normal browser creation must not cloak or move the window off-screen"
        );
        assert!(
            completed && startup_hidden,
            "startup window did not synchronously disappear"
        );
        assert!(same, "the confirmed window was not reusable");
        assert!(
            held_again && recovered,
            "persisted hidden-window recovery failed"
        );
        assert!(manual_closed && reopened, "manual close and reopen failed");
        assert!(regular_untouched, "an ordinary browser window was affected");
        assert!(closed, "the owned browser window did not close");
    }

    #[test]
    #[cfg(windows)]
    fn browser_file_identity_accepts_windows_path_aliases_and_rejects_other_files() {
        let root = std::env::temp_dir().join(format!("ngt-browser-identity-{}", unique_id()));
        fs::create_dir_all(root.join("Chrome/Application")).unwrap();
        let exe = root.join("Chrome/Application/chrome.exe");
        fs::write(&exe, b"fixture").unwrap();
        let native = PathBuf::from(exe.to_string_lossy().replace('/', "\\"));
        let upper = PathBuf::from(native.to_string_lossy().to_uppercase());
        assert!(browser_executable_matches(&exe, &native));
        assert!(browser_executable_matches(&native, &upper));
        let alias = root.join("alias.exe");
        fs::hard_link(&exe, &alias).unwrap();
        assert!(browser_executable_matches(&native, &alias));
        let other = root.join("other.exe");
        fs::write(&other, b"fixture").unwrap();
        assert!(!browser_executable_matches(&native, &other));
        assert!(!browser_executable_matches(
            &native,
            &root.join("missing.exe")
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn a_missing_ownership_property_is_not_proof_that_a_window_closed() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -32000,
                -32000,
                8,
                8,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!window.is_null());
        let (_, pid, created) = browser_window_process_identity(window as _).unwrap();
        let was_alive = !browser_window_was_destroyed(window as _, pid, created);
        unsafe {
            DestroyWindow(window);
        }
        assert!(
            was_alive,
            "an unmarked live HWND was mistaken for a closed window"
        );
        assert!(browser_window_was_destroyed(window as _, pid, created));
    }

    #[test]
    #[cfg(windows)]
    fn unconfirmed_browser_request_survives_an_empty_window_scan() {
        assert_eq!(PROVISIONAL_BROWSER_WINDOW.load(Ordering::SeqCst), 0);
        assert_eq!(MANAGED_BROWSER_WINDOW.load(Ordering::SeqCst), 0);
        BROWSER_WINDOW_EXPECTED.store(true, Ordering::SeqCst);
        let _ = find_managed_browser_window();
        let expected = BROWSER_WINDOW_EXPECTED.swap(false, Ordering::SeqCst);
        assert!(
            expected,
            "absence of a candidate is not evidence of a closed window"
        );
    }

    #[test]
    fn full_verification_reports_file_totals_and_read_bytes() {
        let root = create_test_install("1.2.3");
        let release = root.join("releases/v1.2.3");
        let progress = InstallProgress::new("verification-progress-test");
        verify_release_with_progress(&release, Some(&progress)).unwrap();
        {
            let state = progress.phase.lock().unwrap();
            assert_eq!(state.total_item_count, Some(1));
            assert_eq!(state.item_count, Some(1));
            assert_eq!(state.bytes, Some(b"test release".len() as u64));
        }
        drop(progress);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn daily_startup_verifies_required_files_without_hashing_unrelated_files() {
        let root = std::env::temp_dir().join(format!("ngt-startup-verify-{}", unique_id()));
        fs::create_dir_all(&root).unwrap();
        let mut files = BTreeMap::new();
        for relative in REQUIRED_RUNTIME_FILES {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let contents = format!("required:{relative}");
            fs::write(&path, contents.as_bytes()).unwrap();
            files.insert(
                relative.to_owned(),
                format!("{:x}", Sha256::digest(contents.as_bytes())),
            );
        }
        let unrelated = "application/noncritical.txt";
        let unrelated_path = root.join(unrelated);
        fs::create_dir_all(unrelated_path.parent().unwrap()).unwrap();
        fs::write(&unrelated_path, b"original").unwrap();
        files.insert(
            unrelated.to_owned(),
            format!("{:x}", Sha256::digest(b"original")),
        );
        let manifest = ReleaseManifest {
            version: "2.0.25".to_owned(),
            commit: "a".repeat(40),
            files,
        };
        fs::write(
            root.join("studio-release.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        verify_release_for_startup(&root, "2.0.25").unwrap();
        fs::write(&unrelated_path, b"changed").unwrap();
        verify_release_for_startup(&root, "2.0.25").unwrap();
        let required = root.join(REQUIRED_RUNTIME_FILES[0]);
        fs::write(required, b"changed").unwrap();
        assert!(verify_release_for_startup(&root, "2.0.25")
            .unwrap_err()
            .contains("integrity verification"));

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn startup_handoff_requires_owner_and_hides_a_real_win32_window() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        assert_eq!(RUNTIME_UI_WINDOW.load(Ordering::SeqCst), 0);
        assert!(!complete_and_hide_runtime_ui());
        let (sender, receiver) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || unsafe {
            let instance =
                windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let class_name: Vec<u16> = format!("NGTManager.HandoffTest.{}", unique_id())
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut class: WNDCLASSW = std::mem::zeroed();
            class.lpfnWndProc = Some(session_end_window_proc);
            class.hInstance = instance;
            class.lpszClassName = class_name.as_ptr();
            assert_ne!(RegisterClassW(&class), 0);
            let window = CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_POPUP | WS_VISIBLE,
                -32000,
                -32000,
                16,
                16,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            assert!(!window.is_null());
            sender
                .send((
                    window as isize,
                    windows_sys::Win32::System::Threading::GetCurrentThreadId(),
                ))
                .unwrap();
            let mut message = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            DestroyWindow(window);
            UnregisterClassW(class_name.as_ptr(), instance);
        });
        let (window, thread_id) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let previous_healthy = RUNTIME_HEALTHY.load(Ordering::SeqCst);
        RUNTIME_UI_WINDOW.store(window, Ordering::SeqCst);
        assert_ne!(unsafe { IsWindowVisible(window as _) }, 0);
        update_runtime_ui_phase(RUNTIME_UI_PHASE_HEALTH);
        let completed = complete_and_hide_runtime_ui();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(
                window as _,
                RUNTIME_UI_SHOW_MESSAGE,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1_000,
                &mut result,
            )
        };
        let hidden = unsafe { IsWindowVisible(window as _) } == 0;
        RUNTIME_UI_WINDOW.store(0, Ordering::SeqCst);
        unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) };
        owner.join().unwrap();
        RUNTIME_HEALTHY.store(previous_healthy, Ordering::SeqCst);
        assert!(
            completed,
            "startup handoff was not acknowledged by the owner thread"
        );
        assert!(hidden, "startup window remained visible after the handoff");
    }

    #[cfg(windows)]
    #[test]
    fn runtime_open_request_crosses_processes_to_the_window_owner() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        const CHILD_TARGET: &str = "NGT_TEST_UI_TARGET";
        if let Ok(class_name) = std::env::var(CHILD_TARGET) {
            assert!(signal_runtime_ui_class(
                &class_name,
                RUNTIME_UI_OPEN_MESSAGE
            ));
            return;
        }
        static REQUESTS: AtomicU64 = AtomicU64::new(0);
        unsafe extern "system" fn owner_proc(
            window: windows_sys::Win32::Foundation::HWND,
            message: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize {
            if message == RUNTIME_UI_OPEN_MESSAGE {
                REQUESTS.fetch_add(1, Ordering::SeqCst);
                return 0;
            }
            DefWindowProcW(window, message, wparam, lparam)
        }
        let class_name = format!("NGTManager.OpenRequestTest.{}", unique_id());
        let owner_class = class_name.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let owner = std::thread::spawn(move || unsafe {
            let instance =
                windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
            let wide: Vec<u16> = owner_class.encode_utf16().chain(Some(0)).collect();
            let mut class: WNDCLASSW = std::mem::zeroed();
            class.lpfnWndProc = Some(owner_proc);
            class.hInstance = instance;
            class.lpszClassName = wide.as_ptr();
            assert_ne!(RegisterClassW(&class), 0);
            let window = CreateWindowExW(
                0,
                wide.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -32000,
                -32000,
                16,
                16,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            assert!(!window.is_null());
            sender
                .send(windows_sys::Win32::System::Threading::GetCurrentThreadId())
                .unwrap();
            let mut message = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            DestroyWindow(window);
            UnregisterClassW(wide.as_ptr(), instance);
        });
        let thread_id = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "manager::tests::runtime_open_request_crosses_processes_to_the_window_owner",
                "--nocapture",
            ])
            .env(CHILD_TARGET, class_name)
            .output()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while REQUESTS.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) };
        owner.join().unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(REQUESTS.load(Ordering::SeqCst), 1);
    }

    #[cfg(windows)]
    #[test]
    fn startup_window_progress_uses_locked_real_stage_percentages() {
        assert_eq!(runtime_ui_phase_progress(RUNTIME_UI_PHASE_CHECKING), 10);
        assert_eq!(runtime_ui_phase_progress(RUNTIME_UI_PHASE_DATABASE), 35);
        assert_eq!(runtime_ui_phase_progress(RUNTIME_UI_PHASE_APPLICATION), 65);
        assert_eq!(runtime_ui_phase_progress(RUNTIME_UI_PHASE_HEALTH), 85);
        assert_eq!(runtime_ui_phase_progress(RUNTIME_UI_PHASE_READY), 100);
    }

    #[cfg(windows)]
    #[test]
    fn retrying_verified_restore_preserves_original_database() {
        let root = std::env::temp_dir().join(format!("ngt-manager-restore-{}", unique_id()));
        let data_root = root.join("data");
        let data = data_root.join("postgres");
        let operation_id = "restore-test";
        let backup_root = root.join("backups").join(operation_id);
        let backup = backup_root.join("database");
        let staging = data_root.join("postgres-restoring-restore-test");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&backup).unwrap();
        for path in [&backup, &staging] {
            fs::create_dir_all(path.join("base")).unwrap();
            fs::create_dir_all(path.join("global")).unwrap();
            fs::create_dir_all(path.join("pg_wal")).unwrap();
            fs::write(path.join("PG_VERSION"), "17").unwrap();
            fs::write(path.join("global/pg_control"), "control").unwrap();
        }
        fs::write(data.join("PG_VERSION"), "original").unwrap();
        let mut transaction = create_transaction(
            &root,
            Operation::Update,
            operation_id.into(),
            None,
            PostgresDirectoryState::Initialized,
        )
        .unwrap();
        transaction.restore_verified = true;
        let preserved = data_root.join("postgres-interrupted-restore-test");
        fs::rename(&data, &preserved).unwrap();
        for _ in 0..2 {
            restore_database(&root, &backup_root, &mut transaction).unwrap();
            assert_eq!(fs::read_to_string(data.join("PG_VERSION")).unwrap(), "17");
            assert_eq!(
                fs::read_to_string(preserved.join("PG_VERSION")).unwrap(),
                "original"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn candidate_abandonment_rejects_database_changes_and_foreign_markers() {
        let root = std::env::temp_dir().join(format!("ngt-manager-abandon-{}", unique_id()));
        let mut transaction = create_transaction(
            &root,
            Operation::Install,
            "candidate-test".into(),
            None,
            PostgresDirectoryState::Missing,
        )
        .unwrap();
        assert!(can_abandon_candidate(&root, &transaction).unwrap());
        transaction.migration_started = true;
        assert!(!can_abandon_candidate(&root, &transaction).unwrap());
        write_maintenance(&root, "candidate-test", true).unwrap();
        assert!(write_maintenance(&root, "different-task", false).is_err());
        assert!(write_maintenance(&root, "different-task", true).is_err());
        write_maintenance(&root, "candidate-test", false).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_path_traversal_in_release_inventory() {
        let root = std::env::temp_dir().join(format!("ngt-manager-unsafe-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let manifest = ReleaseManifest {
            version: "2.0.22".to_owned(),
            commit: "a".repeat(40),
            files: [("../outside.exe".to_owned(), "b".repeat(64))]
                .into_iter()
                .collect(),
        };
        let mut manifest_bytes = vec![0xEF, 0xBB, 0xBF];
        manifest_bytes.extend(serde_json::to_vec(&manifest).unwrap());
        fs::write(root.join("studio-release.json"), manifest_bytes).unwrap();
        assert!(verify_release(&root)
            .unwrap_err()
            .contains("unsafe or duplicate path"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_missing_release_files_before_installation() {
        let root = std::env::temp_dir().join(format!("ngt-manager-missing-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let manifest = ReleaseManifest {
            version: "2.0.22".to_owned(),
            commit: "a".repeat(40),
            files: [("runtime/node.exe".to_owned(), "b".repeat(64))]
                .into_iter()
                .collect(),
        };
        fs::write(
            root.join("studio-release.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(verify_release(&root)
            .unwrap_err()
            .contains("file is missing"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transaction_advances_only_through_safe_stages() {
        assert!(valid_transition(&Stage::Preparing, &Stage::Staged));
        assert!(valid_transition(&Stage::Preparing, &Stage::Uninstalling));
        assert!(valid_transition(&Stage::Uninstalling, &Stage::Committed));
        assert!(!valid_transition(&Stage::Preparing, &Stage::Committed));
        assert!(valid_transition(&Stage::Preparing, &Stage::Failed));
        assert!(!terminal(&Stage::Failed));
        assert!(terminal(&Stage::Committed));
    }

    #[test]
    fn disk_preflight_counts_backup_and_verification_copies() {
        assert_eq!(required_space(10, 20), 10 + 60 + 512 * 1024 * 1024);
        assert_eq!(required_space(u64::MAX, 1), u64::MAX);
    }

    #[test]
    fn stopped_postgres_does_not_block_runtime_recovery() {
        assert!(pg_ctl_status(Some(0)).unwrap());
        assert!(!pg_ctl_status(Some(3)).unwrap());
        assert!(pg_ctl_status(Some(1)).is_err());
        assert!(pg_ctl_status(None).is_err());
    }

    #[test]
    fn existing_database_requires_valid_local_credentials() {
        let root = std::env::temp_dir().join(format!("ngt-manager-secrets-{}", unique_id()));
        fs::create_dir_all(&root).unwrap();
        assert!(validate_database_credentials(&root).is_err());
        fs::write(root.join("local-secrets.json"), b"{}").unwrap();
        assert!(validate_database_credentials(&root).is_err());
        fs::write(
            root.join("local-secrets.json"),
            serde_json::json!({
                "password": "a".repeat(48),
                "authSecret": "b".repeat(64),
            })
            .to_string(),
        )
        .unwrap();
        assert!(validate_database_credentials(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_first_install_removes_only_its_database_directories() {
        let root = std::env::temp_dir().join(format!("ngt-manager-initial-db-{}", unique_id()));
        let data = root.join("data");
        let operation_id = "owned-123";
        let initializing = data.join(format!("postgres.initializing-{operation_id}"));
        fs::create_dir_all(data.join("postgres/base")).unwrap();
        fs::write(data.join("postgres/PG_VERSION"), "17").unwrap();
        fs::write(data.join("postgres/.ngt-install-owner"), operation_id).unwrap();
        fs::create_dir_all(initializing.join("base")).unwrap();
        fs::create_dir_all(data.join("postgres-interrupted-user-data")).unwrap();
        fs::write(data.join("local-secrets.json"), b"{}").unwrap();
        let transaction = Transaction {
            format_version: TRANSACTION_VERSION,
            operation_id: operation_id.to_owned(),
            operation: Operation::Install,
            stage: Stage::RollingBack,
            previous_release: None,
            candidate_release: None,
            backup_root: None,
            previous_config: None,
            migration_started: true,
            database_was_present: false,
            database_directory_was_empty: true,
            database_initialization_directory: Some(initializing.clone()),
            database_initialization_owned: true,
            database_initialization_published: true,
            failure: None,
            restore_verified: false,
        };
        cleanup_initial_database(&root, &transaction).unwrap();
        assert!(data.join("postgres").is_dir());
        assert_eq!(fs::read_dir(data.join("postgres")).unwrap().count(), 0);
        assert!(!initializing.exists());
        assert!(data.join("postgres-interrupted-user-data").exists());
        assert!(data.join("local-secrets.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn postgres_directory_inspection_distinguishes_missing_empty_and_incomplete() {
        let root = std::env::temp_dir().join(format!("ngt-manager-postgres-state-{}", unique_id()));
        let database = root.join("postgres");
        assert_eq!(
            inspect_postgres_directory(&database).unwrap(),
            PostgresDirectoryState::Missing
        );
        fs::create_dir_all(&database).unwrap();
        assert_eq!(
            inspect_postgres_directory(&database).unwrap(),
            PostgresDirectoryState::Empty
        );
        fs::write(database.join(".hidden"), "partial").unwrap();
        assert!(inspect_postgres_directory(&database)
            .unwrap_err()
            .contains("incomplete"));
        fs::remove_file(database.join(".hidden")).unwrap();
        fs::write(database.join("PG_VERSION"), "17").unwrap();
        assert_eq!(
            inspect_postgres_directory(&database).unwrap(),
            PostgresDirectoryState::Initialized
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_install_rollback_preserves_empty_or_unowned_database_paths() {
        let root = std::env::temp_dir().join(format!("ngt-manager-unowned-db-{}", unique_id()));
        let data = root.join("data");
        let database = data.join("postgres");
        fs::create_dir_all(&database).unwrap();
        let transaction = Transaction {
            format_version: TRANSACTION_VERSION,
            operation_id: "cancelled-install".to_owned(),
            operation: Operation::Install,
            stage: Stage::RollingBack,
            previous_release: None,
            candidate_release: None,
            backup_root: None,
            previous_config: None,
            migration_started: true,
            database_was_present: false,
            database_directory_was_empty: true,
            database_initialization_directory: None,
            database_initialization_owned: false,
            database_initialization_published: false,
            failure: None,
            restore_verified: false,
        };
        cleanup_initial_database(&root, &transaction).unwrap();
        assert_eq!(fs::read_dir(&database).unwrap().count(), 0);

        fs::write(database.join("PG_VERSION"), "17").unwrap();
        assert!(cleanup_initial_database(&root, &transaction).is_err());
        assert_eq!(
            fs::read_to_string(database.join("PG_VERSION")).unwrap(),
            "17"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_recovery_respects_the_exclusive_operation_lock() {
        let root = std::env::temp_dir().join(format!("ngt-manager-run-lock-{}", unique_id()));
        fs::create_dir_all(&root).unwrap();
        let held = lock_state(&root).unwrap();
        assert!(recover_runtime_before_start(&root)
            .unwrap_err()
            .contains("Another NGTManager operation is already running"));
        drop(held);
        assert!(recover_runtime_before_start(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn initial_install_initializes_missing_and_empty_database_directories() {
        let mut transaction = Transaction {
            format_version: TRANSACTION_VERSION,
            operation_id: "test".to_owned(),
            operation: Operation::Install,
            stage: Stage::Preparing,
            previous_release: None,
            candidate_release: None,
            backup_root: None,
            previous_config: None,
            migration_started: false,
            database_was_present: false,
            database_directory_was_empty: false,
            database_initialization_directory: None,
            database_initialization_owned: false,
            database_initialization_published: false,
            failure: None,
            restore_verified: false,
        };
        assert!(should_initialize_database(&transaction));
        transaction.database_directory_was_empty = true;
        assert!(should_initialize_database(&transaction));
        transaction.database_was_present = true;
        assert!(!should_initialize_database(&transaction));
        transaction.database_was_present = false;
        transaction.operation = Operation::Update;
        assert!(!should_initialize_database(&transaction));
    }

    #[test]
    fn initial_install_cleanup_requires_a_database_free_preinstall_state() {
        let mut transaction = Transaction {
            format_version: TRANSACTION_VERSION,
            operation_id: "test".to_owned(),
            operation: Operation::Install,
            stage: Stage::RollingBack,
            previous_release: None,
            candidate_release: None,
            backup_root: None,
            previous_config: None,
            migration_started: true,
            database_was_present: false,
            database_directory_was_empty: false,
            database_initialization_directory: None,
            database_initialization_owned: false,
            database_initialization_published: false,
            failure: None,
            restore_verified: false,
        };
        assert!(should_remove_initial_database(&transaction));
        transaction.database_was_present = true;
        assert!(!should_remove_initial_database(&transaction));
    }

    #[test]
    fn failure_text_is_a_code_not_an_arbitrary_secret_bearing_message() {
        let valid = "missing_component";
        assert!(valid
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'));
        assert!(!"password=secret"
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'));
    }

    #[test]
    fn status_does_not_create_a_runtime_lock() {
        let root = std::env::temp_dir().join(format!("ngt-manager-status-{}", unique_id()));
        fs::create_dir_all(root.join("state")).unwrap();
        let lock = root.join("state/run.lock");
        assert!(!runtime_is_active(&root).unwrap());
        assert!(!lock.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_process_status_uses_the_live_file_lock_not_a_pid() {
        let root = std::env::temp_dir().join(format!("ngt-manager-update-process-{}", unique_id()));
        fs::create_dir_all(root.join("state")).unwrap();
        let update_id = "00000000-0000-4000-8000-000000000001";
        let lease_path = root
            .join("state")
            .join(format!("update-process-{update_id}.lock"));
        assert!(!update_process_active(&root, update_id).unwrap());
        let mut lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lease_path)
            .unwrap();
        lease.try_lock_exclusive().unwrap();
        lease.set_len(0).unwrap();
        lease.write_all(b"reused-pid-is-irrelevant").unwrap();
        lease.sync_all().unwrap();
        assert!(update_process_active(&root, update_id).unwrap());
        drop(lease);
        assert!(!update_process_active(&root, update_id).unwrap());
        assert!(update_process_active(&root, "../outside").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn online_update_reservation_is_atomic_and_versioned() {
        let root = create_test_install("1.0.0");
        let update_id = "00000000-0000-4000-8000-000000000001";
        let result = reserve_online_update(&root, update_id, "1.0.1").unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&result).unwrap()["status"],
            "starting"
        );
        let lock = read_update_value(&update_lock_path(&root)).unwrap();
        let status = read_update_value(&update_status_path(&root)).unwrap();
        assert_eq!(lock["updateId"], update_id);
        assert_eq!(status["updateId"], update_id);
        assert_eq!(status["previousVersion"], "1.0.0");
        assert_eq!(status["targetVersion"], "1.0.1");
        assert!(reserve_online_update(&root, update_id, "1.0.1").is_err());
        assert_eq!(
            read_update_value(&update_lock_path(&root)).unwrap()["updateId"],
            update_id
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_update_lock_is_released_only_for_its_matching_task() {
        let root = create_test_install("1.0.1");
        let update_id = "00000000-0000-4000-8000-000000000001";
        fs::write(
            update_lock_path(&root),
            serde_json::json!({
                "updateId": update_id,
                "targetVersion": "1.0.1",
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            update_status_path(&root),
            serde_json::json!({
                "status": "complete",
                "updateId": update_id,
                "targetVersion": "1.0.1",
            })
            .to_string(),
        )
        .unwrap();
        assert!(
            clear_update_lock(&root, "00000000-0000-4000-8000-000000000002", "complete").is_err()
        );
        assert!(update_lock_path(&root).exists());
        clear_update_lock(&root, update_id, "complete").unwrap();
        assert!(!update_lock_path(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retry_requires_a_pre_mutation_failure_on_the_active_version() {
        let safe = serde_json::json!({
            "status": "interrupted",
            "stage": "downloading",
            "previousVersion": "1.0.1",
        });
        assert!(safe_update_retry(&safe, "1.0.1"));
        assert!(!safe_update_retry(&safe, "1.0.2"));
        let unsafe_stage = serde_json::json!({
            "status": "interrupted",
            "stage": "installing",
            "previousVersion": "1.0.1",
        });
        assert!(!safe_update_retry(&unsafe_stage, "1.0.1"));
    }

    #[test]
    fn diagnostic_snapshot_does_not_include_private_install_paths() {
        let root = std::env::temp_dir().join(format!("ngt-manager-diagnose-{}", unique_id()));
        fs::create_dir_all(root.join("state")).unwrap();
        let output = diagnose_json(&root).unwrap();
        assert!(!output.contains(root.to_string_lossy().as_ref()));
        assert!(output.contains("\"transactionStage\":null"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_rejects_release_paths_outside_the_release_directory() {
        let root = std::env::temp_dir().join(format!("ngt-manager-config-{}", unique_id()));
        fs::create_dir_all(root.join("state")).unwrap();
        let config = ManagerConfig {
            format_version: CONFIG_VERSION,
            install_root: root.clone(),
            active_release: root.join("releases-outside/v2.0.21"),
            data_root: root.join("data"),
            version: "2.0.21".to_owned(),
            repository: "JayWangsj/ngt1".to_owned(),
            maintenance: false,
        };
        fs::write(config_path(&root), serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(read_config(&root)
            .unwrap_err()
            .contains("configuration is invalid"));
        fs::remove_dir_all(root).unwrap();
    }
}
