"""
In-memory, thread-safe, multi-turn session state management.

Nothing here is persisted to disk: process restart == full memory wipe,
which is intentional given the zero-leakage / zero-persistence design
constraint. Only surrogate-tokenized data and structural metadata is ever
stored (never raw PII, since raw PII never reaches the backend at all).
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from time import time
from typing import Deque, Dict, List, Optional

from shared_libraries.constants import MAX_SESSION_HISTORY_TURNS
from shared_libraries.types import ActionCommand, PageCategory


@dataclass
class TurnRecord:
    timestamp: float
    page_category: PageCategory
    executed_selector: Optional[str]
    action: ActionCommand
    extracted_schema: Optional[dict] = None


@dataclass
class SessionState:
    session_id: str
    history: Deque[TurnRecord] = field(
        default_factory=lambda: deque(maxlen=MAX_SESSION_HISTORY_TURNS)
    )
    last_url: Optional[str] = None
    created_at: float = field(default_factory=time)
    updated_at: float = field(default_factory=time)


class StateMemoryStore:
    """Thread-safe in-memory store keyed by session_id."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: Dict[str, SessionState] = {}

    def get_or_create(self, session_id: str) -> SessionState:
        with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = SessionState(session_id=session_id)
            return self._sessions[session_id]

    def record_turn(
        self,
        session_id: str,
        page_category: PageCategory,
        action: ActionCommand,
        url: Optional[str] = None,
        extracted_schema: Optional[dict] = None,
    ) -> None:
        with self._lock:
            session = self.get_or_create(session_id)
            session.history.append(
                TurnRecord(
                    timestamp=time(),
                    page_category=page_category,
                    executed_selector=action.target_selector,
                    action=action,
                    extracted_schema=extracted_schema,
                )
            )
            if url:
                session.last_url = url
            session.updated_at = time()

    def get_recent_history(self, session_id: str) -> List[TurnRecord]:
        with self._lock:
            session = self._sessions.get(session_id)
            return list(session.history) if session else []

    def clear_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def active_session_count(self) -> int:
        with self._lock:
            return len(self._sessions)


# Module-level singleton used by the FastAPI app / ADK workflow.
state_memory_store = StateMemoryStore()
