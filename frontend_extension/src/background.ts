/**
 * Background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Open the side panel when the toolbar action is clicked.
 *  - Own `chrome.tabs.captureVisibleTab` (only the background/service-worker
 *    context has permission to capture pixels) and relay raw captures to
 *    the side panel via message passing. The raw capture is handed off
 *    in-memory only -- never written to chrome.storage.
 *  - Track the active tab so the side panel knows which tab's content
 *    script to talk to.
 */

const capturedTabState = new Map<number, { url: string; lastCaptureAt: number }>();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.error("[background] failed to set side panel behavior", err);
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined || tab.windowId === undefined) return;
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

type BackgroundMessage =
  | { type: "CAPTURE_VISIBLE_TAB"; tabId: number }
  | { type: "GET_ACTIVE_TAB" }
  | { type: "FORWARD_TO_CONTENT_SCRIPT"; tabId: number; payload: unknown };

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "CAPTURE_VISIBLE_TAB": {
      chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: "jpeg", quality: 70 }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message ?? "capture failed" });
          return;
        }
        capturedTabState.set(message.tabId, { url: dataUrl, lastCaptureAt: Date.now() });
        // dataUrl is forwarded once to the requesting side-panel context and
        // is not retained beyond this map entry, which is overwritten on
        // every subsequent capture (no history is accumulated).
        sendResponse({ ok: true, dataUrl });
      });
      return true; // keep the message channel open for the async response
    }

    case "GET_ACTIVE_TAB": {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        sendResponse({
          ok: true,
          tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
        });
      });
      return true;
    }

    case "FORWARD_TO_CONTENT_SCRIPT": {
      chrome.tabs.sendMessage(message.tabId, message.payload, (response) => {
        sendResponse(response);
      });
      return true;
    }

    default:
      return false;
  }
});

// Clean up captured state when a tab is closed, so nothing lingers in
// memory longer than the tab it came from.
chrome.tabs.onRemoved.addListener((tabId) => {
  capturedTabState.delete(tabId);
});
