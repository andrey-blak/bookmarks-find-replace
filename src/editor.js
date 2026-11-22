// UI layer: DOM wiring and rendering. Pure logic lives in lib/engine.js.
//
// Localization: Firefox does not substitute __MSG_...__ inside HTML pages, so
// every localized node carries data-i18n / data-i18n-title and is filled from
// _locales here. Bookmark-derived text goes through textContent only — never
// innerHTML.
import { collectTargets, computeChanges, makeReplacer, describeReplacement, EMOJI_FIND_PATTERN } from "./lib/engine.js";

const $ = (id) => document.getElementById(id);

const state = {
  tree: [],
  scopeId: null,        // null = All bookmarks
  expanded: new Set(),
};

const formState = {
  mode: "names",
  emojiPreset: false,
};

// --- i18n helpers ---

const msg = (key, substitutions) =>
  browser.i18n.getMessage(key, substitutions) || `‹${key}›`;

function localizeStaticText(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = msg(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = msg(el.dataset.i18nTitle);
  }
}

// --- tree utilities ---

const isFolder = (node) => node.url === undefined && Array.isArray(node.children);

// Breadcrumb including the node's own title; "" segments (hidden root) skipped.
function trailOf(nodes, targetId, acc = []) {
  for (const node of nodes) {
    if (node.id === targetId) return acc.concat(node.title);
    const found = trailOf(node.children ?? [], targetId, acc.concat(node.title));
    if (found !== null) return found;
  }
  return null;
}

// --- data load ---

async function loadBookmarks() {
  try {
    state.tree = await browser.bookmarks.getTree();
    $("error").hidden = true;
    render();
  } catch (error) {
    $("errorText").textContent = `${msg("loadError")} ${error.message}`;
    $("error").hidden = false;
  }
}

// --- sidebar rendering with roving-tabindex keyboard navigation ---

const treeRows = new Map(); // row id (null = "All bookmarks") -> { button, hasKids, parentId }
let rowOrder = [];          // row ids in visual order
let focusId = null;         // the one row reachable by Tab; arrows move it

function registerRow(id, button, meta) {
  treeRows.set(id, { button, ...meta });
  rowOrder.push(id);
}

function applyTabIndex() {
  for (const id of rowOrder) {
    treeRows.get(id).button.tabIndex = id === focusId ? 0 : -1;
  }
}

function refocusCurrent() {
  applyTabIndex();
  treeRows.get(focusId)?.button.focus();
}

function makeFolderRow(node, parentId) {
  const row = document.createElement("div");
  row.className = "tree-row";

  const subfolders = (node.children ?? []).filter(isFolder);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  const expanded = state.expanded.has(node.id);
  toggle.textContent = subfolders.length ? (expanded ? "▾" : "▸") : "";
  toggle.disabled = !subfolders.length;
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-hidden", "true");
  toggle.addEventListener("click", () => {
    if (expanded) state.expanded.delete(node.id);
    else state.expanded.add(node.id);
    renderSidebar();
    refocusCurrent();
  });

  const label = document.createElement("button");
  label.type = "button";
  label.className = "tree-button";
  label.textContent = node.title;
  label.setAttribute("role", "treeitem");
  label.setAttribute("aria-expanded", String(subfolders.length > 0));
  label.setAttribute("aria-selected", String(state.scopeId === node.id));
  if (state.scopeId === node.id) row.classList.add("selected");
  label.addEventListener("click", () => {
    clearApplyResult();
    state.scopeId = node.id;
    state.expanded.add(node.id);
    focusId = node.id;
    render();
    refocusCurrent();
  });

  registerRow(node.id, label, { hasKids: subfolders.length > 0, parentId });

  row.append(toggle, label);

  const wrapper = document.createElement("div");
  wrapper.append(row);
  if (subfolders.length && expanded) {
    const kids = document.createElement("div");
    kids.className = "tree-children";
    kids.setAttribute("role", "group");
    for (const child of subfolders) kids.append(makeFolderRow(child, node.id));
    wrapper.append(kids);
  }
  return wrapper;
}

function renderSidebar() {
  treeRows.clear();
  rowOrder = [];

  const tree = $("folderTree");
  tree.replaceChildren();
  tree.setAttribute("aria-label", msg("folderTreeLabel"));

  const builtins = state.tree[0]?.children ?? [];

  const allRow = document.createElement("div");
  allRow.className = "tree-row";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "tree-button";
  allButton.textContent = msg("allBookmarks");
  allButton.setAttribute("role", "treeitem");
  allButton.setAttribute("aria-expanded", "true");
  allButton.setAttribute("aria-selected", String(state.scopeId === null));
  if (state.scopeId === null) allRow.classList.add("selected");
  allButton.addEventListener("click", () => {
    clearApplyResult();
    state.scopeId = null;
    focusId = null;
    render();
    refocusCurrent();
  });
  registerRow(null, allButton, { hasKids: builtins.length > 0, parentId: null });
  allRow.append(allButton);
  tree.append(allRow);

  for (const builtin of builtins) {
    tree.append(makeFolderRow(builtin, null));
  }

  applyTabIndex();
}

$("folderTree").addEventListener("keydown", (event) => {
  const index = rowOrder.indexOf(focusId);
  if (index === -1) return;
  const row = treeRows.get(focusId);

  const moveTo = (n) => {
    const target = rowOrder[Math.min(rowOrder.length - 1, Math.max(0, n))];
    if (target === undefined) return;
    focusId = target;
    refocusCurrent();
  };

  switch (event.key) {
    case "ArrowDown":
      moveTo(index + 1);
      break;
    case "ArrowUp":
      moveTo(index - 1);
      break;
    case "Home":
      moveTo(0);
      break;
    case "End":
      moveTo(rowOrder.length - 1);
      break;
    case "ArrowRight":
      if (!row.hasKids) return;
      if (focusId === null) {
        for (const builtin of state.tree[0]?.children ?? []) state.expanded.add(builtin.id);
      } else if (!state.expanded.has(focusId)) {
        state.expanded.add(focusId);
      } else {
        moveTo(index + 1); // already open: focus first child (next visual row)
        return;
      }
      renderSidebar();
      moveTo(index + 1); // into the now-visible child
      break;
    case "ArrowLeft": {
      if (focusId === null) {
        state.expanded.clear();
        renderSidebar();
        refocusCurrent();
        return;
      }
      if (state.expanded.has(focusId)) {
        state.expanded.delete(focusId);
        renderSidebar();
        refocusCurrent();
        return;
      }
      focusId = row.parentId; // jump to parent ("All bookmarks" for top level)
      refocusCurrent();
      break;
    }
    default:
      return;
  }
  event.preventDefault();
});

// --- scope bar ---

function renderScope() {
  $("scopePath").textContent = state.scopeId === null
    ? msg("allBookmarks")
    : (trailOf(state.tree, state.scopeId) ?? [])
        .filter(Boolean)
        .join(" / ");
}

function render() {
  renderSidebar();
  renderScope();
  recompute();
}

// --- apply ---

// Batches of completed changes: [{ when, entries: [{id, field, oldValue, storedValue}] }]
const undoBatches = [];

async function applyEntries(entries) {
  const selected = entries.filter((entry) => entry.change.problems.length === 0);
  if (selected.length === 0) return;
  if (!confirm(msg("confirmApply", [selected.length]))) return;
  clearApplyResult();

  $("apply").disabled = true;
  const done = [];
  const skipped = [];
  const errors = [];

  for (const { change } of selected) {
    try {
      const [current] = await browser.bookmarks.get(change.id);
      const actual = change.field === "url" ? current.url : current.title;
      if (actual !== change.original) {
        skipped.push(`${change.path}: ${msg("skippedChanged")}`);
        continue;
      }
      // storedValue: what Firefox kept (it may normalize the input).
      const updated = await browser.bookmarks.update(change.id, {
        [change.field]: change.proposed,
      });
      done.push({
        id: change.id,
        field: change.field,
        oldValue: change.original,
        storedValue: updated[change.field],
      });
    } catch (error) {
      errors.push(`${change.path}: ${error.message}`);
    }
  }

  if (done.length > 0) undoBatches.push({ when: Date.now(), entries: done });
  showApplyResult(done.length, skipped, errors);
  await loadBookmarks();
}

function showApplyResult(applied, skipped, errors) {
  const result = $("applyResult");
  if (applied === 0 && skipped.length === 0 && errors.length === 0) {
    result.hidden = true;
    return;
  }
  const lines = [msg("applyResult", [applied, skipped.length, errors.length])];
  lines.push(...skipped, ...errors);
  result.textContent = lines.join("\n");
  result.hidden = false;
}

// --- search form + live preview ---

// Case-sensitivity defaults per tab (see docs/decisions.md).
const CASE_DEFAULTS = { names: false, urls: true };

let renderTimer;

function scheduleRecompute() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(recompute, 100);
}

function scopeOptions() {
  return {
    scopeId: state.scopeId,
    recursive: $("recursive").checked,
    mode: formState.mode,
    includeFolders: formState.mode === "names" && $("includeFolders").checked,
  };
}

let previewEntries = []; // { change, checked, checkbox? }
let renderToken = 0;     // cancels in-flight chunked renders

// Very long strings would freeze the table; cells display a clipped copy while
// the entries keep the full proposed values.
const CLIP_LENGTH = 2000;

// Highlighting gives up (plain rows) past this many segments per value.
const MAX_PREVIEW_SEGMENTS = 200;

function clipText(text) {
  return text.length <= CLIP_LENGTH ? text : `${text.slice(0, CLIP_LENGTH)}…`;
}

function validEntries() {
  return previewEntries.filter((entry) => entry.change.problems.length === 0);
}

function checkedValidCount() {
  return validEntries().filter((entry) => entry.checked).length;
}

// The apply/undo result line stays visible until the user interacts again;
// re-renders (auto-refresh, post-apply reload) must not wipe it.
function clearApplyResult() {
  const result = $("applyResult");
  result.hidden = true;
  result.textContent = "";
}

function updateApplyButton() {
  const n = checkedValidCount();
  const apply = $("apply");
  apply.textContent = msg("applyButton", [n]);
  apply.title = msg("applyHint");
  apply.disabled = n === 0;
  refreshSelectAll();
}

function refreshSelectAll() {
  const entries = validEntries();
  const checkedCount = entries.filter((entry) => entry.checked).length;
  const selectAll = $("selectAll");
  selectAll.disabled = entries.length === 0;
  selectAll.checked = entries.length > 0 && checkedCount === entries.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < entries.length;
  selectAll.setAttribute("aria-label", msg("selectAllRows"));
}

// Build a cell from {text, on} segments using textContent + <mark> only.
function fillCell(cell, segments, hlClass, extraClass) {
  const line = document.createElement("div");
  line.className = "change-line";
  if (extraClass) line.classList.add(extraClass);
  for (const segment of segments) {
    if (segment.on) {
      const mark = document.createElement("mark");
      mark.className = hlClass;
      mark.textContent = segment.text;
      line.append(mark);
    } else {
      line.append(document.createTextNode(segment.text));
    }
  }
  cell.append(line);
}

function appendPlainLine(cell, text, extraClass, prefix = "") {
  const line = document.createElement("div");
  line.className = "change-line";
  if (extraClass) line.classList.add(extraClass);
  if (prefix) line.append(document.createTextNode(prefix));
  line.append(document.createTextNode(clipText(text)));
  cell.append(line);
}

function makeRow(entry, searchOpts) {
  const { change } = entry;
  const tr = document.createElement("tr");
  if (change.problems.length) tr.className = "invalid";
  const isFolder = change.kind === "folder";
  if (isFolder) tr.classList.add("folder");

  const tdCheck = document.createElement("td");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = entry.checked;
  checkbox.disabled = change.problems.length > 0;
  checkbox.setAttribute("aria-label", msg("includeRow"));
  checkbox.addEventListener("change", () => {
    entry.checked = checkbox.checked;
    updateApplyButton();
  });
  entry.checkbox = checkbox;
  tdCheck.append(checkbox);

  const described = describeReplacement(change.original, searchOpts, MAX_PREVIEW_SEGMENTS);
  const folderClass = isFolder ? "folder-text" : "";

  const tdCurrent = document.createElement("td");
  if (described.overflow) {
    appendPlainLine(tdCurrent, change.original, folderClass, isFolder ? "📁 " : "");
  } else {
    const currentSegments = described.search.map((p) => ({ text: clipText(p.text), on: p.matched }));
    if (isFolder) currentSegments.unshift({ text: "📁 ", on: false });
    fillCell(tdCurrent, currentSegments, "hl-match", folderClass);
  }
  const currentMeta = document.createElement("div");
  currentMeta.className = "row-meta";
  currentMeta.textContent = change.path;
  tdCurrent.append(currentMeta);

  const tdNew = document.createElement("td");
  if (described.overflow || formState.emojiPreset) {
    // No segments (or collapse shifted the offsets): plain clipped value.
    appendPlainLine(tdNew, change.proposed, folderClass);
  } else {
    fillCell(tdNew, described.proposed.map((p) => ({ text: clipText(p.text), on: p.changed })),
      "hl-result", folderClass);
  }
  if (change.problems.length) {
    const reason = document.createElement("div");
    reason.className = "row-meta";
    const badge = document.createElement("span");
    badge.className = "reason";
    badge.textContent = change.problems.map(msg).join(", ");
    reason.append(badge);
    tdNew.append(reason);
  }

  const tdApply = document.createElement("td");
  const single = document.createElement("button");
  single.type = "button";
  single.className = "apply-one";
  single.textContent = msg("applyOne");
  single.addEventListener("click", () => applyEntries([entry]));
  tdApply.append(single);

  tr.append(tdCheck, tdCurrent, tdNew, tdApply);
  return tr;
}

// First rows paint immediately; the rest stream in per animation frame so a
// huge result set never blocks typing.
function renderPreview(searchOpts) {
  const token = ++renderToken;
  const tbody = $("previewRows");
  tbody.replaceChildren();
  const rows = previewEntries.map((entry) => makeRow(entry, searchOpts));
  let i = 0;
  const appendBatch = () => {
    if (token !== renderToken) return;
    const limit = i === 0 ? 300 : 600;
    const fragment = document.createDocumentFragment();
    const end = Math.min(rows.length, i + limit);
    for (; i < end; i++) fragment.append(rows[i]);
    tbody.append(fragment);
    if (i < rows.length) requestAnimationFrame(appendBatch);
  };
  appendBatch();
}

function clearPreview() {
  renderToken += 1;
  previewEntries = [];
  $("previewRows").replaceChildren();
  updateApplyButton();
}

function recompute() {
  $("formError").hidden = true;

  const find = $("find").value;
  if (!find) {
    $("summary").textContent = "";
    clearPreview();
    return;
  }

  const searchOpts = {
    find,
    replace: $("replace").value,
    regex: $("regex").checked,
    caseSensitive: $("caseSensitive").checked,
    wholeWord: $("wholeWord").checked,
  };

  let changes;
  try {
    changes = computeChanges(collectTargets(state.tree, scopeOptions()), {
      replacer: makeReplacer(searchOpts),
      mode: formState.mode,
      collapseWhitespace: formState.emojiPreset,
    });
  } catch (error) {
    $("formError").textContent = `${msg("invalidRegex")} ${error.message}`;
    $("formError").hidden = false;
    $("summary").textContent = "";
    clearPreview();
    return;
  }

  previewEntries = changes.map((change) => ({
    change,
    checked: change.problems.length === 0,
  }));
  renderPreview(searchOpts);

  const invalid = changes.filter((c) => c.problems.length).length;
  $("summary").textContent = changes.length
    ? msg("summary", [changes.length - invalid, invalid])
    : msg("noChanges");
  updateApplyButton();
}

function setMode(mode) {
  formState.mode = mode;
  clearApplyResult();
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  $("caseSensitive").checked = CASE_DEFAULTS[mode];
  $("foldersOption").hidden = mode !== "names";
  $("emojiPreset").hidden = mode !== "names";
  formState.emojiPreset = false;
  recompute();
}

function syncFormState() {
  formState.emojiPreset =
    $("regex").checked &&
    $("find").value === EMOJI_FIND_PATTERN &&
    $("replace").value === "";
  $("wholeWordOption").hidden = $("regex").checked;
}

function wireForm() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  }

  for (const id of ["find", "replace", "regex", "caseSensitive", "wholeWord", "includeFolders", "recursive"]) {
    const handler = () => {
      clearApplyResult();
      syncFormState();
      scheduleRecompute();
    };
    $(id).addEventListener("input", handler);
    $(id).addEventListener("change", handler);
  }

  $("emojiPreset").addEventListener("click", () => {
    clearApplyResult();
    if (formState.mode !== "names") setMode("names");
    $("regex").checked = true;
    $("find").value = EMOJI_FIND_PATTERN;
    $("replace").value = "";
    formState.emojiPreset = true;
    $("wholeWordOption").hidden = true;
    recompute();
  });

  $("selectAll").addEventListener("change", () => {
    const selectAll = $("selectAll").checked;
    for (const entry of previewEntries) {
      if (entry.change.problems.length === 0) {
        entry.checked = selectAll;
        if (entry.checkbox) entry.checkbox.checked = selectAll;
      }
    }
    updateApplyButton();
  });

  $("apply").addEventListener("click", () => {
    applyEntries(validEntries().filter((entry) => entry.checked));
  });

  for (const id of ["find", "replace"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
        clearTimeout(renderTimer);
        recompute();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (!$("apply").disabled) $("apply").click();
      }
    });
  }

  syncFormState();
}

// --- sidebar resize / toggle ---

const layout = $("layout");
const WIDTH_KEY = "bfr-s…dth";

const savedWidth = Number(localStorage.getItem(WIDTH_KEY));
if (savedWidth >= 160 && savedWidth <= 520) {
  layout.style.setProperty("--sidebar-width", `${savedWidth}px`);
}

let resizing = false;
$("resizer").addEventListener("pointerdown", (event) => {
  resizing = true;
  $("resizer").classList.add("dragging");
  $("resizer").setPointerCapture(event.pointerId);
  document.body.style.userSelect = "none";
});
$("resizer").addEventListener("pointermove", (event) => {
  if (!resizing) return;
  const width = Math.min(520, Math.max(160, event.clientX));
  layout.style.setProperty("--sidebar-width", `${width}px`);
});
$("resizer").addEventListener("pointerup", () => {
  if (!resizing) return;
  resizing = false;
  $("resizer").classList.remove("dragging");
  document.body.style.userSelect = "";
  localStorage.setItem(
    WIDTH_KEY,
    getComputedStyle(layout).getPropertyValue("--sidebar-width").replace("px", "").trim(),
  );
});

$("toggleSidebar").addEventListener("click", () => {
  layout.classList.toggle("sidebar-hidden");
});

// --- auto-refresh ---

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadBookmarks, 250);
}
for (const event of [
  browser.bookmarks.onCreated,
  browser.bookmarks.onRemoved,
  browser.bookmarks.onChanged,
  browser.bookmarks.onMoved,
]) {
  event.addListener(scheduleRefresh);
}

// --- wiring / startup ---

$("retry").addEventListener("click", loadBookmarks);
document.title = msg("extensionName");
localizeStaticText();
wireForm();
loadBookmarks();
