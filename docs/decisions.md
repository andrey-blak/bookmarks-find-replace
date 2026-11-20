# Decisions

Only important, non-obvious decisions. Each entry says what was decided, why, and what it implies.

## Case-sensitivity defaults: Names insensitive, URLs sensitive

Human-language names are usually searched case-insensitively. URL paths and queries are case-sensitive to servers, so an insensitive sweep would rewrite `/File` and `/file` together, which is rarely intended.

## Undo is session-only, in memory

Undo batches live in the editor page's memory (max 20) and are gone when the tab closes. Consequence: closing the tab before undoing discards undo data.

## Localization via _locales

All user-visible strings live in `src/_locales/en/messages.json` and are applied by JavaScript  String-quality rules adopted so a future locale is add-a-file, not rewrite: full messages with placeholders instead of fragment assembly, no runtime grammatical plurals ("Changes: N" pattern), no gendered role nouns, path separators formatted in code.

## Packaging via scripts/build.sh

`scripts/build.sh` validates the manifest and zips `src/` into `dist/`.

## Architecture: direct API access from the extension page

The editor page calls `browser.bookmarks` directly; `background.js` only opens/focuses the tab. Message passing through a service worker was rejected: extension pages already have the full bookmarks API, and it removes an entire class of state-sync bugs.

## Minimum Firefox version: 142

The manifest declares `data_collection_permissions` (required by AMO for new extensions; `"required": ["none"]` — the add-on collects nothing), a key only recognized since Firefox 140 desktop / 142 Android, and `strict_min_version` applies to both, so the floor is `142.0`. Consequence: the lint gate runs with 0 errors, 0 warnings, 0 notices.
