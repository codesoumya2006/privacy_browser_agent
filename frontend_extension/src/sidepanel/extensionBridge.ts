/**
 * Thin messaging bridge used by the side panel to talk to the background
 * service worker (for tab capture) and the active tab's content script
 * (for scraping, redaction, and action execution). Centralizing this here
 * keeps App.tsx free of raw chrome.* plumbing and typed message shapes.
 */

import type { ScrapedElement } from "../utils/domScraper";
import { LOCAL_OCR_ENDPOINT } from "../config";

export interface ActiveTabInfo {
  id: number;
  url: string;
  title: string;
}

export async function getActiveTab(): Promise<ActiveTabInfo | null> {
  const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (!response?.ok || !response.tab?.id) return null;
  return { id: response.tab.id, url: response.tab.url ?? "", title: response.tab.title ?? "" };
}

export interface ScrapePageResult {
  ok: boolean;
  elements: ScrapedElement[];
  sensitiveRegionCount: number;
  maskedEntityCount: number;
  url: string;
  title: string;
  error?: string;
}

function isMissingReceiverError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /receiving end does not exist|could not establish connection|message port closed/i.test(text);
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/contentScript.js"],
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(
      `This page cannot be accessed by the extension. Refresh a normal http/https page and try again. (${text})`
    );
  }
}

async function sendToContentScript<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;

    // Tabs that were already open when the extension was loaded do not receive
    // manifest content scripts retroactively. Inject it once, then retry.
    await injectContentScript(tabId);
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    } catch (retryError) {
      if (isMissingReceiverError(retryError)) {
        throw new Error("The page content script did not start. Refresh the webpage and reload the extension.");
      }
      throw retryError;
    }
  }
}

export async function scrapeActivePage(tabId: number): Promise<ScrapePageResult> {
  return await sendToContentScript<ScrapePageResult>(tabId, { type: "SCRAPE_PAGE" });
}

export interface CaptureAndRedactResult {
  ok: boolean;
  redactedImageB64?: string;
  regionsRedacted?: number;
  error?: string;
}

async function detectLocalOCRRegions(rawDataUrl: string): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string;
  coordinateSpace?: "image";
}[]> {
  try {
    const response = await fetch(LOCAL_OCR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_b64: rawDataUrl.split(",")[1] ?? rawDataUrl }),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      regions?: { x: number; y: number; width: number; height: number; reason?: string }[];
    };
    return Array.isArray(body.regions)
      ? body.regions.map((region) => ({ ...region, coordinateSpace: "image" as const }))
      : [];
  } catch {
    // Local OCR is an enhancement; DOM redaction must continue if unavailable.
    return [];
  }
}

/** Captures the visible tab via the background worker, then asks the
 * content script (which knows the current sensitive regions from the most
 * recent scrape) to redact it. The raw dataUrl is held only transiently in
 * these two message payloads and is never written to disk or storage. */
export async function captureAndRedactActiveTab(tabId: number): Promise<CaptureAndRedactResult> {
  const captureResponse = await chrome.runtime.sendMessage({
    type: "CAPTURE_VISIBLE_TAB",
    tabId,
  });
  if (!captureResponse?.ok || !captureResponse.dataUrl) {
    return { ok: false, error: captureResponse?.error ?? "Screen capture failed." };
  }

  const ocrRegions = await detectLocalOCRRegions(captureResponse.dataUrl);

  const redactResponse = await sendToContentScript<{
    ok: boolean;
    redactedImageB64?: string;
    regionsRedacted?: number;
    error?: string;
  }>(tabId, {
    type: "CAPTURE_AND_REDACT",
    rawDataUrl: captureResponse.dataUrl,
    ocrRegions,
  });

  if (!redactResponse?.ok) {
    return { ok: false, error: redactResponse?.error ?? "Redaction failed." };
  }

  return {
    ok: true,
    redactedImageB64: redactResponse.redactedImageB64,
    regionsRedacted: redactResponse.regionsRedacted,
  };
}

export interface ExecuteActionPayload {
  action_type: "click" | "type_tokenized" | "scroll" | "highlight" | "extract" | "none";
  target_selector?: string | null;
  target_bbox?: { ymin: number; xmin: number; ymax: number; xmax: number } | null;
  tokenized_value?: string | null;
}

export async function executeActionOnTab(
  tabId: number,
  action: ExecuteActionPayload
): Promise<{ ok: boolean; error?: string }> {
  return await sendToContentScript<{ ok: boolean; error?: string }>(tabId, {
    type: "EXECUTE_ACTION",
    action,
  });
}

export async function undoLastActionOnTab(tabId: number): Promise<{ ok: boolean }> {
  return await sendToContentScript<{ ok: boolean }>(tabId, { type: "UNDO_LAST_ACTION" });
}

/** Subscribes to passive page-change notifications from the content
 * script (debounced mutation/scroll events). Returns an unsubscribe fn. */
export function onPageChanged(callback: () => void): () => void {
  const listener = (message: { type: string }) => {
    if (message.type === "PAGE_MUTATION_DETECTED" || message.type === "PAGE_SCROLLED") {
      callback();
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
