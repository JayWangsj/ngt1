use chrono::{DateTime, SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::mpsc::{self, Receiver, TryRecvError};
#[cfg(windows)]
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const WARMUP_SECONDS: u64 = 120;
pub const SAMPLE_SECONDS: u64 = 600;
pub const SAMPLE_INTERVAL_SECONDS: u64 = 2;
pub const PLANNED_SAMPLES: usize = 300;
pub const REQUIRED_COMPLETE_SAMPLES: usize = 270;
pub const REQUIRED_WINDOW_SAMPLES: usize = 54;
const MAX_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REPORT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_PROCESSES_PER_POINT: usize = 64;
const IO_BUFFER_BYTES: usize = 64 * 1024;
const REQUEST_RETENTION_SECONDS: i64 = 24 * 60 * 60;
const MAX_SAVE_SECONDS: u64 = 30;

#[cfg(windows)]
pub fn run_external(
    root_pid: u32,
    output_directory: &Path,
    warmup_seconds: u64,
    sample_seconds: u64,
    interval_seconds: u64,
    expected_manager: &Path,
    software_version: &str,
) -> Result<String, String> {
    use std::time::{Duration, Instant};

    if root_pid == 0
        || warmup_seconds > 3600
        || sample_seconds == 0
        || sample_seconds > 3600
        || interval_seconds == 0
        || interval_seconds > 60
    {
        return Err("EXTERNAL_SAMPLE_ARGUMENT_INVALID".to_owned());
    }
    fs::create_dir_all(output_directory)
        .map_err(|_| "EXTERNAL_OUTPUT_DIRECTORY_UNAVAILABLE".to_owned())?;
    let samples_path = output_directory.join("samples.csv");
    let processes_path = output_directory.join("processes.csv");
    let summary_path = output_directory.join("summary.txt");
    let samples_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&samples_path)
        .map_err(|_| "EXTERNAL_OUTPUT_ALREADY_EXISTS".to_owned())?;
    let processes_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&processes_path)
    {
        Ok(file) => file,
        Err(_) => {
            let _ = fs::remove_file(&samples_path);
            return Err("EXTERNAL_OUTPUT_ALREADY_EXISTS".to_owned());
        }
    };
    let mut samples = BufWriter::with_capacity(IO_BUFFER_BYTES, samples_file);
    let mut processes = BufWriter::with_capacity(IO_BUFFER_BYTES, processes_file);
    writeln!(samples, "sampleId,plannedSeconds,actualTimeUtc,discoveredProcesses,readProcesses,workingSetMiB,privateBytesMiB,complete,missingReason")
        .map_err(|_| "EXTERNAL_OUTPUT_WRITE_FAILED".to_owned())?;
    writeln!(
        processes,
        "sampleId,name,pid,parentPid,creationTimeUtc,workingSetMiB,privateBytesMiB,readStatus"
    )
    .map_err(|_| "EXTERNAL_OUTPUT_WRITE_FAILED".to_owned())?;

    let start = Instant::now();
    let sampling_start = start + Duration::from_secs(warmup_seconds);
    while Instant::now() < sampling_start {
        std::thread::sleep((sampling_start - Instant::now()).min(Duration::from_secs(1)));
    }
    let sampling_start_utc = now_utc();
    let planned_count = sample_seconds.div_ceil(interval_seconds) as usize;
    let mut summaries = Vec::with_capacity(planned_count.min(1800));
    let mut root_creation_time: Option<String> = None;

    for index in 0..planned_count {
        let planned_seconds = index as u64 * interval_seconds;
        if planned_seconds >= sample_seconds {
            break;
        }
        let due = sampling_start + Duration::from_secs(planned_seconds);
        if Instant::now() < due {
            std::thread::sleep(due - Instant::now());
        }
        let late_ms = Instant::now().saturating_duration_since(due).as_millis();
        let sample_id = index + 1;
        let summary = if late_ms >= 1000 {
            SampleSummary {
                sample_id,
                planned_seconds,
                actual_time_utc: None,
                discovered_processes: 0,
                read_processes: 0,
                working_set_bytes: 0,
                private_bytes: 0,
                complete: false,
                missing_reason: Some("SAMPLE_MISSED".to_owned()),
            }
        } else {
            let begin = Instant::now();
            let collection =
                collect_external_process_tree(root_pid, expected_manager, &mut root_creation_time)?;
            let readings = collection.processes;
            let read_processes = readings
                .iter()
                .filter(|process| process.read_status == "ok")
                .count();
            let working_set_bytes = readings
                .iter()
                .filter_map(|item| item.working_set_bytes)
                .sum();
            let private_bytes = readings.iter().filter_map(|item| item.private_bytes).sum();
            let within_budget = begin.elapsed() <= Duration::from_secs(1);
            let complete =
                collection.complete && within_budget && read_processes == collection.discovered;
            let summary = SampleSummary {
                sample_id,
                planned_seconds,
                actual_time_utc: Some(now_utc()),
                discovered_processes: collection.discovered,
                read_processes,
                working_set_bytes,
                private_bytes,
                complete,
                missing_reason: if complete {
                    None
                } else if !within_budget {
                    Some("SAMPLE_BUDGET_EXCEEDED".to_owned())
                } else {
                    collection.error_code
                },
            };
            for process in readings {
                writeln!(
                    processes,
                    "{},{},{},{},{},{},{},{}",
                    sample_id,
                    csv(&process.name),
                    process.pid,
                    process.parent_pid,
                    csv(process.creation_time_utc.as_deref().unwrap_or("")),
                    process.working_set_bytes.map(mib_value).unwrap_or_default(),
                    process.private_bytes.map(mib_value).unwrap_or_default(),
                    csv(&process.read_status),
                )
                .map_err(|_| "EXTERNAL_OUTPUT_WRITE_FAILED".to_owned())?;
            }
            summary
        };
        writeln!(
            samples,
            "{},{},{},{},{},{},{},{},{}",
            summary.sample_id,
            summary.planned_seconds,
            csv(summary.actual_time_utc.as_deref().unwrap_or("")),
            summary.discovered_processes,
            summary.read_processes,
            mib_value(summary.working_set_bytes),
            mib_value(summary.private_bytes),
            summary.complete,
            csv(summary.missing_reason.as_deref().unwrap_or("")),
        )
        .map_err(|_| "EXTERNAL_OUTPUT_WRITE_FAILED".to_owned())?;
        samples
            .flush()
            .and_then(|_| processes.flush())
            .map_err(|_| "EXTERNAL_OUTPUT_WRITE_FAILED".to_owned())?;
        summaries.push(summary);
    }
    drop(samples);
    drop(processes);
    let completed = summaries
        .iter()
        .filter(|item| item.complete)
        .collect::<Vec<_>>();
    let private = completed
        .iter()
        .map(|item| item.private_bytes)
        .collect::<Vec<_>>();
    let working = completed
        .iter()
        .map(|item| item.working_set_bytes)
        .collect::<Vec<_>>();
    let first_window_end = utc_boundary(&sampling_start_utc, 120);
    let last_window_start = utc_boundary(&sampling_start_utc, sample_seconds.saturating_sub(120));
    let sampling_end = utc_boundary(&sampling_start_utc, sample_seconds);
    let first_window = completed
        .iter()
        .filter(|item| {
            timestamp_in_window(
                item.actual_time_utc.as_deref(),
                Some(&sampling_start_utc),
                first_window_end.as_deref(),
            )
        })
        .map(|item| item.private_bytes)
        .collect::<Vec<_>>();
    let last_window = completed
        .iter()
        .filter(|item| {
            timestamp_in_window(
                item.actual_time_utc.as_deref(),
                last_window_start.as_deref(),
                sampling_end.as_deref(),
            )
        })
        .map(|item| item.private_bytes)
        .collect::<Vec<_>>();
    let comparable = sample_seconds == SAMPLE_SECONDS
        && completed.len() >= REQUIRED_COMPLETE_SAMPLES
        && first_window.len() >= REQUIRED_WINDOW_SAMPLES
        && last_window.len() >= REQUIRED_WINDOW_SAMPLES;
    let mut summary = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&summary_path)
        .map_err(|_| "EXTERNAL_SUMMARY_CREATE_FAILED".to_owned())?;
    writeln!(summary, "NGTManager external memory sample\nSoftware version: {software_version}\nWindows: {}\nRoot PID: {root_pid}\nWarmup seconds: {warmup_seconds}\nSampling started at UTC: {sampling_start_utc}\nSampling seconds: {sample_seconds}\nInterval seconds: {interval_seconds}\nPlanned samples: {planned_count}\nComplete / incomplete / missed: {} / {} / {}\nPrivate Bytes median / P95 / peak MiB: {} / {} / {}\nWorking Set median / P95 / peak MiB: {} / {} / {}\nEarly / late Private Bytes median MiB: {} / {}\nVersion-comparison quality: {}\nNote: Peaks shorter than the sampling interval may be missed.\nCSV: samples.csv, processes.csv",
        windows_version(),
        completed.len(),
        summaries.iter().filter(|item| !item.complete && item.missing_reason.as_deref() != Some("SAMPLE_MISSED")).count(),
        summaries.iter().filter(|item| item.missing_reason.as_deref() == Some("SAMPLE_MISSED")).count(),
        mib_stat(median(&private)),
        mib_stat(percentile95(&private)),
        mib_stat(private.iter().copied().max()),
        mib_stat(median(&working)),
        mib_stat(percentile95(&working)),
        mib_stat(working.iter().copied().max()),
        mib_stat(median(&first_window)),
        mib_stat(median(&last_window)),
        if comparable { "comparable" } else { "not comparable; repeat a full sample" },
    )
    .and_then(|_| summary.sync_all())
    .map_err(|_| "EXTERNAL_SUMMARY_WRITE_FAILED".to_owned())?;
    Ok(output_directory.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
pub fn run_external(
    _root_pid: u32,
    _output_directory: &Path,
    _warmup_seconds: u64,
    _sample_seconds: u64,
    _interval_seconds: u64,
    _expected_manager: &Path,
    _software_version: &str,
) -> Result<String, String> {
    Err("WINDOWS_ONLY".to_owned())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySampleStatus {
    pub format_version: u8,
    pub request_id: String,
    pub task_id: Option<String>,
    pub software_version: String,
    pub phase: String,
    pub started_at_utc: String,
    pub updated_at_utc: String,
    pub expires_at_utc: String,
    pub elapsed_seconds: u64,
    pub planned_samples: usize,
    pub recorded_samples: usize,
    pub complete_samples: usize,
    pub incomplete_samples: usize,
    pub missed_samples: usize,
    pub report_path: Option<String>,
    #[serde(default)]
    pub expected_report_path: Option<String>,
    pub ended_reason: Option<String>,
    pub error_code: Option<String>,
    pub details_limited: bool,
}

impl MemorySampleStatus {
    fn active(&self) -> bool {
        matches!(
            self.phase.as_str(),
            "queued" | "preparing" | "warmup" | "sampling" | "saving"
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleSummary {
    sample_id: usize,
    planned_seconds: u64,
    actual_time_utc: Option<String>,
    discovered_processes: usize,
    read_processes: usize,
    working_set_bytes: u64,
    private_bytes: u64,
    complete: bool,
    missing_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessReading {
    name: String,
    pid: u32,
    parent_pid: u32,
    creation_time_utc: Option<String>,
    working_set_bytes: Option<u64>,
    private_bytes: Option<u64>,
    read_status: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleRecord {
    summary: SampleSummary,
    processes: Vec<ProcessReading>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingRequest {
    request_id: String,
    created_at_utc: String,
}

fn store_dir(root: &Path) -> PathBuf {
    root.join("state").join("runtime").join("memory-sampling")
}

fn pending_dir(root: &Path) -> PathBuf {
    store_dir(root).join("pending")
}

fn request_status_path(root: &Path, request_id: &str) -> PathBuf {
    store_dir(root)
        .join("requests")
        .join(format!("{request_id}.json"))
}

fn record_path(root: &Path, task_id: &str) -> PathBuf {
    store_dir(root).join(format!("{task_id}.jsonl"))
}

#[cfg(windows)]
fn expected_report_path(task_id: &str) -> Option<String> {
    documents_path().ok().map(|documents| {
        documents
            .join("NGTManager")
            .join("memory-samples")
            .join(format!("NGTManager-memory-sample-{task_id}.txt"))
            .to_string_lossy()
            .into_owned()
    })
}

#[cfg(not(windows))]
fn expected_report_path(_task_id: &str) -> Option<String> {
    None
}

fn latest_path(root: &Path) -> PathBuf {
    store_dir(root).join("latest.json")
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn utc_boundary(start: &str, offset_seconds: u64) -> Option<String> {
    DateTime::parse_from_rfc3339(start).ok().map(|value| {
        (value + chrono::Duration::seconds(offset_seconds as i64))
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn timestamp_in_window(timestamp: Option<&str>, start: Option<&str>, end: Option<&str>) -> bool {
    timestamp
        .zip(start)
        .zip(end)
        .is_some_and(|((timestamp, start), end)| timestamp >= start && timestamp < end)
}

fn expiry_time() -> String {
    (Utc::now() + chrono::Duration::seconds(REQUEST_RETENTION_SECONDS))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn valid_request_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn valid_task_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'T' || byte == b'Z'
        })
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The sampling state path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Unable to create the memory-sampling state directory.".to_owned())?;
    let temporary = parent.join(format!(
        ".state-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "Unable to create a temporary memory-sampling state file.".to_owned())?;
    let result = file
        .write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Unable to save memory-sampling state.".to_owned());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    replace_file(&temporary, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
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
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err("Unable to publish memory-sampling state.".to_owned());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|_| "Unable to publish memory-sampling state.".to_owned())
}

fn read_status_file(path: &Path) -> Result<Option<MemorySampleStatus>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Unable to read memory-sampling status.".to_owned()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return Err("Memory-sampling status is invalid.".to_owned());
    }
    let bytes = fs::read(path).map_err(|_| "Unable to read memory-sampling status.".to_owned())?;
    let status: MemorySampleStatus = serde_json::from_slice(&bytes)
        .map_err(|_| "Memory-sampling status is invalid.".to_owned())?;
    Ok(Some(status))
}

pub fn read_status(
    root: &Path,
    request_id: Option<&str>,
) -> Result<Option<MemorySampleStatus>, String> {
    let status = match request_id {
        Some(request_id) if valid_request_id(request_id) => {
            read_status_file(&request_status_path(root, request_id))?
        }
        Some(_) => return Err("Memory-sampling request ID is invalid.".to_owned()),
        None => read_status_file(&latest_path(root))?,
    };
    let Some(mut status) = status else {
        return Ok(None);
    };
    if let Some(request_id) = request_id {
        if status.task_id.is_some() {
            let current = read_status_file(&latest_path(root))?;
            if current.as_ref().is_some_and(|current| {
                current.task_id == status.task_id && current.request_id != request_id
            }) {
                status = current.unwrap();
                status.request_id = request_id.to_owned();
            }
        }
    }
    if DateTime::parse_from_rfc3339(&status.expires_at_utc)
        .map(|expiry| expiry.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
    {
        return Ok(None);
    }
    Ok(Some(status))
}

fn save_status(root: &Path, status: &MemorySampleStatus) -> Result<(), String> {
    let contents = serde_json::to_vec(status)
        .map_err(|_| "Unable to encode memory-sampling status.".to_owned())?;
    write_atomic(&request_status_path(root, &status.request_id), &contents)?;
    write_atomic(&latest_path(root), &contents)
}

fn parse_active_latest(root: &Path) -> Result<Option<MemorySampleStatus>, String> {
    let latest = read_status_file(&latest_path(root))?;
    Ok(latest.filter(MemorySampleStatus::active))
}

fn write_pending_request(root: &Path, request: &PendingRequest) -> Result<(), String> {
    let pending = pending_dir(root).join(format!("{}.json", request.request_id));
    match fs::symlink_metadata(&pending) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => return Ok(()),
        Ok(_) => return Err("Unable to queue memory-sampling request.".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Unable to queue memory-sampling request.".to_owned()),
    }
    let contents = serde_json::to_vec(request)
        .map_err(|_| "Unable to encode memory-sampling request.".to_owned())?;
    write_atomic(&pending, &contents)
}

fn prepare_record_file(path: &Path) -> Result<(), ()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
            if metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() == 0 {
                Ok(())
            } else {
                Err(())
            }
        }
        Err(_) => Err(()),
    }
}

pub fn enqueue(root: &Path, request_id: &str) -> Result<(), String> {
    if !valid_request_id(request_id) {
        return Err("Memory-sampling request ID is invalid.".to_owned());
    }
    let base = store_dir(root);
    fs::create_dir_all(pending_dir(root))
        .map_err(|_| "Unable to create memory-sampling state.".to_owned())?;
    fs::create_dir_all(base.join("requests"))
        .map_err(|_| "Unable to create memory-sampling state.".to_owned())?;
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(base.join("enqueue.lock"))
        .map_err(|_| "Unable to coordinate memory-sampling requests.".to_owned())?;
    lock.lock_exclusive()
        .map_err(|_| "Unable to coordinate memory-sampling requests.".to_owned())?;
    let pending = pending_dir(root).join(format!("{request_id}.json"));

    if let Some(existing) = read_status_file(&request_status_path(root, request_id))? {
        let expires = DateTime::parse_from_rfc3339(&existing.expires_at_utc)
            .map(|time| time.with_timezone(&Utc))
            .unwrap_or(DateTime::<Utc>::MIN_UTC);
        if expires <= Utc::now() {
            return Err("This memory-sampling request expired; start a new sample.".to_owned());
        }
        let latest = read_status_file(&latest_path(root))?;
        let is_primary = latest.as_ref().is_none_or(|latest| {
            latest.request_id == request_id || latest.task_id != existing.task_id
        });
        if existing.phase == "queued" && existing.task_id.is_some() && is_primary {
            write_pending_request(
                root,
                &PendingRequest {
                    request_id: request_id.to_owned(),
                    created_at_utc: existing.started_at_utc,
                },
            )?;
        }
        return Ok(());
    }
    if let Some(active) = parse_active_latest(root)?.filter(|status| status.task_id.is_some()) {
        let _ = fs::remove_file(&pending);
        let alias = MemorySampleStatus {
            request_id: request_id.to_owned(),
            expires_at_utc: expiry_time(),
            ..active
        };
        let contents = serde_json::to_vec(&alias)
            .map_err(|_| "Unable to encode memory-sampling request.".to_owned())?;
        write_atomic(&request_status_path(root, request_id), &contents)?;
        return Ok(());
    }

    let request = PendingRequest {
        request_id: request_id.to_owned(),
        created_at_utc: now_utc(),
    };
    let task_id = format!("{}-{request_id}", Utc::now().format("%Y%m%dT%H%M%SZ"));
    let status = MemorySampleStatus {
        format_version: 1,
        request_id: request_id.to_owned(),
        task_id: Some(task_id.clone()),
        software_version: String::new(),
        phase: "queued".to_owned(),
        started_at_utc: request.created_at_utc.clone(),
        updated_at_utc: now_utc(),
        expires_at_utc: expiry_time(),
        elapsed_seconds: 0,
        planned_samples: PLANNED_SAMPLES,
        recorded_samples: 0,
        complete_samples: 0,
        incomplete_samples: 0,
        missed_samples: 0,
        report_path: None,
        expected_report_path: expected_report_path(&task_id),
        ended_reason: None,
        error_code: None,
        details_limited: false,
    };
    save_status(root, &status)?;
    write_pending_request(root, &request)
}

#[cfg(windows)]
struct ActiveTask {
    status: MemorySampleStatus,
    start_tick: u64,
    next_sample: usize,
    last_status_bucket: u64,
    pending_sample: Option<PendingSample>,
}

#[cfg(windows)]
struct PendingSample {
    sample_id: usize,
    planned_seconds: u64,
    actual_time_utc: String,
    started_tick: u64,
    receiver: Receiver<ProcessSampleMessage>,
    worker: Option<std::thread::JoinHandle<()>>,
    cancelled: Arc<AtomicBool>,
    discovered: Option<usize>,
    processes: Vec<ProcessReading>,
    completion: Option<Result<CollectionSummary, String>>,
    recorded: bool,
}

#[cfg(windows)]
enum ProcessSampleMessage {
    Discovered(usize),
    Process(ProcessReading),
    Complete(Result<CollectionSummary, String>),
}

#[cfg(windows)]
struct SaveWorker {
    request_id: String,
    task_id: String,
    start_tick: u64,
    child: Child,
    stdout: Option<std::process::ChildStdout>,
}

#[cfg(windows)]
pub struct MemorySamplingSupervisor {
    root: PathBuf,
    active: Option<ActiveTask>,
    saving: Option<SaveWorker>,
    recovery_task: Option<(String, String)>,
}

#[cfg(windows)]
impl MemorySamplingSupervisor {
    pub fn new(root: &Path) -> Self {
        let mut supervisor = Self {
            root: root.to_owned(),
            active: None,
            saving: None,
            recovery_task: None,
        };
        if let Ok(Some(mut status)) = read_status_file(&latest_path(root)) {
            if status.phase == "queued" {
                let task_id = status
                    .task_id
                    .clone()
                    .filter(|task_id| valid_task_id(task_id))
                    .unwrap_or_else(|| {
                        format!(
                            "{}-{}",
                            Utc::now().format("%Y%m%dT%H%M%SZ"),
                            status.request_id
                        )
                    });
                status.task_id = Some(task_id.clone());
                status.expected_report_path = expected_report_path(&task_id);
                let _ = save_status(root, &status);
                let _ = write_pending_request(
                    root,
                    &PendingRequest {
                        request_id: status.request_id,
                        created_at_utc: status.started_at_utc,
                    },
                );
            } else if matches!(
                status.phase.as_str(),
                "preparing" | "warmup" | "sampling" | "saving"
            ) || (status.phase == "failed"
                && matches!(
                    status.error_code.as_deref(),
                    Some(
                        "RECORDING_FAILED"
                            | "REPORT_SAVE_FAILED"
                            | "SAVE_UNCONFIRMED"
                            | "SAVE_UNAVAILABLE"
                    )
                ))
            {
                if let Some(task_id) = status.task_id.clone() {
                    status.phase = "saving".to_owned();
                    if status.ended_reason.is_none() {
                        status.ended_reason = Some("manager-restarted".to_owned());
                    }
                    status.expires_at_utc = expiry_time();
                    status.updated_at_utc = now_utc();
                    let request_id = status.request_id.clone();
                    if save_status(root, &status).is_ok() {
                        supervisor.recovery_task = Some((request_id, task_id));
                    }
                }
            }
        }
        supervisor
    }

    pub fn tick(
        &mut self,
        database_job: windows_sys::Win32::Foundation::HANDLE,
        application_job: windows_sys::Win32::Foundation::HANDLE,
        software_version: &str,
    ) {
        self.poll_save();
        if self.saving.is_some() {
            return;
        }
        if let Some((request_id, task_id)) = self.recovery_task.take() {
            self.start_save(request_id, task_id);
            return;
        }
        self.absorb_pending_requests();
        if self.active.is_none() {
            if let Some(request_id) = self.take_next_request() {
                self.start_task(request_id, software_version);
            }
        }
        let Some(mut active) = self.active.take() else {
            return;
        };
        let now = tick_count_ms();
        let elapsed_ms = now.saturating_sub(active.start_tick);
        active.status.elapsed_seconds = elapsed_ms / 1000;
        let elapsed_bucket = elapsed_ms / (SAMPLE_INTERVAL_SECONDS * 1000);
        let warmup_ms = WARMUP_SECONDS * 1000;
        if elapsed_ms < warmup_ms {
            active.status.phase = "warmup".to_owned();
            if active.last_status_bucket != elapsed_bucket {
                active.status.updated_at_utc = now_utc();
                let _ = save_status(&self.root, &active.status);
                active.last_status_bucket = elapsed_bucket;
            }
            self.active = Some(active);
            return;
        }
        active.status.phase = "sampling".to_owned();
        if active.last_status_bucket != elapsed_bucket {
            active.status.updated_at_utc = now_utc();
            let _ = save_status(&self.root, &active.status);
            active.last_status_bucket = elapsed_bucket;
        }
        let mut pending_finished = false;
        if let Some(mut pending) = active.pending_sample.take() {
            drain_pending_sample(&mut pending);
            let timed_out = tick_count_ms().saturating_sub(pending.started_tick) >= 1000;
            if !pending.recorded && (pending.completion.is_some() || timed_out) {
                let forced_reason = pending
                    .completion
                    .is_none()
                    .then_some("SAMPLE_BUDGET_EXCEEDED");
                if record_pending_sample(&self.root, &mut active, &pending, forced_reason).is_err()
                {
                    pending.cancelled.store(true, Ordering::Relaxed);
                    self.fail_recording(active);
                    return;
                }
                pending.recorded = true;
                pending.cancelled.store(true, Ordering::Relaxed);
            }
            if pending.completion.is_some() {
                if let Some(worker) = pending.worker.take() {
                    let _ = worker.join();
                }
                pending_finished = true;
            } else {
                active.pending_sample = Some(pending);
            }
        }
        if pending_finished {
            active.pending_sample = None;
        }
        let sample_ms = elapsed_ms - warmup_ms;
        while active.next_sample < PLANNED_SAMPLES {
            let planned_seconds = active.next_sample as u64 * SAMPLE_INTERVAL_SECONDS;
            let due_ms = planned_seconds * 1000;
            if sample_ms >= due_ms + 1000 {
                let summary = SampleSummary {
                    sample_id: active.next_sample + 1,
                    planned_seconds,
                    actual_time_utc: None,
                    discovered_processes: 0,
                    read_processes: 0,
                    working_set_bytes: 0,
                    private_bytes: 0,
                    complete: false,
                    missing_reason: Some("SAMPLE_MISSED".to_owned()),
                };
                if append_record(&self.root, &mut active, summary, Vec::new()).is_err() {
                    self.fail_recording(active);
                    return;
                }
                active.status.missed_samples += 1;
                active.status.recorded_samples += 1;
                active.next_sample += 1;
                continue;
            }
            if sample_ms >= due_ms && active.pending_sample.is_none() {
                match start_pending_sample(
                    database_job,
                    application_job,
                    active.next_sample + 1,
                    planned_seconds,
                ) {
                    Ok(pending) => active.pending_sample = Some(pending),
                    Err(error_code) => {
                        let sample_id = active.next_sample + 1;
                        if sample_from_collection(
                            &self.root,
                            &mut active,
                            sample_id,
                            planned_seconds,
                            now_utc(),
                            0,
                            Vec::new(),
                            &error_code,
                        )
                        .is_err()
                        {
                            self.fail_recording(active);
                            return;
                        }
                    }
                }
            }
            break;
        }
        if sample_ms >= SAMPLE_SECONDS * 1000 {
            if let Some(pending) = active.pending_sample.as_ref() {
                pending.cancelled.store(true, Ordering::Relaxed);
            }
            active.status.phase = "saving".to_owned();
            active.status.updated_at_utc = now_utc();
            let status = active.status.clone();
            let _ = save_status(&self.root, &status);
            let task_id = status.task_id.unwrap_or_default();
            let request_id = status.request_id;
            self.start_save(request_id, task_id);
            return;
        }
        self.active = Some(active);
    }

    pub fn interrupt_for_shutdown(&mut self) {
        if let Some(mut active) = self.active.take() {
            if let Some(pending) = active.pending_sample.as_ref() {
                pending.cancelled.store(true, Ordering::Relaxed);
            }
            active.status.phase = "saving".to_owned();
            active.status.ended_reason = Some("runtime-stopping".to_owned());
            active.status.updated_at_utc = now_utc();
            active.status.expires_at_utc = expiry_time();
            let request_id = active.status.request_id.clone();
            let task_id = active.status.task_id.clone().unwrap_or_default();
            let _ = save_status(&self.root, &active.status);
            self.recovery_task = Some((request_id, task_id));
        }
        if let Some(mut worker) = self.saving.take() {
            // The report helper is deliberately outside the runtime Job Object.
            // Stop it before the manager exits; startup will reconcile an already
            // published report or retry from the durable sample record.
            let _ = worker.child.kill();
            let _ = worker.child.wait();
            let status_path = request_status_path(&self.root, &worker.request_id);
            if let Ok(Some(mut status)) = read_status_file(&status_path) {
                if status.task_id.as_deref() == Some(worker.task_id.as_str()) {
                    status.phase = "saving".to_owned();
                    status.ended_reason = Some("runtime-stopping".to_owned());
                    status.updated_at_utc = now_utc();
                    status.expires_at_utc = expiry_time();
                    if save_status(&self.root, &status).is_ok() {
                        self.recovery_task = Some((worker.request_id, worker.task_id));
                    }
                }
            }
        }
    }

    fn fail_recording(&mut self, mut active: ActiveTask) {
        active.status.phase = "saving".to_owned();
        active.status.error_code = Some("RECORDING_FAILED".to_owned());
        active.status.ended_reason = Some("recording-failed".to_owned());
        active.status.updated_at_utc = now_utc();
        active.status.expires_at_utc = expiry_time();
        let request_id = active.status.request_id.clone();
        let task_id = active.status.task_id.clone().unwrap_or_default();
        if save_status(&self.root, &active.status).is_ok() {
            self.recovery_task = Some((request_id, task_id));
        }
    }

    fn start_task(&mut self, request_id: String, software_version: &str) {
        let status_path = request_status_path(&self.root, &request_id);
        let mut status = match read_status_file(&status_path) {
            Ok(Some(status)) if status.phase == "queued" => status,
            _ => {
                let _ = fs::remove_file(pending_dir(&self.root).join(format!("{request_id}.json")));
                return;
            }
        };
        let Some(task_id) = status
            .task_id
            .clone()
            .filter(|task_id| valid_task_id(task_id))
        else {
            self.fail_queued(&request_id, "SAMPLE_STATUS_INVALID");
            let _ = fs::remove_file(pending_dir(&self.root).join(format!("{request_id}.json")));
            return;
        };
        let expires = DateTime::parse_from_rfc3339(&status.expires_at_utc)
            .map(|time| time.with_timezone(&Utc))
            .unwrap_or(DateTime::<Utc>::MIN_UTC);
        if expires <= Utc::now() {
            self.fail_queued(&request_id, "REQUEST_EXPIRED");
            let _ = fs::remove_file(pending_dir(&self.root).join(format!("{request_id}.json")));
            return;
        }
        let path = record_path(&self.root, &task_id);
        if prepare_record_file(&path).is_err() {
            self.fail_queued(&request_id, "RECORDING_UNAVAILABLE");
            let _ = fs::remove_file(pending_dir(&self.root).join(format!("{request_id}.json")));
            return;
        }
        let started = now_utc();
        status.software_version = software_version.to_owned();
        status.phase = "preparing".to_owned();
        status.started_at_utc = started;
        status.updated_at_utc = now_utc();
        status.expires_at_utc = expiry_time();
        status.expected_report_path = expected_report_path(&task_id);
        if save_status(&self.root, &status).is_err() {
            self.fail_queued(&request_id, "STATE_WRITE_FAILED");
            let _ = fs::remove_file(path);
            return;
        }
        let _ = fs::remove_file(pending_dir(&self.root).join(format!("{request_id}.json")));
        self.active = Some(ActiveTask {
            status,
            start_tick: tick_count_ms(),
            next_sample: 0,
            last_status_bucket: 0,
            pending_sample: None,
        });
    }

    fn fail_queued(&self, request_id: &str, error_code: &str) {
        if let Ok(Some(mut status)) = read_status_file(&request_status_path(&self.root, request_id))
        {
            status.phase = "failed".to_owned();
            status.error_code = Some(error_code.to_owned());
            status.updated_at_utc = now_utc();
            status.expires_at_utc = expiry_time();
            let _ = save_status(&self.root, &status);
        }
    }

    fn absorb_pending_requests(&mut self) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let Ok(entries) = fs::read_dir(pending_dir(&self.root)) else {
            return;
        };
        for entry in entries.flatten().take(128) {
            let Some(request_id) = entry
                .path()
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|id| valid_request_id(id))
                .map(str::to_owned)
            else {
                continue;
            };
            if let Ok(mut alias) = read_status_file(&request_status_path(&self.root, &request_id)) {
                if let Some(alias) = alias.as_mut() {
                    alias.task_id = active.status.task_id.clone();
                    alias.phase = active.status.phase.clone();
                    alias.updated_at_utc = now_utc();
                    let _ = save_status(&self.root, alias);
                }
            }
            let _ = fs::remove_file(entry.path());
        }
    }

    fn take_next_request(&self) -> Option<String> {
        let mut requests = fs::read_dir(pending_dir(&self.root))
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let name = entry.path().file_stem()?.to_str()?.to_owned();
                valid_request_id(&name).then_some(name)
            })
            .collect::<Vec<_>>();
        requests.sort();
        requests.into_iter().next()
    }

    fn start_save(&mut self, request_id: String, task_id: String) {
        if !valid_task_id(&task_id) || !valid_request_id(&request_id) {
            self.fail_queued(&request_id, "SAMPLE_RECORD_INVALID");
            return;
        }
        let mut status = match read_status_file(&request_status_path(&self.root, &request_id)) {
            Ok(Some(status)) => status,
            _ => return,
        };
        status.phase = "saving".to_owned();
        status.task_id = Some(task_id.clone());
        status.updated_at_utc = now_utc();
        status.expires_at_utc = expiry_time();
        if save_status(&self.root, &status).is_err() {
            return;
        }
        let executable = match std::env::current_exe() {
            Ok(executable) => executable,
            Err(_) => {
                status.phase = "failed".to_owned();
                status.error_code = Some("SAVE_UNAVAILABLE".to_owned());
                let _ = save_status(&self.root, &status);
                return;
            }
        };
        let mut command = Command::new(executable);
        command
            .args(["memory-sample-save", &request_id, &task_id])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take();
                self.saving = Some(SaveWorker {
                    request_id,
                    task_id,
                    start_tick: tick_count_ms(),
                    child,
                    stdout,
                });
            }
            Err(_) => {
                status.phase = "failed".to_owned();
                status.error_code = Some("SAVE_UNAVAILABLE".to_owned());
                status.updated_at_utc = now_utc();
                let _ = save_status(&self.root, &status);
            }
        }
    }

    fn poll_save(&mut self) {
        let Some(worker) = self.saving.as_ref() else {
            return;
        };
        let timed_out =
            tick_count_ms().saturating_sub(worker.start_tick) >= MAX_SAVE_SECONDS * 1000;
        if timed_out {
            if let Some(worker) = self.saving.as_mut() {
                let _ = worker.child.kill();
                let _ = worker.child.wait();
            }
            self.finish_save(false, None, "SAVE_UNCONFIRMED");
            return;
        }
        let outcome = match self.saving.as_mut().unwrap().child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => {
                let output = self
                    .saving
                    .as_mut()
                    .unwrap()
                    .stdout
                    .take()
                    .and_then(|stdout| {
                        let mut bytes = Vec::new();
                        use std::io::Read;
                        stdout.take(4096).read_to_end(&mut bytes).ok()?;
                        serde_json::from_slice::<String>(&bytes).ok()
                    });
                Some((status.success(), output))
            }
            Err(_) => Some((false, None)),
        };
        if let Some((success, output)) = outcome {
            self.finish_save(success, output, "REPORT_SAVE_FAILED");
        }
    }

    fn finish_save(&mut self, success: bool, path: Option<String>, error_code: &str) {
        let Some(worker) = self.saving.take() else {
            return;
        };
        let Ok(Some(mut status)) =
            read_status_file(&request_status_path(&self.root, &worker.request_id))
        else {
            return;
        };
        if success {
            status.report_path = path;
            if status.complete_samples == 0 {
                status.phase = "failed".to_owned();
                status.error_code = Some("NO_COMPLETE_SAMPLES".to_owned());
                status.ended_reason = Some("no-complete-samples".to_owned());
            } else {
                status.phase = "complete".to_owned();
                status.error_code = None;
            }
            if worker.task_id != status.task_id.as_deref().unwrap_or_default() {
                status.phase = "failed".to_owned();
                status.report_path = None;
                status.error_code = Some("TASK_ID_MISMATCH".to_owned());
            }
        } else {
            status.phase = "failed".to_owned();
            status.error_code = Some(error_code.to_owned());
        }
        status.updated_at_utc = now_utc();
        status.expires_at_utc = expiry_time();
        let saved = save_status(&self.root, &status).is_ok();
        if success
            && saved
            && status.task_id.as_deref() == Some(worker.task_id.as_str())
            && status
                .report_path
                .as_deref()
                .is_some_and(|path| report_matches_task(Path::new(path), &worker.task_id))
        {
            let _ = fs::remove_file(record_path(&self.root, &worker.task_id));
        }
    }
}

#[cfg(windows)]
fn append_record(
    root: &Path,
    active: &mut ActiveTask,
    summary: SampleSummary,
    processes: Vec<ProcessReading>,
) -> Result<(), ()> {
    let task_id = active.status.task_id.as_deref().ok_or(())?;
    let path = record_path(root, task_id);
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|_| ())?;
    let mut record = SampleRecord { summary, processes };
    let mut bytes = serde_json::to_vec(&record).map_err(|_| ())?;
    let current = file.metadata().map_err(|_| ())?.len();
    if current.saturating_add(bytes.len() as u64 + 1) > MAX_RECORD_BYTES - 256 * 1024 {
        record.processes.clear();
        active.status.details_limited = true;
        bytes = serde_json::to_vec(&record).map_err(|_| ())?;
    }
    if current.saturating_add(bytes.len() as u64 + 1) > MAX_RECORD_BYTES {
        return Err(());
    }
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_data())
        .map_err(|_| ())
}

#[cfg(windows)]
fn sample_from_collection(
    root: &Path,
    active: &mut ActiveTask,
    sample_id: usize,
    planned_seconds: u64,
    actual_time_utc: String,
    discovered: usize,
    processes: Vec<ProcessReading>,
    error_code: &str,
) -> Result<(), ()> {
    let read_processes = processes
        .iter()
        .filter(|process| process.read_status == "ok")
        .count();
    let working_set_bytes = processes
        .iter()
        .filter_map(|process| process.working_set_bytes)
        .sum();
    let private_bytes = processes
        .iter()
        .filter_map(|process| process.private_bytes)
        .sum();
    let summary = SampleSummary {
        sample_id,
        planned_seconds,
        actual_time_utc: Some(actual_time_utc),
        discovered_processes: discovered,
        read_processes,
        working_set_bytes,
        private_bytes,
        complete: false,
        missing_reason: Some(error_code.to_owned()),
    };
    append_record(root, active, summary, processes)?;
    active.status.recorded_samples += 1;
    active.status.incomplete_samples += 1;
    active.status.updated_at_utc = now_utc();
    let _ = save_status(root, &active.status);
    active.next_sample += 1;
    Ok(())
}

#[cfg(windows)]
fn tick_count_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}

#[cfg(windows)]
struct ProcessCollection {
    discovered: usize,
    complete: bool,
    error_code: Option<String>,
    processes: Vec<ProcessReading>,
    images: std::collections::HashMap<u32, String>,
}

#[cfg(windows)]
struct CollectionSummary {
    discovered: usize,
    complete: bool,
    error_code: Option<String>,
}

#[cfg(windows)]
fn drain_pending_sample(pending: &mut PendingSample) {
    loop {
        match pending.receiver.try_recv() {
            Ok(ProcessSampleMessage::Discovered(count)) => pending.discovered = Some(count),
            Ok(ProcessSampleMessage::Process(process)) => {
                if pending.processes.len() < MAX_PROCESSES_PER_POINT {
                    pending.processes.push(process);
                }
            }
            Ok(ProcessSampleMessage::Complete(result)) => pending.completion = Some(result),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => {
                if pending.completion.is_none() {
                    pending.completion = Some(Err("SAMPLE_WORKER_FAILED".to_owned()));
                }
                break;
            }
        }
    }
}

#[cfg(windows)]
fn record_pending_sample(
    root: &Path,
    active: &mut ActiveTask,
    pending: &PendingSample,
    forced_reason: Option<&str>,
) -> Result<(), ()> {
    let elapsed = tick_count_ms().saturating_sub(pending.started_tick);
    let within_budget = elapsed <= 1000;
    let collection = pending
        .completion
        .as_ref()
        .and_then(|result| result.as_ref().ok());
    let discovered = collection
        .map(|collection| collection.discovered)
        .or(pending.discovered)
        .unwrap_or(0);
    let read_processes = pending
        .processes
        .iter()
        .filter(|process| process.read_status == "ok")
        .count();
    let working_set_bytes = pending
        .processes
        .iter()
        .filter_map(|process| process.working_set_bytes)
        .sum();
    let private_bytes = pending
        .processes
        .iter()
        .filter_map(|process| process.private_bytes)
        .sum();
    let complete = within_budget
        && collection.is_some_and(|collection| {
            collection.complete && read_processes == collection.discovered
        });
    let collection_error = pending.completion.as_ref().and_then(|result| match result {
        Err(error) => Some(error.clone()),
        Ok(collection) => collection.error_code.clone(),
    });
    let missing_reason = if complete {
        None
    } else if !within_budget {
        Some("SAMPLE_BUDGET_EXCEEDED".to_owned())
    } else {
        collection_error
            .or_else(|| forced_reason.map(str::to_owned))
            .or_else(|| Some("PROCESS_SET_INCOMPLETE".to_owned()))
    };
    let summary = SampleSummary {
        sample_id: pending.sample_id,
        planned_seconds: pending.planned_seconds,
        actual_time_utc: Some(pending.actual_time_utc.clone()),
        discovered_processes: discovered,
        read_processes,
        working_set_bytes,
        private_bytes,
        complete,
        missing_reason,
    };
    append_record(root, active, summary, pending.processes.clone())?;
    active.status.recorded_samples += 1;
    if complete {
        active.status.complete_samples += 1;
    } else {
        active.status.incomplete_samples += 1;
    }
    active.status.updated_at_utc = now_utc();
    let _ = save_status(root, &active.status);
    active.next_sample += 1;
    Ok(())
}

#[cfg(windows)]
fn start_pending_sample(
    database_job: windows_sys::Win32::Foundation::HANDLE,
    application_job: windows_sys::Win32::Foundation::HANDLE,
    sample_id: usize,
    planned_seconds: u64,
) -> Result<PendingSample, String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let actual_time_utc = now_utc();
    let started_tick = tick_count_ms();
    let current_process = unsafe { GetCurrentProcess() };
    let mut duplicate: HANDLE = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            current_process,
            database_job,
            current_process,
            &mut duplicate,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err("SAMPLE_JOB_HANDLE_DUPLICATION_FAILED".to_owned());
    }
    let mut application_duplicate: HANDLE = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            current_process,
            application_job,
            current_process,
            &mut application_duplicate,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        unsafe { CloseHandle(duplicate) };
        return Err("SAMPLE_JOB_HANDLE_DUPLICATION_FAILED".to_owned());
    }

    let (sender, receiver) = mpsc::sync_channel(MAX_PROCESSES_PER_POINT + 2);
    let database_job_value = duplicate as usize;
    let application_job_value = application_duplicate as usize;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = match std::thread::Builder::new()
        .name("ngt-memory-sample".to_owned())
        .spawn(move || {
            let database_job = database_job_value as HANDLE;
            let application_job = application_job_value as HANDLE;
            let result = collect_job_processes(
                database_job,
                application_job,
                &worker_cancelled,
                |count| {
                    let _ = sender.try_send(ProcessSampleMessage::Discovered(count));
                },
                |process| {
                    let _ = sender.try_send(ProcessSampleMessage::Process(process.clone()));
                },
            )
            .map(|collection| CollectionSummary {
                discovered: collection.discovered,
                complete: collection.complete,
                error_code: collection.error_code,
            });
            let _ = sender.try_send(ProcessSampleMessage::Complete(result));
            unsafe {
                CloseHandle(database_job);
                CloseHandle(application_job);
            }
        }) {
        Ok(worker) => worker,
        Err(_) => {
            unsafe { CloseHandle(duplicate) };
            unsafe { CloseHandle(application_duplicate) };
            return Err("SAMPLE_WORKER_START_FAILED".to_owned());
        }
    };
    Ok(PendingSample {
        sample_id,
        planned_seconds,
        actual_time_utc,
        started_tick,
        receiver,
        worker: Some(worker),
        cancelled,
        discovered: None,
        processes: Vec::with_capacity(MAX_PROCESSES_PER_POINT),
        completion: None,
        recorded: false,
    })
}

#[cfg(windows)]
fn collect_job_processes<F, D>(
    database_job: windows_sys::Win32::Foundation::HANDLE,
    application_job: windows_sys::Win32::Foundation::HANDLE,
    cancelled: &AtomicBool,
    on_discovered: D,
    on_process: F,
) -> Result<ProcessCollection, String>
where
    F: FnMut(&ProcessReading),
    D: FnOnce(usize),
{
    use std::collections::HashMap;
    use std::mem::{offset_of, size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    let mut process_ids = Vec::new();
    for job in [database_job, application_job] {
        let mut capacity = 32usize;
        let job_process_ids = loop {
            if capacity > 4096 {
                return Err("PROCESS_LIST_LIMIT".to_owned());
            }
            let bytes = offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
                + capacity * size_of::<usize>();
            let mut buffer = vec![0u8; bytes];
            let list = buffer.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
            let queried = unsafe {
                QueryInformationJobObject(
                    job,
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    bytes as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried != 0 {
                let count = unsafe { (*list).NumberOfProcessIdsInList as usize };
                let assigned = unsafe { (*list).NumberOfAssignedProcesses as usize };
                if count > capacity || assigned > count {
                    capacity = capacity.max(assigned).max(count).next_power_of_two();
                    continue;
                }
                let start = unsafe { std::ptr::addr_of!((*list).ProcessIdList) as *const usize };
                let ids = unsafe { std::slice::from_raw_parts(start, count) }
                    .iter()
                    .map(|pid| *pid as u32)
                    .collect::<Vec<_>>();
                break ids;
            }
            let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if error == ERROR_MORE_DATA {
                capacity = capacity.saturating_mul(2);
            } else {
                return Err(format!("JOB_ENUMERATION_{error}"));
            }
        };
        process_ids.extend(job_process_ids);
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err("PROCESS_SNAPSHOT_FAILED".to_owned());
    }
    let mut parents = HashMap::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let name_length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
            parents.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe { CloseHandle(snapshot) };

    let manager_pid = unsafe { GetCurrentProcessId() };
    let mut ids = process_ids;
    ids.push(manager_pid);
    ids.sort_unstable();
    ids.dedup();
    on_discovered(ids.len());
    Ok(collect_process_ids(
        ids,
        &parents,
        Some(&[database_job, application_job]),
        manager_pid,
        Some(cancelled),
        on_process,
    ))
}

#[cfg(windows)]
fn collect_process_ids(
    mut ids: Vec<u32>,
    parents: &std::collections::HashMap<u32, (u32, String)>,
    expected_jobs: Option<&[windows_sys::Win32::Foundation::HANDLE]>,
    trusted_pid: u32,
    cancelled: Option<&AtomicBool>,
    mut on_process: impl FnMut(&ProcessReading),
) -> ProcessCollection {
    let discovered = ids.len();
    let mut complete = discovered <= MAX_PROCESSES_PER_POINT;
    let mut error_code =
        (discovered > MAX_PROCESSES_PER_POINT).then(|| "PROCESS_COUNT_LIMIT".to_owned());
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > MAX_PROCESSES_PER_POINT && trusted_pid != 0 {
        ids.retain(|pid| *pid != trusted_pid);
        ids.truncate(MAX_PROCESSES_PER_POINT - 1);
        ids.push(trusted_pid);
        ids.sort_unstable();
    } else {
        ids.truncate(MAX_PROCESSES_PER_POINT);
    }
    let mut processes = Vec::with_capacity(ids.len());
    let mut images = std::collections::HashMap::with_capacity(ids.len());
    for pid in ids {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Relaxed)) {
            complete = false;
            error_code.get_or_insert("SAMPLE_CANCELLED".to_owned());
            break;
        }
        let (parent_pid, fallback_name) = parents.get(&pid).cloned().unwrap_or_default();
        let (reading, image, process_error) =
            read_process(pid, parent_pid, &fallback_name, expected_jobs, trusted_pid);
        if reading.read_status != "ok" {
            complete = false;
            error_code.get_or_insert(process_error);
        }
        if let Some(image) = image {
            images.insert(pid, image);
        }
        on_process(&reading);
        processes.push(reading);
    }
    ProcessCollection {
        discovered,
        complete,
        error_code,
        processes,
        images,
    }
}

#[cfg(windows)]
fn collect_external_process_tree(
    root_pid: u32,
    expected_manager: &Path,
    root_creation_time: &mut Option<String>,
) -> Result<ProcessCollection, String> {
    use std::collections::{HashMap, HashSet};
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err("PROCESS_SNAPSHOT_FAILED".to_owned());
    }
    let mut parents = HashMap::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let name_length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_length]);
            parents.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe { windows_sys::Win32::Foundation::CloseHandle(snapshot) };
    if !parents.contains_key(&root_pid) {
        return Err("ROOT_PROCESS_NOT_FOUND".to_owned());
    }

    let mut ids = HashSet::from([root_pid]);
    loop {
        let before = ids.len();
        let current = ids.clone();
        let children = parents
            .iter()
            .filter_map(|(pid, (parent, _))| current.contains(parent).then_some(*pid))
            .collect::<Vec<_>>();
        ids.extend(children);
        if ids.len() == before {
            break;
        }
        if ids.len() > 4096 {
            return Err("PROCESS_LIST_LIMIT".to_owned());
        }
    }
    let ordered = ids.into_iter().collect::<Vec<_>>();
    let collection = collect_process_ids(ordered, &parents, None, root_pid, None, |_| {});
    let expected = normalize_windows_path(&expected_manager.to_string_lossy());
    let actual = collection
        .images
        .get(&root_pid)
        .map(|path| normalize_windows_path(path));
    if actual.as_deref() != Some(expected.as_str()) {
        return Err("ROOT_PROCESS_PATH_MISMATCH".to_owned());
    }
    let root = collection
        .processes
        .iter()
        .find(|process| process.pid == root_pid)
        .ok_or_else(|| "ROOT_PROCESS_NOT_READABLE".to_owned())?;
    let created = root
        .creation_time_utc
        .clone()
        .filter(|_| root.read_status == "ok")
        .ok_or_else(|| "ROOT_PROCESS_IDENTITY_UNVERIFIED".to_owned())?;
    if root_creation_time
        .as_ref()
        .is_some_and(|previous| previous != &created)
    {
        return Err("ROOT_PROCESS_IDENTITY_CHANGED".to_owned());
    }
    *root_creation_time = Some(created);
    Ok(collection)
}

#[cfg(windows)]
fn normalize_windows_path(path: &str) -> String {
    path.trim_start_matches("\\\\?\\")
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn read_process(
    pid: u32,
    parent_pid: u32,
    fallback_name: &str,
    expected_jobs: Option<&[windows_sys::Win32::Foundation::HANDLE]>,
    trusted_pid: u32,
) -> (ProcessReading, Option<String>, String) {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if handle.is_null() {
        return (
            ProcessReading {
                name: safe_process_name(fallback_name),
                pid,
                parent_pid,
                creation_time_utc: None,
                working_set_bytes: None,
                private_bytes: None,
                read_status: "PROCESS_OPEN_FAILED".to_owned(),
            },
            None,
            "PROCESS_OPEN_FAILED".to_owned(),
        );
    }
    if let Some(jobs) = expected_jobs.filter(|_| pid != trusted_pid) {
        let belongs_to_runtime = jobs.iter().any(|job| {
            let mut in_job = 0;
            unsafe {
                windows_sys::Win32::System::JobObjects::IsProcessInJob(handle, *job, &mut in_job)
                    != 0
                    && in_job != 0
            }
        });
        if !belongs_to_runtime {
            unsafe { CloseHandle(handle) };
            return (
                ProcessReading {
                    name: safe_process_name(fallback_name),
                    pid,
                    parent_pid,
                    creation_time_utc: None,
                    working_set_bytes: None,
                    private_bytes: None,
                    read_status: "PROCESS_OWNERSHIP_UNVERIFIED".to_owned(),
                },
                None,
                "PROCESS_OWNERSHIP_UNVERIFIED".to_owned(),
            );
        }
    }
    let mut created = unsafe { zeroed() };
    let mut exited = unsafe { zeroed() };
    let mut kernel = unsafe { zeroed() };
    let mut user = unsafe { zeroed() };
    let has_identity =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
    let mut path = vec![0u16; 32768];
    let mut path_len = path.len() as u32;
    let has_image =
        unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut path_len) } != 0;
    let image = has_image.then(|| String::from_utf16_lossy(&path[..path_len as usize]));
    let name = image
        .as_deref()
        .and_then(|path| path.rsplit(['\\', '/']).next())
        .unwrap_or(fallback_name);
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    let read_ok = unsafe {
        GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            counters.cb,
        )
    } != 0;
    let creation_time_utc = has_identity
        .then(|| filetime_utc(created.dwLowDateTime, created.dwHighDateTime))
        .flatten();
    let (status, error) = if !has_identity {
        ("PROCESS_IDENTITY_UNVERIFIED", "PROCESS_IDENTITY_UNVERIFIED")
    } else if !read_ok {
        ("PROCESS_MEMORY_READ_FAILED", "PROCESS_MEMORY_READ_FAILED")
    } else {
        ("ok", "none")
    };
    let reading = ProcessReading {
        name: safe_process_name(name),
        pid,
        parent_pid,
        creation_time_utc,
        working_set_bytes: read_ok.then_some(counters.WorkingSetSize as u64),
        private_bytes: read_ok.then_some(counters.PrivateUsage as u64),
        read_status: status.to_owned(),
    };
    unsafe { CloseHandle(handle) };
    (reading, image, error.to_owned())
}

#[cfg(windows)]
fn safe_process_name(value: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| !character.is_control())
        .take(128)
        .collect::<String>();
    if safe.is_empty() {
        "unknown".to_owned()
    } else {
        safe
    }
}

#[cfg(windows)]
fn filetime_utc(low: u32, high: u32) -> Option<String> {
    const WINDOWS_TO_UNIX_TICKS: u64 = 116_444_736_000_000_000;
    let ticks = ((high as u64) << 32) | low as u64;
    let ticks = ticks.checked_sub(WINDOWS_TO_UNIX_TICKS)?;
    let seconds = (ticks / 10_000_000) as i64;
    let nanos = ((ticks % 10_000_000) * 100) as u32;
    DateTime::<Utc>::from_timestamp(seconds, nanos)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(windows)]
fn documents_path() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Documents, SHGetKnownFolderPath};
    let mut pointer = std::ptr::null_mut();
    let result =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Documents, 0, std::ptr::null_mut(), &mut pointer) };
    if result < 0 || pointer.is_null() {
        return Err("DOCUMENTS_FOLDER_UNAVAILABLE".to_owned());
    }
    let mut length = 0usize;
    unsafe {
        while *pointer.add(length) != 0 && length < 32768 {
            length += 1;
        }
    }
    let path = unsafe {
        PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
            pointer, length,
        )))
    };
    unsafe { CoTaskMemFree(pointer.cast()) };
    Ok(path)
}

#[cfg(windows)]
pub fn probe_documents() -> Result<(), String> {
    let directory = documents_path()?.join("NGTManager").join("memory-samples");
    fs::create_dir_all(&directory).map_err(|_| "DOCUMENTS_NOT_WRITABLE".to_owned())?;
    let probe = directory.join(format!(".probe-{}.tmp", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| "DOCUMENTS_NOT_WRITABLE".to_owned())?;
    drop(file);
    fs::remove_file(probe).map_err(|_| "DOCUMENTS_NOT_WRITABLE".to_owned())
}

#[cfg(not(windows))]
pub fn probe_documents() -> Result<(), String> {
    Err("WINDOWS_ONLY".to_owned())
}

#[cfg(windows)]
pub fn save_report(root: &Path, request_id: &str, task_id: &str) -> Result<PathBuf, String> {
    if !valid_request_id(request_id) || !valid_task_id(task_id) {
        return Err("SAMPLE_RECORD_INVALID".to_owned());
    }
    let record = record_path(root, task_id);
    let metadata = fs::symlink_metadata(&record).map_err(|_| "SAMPLE_RECORD_MISSING".to_owned())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err("SAMPLE_RECORD_INVALID".to_owned());
    }
    let (records, truncated_tail) = read_records(&record)?;
    let mut status = read_status_file(&request_status_path(root, request_id))?
        .ok_or_else(|| "SAMPLE_STATUS_MISSING".to_owned())?;
    status.recorded_samples = records.len();
    status.complete_samples = records
        .iter()
        .filter(|record| record.summary.complete)
        .count();
    status.missed_samples = records
        .iter()
        .filter(|record| record.summary.missing_reason.as_deref() == Some("SAMPLE_MISSED"))
        .count();
    status.incomplete_samples = records
        .iter()
        .filter(|record| {
            !record.summary.complete
                && record.summary.missing_reason.as_deref() != Some("SAMPLE_MISSED")
        })
        .count();
    status.updated_at_utc = now_utc();
    save_status(root, &status)?;
    let directory = documents_path()?.join("NGTManager").join("memory-samples");
    fs::create_dir_all(&directory).map_err(|_| "DOCUMENTS_NOT_WRITABLE".to_owned())?;
    let filename = format!("NGTManager-memory-sample-{task_id}.txt");
    let destination = directory.join(&filename);
    if destination.exists() {
        if report_matches_task(&destination, task_id) {
            return Ok(destination);
        }
        return Err("REPORT_ALREADY_EXISTS".to_owned());
    }
    let temporary = directory.join(format!(".{task_id}-{}.tmp", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "REPORT_TEMP_CREATE_FAILED".to_owned())?;
    let mut writer = BufWriter::with_capacity(IO_BUFFER_BYTES, file);
    let result = render_report(&records, truncated_tail, &mut writer, task_id, &status)
        .and_then(|_| writer.flush().map_err(|_| "REPORT_WRITE_FAILED".to_owned()))
        .and_then(|_| {
            writer
                .get_ref()
                .sync_all()
                .map_err(|_| "REPORT_WRITE_FAILED".to_owned())
        });
    if let Err(error) = result {
        drop(writer);
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    drop(writer);
    match fs::rename(&temporary, &destination) {
        Ok(()) => Ok(destination),
        Err(_) if report_matches_task(&destination, task_id) => {
            let _ = fs::remove_file(&temporary);
            Ok(destination)
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            Err("REPORT_PUBLISH_FAILED".to_owned())
        }
    }
}

#[cfg(windows)]
pub fn retry_save(root: &Path, request_id: &str) -> Result<MemorySampleStatus, String> {
    if !valid_request_id(request_id) {
        return Err("SAMPLE_REQUEST_INVALID".to_owned());
    }
    let mut status =
        read_status(root, Some(request_id))?.ok_or_else(|| "SAMPLE_REQUEST_EXPIRED".to_owned())?;
    if !status
        .error_code
        .as_deref()
        .is_some_and(is_retryable_save_error)
    {
        return Err("SAMPLE_SAVE_NOT_RETRYABLE".to_owned());
    }
    let task_id = status
        .task_id
        .clone()
        .filter(|task_id| valid_task_id(task_id))
        .ok_or_else(|| "SAMPLE_RECORD_MISSING".to_owned())?;
    status.phase = "saving".to_owned();
    status.updated_at_utc = now_utc();
    status.expires_at_utc = expiry_time();
    status.error_code = None;
    save_status(root, &status)?;
    match save_report(root, request_id, &task_id) {
        Ok(path) => {
            status = read_status(root, Some(request_id))?
                .ok_or_else(|| "SAMPLE_STATUS_MISSING".to_owned())?;
            status.report_path = Some(path.to_string_lossy().into_owned());
            status.phase = if status.complete_samples == 0 {
                status.error_code = Some("NO_COMPLETE_SAMPLES".to_owned());
                status.ended_reason = Some("no-complete-samples".to_owned());
                "failed".to_owned()
            } else {
                "complete".to_owned()
            };
            status.updated_at_utc = now_utc();
            save_status(root, &status)?;
            if report_matches_task(&path, &task_id) {
                let _ = fs::remove_file(record_path(root, &task_id));
            }
            Ok(status)
        }
        Err(error) => {
            status = read_status(root, Some(request_id))?
                .ok_or_else(|| "SAMPLE_STATUS_MISSING".to_owned())?;
            status.phase = "failed".to_owned();
            status.error_code = Some(if is_retryable_save_error(&error) {
                error.clone()
            } else {
                "REPORT_SAVE_FAILED".to_owned()
            });
            status.updated_at_utc = now_utc();
            let _ = save_status(root, &status);
            Err(error)
        }
    }
}

fn is_retryable_save_error(error: &str) -> bool {
    matches!(
        error,
        "REPORT_SAVE_FAILED"
            | "SAVE_UNCONFIRMED"
            | "SAVE_UNAVAILABLE"
            | "DOCUMENTS_NOT_WRITABLE"
            | "DOCUMENTS_FOLDER_UNAVAILABLE"
            | "REPORT_TEMP_CREATE_FAILED"
            | "REPORT_WRITE_FAILED"
            | "REPORT_PUBLISH_FAILED"
    )
}

#[cfg(not(windows))]
pub fn save_report(_root: &Path, _request_id: &str, _task_id: &str) -> Result<PathBuf, String> {
    Err("WINDOWS_ONLY".to_owned())
}

#[cfg(not(windows))]
pub fn retry_save(_root: &Path, _request_id: &str) -> Result<MemorySampleStatus, String> {
    Err("WINDOWS_ONLY".to_owned())
}

#[cfg(windows)]
fn report_matches_task(path: &Path, task_id: &str) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_REPORT_BYTES
    {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut header = vec![0; 4096];
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    String::from_utf8_lossy(&header[..read]).contains(&format!("Task ID: {task_id}"))
}

#[cfg(windows)]
fn render_report<W: Write>(
    records: &[SampleRecord],
    truncated_tail: bool,
    writer: &mut W,
    task_id: &str,
    status: &MemorySampleStatus,
) -> Result<(), String> {
    let summaries = records
        .iter()
        .map(|record| &record.summary)
        .collect::<Vec<_>>();
    let complete = summaries
        .iter()
        .filter(|sample| sample.complete)
        .collect::<Vec<_>>();
    let incomplete_count = summaries
        .iter()
        .filter(|sample| {
            !sample.complete && sample.missing_reason.as_deref() != Some("SAMPLE_MISSED")
        })
        .count();
    let missed_count = summaries
        .iter()
        .filter(|sample| sample.missing_reason.as_deref() == Some("SAMPLE_MISSED"))
        .count();
    let working_set = complete
        .iter()
        .map(|sample| sample.working_set_bytes)
        .collect::<Vec<_>>();
    let private = complete
        .iter()
        .map(|sample| sample.private_bytes)
        .collect::<Vec<_>>();
    let sampling_start = utc_boundary(&status.started_at_utc, WARMUP_SECONDS);
    let first_window_end = sampling_start
        .as_deref()
        .and_then(|start| utc_boundary(start, 120));
    let last_window_start = sampling_start
        .as_deref()
        .and_then(|start| utc_boundary(start, SAMPLE_SECONDS.saturating_sub(120)));
    let sampling_end = sampling_start
        .as_deref()
        .and_then(|start| utc_boundary(start, SAMPLE_SECONDS));
    let early = complete
        .iter()
        .filter(|sample| {
            timestamp_in_window(
                sample.actual_time_utc.as_deref(),
                sampling_start.as_deref(),
                first_window_end.as_deref(),
            )
        })
        .map(|sample| sample.private_bytes)
        .collect::<Vec<_>>();
    let late = complete
        .iter()
        .filter(|sample| {
            timestamp_in_window(
                sample.actual_time_utc.as_deref(),
                last_window_start.as_deref(),
                sampling_end.as_deref(),
            )
        })
        .map(|sample| sample.private_bytes)
        .collect::<Vec<_>>();
    let comparable = status.elapsed_seconds >= WARMUP_SECONDS + SAMPLE_SECONDS
        && complete.len() >= REQUIRED_COMPLETE_SAMPLES
        && early.len() >= REQUIRED_WINDOW_SAMPLES
        && late.len() >= REQUIRED_WINDOW_SAMPLES;
    let process_range = records
        .iter()
        .filter(|record| record.summary.actual_time_utc.is_some())
        .map(|record| record.summary.discovered_processes);
    let process_min = process_range.clone().min().unwrap_or(0);
    let process_max = process_range.max().unwrap_or(0);
    writeln!(writer, "NGTManager process memory sample")
        .and_then(|_| writeln!(writer, "Format version: 1"))
        .and_then(|_| writeln!(writer, "Task ID: {task_id}"))
        .and_then(|_| writeln!(writer, "NGTManager version: {}", status.software_version))
        .and_then(|_| writeln!(writer, "Started at UTC: {}", status.started_at_utc))
        .and_then(|_| writeln!(writer, "Finished at UTC: {}", now_utc()))
        .and_then(|_| writeln!(writer, "Windows version: {}", windows_version()))
        .and_then(|_| writeln!(writer, "Warmup seconds: {WARMUP_SECONDS}"))
        .and_then(|_| writeln!(writer, "Sampling seconds: {SAMPLE_SECONDS}"))
        .and_then(|_| writeln!(writer, "Interval seconds: {SAMPLE_INTERVAL_SECONDS}"))
        .and_then(|_| writeln!(writer, "Planned samples: {}", PLANNED_SAMPLES))
        .and_then(|_| writeln!(writer, "Recorded samples: {}", status.recorded_samples))
        .and_then(|_| writeln!(writer, "Complete samples: {}", complete.len()))
        .and_then(|_| writeln!(writer, "Incomplete samples: {incomplete_count}"))
        .and_then(|_| writeln!(writer, "Missed samples: {missed_count}"))
        .and_then(|_| {
            if truncated_tail {
                writeln!(writer, "Recovery note: an incomplete trailing sample record was omitted; totals use valid records.")
            } else {
                Ok(())
            }
        })
        .and_then(|_| writeln!(writer, "Process count range: {process_min}–{process_max}"))
        .and_then(|_| {
            writeln!(
                writer,
                "Ended reason: {}",
                status.ended_reason.as_deref().unwrap_or("completed")
            )
        })
        .and_then(|_| {
            writeln!(
                writer,
                "Working Set median / P95 / peak (MiB): {} / {} / {}",
                mib_stat(median(&working_set)),
                mib_stat(percentile95(&working_set)),
                mib_stat(working_set.iter().copied().max())
            )
        })
        .and_then(|_| {
            writeln!(
                writer,
                "Private Bytes median / P95 / peak (MiB): {} / {} / {}",
                mib_stat(median(&private)),
                mib_stat(percentile95(&private)),
                mib_stat(private.iter().copied().max())
            )
        })
        .and_then(|_| {
            writeln!(
                writer,
                "Private Bytes first / last 2-minute medians (MiB): {} / {}",
                mib_stat(median(&early)),
                mib_stat(median(&late))
            )
        })
        .and_then(|_| {
            writeln!(
                writer,
                "Version comparison: {}",
                if comparable {
                    "comparable"
                } else {
                    "not comparable; repeat the full sample"
                }
            )
        })
        .and_then(|_| {
            writeln!(
                writer,
                "Note: Peaks shorter than the 2-second interval may be missed."
            )
        })
        .and_then(|_| writeln!(writer, "\nPer-sample CSV (sample ID links process rows)"))
        .map_err(|_| "REPORT_WRITE_FAILED".to_owned())?;
    let mut limited = LimitedWriter::new(writer, MAX_REPORT_BYTES.saturating_sub(12 * 1024));
    limited.line("sampleId,plannedSeconds,actualTimeUtc,discoveredProcesses,readProcesses,workingSetMiB,privateBytesMiB,complete,missingReason")?;
    let mut omitted_samples = 0usize;
    let mut omitted_sample_range = None;
    for record in records {
        let summary = &record.summary;
        let line = format!(
            "{},{},{},{},{},{},{},{},{}",
            summary.sample_id,
            summary.planned_seconds,
            csv(summary.actual_time_utc.as_deref().unwrap_or("")),
            summary.discovered_processes,
            summary.read_processes,
            mib_value(summary.working_set_bytes),
            mib_value(summary.private_bytes),
            summary.complete,
            csv(summary.missing_reason.as_deref().unwrap_or("")),
        );
        if !limited.line(&line)? {
            omitted_samples += 1;
            omitted_sample_range
                .get_or_insert((summary.sample_id, summary.sample_id))
                .1 = summary.sample_id;
        }
    }
    limited.line("\nPer-process CSV")?;
    limited.line(
        "sampleId,name,pid,parentPid,creationTimeUtc,workingSetMiB,privateBytesMiB,readStatus",
    )?;
    let mut omitted_processes = 0usize;
    let mut omitted_process_range = None;
    for record in records {
        for process in &record.processes {
            let line = format!(
                "{},{},{},{},{},{},{},{}",
                record.summary.sample_id,
                csv(&process.name),
                process.pid,
                process.parent_pid,
                csv(process.creation_time_utc.as_deref().unwrap_or("")),
                process.working_set_bytes.map(mib_value).unwrap_or_default(),
                process.private_bytes.map(mib_value).unwrap_or_default(),
                csv(&process.read_status),
            );
            if !limited.line(&line)? {
                omitted_processes += 1;
                omitted_process_range
                    .get_or_insert((record.summary.sample_id, record.summary.sample_id))
                    .1 = record.summary.sample_id;
            }
        }
    }
    if omitted_samples + omitted_processes > 0 || status.details_limited {
        let sample_range = omitted_sample_range
            .map(|(first, last)| format!("{first}-{last}"))
            .unwrap_or_else(|| "none".to_owned());
        let process_range = omitted_process_range
            .map(|(first, last)| format!("{first}-{last}"))
            .unwrap_or_else(|| "none".to_owned());
        limited.line(&format!(
            "\nOmitted rows: samples={} (IDs {}), processes={} (sample IDs {}); detailLimitReached={}",
            omitted_samples,
            sample_range,
            omitted_processes,
            process_range,
            status.details_limited
        ))?;
    }
    let peak = complete
        .iter()
        .max_by_key(|sample| sample.private_bytes)
        .map(|sample| sample.sample_id);
    if let Some(peak) = peak {
        let mut processes = records
            .iter()
            .find(|record| record.summary.sample_id == peak)
            .map(|record| record.processes.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        processes.sort_by_key(|process| std::cmp::Reverse(process.private_bytes.unwrap_or(0)));
        let heading = format!("\nLargest processes at Private Bytes peak (sample {peak})");
        limited.line(&heading)?;
        for process in processes.into_iter().take(10) {
            limited.line(&format!(
                "{} pid={} privateMiB={} workingSetMiB={}",
                process.name,
                process.pid,
                process.private_bytes.map(mib_value).unwrap_or_default(),
                process.working_set_bytes.map(mib_value).unwrap_or_default()
            ))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn read_records(path: &Path) -> Result<(Vec<SampleRecord>, bool), String> {
    let file = File::open(path).map_err(|_| "SAMPLE_RECORD_MISSING".to_owned())?;
    let mut records = Vec::with_capacity(PLANNED_SAMPLES);
    let mut reader = BufReader::with_capacity(IO_BUFFER_BYTES, file);
    let mut line = Vec::with_capacity(IO_BUFFER_BYTES);
    let mut truncated_tail = false;
    loop {
        line.clear();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| "SAMPLE_RECORD_READ_FAILED".to_owned())?;
        if bytes == 0 {
            break;
        }
        if line.len() > IO_BUFFER_BYTES {
            return Err("SAMPLE_RECORD_INVALID".to_owned());
        }
        let record = match serde_json::from_slice(&line) {
            Ok(record) => record,
            Err(_) if line.last() != Some(&b'\n') => {
                truncated_tail = true;
                break;
            }
            Err(_) => return Err("SAMPLE_RECORD_INVALID".to_owned()),
        };
        records.push(record);
        if records.len() > PLANNED_SAMPLES {
            return Err("SAMPLE_RECORD_INVALID".to_owned());
        }
    }
    Ok((records, truncated_tail))
}

#[cfg(windows)]
struct LimitedWriter<'a, W> {
    writer: &'a mut W,
    written: u64,
    limit: u64,
}

#[cfg(windows)]
impl<'a, W: Write> LimitedWriter<'a, W> {
    fn new(writer: &'a mut W, limit: u64) -> Self {
        Self {
            writer,
            written: 0,
            limit,
        }
    }

    fn line(&mut self, line: &str) -> Result<bool, String> {
        let bytes = line.as_bytes();
        if self.written.saturating_add(bytes.len() as u64 + 1) > self.limit {
            return Ok(false);
        }
        self.writer
            .write_all(bytes)
            .and_then(|_| self.writer.write_all(b"\n"))
            .map_err(|_| "REPORT_WRITE_FAILED".to_owned())?;
        self.written += bytes.len() as u64 + 1;
        Ok(true)
    }
}

#[cfg(windows)]
fn csv(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn median(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    Some(if sorted.len() % 2 == 0 {
        sorted[middle - 1] / 2
            + sorted[middle] / 2
            + (sorted[middle - 1] % 2 + sorted[middle] % 2) / 2
    } else {
        sorted[middle]
    })
}

fn percentile95(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = ((sorted.len() as f64) * 0.95).ceil() as usize;
    sorted.get(rank.saturating_sub(1)).copied()
}

#[cfg(windows)]
fn mib_value(bytes: u64) -> String {
    format!("{:.2}", bytes as f64 / (1024.0 * 1024.0))
}

#[cfg(windows)]
fn mib_stat(value: Option<u64>) -> String {
    value.map(mib_value).unwrap_or_else(|| "n/a".to_owned())
}

#[cfg(windows)]
fn windows_version() -> String {
    #[repr(C)]
    struct VersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut VersionInfo) -> i32;
    }
    let mut info = VersionInfo {
        size: std::mem::size_of::<VersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    if unsafe { RtlGetVersion(&mut info) } == 0 {
        format!("Windows {}.{}.{}", info.major, info.minor, info.build)
    } else {
        "Windows version unavailable".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_contract_uses_300_points_and_fixed_quality_thresholds() {
        assert_eq!(WARMUP_SECONDS, 120);
        assert_eq!(SAMPLE_SECONDS, 600);
        assert_eq!(SAMPLE_INTERVAL_SECONDS, 2);
        assert_eq!(PLANNED_SAMPLES, 300);
        assert_eq!(REQUIRED_COMPLETE_SAMPLES, 270);
        assert_eq!(REQUIRED_WINDOW_SAMPLES, 54);
    }

    #[test]
    fn queued_task_can_resume_after_record_creation_was_interrupted() {
        let root = std::env::temp_dir().join(format!(
            "ngt-memory-queued-record-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let record = root.join("record.jsonl");
        prepare_record_file(&record).unwrap();
        prepare_record_file(&record).unwrap();
        fs::write(&record, b"partial data").unwrap();
        assert!(prepare_record_file(&record).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn timed_out_worker_keeps_readable_process_data_in_an_incomplete_sample() {
        let root = std::env::temp_dir().join(format!(
            "ngt-memory-timeout-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let request_id = "43c83ea9-9e27-4db1-9fe9-97f1e6909e41".to_owned();
        let task_id = "20261111T120000Z-43c83ea9-9e27-4db1-9fe9-97f1e6909e41".to_owned();
        fs::create_dir_all(store_dir(&root)).unwrap();
        File::create(record_path(&root, &task_id)).unwrap();
        let status = MemorySampleStatus {
            format_version: 1,
            request_id,
            task_id: Some(task_id.clone()),
            software_version: "2.1.0".to_owned(),
            phase: "sampling".to_owned(),
            started_at_utc: now_utc(),
            updated_at_utc: now_utc(),
            expires_at_utc: expiry_time(),
            elapsed_seconds: 1,
            planned_samples: PLANNED_SAMPLES,
            recorded_samples: 0,
            complete_samples: 0,
            incomplete_samples: 0,
            missed_samples: 0,
            report_path: None,
            expected_report_path: None,
            ended_reason: None,
            error_code: None,
            details_limited: false,
        };
        let mut active = ActiveTask {
            status,
            start_tick: tick_count_ms(),
            next_sample: 0,
            last_status_bucket: 0,
            pending_sample: None,
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(sender);
        let pending = PendingSample {
            sample_id: 1,
            planned_seconds: 0,
            actual_time_utc: now_utc(),
            started_tick: tick_count_ms().saturating_sub(1_001),
            receiver,
            worker: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            discovered: Some(2),
            processes: vec![ProcessReading {
                name: "node.exe".to_owned(),
                pid: 101,
                parent_pid: 100,
                creation_time_utc: Some(now_utc()),
                working_set_bytes: Some(8 * 1024 * 1024),
                private_bytes: Some(6 * 1024 * 1024),
                read_status: "ok".to_owned(),
            }],
            completion: None,
            recorded: false,
        };
        record_pending_sample(&root, &mut active, &pending, Some("SAMPLE_BUDGET_EXCEEDED"))
            .unwrap();
        let (records, truncated_tail) = read_records(&record_path(&root, &task_id)).unwrap();
        assert_eq!(records.len(), 1);
        assert!(!truncated_tail);
        assert_eq!(records[0].summary.read_processes, 1);
        assert_eq!(records[0].summary.discovered_processes, 2);
        assert!(!records[0].summary.complete);
        assert_eq!(
            records[0].summary.missing_reason.as_deref(),
            Some("SAMPLE_BUDGET_EXCEEDED")
        );
        assert_eq!(active.status.incomplete_samples, 1);
        assert_eq!(active.next_sample, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn record_reader_recovers_only_an_unterminated_final_record() {
        let root = std::env::temp_dir().join(format!(
            "ngt-memory-torn-record-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(store_dir(&root)).unwrap();
        let path = record_path(
            &root,
            "20261111T120000Z-43c83ea9-9e27-4db1-9fe9-97f1e6909e41",
        );
        let record = SampleRecord {
            summary: SampleSummary {
                sample_id: 1,
                planned_seconds: 0,
                actual_time_utc: Some(now_utc()),
                discovered_processes: 1,
                read_processes: 1,
                working_set_bytes: 1,
                private_bytes: 1,
                complete: true,
                missing_reason: None,
            },
            processes: Vec::new(),
        };
        let mut file = File::create(&path).unwrap();
        serde_json::to_writer(&mut file, &record).unwrap();
        file.write_all(b"\n{\"summary\":").unwrap();
        drop(file);
        let (records, truncated_tail) = read_records(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert!(truncated_tail);
        fs::write(&path, b"{invalid}\n").unwrap();
        assert!(matches!(
            read_records(&path),
            Err(error) if error == "SAMPLE_RECORD_INVALID"
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn percentile_uses_nearest_rank_and_median_handles_even_counts() {
        assert_eq!(median(&[5, 1, 3, 7]), Some(4));
        assert_eq!(median(&[]), None);
        assert_eq!(percentile95(&(1..=20).collect::<Vec<_>>()), Some(19));
        assert_eq!(percentile95(&[]), None);
    }

    #[test]
    fn request_ids_are_strict_uuids() {
        assert!(valid_request_id("43c83ea9-9e27-4db1-9fe9-97f1e6909e41"));
        assert!(!valid_request_id("../latest"));
        assert!(!valid_request_id("43c83ea9-9e27-4db1-9fe9-97f1e6909e4g"));
        assert!(!valid_request_id("43c83ea99e274db19fe997f1e6909e41"));
    }

    #[test]
    fn request_retry_and_alias_never_create_duplicate_pending_work() {
        let root = std::env::temp_dir().join(format!(
            "ngt-memory-request-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = "43c83ea9-9e27-4db1-9fe9-97f1e6909e41";
        let second = "5b56e417-03ab-494f-a713-f84e7e19d6ef";
        enqueue(&root, first).unwrap();
        enqueue(&root, first).unwrap();
        enqueue(&root, second).unwrap();
        assert!(pending_dir(&root).join(format!("{first}.json")).is_file());
        assert!(!pending_dir(&root).join(format!("{second}.json")).exists());
        let first_status = read_status(&root, Some(first)).unwrap().unwrap();
        let second_status = read_status(&root, Some(second)).unwrap().unwrap();
        assert_eq!(first_status.phase, "queued");
        assert_eq!(second_status.phase, "queued");
        assert_eq!(first_status.task_id, second_status.task_id);
        assert_eq!(fs::read_dir(pending_dir(&root)).unwrap().count(), 1);
        let mut progressing = read_status_file(&latest_path(&root)).unwrap().unwrap();
        progressing.phase = "warmup".to_owned();
        save_status(&root, &progressing).unwrap();
        assert_eq!(
            read_status(&root, Some(second)).unwrap().unwrap().phase,
            "warmup"
        );
        let _ = fs::remove_dir_all(root);
    }
}
