"""
Action Safety & Policy Gate Sub-Agent.

This is the final checkpoint before an ActionCommand leaves the backend.
It is implemented as a deterministic, regex/allowlist-based gate (fast,
auditable, cannot be talked out of its policy by prompt injection in page
content) rather than a second LLM call in the hot path. An optional LLM
escalation path (`run_llm_review`) is provided for ambiguous cases but the
deterministic `enforce` function is what agent.py's orchestrator calls by
default.
"""

from __future__ import annotations

import logging
from typing import List, Optional

from shared_libraries.constants import (
    ALLOWED_ACTIONS,
    CRITICAL_ACTION_PATTERN,
    MODEL_NAME,
)
from shared_libraries.types import ActionCommand, ScrapedElement
from sub_agents.action_safety.prompt import ACTION_SAFETY_SYSTEM_PROMPT

logger = logging.getLogger("action_safety")

try:
    from google.adk.agents import Agent as _ADKAgent
except ImportError:  # pragma: no cover
    _ADKAgent = None


def _target_element_text(
    action: ActionCommand, elements: List[ScrapedElement]
) -> str:
    """Gather every string associated with the action's target for keyword scanning."""
    fragments: List[str] = [action.speech_guidance or ""]

    if action.target_selector:
        for el in elements:
            if el.selector == action.target_selector or el.id == action.target_selector:
                fragments.extend(
                    filter(
                        None,
                        [el.text, el.role, el.tag, el.placeholder, el.aria_label, el.id],
                    )
                )
                break

    return " ".join(fragments)


def enforce(action: ActionCommand, elements: List[ScrapedElement]) -> ActionCommand:
    """
    Deterministic policy gate. Always returns a NEW ActionCommand (never
    mutates the input) with `requires_confirmation` corrected, and rejects
    unknown action types outright by downgrading them to "none".
    """
    if action.action_type not in ALLOWED_ACTIONS and str(action.action_type) not in ALLOWED_ACTIONS:
        logger.warning("action_safety: rejected unknown action_type=%s", action.action_type)
        return action.model_copy(
            update={
                "action_type": "none",
                "requires_confirmation": False,
                "speech_guidance": "That action isn't permitted by policy.",
                "confidence": 0.0,
            }
        )

    # extract / none never touch the live page -> never need confirmation.
    if action.action_type in ("extract", "none"):
        if action.requires_confirmation:
            action = action.model_copy(update={"requires_confirmation": False})
        return action

    combined_text = _target_element_text(action, elements)
    is_critical = bool(CRITICAL_ACTION_PATTERN.search(combined_text))

    if is_critical and not action.requires_confirmation:
        logger.info(
            "action_safety: escalating action_type=%s to requires_confirmation=True "
            "(matched critical keyword)",
            action.action_type,
        )
        return action.model_copy(update={"requires_confirmation": True})

    return action


# --------------------------------------------------------------------------- #
# Optional LLM-backed secondary review for ambiguous cases (not on hot path
# by default -- wire in from agent.py if extra scrutiny is desired).
# --------------------------------------------------------------------------- #
async def run_llm_review(
    genai_client, action: ActionCommand, elements: List[ScrapedElement]
) -> ActionCommand:
    import json

    payload = {
        "proposed_action": action.model_dump(),
        "target_context": _target_element_text(action, elements),
    }
    response = await genai_client.aio.models.generate_content(
        model=MODEL_NAME,
        contents=[{"role": "user", "parts": [{"text": json.dumps(payload, default=str)}]}],
        config={
            "system_instruction": ACTION_SAFETY_SYSTEM_PROMPT,
            "response_mime_type": "application/json",
        },
    )
    raw_text = (response.text or "{}").strip()
    raw_text = raw_text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(raw_text)
        return ActionCommand(**parsed)
    except Exception:
        logger.exception("action_safety: LLM review failed to parse, keeping deterministic result")
        return enforce(action, elements)


if _ADKAgent is not None:
    action_safety_agent = _ADKAgent(
        name="action_safety",
        model=MODEL_NAME,
        instruction=ACTION_SAFETY_SYSTEM_PROMPT,
        description=(
            "Final policy gate: validates action_type against the "
            "allowlist and forces requires_confirmation=true for any "
            "irreversible/high-risk target."
        ),
    )
else:  # pragma: no cover
    action_safety_agent = None
