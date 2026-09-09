"""Optional local OCR redaction using RapidOCR's ONNX runtime models.

The OCR engine runs locally and returns only sensitive pixel boxes. OCR text is
never returned or sent to the remote reasoning model. It is intentionally
conservative: ordinary words are ignored; only strict PII patterns and names
following an explicit label are redacted.
"""

from __future__ import annotations

import base64
import io
import re
from functools import lru_cache
from typing import Any

EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}\b", re.IGNORECASE)
AADHAAR_PATTERN = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
PAN_PATTERN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", re.IGNORECASE)
PHONE_PATTERN = re.compile(r"\b(?:\+91|0)?[6-9]\d{9}\b")
PASSPORT_PATTERN = re.compile(r"\b[A-Z][0-9]{7}\b", re.IGNORECASE)
NAME_PATTERN = re.compile(
    r"\b(?:full\s+name|name|username|applicant|patient|customer)\s*[:=-]\s*"
    r"[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}",
    re.IGNORECASE,
)


@lru_cache(maxsize=1)
def _ocr_engine() -> Any:
    from rapidocr_onnxruntime import RapidOCR

    return RapidOCR()


def _decode_image(image_b64: str) -> Any:
    import cv2
    import numpy as np
    from PIL import Image

    raw = base64.b64decode(image_b64)
    with Image.open(io.BytesIO(raw)) as image:
        rgb = np.asarray(image.convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _box_bounds(box: Any) -> tuple[float, float, float, float]:
    points = [(float(point[0]), float(point[1])) for point in box]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    left, top = min(xs), min(ys)
    return left, top, max(xs) - left, max(ys) - top


def detect_sensitive_regions(image_b64: str) -> list[dict[str, float | str]]:
    """OCR an image locally and return strict sensitive regions only."""
    image = _decode_image(image_b64)
    result, _ = _ocr_engine()(image)
    if not result:
        return []

    regions: list[dict[str, float | str]] = []
    for item in result:
        box, text, score = item[0], str(item[1]).strip(), float(item[2])
        if score < 0.65:
            continue
        if not any(
            pattern.search(text)
            for pattern in (
                EMAIL_PATTERN,
                AADHAAR_PATTERN,
                PAN_PATTERN,
                PHONE_PATTERN,
                PASSPORT_PATTERN,
                NAME_PATTERN,
            )
        ):
            continue
        x, y, width, height = _box_bounds(box)
        regions.append({"x": x, "y": y, "width": width, "height": height, "reason": "local_ocr_pii"})
    return regions
