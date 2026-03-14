from __future__ import annotations

import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .categorization import apply_export_actions, list_category_items, plan_export_actions, run_categorization
from .config import AppConfig, load_or_create_config, resolve_config_path
from .db import Database
from .duplicates import apply_planned_actions, build_duplicate_candidates, plan_duplicate_actions, scan_library, utc_now
from .jobs import JobManager
from .selection import apply_selection_actions, list_selection_items, plan_selection_actions
from .verifier import run_verification


class PicFlowApp:
    def __init__(self, config: AppConfig | None = None, config_path: Path | str | None = None) -> None:
        self.config_path = resolve_config_path(config_path)
        self.config = config or load_or_create_config(self.config_path)
        self.db = Database(self.config.database_path)
        self.db.init()
        self.jobs = JobManager(self.db)

    def serialize_candidate(self, item: dict) -> dict:
        effective_label = item.get("manual_label") or item.get("ai_label") or "pending"
        return {
            **item,
            "effective_label": effective_label,
            "left_media_url": self.media_url(item["left_path"]),
            "right_media_url": self.media_url(item["right_path"]),
            "left_thumbnail_url": self.media_url(item.get("left_thumbnail_path") or item["left_path"]),
            "right_thumbnail_url": self.media_url(item.get("right_thumbnail_path") or item["right_path"]),
        }

    def media_url(self, path: str) -> str:
        return f"/media?path={path}"

    def dashboard_payload(self) -> dict:
        return {
            "stats": self.db.stats(),
            "jobs": self.db.list_jobs(),
            "config": {
                "config_path": str(self.config_path),
                "library_root": str(self.config.library_root),
                "reference_dir": str(self.config.reference_dir),
                "export_dir": str(self.config.export_dir),
                "approved_dir": str(self.config.approved_dir),
                "rejected_dir": str(self.config.rejected_dir),
                "duplicate_action": self.config.duplicate_action,
                "model": self.config.verification.model,
                "proxy_url": self.config.verification.proxy_url,
            },
        }

    def list_candidates(self, filter_mode: str, limit: int, offset: int) -> list[dict]:
        return [self.serialize_candidate(item) for item in self.db.list_candidates(filter_mode, limit, offset)]

    def get_candidate(self, candidate_id: int) -> dict | None:
        item = self.db.get_candidate(candidate_id)
        if not item:
            return None
        return self.serialize_candidate(item)


class PicFlowHandler(BaseHTTPRequestHandler):
    server_version = "PicFlow/0.1"

    @property
    def app(self) -> PicFlowApp:
        return self.server.app  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._serve_file(Path(__file__).resolve().parent / "templates" / "dashboard.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/duplicates":
            self._serve_file(Path(__file__).resolve().parent / "templates" / "duplicates.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/selection":
            self._serve_file(Path(__file__).resolve().parent / "templates" / "selection.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/categorize":
            self._serve_file(Path(__file__).resolve().parent / "templates" / "categorize.html", "text/html; charset=utf-8")
            return
        if parsed.path.startswith("/static/"):
            target = Path(__file__).resolve().parent / parsed.path.lstrip("/")
            if target.exists():
                content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                self._serve_file(target, content_type)
                return
        if parsed.path == "/media":
            self._serve_media(parsed)
            return
        if parsed.path == "/api/dashboard":
            self._send_json(self.app.dashboard_payload())
            return
        if parsed.path == "/api/jobs":
            self._send_json({"jobs": self.app.db.list_jobs()})
            return
        if parsed.path == "/api/duplicates":
            query = parse_qs(parsed.query)
            filter_mode = query.get("filter", ["needs-review"])[0]
            limit = int(query.get("limit", ["50"])[0])
            offset = int(query.get("offset", ["0"])[0])
            items = self.app.list_candidates(filter_mode, limit, offset)
            self._send_json({"items": items, "filter": filter_mode, "offset": offset, "limit": limit})
            return
        if parsed.path == "/api/selection":
            query = parse_qs(parsed.query)
            filter_mode = query.get("filter", ["all"])[0]
            limit = int(query.get("limit", ["120"])[0])
            offset = int(query.get("offset", ["0"])[0])
            items = list_selection_items(self.app.db, self.app.config, filter_mode, limit, offset)
            self._send_json({"items": items, "filter": filter_mode, "offset": offset, "limit": limit})
            return
        if parsed.path == "/api/categories":
            query = parse_qs(parsed.query)
            filter_mode = query.get("filter", ["all"])[0]
            limit = int(query.get("limit", ["120"])[0])
            offset = int(query.get("offset", ["0"])[0])
            items = list_category_items(self.app.db, self.app.config, filter_mode, limit, offset)
            self._send_json(
                {
                    "items": items,
                    "filter": filter_mode,
                    "offset": offset,
                    "limit": limit,
                    "categories": self.app.config.export_categories,
                }
            )
            return
        if parsed.path.startswith("/api/duplicates/"):
            try:
                candidate_id = int(parsed.path.rsplit("/", 1)[-1])
            except ValueError:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректный id")
                return
            candidate = self.app.get_candidate(candidate_id)
            if not candidate:
                self._send_error_json(HTTPStatus.NOT_FOUND, "Пара не найдена")
                return
            self._send_json(candidate)
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "Не найдено")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        body = self._read_json_body()
        if parsed.path == "/api/scan":
            self._start_scan_job(body)
            return
        if parsed.path == "/api/candidates":
            self._start_candidates_job()
            return
        if parsed.path == "/api/verify":
            self._start_verify_job(body)
            return
        if parsed.path == "/api/duplicates/apply-plan":
            actions = plan_duplicate_actions(self.app.db, self.app.config)
            preview = [
                {
                    "kind": action.kind,
                    "old_path": action.old_path,
                    "new_path": action.new_path,
                    "note": action.note,
                }
                for action in actions[:100]
            ]
            self._send_json({"total": len(actions), "preview": preview})
            return
        if parsed.path == "/api/duplicates/apply":
            self._apply_actions_job()
            return
        if parsed.path == "/api/selection/apply-plan":
            self._selection_plan(body)
            return
        if parsed.path == "/api/selection/apply":
            self._apply_selection_job(body)
            return
        if parsed.path == "/api/categories/run-ai":
            self._run_category_ai(body)
            return
        if parsed.path == "/api/categories/export-plan":
            self._category_export_plan()
            return
        if parsed.path == "/api/categories/export":
            self._apply_export_job()
            return
        if parsed.path.startswith("/api/duplicates/") and parsed.path.endswith("/label"):
            self._label_candidate(parsed.path, body)
            return
        if parsed.path.startswith("/api/selection/") and parsed.path.endswith("/label"):
            self._label_selection(parsed.path, body)
            return
        if parsed.path.startswith("/api/categories/") and parsed.path.endswith("/label"):
            self._label_category(parsed.path, body)
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "Не найдено")

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length == 0:
            return {}
        payload = self.rfile.read(length).decode("utf-8")
        if not payload.strip():
            return {}
        return json.loads(payload)

    def _start_scan_job(self, body: dict) -> None:
        create_dirs = bool(body.get("create_runtime_dirs"))
        if create_dirs:
            self.app.config.ensure_runtime_library_dirs()
        job_id = self.app.jobs.start_job(
            "scan",
            body,
            lambda progress: scan_library(self.app.db, self.app.config, progress=progress),
        )
        self._send_json({"job_id": job_id})

    def _start_candidates_job(self) -> None:
        job_id = self.app.jobs.start_job(
            "candidates",
            {},
            lambda progress: build_duplicate_candidates(self.app.db, self.app.config, progress=progress),
        )
        self._send_json({"job_id": job_id})

    def _start_verify_job(self, body: dict) -> None:
        limit = body.get("limit")
        force = bool(body.get("force"))
        job_id = self.app.jobs.start_job(
            "verify",
            {"limit": limit, "force": force},
            lambda progress: run_verification(
                self.app.db,
                self.app.config,
                limit=limit,
                force=force,
                progress=progress,
            ),
        )
        self._send_json({"job_id": job_id})

    def _apply_actions_job(self) -> None:
        actions = plan_duplicate_actions(self.app.db, self.app.config)
        job_id = self.app.jobs.start_job(
            "apply",
            {"actions": len(actions)},
            lambda progress: apply_planned_actions(self.app.db, self.app.config, actions, progress=progress),
        )
        self._send_json({"job_id": job_id, "actions": len(actions)})

    def _label_candidate(self, path: str, body: dict) -> None:
        parts = path.strip("/").split("/")
        try:
            candidate_id = int(parts[2])
        except (IndexError, ValueError):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректный id")
            return
        label = body.get("label")
        if label == "clear":
            label = None
        if label not in {None, "duplicate", "distinct", "blocked"}:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректная метка")
            return
        self.app.db.update_candidate_manual(candidate_id, label, utc_now())
        candidate = self.app.get_candidate(candidate_id)
        self._send_json(candidate or {"ok": True})

    def _label_selection(self, path: str, body: dict) -> None:
        parts = path.strip("/").split("/")
        try:
            image_id = int(parts[2])
        except (IndexError, ValueError):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректный id")
            return
        label = body.get("label")
        if label == "clear":
            label = None
        if label not in {None, "good", "bad"}:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректная метка")
            return
        self.app.db.update_selection_label(image_id, label, utc_now())
        self._send_json({"ok": True, "id": image_id, "label": label})

    def _selection_plan(self, body: dict) -> None:
        through_image_id = int(body.get("through_image_id", 0))
        if not through_image_id:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Нужен through_image_id")
            return
        actions = plan_selection_actions(self.app.db, self.app.config, through_image_id)
        good = sum(1 for action in actions if "selection=good" in action.note)
        bad = sum(1 for action in actions if "selection=bad" in action.note)
        preview = [
            {
                "kind": action.kind,
                "old_path": action.old_path,
                "new_path": action.new_path,
                "note": action.note,
            }
            for action in actions[:100]
        ]
        self._send_json({"total": len(actions), "good": good, "bad": bad, "preview": preview})

    def _apply_selection_job(self, body: dict) -> None:
        through_image_id = int(body.get("through_image_id", 0))
        if not through_image_id:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Нужен through_image_id")
            return
        job_id = self.app.jobs.start_job(
            "selection_apply",
            {"through_image_id": through_image_id},
            lambda progress: apply_selection_actions(
                self.app.db,
                self.app.config,
                through_image_id,
                progress=progress,
            ),
        )
        self._send_json({"job_id": job_id})

    def _label_category(self, path: str, body: dict) -> None:
        parts = path.strip("/").split("/")
        try:
            image_id = int(parts[2])
        except (IndexError, ValueError):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректный id")
            return
        label = body.get("label")
        if label == "clear":
            label = None
        if label not in {None, "blocked", *self.app.config.export_categories}:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Некорректная категория")
            return
        source = None if label is None else "manual"
        self.app.db.update_category_label(image_id, label, source, utc_now())
        self._send_json({"ok": True, "id": image_id, "label": label})

    def _run_category_ai(self, body: dict) -> None:
        limit = body.get("limit")
        force = bool(body.get("force"))
        job_id = self.app.jobs.start_job(
            "categorize_ai",
            {"limit": limit, "force": force},
            lambda progress: run_categorization(
                self.app.db,
                self.app.config,
                limit=limit,
                force=force,
                progress=progress,
            ),
        )
        self._send_json({"job_id": job_id})

    def _category_export_plan(self) -> None:
        actions = plan_export_actions(self.app.db, self.app.config)
        preview = [
            {
                "kind": action.kind,
                "old_path": action.old_path,
                "new_path": action.new_path,
                "note": action.note,
            }
            for action in actions[:100]
        ]
        self._send_json({"total": len(actions), "preview": preview})

    def _apply_export_job(self) -> None:
        job_id = self.app.jobs.start_job(
            "export_apply",
            {},
            lambda progress: apply_export_actions(self.app.db, self.app.config, progress=progress),
        )
        self._send_json({"job_id": job_id})

    def _serve_media(self, parsed) -> None:
        query = parse_qs(parsed.query)
        requested = query.get("path", [""])[0]
        if not requested:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Не указан путь")
            return
        path = Path(unquote(requested))
        resolved = path.resolve()
        allowed_roots = [self.app.config.library_root.resolve(), self.app.config.state_dir.resolve()]
        if not any(str(resolved).startswith(str(root)) for root in allowed_roots):
            self._send_error_json(HTTPStatus.FORBIDDEN, "Путь вне разрешенных директорий")
            return
        if not resolved.exists() or not resolved.is_file():
            self._send_error_json(HTTPStatus.NOT_FOUND, "Файл не найден")
            return
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        self._serve_file(resolved, content_type, binary=True)

    def _serve_file(self, path: Path, content_type: str, *, binary: bool = False) -> None:
        data = path.read_bytes() if binary else path.read_text(encoding="utf-8").encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json({"error": message}, status=status)

    def log_message(self, format: str, *args) -> None:
        return


def run_server(host: str = "127.0.0.1", port: int = 8765, config_path: Path | str | None = None) -> None:
    app = PicFlowApp(config_path=config_path)
    server = ThreadingHTTPServer((host, port), PicFlowHandler)
    server.app = app  # type: ignore[attr-defined]
    print(f"PicFlow running on http://{host}:{port}")
    server.serve_forever()
