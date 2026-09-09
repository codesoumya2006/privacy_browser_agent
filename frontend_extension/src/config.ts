/**
 * Runtime configuration. In a production build this would be injected at
 * build time or read from chrome.storage (a settings screen), but a plain
 * constant keeps local development simple. Point this at your running
 * `uvicorn agent:app` instance.
 */
export const BACKEND_BASE_URL = "http://localhost:8000";
export const INTERACT_ENDPOINT = `${BACKEND_BASE_URL}/api/v1/interact`;
export const LOCAL_OCR_ENDPOINT = `${BACKEND_BASE_URL}/api/v1/local-ocr`;
export const HEALTH_ENDPOINT = `${BACKEND_BASE_URL}/health`;
