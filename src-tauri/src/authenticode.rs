//! Authenticode verification of a binary we are about to run or become.
//!
//! The self-update downloads an executable over HTTPS from GitHub and then
//! *renames it onto our own install slot* — the most privileged thing this app
//! does. TLS proves we talked to GitHub; it says nothing about what GitHub was
//! serving. A release asset replaced by a compromised account, or by anything
//! upstream of the CDN, would sail straight through `apply_update`'s size and
//! `MZ` checks.
//!
//! Since the releases are Authenticode-signed, we can do better: ask Windows to
//! validate the signature and the whole certificate chain, then check that the
//! signer is *us*. The chain check alone is not enough — any code-signing
//! certificate Windows trusts would pass it, and those are purchasable.
//!
//! Revocation is deliberately **not** checked (`WTD_REVOKE_NONE`): it adds an
//! OCSP round-trip that fails closed on a flaky network, and would turn every
//! captive-portal moment into a refused update. Chain validation to a trusted
//! root plus the signer identity is the property we actually need here.

use crate::error::Result;
use std::path::Path;

/// Subject the release binaries carry — the CN of the Certum Open Source Code
/// Signing certificate.
///
/// Hardcoded on purpose: it is the trust anchor of the update path, so it must
/// not be settable from anywhere an attacker could reach. It has to be updated
/// by hand if the certificate is ever reissued under a different name (a switch
/// to an organisation certificate, say). If that is forgotten, updates fail
/// closed — `update_poller` reports the release as "available" and the user
/// installs it by hand — which is the right way round.
pub const EXPECTED_SIGNER: &str = "Open Source Developer Valentin Pitel";

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::error::Error;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct Guid {
        d1: u32,
        d2: u16,
        d3: u16,
        d4: [u8; 8],
    }

    /// WINTRUST_ACTION_GENERIC_VERIFY_V2 — the standard Authenticode policy.
    const ACTION_GENERIC_VERIFY_V2: Guid = Guid {
        d1: 0x00AA_C56B,
        d2: 0xCD44,
        d3: 0x11D0,
        d4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE],
    };

    #[repr(C)]
    struct WinTrustFileInfo {
        cb_struct: u32,
        file_path: *const u16,
        h_file: *mut c_void,
        known_subject: *const Guid,
    }

    #[repr(C)]
    struct WinTrustData {
        cb_struct: u32,
        policy_callback_data: *mut c_void,
        sip_client_data: *mut c_void,
        ui_choice: u32,
        revocation_checks: u32,
        union_choice: u32,
        file_info: *mut WinTrustFileInfo,
        state_action: u32,
        state_data: *mut c_void,
        url_reference: *mut u16,
        prov_flags: u32,
        ui_context: u32,
        signature_settings: *mut c_void,
    }

    /// CRYPT_PROVIDER_CERT, truncated after the field we read. Everything past
    /// `cert` is left out on purpose — we only ever dereference these two.
    #[repr(C)]
    struct CryptProviderCert {
        cb_struct: u32,
        cert: *const c_void,
    }

    const WTD_UI_NONE: u32 = 2;
    const WTD_REVOKE_NONE: u32 = 0;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;
    const WTD_SAFER_FLAG: u32 = 0x100;
    const CERT_NAME_SIMPLE_DISPLAY_TYPE: u32 = 4;

    #[link(name = "wintrust")]
    extern "system" {
        fn WinVerifyTrust(hwnd: *mut c_void, action: *const Guid, data: *mut c_void) -> i32;
        fn WTHelperProvDataFromStateData(state: *mut c_void) -> *mut c_void;
        fn WTHelperGetProvSignerFromChain(
            prov: *mut c_void,
            signer_idx: u32,
            counter_signer: i32,
            counter_signer_idx: u32,
        ) -> *mut c_void;
        fn WTHelperGetProvCertFromChain(
            signer: *mut c_void,
            cert_idx: u32,
        ) -> *mut CryptProviderCert;
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CertGetNameStringW(
            cert: *const c_void,
            name_type: u32,
            flags: u32,
            type_para: *mut c_void,
            name: *mut u16,
            cch: u32,
        ) -> u32;
    }

    /// Human-readable form of the few WinVerifyTrust results worth naming.
    fn explain(status: i32) -> String {
        let code = status as u32;
        let detail = match code {
            0x800B_0100 => "the file carries no Authenticode signature",
            0x800B_0101 => "the signing certificate has expired",
            0x800B_0109 => "the signature chains to a root Windows does not trust",
            0x800B_010A => "the certificate chain could not be built",
            0x8009_6010 => "the file was modified after signing (bad digest)",
            0x800B_0111 => "the certificate is explicitly distrusted",
            _ => "signature verification failed",
        };
        format!("{detail} (0x{code:08X})")
    }

    /// Read the signer's display name from the verification state, which must
    /// still be open — hence the call before `WTD_STATEACTION_CLOSE`.
    unsafe fn signer_name(state: *mut c_void) -> Option<String> {
        let prov = WTHelperProvDataFromStateData(state);
        if prov.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
        if signer.is_null() {
            return None;
        }
        let chain_cert = WTHelperGetProvCertFromChain(signer, 0);
        if chain_cert.is_null() {
            return None;
        }
        let ctx = (*chain_cert).cert;
        if ctx.is_null() {
            return None;
        }
        // First call sizes the buffer (count includes the NUL terminator).
        let len = CertGetNameStringW(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, null_mut(), null_mut(), 0);
        if len <= 1 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let got = CertGetNameStringW(
            ctx,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null_mut(),
            buf.as_mut_ptr(),
            len,
        );
        if got == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(got as usize).saturating_sub(1)]))
    }

    pub fn verify_signed_by(path: &Path, expected_cn: &str) -> Result<String> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut file = WinTrustFileInfo {
            cb_struct: std::mem::size_of::<WinTrustFileInfo>() as u32,
            file_path: wide.as_ptr(),
            h_file: null_mut(),
            known_subject: null(),
        };
        let mut wtd = WinTrustData {
            cb_struct: std::mem::size_of::<WinTrustData>() as u32,
            policy_callback_data: null_mut(),
            sip_client_data: null_mut(),
            ui_choice: WTD_UI_NONE,
            revocation_checks: WTD_REVOKE_NONE,
            union_choice: WTD_CHOICE_FILE,
            file_info: &mut file,
            state_action: WTD_STATEACTION_VERIFY,
            state_data: null_mut(),
            url_reference: null_mut(),
            prov_flags: WTD_SAFER_FLAG,
            ui_context: 0,
            signature_settings: null_mut(),
        };

        let (status, signer) = unsafe {
            let status = WinVerifyTrust(
                null_mut(),
                &ACTION_GENERIC_VERIFY_V2,
                &mut wtd as *mut _ as *mut c_void,
            );
            // Read the signer while the state is alive, then always close it —
            // skipping the close leaks the provider data for the process.
            let signer = if status == 0 {
                signer_name(wtd.state_data)
            } else {
                None
            };
            wtd.state_action = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(
                null_mut(),
                &ACTION_GENERIC_VERIFY_V2,
                &mut wtd as *mut _ as *mut c_void,
            );
            (status, signer)
        };

        if status != 0 {
            return Err(Error::Invalid(format!(
                "refusing {}: {}",
                path.display(),
                explain(status)
            )));
        }
        let Some(signer) = signer else {
            return Err(Error::Invalid(format!(
                "refusing {}: its signature is valid but the signer could not be read",
                path.display()
            )));
        };
        if !signer.trim().eq_ignore_ascii_case(expected_cn.trim()) {
            return Err(Error::Invalid(format!(
                "refusing {}: signed by \"{}\", expected \"{}\"",
                path.display(),
                signer,
                expected_cn
            )));
        }
        Ok(signer)
    }
}

/// Verify that `path` carries a valid Authenticode signature issued to
/// `expected_cn`. Returns the signer name on success.
///
/// Non-Windows builds accept everything: there is no Authenticode there, and
/// the self-update is Windows-only anyway.
#[cfg(windows)]
pub fn verify_signed_by(path: &Path, expected_cn: &str) -> Result<String> {
    imp::verify_signed_by(path, expected_cn)
}

#[cfg(not(windows))]
pub fn verify_signed_by(_path: &Path, _expected_cn: &str) -> Result<String> {
    Ok(String::new())
}
