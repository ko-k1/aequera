//! Configuration validation and migration.
//!
//! Failure model (docs/design/CUSTOMIZATION.md): a malformed value is
//! rejected, the previous valid state is kept, a local actionable diagnostic
//! is emitted, and reset/safe-mode recovery stays available. Validation never
//! writes; migration writes atomically only when a real migration applies.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Current schema generation. Files newer than this are rejected, never guessed.
pub const CURRENT_SCHEMA: u32 = 1;

#[derive(Debug, Deserialize)]
struct VersionProbe {
    meta: Meta,
}

#[derive(Debug, Deserialize, Clone)]
struct Meta {
    schema_version: u32,
}

// ---------------------------------------------------------------------------
// Branding schema (configs/defaults/branding.toml)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrandingFile {
    // Version gate lives in validate_file (probe); kept here so unknown-key
    // denial covers [meta] and the schema stays total.
    #[allow(dead_code)]
    meta: Meta,
    product: BrandingProduct,
    profile: BrandingProfile,
    telemetry_identity: BrandingTelemetryIdentity,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrandingProduct {
    // Validated non-empty by branding_policy; consumed by build stamping later.
    display_name: String,
    app_name: String,
    vendor: String,
    remoting_name: String,
    dbus_service: String,
    update_channel: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrandingProfile {
    import_firefox_profile: bool,
    migrate_on_first_run: bool,
    paths: BrandingProfilePaths,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrandingProfilePaths {
    // Validated non-empty by branding_policy; consumed by profile layout later.
    windows_roaming: String,
    windows_local: String,
    linux: String,
    macos: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BrandingTelemetryIdentity {
    client_id_enabled: bool,
    attribution_enabled: bool,
    studies_enabled: bool,
}

// ---------------------------------------------------------------------------
// Privacy schema (configs/defaults/privacy.toml)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyFile {
    // See BrandingFile.meta.
    #[allow(dead_code)]
    meta: Meta,
    telemetry: PrivacyTelemetry,
    studies: PrivacyStudies,
    newtab: PrivacyNewtab,
    vendor_services: PrivacyVendorServices,
    crash: PrivacyCrash,
    update: PrivacyUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyTelemetry {
    enabled: bool,
    unified: bool,
    archive: bool,
    data_submission: bool,
    healthreport_upload: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyStudies {
    optout_studies: bool,
    normandy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyNewtab {
    sponsored_topsites: bool,
    sponsored_stories: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyVendorServices {
    pocket: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyCrash {
    auto_submit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivacyUpdate {
    mode: UpdateMode,
    background: bool,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum UpdateMode {
    Notify,
    Manual,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct FileResult {
    pub file: String,
    pub ok: bool,
    pub schema_version: Option<u32>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidateReport {
    pub files_checked: usize,
    pub valid: bool,
    pub results: Vec<FileResult>,
}

#[derive(Debug, Serialize)]
pub struct MigrateReport {
    pub file: String,
    pub from_schema: u32,
    pub to_schema: u32,
    pub migrated: bool,
    pub note: String,
}

/// Validate one file against the schema registered for its file name.
pub fn validate_file(path: &Path) -> FileResult {
    let name = path.display().to_string();
    let text = match std::fs::read_to_string(path) {
        Err(e) => {
            return FileResult {
                file: name,
                ok: false,
                schema_version: None,
                errors: vec![format!("unreadable: {e}")],
            };
        }
        Ok(text) => text,
    };
    let probe: VersionProbe = match toml::from_str::<VersionProbe>(&text) {
        Err(e) => {
            return FileResult {
                file: name,
                ok: false,
                schema_version: None,
                errors: vec![format!("invalid TOML: {e}")],
            };
        }
        Ok(probe) => probe,
    };
    if probe.meta.schema_version > CURRENT_SCHEMA {
        return FileResult {
            file: name,
            ok: false,
            schema_version: Some(probe.meta.schema_version),
            errors: vec![format!(
                "schema v{} newer than this CLI (v{CURRENT_SCHEMA}); refusing to guess",
                probe.meta.schema_version
            )],
        };
    }
    if probe.meta.schema_version < CURRENT_SCHEMA {
        return FileResult {
            file: name,
            ok: false,
            schema_version: Some(probe.meta.schema_version),
            errors: vec![format!(
                "schema v{} predates v{CURRENT_SCHEMA}; run `aequera config migrate`",
                probe.meta.schema_version
            )],
        };
    }
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let errors = match file_name {
        "branding.toml" => check_with(&text, branding_policy),
        "privacy.toml" => check_with(&text, privacy_policy),
        other => vec![format!(
            "no schema registered for {other:?}; undocumented configuration is rejected"
        )],
    };
    FileResult {
        file: name,
        ok: errors.is_empty(),
        schema_version: Some(probe.meta.schema_version),
        errors,
    }
}

fn check_with<T, F>(text: &str, policy: F) -> Vec<String>
where
    T: for<'de> Deserialize<'de>,
    F: FnOnce(T) -> Vec<String>,
{
    match toml::from_str::<T>(text) {
        Ok(parsed) => policy(parsed),
        Err(e) => vec![format!("schema violation: {e}")],
    }
}

/// Product invariants from docs/RESTRICTIONS.md, enforced in code:
/// branding must never re-enable data collection, and profiles must never
/// migrate silently.
fn branding_policy(file: BrandingFile) -> Vec<String> {
    let mut errors = Vec::new();
    let off = |errors: &mut Vec<String>, key: &str, value: bool| {
        if value {
            errors.push(format!(
                "policy violation: {key} must be false (RESTRICTIONS.md: no telemetry, no silent migration)"
            ));
        }
    };
    off(
        &mut errors,
        "telemetry_identity.client_id_enabled",
        file.telemetry_identity.client_id_enabled,
    );
    off(
        &mut errors,
        "telemetry_identity.attribution_enabled",
        file.telemetry_identity.attribution_enabled,
    );
    off(
        &mut errors,
        "telemetry_identity.studies_enabled",
        file.telemetry_identity.studies_enabled,
    );
    off(
        &mut errors,
        "profile.import_firefox_profile",
        file.profile.import_firefox_profile,
    );
    off(
        &mut errors,
        "profile.migrate_on_first_run",
        file.profile.migrate_on_first_run,
    );
    // Identity and path strings stamp future builds; empty values would fail
    // silently downstream, so they fail loudly here.
    let non_empty = |errors: &mut Vec<String>, key: &str, value: &str| {
        if value.trim().is_empty() {
            errors.push(format!("policy violation: {key} must not be empty"));
        }
    };
    non_empty(
        &mut errors,
        "product.display_name",
        &file.product.display_name,
    );
    non_empty(&mut errors, "product.app_name", &file.product.app_name);
    non_empty(&mut errors, "product.vendor", &file.product.vendor);
    non_empty(
        &mut errors,
        "product.remoting_name",
        &file.product.remoting_name,
    );
    non_empty(
        &mut errors,
        "product.dbus_service",
        &file.product.dbus_service,
    );
    non_empty(
        &mut errors,
        "product.update_channel",
        &file.product.update_channel,
    );
    non_empty(
        &mut errors,
        "profile.paths.windows_roaming",
        &file.profile.paths.windows_roaming,
    );
    non_empty(
        &mut errors,
        "profile.paths.windows_local",
        &file.profile.paths.windows_local,
    );
    non_empty(
        &mut errors,
        "profile.paths.linux",
        &file.profile.paths.linux,
    );
    non_empty(
        &mut errors,
        "profile.paths.macos",
        &file.profile.paths.macos,
    );
    errors
}

/// Product invariants from docs/RESTRICTIONS.md, enforced in code:
/// no telemetry, no sponsored UI, no silent remote behavior, no uploads
/// without review, no background silent updates.
fn privacy_policy(file: PrivacyFile) -> Vec<String> {
    let mut errors = Vec::new();
    let off = |errors: &mut Vec<String>, key: &str, value: bool| {
        if value {
            errors.push(format!(
                "policy violation: {key} must be false (RESTRICTIONS.md)"
            ));
        }
    };
    off(&mut errors, "telemetry.enabled", file.telemetry.enabled);
    off(&mut errors, "telemetry.unified", file.telemetry.unified);
    off(&mut errors, "telemetry.archive", file.telemetry.archive);
    off(
        &mut errors,
        "telemetry.data_submission",
        file.telemetry.data_submission,
    );
    off(
        &mut errors,
        "telemetry.healthreport_upload",
        file.telemetry.healthreport_upload,
    );
    off(
        &mut errors,
        "studies.optout_studies",
        file.studies.optout_studies,
    );
    off(&mut errors, "studies.normandy", file.studies.normandy);
    off(
        &mut errors,
        "newtab.sponsored_topsites",
        file.newtab.sponsored_topsites,
    );
    off(
        &mut errors,
        "newtab.sponsored_stories",
        file.newtab.sponsored_stories,
    );
    off(
        &mut errors,
        "vendor_services.pocket",
        file.vendor_services.pocket,
    );
    off(&mut errors, "crash.auto_submit", file.crash.auto_submit);
    off(&mut errors, "update.background", file.update.background);
    // Closed enum today (Notify | Manual), but keep an explicit match so a
    // future variant (e.g. `Auto`) fails to compile here and gets a privacy
    // review instead of silently passing validation.
    match file.update.mode {
        UpdateMode::Notify | UpdateMode::Manual => {}
    }
    errors
}

/// Validate every `*.toml` in the committed defaults directory.
pub fn validate_defaults(root: &Path) -> Result<ValidateReport, String> {
    let dir = root.join("configs/defaults");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "toml").unwrap_or(false))
        .collect();
    paths.sort();
    if paths.is_empty() {
        return Err(format!("no .toml defaults in {}", dir.display()));
    }
    let results: Vec<FileResult> = paths.iter().map(|p| validate_file(p)).collect();
    Ok(ValidateReport {
        files_checked: results.len(),
        valid: results.iter().all(|r| r.ok),
        results,
    })
}

/// Migrate one file toward the current schema. Writes atomically (temp +
/// rename, previous kept as `.bak`) and only when a real migration applies.
/// In schema v1 there is nothing to migrate yet: the honest result is a
/// passthrough report, never a pretend rewrite.
pub fn migrate_file(path: &Path) -> Result<MigrateReport, String> {
    let checked = validate_file(path);
    // A file that fails for reasons other than age cannot be migrated.
    let from = checked.schema_version.unwrap_or(0);
    if checked.ok {
        return Ok(MigrateReport {
            file: path.display().to_string(),
            from_schema: from,
            to_schema: CURRENT_SCHEMA,
            migrated: false,
            note: format!("already at schema v{CURRENT_SCHEMA}; nothing to do"),
        });
    }
    if from >= CURRENT_SCHEMA {
        return Err(format!("{}: {}", path.display(), checked.errors.join("; ")));
    }
    Err(format!(
        "{}: no migrator registered from v{from} to v{CURRENT_SCHEMA} ({}); refusing to guess",
        path.display(),
        checked.errors.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch(name: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "aequera-config-test-{}-{}-{}",
            std::process::id(),
            id,
            name
        ))
    }

    fn candidate(name: &str, body: &str) -> PathBuf {
        let dir = scratch(name);
        std::fs::create_dir_all(&dir).unwrap();
        // Name it privacy.toml so a registered schema applies.
        let path = dir.join("privacy.toml");
        std::fs::write(&path, body).unwrap();
        path
    }

    const VALID_PRIVACY: &str = r#"
[meta]
schema_version = 1
[telemetry]
enabled = false
unified = false
archive = false
data_submission = false
healthreport_upload = false
[studies]
optout_studies = false
normandy = false
[newtab]
sponsored_topsites = false
sponsored_stories = false
[vendor_services]
pocket = false
[crash]
auto_submit = false
[update]
mode = "notify"
background = false
"#;

    #[test]
    fn shipped_defaults_validate() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let report = validate_defaults(&dir).expect("defaults dir must read");
        assert_eq!(report.files_checked, 2, "got: {report:?}");
        assert!(report.valid, "got: {report:?}");
    }

    #[test]
    fn valid_candidate_passes() {
        let path = candidate("ok", VALID_PRIVACY);
        let r = validate_file(&path);
        assert!(r.ok, "got: {r:?}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn wrong_type_rejected() {
        let body = VALID_PRIVACY.replace("enabled = false", "enabled = \"yes\"");
        let path = candidate("type", &body);
        let r = validate_file(&path);
        assert!(!r.ok);
        assert!(
            r.errors.iter().any(|e| e.contains("schema violation")),
            "got: {r:?}"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn unknown_key_rejected() {
        let body = VALID_PRIVACY.replace("[crash]", "[crash]\nphone_home = true");
        let path = candidate("unknown", &body);
        let r = validate_file(&path);
        assert!(!r.ok, "undocumented knobs must fail: {r:?}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn policy_violation_rejected() {
        // Structurally valid TOML that violates a product invariant.
        let body = VALID_PRIVACY.replace("normandy = false", "normandy = true");
        let path = candidate("policy", &body);
        let r = validate_file(&path);
        assert!(!r.ok);
        assert!(
            r.errors.iter().any(|e| e.contains("policy violation")),
            "got: {r:?}"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn bad_enum_rejected() {
        let body = VALID_PRIVACY.replace("mode = \"notify\"", "mode = \"silent\"");
        let path = candidate("enum", &body);
        let r = validate_file(&path);
        assert!(!r.ok, "got: {r:?}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn future_schema_rejected_not_guessed() {
        let body = VALID_PRIVACY.replace("schema_version = 1", "schema_version = 99");
        let path = candidate("future", &body);
        let r = validate_file(&path);
        assert!(!r.ok);
        assert!(
            r.errors.iter().any(|e| e.contains("newer than")),
            "got: {r:?}"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn invalid_candidate_leaves_prior_state_untouched() {
        // Recovery property: rejection is read-only. The candidate bytes are
        // unchanged and the shipped defaults still validate afterwards.
        let body = VALID_PRIVACY.replace("mode = \"notify\"", "mode = \"silent\"");
        let path = candidate("recovery", &body);
        let before = std::fs::read_to_string(&path).unwrap();
        let r = validate_file(&path);
        assert!(!r.ok);
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "validation must not mutate its input");
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        assert!(validate_defaults(&dir).unwrap().valid);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn migrate_passes_through_current_schema() {
        let path = candidate("migrate-ok", VALID_PRIVACY);
        let r = migrate_file(&path).expect("passthrough must succeed");
        assert!(!r.migrated);
        assert_eq!((r.from_schema, r.to_schema), (1, CURRENT_SCHEMA));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn migrate_refuses_without_registered_path() {
        let body = VALID_PRIVACY.replace("schema_version = 1", "schema_version = 0");
        let path = candidate("migrate-old", &body);
        let err = migrate_file(&path).expect_err("no v0 migrator exists");
        assert!(err.contains("no migrator registered"), "got: {err}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
