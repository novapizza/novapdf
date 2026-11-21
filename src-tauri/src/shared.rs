//! Document bytes shared read-only between the host and its PDF workers.
//!
//! Without sharing, a document's bytes would live once in the host and once more in
//! every worker that loads it (up to four copies of a 500 MB file). On Windows the
//! host instead copies them once into an anonymous, unnamed, pagefile-backed section;
//! each worker gets its own handle with map-read access only and maps a view, so all
//! processes share the same physical pages. Elsewhere the bytes are sent over the pipe.

/// A document's bytes, as the host keeps them.
pub enum DocBytes {
    /// Sent to each worker in the `Open` payload.
    Owned(Vec<u8>),
    #[cfg(windows)]
    Shared(win::Section),
}

impl DocBytes {
    /// Moves the bytes into shared memory where the platform supports it. If the
    /// section cannot be created (for example, the system is out of commit), the
    /// bytes are kept as they are and sent over the pipe instead.
    pub fn new(bytes: Vec<u8>) -> Self {
        #[cfg(windows)]
        if let Ok(section) = win::Section::new(&bytes) {
            return DocBytes::Shared(section);
        }
        DocBytes::Owned(bytes)
    }

    pub fn len(&self) -> usize {
        match self {
            DocBytes::Owned(v) => v.len(),
            #[cfg(windows)]
            DocBytes::Shared(s) => s.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The bytes a worker hands to PDFium. PDFium reads lazily from this buffer, so it
/// must outlive the document.
pub enum Backing {
    Owned(Vec<u8>),
    #[cfg(windows)]
    Mapped(win::View),
}

impl Backing {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Backing::Owned(v) => v,
            #[cfg(windows)]
            Backing::Mapped(m) => m.as_slice(),
        }
    }
}

#[cfg(windows)]
pub mod win {
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Memory::{
        CreateFileMappingW, FILE_MAP_READ, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS,
        MapViewOfFile, PAGE_READWRITE, UnmapViewOfFile,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    use crate::protocol::MAX_DOC_BYTES;

    /// Host side: an anonymous section holding one document.
    pub struct Section {
        handle: HANDLE,
        len: usize,
    }

    // The handle is owned exclusively and only used through thread-safe Win32 calls.
    unsafe impl Send for Section {}
    unsafe impl Sync for Section {}

    impl Section {
        pub fn new(bytes: &[u8]) -> Result<Self, String> {
            let len = bytes.len();
            if len == 0 || len as u64 > MAX_DOC_BYTES {
                return Err("Invalid document size".into());
            }
            unsafe {
                let size = len as u64;
                let handle = CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    ptr::null(),
                    PAGE_READWRITE,
                    (size >> 32) as u32,
                    size as u32,
                    ptr::null(),
                );
                if handle.is_null() {
                    return Err(format!("CreateFileMapping failed ({})", GetLastError()));
                }
                let section = Section { handle, len };
                let view = MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, len);
                if view.Value.is_null() {
                    return Err(format!("MapViewOfFile failed ({})", GetLastError()));
                }
                ptr::copy_nonoverlapping(bytes.as_ptr(), view.Value as *mut u8, len);
                UnmapViewOfFile(view);
                Ok(section)
            }
        }

        pub fn len(&self) -> usize {
            self.len
        }

        /// Duplicates a map-read-only handle into `process` and returns its value
        /// there. The worker closes it after mapping; if the worker dies first, the
        /// handle goes with it.
        pub fn share_with(&self, process: HANDLE) -> Result<u64, String> {
            let mut out: HANDLE = ptr::null_mut();
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    self.handle,
                    process,
                    &mut out,
                    FILE_MAP_READ,
                    0,
                    0,
                )
            };
            if ok == 0 {
                return Err(format!("Could not share the document with the PDF engine ({})", unsafe {
                    GetLastError()
                }));
            }
            Ok(out as usize as u64)
        }
    }

    impl Drop for Section {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    /// Worker side: a read-only view of a section.
    pub struct View {
        addr: MEMORY_MAPPED_VIEW_ADDRESS,
        len: usize,
    }

    impl View {
        /// Maps `len` bytes of the section behind `handle` read-only and closes the
        /// handle (the view keeps the section alive).
        ///
        /// # Safety
        /// `handle` must be a section handle owned by this process, as sent by the
        /// host in `OpenShared`. It is closed whether or not mapping succeeds.
        pub unsafe fn open(handle: u64, len: u64) -> Result<Self, String> {
            let handle = handle as usize as HANDLE;
            if len == 0 || len > MAX_DOC_BYTES {
                unsafe { CloseHandle(handle) };
                return Err("Invalid document size".into());
            }
            let len = len as usize;
            let addr = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, len) };
            unsafe { CloseHandle(handle) };
            if addr.Value.is_null() {
                return Err("Could not map the document".into());
            }
            Ok(View { addr, len })
        }

        pub fn as_slice(&self) -> &[u8] {
            // SAFETY: the view is mapped for `len` bytes, read-only, until drop.
            unsafe { std::slice::from_raw_parts(self.addr.Value as *const u8, self.len) }
        }
    }

    impl Drop for View {
        fn drop(&mut self) {
            unsafe { UnmapViewOfFile(self.addr) };
        }
    }
}

#[cfg(test)]
mod tests;
