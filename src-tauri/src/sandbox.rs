//! OS-level hardening for the PDF worker.
//!
//! Windows, host side: each worker runs in its own Job Object with a memory cap, one
//! process only (no children) and UI restrictions, and it dies with the app.
//!
//! Windows, worker side: after PDFium is loaded the worker lowers itself to Low
//! integrity (no writes to user files or the registry) and enables mitigation
//! policies: no dynamic code, no extension-point DLLs, no remote or low-label image
//! loads, strict handle checks.
//!
//! macOS, worker side: after PDFium is loaded the worker enters a Seatbelt sandbox
//! (`sandbox_init`) that denies everything except reading the installed font folders.
//! No file writes, no other file reads, no network, no starting programs.
//!
//! macOS, host side: there is no Job Object equivalent, so the host polls each
//! worker's physical footprint (`MEMORY_POLL`) and kills one that goes over the cap.
//! The pool then restarts it like any crashed worker.
//!
//! Linux: the worker is still a separate process with timeouts and restart; add
//! seccomp/landlock and a memory cap before shipping there.

/// Memory cap for one worker process: enforced by the Job Object on Windows and by
/// the host's watchdog on macOS.
#[cfg(any(windows, target_os = "macos"))]
pub const WORKER_MEMORY_LIMIT: usize = 3 * 1024 * 1024 * 1024;

/// How often the macOS host checks worker memory. A worker can overshoot the cap by
/// whatever it allocates in this time before it is killed.
#[cfg(target_os = "macos")]
pub const MEMORY_POLL: std::time::Duration = std::time::Duration::from_millis(500);

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows_sys::Win32::Security::{
        GetLengthSid, PSID, SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_ADJUST_DEFAULT,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT_DESKTOP,
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
        JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES,
        JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD, JOBOBJECT_BASIC_UI_RESTRICTIONS,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, ProcessDynamicCodePolicy,
        ProcessExtensionPointDisablePolicy, ProcessImageLoadPolicy,
        ProcessStrictHandleCheckPolicy, SetProcessMitigationPolicy,
    };

    pub struct Job(HANDLE);

    // The handle is only used to keep the job alive and is closed on drop.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Job {
        pub fn confine(process: HANDLE, memory_limit: usize) -> Result<Job, String> {
            unsafe {
                let job = CreateJobObjectW(ptr::null(), ptr::null());
                if job.is_null() {
                    return Err("CreateJobObject failed".into());
                }
                let job = Job(job);

                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
                limits.BasicLimitInformation.ActiveProcessLimit = 1;
                limits.ProcessMemoryLimit = memory_limit;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err("SetInformationJobObject(limits) failed".into());
                }

                let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                    UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                        | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                        | JOB_OBJECT_UILIMIT_EXITWINDOWS
                        | JOB_OBJECT_UILIMIT_GLOBALATOMS
                        | JOB_OBJECT_UILIMIT_HANDLES
                        | JOB_OBJECT_UILIMIT_READCLIPBOARD
                        | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                        | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
                };
                // UI limits are defence in depth; failing to set them is not fatal.
                SetInformationJobObject(
                    job.0,
                    JobObjectBasicUIRestrictions,
                    &ui as *const _ as *const c_void,
                    size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                );

                if AssignProcessToJobObject(job.0, process) == 0 {
                    return Err("AssignProcessToJobObject failed".into());
                }
                Ok(job)
            }
        }
    }

    fn set_policy(policy: i32, flags: u32, name: &str) {
        let ok = unsafe {
            SetProcessMitigationPolicy(policy, &flags as *const u32 as *const c_void, size_of::<u32>())
        };
        if ok == 0 {
            eprintln!("[pdf-worker] could not enable {name} mitigation");
        }
    }

    fn lower_integrity() -> Result<(), String> {
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, &mut token) == 0 {
                return Err("OpenProcessToken failed".into());
            }
            let low: Vec<u16> = "S-1-16-4096\0".encode_utf16().collect();
            let mut sid: PSID = ptr::null_mut();
            if ConvertStringSidToSidW(low.as_ptr(), &mut sid) == 0 {
                CloseHandle(token);
                return Err("ConvertStringSidToSid failed".into());
            }
            let label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: SE_GROUP_INTEGRITY as u32 },
            };
            let ok = SetTokenInformation(
                token,
                TokenIntegrityLevel,
                &label as *const _ as *const c_void,
                size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(sid),
            );
            LocalFree(sid as _);
            CloseHandle(token);
            if ok == 0 {
                return Err("SetTokenInformation(IntegrityLevel) failed".into());
            }
            Ok(())
        }
    }

    pub fn harden_worker() {
        // Bit 0 of each policy struct: ProhibitDynamicCode / DisableExtensionPoints /
        // RaiseExceptionOnInvalidHandleReference. Image load: NoRemoteImages |
        // NoLowMandatoryLabelImages | PreferSystem32Images.
        set_policy(ProcessDynamicCodePolicy, 0b1, "dynamic-code");
        set_policy(ProcessExtensionPointDisablePolicy, 0b1, "extension-point");
        set_policy(ProcessImageLoadPolicy, 0b111, "image-load");
        set_policy(ProcessStrictHandleCheckPolicy, 0b11, "strict-handle");
        if let Err(e) = lower_integrity() {
            eprintln!("[pdf-worker] could not lower integrity level: {e}");
        }
    }
}

#[cfg(windows)]
pub use imp::Job;

#[cfg(windows)]
pub fn harden_worker() {
    imp::harden_worker();
}

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::{Usage, harden_worker, kill, profile, usage};

#[cfg(not(any(windows, target_os = "macos")))]
pub fn harden_worker() {}
