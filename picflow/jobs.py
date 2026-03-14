from __future__ import annotations

import threading
from datetime import UTC, datetime
from typing import Any, Callable

from .db import Database


JobCallable = Callable[[Callable[[float, str], None]], dict[str, Any]]


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class JobManager:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._lock = threading.Lock()
        self._active_kinds: set[str] = set()

    def start_job(self, kind: str, payload: dict[str, Any], runner: JobCallable) -> int:
        with self._lock:
            if kind in self._active_kinds:
                raise RuntimeError(f"Задача '{kind}' уже выполняется")
            self._active_kinds.add(kind)
        job_id = self.db.create_job(kind, payload, utc_now())

        def update(progress: float, message: str) -> None:
            self.db.update_job(job_id, status="running", progress=round(progress, 4), message=message)

        def target() -> None:
            self.db.update_job(job_id, status="running", started_at=utc_now(), message="Запуск")
            try:
                result = runner(update)
            except Exception as exc:  # noqa: BLE001
                self.db.update_job(
                    job_id,
                    status="failed",
                    progress=1.0,
                    message=str(exc),
                    result={"error": str(exc)},
                    finished_at=utc_now(),
                )
            else:
                self.db.update_job(
                    job_id,
                    status="done",
                    progress=1.0,
                    message="Готово",
                    result=result,
                    finished_at=utc_now(),
                )
            finally:
                with self._lock:
                    self._active_kinds.discard(kind)

        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        return job_id
