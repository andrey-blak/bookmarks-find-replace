import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeForRegex,
  makeReplacer,
  collapseWhitespace,
  EMOJI_FIND_PATTERN,
  collectTargets,
  computeChanges,
} from "../src/lib/engine.js";

// --- escapeForRegex ---

test("escapeForRegex escapes regex metacharacters", () => {
  assert.equal(escapeForRegex("a.b*c"), "a\\.b\\*c");
  const re = new RegExp(escapeForRegex("$&[x]"), "u");
  assert.equal(re.test("$&[x]"), true);
});

// --- makeReplacer: basics ---

test("empty find yields null replacer", () => {
  assert.equal(makeReplacer({ find: "", replace: "z" }), null);
});

// --- makeReplacer: literal mode ---

test("literal mode inserts replacement verbatim, $-sequences intact", () => {
  const r = makeReplacer({ find: "x", replace: "a$&b$1", regex: false, caseSensitive: true });
  assert.equal(r("x-x"), "a$&b$1-a$&b$1");
});

test("literal mode can be case-insensitive", () => {
  const r = makeReplacer({ find: "Foo", replace: "X", regex: false, caseSensitive: false });
  assert.equal(r("foo Foo FOO"), "X X X");
});

test("literal mode with caseSensitive only matches exact case", () => {
  const r = makeReplacer({ find: "Foo", replace: "X", regex: false, caseSensitive: true });
  assert.equal(r("foo Foo FOO"), "foo X FOO");
});

// --- makeReplacer: whole word (literal mode) ---

test("whole word matches only standalone words", () => {
  const r = makeReplacer({ find: "cat", replace: "dog", regex: false, caseSensitive: true, wholeWord: true });
  // "catalog": no boundary; "cat-dog": boundary after hyphen; "thecat": no boundary
  assert.equal(r("cat catalog cat-dog thecat"), "dog catalog dog-dog thecat");
});

test("whole word is Unicode-aware for Cyrillic", () => {
  const r = makeReplacer({ find: "текст", replace: "X", regex: false, caseSensitive: true, wholeWord: true });
  // «текст» must match (quotes are not letters); "текстовый"/"подтекстом" must not
  assert.equal(r("текст текстовый «текст» подтекстом"), "X текстовый «X» подтекстом");
});

test("whole word is Unicode-aware for accented Latin and digits", () => {
  const r = makeReplacer({ find: "café", replace: "X", regex: false, caseSensitive: true, wholeWord: true });
  // "cafés": é glued to s; "1café": digit glued to front — both must not match
  assert.equal(r("café cafés 1café"), "X cafés 1café");
});

// --- makeReplacer: regex mode ---

test("regex mode supports capture groups", () => {
  const r = makeReplacer({ find: "(\\w+)@(\\w+)", replace: "$2.$1", regex: true, caseSensitive: true });
  assert.equal(r("bob@dev"), "dev.bob");
});

test("one replacer changes every string it is applied to (no shared match state)", () => {
  const r = makeReplacer({ find: "a", replace: "o", regex: true, caseSensitive: true });
  assert.equal(r("cat"), "cot");
  assert.equal(r("cat"), "cot");
  assert.equal(r("cat"), "cot");
});

test("regex mode is case-insensitive when requested", () => {
  const r = makeReplacer({ find: "f.o", replace: "X", regex: true, caseSensitive: false });
  assert.equal(r("Foo F.O fox"), "X X fox");
});

test("invalid regex throws SyntaxError", () => {
  assert.throws(
    () => makeReplacer({ find: "(", replace: "", regex: true, caseSensitive: true }),
    SyntaxError,
  );
});

// --- collapseWhitespace ---

test("collapseWhitespace squeezes runs and trims", () => {
  assert.equal(collapseWhitespace("  a   b  "), "a b");
  assert.equal(collapseWhitespace("a\t\tb"), "a b");
});

// --- emoji preset pattern (used via the ordinary replacer pipeline) ---

const emojiStrip = (s) =>
  collapseWhitespace(
    makeReplacer({ find: EMOJI_FIND_PATTERN, replace: "", regex: true, caseSensitive: true })(s),
  );

test("emoji pattern needs no u-flag escape errors and strips simple emoji", () => {
  assert.equal(emojiStrip("🔥 Sale"), "Sale");
  assert.equal(emojiStrip("no emoji here"), "no emoji here");
});

test("emoji pattern strips ZWJ sequences", () => {
  assert.equal(emojiStrip("a 👩‍💻 b"), "a b");
});

test("emoji pattern strips skin-tone modifiers", () => {
  assert.equal(emojiStrip("👍🏽 ok"), "ok");
});

test("emoji pattern strips keycaps", () => {
  assert.equal(emojiStrip("1️⃣ go"), "go");
});

test("emoji pattern strips flag sequences", () => {
  assert.equal(emojiStrip("🇩🇪 Germany"), "Germany");
});

test("emoji pattern strips variation-selector emoji", () => {
  assert.equal(emojiStrip("❤️ love"), "love");
});

test("emoji-only name becomes empty string", () => {
  assert.equal(emojiStrip("🤩🤩"), "");
});

// ============================================================
// Step 2: scope walk (collectTargets) and change computation
// ============================================================

// Fixture shaped like browser.bookmarks.getTree() output.
const TREE = [{
  id: "0", title: "", children: [
    { id: "1", title: "menuBar", children: [
      { id: "2", title: "Site One", url: "https://old.example/a" },
      { id: "3", title: "📁 Work", children: [
        { id: "4", title: "Docs", children: [
          { id: "5", title: "old readme", url: "https://old.example/b old" } ] },
        { id: "8", title: "Notes", children: [
          { id: "9", title: "old note", url: "https://n.example/old" } ] } ] } ] },
    { id: "6", title: "toolbar", children: [
      { id: "7", title: "Old Tab", url: "https://t.example/x" } ] } ] },
];

test("names mode without folders: bookmarks only", () => {
  const t = collectTargets(TREE, { scopeId: null, recursive: true, mode: "names", includeFolders: false });
  assert.deepEqual(t.map(x => x.id), ["2", "5", "9", "7"]);
});

test("names mode with folders excludes built-in roots", () => {
  const t = collectTargets(TREE, { scopeId: null, recursive: true, mode: "names", includeFolders: true });
  assert.deepEqual(t.map(x => x.id), ["2", "3", "4", "5", "8", "9", "7"]);
});

test("urls mode never yields folders", () => {
  const t = collectTargets(TREE, { scopeId: null, recursive: true, mode: "urls", includeFolders: true });
  assert.deepEqual(t.map(x => x.id), ["2", "5", "9", "7"]);
  assert.ok(t.every(x => x.kind === "bookmark" && x.url !== undefined));
});

test("scope selects a folder's contents; paths are breadcrumbs", () => {
  const t = collectTargets(TREE, { scopeId: "3", recursive: true, mode: "names", includeFolders: true });
  assert.deepEqual(t.map(x => x.id), ["4", "5", "8", "9"]);
  assert.equal(t.find(x => x.id === "5").path, "menuBar / 📁 Work / Docs");
});

test("non-recursive yields direct children of the scope only", () => {
  const t = collectTargets(TREE, { scopeId: "3", recursive: false, mode: "names", includeFolders: true });
  assert.deepEqual(t.map(x => x.id), ["4", "8"]);
});

test("non-recursive with folders off finds nothing inside Work", () => {
  const t = collectTargets(TREE, { scopeId: "3", recursive: false, mode: "names", includeFolders: false });
  assert.deepEqual(t, []);
});

test("whole-tree non-recursive: children of built-in roots", () => {
  const t = collectTargets(TREE, { scopeId: null, recursive: false, mode: "names", includeFolders: true });
  assert.deepEqual(t.map(x => x.id), ["2", "3", "7"]);
});

const walk = (over = {}) =>
  collectTargets(TREE, { scopeId: null, recursive: true, mode: "names", includeFolders: false, ...over });

test("null replacer yields no changes", () => {
  assert.deepEqual(computeChanges(walk(), { replacer: null, mode: "names" }), []);
});

test("names: only items that actually change are reported", () => {
  const changes = computeChanges(walk(), {
    replacer: makeReplacer({ find: "old", replace: "new", regex: false, caseSensitive: true }),
    mode: "names",
  });
  assert.deepEqual(changes.map(c => [c.id, c.field, c.original, c.proposed]), [
    ["5", "title", "old readme", "new readme"],
    ["9", "title", "old note", "new note"],
  ]);
});

test("names with folders: folder titles participate", () => {
  const changes = computeChanges(walk({ includeFolders: true }), {
    replacer: makeReplacer({ find: "Work", replace: "Job", regex: false, caseSensitive: false }),
    mode: "names",
  });
  assert.deepEqual(changes.map(c => [c.id, c.kind, c.proposed]), [["3", "folder", "📁 Job"]]);
});

test("urls mode computes url-field changes", () => {
  const changes = computeChanges(walk({ mode: "urls" }), {
    replacer: makeReplacer({ find: "old.example", replace: "new.example", regex: false, caseSensitive: true }),
    mode: "urls",
  });
  assert.deepEqual(changes.map(c => [c.id, c.field]), [["2", "url"], ["5", "url"]]);
});

test("unparsable result URL is flagged invalid", () => {
  const changes = computeChanges(walk({ mode: "urls" }), {
    replacer: makeReplacer({ find: "old.example", replace: "spa ce.example", regex: false, caseSensitive: true }),
    mode: "urls",
  });
  assert.ok(changes.length > 0);
  assert.deepEqual(changes.map(c => c.problems), [["invalid URL"], ["invalid URL"]]);
});

test("empty result URL is flagged", () => {
  const changes = computeChanges(walk({ mode: "urls" }), {
    replacer: makeReplacer({ find: ".*", replace: "", regex: true, caseSensitive: true }),
    mode: "urls",
  });
  assert.deepEqual(changes.map(c => c.problems), [
    ["empty URL"], ["empty URL"], ["empty URL"], ["empty URL"],
  ]);
});

test("empty result name is flagged", () => {
  const changes = computeChanges(walk(), {
    replacer: makeReplacer({ find: ".*", replace: "", regex: true, caseSensitive: true }),
    mode: "names",
  });
  assert.ok(changes.length > 0);
  assert.ok(changes.every(c => c.problems.includes("empty name")));
});

test("collapseWhitespace applies to the proposed value (emoji pipeline)", () => {
  const changes = computeChanges(walk({ includeFolders: true }), {
    replacer: makeReplacer({ find: EMOJI_FIND_PATTERN, replace: "", regex: true, caseSensitive: true }),
    collapseWhitespace: true,
    mode: "names",
  });
  assert.deepEqual(changes.map(c => [c.id, c.proposed]), [["3", "Work"]]);
});

test("without collapseWhitespace the emoji pipeline leaves raw spacing", () => {
  const changes = computeChanges(walk({ includeFolders: true }), {
    replacer: makeReplacer({ find: EMOJI_FIND_PATTERN, replace: "", regex: true, caseSensitive: true }),
    mode: "names",
  });
  assert.equal(changes.find(c => c.id === "3").proposed, " Work");
});
