use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FORMAT_VERSION: u8 = 1;
const MAX_EVENT_BYTES: usize = 4 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MESSAGE_BYTES: usize = 4 * 1024;
const QUEUE_MESSAGES: usize = 256;
const EXPORT_LIMIT: u64 = 15 * 1024 * 1024;
const EXPORT_FOOTER_RESERVE: usize = 2048;
const MAX_OMITTED_SOURCES_PER_KIND: usize = 4;
const MAX_DIRECTORY_SCAN: usize = 1024;
const EVENT_SEGMENT_LIMIT: u64 = 1024 * 1024;
const DETAIL_SEGMENT_LIMIT: u64 = 4 * 1024 * 1024;
const EVENT_TOTAL_LIMIT: u64 = 10 * 1024 * 1024;
const DETAIL_TOTAL_LIMIT: u64 = 40 * 1024 * 1024;
const EVENT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const DETAIL_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Component {
    Manager,
    Installer,
    Database,
    Migration,
    Application,
    Updater,
    BackupImport,
}

#[derive(Clone, Copy)]
pub enum LogOwner {
    Manager,
    Updater,
}

impl Component {
    fn event_bucket(self) -> &'static str {
        match self {
            Self::Application | Self::BackupImport => "application",
            Self::Updater => "updater",
            _ => "manager-db",
        }
    }

    fn detail_bucket(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Application | Self::BackupImport => "application",
            Self::Migration | Self::Installer => "install-migration",
            Self::Updater => "updater",
            Self::Manager => "install-migration",
        }
    }

    fn from_safe_name(value: &str) -> Option<Self> {
        match value {
            "manager" => Some(Self::Manager),
            "installer" => Some(Self::Installer),
            "database" => Some(Self::Database),
            "migration" => Some(Self::Migration),
            "application" => Some(Self::Application),
            "updater" => Some(Self::Updater),
            "backup-import" => Some(Self::BackupImport),
            _ => None,
        }
    }

    fn safe_name(self) -> &'static str {
        match self {
            Self::Manager => "manager",
            Self::Installer => "installer",
            Self::Database => "database",
            Self::Migration => "migration",
            Self::Application => "application",
            Self::Updater => "updater",
            Self::BackupImport => "backup-import",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub format_version: u8,
    pub diagnostic_id: String,
    pub utc_time: String,
    pub component: Component,
    pub severity: String,
    pub event_code: String,
    pub operation_id: String,
    pub process_start_id: String,
    pub process_sequence: u64,
    pub version: String,
    pub phase: String,
    pub error_code: String,
    pub detail_ref: String,
    pub details_available: bool,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub occurrences: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_utc_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_event_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_detail_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_writer_failed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_version: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub record_counts: BTreeMap<String, u32>,
}

fn is_one(value: &u32) -> bool {
    *value == 1
}

fn one() -> u32 {
    1
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalEvent {
    format_version: u8,
    diagnostic_id: String,
    component: String,
    severity: String,
    event_code: String,
    phase: String,
    error_code: String,
    #[serde(default)]
    attempts: Option<u16>,
    #[serde(default)]
    elapsed_ms: Option<u64>,
    #[serde(default)]
    dropped_detail_bytes: Option<u64>,
    #[serde(default)]
    backup_format: Option<String>,
    #[serde(default)]
    backup_version: Option<u32>,
    #[serde(default)]
    record_counts: BTreeMap<String, u32>,
}

enum Message {
    Event(Box<DiagnosticEvent>),
    Detail {
        component: Component,
        bytes: Vec<u8>,
    },
    Finish,
}

struct ReaderContext {
    sender: SyncSender<Message>,
    component: Component,
    dropped_events: std::sync::Arc<AtomicU64>,
    dropped_detail_bytes: std::sync::Arc<AtomicU64>,
    writer_failed: std::sync::Arc<AtomicBool>,
    run_id: String,
    operation_id: std::sync::Arc<Mutex<String>>,
    version: String,
    sequence: std::sync::Arc<AtomicU64>,
    started: Option<mpsc::SyncSender<()>>,
}

/// One bounded queue and one writer for the current manager or updater process.
/// Child readers only use try_send, so a slow or failed log disk never blocks them.
pub struct LogSession {
    sender: SyncSender<Message>,
    writer: Mutex<Option<JoinHandle<()>>>,
    readers: Mutex<Vec<JoinHandle<()>>>,
    root: PathBuf,
    operation_id: std::sync::Arc<Mutex<String>>,
    version: String,
    run_id: String,
    sequence: std::sync::Arc<AtomicU64>,
    dropped_events: std::sync::Arc<AtomicU64>,
    dropped_detail_bytes: std::sync::Arc<AtomicU64>,
    writer_failed: std::sync::Arc<AtomicBool>,
    finished: AtomicBool,
}

impl LogSession {
    pub fn start(
        root: &Path,
        operation_id: &str,
        version: &str,
        owner: LogOwner,
    ) -> io::Result<Self> {
        let run_id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let log_root = root.join("logs").join("diagnostics");
        fs::create_dir_all(log_root.join("events"))?;
        fs::create_dir_all(log_root.join("details"))?;
        let (sender, receiver) = mpsc::sync_channel(QUEUE_MESSAGES);
        let failed = std::sync::Arc::new(AtomicBool::new(false));
        let dropped_events = std::sync::Arc::new(AtomicU64::new(0));
        let dropped_detail_bytes = std::sync::Arc::new(AtomicU64::new(0));
        let writer_dropped_events = dropped_events.clone();
        let writer_dropped_detail_bytes = dropped_detail_bytes.clone();
        let writer_error_state = failed.clone();
        let writer_root = root.to_path_buf();
        let writer_run_id = run_id.clone();
        let writer_owner = owner;
        let log_version = safe_field(version, 48, "unknown");
        let writer_version = log_version.clone();
        let writer = thread::Builder::new()
            .name("ngt-diagnostics-writer".to_owned())
            .spawn(move || {
                let mut store = SegmentStore::new(&writer_root, &writer_run_id, writer_owner);
                if store.cleanup_expired().is_err() {
                    writer_error_state.store(true, Ordering::Relaxed);
                }
                let mut detail_targets: HashMap<String, String> = HashMap::new();
                let mut detail_components: HashMap<String, Component> = HashMap::new();
                let mut pending_details: HashMap<String, VecDeque<u8>> = HashMap::new();
                let mut failed_detail_buckets = HashSet::new();
                while let Ok(message) = receiver.recv() {
                    let result = match message {
                        Message::Event(mut event) => {
                            let bucket = event.component.detail_bucket().to_owned();
                            let is_failure =
                                matches!(event.severity.as_str(), "error" | "critical");
                            if is_failure {
                                event.details_available &=
                                    writer_dropped_detail_bytes.load(Ordering::Relaxed) == 0
                                        && !writer_error_state.load(Ordering::Relaxed)
                                        && !failed_detail_buckets.contains(&bucket)
                                        && event.dropped_detail_bytes.unwrap_or_default() == 0;
                                if let Some(previous) = detail_targets.remove(&bucket) {
                                    if previous != event.detail_ref
                                        && store.rotate_detail(&previous, &bucket).is_err()
                                    {
                                        writer_error_state.store(true, Ordering::Relaxed);
                                        failed_detail_buckets.insert(bucket.clone());
                                        if let Some(previous_component) =
                                            detail_components.get(&bucket).copied()
                                        {
                                            if record_detail_unavailable(
                                                &mut store,
                                                &previous,
                                                previous_component,
                                                &writer_run_id,
                                                &writer_version,
                                            )
                                            .is_err()
                                            {
                                                writer_error_state.store(true, Ordering::Relaxed);
                                            }
                                        }
                                        event.details_available = false;
                                    }
                                }
                                detail_targets.insert(bucket.clone(), event.detail_ref.clone());
                                detail_components.insert(
                                    event.component.detail_bucket().to_owned(),
                                    event.component,
                                );
                                if let Some(pending) = pending_details.remove(&bucket) {
                                    let bytes = pending.into_iter().collect::<Vec<_>>();
                                    if !bytes.is_empty()
                                        && store
                                            .write_detail(
                                                &event.detail_ref,
                                                event.component,
                                                &bytes,
                                            )
                                            .is_err()
                                    {
                                        writer_dropped_detail_bytes
                                            .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                                        writer_error_state.store(true, Ordering::Relaxed);
                                        failed_detail_buckets.insert(bucket.clone());
                                        event.details_available = false;
                                    }
                                }
                            }
                            let result = store.write_event(&event);
                            if result.is_err() {
                                writer_dropped_events.fetch_add(1, Ordering::Relaxed);
                            }
                            result
                        }
                        Message::Detail { component, bytes } => {
                            let length = bytes.len() as u64;
                            let bucket = component.detail_bucket().to_owned();
                            let detail_ref = detail_targets.get(&bucket).cloned();
                            let target_component =
                                detail_components.get(&bucket).copied().unwrap_or(component);
                            let result = if writer_error_state.load(Ordering::Relaxed)
                                || failed_detail_buckets.contains(&bucket)
                            {
                                writer_dropped_detail_bytes.fetch_add(length, Ordering::Relaxed);
                                Ok(())
                            } else if let Some(detail_ref) = detail_ref {
                                match store.write_detail(&detail_ref, target_component, &bytes) {
                                    Ok(()) => Ok(()),
                                    Err(error) => {
                                        writer_error_state.store(true, Ordering::Relaxed);
                                        failed_detail_buckets.insert(bucket);
                                        let _ = record_detail_unavailable(
                                            &mut store,
                                            &detail_ref,
                                            target_component,
                                            &writer_run_id,
                                            &writer_version,
                                        );
                                        Err(error)
                                    }
                                }
                            } else {
                                let pending = pending_details
                                    .entry(bucket)
                                    .or_insert_with(|| VecDeque::with_capacity(READ_BUFFER_BYTES));
                                let dropped = append_pending_detail(pending, &bytes);
                                if dropped > 0 {
                                    writer_dropped_detail_bytes
                                        .fetch_add(dropped, Ordering::Relaxed);
                                }
                                Ok(())
                            };
                            match result {
                                Ok(()) => Ok(()),
                                Err(error) => {
                                    writer_dropped_detail_bytes
                                        .fetch_add(length, Ordering::Relaxed);
                                    Err(error)
                                }
                            }
                        }
                        Message::Finish => {
                            let dropped_events = writer_dropped_events.load(Ordering::Relaxed);
                            let dropped_detail_bytes =
                                writer_dropped_detail_bytes.load(Ordering::Relaxed);
                            let recording_failed = writer_error_state.load(Ordering::Relaxed);
                            if dropped_events > 0 || dropped_detail_bytes > 0 || recording_failed {
                                let event = DiagnosticEvent {
                                    format_version: FORMAT_VERSION,
                                    diagnostic_id: format!("{}-incomplete", writer_run_id),
                                    utc_time: utc_now(),
                                    component: Component::Manager,
                                    severity: "warning".to_owned(),
                                    event_code: "diagnostics.recording_incomplete".to_owned(),
                                    operation_id: "none".to_owned(),
                                    process_start_id: writer_run_id.clone(),
                                    process_sequence: u64::MAX,
                                    version: "unknown".to_owned(),
                                    phase: "recording".to_owned(),
                                    error_code: if recording_failed {
                                        "LOG_WRITER_FAILED"
                                    } else if dropped_events > 0 {
                                        "EVENT_QUEUE_DROPPED"
                                    } else {
                                        "DETAIL_OUTPUT_DROPPED"
                                    }
                                    .to_owned(),
                                    detail_ref: "details/manager-db-none".to_owned(),
                                    details_available: false,
                                    occurrences: 1,
                                    last_utc_time: None,
                                    attempts: None,
                                    elapsed_ms: None,
                                    dropped_event_count: Some(dropped_events),
                                    dropped_detail_bytes: Some(dropped_detail_bytes),
                                    log_writer_failed: Some(recording_failed),
                                    backup_format: None,
                                    backup_version: None,
                                    record_counts: BTreeMap::new(),
                                };
                                let _ = store.write_event(&event);
                            }
                            if store.close_all().is_err() {
                                writer_error_state.store(true, Ordering::Relaxed);
                            }
                            break;
                        }
                    };
                    if result.is_err() {
                        writer_error_state.store(true, Ordering::Relaxed);
                    }
                }
            })?;
        Ok(Self {
            sender,
            writer: Mutex::new(Some(writer)),
            readers: Mutex::new(Vec::new()),
            root: root.to_path_buf(),
            operation_id: std::sync::Arc::new(Mutex::new(safe_field(operation_id, 64, "none"))),
            version: log_version,
            run_id,
            sequence: std::sync::Arc::new(AtomicU64::new(1)),
            dropped_events,
            dropped_detail_bytes,
            writer_failed: failed,
            finished: AtomicBool::new(false),
        })
    }

    pub fn record(
        &self,
        component: Component,
        severity: &str,
        event_code: &str,
        phase: &str,
        error_code: &str,
    ) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let event = DiagnosticEvent {
            format_version: FORMAT_VERSION,
            diagnostic_id: format!("{}-{sequence}", self.run_id),
            utc_time: utc_now(),
            component,
            severity: safe_severity(severity),
            event_code: safe_field(event_code, 96, "diagnostic.unknown"),
            operation_id: self.current_operation_id(),
            process_start_id: self.run_id.clone(),
            process_sequence: sequence,
            version: self.version.clone(),
            phase: safe_field(phase, 64, "unknown"),
            error_code: safe_field(error_code, 64, "none"),
            detail_ref: detail_reference(&component, &format!("{}-{sequence}", self.run_id)),
            details_available: !self.writer_failed.load(Ordering::Relaxed)
                && self.dropped_detail_bytes.load(Ordering::Relaxed) == 0,
            occurrences: 1,
            last_utc_time: None,
            attempts: None,
            elapsed_ms: None,
            dropped_event_count: None,
            dropped_detail_bytes: None,
            log_writer_failed: None,
            backup_format: None,
            backup_version: None,
            record_counts: BTreeMap::new(),
        };
        let id = event.diagnostic_id.clone();
        self.send_event(event);
        id
    }

    fn send_event(&self, event: DiagnosticEvent) {
        match self.sender.try_send(Message::Event(Box::new(event))) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped_events.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn set_operation_id(&self, operation_id: &str) {
        *self
            .operation_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            safe_field(operation_id, 64, "none");
    }

    fn current_operation_id(&self) -> String {
        self.operation_id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Starts draining a child pipe. The reader is independent of disk I/O and is
    /// installed before the caller releases the child startup gate.
    pub fn attach_reader<R: Read + Send + 'static>(
        &self,
        reader: R,
        component: Component,
    ) -> io::Result<()> {
        let sender = self.sender.clone();
        let dropped_events = self.dropped_events.clone();
        let dropped_detail_bytes = self.dropped_detail_bytes.clone();
        let writer_failed = self.writer_failed.clone();
        let run_id = self.run_id.clone();
        let operation_id = self.operation_id.clone();
        let version = self.version.clone();
        let sequence = self.sequence.clone();
        let (started_sender, started_receiver) = mpsc::sync_channel(0);
        let handle = thread::Builder::new()
            .name(format!("ngt-output-{}", component.safe_name()))
            .spawn(move || {
                drain_reader(
                    reader,
                    ReaderContext {
                        sender,
                        component,
                        dropped_events,
                        dropped_detail_bytes,
                        writer_failed,
                        run_id,
                        operation_id,
                        version,
                        sequence,
                        started: Some(started_sender),
                    },
                );
            })?;
        started_receiver
            .recv()
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "reader failed to start"))?;
        self.readers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(handle);
        Ok(())
    }

    pub fn recording_failed(&self) -> bool {
        self.writer_failed.load(Ordering::Relaxed)
    }

    pub fn detail(&self, component: Component, bytes: &[u8]) {
        for chunk in bytes.chunks(MESSAGE_BYTES) {
            if self
                .sender
                .try_send(Message::Detail {
                    component,
                    bytes: chunk.to_vec(),
                })
                .is_err()
            {
                self.dropped_detail_bytes
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn shutdown(&self) {
        if self.finished.swap(true, Ordering::Relaxed) {
            return;
        }
        let readers = std::mem::take(
            &mut *self
                .readers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for reader in readers {
            let _ = reader.join();
        }
        let _ = self.sender.send(Message::Finish);
        if let Some(writer) = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = writer.join();
        }
    }

    pub fn finish(&self) {
        self.shutdown();
    }
}

impl Drop for LogSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn append_pending_detail(buffer: &mut VecDeque<u8>, bytes: &[u8]) -> u64 {
    let dropped = buffer
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(READ_BUFFER_BYTES) as u64;
    if dropped > 0 {
        let remove = dropped as usize;
        let from_buffer = remove.min(buffer.len());
        buffer.drain(..from_buffer);
        let from_input = remove.saturating_sub(from_buffer);
        buffer.extend(bytes[from_input..].iter().copied());
    } else {
        buffer.extend(bytes.iter().copied());
    }
    dropped
}

fn drain_reader<R: Read>(mut reader: R, context: ReaderContext) {
    let ReaderContext {
        sender,
        component,
        dropped_events,
        dropped_detail_bytes,
        writer_failed,
        run_id,
        operation_id,
        version,
        sequence,
        mut started,
    } = context;
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    let mut line = Vec::with_capacity(MESSAGE_BYTES);
    let mut line_overflow = false;
    loop {
        if let Some(started) = started.take() {
            let _ = started.send(());
        }
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(_) => {
                let event_sequence = sequence.fetch_add(1, Ordering::Relaxed);
                let event = DiagnosticEvent {
                    format_version: FORMAT_VERSION,
                    diagnostic_id: format!("{}-read-{event_sequence}", run_id),
                    utc_time: utc_now(),
                    component,
                    severity: "warning".to_owned(),
                    event_code: "runtime.output_read_failed".to_owned(),
                    operation_id: operation_id
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                    process_start_id: run_id.clone(),
                    process_sequence: event_sequence,
                    version: version.clone(),
                    phase: "output-read".to_owned(),
                    error_code: "STREAM_READ_FAILED".to_owned(),
                    detail_ref: detail_reference(
                        &component,
                        &format!("{}-read-{event_sequence}", run_id),
                    ),
                    details_available: false,
                    occurrences: 1,
                    last_utc_time: None,
                    attempts: None,
                    elapsed_ms: None,
                    dropped_event_count: None,
                    dropped_detail_bytes: None,
                    log_writer_failed: None,
                    backup_format: None,
                    backup_version: None,
                    record_counts: BTreeMap::new(),
                };
                try_event(&sender, &dropped_events, event);
                break;
            }
        };
        for byte in &buffer[..count] {
            line.push(*byte);
            if line.len() > MAX_EVENT_BYTES {
                line_overflow = true;
                flush_detail(&sender, &dropped_detail_bytes, component, &line);
                line.clear();
            }
            if *byte == b'\n' {
                if !line_overflow {
                    if let Some(json) = line
                        .strip_prefix(b"NGT_DIAGNOSTIC:")
                        .and_then(|bytes| serde_json::from_slice::<ExternalEvent>(bytes).ok())
                        .filter(|event| event.format_version == FORMAT_VERSION)
                    {
                        let event_component =
                            Component::from_safe_name(&json.component).unwrap_or(component);
                        let event = DiagnosticEvent {
                            format_version: FORMAT_VERSION,
                            diagnostic_id: safe_identifier(&json.diagnostic_id, 96, "unknown"),
                            utc_time: utc_now(),
                            component: event_component,
                            severity: safe_severity(&json.severity),
                            event_code: safe_field(&json.event_code, 96, "diagnostic.unknown"),
                            operation_id: operation_id
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .clone(),
                            process_start_id: run_id.clone(),
                            process_sequence: sequence.fetch_add(1, Ordering::Relaxed),
                            version: version.clone(),
                            phase: safe_field(&json.phase, 64, "unknown"),
                            error_code: safe_field(&json.error_code, 64, "none"),
                            detail_ref: detail_reference(
                                &event_component,
                                &safe_field(&json.diagnostic_id, 96, "unknown"),
                            ),
                            details_available: !writer_failed.load(Ordering::Relaxed)
                                && dropped_detail_bytes.load(Ordering::Relaxed) == 0
                                && json.dropped_detail_bytes.unwrap_or_default() == 0,
                            occurrences: 1,
                            last_utc_time: None,
                            attempts: json.attempts.filter(|value| (1..=1000).contains(value)),
                            elapsed_ms: json.elapsed_ms.filter(|value| *value <= 600_000),
                            dropped_event_count: None,
                            dropped_detail_bytes: json
                                .dropped_detail_bytes
                                .filter(|value| *value <= 1_000_000_000_000),
                            log_writer_failed: None,
                            backup_format: json.backup_format.filter(|value| {
                                matches!(value.as_str(), "ngt-repair-data" | "unknown")
                            }),
                            backup_version: json
                                .backup_version
                                .filter(|value| (1..=1000).contains(value)),
                            record_counts: safe_record_counts(json.record_counts),
                        };
                        try_event(&sender, &dropped_events, event);
                    } else {
                        flush_detail(&sender, &dropped_detail_bytes, component, &line);
                    }
                } else {
                    flush_detail(&sender, &dropped_detail_bytes, component, &line);
                }
                line.clear();
                line_overflow = false;
            }
        }
    }
    if !line.is_empty() {
        flush_detail(&sender, &dropped_detail_bytes, component, &line);
    }
}

fn try_event(sender: &SyncSender<Message>, dropped: &AtomicU64, event: DiagnosticEvent) {
    if sender.try_send(Message::Event(Box::new(event))).is_err() {
        dropped.fetch_add(1, Ordering::Relaxed);
    }
}

fn flush_detail(
    sender: &SyncSender<Message>,
    dropped: &AtomicU64,
    component: Component,
    bytes: &[u8],
) {
    for chunk in bytes.chunks(MESSAGE_BYTES) {
        let message = Message::Detail {
            component,
            bytes: chunk.to_vec(),
        };
        if sender.try_send(message).is_err() {
            dropped.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
    }
}

struct Segment {
    path: PathBuf,
    file: File,
    bytes: u64,
}

struct SegmentSpec<'a> {
    area: &'a str,
    key: &'a str,
    file_prefix: &'a str,
    quota_prefix: &'a str,
    extension: &'a str,
    quota: u64,
    segment_limit: u64,
}

struct SegmentStore {
    root: PathBuf,
    run_id: String,
    owner: LogOwner,
    next: u64,
    active: HashMap<String, Segment>,
}

const MANAGER_SEGMENT_QUOTAS: [(&str, &str, &str, u64); 5] = [
    ("events", "events-manager-db", "jsonl", 5 * 1024 * 1024),
    ("events", "events-application", "jsonl", 3 * 1024 * 1024),
    ("details", "details-database", "logseg", 12 * 1024 * 1024),
    ("details", "details-application", "logseg", 12 * 1024 * 1024),
    (
        "details",
        "details-install-migration",
        "logseg",
        10 * 1024 * 1024,
    ),
];

const UPDATER_SEGMENT_QUOTAS: [(&str, &str, &str, u64); 2] = [
    ("events", "events-updater", "jsonl", 2 * 1024 * 1024),
    ("details", "details-updater", "logseg", 6 * 1024 * 1024),
];

impl SegmentStore {
    fn new(root: &Path, run_id: &str, owner: LogOwner) -> Self {
        Self {
            root: root.join("logs").join("diagnostics"),
            run_id: run_id.to_owned(),
            owner,
            next: 0,
            active: HashMap::new(),
        }
    }

    fn cleanup_expired(&self) -> io::Result<()> {
        let mut first_error = None;
        let quotas = match self.owner {
            LogOwner::Manager => MANAGER_SEGMENT_QUOTAS.as_slice(),
            LogOwner::Updater => UPDATER_SEGMENT_QUOTAS.as_slice(),
        };
        for &(area, prefix, extension, quota) in quotas {
            if let Err(error) = cleanup_segments(&self.root.join(area), prefix, extension, quota, 0)
            {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn write_event(&mut self, event: &DiagnosticEvent) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(event)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_EVENT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "event too large",
            ));
        }
        let bucket = event.component.event_bucket();
        let quota = match bucket {
            "manager-db" => 5 * 1024 * 1024,
            "application" => 3 * 1024 * 1024,
            _ => 2 * 1024 * 1024,
        };
        let key = format!("events-{bucket}");
        self.append(
            SegmentSpec {
                area: "events",
                key: &key,
                file_prefix: &key,
                quota_prefix: &key,
                extension: "jsonl",
                quota,
                segment_limit: EVENT_SEGMENT_LIMIT,
            },
            &bytes,
        )?;
        if matches!(event.severity.as_str(), "error" | "critical")
            || event.event_code.ends_with(".completed")
            || event.event_code.ends_with(".committed")
            || event.event_code.ends_with(".passed")
            || event.event_code.ends_with(".unavailable")
            || event.event_code.ends_with(".incomplete")
            || event.phase == "rolled-back"
        {
            if let Some(segment) = self.active.get_mut(&format!("events-{bucket}")) {
                segment.file.sync_data()?;
            }
        }
        Ok(())
    }

    fn write_detail(
        &mut self,
        detail_ref: &str,
        component: Component,
        bytes: &[u8],
    ) -> io::Result<()> {
        let bucket = component.detail_bucket();
        let identifier = detail_identifier(detail_ref, bucket)?;
        let quota = match bucket {
            "database" | "application" => 12 * 1024 * 1024,
            "updater" => 6 * 1024 * 1024,
            _ => 10 * 1024 * 1024,
        };
        let source_prefix = format!("details-{bucket}");
        let key = format!("details-{identifier}-{bucket}");
        let file_prefix = format!("{source_prefix}-{identifier}");
        self.append(
            SegmentSpec {
                area: "details",
                key: &key,
                file_prefix: &file_prefix,
                quota_prefix: &source_prefix,
                extension: "logseg",
                quota,
                segment_limit: DETAIL_SEGMENT_LIMIT,
            },
            bytes,
        )
    }

    fn rotate_detail(&mut self, detail_ref: &str, bucket: &str) -> io::Result<()> {
        let identifier = detail_identifier(detail_ref, bucket)?;
        self.rotate(&format!("details-{identifier}-{bucket}"), "logseg")
    }

    fn close_all(&mut self) -> io::Result<()> {
        let active = self.active.keys().cloned().collect::<Vec<_>>();
        for key in active {
            let extension = if key.starts_with("events-") {
                "jsonl"
            } else {
                "logseg"
            };
            self.rotate(&key, extension)?;
        }
        Ok(())
    }

    fn append(&mut self, spec: SegmentSpec<'_>, bytes: &[u8]) -> io::Result<()> {
        let SegmentSpec {
            area,
            key,
            file_prefix,
            quota_prefix,
            extension,
            quota,
            segment_limit,
        } = spec;
        if bytes.is_empty() {
            return Ok(());
        }
        let directory = self.root.join(area);
        fs::create_dir_all(&directory)?;
        if self
            .active
            .get(key)
            .is_some_and(|segment| segment.bytes + bytes.len() as u64 > segment_limit)
        {
            self.rotate(key, extension)?;
        }
        if !self.active.contains_key(key) {
            let next = self.next;
            self.next = self.next.saturating_add(1);
            let name = format!("{file_prefix}-{}-{next:06}.open", self.run_id);
            let path = directory.join(name);
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&path)?;
            file.try_lock_exclusive()?;
            self.active.insert(
                key.to_owned(),
                Segment {
                    path,
                    file,
                    bytes: 0,
                },
            );
        }
        let current = self.active.get(key).expect("active segment").bytes;
        let capacity = quota.saturating_sub(current);
        let write_len = bytes.len().min(capacity as usize);
        if write_len == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "diagnostic quota reached",
            ));
        }
        cleanup_segments(&directory, quota_prefix, extension, quota, write_len as u64)?;
        let segment = self.active.get_mut(key).expect("active segment");
        if let Err(error) = segment.file.write_all(&bytes[..write_len]) {
            segment.bytes = segment
                .file
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(segment.bytes);
            return Err(error);
        }
        segment.bytes += write_len as u64;
        if write_len < bytes.len() {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "diagnostic quota reached",
            ));
        }
        Ok(())
    }

    fn rotate(&mut self, key: &str, extension: &str) -> io::Result<()> {
        if let Some(segment) = self.active.remove(key) {
            let closed_path = segment.path.with_extension(extension);
            drop(segment.file);
            fs::rename(segment.path, closed_path)?;
        }
        Ok(())
    }
}

fn cleanup_segments(
    directory: &Path,
    prefix: &str,
    closed_extension: &str,
    quota: u64,
    incoming: u64,
) -> io::Result<()> {
    recover_abandoned_segments(directory, prefix, closed_extension)?;
    let now = SystemTime::now();
    let retention = if prefix.starts_with("events-") {
        EVENT_RETENTION
    } else {
        DETAIL_RETENTION
    };
    let mut files = Vec::new();
    let mut used = 0u64;
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_owned_segment(&name, prefix, closed_extension) {
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str());
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => metadata,
            _ => continue,
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        used = used.saturating_add(metadata.len());
        if extension == Some(closed_extension) {
            files.push((modified, metadata.len(), path));
        }
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (modified, len, path) in &files {
        let expired = now
            .duration_since(*modified)
            .is_ok_and(|age| age > retention);
        if expired || used.saturating_add(incoming) > quota {
            match try_remove_owned_segment(path) {
                Ok(()) => used = used.saturating_sub(*len),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    used = used.saturating_sub(*len);
                }
                Err(_) => {}
            }
        }
    }
    if used.saturating_add(incoming) > quota {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "diagnostic quota reached",
        ));
    }
    Ok(())
}

fn try_remove_owned_segment(path: &Path) -> io::Result<()> {
    let file = open_owned_segment(path, true)?;
    file.try_lock_exclusive()?;
    drop(file);
    fs::remove_file(path)
}

fn recover_abandoned_segments(
    directory: &Path,
    prefix: &str,
    closed_extension: &str,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_owned_segment(&name, prefix, closed_extension)
            || path.extension().and_then(|value| value.to_str()) != Some("open")
        {
            continue;
        }
        let Ok(file) = open_owned_segment(&path, true) else {
            continue;
        };
        if file.try_lock_exclusive().is_err() {
            continue;
        }
        drop(file);
        match fs::rename(&path, path.with_extension(closed_extension)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn open_owned_segment(path: &Path, write: bool) -> io::Result<File> {
    let path_metadata = fs::symlink_metadata(path)?;
    if !path_metadata.is_file() || is_reparse(&path_metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular log segment",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular log segment",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "log segment changed while opening",
            ));
        }
    }
    Ok(file)
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt;
    metadata.file_type().is_symlink() || metadata.file_type().is_block_device()
}

fn utc_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn safe_severity(value: &str) -> String {
    match value {
        "info" | "warning" | "error" | "critical" => value.to_owned(),
        _ => "warning".to_owned(),
    }
}

fn safe_field(value: &str, max: usize, fallback: &str) -> String {
    if value.is_empty()
        || value.len() > max
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        fallback.to_owned()
    } else {
        value.to_owned()
    }
}

fn safe_identifier(value: &str, max: usize, fallback: &str) -> String {
    if is_safe_identifier(value, max) {
        value.to_owned()
    } else {
        fallback.to_owned()
    }
}

fn is_safe_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn detail_reference(component: &Component, diagnostic_id: &str) -> String {
    let identifier = safe_identifier(diagnostic_id, 96, "unknown");
    format!("details/{}-{identifier}", component.detail_bucket())
}

fn detail_identifier(detail_ref: &str, bucket: &str) -> io::Result<String> {
    let prefix = format!("{bucket}-");
    detail_ref
        .strip_prefix("details/")
        .and_then(|name| name.strip_prefix(prefix.as_str()))
        .filter(|name| {
            !name.is_empty()
                && name.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        })
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid detail reference"))
}

fn record_detail_unavailable(
    store: &mut SegmentStore,
    detail_ref: &str,
    component: Component,
    run_id: &str,
    version: &str,
) -> io::Result<()> {
    let diagnostic_id = detail_identifier(detail_ref, component.detail_bucket())?;
    if diagnostic_id.len() > 96 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid diagnostic ID",
        ));
    }
    store.write_event(&DiagnosticEvent {
        format_version: FORMAT_VERSION,
        diagnostic_id,
        utc_time: utc_now(),
        component,
        severity: "warning".to_owned(),
        event_code: "diagnostics.detail.unavailable".to_owned(),
        operation_id: "none".to_owned(),
        process_start_id: run_id.to_owned(),
        process_sequence: u64::MAX,
        version: safe_field(version, 48, "unknown"),
        phase: "detail-write".to_owned(),
        error_code: "DETAIL_OUTPUT_UNAVAILABLE".to_owned(),
        detail_ref: detail_ref.to_owned(),
        details_available: false,
        occurrences: 1,
        last_utc_time: None,
        attempts: None,
        elapsed_ms: None,
        dropped_event_count: None,
        dropped_detail_bytes: None,
        log_writer_failed: None,
        backup_format: None,
        backup_version: None,
        record_counts: BTreeMap::new(),
    })
}

struct SnapshotFile {
    name: String,
    file: File,
    length: u64,
    truncated: bool,
}

#[derive(Default)]
struct SnapshotGaps {
    missing_events: u64,
    missing_details: u64,
    event_sources: BTreeSet<String>,
    detail_sources: BTreeSet<String>,
    more_event_sources: bool,
    more_detail_sources: bool,
}

/// Creates a bounded, redacted diagnostics file without overwriting any path.
pub fn export_diagnostics(root: &Path, output: &Path) -> io::Result<()> {
    let output = validate_output_path(root, output)?;
    let (mut events, mut details, gaps) = capture_log_snapshot(root);
    let mut output_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let export_result = (|| {
        let mut budget = ExportBudget {
            file: &mut output_file,
            written: 0,
            omitted_events: 0,
            omitted_details: 0,
            omitted_event_sources: BTreeSet::new(),
            omitted_detail_sources: BTreeSet::new(),
            export_limited_detail_sources: BTreeSet::new(),
            more_event_sources: false,
            more_detail_sources: false,
            more_export_limited_details: false,
        };
        budget.append(b"NGTManager diagnostic export v1\n")?;
        budget.append(format!("Exported UTC: {}\n\n", utc_now()).as_bytes())?;
        budget.append(b"FAILURE EVENTS\n")?;
        events.sort_by(|a, b| a.name.cmp(&b.name));
        let mut event_groups: HashMap<u64, Vec<DiagnosticEvent>> = HashMap::new();
        let grouping_hasher = std::collections::hash_map::RandomState::new();
        let mut seen_diagnostic_ids: HashMap<String, (u64, usize)> = HashMap::new();
        let mut unavailable_detail_ids = HashSet::new();
        for snapshot in events {
            let source = snapshot.name.clone();
            let visited = visit_lines(snapshot, |line| {
                let Ok(event) = serde_json::from_slice::<DiagnosticEvent>(line) else {
                    budget.note_omitted_event(&source, 1);
                    return Ok(());
                };
                if !valid_event(&event) {
                    budget.note_omitted_event(&source, 1);
                    return Ok(());
                }
                if event.severity == "info" {
                    return Ok(());
                }
                if event.event_code == "diagnostics.detail.unavailable" {
                    unavailable_detail_ids.insert(event.diagnostic_id);
                    return Ok(());
                }
                let diagnostic_id = event.diagnostic_id.clone();
                if let Some((group_hash, event_index)) =
                    seen_diagnostic_ids.get(&diagnostic_id).copied()
                {
                    if let Some(first) = event_groups
                        .get_mut(&group_hash)
                        .and_then(|group| group.get_mut(event_index))
                    {
                        merge_repeated_event(first, &event);
                    }
                    return Ok(());
                }
                let group_hash = event_group_hash(&event, &grouping_hasher);
                let group = event_groups.entry(group_hash).or_default();
                let event_index = if let Some((event_index, first)) = group
                    .iter_mut()
                    .enumerate()
                    .find(|(_, first)| same_event_group(first, &event))
                {
                    merge_repeated_event(first, &event);
                    event_index
                } else {
                    let event_index = group.len();
                    group.push(event);
                    event_index
                };
                seen_diagnostic_ids.insert(diagnostic_id, (group_hash, event_index));
                Ok(())
            });
            match visited {
                Ok((_, incomplete)) if incomplete => {
                    budget.note_omitted_event(&source, 1);
                }
                Ok(_) => {}
                Err(_) => budget.note_omitted_event(&source, 1),
            }
        }
        let mut grouped_events = event_groups.into_values().flatten().collect::<Vec<_>>();
        for event in &mut grouped_events {
            if unavailable_detail_ids.contains(&event.diagnostic_id) {
                event.details_available = false;
            }
            if !event.details_available {
                budget.note_omitted_detail(&format!("reference-{}", event.diagnostic_id), 1);
                continue;
            }
            let reference = format!(
                "details-{}-",
                event.detail_ref.trim_start_matches("details/")
            );
            let found = details.iter().any(|snapshot| {
                snapshot.name.starts_with(&reference)
                    && snapshot.length > 0
                    && [".open", ".logseg", ".log"]
                        .iter()
                        .any(|extension| snapshot.name.ends_with(extension))
            });
            if !found {
                event.details_available = false;
                budget.note_omitted_detail(&format!("reference-{}", event.diagnostic_id), 1);
            }
        }
        let retained_detail_prefixes = grouped_events
            .iter()
            .filter(|event| event.details_available)
            .map(|event| {
                format!(
                    "details-{}-",
                    event.detail_ref.trim_start_matches("details/")
                )
            })
            .collect::<HashSet<_>>();
        grouped_events.sort_by(|a, b| {
            a.utc_time
                .cmp(&b.utc_time)
                .then_with(|| a.diagnostic_id.cmp(&b.diagnostic_id))
        });
        for event in grouped_events {
            let mut safe = serde_json::to_vec(&event)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            safe.push(b'\n');
            budget.append_event(&safe, &event.process_start_id)?;
        }
        budget.append(b"\nSAFE DETAIL SUMMARY (raw output withheld)\n")?;
        details.sort_by(|a, b| a.name.cmp(&b.name));
        for snapshot in details {
            let source = snapshot.name.clone();
            if snapshot.name.starts_with("details-")
                && !retained_detail_prefixes
                    .iter()
                    .any(|prefix| snapshot.name.starts_with(prefix))
            {
                budget.note_omitted_detail(&source, 1);
                continue;
            }
            let mut categories = BTreeSet::new();
            let visited = visit_lines(snapshot, |line| {
                if let Some(category) = safe_detail_category(line) {
                    categories.insert(category.to_owned());
                }
                Ok(())
            });
            let (lines, incomplete) = match visited {
                Ok((lines, incomplete)) => (lines, incomplete),
                Err(_) => {
                    budget.note_omitted_detail(&source, 1);
                    continue;
                }
            };
            let mut summary = format!("\n[{}]\n", safe_source_label(&source));
            for category in categories {
                summary.push_str(&format!("safe error category: {category}\n"));
            }
            if incomplete {
                summary.push_str("snapshot incomplete; unread tail omitted\n");
                budget.note_omitted_detail(&source, 1);
            }
            summary.push_str(&format!("raw detail lines withheld: {lines}\n"));
            budget.note_omitted_detail(&source, lines as u64);
            budget.append_detail(&source, summary.as_bytes())?;
        }
        for source in gaps.event_sources {
            budget.add_event_source(&source);
        }
        for source in gaps.detail_sources {
            budget.add_detail_source(&source);
        }
        budget.more_event_sources |= gaps.more_event_sources;
        budget.more_detail_sources |= gaps.more_detail_sources;
        budget.omitted_events = budget.omitted_events.saturating_add(gaps.missing_events);
        budget.omitted_details = budget.omitted_details.saturating_add(gaps.missing_details);
        budget.append_footer()?;
        budget.file.flush()
    })();
    if export_result.is_err() {
        drop(output_file);
        let _ = fs::remove_file(&output);
    }
    export_result
}

fn validate_output_path(root: &Path, output: &Path) -> io::Result<PathBuf> {
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = output
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "output filename is required")
        })?;
    if !Path::new(name)
        .components()
        .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid output filename",
        ));
    }
    let parent = fs::canonicalize(parent)?;
    for protected in [root.join("data"), root.join("backups")] {
        if let Ok(protected) = fs::canonicalize(protected) {
            if parent.starts_with(protected) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "diagnostic output cannot be placed in business data or backups",
                ));
            }
        }
    }
    let output = parent.join(name);
    if fs::symlink_metadata(&output).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "diagnostic output already exists",
        ));
    }
    Ok(output)
}

fn capture_log_snapshot(root: &Path) -> (Vec<SnapshotFile>, Vec<SnapshotFile>, SnapshotGaps) {
    let logs = root.join("logs");
    let mut events = Vec::new();
    let mut details = Vec::new();
    let mut gaps = SnapshotGaps::default();
    snapshot_directory(
        &logs.join("diagnostics/events"),
        EVENT_SEGMENT_LIMIT,
        EVENT_TOTAL_LIMIT,
        EVENT_RETENTION,
        &mut events,
        true,
        &mut gaps,
    );
    snapshot_directory(
        &logs.join("diagnostics/details"),
        12 * 1024 * 1024,
        DETAIL_TOTAL_LIMIT,
        DETAIL_RETENTION,
        &mut details,
        false,
        &mut gaps,
    );
    let mut legacy = BinaryHeap::with_capacity(16);
    match fs::read_dir(&logs) {
        Ok(entries) => {
            for (index, entry) in entries.enumerate() {
                if index >= MAX_DIRECTORY_SCAN {
                    note_snapshot_gap(&mut gaps, false, "legacy:[entry limit]");
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        note_snapshot_gap(&mut gaps, false, "legacy:[entry unreadable]");
                        continue;
                    }
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "manager.log"
                    || name == "database.log"
                    || name == "application.log"
                    || name.starts_with("migration-")
                    || name.starts_with("update-")
                {
                    retain_latest_path(&mut legacy, entry.path(), name, 16, "legacy", &mut gaps);
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => note_snapshot_gap(&mut gaps, false, "legacy:[directory unreadable]"),
    }
    for (_, path, name) in take_latest_candidates(legacy) {
        if let Some(snapshot) = snapshot_file(&path, 1024 * 1024) {
            details.push(snapshot);
        } else {
            note_snapshot_gap(
                &mut gaps,
                false,
                &format!("legacy:{}", safe_source_label(&name)),
            );
        }
    }
    let updater_logs = logs.join("updater");
    match fs::read_dir(&updater_logs) {
        Ok(entries) => {
            let mut updater = BinaryHeap::with_capacity(16);
            for (index, entry) in entries.enumerate() {
                if index >= MAX_DIRECTORY_SCAN {
                    note_snapshot_gap(&mut gaps, false, "updater:[entry limit]");
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        note_snapshot_gap(&mut gaps, false, "updater:[entry unreadable]");
                        continue;
                    }
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("update-")
                    && entry.path().extension().is_some_and(|ext| ext == "log")
                {
                    retain_latest_path(&mut updater, entry.path(), name, 16, "updater", &mut gaps);
                }
            }
            for (_, path, name) in take_latest_candidates(updater) {
                if let Some(snapshot) = snapshot_file(&path, 512 * 1024) {
                    details.push(snapshot);
                } else {
                    note_snapshot_gap(
                        &mut gaps,
                        false,
                        &format!("updater:{}", safe_source_label(&name)),
                    );
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => note_snapshot_gap(&mut gaps, false, "updater:[directory unreadable]"),
    }
    (events, details, gaps)
}

fn note_snapshot_gap(gaps: &mut SnapshotGaps, is_event: bool, source: &str) {
    if is_event {
        gaps.missing_events = gaps.missing_events.saturating_add(1);
        add_bounded_source(
            &mut gaps.event_sources,
            &mut gaps.more_event_sources,
            source,
        );
    } else {
        gaps.missing_details = gaps.missing_details.saturating_add(1);
        add_bounded_source(
            &mut gaps.detail_sources,
            &mut gaps.more_detail_sources,
            source,
        );
    }
}

fn retain_latest_path(
    candidates: &mut BinaryHeap<Reverse<(SystemTime, PathBuf, String)>>,
    path: PathBuf,
    name: String,
    limit: usize,
    kind: &str,
    gaps: &mut SnapshotGaps,
) {
    let modified = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {
            metadata.modified().unwrap_or(UNIX_EPOCH)
        }
        _ => {
            note_snapshot_gap(gaps, false, &format!("{kind}:{}", safe_source_label(&name)));
            return;
        }
    };
    let candidate = Reverse((modified, path, name));
    if candidates.len() < limit {
        candidates.push(candidate);
    } else if candidates
        .peek()
        .is_some_and(|oldest| candidate.0 .0.cmp(&oldest.0 .0) == std::cmp::Ordering::Greater)
    {
        if let Some(Reverse((_, _, evicted_name))) = candidates.pop() {
            note_snapshot_gap(
                gaps,
                false,
                &format!("{kind}:{}", safe_source_label(&evicted_name)),
            );
        }
        candidates.push(candidate);
    } else {
        note_snapshot_gap(
            gaps,
            false,
            &format!("{kind}:{}", safe_source_label(&candidate.0 .2)),
        );
    }
}

fn take_latest_candidates(
    candidates: BinaryHeap<Reverse<(SystemTime, PathBuf, String)>>,
) -> Vec<(SystemTime, PathBuf, String)> {
    let mut candidates = candidates
        .into_vec()
        .into_iter()
        .map(|Reverse(candidate)| candidate)
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| Reverse(candidate.0));
    candidates
}

fn snapshot_directory(
    directory: &Path,
    max_file_bytes: u64,
    max_total_bytes: u64,
    retention: Duration,
    output: &mut Vec<SnapshotFile>,
    is_event: bool,
    gaps: &mut SnapshotGaps,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(_) => {
            let kind = if is_event { "events" } else { "details" };
            note_snapshot_gap(gaps, is_event, &format!("{kind}:[directory unreadable]"));
            return;
        }
    };
    let kind = if is_event { "events" } else { "details" };
    let capacity = 256usize.saturating_sub(output.len());
    let mut candidates =
        BinaryHeap::<Reverse<(SystemTime, PathBuf, String)>>::with_capacity(capacity);
    for (index, entry) in entries.enumerate() {
        if index >= MAX_DIRECTORY_SCAN {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:[entry limit]"));
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                note_snapshot_gap(gaps, is_event, &format!("{kind}:[entry unreadable]"));
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !safe_export_filename(&name) {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:[unsafe filename]"));
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str());
        if !matches!(extension, Some("open" | "jsonl" | "logseg")) {
            continue;
        }
        if !is_snapshot_segment(&name, is_event) {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:[unowned filename]"));
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => metadata,
            _ => {
                note_snapshot_gap(gaps, is_event, &format!("{kind}:{name}"));
                continue;
            }
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        if SystemTime::now()
            .duration_since(modified)
            .is_ok_and(|age| age > retention)
        {
            continue;
        }
        if capacity == 0 {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:[snapshot limit]"));
            continue;
        }
        let candidate = Reverse((modified, path, name));
        if candidates.len() < capacity {
            candidates.push(candidate);
        } else if candidates
            .peek()
            .is_some_and(|oldest| candidate.0 .0.cmp(&oldest.0 .0) == std::cmp::Ordering::Greater)
        {
            if let Some(Reverse((_, _, evicted_name))) = candidates.pop() {
                note_snapshot_gap(gaps, is_event, &format!("{kind}:{evicted_name}"));
            }
            candidates.push(candidate);
        } else {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:{}", candidate.0 .2));
        }
    }
    let mut total_bytes = 0u64;
    for (_, path, name) in take_latest_candidates(candidates) {
        if let Some(mut snapshot) = snapshot_file(&path, max_file_bytes) {
            if total_bytes.saturating_add(snapshot.length) > max_total_bytes {
                note_snapshot_gap(gaps, is_event, &format!("{kind}:{name}"));
                continue;
            }
            total_bytes = total_bytes.saturating_add(snapshot.length);
            snapshot.name = name;
            output.push(snapshot);
        } else {
            note_snapshot_gap(gaps, is_event, &format!("{kind}:{name}"));
        }
    }
}

fn snapshot_file(path: &Path, max_file_bytes: u64) -> Option<SnapshotFile> {
    if !safe_export_filename(path.file_name()?.to_str()?) {
        return None;
    }
    let path_metadata = fs::symlink_metadata(path).ok()?;
    if !path_metadata.is_file() || is_reparse(&path_metadata) {
        return None;
    }
    let file = open_snapshot_file(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            return None;
        }
    }
    let full_length = metadata.len();
    let length = full_length.min(max_file_bytes);
    Some(SnapshotFile {
        name: path.file_name()?.to_string_lossy().into_owned(),
        file,
        length,
        truncated: full_length > length,
    })
}

#[cfg(windows)]
fn open_snapshot_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(windows))]
fn open_snapshot_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

fn visit_lines<F>(snapshot: SnapshotFile, mut visit: F) -> io::Result<(usize, bool)>
where
    F: FnMut(&[u8]) -> io::Result<()>,
{
    let mut incomplete = snapshot.truncated;
    let mut reader = BufReader::new(snapshot.file.take(snapshot.length));
    let mut line = Vec::with_capacity(MAX_EVENT_BYTES);
    let mut count = 0usize;
    loop {
        let (has_line, complete, oversized) =
            read_bounded_line(&mut reader, &mut line, MAX_EVENT_BYTES)?;
        if !has_line {
            break;
        }
        if complete && !oversized {
            visit(&line)?;
            count += 1;
        } else {
            incomplete = true;
        }
    }
    if reader.get_ref().limit() > 0 {
        incomplete = true;
    }
    Ok((count, incomplete))
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    limit: usize,
) -> io::Result<(bool, bool, bool)> {
    line.clear();
    let mut oversized = false;
    loop {
        let (consume, newline, add) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                return Ok((!line.is_empty() || oversized, false, oversized));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let end = newline.unwrap_or(available.len());
            let remaining = limit.saturating_sub(line.len());
            let add = end.min(remaining);
            if end > remaining {
                oversized = true;
            }
            (end + usize::from(newline.is_some()), newline.is_some(), add)
        };
        if add > 0 {
            // The buffer is reborrowed only after fill_buf returns above.
            let available = reader.fill_buf()?;
            line.extend_from_slice(&available[..add]);
        }
        reader.consume(consume);
        if newline {
            break;
        }
    }
    Ok((true, true, oversized))
}

fn valid_event(event: &DiagnosticEvent) -> bool {
    event.format_version == FORMAT_VERSION
        && chrono::DateTime::parse_from_rfc3339(&event.utc_time).is_ok()
        && event.event_code.len() <= 96
        && event.phase.len() <= 64
        && event.error_code.len() <= 64
        && event.version.len() <= 48
        && event.detail_ref.len() <= 128
        && (1..=1_000_000).contains(&event.occurrences)
        && event.last_utc_time.as_deref().is_none_or(|value| {
            value.len() <= 40 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
        })
        && event
            .dropped_event_count
            .is_none_or(|value| value <= 1_000_000_000)
        && event
            .dropped_detail_bytes
            .is_none_or(|value| value <= 1_000_000_000_000)
        && event
            .attempts
            .is_none_or(|value| (1..=1000).contains(&value))
        && event.elapsed_ms.is_none_or(|value| value <= 600_000)
        && event.detail_ref.starts_with("details/")
        && !event.detail_ref.contains("..")
        && matches!(
            event.severity.as_str(),
            "info" | "warning" | "error" | "critical"
        )
        && event
            .backup_format
            .as_deref()
            .is_none_or(|format| matches!(format, "ngt-repair-data" | "unknown"))
        && event
            .backup_version
            .is_none_or(|version| (1..=1000).contains(&version))
        && event.record_counts.len() <= BACKUP_SECTIONS.len()
        && event.record_counts.iter().all(|(section, count)| {
            BACKUP_SECTIONS.contains(&section.as_str()) && *count <= 25_000_000
        })
        && [
            &event.event_code,
            &event.phase,
            &event.error_code,
            &event.version,
        ]
        .iter()
        .all(|value| safe_event_token(value))
        && is_safe_identifier(&event.diagnostic_id, 96)
        && is_safe_identifier(&event.operation_id, 64)
        && is_safe_identifier(&event.process_start_id, 96)
        && event
            .detail_ref
            .strip_prefix("details/")
            .is_some_and(safe_event_token)
}

fn merge_repeated_event(first: &mut DiagnosticEvent, next: &DiagnosticEvent) {
    let occurrences = first
        .occurrences
        .saturating_add(next.occurrences.max(1))
        .min(1_000_000);
    let next_last = next.last_utc_time.as_deref().unwrap_or(&next.utc_time);
    let first_last = first.last_utc_time.as_deref().unwrap_or(&first.utc_time);
    let last_utc_time = next_last.max(first_last).to_owned();
    if next.utc_time < first.utc_time {
        *first = next.clone();
    }
    first.occurrences = occurrences;
    first.last_utc_time = Some(last_utc_time);
}

fn event_group_hash(
    event: &DiagnosticEvent,
    state: &std::collections::hash_map::RandomState,
) -> u64 {
    let operation_scope = if event.operation_id == "none" {
        &event.process_start_id
    } else {
        &event.operation_id
    };
    let mut hasher = state.build_hasher();
    event.component.safe_name().hash(&mut hasher);
    event.event_code.hash(&mut hasher);
    event.error_code.hash(&mut hasher);
    event.phase.hash(&mut hasher);
    event.severity.hash(&mut hasher);
    operation_scope.hash(&mut hasher);
    hasher.finish()
}

fn same_event_group(first: &DiagnosticEvent, next: &DiagnosticEvent) -> bool {
    let first_operation = if first.operation_id == "none" {
        first.process_start_id.as_str()
    } else {
        first.operation_id.as_str()
    };
    let next_operation = if next.operation_id == "none" {
        next.process_start_id.as_str()
    } else {
        next.operation_id.as_str()
    };
    first.component == next.component
        && first.event_code == next.event_code
        && first.error_code == next.error_code
        && first.phase == next.phase
        && first.severity == next.severity
        && first_operation == next_operation
}

fn safe_event_token(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn safe_export_filename(value: &str) -> bool {
    value.len() <= 180
        && !value.contains("..")
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

fn is_snapshot_segment(name: &str, is_event: bool) -> bool {
    let path = Path::new(name);
    let extension = path.extension().and_then(|value| value.to_str());
    let stem = path.file_stem().and_then(|value| value.to_str());
    let (prefixes, extensions): (&[&str], &[&str]) = if is_event {
        (
            &[
                "events-manager-db-",
                "events-application-",
                "events-updater-",
            ],
            &["open", "jsonl"],
        )
    } else {
        (
            &[
                "details-database-",
                "details-application-",
                "details-install-migration-",
                "details-updater-",
            ],
            &["open", "logseg"],
        )
    };
    if !extensions.contains(&extension.unwrap_or_default()) {
        return false;
    }
    let Some(stem) = stem else {
        return false;
    };
    prefixes.iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.split('-').count() >= 3
                && suffix.split('-').all(|part| !part.is_empty())
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    })
}

fn is_owned_segment(name: &str, prefix: &str, closed_extension: &str) -> bool {
    if !safe_export_filename(name) {
        return false;
    }
    let path = Path::new(name);
    let extension = path.extension().and_then(|value| value.to_str());
    if extension != Some("open") && extension != Some(closed_extension) {
        return false;
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .and_then(|stem| stem.strip_prefix(prefix))
        .is_some_and(|suffix| {
            suffix.starts_with('-')
                && suffix[1..].split('-').count() >= 3
                && suffix[1..].split('-').all(|part| !part.is_empty())
                && suffix[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn safe_source_label(value: &str) -> String {
    if value.starts_with("reference-") {
        return "event detail reference".to_owned();
    }
    if value.starts_with("legacy:")
        || value.starts_with("manager.log")
        || value.starts_with("database.log")
        || value.starts_with("application.log")
    {
        return "legacy log".to_owned();
    }
    if value.starts_with("updater:") {
        return "legacy updater log".to_owned();
    }
    if value.starts_with("events:") {
        return "event segments".to_owned();
    }
    if value.starts_with("details:") {
        return "detail segments".to_owned();
    }
    for prefix in [
        "events-manager-db-",
        "events-application-",
        "events-updater-",
        "details-database-",
        "details-application-",
        "details-install-migration-",
        "details-updater-",
    ] {
        if value.starts_with(prefix) {
            return format!("{} segment", prefix.trim_end_matches('-'));
        }
    }
    "diagnostic source".to_owned()
}

const BACKUP_SECTIONS: &[&str] = &[
    "customers",
    "phones",
    "devices",
    "orders",
    "items",
    "payments",
    "histories",
    "prices",
    "priceOptions",
    "faults",
    "audits",
    "products",
    "inventoryMovements",
    "retailSales",
    "retailSaleItems",
    "paymentAllocations",
    "workOrderProducts",
    "workOrderFaults",
    "reworkSessions",
    "reworkItems",
    "deviceCatalogDeletions",
    "productCompatibilities",
    "quickServices",
    "retailServiceItems",
    "workOrderDevices",
    "inventoryCategories",
    "businessClock",
];

fn safe_record_counts(counts: BTreeMap<String, u32>) -> BTreeMap<String, u32> {
    counts
        .into_iter()
        .filter(|(section, count)| {
            BACKUP_SECTIONS.contains(&section.as_str()) && *count <= 25_000_000
        })
        .collect()
}

fn safe_detail_category(line: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(line).to_ascii_lowercase();
    if text.contains("eaddrinuse") || text.contains("address already in use") {
        Some("PORT_IN_USE")
    } else if text.contains("access is denied")
        || text.contains("permission denied")
        || text.contains("operation not permitted")
        || text.contains("eacces")
        || text.contains("eperm")
        || text.contains("win32_5")
    {
        Some("ACCESS_DENIED")
    } else if text.contains("cannot find module") || text.contains("module_not_found") {
        Some("MODULE_MISSING")
    } else if text.contains("enoent")
        || text.contains("file not found")
        || text.contains("cannot find the path")
        || text.contains("system cannot find the file specified")
    {
        Some("COMPONENT_MISSING")
    } else if text.contains("database did not start") || text.contains("econnrefused") {
        Some("DATABASE_UNAVAILABLE")
    } else if text.contains("p1001") {
        Some("PRISMA_P1001")
    } else if text.contains("p1002") {
        Some("PRISMA_P1002")
    } else if text.contains("p2002") {
        Some("PRISMA_P2002")
    } else if text.contains("p2003") {
        Some("PRISMA_P2003")
    } else if text.contains("no space left") || text.contains("disk full") {
        Some("DISK_FULL")
    } else if text.contains("winerror 32")
        || text.contains("win32_32")
        || text.contains("error_sharing_violation")
        || text.contains("sharing violation")
    {
        Some("FILE_IN_USE")
    } else {
        None
    }
}

struct ExportBudget<'a> {
    file: &'a mut File,
    written: u64,
    omitted_events: u64,
    omitted_details: u64,
    omitted_event_sources: BTreeSet<String>,
    omitted_detail_sources: BTreeSet<String>,
    export_limited_detail_sources: BTreeSet<String>,
    more_event_sources: bool,
    more_detail_sources: bool,
    more_export_limited_details: bool,
}

impl ExportBudget<'_> {
    fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let limit = EXPORT_LIMIT - EXPORT_FOOTER_RESERVE as u64;
        if self.written.saturating_add(bytes.len() as u64) > limit {
            return Ok(());
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    fn append_event(&mut self, bytes: &[u8], source: &str) -> io::Result<()> {
        let limit = EXPORT_LIMIT - EXPORT_FOOTER_RESERVE as u64;
        if self.written.saturating_add(bytes.len() as u64) > limit {
            self.omitted_events = self.omitted_events.saturating_add(1);
            self.add_event_source(source);
            return Ok(());
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    fn append_detail(&mut self, source: &str, bytes: &[u8]) -> io::Result<()> {
        let limit = EXPORT_LIMIT - EXPORT_FOOTER_RESERVE as u64;
        if self.written.saturating_add(bytes.len() as u64) > limit {
            add_bounded_source(
                &mut self.export_limited_detail_sources,
                &mut self.more_export_limited_details,
                source,
            );
            self.add_detail_source(source);
            return Ok(());
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    fn note_omitted_event(&mut self, source: &str, count: u64) {
        self.omitted_events = self.omitted_events.saturating_add(count);
        self.add_event_source(source);
    }

    fn note_omitted_detail(&mut self, source: &str, count: u64) {
        self.omitted_details = self.omitted_details.saturating_add(count);
        self.add_detail_source(source);
    }

    fn add_event_source(&mut self, source: &str) {
        add_bounded_source(
            &mut self.omitted_event_sources,
            &mut self.more_event_sources,
            source,
        );
    }

    fn add_detail_source(&mut self, source: &str) {
        add_bounded_source(
            &mut self.omitted_detail_sources,
            &mut self.more_detail_sources,
            source,
        );
    }

    fn append_footer(&mut self) -> io::Result<()> {
        let mut footer = format!(
            "\nINCOMPLETE / OMITTED\nMissing, corrupt, or export-omitted event records: {}\nDetail lines withheld or unavailable: {}\n",
            self.omitted_events, self.omitted_details
        );
        append_source_list(
            &mut footer,
            "Event sources",
            &self.omitted_event_sources,
            self.more_event_sources,
        );
        append_source_list(
            &mut footer,
            "Detail sources with withheld or missing content",
            &self.omitted_detail_sources,
            self.more_detail_sources,
        );
        append_source_list(
            &mut footer,
            "Detail summaries omitted by the 15 MiB export limit",
            &self.export_limited_detail_sources,
            self.more_export_limited_details,
        );
        if footer.len() > EXPORT_FOOTER_RESERVE {
            footer.truncate(EXPORT_FOOTER_RESERVE);
        }
        if self.written.saturating_add(footer.len() as u64) > EXPORT_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "diagnostic export footer exceeded its reserved space",
            ));
        }
        self.file.write_all(footer.as_bytes())?;
        self.written += footer.len() as u64;
        Ok(())
    }
}

fn add_bounded_source(sources: &mut BTreeSet<String>, more: &mut bool, source: &str) {
    let source = safe_source_label(source);
    if sources.contains(&source) {
        return;
    }
    if sources.len() < MAX_OMITTED_SOURCES_PER_KIND {
        sources.insert(source);
    } else {
        *more = true;
    }
}

fn append_source_list(output: &mut String, title: &str, sources: &BTreeSet<String>, more: bool) {
    if sources.is_empty() && !more {
        return;
    }
    output.push_str(title);
    output.push_str(":\n");
    for source in sources {
        output.push_str("- ");
        output.push_str(source);
        output.push('\n');
    }
    if more {
        output.push_str("- additional sources omitted\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ngt-diagnostics-{label}-{}", unique_test_id()))
    }

    fn unique_test_id() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }

    #[test]
    fn structured_events_are_bounded_and_fields_are_sanitized() {
        let root = temp_root("event");
        let logs = LogSession::start(&root, "install-01", "2.1.0", LogOwner::Manager).unwrap();
        let id = logs.record(
            Component::Manager,
            "error",
            "install.failed; C:\\secret\\user",
            "candidate-validation",
            "WIN32_5",
        );
        drop(logs);
        let (events, _, _) = capture_log_snapshot(&root);
        assert_eq!(events.len(), 1);
        drop(events);
        assert!(id.ends_with("-1"));
        let paths = fs::read_dir(root.join("logs/diagnostics/events")).unwrap();
        let first = paths.flatten().next().unwrap().path();
        let event = fs::read_to_string(first).unwrap();
        assert!(event.len() <= MAX_EVENT_BYTES);
        assert!(event.contains("diagnostic.unknown"));
        assert!(!event.contains("secret"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_omits_info_events_but_keeps_warnings_and_failures() {
        let root = temp_root("event-severity");
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        logs.record(
            Component::Manager,
            "info",
            "manager.state",
            "runtime",
            "none",
        );
        logs.record(
            Component::Manager,
            "warning",
            "diagnostics.recording_incomplete",
            "recording",
            "EVENT_QUEUE_DROPPED",
        );
        logs.record(
            Component::Manager,
            "error",
            "manager.operation.failed",
            "install",
            "ACCESS_DENIED",
        );
        logs.finish();

        export_diagnostics(&root, &output).unwrap();
        let contents = fs::read_to_string(&output).unwrap();
        assert!(!contents.contains("manager.state"));
        assert!(contents.contains("diagnostics.recording_incomplete"));
        assert!(contents.contains("manager.operation.failed"));

        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_groups_repeat_failures_and_preserves_the_first_event_id() {
        let root = temp_root("repeat");
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        let first_id = logs.record(
            Component::Database,
            "error",
            "database.readiness.failed",
            "connection-check",
            "ECONNREFUSED",
        );
        logs.detail(Component::Database, b"ECONNREFUSED\n");
        logs.record(
            Component::Database,
            "error",
            "database.readiness.failed",
            "connection-check",
            "ECONNREFUSED",
        );
        logs.detail(Component::Database, b"disk full\n");
        logs.finish();

        export_diagnostics(&root, &output).unwrap();
        let contents = fs::read_to_string(&output).unwrap();
        let event: DiagnosticEvent = contents
            .lines()
            .find(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str(line).unwrap())
            .unwrap();
        assert_eq!(event.diagnostic_id, first_id);
        assert_eq!(event.occurrences, 2);
        assert!(event.last_utc_time.is_some());
        assert!(contents.contains("DATABASE_UNAVAILABLE"));
        assert!(!contents.contains("DISK_FULL"));

        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_diagnostic_ids_keep_the_first_event_and_increment_occurrences() {
        let root = temp_root("duplicate-id");
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        let lines = b"NGT_DIAGNOSTIC:{\"formatVersion\":1,\"diagnosticId\":\"12345678-1234-1234-1234-123456789abc\",\"component\":\"backup-import\",\"severity\":\"error\",\"eventCode\":\"backup_import.failed\",\"phase\":\"transaction\",\"errorCode\":\"BACKUP_IMPORT_FAILED\"}\nNGT_DIAGNOSTIC:{\"formatVersion\":1,\"diagnosticId\":\"12345678-1234-1234-1234-123456789abc\",\"component\":\"backup-import\",\"severity\":\"error\",\"eventCode\":\"backup_import.client_failed\",\"phase\":\"request\",\"errorCode\":\"IMPORT_REQUEST_FAILED\"}\n";
        logs.attach_reader(io::Cursor::new(lines), Component::Application)
            .unwrap();
        logs.finish();

        export_diagnostics(&root, &output).unwrap();
        let contents = fs::read_to_string(&output).unwrap();
        let events = contents
            .lines()
            .filter(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str::<DiagnosticEvent>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_code, "backup_import.failed");
        assert_eq!(events[0].occurrences, 2);

        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failure_details_are_linked_by_diagnostic_id_and_raw_text_is_withheld() {
        let root = temp_root("detail-link");
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        logs.detail(Component::Database, b"listen EADDRINUSE password=secret\n");
        let id = logs.record(
            Component::Database,
            "error",
            "database.readiness.failed",
            "connection-check",
            "ECONNREFUSED",
        );
        logs.finish();

        export_diagnostics(&root, &output).unwrap();
        let contents = fs::read_to_string(&output).unwrap();
        let event: DiagnosticEvent = contents
            .lines()
            .find(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str(line).unwrap())
            .unwrap();
        assert_eq!(event.diagnostic_id, id);
        assert!(event.details_available);
        assert_eq!(event.detail_ref, format!("details/database-{id}"));
        assert!(contents.contains("PORT_IN_USE"));
        assert!(!contents.contains("password=secret"));

        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detail_write_failure_marks_the_related_event_unavailable() {
        let root = temp_root("detail-write-failure");
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        let id = logs.record(
            Component::Database,
            "error",
            "database.readiness.failed",
            "connection-check",
            "ECONNREFUSED",
        );
        let details = root.join("logs/diagnostics/details");
        fs::remove_dir(&details).unwrap();
        fs::write(&details, b"simulate an unwritable detail store").unwrap();
        logs.detail(Component::Database, b"database did not start\n");
        logs.finish();

        export_diagnostics(&root, &output).unwrap();
        let contents = fs::read_to_string(&output).unwrap();
        let event: DiagnosticEvent = contents
            .lines()
            .filter(|line| line.starts_with('{'))
            .map(|line| serde_json::from_str(line).unwrap())
            .find(|event: &DiagnosticEvent| event.diagnostic_id == id)
            .unwrap();
        assert!(!event.details_available);
        assert!(contents.contains("diagnostics.recording_incomplete"));
        assert!(contents.contains("Detail lines withheld or unavailable:"));
        assert!(contents.contains("Detail sources with withheld or missing content:"));

        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_event_uses_process_operation_and_shared_sequence() {
        let json = b"NGT_DIAGNOSTIC:{\"formatVersion\":1,\"diagnosticId\":\"12345678-1234-1234-1234-123456789abc\",\"component\":\"database\",\"severity\":\"error\",\"eventCode\":\"database.readiness.failed\",\"phase\":\"connection-check\",\"errorCode\":\"ECONNREFUSED\",\"attempts\":12,\"elapsedMs\":2500,\"droppedDetailBytes\":512}\n";
        let (sender, receiver) = mpsc::sync_channel(4);
        drain_reader(
            io::Cursor::new(json),
            ReaderContext {
                sender,
                component: Component::Manager,
                dropped_events: std::sync::Arc::new(AtomicU64::new(0)),
                dropped_detail_bytes: std::sync::Arc::new(AtomicU64::new(0)),
                writer_failed: std::sync::Arc::new(AtomicBool::new(false)),
                run_id: "run-1".to_owned(),
                operation_id: std::sync::Arc::new(Mutex::new("install-01".to_owned())),
                version: "2.1.0".to_owned(),
                sequence: std::sync::Arc::new(AtomicU64::new(1)),
                started: None,
            },
        );
        let Message::Event(event) = receiver.try_recv().unwrap() else {
            panic!("expected structured diagnostic event");
        };
        assert_eq!(event.operation_id, "install-01");
        assert_eq!(event.process_sequence, 1);
        assert_eq!(event.attempts, Some(12));
        assert_eq!(event.elapsed_ms, Some(2500));
        assert_eq!(event.dropped_detail_bytes, Some(512));
        assert!(!event.details_available);
    }

    #[test]
    fn export_is_no_overwrite_bounded_and_withholds_raw_log_content() {
        let root = temp_root("export");
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(
            root.join("logs/application.log"),
            "password=private-value\nlisten EADDRINUSE\n",
        )
        .unwrap();
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        export_diagnostics(&root, &output).unwrap();
        let result = fs::read_to_string(&output).unwrap();
        assert!(result.contains("PORT_IN_USE"));
        assert!(!result.contains("private-value"));
        assert!(export_diagnostics(&root, &output).is_err());
        assert!(fs::metadata(&output).unwrap().len() <= EXPORT_LIMIT);
        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_limit_footer_names_detail_sources_without_raw_content() {
        let path = std::env::temp_dir().join(format!(
            "NGTManager-diagnostics-limit-{}.txt",
            unique_test_id()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let mut budget = ExportBudget {
            file: &mut file,
            written: EXPORT_LIMIT - EXPORT_FOOTER_RESERVE as u64,
            omitted_events: 0,
            omitted_details: 0,
            omitted_event_sources: BTreeSet::new(),
            omitted_detail_sources: BTreeSet::new(),
            export_limited_detail_sources: BTreeSet::new(),
            more_event_sources: false,
            more_detail_sources: false,
            more_export_limited_details: false,
        };

        budget
            .append_detail(
                "details-application-run-000001.logseg",
                b"private raw output",
            )
            .unwrap();
        budget.append_footer().unwrap();
        drop(budget);

        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("Detail summaries omitted by the 15 MiB export limit"));
        assert!(contents.contains("details-application segment"));
        assert!(!contents.contains("private raw output"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn incomplete_jsonl_tail_is_omitted() {
        let root = temp_root("tail");
        let events = root.join("logs/diagnostics/events");
        fs::create_dir_all(&events).unwrap();
        fs::write(
            events.join("events-manager-db-123-456-000001.open"),
            b"{\"broken\":",
        )
        .unwrap();
        let output =
            std::env::temp_dir().join(format!("NGTManager-diagnostics-{}.txt", unique_test_id()));
        export_diagnostics(&root, &output).unwrap();
        let result = fs::read_to_string(&output).unwrap();
        assert!(result.contains("Missing, corrupt, or export-omitted event records: 1"));
        assert!(result.contains("Event sources:"));
        assert!(!result.contains("broken"));
        let _ = fs::remove_file(output);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_reads_only_the_length_captured_before_later_output() {
        let root = temp_root("snapshot-length");
        let path = root.join("segment.open");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, b"first line\n").unwrap();
        let snapshot = snapshot_file(&path, 1024).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"later line\n")
            .unwrap();

        let mut lines = Vec::new();
        let (count, incomplete) = visit_lines(snapshot, |line| {
            lines.push(String::from_utf8_lossy(line).into_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(count, 1);
        assert!(!incomplete);
        assert_eq!(lines, vec!["first line".to_owned()]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_keeps_a_fixed_snapshot_when_a_segment_rotates() {
        let root = temp_root("snapshot-rotation");
        let events = root.join("logs/diagnostics/events");
        fs::create_dir_all(&events).unwrap();
        let open = events.join("events-manager-db-123-456-000001.open");
        let closed = open.with_extension("jsonl");
        fs::write(&open, b"first line\n").unwrap();
        let snapshot = snapshot_file(&open, 1024).unwrap();
        fs::rename(&open, &closed).unwrap();

        let mut lines = Vec::new();
        let (count, incomplete) = visit_lines(snapshot, |line| {
            lines.push(String::from_utf8_lossy(line).into_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(count, 1);
        assert!(!incomplete);
        assert_eq!(lines, vec!["first line".to_owned()]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_shrink_is_reported_as_incomplete() {
        let root = temp_root("snapshot-shrink");
        let path = root.join("segment.open");
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, b"first line\nsecond line\n").unwrap();
        let snapshot = snapshot_file(&path, 1024).unwrap();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(0)
            .unwrap();

        let (_, incomplete) = visit_lines(snapshot, |_| Ok(())).unwrap();
        assert!(incomplete);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn log_owner_cleans_only_its_own_source_quotas() {
        let root = temp_root("owner-quota");
        let updater_segment = root
            .join("logs/diagnostics/events")
            .join("events-updater-123-456-000001.jsonl");
        fs::create_dir_all(updater_segment.parent().unwrap()).unwrap();
        File::create(&updater_segment)
            .unwrap()
            .set_len(3 * 1024 * 1024)
            .unwrap();

        let manager = LogSession::start(&root, "manager-test", "2.1.0", LogOwner::Manager).unwrap();
        manager.finish();
        assert!(updater_segment.exists());

        let updater = LogSession::start(&root, "updater-test", "2.1.0", LogOwner::Updater).unwrap();
        updater.finish();
        assert!(!updater_segment.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_seals_unlocked_open_segments_after_a_crash() {
        let root = temp_root("abandoned-segment");
        let events = root.join("logs/diagnostics/events");
        fs::create_dir_all(&events).unwrap();
        let open = events.join("events-manager-db-123-456-000001.open");
        let sealed = open.with_extension("jsonl");
        fs::write(&open, b"{\"unfinished\":").unwrap();

        cleanup_segments(&events, "events-manager-db", "jsonl", 5 * 1024 * 1024, 0).unwrap();

        assert!(!open.exists());
        assert_eq!(fs::read(&sealed).unwrap(), b"{\"unfinished\":");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_failure_keeps_earliest_event_and_detail_reference() {
        let make_event = |id: &str, time: &str, detail_ref: &str| DiagnosticEvent {
            format_version: FORMAT_VERSION,
            diagnostic_id: id.to_owned(),
            utc_time: time.to_owned(),
            component: Component::Database,
            severity: "error".to_owned(),
            event_code: "database.readiness.failed".to_owned(),
            operation_id: "install-01".to_owned(),
            process_start_id: "process-01".to_owned(),
            process_sequence: 1,
            version: "2.1.0".to_owned(),
            phase: "connection-check".to_owned(),
            error_code: "DATABASE_UNAVAILABLE".to_owned(),
            detail_ref: detail_ref.to_owned(),
            details_available: true,
            occurrences: 1,
            last_utc_time: None,
            attempts: None,
            elapsed_ms: None,
            dropped_event_count: None,
            dropped_detail_bytes: None,
            log_writer_failed: None,
            backup_format: None,
            backup_version: None,
            record_counts: BTreeMap::new(),
        };
        let mut first = make_event("later", "2026-11-07T10:00:00Z", "details/database-later");
        let earlier = make_event(
            "earlier",
            "2026-11-07T09:00:00Z",
            "details/database-earlier",
        );

        merge_repeated_event(&mut first, &earlier);

        assert_eq!(first.diagnostic_id, "earlier");
        assert_eq!(first.detail_ref, "details/database-earlier");
        assert_eq!(first.occurrences, 2);
        assert_eq!(first.last_utc_time.as_deref(), Some("2026-11-07T10:00:00Z"));
    }

    #[test]
    fn child_reader_drops_when_queue_is_full_and_keeps_draining() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let dropped_events = std::sync::Arc::new(AtomicU64::new(0));
        let dropped_detail = std::sync::Arc::new(AtomicU64::new(0));
        let mut reader = io::Cursor::new(vec![b'x'; READ_BUFFER_BYTES * 4]);
        drain_reader(
            &mut reader,
            ReaderContext {
                sender,
                component: Component::Application,
                dropped_events: dropped_events.clone(),
                dropped_detail_bytes: dropped_detail.clone(),
                writer_failed: std::sync::Arc::new(AtomicBool::new(false)),
                run_id: "run".to_owned(),
                operation_id: std::sync::Arc::new(Mutex::new("op".to_owned())),
                version: "1.0".to_owned(),
                sequence: std::sync::Arc::new(AtomicU64::new(1)),
                started: None,
            },
        );
        assert_eq!(dropped_events.load(Ordering::Relaxed), 0);
        assert!(dropped_detail.load(Ordering::Relaxed) > 0);
        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn child_reader_keeps_draining_after_the_log_store_fails() {
        let root = temp_root("writer-failure-drain");
        let events = root.join("logs/diagnostics/events");
        fs::create_dir_all(&events).unwrap();
        let active = events.join("events-manager-db-123-456-000001.open");
        let held = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(active)
            .unwrap();
        held.set_len(5 * 1024 * 1024).unwrap();
        held.try_lock_exclusive().unwrap();

        let logs = LogSession::start(&root, "operation-1", "2.1.0", LogOwner::Manager).unwrap();
        logs.record(
            Component::Manager,
            "error",
            "manager.operation.failed",
            "install",
            "ACCESS_DENIED",
        );
        logs.attach_reader(
            io::Cursor::new(vec![b'x'; READ_BUFFER_BYTES * 4]),
            Component::Manager,
        )
        .unwrap();
        logs.finish();

        assert!(logs.recording_failed());
        assert!(logs.dropped_detail_bytes.load(Ordering::Relaxed) > 0);
        drop(held);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_detail_context_keeps_only_the_most_recent_bounded_bytes() {
        let mut pending = VecDeque::new();
        assert_eq!(
            append_pending_detail(&mut pending, &vec![b'a'; READ_BUFFER_BYTES]),
            0
        );
        assert_eq!(append_pending_detail(&mut pending, b"last"), 4);
        assert_eq!(pending.len(), READ_BUFFER_BYTES);
        let tail = pending
            .iter()
            .skip(READ_BUFFER_BYTES - 4)
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(tail.as_slice(), b"last");
    }
}
