"""
Page Perception Sub-Agent.

Classifies the current (already-redacted) page state into a PageCategory
and identifies the focal interaction area. Built as a Google ADK ``Agent``
so it can be composed into the root workflow, but also exposes a plain
async function (``run``) that agent.py's orchestrator calls directly with
a shared genai client -- this keeps the module usable both inside a full
ADK `Runner` pipeline and in lightweight/manual orchestration.
"""

from __future__ import annotations

import json
import logging
from typing import List
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from google.genai.errors import ServerError

from shared_libraries.constants import MODEL_NAME
from shared_libraries.types import PagePerceptionResult, ScrapedElement
from sub_agents.page_perception.prompt import PAGE_PERCEPTION_SYSTEM_PROMPT

logger = logging.getLogger("page_perception")

try:
    from google.adk.agents import Agent as _ADKAgent
except ImportError:  # pragma: no cover - ADK optional at dev-time
    _ADKAgent = None


def _build_user_content(
    elements: List[ScrapedElement], redacted_image_b64: str | None, user_query: str | None
) -> str:
    elements_json = json.dumps([e.model_dump() for e in elements], default=str)
    return (
        f"user_query: {user_query or '(none)'}\n"
        f"has_redacted_image: {bool(redacted_image_b64)}\n"
        f"elements: {elements_json}"
    )


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type(ServerError),
    reraise=True
)
async def run(
    genai_client,
    elements: List[ScrapedElement],
    redacted_image_b64: str | None,
    user_query: str | None,
    preferred_language: str = "en-IN",
) -> PagePerceptionResult:
    """Invoke the page perception model call and parse a strict JSON result."""
    from shared_libraries.language_utils import build_language_system_suffix
    system_prompt = PAGE_PERCEPTION_SYSTEM_PROMPT + build_language_system_suffix(preferred_language)

    contents: list = []
    if redacted_image_b64:
        contents.append(
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": "image/jpeg", "data": redacted_image_b64}},
                    {"text": _build_user_content(elements, redacted_image_b64, user_query)},
                ],
            }
        )
    else:
        contents.append(
            {
                "role": "user",
                "parts": [
                    {"text": _build_user_content(elements, redacted_image_b64, user_query)},
                ],
            }
        )

    response = await genai_client.aio.models.generate_content(
        model=MODEL_NAME,
        contents=contents,
        config={
            "system_instruction": system_prompt,
            "response_mime_type": "application/json",
        },
    )

    raw_text = (response.text or "{}").strip()
    raw_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        parsed = json.loads(raw_text)
        return PagePerceptionResult(**parsed)
    except Exception:
        logger.exception("page_perception: failed to parse model output, falling back to UNKNOWN")
        return PagePerceptionResult(
            page_category="unknown",  # type: ignore[arg-type]
            focal_area_description="",
            interactable_field_ids=[],
            summary="Page perception could not confidently classify this page.",
        )


# --------------------------------------------------------------------------- #
# ADK Agent registration (used when running under a full ADK Runner)
# --------------------------------------------------------------------------- #
if _ADKAgent is not None:
    page_perception_agent = _ADKAgent(
        name="page_perception",
        model=MODEL_NAME,
        instruction=PAGE_PERCEPTION_SYSTEM_PROMPT,
        description=(
            "Classifies the sanitized page state into a page category "
            "(form/dashboard/table_data/article/ecommerce) and identifies "
            "the focal interaction area, using only redacted image + "
            "tokenized element data."
        ),
    )
else:  # pragma: no cover
    page_perception_agent = None
