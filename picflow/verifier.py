from __future__ import annotations

import json
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

import requests

from .config import AppConfig, DEFAULT_CONFIG_PATH
from .db import Database
from .hashing import encode_image_for_api


ProgressCallback = Callable[[float, str], None]

PROMPT = """Сравни две картинки и реши, являются ли они одним и тем же исходным изображением.

Считай duplicate только если это действительно один и тот же исходник:
- тот же арт, мем или фото после ресайза, сжатия или слабой цветокоррекции;
- легкий кроп, который не меняет сам исходник;
- мелкие графические правки, watermark или незначительная косметика поверх того же изображения.

Считай distinct, если изменена содержательная текстовая часть:
- тот же шаблон, но другой текст, подпись, реплика, шутка, надпись или caption;
- та же база мема, но из-за другого текста это уже другой мемный пост;
- похожий ракурс, похожий арт или похожая картинка, но не тот же самый исходник.

Если отличается смысловой текст, выбирай distinct даже тогда, когда визуальная основа почти одинаковая.

Верни ТОЛЬКО JSON без пояснений вне JSON:
{"label":"duplicate|distinct|blocked","confidence":0.0,"reason":"кратко"}

Если не можешь ответить из-за ограничений безопасности или не видишь содержимое, верни label=blocked.
"""


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass(slots=True)
class VerificationResult:
    label: str
    confidence: float | None
    reason: str
    raw_response: str


@dataclass(slots=True)
class KeyWorkerState:
    api_key: str
    next_allowed_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class GeminiVerifier:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    def _endpoint_for_key(self, api_key: str) -> str:
        base = self.config.verification.base_url.rstrip("/")
        return f"{base}/models/{self.config.verification.model}:generateContent?key={api_key}"

    def _proxies(self) -> dict[str, str] | None:
        if not self.config.verification.proxy_url:
            return None
        return {
            "http": self.config.verification.proxy_url,
            "https": self.config.verification.proxy_url,
        }

    def _payload(self, left_path: str, right_path: str, *, json_mode: bool) -> dict:
        left_b64, left_mime = encode_image_for_api(
            Path(left_path),
            max_side=self.config.verification.max_image_side,
            jpeg_quality=self.config.verification.jpeg_quality,
        )
        right_b64, right_mime = encode_image_for_api(
            Path(right_path),
            max_side=self.config.verification.max_image_side,
            jpeg_quality=self.config.verification.jpeg_quality,
        )
        generation_config: dict[str, object] = {"temperature": 0}
        if json_mode:
            generation_config["responseMimeType"] = "application/json"
        return {
            "contents": [
                {
                    "parts": [
                        {"text": PROMPT},
                        {"inlineData": {"mimeType": left_mime, "data": left_b64}},
                        {"inlineData": {"mimeType": right_mime, "data": right_b64}},
                    ]
                }
            ],
            "safetySettings": [
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE"},
            ],
            "generationConfig": generation_config,
        }

    def verify_pair(self, left_path: str, right_path: str, api_key: str) -> VerificationResult:
        endpoint = self._endpoint_for_key(api_key)
        response = requests.post(
            endpoint,
            json=self._payload(left_path, right_path, json_mode=True),
            timeout=self.config.verification.request_timeout_sec,
            proxies=self._proxies(),
        )
        if response.status_code == 400 and "JSON mode is not enabled" in response.text:
            response = requests.post(
                endpoint,
                json=self._payload(left_path, right_path, json_mode=False),
                timeout=self.config.verification.request_timeout_sec,
                proxies=self._proxies(),
            )
        response.raise_for_status()
        return self._parse_response(response.json())

    def _parse_response(self, data: dict) -> VerificationResult:
        prompt_feedback = data.get("promptFeedback", {})
        if prompt_feedback.get("blockReason"):
            reason = prompt_feedback["blockReason"]
            return VerificationResult("blocked", 0.0, reason, json.dumps(data, ensure_ascii=False))

        candidates = data.get("candidates") or []
        if not candidates:
            return VerificationResult("error", None, "No candidates in response", json.dumps(data, ensure_ascii=False))

        first = candidates[0]
        finish_reason = first.get("finishReason", "")
        if finish_reason in {"SAFETY", "BLOCKED"}:
            return VerificationResult("blocked", 0.0, finish_reason, json.dumps(data, ensure_ascii=False))

        text_parts = [
            part.get("text", "")
            for part in first.get("content", {}).get("parts", [])
            if isinstance(part, dict) and part.get("text")
        ]
        raw_text = "\n".join(text_parts).strip()
        raw_response = raw_text or json.dumps(data, ensure_ascii=False)
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start == -1 or end == -1 or end < start:
            return VerificationResult("error", None, "Model did not return JSON", raw_response)

        try:
            parsed = json.loads(raw_text[start : end + 1])
        except json.JSONDecodeError as exc:
            return VerificationResult("error", None, f"JSON parse failed: {exc}", raw_response)

        label = parsed.get("label", "error")
        if label not in {"duplicate", "distinct", "blocked"}:
            label = "error"

        confidence = parsed.get("confidence")
        confidence_value = max(0.0, min(1.0, float(confidence))) if isinstance(confidence, (int, float)) else None
        reason = str(parsed.get("reason", ""))
        return VerificationResult(label, confidence_value, reason, raw_response)


def resolve_api_keys(config: AppConfig) -> list[str]:
    api_keys = [key for key in config.verification.api_keys if key]
    if api_keys:
        return api_keys
    if DEFAULT_CONFIG_PATH.exists():
        try:
            payload = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        except Exception:  # noqa: BLE001
            return []
        fallback = [key for key in payload.get("verification", {}).get("api_keys", []) if key]
        if fallback:
            return fallback
    return []


def _rate_limit_wait(worker_state: KeyWorkerState, rpm: int = 30) -> None:
    min_interval = 60.0 / max(1, rpm)
    with worker_state.lock:
        now = time.monotonic()
        wait_for = worker_state.next_allowed_at - now
        if wait_for > 0:
            time.sleep(wait_for)
        worker_state.next_allowed_at = time.monotonic() + min_interval


def _retry_sleep(attempt: int, response: requests.Response | None = None) -> None:
    retry_after = None
    if response is not None:
        header = response.headers.get("Retry-After")
        if header:
            try:
                retry_after = float(header)
            except ValueError:
                retry_after = None
    delay = retry_after if retry_after is not None else min(20.0, 2.5 * (attempt + 1))
    time.sleep(delay)


def _verify_with_retries(
    verifier: GeminiVerifier,
    left_path: str,
    right_path: str,
    worker_state: KeyWorkerState,
    max_attempts: int = 5,
) -> VerificationResult:
    for attempt in range(max_attempts):
        _rate_limit_wait(worker_state)
        try:
            return verifier.verify_pair(left_path, right_path, worker_state.api_key)
        except requests.HTTPError as exc:
            response = exc.response
            status_code = response.status_code if response is not None else None
            if status_code in {429, 500, 502, 503, 504} and attempt < max_attempts - 1:
                _retry_sleep(attempt, response)
                continue
            raise
        except (requests.Timeout, requests.ConnectionError):
            if attempt < max_attempts - 1:
                _retry_sleep(attempt)
                continue
            raise
    raise RuntimeError("verification retries exhausted")


def run_verification(
    db: Database,
    config: AppConfig,
    *,
    limit: int | None = None,
    force: bool = False,
    progress: ProgressCallback | None = None,
) -> dict[str, int]:
    api_keys = resolve_api_keys(config)
    if not api_keys:
        raise RuntimeError("В конфиге нет verification.api_keys")

    verifier = GeminiVerifier(config)
    items = db.list_candidates_for_verification(limit=limit, force=force)
    total = len(items)
    if total == 0:
        return {"queued": 0, "verified": 0, "duplicates": 0, "distinct": 0, "blocked": 0, "errors": 0}

    tasks: queue.Queue[dict] = queue.Queue()
    for item in items:
        tasks.put(item)

    worker_states = [KeyWorkerState(api_key=api_key) for api_key in api_keys]
    counters = {"verified": 0, "duplicates": 0, "distinct": 0, "blocked": 0, "errors": 0}
    lock = threading.Lock()

    def worker(worker_state: KeyWorkerState) -> None:
        while True:
            try:
                item = tasks.get_nowait()
            except queue.Empty:
                return

            try:
                result = _verify_with_retries(
                    verifier,
                    item["left_path"],
                    item["right_path"],
                    worker_state,
                )
            except Exception as exc:  # noqa: BLE001
                result = VerificationResult("error", None, str(exc), str(exc))

            db.update_candidate_ai(
                item["id"],
                label=result.label,
                confidence=result.confidence,
                reason=result.reason,
                raw_response=result.raw_response,
                updated_at=utc_now(),
            )

            with lock:
                counters["verified"] += 1
                if result.label == "duplicate":
                    counters["duplicates"] += 1
                elif result.label == "distinct":
                    counters["distinct"] += 1
                elif result.label == "blocked":
                    counters["blocked"] += 1
                else:
                    counters["errors"] += 1
                if progress:
                    progress(counters["verified"] / total, f"AI-проверка {counters['verified']}/{total}")

            tasks.task_done()

    workers = [threading.Thread(target=worker, args=(worker_state,), daemon=True) for worker_state in worker_states]
    for thread in workers:
        thread.start()
    for thread in workers:
        thread.join()

    return {"queued": total, **counters}
