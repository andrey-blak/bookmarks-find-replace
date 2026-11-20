// Pure logic module: no DOM, no browser.* APIs — unit-tested under `node --test`.
//
// Engine contract (enforced by tests):
// - `makeReplacer` returns a function `(string) => string`, or `null` for empty find.
// - Literal mode never lets JS interpret `$`-sequences in the replacement.
// - Each returned replacer builds its RegExp internally per call; no shared,
//   stateful global regex objects can escape this module.

export function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeReplacer({
  find,
  replace = "",
  regex = false,
  caseSensitive = false,
  wholeWord = false,
} = {}) {
  if (!find) return null;
  const flags = "gu" + (caseSensitive ? "" : "i");

  if (regex) {
    // In regex mode the user owns the pattern; whole-word is the user's `\b`,
    // and `$1`/`$&` in the replacement work as JS documents them.
    // Validate eagerly so a bad pattern surfaces at edit time, not at first use;
    // each call still gets a fresh RegExp (no shared match state).
    try {
      new RegExp(find, flags);
    } catch (error) {
      throw new SyntaxError(`Invalid regular expression: ${error.message}`);
    }
    return (value) => value.replace(new RegExp(find, flags), replace);
  }

  // Word edges are Unicode-aware: "not glued to a letter or digit on either
  // side" (lookarounds over \p{L}/\p{N}), so Cyrillic, accented Latin, CJK and
  // punctuation-quoted words all behave as users expect. Digits and underscore
  // count as word parts, punctuation does not.
  const source = wholeWord
    ? `(?<![\\p{L}\\p{N}_])(?:${escapeForRegex(find)})(?![\\p{L}\\p{N}_])`
    : escapeForRegex(find);
  // The replacer callback returns the replacement verbatim: string.replace would
  // otherwise interpret `$1`, `$&` etc. inside it.
  return (value) => value.replace(new RegExp(source, flags), () => replace);
}

export function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

// Emoji search pattern for the "Remove emoji" preset: the preset fills this exact
// string into the visible Find field (regex mode), so what runs is what the user
// sees and can edit. Covers pictographs, ZWJ sequences, skin tones, keycaps,
// flags, variation selectors. Coverage is bounded by the engine's Unicode data.
const EMOJI_ELEMENT =
  "(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?)";

export const EMOJI_FIND_PATTERN =
  `${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT}|[\\u{1F3FB}-\\u{1F3FF}]|[\\uFE0F\\u20E3])*`;
