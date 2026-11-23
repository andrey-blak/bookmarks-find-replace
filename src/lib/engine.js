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

// Compile the search once so a bad pattern surfaces at edit time, not at first
// use; callers build a fresh RegExp per operation (no shared match state).
// Throws SyntaxError with the engine's raw reason — display text is the UI's
// job (localization lives in _locales, not here).
function compileSpec({ find, regex, caseSensitive = false, wholeWord = false }) {
  const flags = "gu" + (caseSensitive ? "" : "i");
  let source;
  if (regex) {
    // In regex mode the user owns the pattern; whole-word is the user's `\b`,
    // and `$1`/`$&` in the replacement work as JS documents them.
    source = find;
  } else {
    // Word edges are Unicode-aware: "not glued to a letter or digit on either
    // side" (lookarounds over \p{L}/\p{N}), so Cyrillic, accented Latin, CJK and
    // punctuation-quoted words all behave as users expect. Digits and underscore
    // count as word parts, punctuation does not.
    source = wholeWord
      ? `(?<![\\p{L}\\p{N}_])(?:${escapeForRegex(find)})(?![\\p{L}\\p{N}_])`
      : escapeForRegex(find);
  }
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw new SyntaxError(error.message);
  }
  return { source, flags, interpretReplacement: Boolean(regex) };
}

// Expand JS replacement-pattern references ($$, $&, $`, $', $n/$nn) the way
// String.replace would, for one match. Unknown group numbers stay literal,
// mirroring the spec.
function expandTemplate(template, match, text) {
  return template.replace(/\$(\$|&|`|'|\d{1,2})/g, (whole, key) => {
    switch (key) {
      case "$": return "$";
      case "&": return match[0];
      case "`": return text.slice(0, match.index);
      case "'": return text.slice(match.index + match[0].length);
      default: {
        const hasGroup = (n) => n > 0 && n < match.length && match[n] !== undefined;
        if (key.length === 2) {
          if (hasGroup(Number(key))) return match[Number(key)];
          // Two-digit group does not exist: per spec the first digit is the
          // group and the second digit becomes literal text.
          if (hasGroup(Number(key[0]))) return match[Number(key[0])] + key[1];
          return whole;
        }
        return hasGroup(Number(key)) ? match[Number(key)] : whole;
      }
    }
  });
}

export function makeReplacer(options = {}) {
  const { find, replace = "" } = options;
  if (!find) return null;
  const { source, flags, interpretReplacement } = compileSpec(options);
  const substitution = interpretReplacement ? replace : (() => replace);
  return (value) => value.replace(new RegExp(source, flags), substitution);
}

// Same work as makeReplacer, but exposing which parts of the strings came from
// matches — the UI uses it to highlight "found here" and "produced by replace"
// segments in the preview. Guarantees: proposed.join("") equals
// makeReplacer(options)(value) for the same options.
// Patterns matching at nearly every position ("()", "a*", ...) would produce
// thousands of tiny segments per string: above maxSegments the description
// bails out with { overflow: true } and callers fall back to plain text.
export function describeReplacement(value, options = {}, maxSegments = Infinity) {
  const { find, replace = "" } = options;
  if (!find) {
    return {
      search: [{ text: value, matched: false }],
      proposed: [{ text: value, changed: false }],
      overflow: false,
    };
  }
  const { source, flags, interpretReplacement } = compileSpec(options);
  const re = new RegExp(source, flags);
  const search = [];
  const proposed = [];
  let last = 0;
  let match;
  while ((match = re.exec(value)) !== null) {
    if (search.length + proposed.length > maxSegments) return { overflow: true };
    if (match.index > last) {
      const text = value.slice(last, match.index);
      search.push({ text, matched: false });
      proposed.push({ text, changed: false });
    }
    if (match[0] !== "") search.push({ text: match[0], matched: true });
    const out = interpretReplacement
      ? expandTemplate(replace, match, value)
      : replace;
    if (out !== "") proposed.push({ text: out, changed: true });
    last = match.index + match[0].length;
    if (match[0] === "") re.lastIndex += 1; // zero-length match guard
  }
  if (last < value.length) {
    const text = value.slice(last);
    search.push({ text, matched: false });
    proposed.push({ text, changed: false });
  }
  if (search.length === 0) search.push({ text: "", matched: true });
  if (proposed.length === 0) proposed.push({ text: "", changed: false });
  return { search, proposed, overflow: false };
}

export function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

// --- readable URL form ---

// Decoded view used for matching and display on the URLs tab: punycode host
// becomes Unicode, UTF-8 percent escapes outside the reserved set become
// readable characters. Reserved escapes (%2F) and malformed input are left
// untouched; the function never throws. Storage and the apply re-check keep
// using the raw value.
const REBUILDABLE_PROTOCOLS = new Set(["http:", "https:", "ftp:"]);

// RFC 3492 punycode decoding (compact reference implementation). Needed
// because Node's URL keeps xn-- hosts serialized while browsers may not —
// the engine must decide the readable form itself, identically everywhere.
function punycodeDecode(input) {
  const base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700;
  let n = 128, i = 0, bias = 72;
  const basic = input.lastIndexOf("-");
  const output = basic > 0
    ? [...input.slice(0, basic)].map((c) => c.codePointAt(0))
    : [];
  let pos = basic > 0 ? basic + 1 : 0;

  const decodeDigit = (cp) => {
    if (cp >= 48 && cp <= 57) return cp - 22;  // '0'-'9' -> 26..35
    if (cp >= 65 && cp <= 90) return cp - 65;  // 'A'-'Z' -> 0..25
    if (cp >= 97 && cp <= 122) return cp - 97; // 'a'-'z' -> 0..25
    throw new Error("bad punycode digit");
  };
  const adapt = (delta, numPoints, firstTime) => {
    delta = firstTime ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / (base - tmin));
    let k = 0;
    while (delta > ((base - tmin) * tmax) >> 1) {
      delta = Math.floor(delta / (base - tmin));
      k += base;
    }
    return k + Math.floor(((base - tmin + 1) * delta) / (delta + skew));
  };

  for (; pos < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) throw new Error("bad punycode");
      const digit = decodeDigit(input.charCodeAt(pos++));
      i += digit * w;
      const t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

function unicodeHost(host) {
  return host
    .split(".")
    .map((label) => {
      if (!/^xn--/i.test(label)) return label;
      try {
        return punycodeDecode(label.slice(4));
      } catch {
        return label; // undecodable label: keep raw form
      }
    })
    .join(".");
}

function softDecode(text) {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

export function searchableUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (REBUILDABLE_PROTOCOLS.has(url.protocol) && url.hostname) {
      const auth = url.username
        ? `${url.username}${url.password ? ":" + url.password : ""}@`
        : "";
      const host = unicodeHost(url.hostname) + (url.port ? `:${url.port}` : "");
      return `${url.protocol}//${auth}${host}` +
        `${softDecode(url.pathname)}${softDecode(url.search)}${softDecode(url.hash)}`;
    }
  } catch {
    // not a parseable URL: fall through to a best-effort escape decode
  }
  return softDecode(rawUrl);
}

// --- scope walk ---

// Flatten the getTree()-shaped tree into editable targets.
// Options: scopeId (null = whole tree), recursive, mode ("names" | "urls"),
// includeFolders (names mode only).
// Rules (tested): the built-in roots (children of the hidden top node) are
// traversed but never themselves targets; the selected scope folder is not a
// target either — only its contents; `path` is the ancestor breadcrumb used
// for display.
export function collectTargets(
  tree,
  { scopeId = null, recursive = true, mode = "names", includeFolders = false } = {},
) {
  const targets = [];

  const isFolder = (node) => node.url === undefined && Array.isArray(node.children);
  const join = (path, title) => (path ? `${path} / ${title}` : title);

  function collect(nodes, path, recurse) {
    for (const node of nodes) {
      if (isFolder(node)) {
        if (includeFolders && mode === "names") {
          targets.push({ id: node.id, kind: "folder", path, title: node.title });
        }
        if (recurse) collect(node.children, join(path, node.title), recursive);
      } else if (node.url !== undefined) {
        targets.push({
          id: node.id, kind: "bookmark", path, title: node.title, url: node.url,
        });
      }
    }
  }

  if (scopeId === null) {
    for (const builtin of tree[0]?.children ?? []) {
      collect(builtin.children ?? [], builtin.title, recursive);
    }
    return targets;
  }

  function locate(nodes, trail) {
    for (const node of nodes) {
      if (node.id === scopeId) return { node, trail };
      const found = locate(node.children ?? [], [...trail, node]);
      if (found) return found;
    }
    return null;
  }

  const scope = locate(tree, []);
  if (!scope || !isFolder(scope.node)) return targets;
  const scopePath = scope.trail.map((n) => n.title).filter((t) => t !== "").join(" / ");
  collect(scope.node.children, join(scopePath, scope.node.title), recursive);
  return targets;
}

// --- change computation ---

// One entry per (target, field) whose value actually differs.
// URLs are matched on their readable form (searchableUrl): `searchable` and
// `proposed` are decoded text, `original` stays the raw stored value.
// problems are localization codes (the UI maps them to _locales):
// "empty-url" | "invalid-url" | "empty-name".
export function computeChanges(targets, { replacer, mode, collapseWhitespace: collapse = false }) {
  if (!replacer) return [];
  const changes = [];
  for (const target of targets) {
    const field = mode === "urls" ? "url" : "title";
    const original = target[field];
    if (original === undefined) continue;
    const searchable = field === "url" ? searchableUrl(original) : original;
    let proposed = replacer(searchable);
    // Collapse only when the search actually altered the value: a name with
    // stray double spaces but no match is not a change.
    if (collapse && proposed !== searchable) proposed = collapseWhitespace(proposed);
    if (proposed === searchable) continue;

    const problems = [];
    if (field === "url") {
      if (proposed === "") {
        problems.push("empty-url");
      } else {
        try {
          new URL(proposed);
        } catch {
          problems.push("invalid-url");
        }
      }
    } else if (proposed.trim() === "") {
      problems.push("empty-name");
    }

    changes.push({
      id: target.id, kind: target.kind, path: target.path,
      field, original, searchable, proposed, problems,
    });
  }
  return changes;
}

// Emoji search pattern for the "Remove emoji" preset: the preset fills this exact
// string into the visible Find field (regex mode), so what runs is what the user
// sees and can edit. Covers pictographs, ZWJ sequences, skin tones, keycaps,
// flags, variation selectors. Coverage is bounded by the engine's Unicode data.
// Plain digits and "#" are NOT emoji: the keycap branch requires the full
// FE0F + 20E3 sequence (verified against names like "Firefox 106 ... 4GB").
const EMOJI_ELEMENT =
  "(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F\\u20E3)";

export const EMOJI_FIND_PATTERN =
  `${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT}|[\\u{1F3FB}-\\u{1F3FF}]|[\\uFE0F\\u20E3])*`;
