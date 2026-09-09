"""
Server-side fail-safe auditing tool.

Client-side redaction (canvas black-out + pseudonymizer) is the primary
line of defense. This module is the *second* line of defense: it re-scans
every string that reaches the backend and refuses to let the ADK pipeline
touch anything that still contains an unmasked PII pattern.

Exposed as an ADK-compliant Tool (``RedactionAuditTool``) so it can be
wired directly into the root workflow's pre-processing step in agent.py.
"""

from __future__ import annotations

import logging
from typing import List

from shared_libraries.constants import PII_PATTERNS
from shared_libraries.types import SanitizedPageState

logger = logging.getLogger("redaction_verifier")


class SecurityRedactionException(Exception):
    """Raised when raw PII is detected in a payload that claims to be sanitized."""

    def __init__(self, violations: List[str]):
        self.violations = violations
        message = (
            "RedactionAuditTool aborted processing: "
            f"{len(violations)} unredacted PII pattern(s) detected in payload. "
            "Pipeline halted before any LLM saw the data."
        )
        super().__init__(message)


def _scan_string(field_path: str, value: str, violations: List[str]) -> None:
    if not value:
        return
    # A value that already matches the surrogate-token allowlist is fine.
    if PII_PATTERNS["surrogate_token"].match(value.strip()):
        return
    for pattern_name, pattern in PII_PATTERNS.items():
        if pattern_name == "surrogate_token":
            continue
        if pattern.search(value):
            violations.append(f"{field_path}: matched '{pattern_name}'")


def audit_sanitized_page_state(state: SanitizedPageState) -> None:
    """
    Raises ``SecurityRedactionException`` if any unredacted PII is found.
    Call this BEFORE the payload is handed to page_perception or any other
    sub-agent / LLM call.
    """
    violations: List[str] = []

    _scan_string("title", state.title, violations)
    if state.user_query:
        _scan_string("user_query", state.user_query, violations)

    for el in state.elements:
        _scan_string(f"elements[{el.id}].text", el.text, violations)
        if el.placeholder:
            _scan_string(f"elements[{el.id}].placeholder", el.placeholder, violations)
        if el.aria_label:
            _scan_string(f"elements[{el.id}].aria_label", el.aria_label, violations)

    if violations:
        logger.error("RedactionAuditTool: %d violation(s) found", len(violations))
        raise SecurityRedactionException(violations)

    logger.info(
        "RedactionAuditTool: payload for session=%s passed audit (%d elements scanned)",
        state.session_id,
        len(state.elements),
    )


class RedactionAuditTool:
    """
    ADK Tool wrapper. Google ADK tools are typically plain callables with a
    name/description registered on an Agent; this class keeps that metadata
    alongside the implementation so it can be dropped straight into
    ``Agent(tools=[RedactionAuditTool()])``.
    """

    name = "redaction_audit_tool"
    description = (
        "Scans an incoming SanitizedPageState for any residual unredacted "
        "PII (Aadhaar, PAN, IFSC, phone, email). Raises and halts the "
        "pipeline if anything is found. Must run before any other agent."
    )

    def __call__(self, state: SanitizedPageState) -> bool:
        audit_sanitized_page_state(state)
        return True
