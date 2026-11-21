//! Host side of the worker pool.
//!
//! Worker 0 serves interactive requests (page view, text extraction, saving) so they
//! never queue behind a flood of thumbnails; the remaining workers render thumbnails.
//! Each worker loads documents lazily from bytes the host keeps in memory, so a
//! crashed worker can be replaced transparently.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::protocol::{DocId, PageInfo, Request, Response, async_io};
use crate::worker::WORKER_FLAG;

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(60);
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(30);
pub const EXTRACT_TIMEOUT: Duration = Duration::from_secs(30);
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(180);
pub const SAVE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy)]
pub enum Lane {
    Interactive,
    Background,
}

struct Proc {
    // Field order matters: pipes close before the child handle drops (kill_on_drop).
    stdin: ChildStdin,
    stdout: ChildStdout,
    child: Child,
    #[cfg(windows)]
    _job: crate::sandbox::Job,
}

#[derive(Default)]
struct Slot {
    proc: Option<Proc>,
    loaded: HashSet<DocId>,
}

pub struct Pool {
    exe: PathBuf,
    lib_dir: Option<PathBuf>,
    workers: Vec<Mutex<Slot>>,
    docs: RwLock<HashMap<DocId, Arc<Vec<u8>>>>,
    next_doc: AtomicU32,
    next_bg: AtomicUsize,
}

impl Pool {
    pub fn new(lib_dir: Option<PathBuf>) -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|e| format!("Cannot locate app executable: {e}"))?;
        let cores = std::thread::available_parallelism().map_or(2, |n| n.get());
        let count = if cores >= 8 { 3 } else { 2 };
        Ok(Self {
            exe,
            lib_dir,
            workers: (0..count).map(|_| Mutex::new(Slot::default())).collect(),
            docs: RwLock::new(HashMap::new()),
            next_doc: AtomicU32::new(1),
            next_bg: AtomicUsize::new(0),
        })
    }

    fn spawn(&self) -> Result<Proc, String> {
        let mut cmd = Command::new(&self.exe);
        cmd.arg(WORKER_FLAG);
        if let Some(dir) = &self.lib_dir {
            cmd.arg("--pdfium").arg(dir);
        }
        // Minimal environment: nothing from the user's session leaks to the worker.
        cmd.env_clear();
        for key in ["SystemRoot", "windir", "LOCALAPPDATA", "HOME", "XDG_DATA_HOME", "XDG_DATA_DIRS"] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| format!("Could not start the PDF engine: {e}"))?;

        #[cfg(windows)]
        let job = {
            let handle = child.raw_handle().ok_or("PDF engine exited immediately")?;
            crate::sandbox::Job::confine(handle as _, crate::sandbox::WORKER_MEMORY_LIMIT)
                .map_err(|e| format!("Could not sandbox the PDF engine: {e}"))?
        };

        let stdin = child.stdin.take().ok_or("No stdin for PDF engine")?;
        let stdout = child.stdout.take().ok_or("No stdout for PDF engine")?;
        Ok(Proc {
            stdin,
            stdout,
            child,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Sends one request on a locked slot. Any transport failure or timeout kills the
    /// worker; the next request starts a fresh one.
    async fn exchange(
        &self,
        slot: &mut Slot,
        req: &Request,
        payload: &[u8],
        timeout: Duration,
    ) -> Result<(serde_json::Value, Vec<u8>), String> {
        if slot.proc.is_none() {
            slot.proc = Some(self.spawn()?);
            slot.loaded.clear();
        }
        let header = serde_json::to_vec(req).map_err(|e| e.to_string())?;
        let proc = slot.proc.as_mut().unwrap();

        let io = async {
            async_io::write_frame(&mut proc.stdin, &header, payload).await?;
            async_io::read_frame(&mut proc.stdout).await
        };
        let outcome = tokio::time::timeout(timeout, io).await;

        let (resp_header, resp_payload) = match outcome {
            Ok(Ok(frame)) => frame,
            other => {
                let timed_out = other.is_err();
                if let Some(mut p) = slot.proc.take() {
                    let _ = p.child.start_kill();
                }
                slot.loaded.clear();
                return Err(if timed_out {
                    "The PDF engine took too long and was restarted. The file may be very complex or malformed.".into()
                } else {
                    "The PDF engine stopped while processing this file and was restarted. The file may be damaged or malicious.".into()
                });
            }
        };

        match serde_json::from_slice::<Response>(&resp_header) {
            Ok(Response::Ok { result }) => Ok((result, resp_payload)),
            Ok(Response::Err { message }) => Err(message),
            Err(_) => {
                if let Some(mut p) = slot.proc.take() {
                    let _ = p.child.start_kill();
                }
                slot.loaded.clear();
                Err("The PDF engine sent an invalid reply and was restarted.".into())
            }
        }
    }

    /// Drops a worker that died while idle (a crash from an earlier request, the job's
    /// memory cap, or the OS), so the next request starts a fresh one and reloads its
    /// documents instead of failing for something it did not cause.
    fn reap(slot: &mut Slot) {
        if let Some(p) = slot.proc.as_mut()
            && !matches!(p.child.try_wait(), Ok(None))
        {
            slot.proc = None;
            slot.loaded.clear();
        }
    }

    async fn lock(&self, lane: Lane) -> tokio::sync::MutexGuard<'_, Slot> {
        let mut guard = self.lock_slot(lane).await;
        Self::reap(&mut guard);
        guard
    }

    async fn lock_slot(&self, lane: Lane) -> tokio::sync::MutexGuard<'_, Slot> {
        match lane {
            Lane::Interactive => self.workers[0].lock().await,
            Lane::Background => {
                let bg = &self.workers[1..];
                for w in bg {
                    if let Ok(g) = w.try_lock() {
                        return g;
                    }
                }
                let i = self.next_bg.fetch_add(1, Ordering::Relaxed) % bg.len();
                bg[i].lock().await
            }
        }
    }

    async fn ensure_loaded(&self, slot: &mut Slot, ids: &[DocId]) -> Result<(), String> {
        for &id in ids {
            if slot.loaded.contains(&id) && slot.proc.is_some() {
                continue;
            }
            let bytes = self
                .docs
                .read()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or("This document has been closed.")?;
            self.exchange(slot, &Request::Open { doc_id: id }, &bytes, OPEN_TIMEOUT)
                .await?;
            slot.loaded.insert(id);
        }
        Ok(())
    }

    pub async fn call(
        &self,
        lane: Lane,
        req: Request,
        timeout: Duration,
    ) -> Result<(serde_json::Value, Vec<u8>), String> {
        let mut slot = self.lock(lane).await;
        self.ensure_loaded(&mut slot, &req.doc_ids()).await?;
        self.exchange(&mut slot, &req, &[], timeout).await
    }

    /// Registers a document's bytes and parses it in the interactive worker.
    pub async fn open(&self, bytes: Vec<u8>) -> Result<(DocId, Vec<PageInfo>), String> {
        let id = self.next_doc.fetch_add(1, Ordering::Relaxed);
        let bytes = Arc::new(bytes);
        self.docs.write().unwrap().insert(id, bytes.clone());

        let mut slot = self.lock(Lane::Interactive).await;
        let result = self
            .exchange(&mut slot, &Request::Open { doc_id: id }, &bytes, OPEN_TIMEOUT)
            .await
            .and_then(|(v, _)| serde_json::from_value::<Vec<PageInfo>>(v).map_err(|e| e.to_string()));
        match result {
            Ok(pages) => {
                slot.loaded.insert(id);
                Ok((id, pages))
            }
            Err(e) => {
                drop(slot);
                self.docs.write().unwrap().remove(&id);
                Err(e)
            }
        }
    }

    pub async fn close(&self, id: DocId) {
        self.docs.write().unwrap().remove(&id);
        for w in &self.workers {
            let mut slot = w.lock().await;
            Self::reap(&mut slot);
            if slot.loaded.remove(&id) && slot.proc.is_some() {
                let _ = self
                    .exchange(&mut slot, &Request::Close { doc_id: id }, &[], OPEN_TIMEOUT)
                    .await;
            }
        }
    }
}
