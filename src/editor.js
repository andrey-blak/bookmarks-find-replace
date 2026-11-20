// UI layer: DOM wiring, rendering, apply/undo orchestration.
// All pure logic (patterns, scope walk, change computation) lives in lib/engine.js.
//
// Localization: Firefox does NOT substitute __MSG_...__ placeholders inside HTML
// pages (only manifest.json). Every localized node carries data-i18n="key" and is
// filled here from _locales; textContent only, never innerHTML.
import { engineReady } from "./lib/engine.js";

function localizeStaticText(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = browser.i18n.getMessage(el.dataset.i18n) || `‹${el.dataset.i18n}›`;
  }
}

localizeStaticText();
document.title = browser.i18n.getMessage("extensionName");

const status = document.getElementById("status");
status.textContent = engineReady
  ? `Scaffold OK — v${browser.runtime.getManifest().version}`
  : browser.i18n.getMessage("engineLoadFailed");
