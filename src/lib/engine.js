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
// problems: "empty URL" | "invalid URL" (proposed result), "empty name".
export function computeChanges(targets, { replacer, mode, collapseWhitespace: collapse = false }) {
  if (!replacer) return [];
  const changes = [];
  for (const target of targets) {
    const field = mode === "urls" ? "url" : "title";
    const original = target[field];
    if (original === undefined) continue;
    let proposed = replacer(original);
    if (collapse) proposed = collapseWhitespace(proposed);
    if (proposed === original) continue;

    const problems = [];
    if (field === "url") {
      if (proposed === "") {
        problems.push("empty URL");
      } else {
        try {
          new URL(proposed);
        } catch {
          problems.push("invalid URL");
        }
      }
    } else if (proposed.trim() === "") {
      problems.push("empty name");
    }

    changes.push({
      id: target.id, kind: target.kind, path: target.path,
      field, original, proposed, problems,
    });
  }
  return changes;
}

// Emoji search pattern for the "Remove emoji" preset: the preset fills this exact
// string into the visible Find field (regex mode), so what runs is what the user
// sees and can edit. Covers pictographs, ZWJ sequences, skin tones, keycaps,
// flags, variation selectors. Coverage is bounded by the engine's Unicode data.
const EMOJI_ELEMENT =
  "(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?)";

export const EMOJI_FIND_PATTERN =
  `${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT}|[\\u{1F3FB}-\\u{1F3FF}]|[\\uFE0F\\u20E3])*`;
