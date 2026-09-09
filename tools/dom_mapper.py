"""
Coordinate-to-DOM matching & viewport translation utilities.

The vision model reasons in a normalized 0-1000 coordinate space (Gemini's
bounding-box convention). This module converts those coordinates back into
real viewport pixels and finds the closest matching ``ScrapedElement`` so
that ``navigation_planning`` can emit a concrete ``target_selector`` instead
of a bare bounding box whenever possible (selectors are far more robust to
reflow/scroll than raw pixel coordinates).
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

from shared_libraries.types import BoundingBox, ScrapedElement


def normalized_to_viewport(
    bbox: BoundingBox, viewport_width: int, viewport_height: int
) -> Tuple[float, float, float, float]:
    """Convert a 0-1000 normalized bbox into (x, y, width, height) pixels."""
    x = (bbox.xmin / 1000.0) * viewport_width
    y = (bbox.ymin / 1000.0) * viewport_height
    w = ((bbox.xmax - bbox.xmin) / 1000.0) * viewport_width
    h = ((bbox.ymax - bbox.ymin) / 1000.0) * viewport_height
    return x, y, w, h


def _euclidean(p1: Tuple[float, float], p2: Tuple[float, float]) -> float:
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def find_closest_element(
    target_bbox: BoundingBox,
    elements: List[ScrapedElement],
    max_distance: float = 60.0,
) -> Optional[ScrapedElement]:
    """
    Find the ScrapedElement whose bbox center is closest (in the shared
    normalized 0-1000 space) to ``target_bbox``'s center.

    Returns None if the closest match is farther than ``max_distance``
    normalized units away (i.e. no confident match -- caller should fall
    back to raw bbox-based interaction instead of a selector).
    """
    if not elements:
        return None

    target_center = target_bbox.center()
    best_el: Optional[ScrapedElement] = None
    best_dist = math.inf

    for el in elements:
        dist = _euclidean(target_center, el.bbox.center())
        if dist < best_dist:
            best_dist = dist
            best_el = el

    if best_el is not None and best_dist <= max_distance:
        return best_el
    return None


def relative_viewport_metrics(
    bbox: BoundingBox,
) -> dict:
    """Return percentage-based layout metrics, useful for speech guidance
    like 'the field near the top-right of the form'."""
    cx, cy = bbox.center()
    horizontal = "left" if cx < 333 else "right" if cx > 666 else "center"
    vertical = "top" if cy < 333 else "bottom" if cy > 666 else "middle"
    return {
        "horizontal_zone": horizontal,
        "vertical_zone": vertical,
        "center_x_pct": round(cx / 10.0, 1),
        "center_y_pct": round(cy / 10.0, 1),
    }
