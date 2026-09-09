/**
 * DOM scraper: harvests coordinates, labels, roles, and input state for
 * every interactable/informational element in the current viewport, and
 * classifies which regions are visually sensitive (so edgeRedactor.ts can
 * black them out on the canvas capture).
 */

import { redactText } from "./edgeRedactor";
import type { SensitiveRegion } from "./edgeRedactor";

export interface ScrapedElement {
  id: string;
  tag: string;
  role: string;
  text: string;
  bbox: { ymin: number; xmin: number; ymax: number; xmax: number }; // normalized 0-1000
  is_interactable: boolean;
  selector?: string;
  input_type?: string;
  placeholder?: string;
  aria_label?: string;
}

const INTERACTABLE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"], [tabindex]';

const SENSITIVE_INPUT_TYPES = new Set(["password", "tel", "email"]);

/** Best-effort unique CSS selector for a live DOM node. */
function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 5) {
    let selector = node.tagName.toLowerCase();
    if (node.classList.length > 0) {
      selector += "." + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
    }
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    node = node.parentElement;
    depth++;
  }
  return parts.join(" > ");
}

function toNormalizedBbox(rect: DOMRect, viewportW: number, viewportH: number) {
  return {
    xmin: Math.max(0, Math.round((rect.left / viewportW) * 1000)),
    ymin: Math.max(0, Math.round((rect.top / viewportH) * 1000)),
    xmax: Math.min(1000, Math.round((rect.right / viewportW) * 1000)),
    ymax: Math.min(1000, Math.round((rect.bottom / viewportH) * 1000)),
  };
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
    return false;
  }
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function elementText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Never scrape live password contents even redacted-in-place; report
    // presence only.
    if (el.type === "password") return el.value ? "••••••••" : "";
    return el.value ?? "";
  }
  return (el.textContent ?? "").trim().slice(0, 300);
}

function hasDirectText(el: Element): boolean {
  return Array.from(el.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
  );
}

function associatedLabelText(el: Element): string {
  const id = el.getAttribute("id");
  const labels = id ? Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)) : [];
  const parentLabel = el.closest("label");
  if (parentLabel) labels.push(parentLabel);
  return labels.map((label) => label.textContent ?? "").join(" ");
}

export interface ScrapeResult {
  elements: ScrapedElement[];
  sensitiveRegions: SensitiveRegion[]; // pixel-space, for canvas redaction
}

let idCounter = 0;

/**
 * Walks the visible viewport DOM and returns:
 *  - a redacted (tokenized-text) ScrapedElement[] ready for transmission
 *  - a list of pixel-space sensitive regions for the canvas redactor
 *
 * All PII masking happens INSIDE this function, before anything is
 * returned to the caller -- callers never see raw text.
 */
export function scrapeViewport(): ScrapeResult {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const elements: ScrapedElement[] = [];
  const sensitiveRegions: SensitiveRegion[] = [];

  const candidates = document.querySelectorAll(INTERACTABLE_SELECTOR);
  const seen = new Set<Element>();

  const registerElement = (el: Element, interactable: boolean) => {
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    const rawText = elementText(el);
    const maskedText = redactText(rawText);

    const inputType =
      el instanceof HTMLInputElement ? el.type : undefined;
    const placeholder =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.placeholder || undefined
        : undefined;
    const ariaLabel = el.getAttribute("aria-label") || undefined;
    const autocomplete = el.getAttribute("autocomplete") || "";
    const fieldMetadata = [
      rawText,
      placeholder ?? "",
      ariaLabel ?? "",
      el.getAttribute("name") ?? "",
      autocomplete,
      associatedLabelText(el),
    ].join(" ");
    const metadataHasSensitiveLabel = /password|email|e-mail|phone|mobile|tel|name|address|dob|birth|account|card|aadhaar|pan|ifsc|ssn|passport/i.test(
      fieldMetadata
    );

    const isSensitiveField =
      (inputType && SENSITIVE_INPUT_TYPES.has(inputType)) ||
      maskedText !== rawText ||
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && metadataHasSensitiveLabel;

    if (isSensitiveField) {
      sensitiveRegions.push({
        x: (rect.left / viewportW) * 1000,
        y: (rect.top / viewportH) * 1000,
        width: (rect.width / viewportW) * 1000,
        height: (rect.height / viewportH) * 1000,
        reason: inputType && SENSITIVE_INPUT_TYPES.has(inputType) ? inputType : "sensitive_text",
        coordinateSpace: "normalized",
      });
    }

    elements.push({
      id: `el_${idCounter++}`,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || (interactable ? "interactive" : "text"),
      text: maskedText,
      bbox: toNormalizedBbox(rect, viewportW, viewportH),
      is_interactable: interactable,
      selector: buildSelector(el),
      input_type: inputType,
      placeholder: placeholder ? redactText(placeholder) : undefined,
      aria_label: ariaLabel ? redactText(ariaLabel) : undefined,
    });
  };

  candidates.forEach((el) => registerElement(el, true));

  // Scan visible non-interactive text only when the precise tokenizer finds
  // PII. This catches emails and labeled names in cards/tables without
  // forwarding every heading or paragraph as an element.
  document.querySelectorAll("body *").forEach((el) => {
    if (!isVisible(el) || !(el.children.length === 0 || hasDirectText(el))) return;
    const rawText = elementText(el);
    if (rawText && redactText(rawText) !== rawText) registerElement(el, false);
  });

  // Also register images that look like avatars/photos/signatures so the
  // canvas redactor can black them out even though they carry no text.
  document.querySelectorAll("img").forEach((img) => {
    if (!isVisible(img)) return;
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    const looksLikeIdentityPhoto =
      alt.includes("photo") ||
      alt.includes("avatar") ||
      alt.includes("signature") ||
      alt.includes("profile");
    if (looksLikeIdentityPhoto) {
      const rect = img.getBoundingClientRect();
      sensitiveRegions.push({
        x: (rect.left / viewportW) * 1000,
        y: (rect.top / viewportH) * 1000,
        width: (rect.width / viewportW) * 1000,
        height: (rect.height / viewportH) * 1000,
        reason: alt.includes("signature") ? "signature" : "face",
        coordinateSpace: "normalized",
      });
    }
  });

  return { elements, sensitiveRegions };
}

export function resetIdCounter(): void {
  idCounter = 0;
}
