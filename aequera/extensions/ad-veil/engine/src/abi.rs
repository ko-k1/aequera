//! C ABI for engine.wasm (driven by addon/engine.js).
//!
//! The host copies inputs into memory from `veil_alloc`, calls a function with
//! (pointer, length) pairs, and reads byte results from `veil_out()` with the
//! returned length. One engine per instance; a failed `veil_load` keeps the
//! previous one.

use crate::{Decision, Seen, Veil};
use std::cell::RefCell;

thread_local! {
    static VEIL: RefCell<Option<Veil>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// No engine is loaded yet.
const NO_ENGINE: i32 = -2;

/// # Safety
/// `ptr..ptr + len` must be memory from `alloc` that the host filled.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

unsafe fn text<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    std::str::from_utf8(unsafe { bytes(ptr, len) }).ok()
}

fn put(out: &[u8]) -> usize {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(out);
        o.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn veil_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

#[unsafe(no_mangle)]
pub extern "C" fn veil_out() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

/// Compiles filter list text. 0 on success, -1 on invalid UTF-8.
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_compile(ptr: *const u8, len: usize) -> i32 {
    let Some(lists) = (unsafe { text(ptr, len) }) else {
        return -1;
    };
    let veil = Veil::compile(lists);
    VEIL.with(|v| *v.borrow_mut() = Some(veil));
    0
}

/// Loads a serialized engine. 0 on success, -1 if the bytes do not load
/// (the current engine stays).
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_load(ptr: *const u8, len: usize) -> i32 {
    match Veil::deserialize(unsafe { bytes(ptr, len) }) {
        Some(veil) => {
            VEIL.with(|v| *v.borrow_mut() = Some(veil));
            0
        }
        None => -1,
    }
}

/// Serializes the current engine into `veil_out()`; 0 bytes without one.
#[unsafe(no_mangle)]
pub extern "C" fn veil_serialize() -> usize {
    let data = VEIL
        .with(|v| v.borrow().as_ref().map(Veil::serialize))
        .unwrap_or_default();
    put(&data)
}

/// Whether the popup rules block a new window opening `url` from a page at
/// `opener`: a [`Decision`] as i32, or -2 without an engine.
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_check_popup(
    url: *const u8,
    url_len: usize,
    opener: *const u8,
    opener_len: usize,
) -> i32 {
    let (Some(url), Some(opener)) = (unsafe { (text(url, url_len), text(opener, opener_len)) }) else {
        return Decision::Unparsable as i32;
    };
    VEIL.with(|v| match v.borrow().as_ref() {
        Some(veil) => veil.check_popup(url, opener) as i32,
        None => NO_ENGINE,
    })
}

/// A [`Decision`] as i32, or -2 without an engine.
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_check(
    url: *const u8,
    url_len: usize,
    source: *const u8,
    source_len: usize,
    kind: *const u8,
    kind_len: usize,
) -> i32 {
    let (Some(url), Some(source), Some(kind)) = (unsafe {
        (
            text(url, url_len),
            text(source, source_len),
            text(kind, kind_len),
        )
    }) else {
        return Decision::Unparsable as i32;
    };
    VEIL.with(|v| match v.borrow().as_ref() {
        Some(veil) => veil.check(url, source, kind) as i32,
        None => NO_ENGINE,
    })
}

/// [`crate::Cosmetic`] as JSON in `veil_out()`; 0 bytes without an engine or on
/// invalid UTF-8.
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_cosmetic(url: *const u8, url_len: usize) -> usize {
    let Some(url) = (unsafe { text(url, url_len) }) else {
        return put(b"");
    };
    let json = VEIL.with(|v| {
        v.borrow()
            .as_ref()
            .map(|veil| serde_json::to_vec(&veil.cosmetic(url)).unwrap_or_default())
    });
    put(&json.unwrap_or_default())
}

/// Input: [`Seen`] as JSON. Output: a JSON array of selectors in `veil_out()`;
/// 0 bytes without an engine or on invalid input.
///
/// # Safety
/// See `bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn veil_generic(ptr: *const u8, len: usize) -> usize {
    let Ok(seen) = serde_json::from_slice::<Seen>(unsafe { bytes(ptr, len) }) else {
        return put(b"");
    };
    let json = VEIL.with(|v| {
        v.borrow()
            .as_ref()
            .map(|veil| serde_json::to_vec(&veil.generic(&seen)).unwrap_or_default())
    });
    put(&json.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(s: &[u8]) -> (*const u8, usize) {
        let p = veil_alloc(s.len());
        unsafe { std::ptr::copy_nonoverlapping(s.as_ptr(), p, s.len()) };
        (p, s.len())
    }

    fn output(len: usize) -> Vec<u8> {
        unsafe { std::slice::from_raw_parts(veil_out(), len) }.to_vec()
    }

    #[test]
    fn abi_round_trip() {
        let (u, ul) = input(b"https://ads.example/x.js");
        let (s, sl) = input(b"https://news.test/");
        let (k, kl) = input(b"script");
        assert_eq!(unsafe { veil_check(u, ul, s, sl, k, kl) }, NO_ENGINE);

        let (l, ll) = input(b"||ads.example^\nnews.test##.promo\n");
        assert_eq!(unsafe { veil_compile(l, ll) }, 0);
        assert_eq!(unsafe { veil_check(u, ul, s, sl, k, kl) }, 1);

        let json = output(unsafe { veil_cosmetic(s, sl) });
        assert!(String::from_utf8(json).unwrap().contains(".promo"));

        let saved = output(veil_serialize());
        let (bad, bl) = input(b"garbage");
        assert_eq!(unsafe { veil_load(bad, bl) }, -1);
        assert_eq!(
            unsafe { veil_check(u, ul, s, sl, k, kl) },
            1,
            "failed load keeps the engine"
        );
        let (good, gl) = input(&saved);
        assert_eq!(unsafe { veil_load(good, gl) }, 0);
        assert_eq!(unsafe { veil_check(u, ul, s, sl, k, kl) }, 1);

        let (bad_utf8, bul) = input(&[0xff, 0xfe]);
        assert_eq!(
            unsafe { veil_check(bad_utf8, bul, s, sl, k, kl) },
            Decision::Unparsable as i32
        );
        assert_eq!(unsafe { veil_generic(bad_utf8, bul) }, 0);
    }
}
