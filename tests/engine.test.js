import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeForRegex,
  makeReplacer,
  collapseWhitespace,
  EMOJI_FIND_PATTERN,
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
