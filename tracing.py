"""
OpenTelemetry / OpenInference tracing hooks.

Provides a single `traced_span` context manager used throughout agent.py
and the sub-agents so every stage of the pipeline (audit -> perception ->
router -> extraction/navigation -> safety) shows up as a nested span in
whatever OTLP-compatible backend is configured via the standard
OTEL_EXPORTER_OTLP_ENDPOINT environment variable.

Tracing NEVER records raw payload contents (only shapes/counts/booleans)
to stay consistent with the zero-leakage design constraint -- span
attributes must be scalars derived from metadata, never full element text
or images.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Iterator, Optional

logger = logging.getLogger("tracing")

try:
    from opentelemetry import trace
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import (
        BatchSpanProcessor,
        ConsoleSpanExporter,
    )

    _OTEL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _OTEL_AVAILABLE = False


_tracer = None


def init_tracing(service_name: str = "edge-vision-web-assistant") -> None:
    """Idempotently configure the global TracerProvider."""
    global _tracer

    if not _OTEL_AVAILABLE:
        logger.warning("opentelemetry not installed; tracing disabled")
        return

    if _tracer is not None:
        return

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)

    otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if otlp_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
                OTLPSpanExporter,
            )

            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
            logger.info("tracing: exporting spans to OTLP endpoint %s", otlp_endpoint)
        except ImportError:  # pragma: no cover
            logger.warning("OTLP endpoint configured but exporter package missing; "
                            "falling back to console exporter")
            provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
    else:
        provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))

    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer(service_name)


def get_tracer():
    if _tracer is None:
        init_tracing()
    return _tracer


@contextmanager
def traced_span(name: str, **attributes) -> Iterator[Optional["object"]]:
    """
    Usage:
        with traced_span("page_perception", session_id=sid, element_count=len(els)):
            ...
    Only scalar, non-PII attributes should ever be passed.
    """
    tracer = get_tracer()
    if tracer is None:
        yield None
        return

    with tracer.start_as_current_span(name) as span:
        for key, value in attributes.items():
            try:
                span.set_attribute(key, value)
            except Exception:  # pragma: no cover
                pass
        yield span
