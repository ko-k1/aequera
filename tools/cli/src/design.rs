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

/// Every generated stylesheet, relative to the repository root.
pub const TARGETS: &[&str] = &["aequera/extensions/ad-veil/addon/pages/tokens.css"];

#[derive(Deserialize)]
struct Tokens {
    meta: Meta,
    chrome: Chrome,
    rows: Rows,
    shape: Shape,
    material: Material,
    #[serde(rename = "type")]
    type_: Type,
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
    /// Every target matches the source (after writing, unless `--check`).
    pub up_to_date: bool,
}

#[derive(Debug, Serialize)]
pub struct TargetState {
    pub path: String,
    /// "unchanged", "written", or (with `--check`) "stale".
    pub state: String,
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

/// The stylesheet for `text` (the contents of tokens.toml).
pub fn render(text: &str) -> Result<String, String> {
    let t: Tokens = toml::from_str(text).map_err(|e| format!("{TOKENS_RELATIVE}: {e}"))?;
    if t.meta.schema_version != 1 {
        return Err(format!(
            "{TOKENS_RELATIVE}: schema_version {} is not supported (expected 1)",
            t.meta.schema_version
        ));
    }
    let swift = curve("swift", &t.motion.swift)?;
    let snappy = curve("snappy", &t.motion.snappy)?;
    let smooth = curve("smooth", &t.motion.smooth)?;
    let ease = match t.motion.easing.as_str() {
        "swift" => &swift,
        "snappy" => &snappy,
        "smooth" => &smooth,
        other => {
            return Err(format!(
                "[motion] easing = {other:?}: expected swift, snappy, or smooth"
            ));
        }
    };
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
    css.push_str("}\n");
    Ok(css)
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
    Ok(TokensReport {
        source: TOKENS_RELATIVE.to_string(),
        targets,
        up_to_date,
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
}
