/**
 * Typed client for the FastAPI backend's /api/v1/interact endpoint.
 * Mirrors shared_libraries/types.py on the backend.
 */

import { INTERACT_ENDPOINT } from "../config";
import type { ScrapedElement } from "../utils/domScraper";

export interface BoundingBoxNorm {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface SanitizedPageState {
  session_id: string;
  url: string;
  title: string;
  user_query: string | null;
  elements: ScrapedElement[];
  redacted_image_b64: string | null;
  timestamp: number;
  preferred_language: string;
}

export type ActionType = "click" | "type_tokenized" | "scroll" | "highlight" | "extract" | "none";

export interface ActionCommand {
  action_type: ActionType;
  target_selector: string | null;
  target_bbox: BoundingBoxNorm | null;
  tokenized_value: string | null;
  speech_guidance: string;
  requires_confirmation: boolean;
  confidence: number;
  extracted_data: Record<string, unknown> | null;
}

export interface InteractResponse {
  session_id: string;
  page_category: string;
  action: ActionCommand;
  reasoning_trace_id: string | null;
}

export class BackendError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "BackendError";
  }
}

export async function callInteract(state: SanitizedPageState): Promise<InteractResponse> {
  const response = await fetch(INTERACT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body?.detail ?? detail;
    } catch {
      /* response body wasn't JSON */
    }
    throw new BackendError(detail, response.status);
  }

  return (await response.json()) as InteractResponse;
}
