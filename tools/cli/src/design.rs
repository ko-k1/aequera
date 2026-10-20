//! Design tokens -> generated CSS (`aequera design tokens [--check]`).
//!
//! `aequera/design/tokens.toml` is the source of truth. Pages that cannot
//! read it get a generated stylesheet of `--ae-*` custom properties (the
//! default profile; profile resolution belongs to aequera/customization).
//! The output is committed, so the Firefox build needs no generator, and
//! `--check` (also run by `cargo test`, below) fails when it is stale.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const TOKENS_RELATIVE: &str = "aequera/design/tokens.toml";

/// Default prefs that mirror tokens (`mirrored_prefs`).
const PREFS_RELATIVE: &str = crate::config::SHIPPED_PREFS_RELATIVE;

/// Every generated stylesheet, relative to the repository root.
pub const TARGETS: &[&str] = &[
    "aequera/extensions/ad-veil/addon/pages/tokens.css",
    "aequera/shell/firefox/aequera-tokens.css",
];

#[derive(Deserialize)]
struct Tokens {
    meta: Meta,
    chrome: Chrome,
    rows: Rows,
    shape: Shape,
    material: Material,
    #[serde(rename = "type")]
    type_: Type,
    color: Color,
    palette: Palette,
    traffic: Traffic,
    motion: Motion,
}

#[derive(Deserialize)]
struct Meta {
    schema_version: u32,
}

#[derive(Deserialize)]
struct Chrome {
    top: u32,
    rail: u32,
    panel: u32,
    ctl: u32,
}

#[derive(Deserialize)]
struct Rows {
    rpy: u32,
    rpx: u32,
    gap: u32,
}

#[derive(Deserialize)]
struct Shape {
    rad: u32,
}

#[derive(Deserialize)]
struct Material {
    blur: u32,
    sat: f64,
}

#[derive(Deserialize)]
struct Type {
    fs: u32,
}

/// `u8` channels: serde rejects anything outside 0..=255.
#[derive(Deserialize)]
struct Color {
    wash: [u8; 3],
    wash_hover: f64,
    wash_control: f64,
    wash_selected: f64,
}

/// One light and one dark sRGB triplet (`u8`, as for the wash).
#[derive(Deserialize)]
struct Pair {
    light: [u8; 3],
    dark: [u8; 3],
}

#[derive(Deserialize)]
struct Palette {
    canvas: Pair,
    surface: Pair,
    text: Pair,
    text_dim: Pair,
    accent: Pair,
    accent_hover: Pair,
    accent_active: Pair,
    on_accent: Pair,
    private: Pair,
}

#[derive(Deserialize)]
struct Traffic {
    tl: u32,
}

#[derive(Deserialize)]
struct Motion {
    dur_ms: u32,
    easing: String,
    swift: String,
    snappy: String,
    smooth: String,
}

#[derive(Debug, Serialize)]
pub struct TokensReport {
    pub source: String,
    pub targets: Vec<TargetState>,
    /// Mirrored prefs in aequera-prefs.js that differ from their token
    /// (fixed by hand: the file is not generated).
    pub prefs: Vec<String>,
    /// Every target matches the source (after writing, unless `--check`),
    /// and so does every mirrored pref.
    pub up_to_date: bool,
}

#[derive(Debug, Serialize)]
pub struct TargetState {
    pub path: String,
    /// "unchanged", "written", or (with `--check`) "stale".
    pub state: String,
}

/// WCAG 2 relative luminance of an sRGB triplet.
fn luminance([r, g, b]: [u8; 3]) -> f64 {
    let lin = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/// WCAG 2 contrast ratio of two sRGB triplets (1 to 21).
fn contrast(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Text contrast every palette pair that renders text must reach (WCAG AA).
const MIN_TEXT_CONTRAST: f64 = 4.5;

/// The palette's foreground/background pairs that render text, in both
/// schemes: fails when one falls below `MIN_TEXT_CONTRAST`.
fn check_palette(p: &Palette) -> Result<(), String> {
    let pairs = [
        ("on_accent", &p.on_accent, "accent", &p.accent),
        ("accent", &p.accent, "canvas", &p.canvas),
        ("accent", &p.accent, "surface", &p.surface),
        ("text", &p.text, "canvas", &p.canvas),
        ("text", &p.text, "surface", &p.surface),
        ("text_dim", &p.text_dim, "canvas", &p.canvas),
        ("text_dim", &p.text_dim, "surface", &p.surface),
        ("private", &p.private, "canvas", &p.canvas),
        ("private", &p.private, "surface", &p.surface),
    ];
    for (fg_name, fg, bg_name, bg) in pairs {
        for (scheme, f, b) in [("light", fg.light, bg.light), ("dark", fg.dark, bg.dark)] {
            let ratio = contrast(f, b);
            if ratio < MIN_TEXT_CONTRAST {
                return Err(format!(
                    "[palette] {fg_name} on {bg_name} ({scheme}): contrast {ratio:.2}, \
                     expected at least {MIN_TEXT_CONTRAST}"
                ));
            }
        }
    }
    Ok(())
}

/// Only `cubic-bezier(<numbers>)`: the value is pasted into CSS verbatim.
fn curve(name: &str, value: &str) -> Result<String, String> {
    let inner = value
        .strip_prefix("cubic-bezier(")
        .and_then(|rest| rest.strip_suffix(')'))
        .filter(|inner| {
            inner
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | ' ' | '-'))
        });
    match inner {
        Some(_) => Ok(value.to_string()),
        None => Err(format!(
            "[motion] {name} = {value:?}: expected cubic-bezier(x1,y1,x2,y2)"
        )),
    }
}

fn parse(text: &str) -> Result<Tokens, String> {
    let t: Tokens = toml::from_str(text).map_err(|e| format!("{TOKENS_RELATIVE}: {e}"))?;
    if t.meta.schema_version != 1 {
        return Err(format!(
            "{TOKENS_RELATIVE}: schema_version {} is not supported (expected 1)",
            t.meta.schema_version
        ));
    }
    Ok(t)
}

/// The curve `[motion] easing` names.
fn ease(t: &Tokens) -> Result<String, String> {
    match t.motion.easing.as_str() {
        "swift" => curve("swift", &t.motion.swift),
        "snappy" => curve("snappy", &t.motion.snappy),
        "smooth" => curve("smooth", &t.motion.smooth),
        other => Err(format!(
            "[motion] easing = {other:?}: expected swift, snappy, or smooth"
        )),
    }
}

/// The stylesheet for `text` (the contents of tokens.toml).
pub fn render(text: &str) -> Result<String, String> {
    let t = parse(text)?;
    let swift = curve("swift", &t.motion.swift)?;
    let snappy = curve("snappy", &t.motion.snappy)?;
    let smooth = curve("smooth", &t.motion.smooth)?;
    let ease = ease(&t)?;
    let px = [
        ("top", t.chrome.top),
        ("rail", t.chrome.rail),
        ("panel", t.chrome.panel),
        ("ctl", t.chrome.ctl),
        ("rpy", t.rows.rpy),
        ("rpx", t.rows.rpx),
        ("gap", t.rows.gap),
        ("rad", t.shape.rad),
        ("blur", t.material.blur),
        ("fs", t.type_.fs),
        ("tl", t.traffic.tl),
    ];
    let [r, g, b] = t.color.wash;
    let mut washes = Vec::new();
    for (name, alpha) in [
        ("hover", t.color.wash_hover),
        ("control", t.color.wash_control),
        ("selected", t.color.wash_selected),
    ] {
        if !(0.0..=1.0).contains(&alpha) {
            return Err(format!("[color] wash_{name} = {alpha}: expected 0 to 1"));
        }
        washes.push((name, alpha));
    }
    let mut css = String::from(
        "/* This Source Code Form is subject to the terms of the Mozilla Public\n \
         * License, v. 2.0. If a copy of the MPL was not distributed with this\n \
         * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n\
         \n\
         /* Generated from aequera/design/tokens.toml by `aequera design tokens`.\n \
         * Do not edit: change the tokens and regenerate. */\n\
         \n\
         :root {\n",
    );
    for (name, value) in px {
        css.push_str(&format!("  --ae-{name}: {value}px;\n"));
    }
    css.push_str(&format!("  --ae-sat: {};\n", t.material.sat));
    css.push_str(&format!("  --ae-dur: {}ms;\n", t.motion.dur_ms));
    css.push_str(&format!("  --ae-ease: {ease};\n"));
    css.push_str(&format!("  --ae-ease-swift: {swift};\n"));
    css.push_str(&format!("  --ae-ease-snappy: {snappy};\n"));
    css.push_str(&format!("  --ae-ease-smooth: {smooth};\n"));
    for (name, alpha) in washes {
        css.push_str(&format!(
            "  --ae-wash-{name}: rgb({r} {g} {b} / {alpha});\n"
        ));
    }
    let p = &t.palette;
    check_palette(p)?;
    for (name, pair) in [
        ("canvas", &p.canvas),
        ("surface", &p.surface),
        ("text", &p.text),
        ("text-dim", &p.text_dim),
        ("accent", &p.accent),
        ("accent-hover", &p.accent_hover),
        ("accent-active", &p.accent_active),
        ("on-accent", &p.on_accent),
        ("private", &p.private),
    ] {
        let [lr, lg, lb] = pair.light;
        let [dr, dg, db] = pair.dark;
        css.push_str(&format!(
            "  --ae-{name}: light-dark(rgb({lr} {lg} {lb}), rgb({dr} {dg} {db}));\n"
        ));
    }
    css.push_str("}\n");
    Ok(css)
}

/// Default prefs that carry a token, for chrome code that reads prefs
/// instead of CSS: (pref, the value it must ship, the token).
fn mirrored_prefs(t: &Tokens) -> Result<Vec<(&'static str, String, &'static str)>, String> {
    Ok(vec![
        (
            "aequera.motion.durationMs",
            t.motion.dur_ms.to_string(),
            "[motion] dur_ms",
        ),
        (
            "aequera.motion.easing",
            format!("\"{}\"", ease(t)?),
            "[motion] easing",
        ),
        (
            "aequera.rail.expandedWidth",
            t.chrome.panel.to_string(),
            "[chrome] panel",
        ),
    ])
}

/// Where `prefs_js` (aequera-prefs.js) ships a value other than the token
/// it mirrors. The file is written by hand, so it is checked, not generated.
pub fn prefs_mismatches(text: &str, prefs_js: &str) -> Result<Vec<String>, String> {
    let t = parse(text)?;
    Ok(mirrored_prefs(&t)?
        .into_iter()
        .filter_map(
            |(pref, want, token)| match crate::config::shipped_pref(prefs_js, pref) {
                Some(value) if value == want => None,
                Some(value) => Some(format!(
                    "{PREFS_RELATIVE}: {pref} ships {value}, {TOKENS_RELATIVE} {token} is {want}"
                )),
                None => Some(format!(
                    "{PREFS_RELATIVE}: {pref} is not set ({TOKENS_RELATIVE} {token} is {want})"
                )),
            },
        )
        .collect())
}

/// Regenerate every target (or, with `check`, only compare).
pub fn tokens(root: &Path, check: bool) -> Result<TokensReport, String> {
    let source = root.join(TOKENS_RELATIVE);
    let text =
        std::fs::read_to_string(&source).map_err(|e| format!("{}: {e}", source.display()))?;
    let css = render(&text)?;
    let mut targets = Vec::new();
    let mut up_to_date = true;
    for relative in TARGETS {
        let path = root.join(relative);
        let current = std::fs::read_to_string(&path).ok();
        let state = if current.as_deref() == Some(css.as_str()) {
            "unchanged"
        } else if check {
            up_to_date = false;
            "stale"
        } else {
            std::fs::write(&path, &css).map_err(|e| format!("{}: {e}", path.display()))?;
            "written"
        };
        targets.push(TargetState {
            path: relative.to_string(),
            state: state.to_string(),
        });
    }
    let prefs_path = root.join(PREFS_RELATIVE);
    let prefs_js = std::fs::read_to_string(&prefs_path)
        .map_err(|e| format!("{}: {e}", prefs_path.display()))?;
    let prefs = prefs_mismatches(&text, &prefs_js)?;
    Ok(TokensReport {
        source: TOKENS_RELATIVE.to_string(),
        targets,
        up_to_date: up_to_date && prefs.is_empty(),
        prefs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn shipped() -> String {
        std::fs::read_to_string(repo().join(TOKENS_RELATIVE)).unwrap()
    }

    #[test]
    fn committed_css_is_current() {
        let report = tokens(&repo(), true).expect("tokens must render");
        assert!(
            report.up_to_date,
            "stale generated CSS, run `aequera design tokens`: {report:?}"
        );
    }

    #[test]
    fn renders_shipped_values() {
        let css = render(&shipped()).unwrap();
        for line in [
            "  --ae-rad: 9px;\n",
            "  --ae-gap: 6px;\n",
            "  --ae-ctl: 30px;\n",
            "  --ae-fs: 14px;\n",
            "  --ae-tl: 12px;\n",
            "  --ae-sat: 1.5;\n",
            "  --ae-dur: 250ms;\n",
            "  --ae-ease: cubic-bezier(0.3,0.7,0.3,1);\n",
            "  --ae-wash-hover: rgb(127 140 170 / 0.12);\n",
            "  --ae-wash-selected: rgb(127 140 170 / 0.22);\n",
            "  --ae-accent: light-dark(rgb(3 105 161), rgb(78 213 255));\n",
            "  --ae-on-accent: light-dark(rgb(255 255 255), rgb(11 26 34));\n",
        ] {
            assert!(css.contains(line), "missing {line:?} in:\n{css}");
        }
    }

    #[test]
    fn future_schema_rejected() {
        let text = shipped().replace("schema_version = 1", "schema_version = 2");
        assert!(render(&text).unwrap_err().contains("schema_version 2"));
    }

    #[test]
    fn wash_out_of_range_rejected() {
        let alpha = shipped().replace("wash_hover = 0.12", "wash_hover = 1.5");
        assert!(render(&alpha).unwrap_err().contains("wash_hover"));
        let channel = shipped().replace("wash = [127, 140, 170]", "wash = [127, 140, 300]");
        assert!(render(&channel).is_err());
    }

    #[test]
    fn palette_pair_needs_both_schemes() {
        let half = shipped().replace(
            "accent = { light = [3, 105, 161], dark = [78, 213, 255] }",
            "accent = { light = [3, 105, 161] }",
        );
        assert!(render(&half).is_err());
        let channel = shipped().replace("dark = [78, 213, 255]", "dark = [78, 213, 256]");
        assert!(render(&channel).is_err());
    }

    #[test]
    fn contrast_matches_wcag() {
        assert!((contrast([0, 0, 0], [255, 255, 255]) - 21.0).abs() < 1e-9);
        assert!((contrast([255, 255, 255], [255, 255, 255]) - 1.0).abs() < 1e-9);
        // The shipped light accent under white text (tokens.toml: 5.9).
        let ratio = contrast([255, 255, 255], [3, 105, 161]);
        assert!((5.9..6.0).contains(&ratio), "{ratio}");
    }

    #[test]
    fn low_contrast_palette_rejected() {
        // A light accent too pale for white text.
        let text = shipped().replace(
            "accent = { light = [3, 105, 161]",
            "accent = { light = [120, 190, 230]",
        );
        let err = render(&text).unwrap_err();
        assert!(err.contains("on_accent on accent (light)"), "{err}");
        // Dimmed text too close to the dark canvas.
        let text = shipped().replace(
            "text_dim = { light = [95, 102, 114], dark = [154, 161, 173] }",
            "text_dim = { light = [95, 102, 114], dark = [70, 74, 82] }",
        );
        let err = render(&text).unwrap_err();
        assert!(err.contains("text_dim on canvas (dark)"), "{err}");
    }

    #[test]
    fn unknown_easing_rejected() {
        let text = shipped().replace("easing = \"swift\"", "easing = \"bouncy\"");
        assert!(render(&text).unwrap_err().contains("bouncy"));
    }

    #[test]
    fn curve_cannot_inject_css() {
        let text = shipped().replace(
            "swift = \"cubic-bezier(0.3,0.7,0.3,1)\"",
            "swift = \"cubic-bezier(0,0,1,1); } body { color: red\"",
        );
        assert!(render(&text).unwrap_err().contains("[motion] swift"));
    }

    #[test]
    fn missing_token_rejected() {
        let text = shipped().replace("rad = 9", "");
        assert!(render(&text).is_err());
    }

    fn shipped_prefs() -> String {
        std::fs::read_to_string(repo().join(PREFS_RELATIVE)).unwrap()
    }

    #[test]
    fn shipped_prefs_mirror_tokens() {
        assert_eq!(
            prefs_mismatches(&shipped(), &shipped_prefs()).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn changed_token_flags_its_pref() {
        let text = shipped()
            .replace("dur_ms = 250", "dur_ms = 200")
            .replace("easing = \"swift\"", "easing = \"snappy\"")
            .replace("panel = 220", "panel = 240");
        let found = prefs_mismatches(&text, &shipped_prefs()).unwrap();
        assert_eq!(found.len(), 3, "got: {found:?}");
        assert!(
            found[0].contains("aequera.motion.durationMs ships 250") && found[0].contains("is 200"),
            "got: {found:?}"
        );
        assert!(found[1].contains("aequera.motion.easing"), "got: {found:?}");
        assert!(
            found[2].contains("aequera.rail.expandedWidth ships 220"),
            "got: {found:?}"
        );
    }

    #[test]
    fn missing_mirrored_pref_flagged() {
        let prefs = shipped_prefs().replace("pref(\"aequera.rail.expandedWidth\", 220);\n", "");
        let found = prefs_mismatches(&shipped(), &prefs).unwrap();
        assert!(
            found.len() == 1 && found[0].contains("aequera.rail.expandedWidth is not set"),
            "got: {found:?}"
        );
    }
}
