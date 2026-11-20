"use strict";

// Open the editor tab on toolbar click; focus it if already open.
const EDITOR_URL = browser.runtime.getURL("editor.html");

browser.action.onClicked.addListener(async () => {
  const tabs = await browser.tabs.query({ url: EDITOR_URL });
  if (tabs.length > 0) {
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: EDITOR_URL });
  }
});
