//! Ad Veil filter engine (docs/design/ADS.md, "Engine").
//!
//! adblock-rust does the parsing and matching. This crate is the seam the
//! add-on sees: one engine per instance, network decisions as small
//! integers, cosmetic results as JSON. `abi` exposes it to WebAssembly.

use adblock::Engine;
use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

mod abi;

/// Network decision for one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Decision {
    Allow = 0,
    Block = 1,
    /// The URL or its source could not be parsed: the request is allowed.
    Unparsable = -1,
}

/// Cosmetic rules for one document URL.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Cosmetic {
    /// Host-specific and simple generic selectors to hide, sorted.
    pub hide: Vec<String>,
    /// `#@#` exceptions; passed back to [`Veil::generic`].
    pub exceptions: Vec<String>,
    /// The page opted out of generic rules (`$generichide`).
    pub generichide: bool,
    /// Host-specific filters CSS cannot express (`:has-text()`, `:upward()`,
    /// `:remove()`, ...), as adblock-rust's operator chains:
    /// `{"selector": [{"type": "css-selector", "arg": ".x"}, ...],
    /// "action": {"type": "remove"}}` (no action: hide). Sorted by their JSON.
    pub procedural: Vec<serde_json::Value>,
}

/// Class and id names seen in a document, for generic rules.
#[derive(Debug, Default, Deserialize)]
pub struct Seen {
    #[serde(default)]
    pub classes: Vec<String>,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub exceptions: Vec<String>,
}

pub struct Veil {
    engine: Engine,
    /// The lists' `$popup` rules, judging the pages new windows open.
    popups: Engine,
}

/// Type options a `$popup` rule may carry besides `popup` (`$popup,script`):
/// the popup engine keeps only the popup part.
const TYPE_OPTIONS: &[&str] = &[
    "script",
    "image",
    "stylesheet",
    "css",
    "object",
    "object-subrequest",
    "subdocument",
    "frame",
    "xmlhttprequest",
    "xhr",
    "websocket",
    "font",
    "media",
    "other",
    "ping",
    "beacon",
    "document",
    "doc",
    "all",
    "popup",
];

/// The `$popup` (and `$all`) rules of filter list text, rewritten as
/// `$document` rules: adblock-rust rejects the `popup` option, and a page a
/// popup opens is a document, judged with its opener as the source (so
/// `$third-party` and `$domain=` keep their meaning). Other type options are
/// dropped.
pub fn popup_rules(lists: &str) -> String {
    let mut out = String::new();
    for line in lists.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') || line.contains('#') {
            continue;
        }
        let Some(dollar) = line.rfind('$') else {
            continue;
        };
        let (pattern, options) = (&line[..dollar], &line[dollar + 1..]);
        let options: Vec<&str> = options.split(',').map(str::trim).collect();
        if !options.iter().any(|o| *o == "popup" || *o == "all") {
            continue;
        }
        let kept: Vec<&str> = options
            .iter()
            .copied()
            .filter(|o| !TYPE_OPTIONS.contains(&o.trim_start_matches('~')))
            .chain(std::iter::once("document"))
            .collect();
        out.push_str(pattern);
        out.push('$');
        out.push_str(&kept.join(","));
        out.push('\n');
    }
    out
}

fn engine_of(lists: &str) -> Engine {
    let mut set = FilterSet::new(false);
    set.add_filter_list(lists.to_string(), ParseOptions::default());
    Engine::new_with_filter_set(set)
}

impl Veil {
    /// Compiles filter list text (several lists may be concatenated).
    pub fn compile(lists: &str) -> Self {
        Self {
            engine: engine_of(lists),
            popups: engine_of(&popup_rules(lists)),
        }
    }

    /// Loads engines produced by [`Veil::serialize`] with the same
    /// adblock-rust version. `None` when the bytes do not load.
    pub fn deserialize(bytes: &[u8]) -> Option<Self> {
        // [length of the first, little-endian u32][first][second]
        let length = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let first = bytes.get(4..4usize.checked_add(length)?)?;
        let second = bytes.get(4 + length..)?;
        let mut engine = Engine::default();
        engine.deserialize(first).ok()?;
        let mut popups = Engine::default();
        popups.deserialize(second).ok()?;
        Some(Self { engine, popups })
    }

    pub fn serialize(&self) -> Vec<u8> {
        let first = self.engine.serialize();
        let second = self.popups.serialize();
        let mut out = Vec::with_capacity(4 + first.len() + second.len());
        out.extend_from_slice(&(first.len() as u32).to_le_bytes());
        out.extend_from_slice(&first);
        out.extend_from_slice(&second);
        out
    }

    /// Whether the lists' popup rules block a new window opening `url` from
    /// a page at `opener`.
    pub fn check_popup(&self, url: &str, opener: &str) -> Decision {
        let Ok(request) = Request::new(url, opener, "main_frame", "get") else {
            return Decision::Unparsable;
        };
        if self.popups.check_network_request(&request).should_block() {
            Decision::Block
        } else {
            Decision::Allow
        }
    }

    /// `kind` is a WebExtension `webRequest` resource type (`main_frame`,
    /// `sub_frame`, `script`, `image`, `beacon`, ...).
    pub fn check(&self, url: &str, source: &str, kind: &str) -> Decision {
        let Ok(request) = Request::new(url, source, kind, "get") else {
            return Decision::Unparsable;
        };
        if self.engine.check_network_request(&request).should_block() {
            Decision::Block
        } else {
            Decision::Allow
        }
    }

    pub fn cosmetic(&self, url: &str) -> Cosmetic {
        let resources = self.engine.url_cosmetic_resources(url);
        let mut hide: Vec<String> = resources.hide_selectors.into_iter().collect();
        hide.sort();
        let mut exceptions: Vec<String> = resources.exceptions.into_iter().collect();
        exceptions.sort();
        let mut procedural: Vec<String> = resources.procedural_actions.into_iter().collect();
        procedural.sort();
        Cosmetic {
            hide,
            exceptions,
            generichide: resources.generichide,
            procedural: procedural
                .iter()
                .filter_map(|json| serde_json::from_str(json).ok())
                .collect(),
        }
    }

    /// Generic selectors that apply to the class and id names in `seen`.
    pub fn generic(&self, seen: &Seen) -> Vec<String> {
        let exceptions: HashSet<String> = seen.exceptions.iter().cloned().collect();
        let mut selectors =
            self.engine
                .hidden_class_id_selectors(&seen.classes, &seen.ids, &exceptions);
        selectors.sort();
        selectors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "\
[Adblock Plus 2.0]
! Title: fixture
||ads.example^
||track.example^$third-party
@@||ads.example/allowed.js
example.com##.sponsored
##.ad-banner
example.com#@#.ad-banner
example.com#?#.card:has-text(Sponsored)
example.com##.tile:has-text(Promoted)
example.com#?#.row:-abp-contains(Partner)
example.com##.promo-box:remove()
||pops.example^$popup
&zoneid=*&ad_$popup,third-party
||both.example^$popup,script
@@||pops.example/allowed$popup
";

    fn veil() -> Veil {
        Veil::compile(LIST)
    }

    #[test]
    fn blocks_network_matches() {
        let v = veil();
        assert_eq!(
            v.check("https://ads.example/x.js", "https://news.test/", "script"),
            Decision::Block
        );
        assert_eq!(
            v.check("https://cdn.test/app.js", "https://news.test/", "script"),
            Decision::Allow
        );
    }

    #[test]
    fn exception_rules_allow() {
        let v = veil();
        assert_eq!(
            v.check(
                "https://ads.example/allowed.js",
                "https://news.test/",
                "script"
            ),
            Decision::Allow
        );
    }

    #[test]
    fn third_party_option_is_respected() {
        let v = veil();
        assert_eq!(
            v.check("https://track.example/p", "https://news.test/", "image"),
            Decision::Block
        );
        assert_eq!(
            v.check("https://track.example/p", "https://track.example/", "image"),
            Decision::Allow
        );
    }

    #[test]
    fn firefox_resource_types_parse() {
        let v = veil();
        for kind in [
            "main_frame",
            "sub_frame",
            "beacon",
            "xmlhttprequest",
            "imageset",
            "speculative",
        ] {
            assert_ne!(
                v.check("https://cdn.test/a", "https://news.test/", kind),
                Decision::Unparsable,
                "{kind}"
            );
        }
    }

    #[test]
    fn unparsable_urls_are_reported() {
        assert_eq!(
            veil().check("not a url", "https://news.test/", "script"),
            Decision::Unparsable
        );
    }

    #[test]
    fn host_specific_selectors_apply_only_on_their_host() {
        let v = veil();
        assert!(
            v.cosmetic("https://example.com/a")
                .hide
                .contains(&".sponsored".to_string())
        );
        assert!(
            !v.cosmetic("https://other.test/a")
                .hide
                .contains(&".sponsored".to_string())
        );
    }

    #[test]
    fn popup_rules_judge_new_windows() {
        let v = veil();
        let opener = "https://news.test/story";
        assert_eq!(v.check_popup("https://pops.example/landing", opener), Decision::Block);
        assert_eq!(v.check_popup("https://pops.example/allowed", opener), Decision::Allow, "exception");
        assert_eq!(
            v.check_popup("https://track.test/go?s=1&zoneid=7&ad_id=2", opener),
            Decision::Block,
            "a path rule, third-party"
        );
        assert_eq!(
            v.check_popup("https://news.test/go?s=1&zoneid=7&ad_id=2", opener),
            Decision::Allow,
            "the same rule, first-party"
        );
        assert_eq!(v.check_popup("https://both.example/", opener), Decision::Block, "$popup,script");
        assert_eq!(v.check_popup("https://cdn.test/page", opener), Decision::Allow);
        // Network rules do not judge popups, and popup rules not requests.
        assert_eq!(v.check_popup("https://ads.example/", opener), Decision::Allow);
        assert_eq!(v.check("https://pops.example/x.js", opener, "script"), Decision::Allow);
        assert_eq!(v.check("https://both.example/x.js", opener, "script"), Decision::Allow);
    }

    #[test]
    fn popup_rules_rewrite() {
        assert_eq!(
            popup_rules("||a.test^$popup\n||b.test^$script\n&z=$popup,~third-party,subdocument\n##.x\n! c$popup\n"),
            "||a.test^$document\n&z=$~third-party,document\n"
        );
    }

    #[test]
    fn procedural_filters_come_as_operator_chains() {
        let v = veil();
        let procedural = v.cosmetic("https://example.com/a").procedural;
        assert_eq!(
            procedural,
            vec![
                serde_json::json!({"selector": [{"type": "css-selector", "arg": ".card"}, {"type": "has-text", "arg": "Sponsored"}]}),
                serde_json::json!({"selector": [{"type": "css-selector", "arg": ".promo-box"}], "action": {"type": "remove"}}),
                serde_json::json!({"selector": [{"type": "css-selector", "arg": ".row"}, {"type": "has-text", "arg": "Partner"}]}),
                serde_json::json!({"selector": [{"type": "css-selector", "arg": ".tile"}, {"type": "has-text", "arg": "Promoted"}]}),
            ]
        );
        assert!(v.cosmetic("https://other.test/").procedural.is_empty());
    }

    #[test]
    fn generic_class_selectors_and_exceptions() {
        let v = veil();
        let seen = |url: &str| Seen {
            classes: vec!["ad-banner".into(), "content".into()],
            ids: vec![],
            exceptions: v.cosmetic(url).exceptions,
        };
        assert_eq!(
            v.generic(&seen("https://other.test/")),
            vec![".ad-banner".to_string()]
        );
        assert!(v.generic(&seen("https://example.com/")).is_empty());
    }

    #[test]
    fn serialize_round_trip_keeps_decisions() {
        let bytes = veil().serialize();
        let loaded = Veil::deserialize(&bytes).expect("round trip");
        assert_eq!(
            loaded.check("https://ads.example/x.js", "https://news.test/", "script"),
            Decision::Block
        );
        assert_eq!(
            loaded.cosmetic("https://example.com/a"),
            veil().cosmetic("https://example.com/a")
        );
        assert_eq!(
            loaded.check_popup("https://pops.example/landing", "https://news.test/"),
            Decision::Block,
            "popup rules too"
        );
        assert!(Veil::deserialize(&bytes[..bytes.len() / 2]).is_none(), "truncated");
    }

    /// Cosmetic rules of the shipped lists by parse result (run with
    /// `--ignored --nocapture`).
    #[test]
    #[ignore]
    fn shipped_list_cosmetic_stats() {
        use adblock::filters::cosmetic::CosmeticFilter;
        let (mut plain, mut procedural, mut rejected) = (0, 0, 0);
        let (mut popups, mut popups_parsed) = (0, 0);
        for name in ["easylist.txt", "easyprivacy.txt"] {
            let path = format!("{}/../addon/lists/{name}", env!("CARGO_MANIFEST_DIR"));
            let text = std::fs::read_to_string(path).unwrap();
            for line in popup_rules(&text).lines() {
                popups += 1;
                if adblock::filters::network::NetworkFilter::parse(line, false, Default::default()).is_ok() {
                    popups_parsed += 1;
                }
            }
            for line in text.lines() {
                if !(line.contains("##") || line.contains("#?#") || line.contains("#@#")) || line.starts_with('!') {
                    continue;
                }
                match CosmeticFilter::parse(line, false, Default::default()) {
                    Ok(filter) if filter.plain_css_selector().is_some() => plain += 1,
                    Ok(_) => procedural += 1,
                    Err(_) => rejected += 1,
                }
            }
        }
        println!("cosmetic: plain {plain}, procedural {procedural}, rejected {rejected}");
        println!("popup rules: {popups}, parsed {popups_parsed}");
    }

    #[test]
    fn corrupt_bytes_do_not_load() {
        assert!(Veil::deserialize(b"not an engine").is_none());
        assert!(Veil::deserialize(&[]).is_none());
    }
}
