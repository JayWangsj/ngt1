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
use std::process::{Child, Command, ExitStatus, Stdio};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TRANSACTION_VERSION: u32 = 3;
const CONFIG_VERSION: u32 = 1;
const DATABASE_PORT: u16 = 55432;
const APPLICATION_PORT: u16 = 3000;

#[cfg(windows)]
static WINDOWS_SESSION_END: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static WINDOWS_SESSION_END_TICK: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Serialize, Deserialize)]
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
    let mut expected_paths = BTreeSet::new();
    for (relative, expected_hash) in &manifest.files {
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
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("Unable to read release file {relative}: {error}"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
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

fn lock_state(root: &Path) -> Result<File, String> {
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
        Err(error) if is_lock_contention(&error) => {
            return Err("Another NGTManager operation is already running.".to_owned());
        }
        Err(error) => return Err(format!("Unable to open operation lock: {error}")),
    };
    lock.try_lock_exclusive().map_err(|error| {
        if is_lock_contention(&error) {
            "Another NGTManager operation is already running.".to_owned()
        } else {
            format!("Unable to acquire operation lock: {error}")
        }
    })?;
    Ok(lock)
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

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
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
            copy_directory(&source_path, &destination_path)?;
        } else if entry_metadata.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to copy {}: {error}", source_path.display()))?;
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
) -> Result<ReleaseManifest, String> {
    progress.set_phase("source_copy_verification");
    let manifest = verify_release(source)?;
    progress.set_current_metrics(
        Some(manifest.files.len().min(u32::MAX as usize) as u32),
        None,
    );
    progress.set_phase_with_metrics("candidate_file_copy", None, None);
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create candidate release: {error}"))?;
    let mut copied_bytes = 0u64;
    for relative in manifest.files.keys() {
        let relative_path = Path::new(relative);
        let source_file = source.join(relative_path);
        let destination_file = destination.join(relative_path);
        if let Some(parent) = destination_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create candidate path: {error}"))?;
        }
        let copied = fs::copy(&source_file, &destination_file)
            .map_err(|error| format!("Unable to deploy {relative}: {error}"))?;
        copied_bytes = copied_bytes.saturating_add(copied);
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
    progress.set_phase_with_metrics(
        "candidate_verification",
        Some(manifest.files.len().min(u32::MAX as usize) as u32),
        Some(copied_bytes),
    );
    verify_release(destination)
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
    let manifest = verify_release(source)?;
    let required = [
        "runtime/node.exe",
        "runtime/gh.exe",
        "runtime/postgres/bin/postgres.exe",
        "runtime/postgres/bin/initdb.exe",
        "runtime/postgres/bin/pg_ctl.exe",
        "runtime/postgres/bin/pg_controldata.exe",
        "tools/NGTManager.exe",
        "tools/NGTUpdater.exe",
        "assets/ngt-studio.ico",
        "scripts/windows-db.mjs",
        "scripts/start.mjs",
        "scripts/runtime-start-gate.cjs",
        "scripts/postgres-runtime.mjs",
        "scripts/run-pg-ctl.mjs",
        "node_modules/prisma/build/index.js",
    ];
    if let Some(progress) = progress {
        progress.set_current_metrics(
            Some(manifest.files.len().min(u32::MAX as usize) as u32),
            None,
        );
        progress.set_phase_with_metrics(
            "runtime_dependency_check",
            Some(required.len() as u32),
            None,
        );
    }
    for relative in required {
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
    validate_runtime(source, progress)?;
    if let Some(progress) = progress {
        progress.set_phase("installation_path_check");
    }
    let root = stable_root()?;
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
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 1024 * 1024 {
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

fn record_command_failure(root: &Path, arguments: &[String], message: &str) {
    if let Some(logger) = manager_diagnostics(root) {
        let lower = message.to_ascii_lowercase();
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
        logger.record(component, "error", event_code, phase, &code);
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
impl SessionEndNotifier {
    fn start() -> Result<Self, String> {
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage,
            WNDCLASSW, WS_OVERLAPPED,
        };
        let (sender, receiver) = mpsc::sync_channel::<Result<u32, String>>(1);
        let thread = thread::Builder::new()
            .name("ngt-session-end-notifier".to_owned())
            .spawn(move || unsafe {
                let class_name: Vec<u16> = "NGTManager.SessionEnd"
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let instance =
                    windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null());
                let mut class: WNDCLASSW = std::mem::zeroed();
                class.lpfnWndProc = Some(session_end_window_proc);
                class.hInstance = instance;
                class.lpszClassName = class_name.as_ptr();
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
                    class_name.as_ptr(),
                    WS_OVERLAPPED,
                    0,
                    0,
                    0,
                    0,
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
                let thread_id = GetCurrentThreadId();
                if sender.send(Ok(thread_id)).is_err() {
                    return;
                }
                let mut message = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
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
unsafe extern "system" fn session_end_window_proc(
    window: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, WM_ENDSESSION, WM_QUERYENDSESSION,
    };
    match message {
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
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
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
fn wait_for_runtime_stop(root: &Path) -> Result<File, String> {
    let lock_path = root.join("state").join("run.lock");
    for stop_attempts in 0..180 {
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
                    ensure_previous_runtime_confirmed(root)?;
                    return Ok(lock);
                }
                Err(error) if is_lock_contention(&error) => {}
                Err(error) => return Err(format!("Unable to check the runtime lock: {error}")),
            }
        }
        if stop_attempts % 10 == 0 {
            request_runtime_stop_with_source(root, "maintenance-operation")?;
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("The running application did not stop safely; installation was cancelled.".to_owned())
}

#[cfg(windows)]
fn ensure_previous_runtime_confirmed(root: &Path) -> Result<(), String> {
    let path = root.join("state/runtime/run-state.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ensure_legacy_runtime_confirmed(root)
        }
        Err(_) => {
            return Err(
                "The previous runtime stop state cannot be read; installation was cancelled."
                    .to_owned(),
            )
        }
    };
    let record = serde_json::from_slice::<RuntimeRunRecord>(&bytes).map_err(|_| {
        "The previous runtime stop state is invalid; installation was cancelled.".to_owned()
    })?;
    if matches!(record.phase.as_str(), "completed" | "startup-failed")
        && record.ended_at_utc.is_some()
    {
        Ok(())
    } else {
        Err("The previous runtime shutdown is unconfirmed; start and stop NGTManager normally before installing, updating, repairing, or uninstalling.".to_owned())
    }
}

#[cfg(windows)]
fn ensure_legacy_runtime_confirmed(root: &Path) -> Result<(), String> {
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

    let manifest = verify_release(&release)?;
    if manifest.version != config.version {
        return Err("The legacy runtime version does not match its installation record; installation was cancelled.".to_owned());
    }
    let database = data_root.join("postgres");
    if inspect_postgres_directory(&database)? != PostgresDirectoryState::Initialized {
        return Err(
            "The legacy database is not a complete cluster; installation was cancelled.".to_owned(),
        );
    }

    let temp = ascii_temp_directory()?;
    let mut command = Command::new(release.join("runtime/node.exe"));
    let runner = r#"
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolvePostgresRuntime } from './scripts/postgres-runtime.mjs';
const { runtime } = await resolvePostgresRuntime();
const child = spawn(join(runtime, 'bin', 'pg_controldata.exe'), process.argv.slice(1), { windowsHide: true, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
"#;
    command
        .arg("--input-type=module")
        .arg("-e")
        .arg(runner)
        .arg("--")
        .arg("-D")
        .arg(&database);
    configure_runtime_command(&mut command, &release, root, &temp);
    hide_console(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let job = RuntimeJob::new()?;
    let mut child = job.spawn(&mut command).map_err(|_| {
        "The legacy PostgreSQL control data could not be checked; installation was cancelled."
            .to_owned()
    })?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = match wait_child_until(&mut child, deadline) {
        Ok(Some(exit)) => exit,
        Ok(None) => {
            let _ = job.terminate_and_wait();
            return Err(
                "The legacy PostgreSQL control-data check timed out; installation was cancelled."
                    .to_owned(),
            );
        }
        Err(_) => {
            let _ = job.terminate_and_wait();
            return Err("The legacy PostgreSQL control data could not be checked; installation was cancelled.".to_owned());
        }
    };
    let output = child.wait_with_output().map_err(|_| {
        "The legacy PostgreSQL control data could not be read; installation was cancelled."
            .to_owned()
    })?;
    if !exit.success()
        || !output.status.success()
        || !postgres_cluster_is_clean(&String::from_utf8_lossy(&output.stdout))
    {
        return Err("The legacy PostgreSQL cluster is not confirmed cleanly shut down; installation was cancelled.".to_owned());
    }
    Ok(())
}

fn postgres_cluster_is_clean(output: &str) -> bool {
    output.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, state)| {
            name.trim() == "Database cluster state" && state.trim() == "shut down"
        })
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
    let contents = serde_json::to_vec(record)
        .map_err(|_| "Unable to encode runtime stop state.".to_owned())?;
    atomic_write(&runtime_run_path(root, record), &contents)
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
            let _ = write_runtime_run(root, &record);
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
fn set_autostart(root: &Path, enabled: bool) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    let subkey: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = "NGTManager".encode_utf16().chain(Some(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    let result = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if result != 0 {
        return Err(format!(
            "Unable to register per-user startup: error {result}."
        ));
    }
    let result = if enabled {
        let executable = root.join("tools").join("NGTManager.exe");
        let value = format!("\"{}\" run", executable.display());
        let data: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                (data.len() * 2) as u32,
            )
        }
    } else {
        unsafe { RegDeleteValueW(key, name.as_ptr()) }
    };
    unsafe { RegCloseKey(key) };
    if result != 0 && (enabled || result != 2) {
        return Err(format!(
            "Unable to update per-user startup registration: error {result}."
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_autostart(_root: &Path, _enabled: bool) -> Result<(), String> {
    Err("Per-user startup registration is supported only on Windows x64.".to_owned())
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
    copy_directory(&root.join("data/postgres"), &backup_data)?;
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
    copy_directory(backup_data, &verification)?;
    let log = backup_root.join("verification.log");
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
    let start_status = spawn_pg_ctl(&job, release, root, &start_args)?
        .wait()
        .map_err(|error| format!("Unable to verify the database backup: {error}"))?;
    if !start_status.success() {
        return Err(format!(
            "Database backup verification failed (exit {}).",
            status_code(&start_status)
        ));
    }
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
    let stop_status = spawn_pg_ctl(&job, release, root, &stop_args)?
        .wait()
        .map_err(|error| format!("Unable to stop the verification database: {error}"))?;
    if !stop_status.success() {
        return Err(format!(
            "Verification database did not stop cleanly (exit {}).",
            status_code(&stop_status)
        ));
    }
    drop(job);
    remove_owned_directory(backup_root, &verification)?;
    Ok(())
}

fn restore_database(root: &Path, backup_root: &Path, operation_id: &str) -> Result<(), String> {
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
    let preserved_exists = match fs::symlink_metadata(&preserved) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => true,
        Ok(_) => return Err("The interrupted database copy is not a regular directory.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Unable to inspect the interrupted database copy: {error}"
            ))
        }
    };
    let mut has_preserved_data = preserved_exists;
    match fs::symlink_metadata(&data) {
        Ok(metadata) if metadata.is_dir() && !is_reparse(&metadata) => {
            if preserved_exists {
                remove_owned_directory(&data_root, &data)?;
            } else {
                fs::rename(&data, &preserved).map_err(|error| {
                    format!("Unable to preserve the current database before recovery: {error}")
                })?;
                has_preserved_data = true;
            }
        }
        Ok(_) => return Err("The current database is not a regular directory.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Unable to inspect the current database: {error}")),
    }
    copy_directory(&backup, &data)?;
    if has_preserved_data {
        remove_owned_directory(&data_root, &preserved)?;
    }
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
    stop_sender: mpsc::Sender<()>,
    heartbeat: Option<thread::JoinHandle<()>>,
    finished: Mutex<bool>,
}

struct ProgressPhase {
    name: String,
    started: Instant,
    item_count: Option<u32>,
    bytes: Option<u64>,
}

impl InstallProgress {
    fn new(operation_id: &str) -> Self {
        let operation_id = operation_id.to_owned();
        let cancel_file = INSTALL_CANCEL_FILE.get().cloned().flatten();
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
        }));
        let thread_phase = Arc::clone(&phase);
        let thread_id = operation_id.clone();
        let thread_started = started;
        let thread_cancel_file = cancel_file.clone();
        let (stop_sender, stop_receiver) = mpsc::channel();
        let heartbeat = thread::Builder::new()
            .name("ngt-install-progress".to_owned())
            .spawn(move || loop {
                match stop_receiver.recv_timeout(Duration::from_secs(3)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let (current, phase_elapsed) = {
                            let current = thread_phase
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            (current.name.clone(), current.started.elapsed().as_secs())
                        };
                        let cancel_pending = thread_cancel_file
                            .as_ref()
                            .filter(|path| cancel_file_exists(path, &thread_id))
                            .map_or(0, |_| if current == "commit_release" { 2 } else { 1 });
                        println!(
                            "NGT_PROGRESS|{thread_id}|{current}|{phase_elapsed}|{}|{}",
                            setup_elapsed_ms / 1000 + thread_started.elapsed().as_secs(),
                            cancel_pending
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
        self.transition_phase(
            phase,
            None,
            None,
            "error",
            "installer.phase.failed",
            "INSTALL_PHASE_FAILED",
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
        println!(
            "NGT_PROGRESS|{}|{}|{}|{}|{}",
            self.operation_id,
            phase,
            phase_elapsed,
            self.setup_elapsed_ms / 1000 + self.started.elapsed().as_secs(),
            self.cancel_status()
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
                .and_then(|active| verify_release(source).map(|candidate| (active, candidate)))
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
        if let Some(config) = previous_config.as_ref() {
            let active = verify_release(&config.active_release)?;
            let candidate = verify_release(source)?;
            if active.version == candidate.version
                && active.commit == candidate.commit
                && active.files == candidate.files
            {
                set_autostart(&root, true)?;
                drop(_operation_lock);
                if !runtime_is_active(&root)? {
                    launch_manager(&root, "run")?;
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
    let mut stage_created = false;
    let result = (|| {
        progress.set_phase_with_metrics("deploy_candidate", None, Some(preflight.package_bytes));
        fs::create_dir_all(root.join("releases"))
            .map_err(|error| format!("Unable to create releases directory: {error}"))?;
        transaction.candidate_release = Some(candidate_stage.clone());
        write_transaction(&root, &transaction)?;
        stage_created = true;
        let manifest = copy_release(source, &candidate_stage, &progress)?;
        progress.set_current_metrics(
            Some(manifest.files.len().min(u32::MAX as usize) as u32),
            Some(preflight.package_bytes),
        );
        advance_transaction(&root, &mut transaction, Stage::Staged)?;
        progress.check_cancel()?;

        progress.set_phase("stop_runtime");
        let _runtime_lock = wait_for_runtime_stop(&root)?;
        progress.check_cancel()?;
        ensure_port_available(APPLICATION_PORT)?;
        ensure_port_available(DATABASE_PORT)?;
        if let Some(config) = previous_config.as_ref() {
            let mut maintenance = config.clone();
            maintenance.maintenance = true;
            write_config(&root, &maintenance)?;
        }
        write_maintenance(&root, &id, true)?;
        advance_transaction(&root, &mut transaction, Stage::Maintenance)?;

        progress.set_phase_with_metrics("backup_database", None, Some(preflight.database_bytes));
        backup_database(&candidate_stage, &root, &id, &mut transaction)?;
        progress.check_cancel()?;
        transaction.migration_started = true;
        write_transaction(&root, &transaction)?;
        let candidate = verify_release(&candidate_stage)?;
        validate_candidate(&candidate_stage, &root, &id, &mut transaction, &progress)?;
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
        set_autostart(&root, true)?;
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
            launch_manager(&root, "run")?;
            progress.finish("complete");
            Ok(format!(
                "NGTManager v{} installed successfully.",
                config.version
            ))
        }
        Err(error) => {
            progress.set_phase_failure("recovery");
            let recovery = rollback_transaction(&root, &mut transaction);
            if stage_created && candidate_stage.exists() {
                let _ = remove_owned_directory(&root.join("releases"), &candidate_stage);
            }
            if let Err(recovery_error) = recovery {
                progress.finish_failure("recovery_failed");
                transaction.failure = Some("recovery_failed".to_owned());
                transaction.stage = Stage::Failed;
                let _ = write_transaction(&root, &transaction);
                return Err(format!("Installation failed and recovery needs attention: {recovery_error}. Data and backups were preserved."));
            }
            progress.finish("failed");
            drop(_operation_lock);
            if previous_config.is_some() {
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
        let health = wait_for_health(&mut application, &verify_release(release)?.version, None);
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
    #[cfg(windows)]
    let _runtime_lock = wait_for_runtime_stop(root)?;
    if transaction.migration_started {
        if let Some(backup_root) = transaction.backup_root.as_ref() {
            if backup_root != &root.join("backups").join(&transaction.operation_id) {
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
            restore_database(root, backup_root, &transaction.operation_id)?;
        }
    }
    if should_remove_initial_database(transaction) {
        cleanup_initial_database(root, transaction)?;
    }
    if let Some(previous) = transaction.previous_config.as_ref() {
        let mut restored = previous.clone();
        restored.maintenance = false;
        write_config(root, &restored)?;
        set_autostart(root, true)?;
    } else if let (Some(candidate), Some(current)) =
        (transaction.candidate_release.as_ref(), read_config(root)?)
    {
        if current.active_release == *candidate {
            fs::remove_file(config_path(root)).map_err(|error| {
                format!("Unable to clear the uncommitted manager configuration: {error}")
            })?;
            let _ = set_autostart(root, false);
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
                set_autostart(root, true)?;
                advance_transaction(root, &mut transaction, Stage::Committed)?;
                return Ok("Completed the interrupted release switch.".to_owned());
            }
        }
    }
    rollback_transaction(root, &mut transaction)?;
    Ok("Recovered the interrupted installation and retained its backup.".to_owned())
}

#[cfg(windows)]
fn launch_manager(root: &Path, command: &str) -> Result<(), String> {
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
        .map(|_| ())
        .map_err(|error| format!("Unable to start NGTManager: {error}"))
}

#[cfg(not(windows))]
fn launch_manager(_root: &Path, _command: &str) -> Result<(), String> {
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
    let state = root.join("state");
    fs::create_dir_all(&state)
        .map_err(|error| format!("Unable to create runtime state: {error}"))?;
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(state.join("run.lock"))
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
    verify_release(&config.active_release)?;
    ensure_port_available(APPLICATION_PORT)?;
    ensure_port_available(DATABASE_PORT)?;
    let job = RuntimeJob::new()?;
    let mut database = start_database(&job, &config.active_release, root, Some(stop), run_state)?;
    let application_job = RuntimeJob::new()?;
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
fn run_supervisor() -> Result<String, String> {
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    let root = stable_root()?;
    let operation_lock = recover_runtime_before_start(&root)?;
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
        return Ok("NGTManager is already running.".to_owned());
    };
    drop(operation_lock);
    let stop = create_stop_event()?;
    WINDOWS_SESSION_END.store(false, Ordering::SeqCst);
    WINDOWS_SESSION_END_TICK.store(0, Ordering::SeqCst);
    let _session_notifier = SessionEndNotifier::start()?;
    report_unconfirmed_previous_run(&root);
    let mut memory_sampler = memory_sample::MemorySamplingSupervisor::new(&root);
    let mut restarts = 0;
    loop {
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
        loop {
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
fn run_supervisor() -> Result<String, String> {
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
fn open_system(root: &Path) -> Result<String, String> {
    let config = read_config(root)?.ok_or_else(|| "NGTManager is not installed.".to_owned())?;
    if !runtime_is_active(root)? {
        launch_manager(root, "run")?;
    }
    let client = health_client()?;
    for _ in 0..180 {
        if health_matches(&client, &config.version) {
            let mut command = Command::new("cmd.exe");
            command
                .args(["/C", "start", "", "http://127.0.0.1:3000"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            hide_console(&mut command);
            command
                .spawn()
                .map_err(|error| format!("Unable to open NGTManager in the browser: {error}"))?;
            return Ok("NGTManager is open.".to_owned());
        }
        thread::sleep(Duration::from_secs(1));
    }
    Err("NGTManager did not pass its health check; see logs/manager.log.".to_owned())
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
        [command] if command == "run" => run_supervisor(),
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
            stop_supervisor(&root)?;
            let mut transaction = create_transaction(
                &root,
                Operation::Uninstall,
                unique_id(),
                read_config(&root)?,
                inspect_postgres_directory(&root.join("data/postgres"))?,
            )?;
            advance_transaction(&root, &mut transaction, Stage::Uninstalling)?;
            set_autostart(&root, false)?;
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
    if !matches!(
        arguments.first().map(String::as_str),
        Some("install" | "update")
    ) {
        return Err("The install result path is only valid for setup operations.".to_owned());
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
        .ok_or_else(|| {
            "A valid operation ID is required for the install result file.".to_owned()
        })?;
    let expected_name = format!("NGTManager-setup-result-{operation_id}.txt");
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err("The install result file name does not match its operation.".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The install result file directory is invalid.".to_owned())?;
    let parent = fs::canonicalize(parent)
        .map_err(|_| "The install result file directory is unavailable.".to_owned())?;
    let temporary = fs::canonicalize(std::env::temp_dir())
        .map_err(|_| "The temporary directory is unavailable.".to_owned())?;
    if !parent.starts_with(temporary) {
        return Err("The install result file must be inside the temporary directory.".to_owned());
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("The install result file already exists; it was not overwritten.".to_owned()),
        Err(_) => Err("The install result file cannot be safely inspected.".to_owned()),
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
    let _ = INSTALL_EXTRACTION_METRICS.set(extraction_metrics);
    let _ = INSTALL_CANCEL_FILE.set(cancel_file);
    initialize_manager_diagnostics(&arguments);
    let result = run(&arguments);
    if let Err(message) = &result {
        if let Ok(root) = stable_root() {
            if let Ok(Some(transaction)) = read_transaction_if_exists(&root) {
                set_operation_id(&root, &transaction.operation_id);
            }
            record_command_failure(&root, &arguments, message);
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

    #[test]
    fn legacy_database_handoff_requires_a_clean_control_state() {
        assert!(postgres_cluster_is_clean(
            "Database cluster state:               shut down\n"
        ));
        assert!(!postgres_cluster_is_clean(
            "Database cluster state:               in production\n"
        ));
        assert!(!postgres_cluster_is_clean("control file is unreadable\n"));
    }

    #[test]
    fn setup_result_files_are_operation_scoped_and_never_overwritten() {
        let directory = std::env::temp_dir().join(format!("ngt-setup-result-{}", unique_id()));
        fs::create_dir(&directory).unwrap();
        let result_path = directory.join("NGTManager-setup-result-attempt-1.txt");
        let arguments = vec![
            "install".to_owned(),
            "package".to_owned(),
            "attempt-1".to_owned(),
        ];

        validate_result_file_path(&result_path, &arguments).unwrap();
        write_setup_result(&result_path, "ERROR\ninstall failed").unwrap();
        assert!(validate_result_file_path(&result_path, &arguments).is_err());
        assert!(write_setup_result(&result_path, "ERROR\nreplacement").is_err());
        assert_eq!(
            fs::read_to_string(&result_path).unwrap(),
            "ERROR\ninstall failed"
        );

        let unrelated_path = std::env::current_dir()
            .unwrap()
            .join("NGTManager-setup-result-attempt-1.txt");
        assert!(validate_result_file_path(&unrelated_path, &arguments).is_err());
        let wrong_name = directory.join("business-backup.json");
        assert!(validate_result_file_path(&wrong_name, &arguments).is_err());
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
    fn retrying_database_restore_does_not_accumulate_preserved_copies() {
        let root = std::env::temp_dir().join(format!("ngt-manager-restore-{}", unique_id()));
        let data_root = root.join("data");
        let data = data_root.join("postgres");
        let operation_id = "restore-test";
        let backup_root = root.join("backups").join(operation_id);
        let backup = backup_root.join("database");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::write(data.join("PG_VERSION"), "original").unwrap();
        fs::write(backup.join("PG_VERSION"), "verified").unwrap();

        restore_database(&root, &backup_root, operation_id).unwrap();
        let preserved = data_root.join("postgres-interrupted-restore-test");
        assert_eq!(
            fs::read_to_string(data.join("PG_VERSION")).unwrap(),
            "verified"
        );
        assert!(!preserved.exists());

        fs::create_dir_all(&preserved).unwrap();
        fs::write(
            preserved.join("PG_VERSION"),
            "preserved before interrupted restore",
        )
        .unwrap();
        remove_owned_directory(&data_root, &data).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("PG_VERSION"), "partial restore").unwrap();
        restore_database(&root, &backup_root, operation_id).unwrap();

        let preserved_copies = fs::read_dir(&data_root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("postgres-interrupted-restore-test")
            })
            .count();
        assert_eq!(preserved_copies, 0);
        assert_eq!(
            fs::read_to_string(data.join("PG_VERSION")).unwrap(),
            "verified"
        );
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
        assert!(verify_release(&root).unwrap_err().contains("unsafe path"));
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
