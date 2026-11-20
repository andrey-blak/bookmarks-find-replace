// UI layer: DOM wiring and rendering. Pure logic lives in lib/engine.js.
//
// Localization: Firefox does not substitute __MSG_...__ inside HTML pages, so
// every localized node carries data-i18n / data-i18n-title and is filled from
// _locales here. Bookmark-derived text goes through textContent only — never
// innerHTML.

const $ = (id) => document.getElementById(id);

const state = {
  tree: [],
  scopeId: null,        // null = All bookmarks
  expanded: new Set(),
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

// Kept for evaluation; state intentionally not persisted yet.
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
loadBookmarks();
