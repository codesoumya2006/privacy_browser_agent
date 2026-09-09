"""
Navigation Planning Sub-Agent.

Formulates the single next ActionCommand (click / type_tokenized / scroll /
highlight / extract / none) given the current sanitized page state, the
user's query, and recent session memory. Deliberately produces ONE step at
a time rather than a full plan, so that action_safety and the extension's
execution layer can validate/confirm/execute before any further planning.
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional

from shared_libraries.constants import MODEL_NAME
from shared_libraries.types import ActionCommand, PageCategory, ScrapedElement
from sub_agents.navigation_planning.prompt import NAVIGATION_PLANNING_SYSTEM_PROMPT
from tools.state_memory import TurnRecord

logger = logging.getLogger("navigation_planning")

try:
    from google.adk.agents import Agent as _ADKAgent
except ImportError:  # pragma: no cover
    _ADKAgent = None


def _history_to_text(history: List[TurnRecord]) -> str:
    if not history:
        return "(no prior turns this session)"
    lines = []
    for turn in history:
        lines.append(
            f"- action={turn.action.action_type} selector={turn.executed_selector} "
            f"page={turn.page_category}"
        )
    return "\n".join(lines)


async def run(
    genai_client,
    elements: List[ScrapedElement],
    page_category: PageCategory,
    user_query: Optional[str],
    history: List[TurnRecord],
) -> ActionCommand:
    payload = {
        "user_query": user_query or "",
        "page_category": page_category.value if hasattr(page_category, "value") else page_category,
        "elements": [e.model_dump() for e in elements],
        "recent_history": _history_to_text(history),
    }

    response = await genai_client.aio.models.generate_content(
        model=MODEL_NAME,
        contents=[{"role": "user", "parts": [{"text": json.dumps(payload, default=str)}]}],
        config={
            "system_instruction": NAVIGATION_PLANNING_SYSTEM_PROMPT,
            "response_mime_type": "application/json",
        },
    )

    raw_text = (response.text or "{}").strip()
    raw_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    try:
        parsed = json.loads(raw_text)
        return ActionCommand(**parsed)
    except Exception:
        logger.exception("navigation_planning: failed to parse/validate model output")
        return ActionCommand(
            action_type="none",  # type: ignore[arg-type]
            speech_guidance="I wasn't able to determine a safe next step. Could you clarify?",
            requires_confirmation=False,
            confidence=0.0,
        )


if _ADKAgent is not None:
    navigation_planning_agent = _ADKAgent(
        name="navigation_planning",
        model=MODEL_NAME,
        instruction=NAVIGATION_PLANNING_SYSTEM_PROMPT,
        description=(
            "Plans the single immediate next ActionCommand (click, "
            "type_tokenized, scroll, highlight, extract, or none) to "
            "advance the user's actionable goal on the current page."
        ),
    )
else:  # pragma: no cover
    navigation_planning_agent = None
