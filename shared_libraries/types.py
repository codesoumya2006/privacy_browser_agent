"""
Strict Pydantic schemas shared across every sub-agent, tool, and the
FastAPI transport layer.

IMPORTANT PRIVACY INVARIANT: none of these models are permitted to carry
raw PII. Any free-text field (``text``, ``user_query`` etc.) is expected
to already have been passed through the client-side pseudonymizer /
canvas redactor before it ever reaches the backend. The backend-side
``RedactionAuditTool`` (see tools/redaction_verifier.py) re-verifies this
invariant defensively on every request.
"""

from __future__ import annotations

from enum import Enum
from time import time
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
class BoundingBox(BaseModel):
    """Normalized bounding box, scaled 0-1000 on both axes (Gemini convention)."""

    ymin: float = Field(..., ge=0, le=1000)
    xmin: float = Field(..., ge=0, le=1000)
    ymax: float = Field(..., ge=0, le=1000)
    xmax: float = Field(..., ge=0, le=1000)

    @field_validator("ymax")
    @classmethod
    def _ymax_after_ymin(cls, v: float, info) -> float:
        ymin = info.data.get("ymin")
        if ymin is not None and v < ymin:
            raise ValueError("ymax must be >= ymin")
        return v

    @field_validator("xmax")
    @classmethod
    def _xmax_after_xmin(cls, v: float, info) -> float:
        xmin = info.data.get("xmin")
        if xmin is not None and v < xmin:
            raise ValueError("xmax must be >= xmin")
        return v

    def center(self) -> "tuple[float, float]":
        return ((self.xmin + self.xmax) / 2.0, (self.ymin + self.ymax) / 2.0)


# --------------------------------------------------------------------------- #
# Page state
# --------------------------------------------------------------------------- #
class ScrapedElement(BaseModel):
    """A single interactable or informational DOM element harvested client-side."""

    id: str
    tag: str
    role: str = ""
    text: str = ""
    bbox: BoundingBox
    is_interactable: bool = False
    selector: Optional[str] = None
    input_type: Optional[str] = None  # e.g. "text", "password", "checkbox"
    placeholder: Optional[str] = None
    aria_label: Optional[str] = None


class SanitizedPageState(BaseModel):
    """
    The only object ever transmitted from the extension to the backend.
    ``redacted_image_b64`` must already be canvas-redacted; ``elements``
    text fields must already be tokenized.
    """

    session_id: str
    url: str
    title: str = ""
    user_query: Optional[str] = None
    elements: List[ScrapedElement] = Field(default_factory=list)
    redacted_image_b64: Optional[str] = None
    timestamp: float = Field(default_factory=time)
    token_map_digest: Optional[str] = None  # non-reversible hash for audit logging only


# --------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------- #
class ActionType(str, Enum):
    CLICK = "click"
    TYPE_TOKENIZED = "type_tokenized"
    SCROLL = "scroll"
    HIGHLIGHT = "highlight"
    EXTRACT = "extract"
    NONE = "none"


class PageCategory(str, Enum):
    FORM = "form"
    DASHBOARD = "dashboard"
    TABLE_DATA = "table_data"
    ARTICLE = "article"
    ECOMMERCE = "ecommerce"
    UNKNOWN = "unknown"


class ActionCommand(BaseModel):
    """The single structured output the backend returns to the extension."""

    action_type: ActionType = ActionType.NONE
    target_selector: Optional[str] = None
    target_bbox: Optional[BoundingBox] = None
    tokenized_value: Optional[str] = None  # e.g. "<PERSON_1>" - never raw PII
    speech_guidance: str = ""
    requires_confirmation: bool = False
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    extracted_data: Optional[Dict] = None

    @field_validator("tokenized_value")
    @classmethod
    def _no_raw_pii_leak(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Defensive shape-check: tokenized values must look like <TAG_N> or
        # a bracketed redaction marker, never a bare literal.
        stripped = v.strip()
        looks_like_token = (
            (stripped.startswith("<") and stripped.endswith(">"))
            or (stripped.startswith("[") and stripped.endswith("]"))
        )
        if not looks_like_token:
            raise ValueError(
                "tokenized_value must be a surrogate token like <PERSON_1>, "
                "never a raw literal value."
            )
        return v


class PagePerceptionResult(BaseModel):
    page_category: PageCategory = PageCategory.UNKNOWN
    focal_area_description: str = ""
    interactable_field_ids: List[str] = Field(default_factory=list)
    summary: str = ""


class InteractResponse(BaseModel):
    """Top level FastAPI response envelope for POST /api/v1/interact."""

    session_id: str
    page_category: PageCategory
    action: ActionCommand
    reasoning_trace_id: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    model_ready: bool
    version: str
