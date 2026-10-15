//! Output helper: human text by default, JSON with `--json`.

use serde::Serialize;
use std::process::ExitCode;

/// Print `human`, or pretty JSON of `value` when `json` is set.
pub fn emit<T: Serialize>(json: bool, human: &str, value: &T) {
    if json {
        match serde_json::to_string_pretty(value) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("JSON serialization failed ({e}); falling back to text:\n{human}");
            }
        }
    } else {
        println!("{human}");
    }
}

/// Report a failure and return its exit code: `context: error` on stderr,
/// and with `json` also `{"ok": false, "context", "error"}` on stdout, where
/// a caller parsing the JSON output reads it.
pub fn fail(json: bool, context: &str, error: &str) -> ExitCode {
    fail_with(json, context, error, ExitCode::FAILURE)
}

/// `fail` with a specific exit code.
pub fn fail_with(json: bool, context: &str, error: &str, code: ExitCode) -> ExitCode {
    eprintln!("{context}: {error}");
    if json {
        println!("{}", failure_json(context, error));
    }
    code
}

/// The `--json` failure object.
fn failure_json(context: &str, error: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "context": context, "error": error })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_json_names_context_and_error() {
        let v = failure_json("Fetch failed", "no route \"x\"");
        assert_eq!(v["ok"], false);
        assert_eq!(v["context"], "Fetch failed");
        assert_eq!(v["error"], "no route \"x\"");
    }
}
