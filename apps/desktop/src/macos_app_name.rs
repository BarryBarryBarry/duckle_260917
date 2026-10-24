//! Dock, app-switcher and app-menu name for unbundled macOS runs.
//!
//! A bundled `.app` gets its Dock name from `CFBundleName` (the Tauri
//! `productName`). The dev binary (`target/debug/duckle`, launched by
//! `cargo tauri dev`) has no bundle, so LaunchServices names it after the
//! executable file, and Cargo binary names cannot contain spaces. Set the
//! LaunchServices display name of the running process instead - the same
//! private-but-stable call Chromium uses for its helper processes. Symbols are
//! looked up at runtime so a missing one just leaves the default name.

use std::ffi::{c_char, c_int, c_void, CStr};

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type OSStatus = i32;

const RTLD_LAZY: c_int = 0x1;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_LS_DEFAULT_SESSION_ID: c_int = -2;
const LAUNCH_SERVICES: &CStr = c"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/LaunchServices";

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFStringRef;
    fn CFRelease(cf: CFTypeRef);
}

type GetCurrentAsnFn = unsafe extern "C" fn() -> CFTypeRef;
type SetInfoItemFn = unsafe extern "C" fn(
    session: c_int,
    asn: CFTypeRef,
    key: CFStringRef,
    value: CFTypeRef,
    out_new_info: *mut CFTypeRef,
) -> OSStatus;

fn running_from_app_bundle() -> bool {
    std::env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Tauri's default macOS menu, with the app submenu's "About / Hide / Quit"
/// items naming the product instead of the executable. Those labels come from
/// the process name when the menu is built, which for unbundled runs is the
/// executable file (`duckle`).
pub fn default_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let menu = tauri::menu::Menu::default(app)?;
    let name = app.package_info().name.clone();
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if exe_name.is_empty() || exe_name == name {
        return Ok(menu);
    }
    let Some(app_menu) = menu.items()?.into_iter().next() else {
        return Ok(menu);
    };
    let Some(app_menu) = app_menu.as_submenu() else {
        return Ok(menu);
    };
    for item in app_menu.items()? {
        if let Some(item) = item.as_predefined_menuitem() {
            let text = item.text()?;
            if text.contains(&exe_name) {
                item.set_text(text.replace(&exe_name, &name))?;
            }
        }
    }
    Ok(menu)
}

/// Must run after NSApplication has checked in with LaunchServices, i.e. from
/// the Tauri `setup` hook.
pub fn apply(name: &str) {
    if name.is_empty() || running_from_app_bundle() {
        return;
    }
    unsafe {
        let ls = dlopen(LAUNCH_SERVICES.as_ptr(), RTLD_LAZY);
        if ls.is_null() {
            return;
        }
        let get_asn = dlsym(ls, c"_LSGetCurrentApplicationASN".as_ptr());
        let set_item = dlsym(ls, c"_LSSetApplicationInformationItem".as_ptr());
        let key = dlsym(ls, c"_kLSDisplayNameKey".as_ptr()) as *const CFStringRef;
        if get_asn.is_null() || set_item.is_null() || key.is_null() || (*key).is_null() {
            return;
        }
        let get_asn: GetCurrentAsnFn = std::mem::transmute(get_asn);
        let set_item: SetInfoItemFn = std::mem::transmute(set_item);

        let asn = get_asn();
        if asn.is_null() {
            return;
        }
        let value = CFStringCreateWithBytes(
            std::ptr::null(),
            name.as_ptr(),
            name.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
            0,
        );
        if value.is_null() {
            return;
        }
        let status = set_item(
            K_LS_DEFAULT_SESSION_ID,
            asn,
            *key,
            value,
            std::ptr::null_mut(),
        );
        CFRelease(value);
        if status != 0 {
            tracing::debug!("could not set the Dock name (LaunchServices status {status})");
        }
    }
}
