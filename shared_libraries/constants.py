"""
Security parameters, matching rules, and shared regex definitions.

These regexes are duplicated (intentionally) in the TypeScript edge redactor
(frontend_extension/src/utils/edgeRedactor.ts) so that masking can happen
entirely client-side. The backend copies here exist ONLY so that
tools/redaction_verifier.py can perform a fail-safe audit and refuse to
process anything that slipped through.
"""

import os
import re

# --------------------------------------------------------------------------- #
# Action policy
# --------------------------------------------------------------------------- #
ALLOWED_ACTIONS = {"click", "type_tokenized", "scroll", "highlight", "extract", "none"}

# Any element label / id / selector / surrounding text matching one of these
# (case-insensitive, word-boundary aware) forces requires_confirmation = True
# regardless of what navigation_planning proposed.
CRITICAL_ACTION_KEYWORDS = {
    "submit",
    "pay",
    "order",
    "delete",
    "remove",
    "transfer",
    "confirm",
    "buy",
    "checkout",
    "purchase",
    "place order",
    "authorize",
    "send money",
    "withdraw",
}

CRITICAL_ACTION_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in CRITICAL_ACTION_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------- #
# PII detection (India-first, extensible)
# --------------------------------------------------------------------------- #
PII_PATTERNS = {
    "aadhaar": re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b"),
    "pan": re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b"),
    "ifsc": re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"),
    "phone_in": re.compile(r"\b(?:\+91|0)?[6-9]\d{9}\b"),
    "email": re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b", re.IGNORECASE),
    "passport": re.compile(r"\b[A-Z][0-9]{7}\b", re.IGNORECASE),
    "titled_name": re.compile(r"\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b"),
    # Generic surrogate-token allowlist used to distinguish an already-masked
    # value (safe) from a raw literal (unsafe).
    "surrogate_token": re.compile(r"^<[A-Z_]+_\d+>$|^\[[A-Za-z ]+ Redacted\]$"),
}

# Fields whose presence in an element's `role`/`input_type` almost always
# signals sensitive content, used as a secondary heuristic by the page
# perception agent even when regex matching misses (e.g. masked password
# dots, or an <input type="password"> with no visible text).
SENSITIVE_INPUT_TYPES = {"password", "tel", "email"}

# --------------------------------------------------------------------------- #
# Networking / model
# --------------------------------------------------------------------------- #
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
MAX_SESSION_HISTORY_TURNS = 5
