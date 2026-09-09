"""
Data Extraction Sub-Agent.

Handles informational (read-only) requests: scraping tabular data, metrics,
and summaries out of the sanitized element list into structured JSON.
Never produces an ActionCommand itself -- the router wraps its output into
an ActionCommand(action_type=EXTRACT) after the fact.
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional

from shared_libraries.constants import MODEL_NAME
from shared_libraries.types import PageCategory, ScrapedElement
from sub_agents.data_extraction.prompt import DATA_EXTRACTION_SYSTEM_PROMPT

logger = logging.getLogger("data_extraction")

try:
    from google.adk.agents import Agent as _ADKAgent
except ImportError:  # pragma: no cover
    _ADKAgent = None


async def run(
    genai_client,
    elements: List[ScrapedElement],
    page_category: PageCategory,
    user_query: Optional[str],
) -> dict:
    """Returns a dict with keys: answer_summary, structured_data, source_element_ids."""
    payload = {
        "page_category": page_category.value if hasattr(page_category, "value") else page_category,
        "user_query": user_query or "",
        "elements": [e.model_dump() for e in elements],
    }

    response = await genai_client.aio.models.generate_content(
        model=MODEL_NAME,
        contents=[{"role": "user", "parts": [{"text": json.dumps(payload, default=str)}]}],
        config={
            "system_instruction": DATA_EXTRACTION_SYSTEM_PROMPT,
            "response_mime_type": "application/json",
        },
    )

    raw_text = (response.text or "{}").strip()
    raw_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        return json.loads(raw_text)
    except Exception:
        logger.exception("data_extraction: failed to parse model output")
        return {
            "answer_summary": "I couldn't confidently extract that information from the page.",
            "structured_data": {},
            "source_element_ids": [],
        }


if _ADKAgent is not None:
    data_extraction_agent = _ADKAgent(
        name="data_extraction",
        model=MODEL_NAME,
        instruction=DATA_EXTRACTION_SYSTEM_PROMPT,
        description=(
            "Extracts structured JSON (tables, prices, rows, direct answers) "
            "from the sanitized element list for read-only user queries."
        ),
    )
else:  # pragma: no cover
    data_extraction_agent = None
