//! Output helper: human text by default, JSON with `--json`.

use serde::Serialize;

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
