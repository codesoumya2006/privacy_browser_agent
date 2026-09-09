/**
 * Content script injected on every page (document_idle).
 *
 * Responsibilities:
 *  - Watch the DOM for meaningful changes via a debounced MutationObserver
 *    and notify the side panel so it can decide whether to re-scan.
 *  - Respond to SCRAPE_PAGE by harvesting + tokenizing viewport elements
 *    (via domScraper.ts) and reporting pixel-space sensitive regions.
 *  - Respond to CAPTURE_AND_REDACT by redacting a raw screenshot data URL
 *    against those sensitive regions (canvas black-out).
 *  - Execute ActionCommands relayed from the side panel: click,
 *    type_tokenized (detokenizing locally right before dispatch),
 *    scroll, highlight.
 *  - Maintain a local 3-step undo stack for reversible actions.
 *
 * This content script owns the live `pseudonymizer` singleton for this
 * tab: it is the component that both scrapes/tokenizes text (via
 * domScraper.ts) AND detokenizes a surrogate token back to its raw value
 * immediately before dispatching a native input event. The side panel
 * only ever sees/forwards the surrogate token string (e.g. "<PERSON_1>")
 * -- it never has access to the real value, satisfying the "client
 * de-tokenizes locally right before dispatch" invariant.
 */

import { debounce } from "./utils/frameDiff";
import { scrapeViewport } from "./utils/domScraper";
import { pseudonymizer } from "./utils/pseudonymizer";
import { redactCanvas } from "./utils/edgeRedactor";

interface BoundingBoxNorm {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

type ContentScriptMessage =
  | { type: "SCRAPE_PAGE" }
  | {
      type: "CAPTURE_AND_REDACT";
      rawDataUrl: string;
      ocrRegions?: {
        x: number;
        y: number;
        width: number;
        height: number;
        reason?: string;
        coordinateSpace?: "image";
      }[];
    }
  | {
      type: "EXECUTE_ACTION";
      action: {
        action_type: "click" | "type_tokenized" | "scroll" | "highlight" | "extract" | "none";
        target_selector?: string | null;
        target_bbox?: BoundingBoxNorm | null;
        tokenized_value?: string | null; // surrogate token, e.g. "<PERSON_1>"
      };
    }
  | { type: "UNDO_LAST_ACTION" };

type UndoEntry = {
  element: HTMLInputElement | HTMLTextAreaElement;
  prevValue: string;
};

const undoStack: UndoEntry[] = [];
const MAX_UNDO_STEPS = 3;

// Cache of the most recent scrape's sensitive regions, so a subsequent
// CAPTURE_AND_REDACT call (which happens shortly after SCRAPE_PAGE, once
// the background worker has captured pixels) knows what to black out.
let lastSensitiveRegions: { x: number; y: number; width: number; height: number; reason?: string }[] = [];

// --------------------------------------------------------------------------- #
// DOM mutation observation (800ms debounce)
// --------------------------------------------------------------------------- #
const notifyPageChanged = debounce(() => {
  chrome.runtime.sendMessage({ type: "PAGE_MUTATION_DETECTED", url: location.href });
}, 800);

const observer = new MutationObserver((mutations) => {
  const meaningful = mutations.some(
    (m) => m.addedNodes.length > 0 || m.removedNodes.length > 0 || m.type === "attributes"
  );
  if (meaningful) notifyPageChanged();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["value", "class", "style", "aria-hidden"],
});

const notifyScroll = debounce(() => {
  chrome.runtime.sendMessage({ type: "PAGE_SCROLLED", url: location.href });
}, 800);
window.addEventListener("scroll", notifyScroll, { passive: true });

// --------------------------------------------------------------------------- #
// Element resolution
// --------------------------------------------------------------------------- #
function resolveTargetElement(
  selector?: string | null,
  bbox?: BoundingBoxNorm | null
): Element | null {
  if (selector) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  if (bbox) {
    const cx = ((bbox.xmin + bbox.xmax) / 2 / 1000) * window.innerWidth;
    const cy = ((bbox.ymin + bbox.ymax) / 2 / 1000) * window.innerHeight;
    const stack = document.elementsFromPoint(cx, cy);
    return stack.find((el) => !el.closest("#edge-vision-highlight-layer")) ?? null;
  }
  return null;
}

// --------------------------------------------------------------------------- #
// Event dispatch helpers (fires full pointer + keyboard sequences so React/
// Vue/Angular controlled inputs register the change)
// --------------------------------------------------------------------------- #
function dispatchClickSequence(el: Element): void {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };

  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function dispatchTypeSequence(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prevValue = el.value;

  el.focus();
  setNativeValue(el, value);

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  if (undoStack.length >= MAX_UNDO_STEPS) undoStack.shift();
  undoStack.push({ element: el, prevValue });
}

function dispatchScroll(el: Element): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// --------------------------------------------------------------------------- #
// Highlight overlay (floating SVG pulse ring)
// --------------------------------------------------------------------------- #
function ensureHighlightLayer(): HTMLDivElement {
  let layer = document.getElementById("edge-vision-highlight-layer") as HTMLDivElement | null;
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "edge-vision-highlight-layer";
    layer.style.position = "fixed";
    layer.style.top = "0";
    layer.style.left = "0";
    layer.style.width = "0";
    layer.style.height = "0";
    layer.style.zIndex = "2147483647";
    layer.style.pointerEvents = "none";
    document.documentElement.appendChild(layer);
  }
  return layer;
}

function highlightElement(el: Element): void {
  const rect = el.getBoundingClientRect();
  const layer = ensureHighlightLayer();

  const ring = document.createElement("div");
  ring.style.position = "fixed";
  ring.style.top = `${rect.top - 4}px`;
  ring.style.left = `${rect.left - 4}px`;
  ring.style.width = `${rect.width + 8}px`;
  ring.style.height = `${rect.height + 8}px`;
  ring.style.borderRadius = "10px";
  ring.style.outline = "3px solid #38bdf8";
  ring.style.boxShadow = "0 0 20px #38bdf8";
  ring.style.transition = "all 0.3s ease";
  ring.style.pointerEvents = "none";

  layer.appendChild(ring);
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  setTimeout(() => ring.remove(), 3000);
}

// --------------------------------------------------------------------------- #
// Undo
// --------------------------------------------------------------------------- #
function undoLastAction(): boolean {
  const entry = undoStack.pop();
  if (!entry) return false;
  setNativeValue(entry.element, entry.prevValue);
  entry.element.dispatchEvent(new Event("input", { bubbles: true }));
  entry.element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// --------------------------------------------------------------------------- #
// Message handling
// --------------------------------------------------------------------------- #
chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage, _sender, sendResponse) => {
    switch (message.type) {
      case "SCRAPE_PAGE": {
        const { elements, sensitiveRegions } = scrapeViewport();
        lastSensitiveRegions = sensitiveRegions;
        sendResponse({
          ok: true,
          elements,
          sensitiveRegionCount: sensitiveRegions.length,
          maskedEntityCount: pseudonymizer.maskedEntityCount(),
          url: location.href,
          title: document.title,
        });
        return true;
      }

      case "CAPTURE_AND_REDACT": {
        const regions = [...lastSensitiveRegions, ...(message.ocrRegions ?? [])];
        redactCanvas(message.rawDataUrl, regions, window.innerWidth, window.innerHeight)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
        return true; // async
      }

      case "UNDO_LAST_ACTION": {
        sendResponse({ ok: undoLastAction() });
        return true;
      }

      case "EXECUTE_ACTION": {
        const { action } = message;
        const target = resolveTargetElement(action.target_selector, action.target_bbox);

        if (!target && action.action_type !== "none") {
          sendResponse({ ok: false, error: "Target element could not be resolved on the live page." });
          return true;
        }

        try {
          switch (action.action_type) {
            case "click":
              dispatchClickSequence(target as Element);
              sendResponse({ ok: true });
              break;

            case "type_tokenized": {
              const inputEl = target as HTMLInputElement | HTMLTextAreaElement;
              if (!(inputEl instanceof HTMLInputElement) && !(inputEl instanceof HTMLTextAreaElement)) {
                sendResponse({ ok: false, error: "Target is not a text input." });
                break;
              }
              // Detokenize locally, using this tab's own pseudonymizer
              // instance (the same one that produced the token during
              // SCRAPE_PAGE) -- the raw value never left this context.
              const rawValue = pseudonymizer.detokenize(action.tokenized_value ?? "");
              dispatchTypeSequence(inputEl, rawValue);
              sendResponse({ ok: true });
              break;
            }

            case "scroll":
              dispatchScroll(target as Element);
              sendResponse({ ok: true });
              break;

            case "highlight":
              highlightElement(target as Element);
              sendResponse({ ok: true });
              break;

            default:
              sendResponse({ ok: true, noop: true });
          }
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return true;
      }

      default:
        return false;
    }
  }
);
