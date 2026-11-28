//! Password protection for saved files.
//!
//! PDFium builds the saved file but cannot encrypt it, so a file saved from a
//! password-protected document is encrypted here afterwards, with lopdf: AES-256 (PDF
//! 2.0, security handler revision 6), the strongest standard PDF encryption. The file
//! opens with the same password the source opened with. Permissions are all granted:
//! the source's restrictions (no printing, no copying) are not carried over.
//!
//! Runs in the worker, on bytes PDFium has just written, never on input files.

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Document, EncryptionState, EncryptionVersion, Permissions};

/// Encrypts `pdf` so it opens only with `password`. `key` is the 32-byte file
/// encryption key, which must be random.
pub fn encrypt(pdf: &[u8], password: &str, key: &[u8]) -> Result<Vec<u8>, String> {
    let fail = |e: lopdf::Error| format!("The file could not be password-protected: {e}");
    if key.len() != 32 {
        return Err("The encryption key is invalid.".into());
    }
    let mut doc = Document::load_mem(pdf).map_err(fail)?;
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let state = EncryptionState::try_from(EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        // The owner password is the same: the user who opened it with that password
        // gets every permission anyway.
        owner_password: password,
        user_password: password,
        permissions: Permissions::all(),
    })
    .map_err(|e| format!("The file could not be password-protected: {e}"))?;
    doc.encrypt(&state).map_err(fail)?;
    let mut out = Vec::with_capacity(pdf.len() + 4096);
    doc.save_to(&mut out).map_err(|e| format!("The file could not be password-protected: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests;
