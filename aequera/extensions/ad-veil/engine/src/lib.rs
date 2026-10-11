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
}

impl Veil {
    /// Compiles filter list text (several lists may be concatenated).
    pub fn compile(lists: &str) -> Self {
        let mut set = FilterSet::new(false);
        set.add_filter_list(lists.to_string(), ParseOptions::default());
        Self {
            engine: Engine::new_with_filter_set(set),
        }
    }

    /// Loads an engine produced by [`Veil::serialize`] with the same
    /// adblock-rust version. `None` when the bytes do not load.
    pub fn deserialize(bytes: &[u8]) -> Option<Self> {
        let mut engine = Engine::default();
        engine.deserialize(bytes).ok()?;
        Some(Self { engine })
    }

    pub fn serialize(&self) -> Vec<u8> {
        self.engine.serialize()
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
        Cosmetic {
            hide,
            exceptions,
            generichide: resources.generichide,
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
    }

    #[test]
    fn corrupt_bytes_do_not_load() {
        assert!(Veil::deserialize(b"not an engine").is_none());
        assert!(Veil::deserialize(&[]).is_none());
    }
}
