//! macOS: Seatbelt sandbox for the worker, and the memory readings the host uses to
//! enforce `WORKER_MEMORY_LIMIT`.

use std::ffi::{CStr, CString, c_char, c_int};
use std::ptr;

unsafe extern "C" {
    // libsystem_sandbox, part of libSystem. Deprecated in the headers since 10.8 but
    // still supported; Chromium and Firefox sandbox their content processes with it.
    fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
    fn sandbox_free_error(errorbuf: *mut c_char);
}

/// The worker's Seatbelt profile. Everything is denied except reading the installed
/// font folders, which `fontdb` and PDFium scan lazily, after the sandbox is on.
/// The worker talks to the host only over its inherited stdin/stdout pipes, which
/// need no rule. `home` adds the user's own font folder.
pub fn profile(home: Option<&str>) -> String {
    let mut fonts = vec![
        r#"(subpath "/System/Library/Fonts")"#.to_string(),
        r#"(subpath "/Library/Fonts")"#.to_string(),
        r#"(subpath "/Network/Library/Fonts")"#.to_string(),
        // Fonts downloaded on demand. The parent is listed to find them.
        r#"(literal "/System/Library/AssetsV2")"#.to_string(),
        r#"(regex #"^/System/Library/AssetsV2/com_apple_MobileAsset_Font")"#.to_string(),
    ];
    if let Some(home) = home.filter(|h| h.starts_with('/') && !h.contains('\0')) {
        fonts.push(format!(r#"(subpath "{}/Library/Fonts")"#, escape(home.trim_end_matches('/'))));
    }
    format!(
        "(version 1)\n\
         (deny default)\n\
         (allow signal (target self))\n\
         (allow file-read* {})\n",
        fonts.join(" ")
    )
}

/// Escapes a value for an SBPL string literal.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Enters the sandbox. Irreversible for the life of the process.
fn enter(profile: &str) -> Result<(), String> {
    let profile = CString::new(profile).map_err(|_| "profile contains NUL".to_string())?;
    let mut err: *mut c_char = ptr::null_mut();
    // flags 0: `profile` is the profile text, not the name of a built-in one.
    if unsafe { sandbox_init(profile.as_ptr(), 0, &mut err) } == 0 {
        return Ok(());
    }
    if err.is_null() {
        return Err("sandbox_init failed".into());
    }
    let message = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
    unsafe { sandbox_free_error(err) };
    Err(message)
}

pub fn harden_worker() {
    let home = std::env::var("HOME").ok();
    if let Err(e) = enter(&profile(home.as_deref())) {
        eprintln!("[pdf-worker] could not enter the sandbox: {e}");
    }
}

/// A process's memory use, with its start time so a reading can be matched to the
/// process it was meant for (pids are reused).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    /// Physical footprint: what Activity Monitor shows as Memory and what the
    /// kernel's memory-pressure logic uses.
    pub footprint: u64,
    pub started: u64,
}

/// Reads another process's memory use. `None` if it has exited.
pub fn usage(pid: u32) -> Option<Usage> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::proc_pid_rusage(
            pid as c_int,
            libc::RUSAGE_INFO_V2,
            &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t,
        )
    };
    (rc == 0).then_some(Usage { footprint: info.ri_phys_footprint, started: info.ri_proc_start_abstime })
}

pub fn kill(pid: u32) {
    unsafe { libc::kill(pid as c_int, libc::SIGKILL) };
}

#[cfg(test)]
mod tests;
