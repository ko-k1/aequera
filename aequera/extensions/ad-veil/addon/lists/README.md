# Filter list snapshots

Shipped with Ad Veil and compiled by the add-on on first run; the
known-good fallback for list updates (`docs/design/ADS.md`, "Rules").

| File | List | Version | sha256 |
|---|---|---|---|
| `easylist.txt` | EasyList | 202610110853 | `f683837ed5b7fada7ffaba24c0ae97cfe518ae8984668f8d665784d790a09300` |
| `easyprivacy.txt` | EasyPrivacy | 202610110855 | `cf3e3b0330d3ad36166fb60e43a7cec3649d7a4ffae5452c7ba9b1b8645e76df` |

Source: `https://easylist.to/easylist/<file>`, unmodified (the version is
the `! Version:` header line).

License: the EasyList authors (https://easylist.to/). EasyList and
EasyPrivacy are dual licensed under the GNU General Public License,
version 3 or later, and Creative Commons Attribution-ShareAlike 3.0
Unported or later (https://easylist.to/pages/licence.html). They are data
files distributed alongside Aequera, not linked into it.

Refresh: download both files, replace them, and update this table
(`sha256sum`, `grep '^! Version:'`).
