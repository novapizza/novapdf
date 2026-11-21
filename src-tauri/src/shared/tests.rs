use super::*;

#[test]
fn doc_bytes_keep_their_length() {
    let d = DocBytes::new(b"%PDF-1.7 hello".to_vec());
    assert_eq!(d.len(), 14);
    assert!(!d.is_empty());
    #[cfg(windows)]
    assert!(matches!(d, DocBytes::Shared(_)), "Windows keeps documents in shared memory");
}

#[test]
fn empty_documents_stay_owned() {
    let d = DocBytes::new(Vec::new());
    assert!(d.is_empty());
    assert!(matches!(d, DocBytes::Owned(_)));
}

#[test]
fn owned_backing_exposes_its_bytes() {
    assert_eq!(Backing::Owned(vec![1, 2, 3]).bytes(), &[1, 2, 3]);
}

#[cfg(windows)]
#[test]
fn a_shared_section_maps_back_to_the_same_bytes() {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let bytes: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
    let section = win::Section::new(&bytes).unwrap();
    assert_eq!(section.len(), bytes.len());

    // Share with ourselves, as the host does with a worker.
    let handle = section.share_with(unsafe { GetCurrentProcess() }).unwrap();
    let view = unsafe { win::View::open(handle, bytes.len() as u64) }.unwrap();
    assert_eq!(view.as_slice(), &bytes[..]);

    // The view keeps the section alive after the host drops its handle.
    drop(section);
    let backing = Backing::Mapped(view);
    assert_eq!(backing.bytes()[..5], bytes[..5]);
}

#[cfg(windows)]
#[test]
fn shared_views_are_read_only() {
    use windows_sys::Win32::System::Memory::{
        MEMORY_BASIC_INFORMATION, PAGE_READONLY, VirtualQuery,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let section = win::Section::new(b"%PDF-1.7").unwrap();
    let handle = section.share_with(unsafe { GetCurrentProcess() }).unwrap();
    let view = unsafe { win::View::open(handle, 8) }.unwrap();
    let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
    let n = unsafe {
        VirtualQuery(
            view.as_slice().as_ptr() as *const _,
            &mut info,
            std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
        )
    };
    assert_ne!(n, 0);
    assert_eq!(info.Protect, PAGE_READONLY);
}

#[cfg(windows)]
#[test]
fn bad_sizes_are_rejected() {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    assert!(win::Section::new(&[]).is_err());

    let section = win::Section::new(b"%PDF-1.7").unwrap();
    for len in [0, crate::protocol::MAX_DOC_BYTES + 1] {
        let handle = section.share_with(unsafe { GetCurrentProcess() }).unwrap();
        assert_eq!(unsafe { win::View::open(handle, len) }.err().unwrap(), "Invalid document size");
    }
    // Asking for more than the section holds fails to map.
    let handle = section.share_with(unsafe { GetCurrentProcess() }).unwrap();
    assert_eq!(
        unsafe { win::View::open(handle, 1 << 20) }.err().unwrap(),
        "Could not map the document"
    );
}
