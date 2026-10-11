//! Local sign-in for the desktop app.
//!
//! The desktop app is normally used by the machine's owner alone, so accounts
//! are local: an administrator is created on first launch and is the only one
//! who can add others. Passwords are stored as Argon2id hashes in
//! `<app data>/local-auth.json`, outside every workspace.
//!
//! This is a gate on the app, not encryption: the workspaces, pipelines and
//! DuckDB files stay readable on disk to anyone with access to this user
//! account on the machine. Deleting `local-auth.json` resets sign-in (a new
//! administrator is created on the next launch) and touches no workspace data;
//! that is also the documented way back in when the password and the recovery
//! code are both lost.
//!
//! Errors are stable codes (`invalid_credentials`, `throttled:30`, ...) that the
//! frontend turns into translated messages.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const AUTH_FILE: &str = "local-auth.json";
/// The "remember me" lengths the sign-in screen offers.
pub const REMEMBER_DAYS: [u32; 3] = [1, 7, 30];
const MIN_PASSWORD_LEN: usize = 8;
const MAX_USERNAME_LEN: usize = 64;
/// Wrong passwords allowed before sign-in pauses.
const FREE_FAILURES: u32 = 5;
const FIRST_PAUSE_SECS: i64 = 30;
const MAX_PAUSE_SECS: i64 = 300;
/// Crockford base32 without I, L, O and U, so a written-down code cannot be misread.
const RECOVERY_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFile {
    #[serde(default)]
    users: Vec<StoredUser>,
    /// Argon2id hash of the normalized recovery code.
    #[serde(default)]
    recovery_hash: Option<String>,
    /// Who is signed in across restarts, and until when.
    #[serde(default)]
    remember: Option<Remember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredUser {
    username: String,
    password_hash: String,
    is_admin: bool,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Remember {
    username: String,
    expires_at: i64,
}

/// The signed-in user for this run of the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    username: String,
    is_admin: bool,
    /// Unix seconds when "remember me" lapses; `None` when not remembered.
    remember_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub username: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub needs_setup: bool,
    pub user: Option<UserInfo>,
    /// Milliseconds since the epoch, for the frontend's timers.
    pub remember_until: Option<i64>,
    /// Shown on the "forgot password" screen as the manual reset.
    pub store_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    pub username: String,
    pub is_admin: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCode {
    pub recovery_code: String,
}

/// Consecutive failed password checks, kept in memory: a restart clears it,
/// which is fine for a gate whose file can be deleted anyway.
#[derive(Debug, Default)]
pub struct Throttle {
    failures: u32,
    paused_until: i64,
}

impl Throttle {
    fn check(&self, now: i64) -> Result<(), String> {
        if now < self.paused_until {
            return Err(format!("throttled:{}", self.paused_until - now));
        }
        Ok(())
    }

    fn fail(&mut self, now: i64) {
        self.failures += 1;
        if self.failures >= FREE_FAILURES {
            let doublings = (self.failures - FREE_FAILURES).min(4);
            let pause = (FIRST_PAUSE_SECS << doublings).min(MAX_PAUSE_SECS);
            self.paused_until = now + pause;
        }
    }

    fn succeed(&mut self) {
        *self = Throttle::default();
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static THROTTLE: Mutex<Throttle> = Mutex::new(Throttle { failures: 0, paused_until: 0 });

// ---- storage --------------------------------------------------------------

pub fn auth_path(app_data: &Path) -> PathBuf {
    app_data.join(AUTH_FILE)
}

fn load(path: &Path) -> Result<AuthFile, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("store_unreadable:{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AuthFile::default()),
        Err(e) => Err(format!("store_unreadable:{e}")),
    }
}

/// Write through a temporary file and a rename, so a crash mid-write cannot
/// leave a truncated file that locks the owner out.
fn save(path: &Path, file: &AuthFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("store_unwritable:{e}"))?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| format!("store_unwritable:{e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("store_unwritable:{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("store_unwritable:{e}"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- secrets --------------------------------------------------------------

fn hash_secret(secret: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(secret.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("hash_failed:{e}"))
}

fn verify_secret(secret: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(secret.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// Four groups of five characters, 100 bits.
fn mint_recovery_code() -> Result<String, String> {
    let mut raw = [0u8; 20];
    getrandom::fill(&mut raw).map_err(|e| format!("rng_failed:{e}"))?;
    let chars: Vec<char> = raw.iter().map(|b| RECOVERY_ALPHABET[(*b & 31) as usize] as char).collect();
    Ok(chars.chunks(5).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-"))
}

/// Case, spaces and dashes do not matter when typing a code back in.
fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

// ---- validation -----------------------------------------------------------

fn clean_username(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > MAX_USERNAME_LEN || name.chars().any(char::is_control) {
        return Err("username_invalid".into());
    }
    Ok(name.to_string())
}

fn check_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err("password_too_short".into());
    }
    Ok(())
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn find<'a>(file: &'a AuthFile, username: &str) -> Option<&'a StoredUser> {
    file.users.iter().find(|u| same_name(&u.username, username))
}

fn info(user: &StoredUser) -> UserInfo {
    UserInfo { username: user.username.clone(), is_admin: user.is_admin }
}

fn require_admin(session: &Option<Session>) -> Result<&Session, String> {
    match session {
        Some(s) if s.is_admin => Ok(s),
        Some(_) => Err("not_admin".into()),
        None => Err("not_signed_in".into()),
    }
}

// ---- operations (pure over a path and a clock, so they can be tested) -----

pub fn status(path: &Path, now: i64, session: &mut Option<Session>) -> Result<AuthStatus, String> {
    let file = load(path)?;
    // Picks up a remembered sign-in on launch, if the user still exists.
    if session.is_none() {
        if let Some(r) = file.remember.as_ref().filter(|r| r.expires_at > now) {
            if let Some(user) = find(&file, &r.username) {
                *session = Some(Session {
                    username: user.username.clone(),
                    is_admin: user.is_admin,
                    remember_until: Some(r.expires_at),
                });
            }
        }
    }
    // A user removed by an administrator is signed out on their next check.
    if let Some(s) = session.as_ref() {
        match find(&file, &s.username) {
            Some(u) => {
                let is_admin = u.is_admin;
                if let Some(s) = session.as_mut() {
                    s.is_admin = is_admin;
                }
            }
            None => *session = None,
        }
    }
    Ok(AuthStatus {
        needs_setup: file.users.is_empty(),
        user: session.as_ref().map(|s| UserInfo { username: s.username.clone(), is_admin: s.is_admin }),
        remember_until: session.as_ref().and_then(|s| s.remember_until).map(|t| t * 1000),
        store_path: path.display().to_string(),
    })
}

/// Create the first administrator. Refused once any account exists.
pub fn setup(
    path: &Path,
    now: i64,
    session: &mut Option<Session>,
    username: &str,
    password: &str,
) -> Result<RecoveryCode, String> {
    let mut file = load(path)?;
    if !file.users.is_empty() {
        return Err("already_set_up".into());
    }
    let username = clean_username(username)?;
    check_password(password)?;
    let code = mint_recovery_code()?;
    file.users.push(StoredUser {
        username: username.clone(),
        password_hash: hash_secret(password)?,
        is_admin: true,
        created_at: now,
    });
    file.recovery_hash = Some(hash_secret(&normalize_code(&code))?);
    file.remember = None;
    save(path, &file)?;
    *session = Some(Session { username, is_admin: true, remember_until: None });
    Ok(RecoveryCode { recovery_code: code })
}

pub fn sign_in(
    path: &Path,
    now: i64,
    session: &mut Option<Session>,
    throttle: &mut Throttle,
    username: &str,
    password: &str,
    remember_days: u32,
) -> Result<(), String> {
    throttle.check(now)?;
    let mut file = load(path)?;
    let Some(user) = find(&file, username.trim()).cloned() else {
        // Spend the same time as a real check, so a wrong name is not faster.
        let _ = verify_secret(password, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        throttle.fail(now);
        return Err("invalid_credentials".into());
    };
    if !verify_secret(password, &user.password_hash) {
        throttle.fail(now);
        return Err("invalid_credentials".into());
    }
    throttle.succeed();
    let remember_until = REMEMBER_DAYS
        .contains(&remember_days)
        .then(|| now + i64::from(remember_days) * 86_400);
    file.remember = remember_until.map(|expires_at| Remember { username: user.username.clone(), expires_at });
    save(path, &file)?;
    *session = Some(Session { username: user.username, is_admin: user.is_admin, remember_until });
    Ok(())
}

/// The lock screen: the signed-in user proves it is still them. "Remember me"
/// is left as it was.
pub fn unlock(
    path: &Path,
    now: i64,
    session: &Option<Session>,
    throttle: &mut Throttle,
    password: &str,
) -> Result<(), String> {
    throttle.check(now)?;
    let s = session.as_ref().ok_or("not_signed_in")?;
    let file = load(path)?;
    let user = find(&file, &s.username).ok_or("not_signed_in")?;
    if !verify_secret(password, &user.password_hash) {
        throttle.fail(now);
        return Err("invalid_credentials".into());
    }
    throttle.succeed();
    Ok(())
}

pub fn sign_out(path: &Path, session: &mut Option<Session>) -> Result<(), String> {
    *session = None;
    let mut file = load(path)?;
    if file.remember.take().is_some() {
        save(path, &file)?;
    }
    Ok(())
}

pub fn change_password(path: &Path, session: &Option<Session>, current: &str, next: &str) -> Result<(), String> {
    let s = session.as_ref().ok_or("not_signed_in")?;
    check_password(next)?;
    let mut file = load(path)?;
    let user = file
        .users
        .iter_mut()
        .find(|u| same_name(&u.username, &s.username))
        .ok_or("not_signed_in")?;
    if !verify_secret(current, &user.password_hash) {
        return Err("wrong_current_password".into());
    }
    user.password_hash = hash_secret(next)?;
    save(path, &file)
}

pub fn list_users(path: &Path, session: &Option<Session>) -> Result<Vec<UserRow>, String> {
    require_admin(session)?;
    let file = load(path)?;
    Ok(file
        .users
        .iter()
        .map(|u| UserRow { username: u.username.clone(), is_admin: u.is_admin, created_at: u.created_at * 1000 })
        .collect())
}

pub fn create_user(
    path: &Path,
    now: i64,
    session: &Option<Session>,
    username: &str,
    password: &str,
    is_admin: bool,
) -> Result<UserInfo, String> {
    require_admin(session)?;
    let username = clean_username(username)?;
    check_password(password)?;
    let mut file = load(path)?;
    if find(&file, &username).is_some() {
        return Err("username_taken".into());
    }
    let user = StoredUser { username, password_hash: hash_secret(password)?, is_admin, created_at: now };
    let out = info(&user);
    file.users.push(user);
    save(path, &file)?;
    Ok(out)
}

pub fn delete_user(path: &Path, session: &Option<Session>, username: &str) -> Result<(), String> {
    let me = require_admin(session)?;
    if same_name(&me.username, username) {
        return Err("cannot_delete_self".into());
    }
    let mut file = load(path)?;
    let target = find(&file, username).ok_or("user_not_found")?.clone();
    if target.is_admin && file.users.iter().filter(|u| u.is_admin).count() <= 1 {
        return Err("last_admin".into());
    }
    file.users.retain(|u| !same_name(&u.username, &target.username));
    if file.remember.as_ref().is_some_and(|r| same_name(&r.username, &target.username)) {
        file.remember = None;
    }
    save(path, &file)
}

pub fn reset_password(path: &Path, session: &Option<Session>, username: &str, password: &str) -> Result<(), String> {
    require_admin(session)?;
    check_password(password)?;
    let mut file = load(path)?;
    let user = file
        .users
        .iter_mut()
        .find(|u| same_name(&u.username, username))
        .ok_or("user_not_found")?;
    user.password_hash = hash_secret(password)?;
    save(path, &file)
}

/// Set a new password with the recovery code. The code is used up: a new one
/// is returned and has to be saved in its place.
pub fn recover(
    path: &Path,
    now: i64,
    throttle: &mut Throttle,
    username: &str,
    code: &str,
    password: &str,
) -> Result<RecoveryCode, String> {
    throttle.check(now)?;
    check_password(password)?;
    let mut file = load(path)?;
    let code_ok = file
        .recovery_hash
        .as_deref()
        .is_some_and(|h| verify_secret(&normalize_code(code), h));
    let Some(user) = file.users.iter_mut().find(|u| same_name(&u.username, username.trim())) else {
        throttle.fail(now);
        return Err("recovery_invalid".into());
    };
    if !code_ok {
        throttle.fail(now);
        return Err("recovery_invalid".into());
    }
    throttle.succeed();
    user.password_hash = hash_secret(password)?;
    let next = mint_recovery_code()?;
    file.recovery_hash = Some(hash_secret(&normalize_code(&next))?);
    file.remember = None;
    save(path, &file)?;
    Ok(RecoveryCode { recovery_code: next })
}

/// Replace the recovery code, for an administrator who lost it while still
/// able to sign in. Asks for the password again.
pub fn regenerate_recovery(path: &Path, session: &Option<Session>, password: &str) -> Result<RecoveryCode, String> {
    let me = require_admin(session)?;
    let mut file = load(path)?;
    let user = find(&file, &me.username).ok_or("not_signed_in")?;
    if !verify_secret(password, &user.password_hash) {
        return Err("wrong_current_password".into());
    }
    let code = mint_recovery_code()?;
    file.recovery_hash = Some(hash_secret(&normalize_code(&code))?);
    save(path, &file)?;
    Ok(RecoveryCode { recovery_code: code })
}

// ---- Tauri commands -------------------------------------------------------

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("store_unreadable:{e}"))?;
    Ok(auth_path(&dir))
}

fn session_lock() -> Result<std::sync::MutexGuard<'static, Option<Session>>, String> {
    SESSION.lock().map_err(|_| "store_unreadable:session".to_string())
}

fn throttle_lock() -> Result<std::sync::MutexGuard<'static, Throttle>, String> {
    THROTTLE.lock().map_err(|_| "store_unreadable:throttle".to_string())
}

#[tauri::command]
pub async fn auth_status(app: tauri::AppHandle) -> Result<AuthStatus, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || status(&path, now_secs(), &mut *session_lock()?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_setup(app: tauri::AppHandle, username: String, password: String) -> Result<RecoveryCode, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        setup(&path, now_secs(), &mut *session_lock()?, &username, &password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_sign_in(
    app: tauri::AppHandle,
    username: String,
    password: String,
    remember_days: u32,
) -> Result<AuthStatus, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_secs();
        let mut session = session_lock()?;
        sign_in(&path, now, &mut session, &mut *throttle_lock()?, &username, &password, remember_days)?;
        status(&path, now, &mut session)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_unlock(app: tauri::AppHandle, password: String) -> Result<(), String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        unlock(&path, now_secs(), &*session_lock()?, &mut *throttle_lock()?, &password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn auth_sign_out(app: tauri::AppHandle) -> Result<(), String> {
    sign_out(&store_path(&app)?, &mut *session_lock()?)
}

#[tauri::command]
pub async fn auth_change_password(app: tauri::AppHandle, current: String, next: String) -> Result<(), String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || change_password(&path, &*session_lock()?, &current, &next))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn auth_list_users(app: tauri::AppHandle) -> Result<Vec<UserRow>, String> {
    list_users(&store_path(&app)?, &*session_lock()?)
}

#[tauri::command]
pub async fn auth_create_user(
    app: tauri::AppHandle,
    username: String,
    password: String,
    is_admin: bool,
) -> Result<UserInfo, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        create_user(&path, now_secs(), &*session_lock()?, &username, &password, is_admin)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn auth_delete_user(app: tauri::AppHandle, username: String) -> Result<(), String> {
    delete_user(&store_path(&app)?, &*session_lock()?, &username)
}

#[tauri::command]
pub async fn auth_reset_password(app: tauri::AppHandle, username: String, password: String) -> Result<(), String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || reset_password(&path, &*session_lock()?, &username, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_recover(
    app: tauri::AppHandle,
    username: String,
    code: String,
    password: String,
) -> Result<RecoveryCode, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        recover(&path, now_secs(), &mut *throttle_lock()?, &username, &code, &password)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_regenerate_recovery(app: tauri::AppHandle, password: String) -> Result<RecoveryCode, String> {
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || regenerate_recovery(&path, &*session_lock()?, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    struct Fixture {
        _dir: tempfile::TempDir,
        path: PathBuf,
        session: Option<Session>,
        throttle: Throttle,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = auth_path(dir.path());
        Fixture { _dir: dir, path, session: None, throttle: Throttle::default() }
    }

    fn set_up(f: &mut Fixture) -> String {
        setup(&f.path, NOW, &mut f.session, "Barry", "owner-password").unwrap().recovery_code
    }

    #[test]
    fn a_new_install_asks_for_an_administrator_and_signs_them_in() {
        let mut f = fixture();
        let st = status(&f.path, NOW, &mut f.session).unwrap();
        assert!(st.needs_setup && st.user.is_none());
        let code = set_up(&mut f);
        assert_eq!(code.len(), 23, "{code}");
        assert_eq!(code.matches('-').count(), 3);
        let st = status(&f.path, NOW, &mut f.session).unwrap();
        assert!(!st.needs_setup);
        assert_eq!(st.user, Some(UserInfo { username: "Barry".into(), is_admin: true }));
        let stored = std::fs::read_to_string(&f.path).unwrap();
        assert!(!stored.contains("owner-password") && !stored.contains(&code), "secrets are stored hashed");
        assert_eq!(setup(&f.path, NOW, &mut f.session, "Other", "another-password").unwrap_err(), "already_set_up");
    }

    #[test]
    fn setup_refuses_a_short_password_and_a_blank_name() {
        let mut f = fixture();
        assert_eq!(setup(&f.path, NOW, &mut f.session, "Barry", "short").unwrap_err(), "password_too_short");
        assert_eq!(setup(&f.path, NOW, &mut f.session, "  ", "long-enough").unwrap_err(), "username_invalid");
        assert!(status(&f.path, NOW, &mut f.session).unwrap().needs_setup);
    }

    #[test]
    fn sign_in_checks_the_password_and_ignores_name_case() {
        let mut f = fixture();
        set_up(&mut f);
        sign_out(&f.path, &mut f.session).unwrap();
        let bad = sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "wrong-password", 0);
        assert_eq!(bad.unwrap_err(), "invalid_credentials");
        let nobody = sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "nobody", "owner-password", 0);
        assert_eq!(nobody.unwrap_err(), "invalid_credentials");
        assert!(f.session.is_none());
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "barry", "owner-password", 0).unwrap();
        assert_eq!(f.session.as_ref().unwrap().username, "Barry");
    }

    #[test]
    fn without_remember_me_a_restart_asks_again() {
        let mut f = fixture();
        set_up(&mut f);
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "owner-password", 0).unwrap();
        let mut restarted = None;
        assert!(status(&f.path, NOW + 60, &mut restarted).unwrap().user.is_none());
    }

    #[test]
    fn remember_me_survives_a_restart_until_it_lapses() {
        let mut f = fixture();
        set_up(&mut f);
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "owner-password", 7).unwrap();
        let mut restarted = None;
        let st = status(&f.path, NOW + 6 * 86_400, &mut restarted).unwrap();
        assert_eq!(st.user.unwrap().username, "Barry");
        assert_eq!(st.remember_until, Some((NOW + 7 * 86_400) * 1000));
        let mut later = None;
        assert!(status(&f.path, NOW + 7 * 86_400 + 1, &mut later).unwrap().user.is_none());
    }

    #[test]
    fn only_the_offered_remember_lengths_are_accepted() {
        let mut f = fixture();
        set_up(&mut f);
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "owner-password", 365).unwrap();
        assert_eq!(f.session.as_ref().unwrap().remember_until, None);
    }

    #[test]
    fn signing_out_forgets_the_remembered_sign_in() {
        let mut f = fixture();
        set_up(&mut f);
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "owner-password", 30).unwrap();
        sign_out(&f.path, &mut f.session).unwrap();
        let mut restarted = None;
        assert!(status(&f.path, NOW + 60, &mut restarted).unwrap().user.is_none());
    }

    #[test]
    fn the_lock_screen_takes_only_the_signed_in_users_password() {
        let mut f = fixture();
        set_up(&mut f);
        assert_eq!(unlock(&f.path, NOW, &f.session, &mut f.throttle, "wrong-password").unwrap_err(), "invalid_credentials");
        unlock(&f.path, NOW, &f.session, &mut f.throttle, "owner-password").unwrap();
        assert_eq!(unlock(&f.path, NOW, &None, &mut f.throttle, "owner-password").unwrap_err(), "not_signed_in");
    }

    #[test]
    fn repeated_wrong_passwords_pause_sign_in() {
        let mut f = fixture();
        set_up(&mut f);
        for _ in 0..FREE_FAILURES {
            let _ = sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "wrong-password", 0);
        }
        let paused = sign_in(&f.path, NOW + 1, &mut f.session, &mut f.throttle, "Barry", "owner-password", 0);
        assert_eq!(paused.unwrap_err(), "throttled:29");
        sign_in(&f.path, NOW + FIRST_PAUSE_SECS, &mut f.session, &mut f.throttle, "Barry", "owner-password", 0).unwrap();
        assert_eq!(f.throttle.failures, 0);
    }

    #[test]
    fn a_user_changes_their_own_password() {
        let mut f = fixture();
        set_up(&mut f);
        assert_eq!(
            change_password(&f.path, &f.session, "wrong-password", "new-password-1").unwrap_err(),
            "wrong_current_password"
        );
        assert_eq!(change_password(&f.path, &f.session, "owner-password", "short").unwrap_err(), "password_too_short");
        change_password(&f.path, &f.session, "owner-password", "new-password-1").unwrap();
        sign_out(&f.path, &mut f.session).unwrap();
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "new-password-1", 0).unwrap();
    }

    #[test]
    fn only_an_administrator_manages_users() {
        let mut f = fixture();
        set_up(&mut f);
        create_user(&f.path, NOW, &f.session, "Ann", "ann-password", false).unwrap();
        assert_eq!(create_user(&f.path, NOW, &f.session, "ann", "ann-password", false).unwrap_err(), "username_taken");
        assert_eq!(list_users(&f.path, &f.session).unwrap().len(), 2);

        let mut ann = None;
        sign_in(&f.path, NOW, &mut ann, &mut f.throttle, "Ann", "ann-password", 0).unwrap();
        assert_eq!(list_users(&f.path, &ann).unwrap_err(), "not_admin");
        assert_eq!(create_user(&f.path, NOW, &ann, "Bob", "bob-password", false).unwrap_err(), "not_admin");
        assert_eq!(delete_user(&f.path, &ann, "Barry").unwrap_err(), "not_admin");
        assert_eq!(list_users(&f.path, &None).unwrap_err(), "not_signed_in");

        reset_password(&f.path, &f.session, "Ann", "reset-password").unwrap();
        let mut ann_again = None;
        sign_in(&f.path, NOW, &mut ann_again, &mut f.throttle, "Ann", "reset-password", 0).unwrap();
    }

    #[test]
    fn the_last_administrator_and_yourself_cannot_be_deleted() {
        let mut f = fixture();
        set_up(&mut f);
        assert_eq!(delete_user(&f.path, &f.session, "barry").unwrap_err(), "cannot_delete_self");
        create_user(&f.path, NOW, &f.session, "Ann", "ann-password", true).unwrap();
        let mut ann = None;
        sign_in(&f.path, NOW, &mut ann, &mut f.throttle, "Ann", "ann-password", 0).unwrap();
        delete_user(&f.path, &ann, "Barry").unwrap();
        assert_eq!(delete_user(&f.path, &ann, "Ann").unwrap_err(), "cannot_delete_self");
        assert_eq!(delete_user(&f.path, &ann, "Nobody").unwrap_err(), "user_not_found");
    }

    #[test]
    fn a_deleted_user_is_signed_out_on_their_next_check() {
        let mut f = fixture();
        set_up(&mut f);
        create_user(&f.path, NOW, &f.session, "Ann", "ann-password", false).unwrap();
        let mut ann = None;
        sign_in(&f.path, NOW, &mut ann, &mut f.throttle, "Ann", "ann-password", 7).unwrap();
        delete_user(&f.path, &f.session, "Ann").unwrap();
        assert!(status(&f.path, NOW, &mut ann).unwrap().user.is_none());
        assert!(ann.is_none());
    }

    #[test]
    fn the_recovery_code_resets_a_password_once() {
        let mut f = fixture();
        let code = set_up(&mut f);
        sign_out(&f.path, &mut f.session).unwrap();
        assert_eq!(
            recover(&f.path, NOW, &mut f.throttle, "Barry", "AAAAA-AAAAA-AAAAA-AAAAA", "recovered-1").unwrap_err(),
            "recovery_invalid"
        );
        let typed = code.to_lowercase().replace('-', " ");
        let next = recover(&f.path, NOW, &mut f.throttle, "barry", &typed, "recovered-1").unwrap().recovery_code;
        assert_ne!(next, code);
        sign_in(&f.path, NOW, &mut f.session, &mut f.throttle, "Barry", "recovered-1", 0).unwrap();
        assert_eq!(
            recover(&f.path, NOW, &mut f.throttle, "Barry", &code, "recovered-2").unwrap_err(),
            "recovery_invalid",
            "a used code does not work twice"
        );
        recover(&f.path, NOW, &mut f.throttle, "Barry", &next, "recovered-2").unwrap();
    }

    #[test]
    fn an_administrator_replaces_a_lost_recovery_code() {
        let mut f = fixture();
        let old = set_up(&mut f);
        assert_eq!(regenerate_recovery(&f.path, &f.session, "wrong-password").unwrap_err(), "wrong_current_password");
        let new = regenerate_recovery(&f.path, &f.session, "owner-password").unwrap().recovery_code;
        assert_eq!(recover(&f.path, NOW, &mut f.throttle, "Barry", &old, "recovered-1").unwrap_err(), "recovery_invalid");
        recover(&f.path, NOW, &mut f.throttle, "Barry", &new, "recovered-1").unwrap();
    }

    #[test]
    fn deleting_the_file_starts_over() {
        let mut f = fixture();
        set_up(&mut f);
        std::fs::remove_file(&f.path).unwrap();
        let mut fresh = None;
        assert!(status(&f.path, NOW, &mut fresh).unwrap().needs_setup);
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_a_fresh_install() {
        let mut f = fixture();
        std::fs::write(&f.path, "{ not json").unwrap();
        assert!(status(&f.path, NOW, &mut f.session).unwrap_err().starts_with("store_unreadable"));
    }
}
