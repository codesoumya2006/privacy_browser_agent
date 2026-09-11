"""
Google ADK Root Workflow Orchestrator & FastAPI Server.

Pipeline:
  State Ingest -> RedactionAuditTool -> PagePerception -> Router
    -> [DataExtraction | NavigationPlanning] -> ActionSafety -> Output

Exposes:
  POST /api/v1/interact  - ingest SanitizedPageState, run pipeline, return ActionCommand
  GET  /health            - service + model readiness

Run locally with:
  uvicorn agent:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager

from google import genai
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from prompt import ROOT_ORCHESTRATOR_PROMPT  # noqa: F401  (bound to root agent below)
from shared_libraries.constants import MODEL_NAME
from shared_libraries.types import (
    ActionCommand,
    HealthResponse,
    InteractResponse,
    PageCategory,
    PagePerceptionResult,
    SanitizedPageState,
)
from sub_agents.action_safety.agent import enforce as action_safety_enforce
from sub_agents.data_extraction.agent import run as data_extraction_run
from sub_agents.navigation_planning.agent import run as navigation_planning_run
from sub_agents.page_perception.agent import run as page_perception_run
from tools.redaction_verifier import (
    SecurityRedactionException,
    audit_sanitized_page_state,
)
from tools.state_memory import state_memory_store
from tools.local_ocr import detect_sensitive_regions
from tracing import init_tracing, traced_span

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("agent")

_genai_client = None
_model_ready = False


class LocalOCRRequest(BaseModel):
    image_b64: str


def _init_gemini_client():
    """Initialize Google Gemini using GEMINI_API_KEY from the environment."""
    global _genai_client, _model_ready
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.warning(
            "No GEMINI_API_KEY set; server will start but "
            "/api/v1/interact will fail until a key is configured."
        )
        _genai_client = None
        _model_ready = False
        return
    _genai_client = genai.Client(api_key=api_key)
    _model_ready = True
    logger.info("Gemini client initialized (model=%s)", MODEL_NAME)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_tracing()
    _init_gemini_client()
    yield
    logger.info("shutting down; active sessions=%d", state_memory_store.active_session_count())


app = FastAPI(
    title="Edge-Redacted Vision & Web Navigation Assistant",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome extension origins (chrome-extension://<id>) vary per install
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_informational_query(user_query: str | None, page_category: PageCategory) -> bool:
    """Heuristic router: read-only phrasing or an article page -> data_extraction."""
    if page_category == PageCategory.ARTICLE:
        return True
    if not user_query:
        return False
    informational_markers = (
        "what",
        "how much",
        "show me",
        "summarize",
        "explain",
        "read",
        "tell me",
        "which",
        "who",
    )
    lowered = user_query.strip().lower()
    return any(lowered.startswith(marker) for marker in informational_markers)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_ready=_model_ready,
        version=app.version,
    )


@app.post("/api/v1/local-ocr")
async def local_ocr(request: LocalOCRRequest) -> dict:
    """Return local OCR sensitive boxes; OCR text never leaves this process."""
    try:
        return {"available": True, "regions": detect_sensitive_regions(request.image_b64)}
    except ImportError:
        logger.warning("RapidOCR is not installed; continuing with DOM-only redaction")
        return {"available": False, "regions": []}
    except Exception:
        logger.exception("local OCR failed; continuing with DOM-only redaction")
        return {"available": False, "regions": []}


@app.post("/api/v1/interact", response_model=InteractResponse)
async def interact(state: SanitizedPageState) -> InteractResponse:
    trace_id = str(uuid.uuid4())

    with traced_span(
        "interact.request",
        session_id=state.session_id,
        element_count=len(state.elements),
        has_image=bool(state.redacted_image_b64),
        trace_id=trace_id,
    ):
        # ---- 1. Fail-safe redaction audit -------------------------------- #
        try:
            with traced_span("tool.redaction_audit"):
                audit_sanitized_page_state(state)
        except SecurityRedactionException as exc:
            logger.error("interact: redaction audit failed for session=%s", state.session_id)
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if _genai_client is None:
            raise HTTPException(
                status_code=503,
                detail="Model backend not configured. Set GEMINI_API_KEY and restart.",
            )

        # ---- 2. Page perception -------------------------------------------#
        try:
            with traced_span("agent.page_perception"):
                perception: PagePerceptionResult = await page_perception_run(
                    _genai_client,
                    state.elements,
                    state.redacted_image_b64,
                    state.user_query,
                )
        except Exception as exc:
            logger.exception("page perception model call failed")
            raise HTTPException(status_code=502, detail=f"Model request failed: {exc}") from exc

        # ---- 3. Route: informational vs actionable ------------------------#
        history = state_memory_store.get_recent_history(state.session_id)
        informational = _is_informational_query(state.user_query, perception.page_category)

        if informational:
            with traced_span("agent.data_extraction"):
                extraction = await data_extraction_run(
                    _genai_client,
                    state.elements,
                    perception.page_category,
                    state.user_query,
                )
            action = ActionCommand(
                action_type="extract",
                speech_guidance=extraction.get("answer_summary", ""),
                requires_confirmation=False,
                confidence=1.0,
                extracted_data=extraction.get("structured_data") or {},
            )
        else:
            with traced_span("agent.navigation_planning"):
                action = await navigation_planning_run(
                    _genai_client,
                    state.elements,
                    perception.page_category,
                    state.user_query,
                    history,
                )

        # ---- 4. Action safety gate (mandatory, deterministic) -------------#
        with traced_span("agent.action_safety"):
            action = action_safety_enforce(action, state.elements)

        # ---- 5. Persist turn to session memory -----------------------------#
        state_memory_store.record_turn(
            session_id=state.session_id,
            page_category=perception.page_category,
            action=action,
            url=state.url,
            extracted_schema=action.extracted_data,
        )

        return InteractResponse(
            session_id=state.session_id,
            page_category=perception.page_category,
            action=action,
            reasoning_trace_id=trace_id,
        )


@app.delete("/api/v1/session/{session_id}")
async def clear_session(session_id: str) -> dict:
    state_memory_store.clear_session(session_id)
    return {"cleared": True, "session_id": session_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("agent:app", host="0.0.0.0", port=8000, reload=True)
