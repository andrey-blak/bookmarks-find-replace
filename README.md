# Bookmarks Find & Replace

A Firefox extension for finding and replacing text in bookmark names, folder names, and URLs, with regular expressions, scoped search, and live preview.

The editor page shows the bookmark folder tree, lets you pick the search scope, previews changes live on Names and URLs tabs, and applies the selected changes.

## Requirements

- Firefox 142 or later.

## Install for testing (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on…".
3. Select `src/manifest.json` from this repository.

The extension then appears in the toolbar area (use the puzzle-piece menu if it is collapsed). Clicking its button opens the editor tab. Temporary add-ons are removed when Firefox restarts.

## Build a package

`scripts/build.sh` validates the manifest and packs `src/` into a zip file in `dist/`. A built zip can be loaded the same way via "Load Temporary Add-on…", or installed permanently in Firefox Developer Edition/Nightly via `about:configs` (`extensions.autoUpdateScopes` not required; use "Install Add-on From File…" in `about:addons` with signing disabled only on unbranded builds).

## Commands

- `npm test` — run the engine unit tests (`node --test`, no dependencies).
- `npx web-ext lint --source-dir src` — validate the package (web-ext fetched by npx on first use).
- `./scripts/build.sh` — produce `dist/*.zip`.

## Project layout

- `src/` — the extension package, exactly what ships in the zip.
- `src/lib/engine.js` — pure search/replace and change-computation logic, unit-tested in `tests/`.
- `src/_locales/en/messages.json` — every user-visible string.
- `scripts/build.sh` — manifest validation and packaging.
- `docs/` — decisions log and roadmap.

## Documentation

- `docs/decisions.md` — why the project is shaped the way it is.
- `docs/roadmap.md` — current scope and deferred ideas.
