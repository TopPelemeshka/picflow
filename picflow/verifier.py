from __future__ import annotations

import json
import queue
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

import requests

from .config import AppConfig, DEFAULT_CONFIG_PATH
from .db import Database
from .hashing import encode_image_for_api


ProgressCallback = Callable[[float, str], None]


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


PROMPT = """Сравни две картинки и реши, являются ли они одной и той же исходной картинкой.

Считай дубликатами:
- один и тот же арт/мем/фото после ресайза, сжатия, слабой коррекции цвета;
- лёгкий кроп, не меняющий сам исходник;
- небольшие текстовые или графические правки поверх того же изображения.

Считай разными:
- разные кадры, разные арты, разные позы, другой ракурс;
- похожие картинки, но не один и тот же исходник.

Верни ТОЛЬКО JSON без пояснений вне JSON:
{"label":"duplicate|distinct|blocked","confidence":0.0,"reason":"кратко"}

Если не можешь ответить из-за ограничений безопасности или не видишь содержимое, верни label=blocked.
"""


@dataclass(slots=True)
class VerificationResult:
    label: str
    confidence: float | None
    reason: str
    raw_response: str


class GeminiVerifier:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    def _endpoint_for_key(self, api_key: str) -> str:
        base = self.config.verification.base_url.rstrip("/")
        return f"{base}/models/{self.config.verification.model}:generateContent?key={api_key}"

    def _payload(self, left_path: str, right_path: str, *, json_mode: bool = True) -> dict:
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
        generation_config = {
            "temperature": 0,
        }
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
            "generationConfig": generation_config,
        }

    def verify_pair(self, left_path: str, right_path: str, api_key: str) -> VerificationResult:
        endpoint = self._endpoint_for_key(api_key)
        payload = self._payload(left_path, right_path, json_mode=True)
        proxies = None
        if self.config.verification.proxy_url:
            proxies = {
                "http": self.config.verification.proxy_url,
                "https": self.config.verification.proxy_url,
            }
        response = requests.post(endpoint, json=payload, timeout=self.config.verification.request_timeout_sec, proxies=proxies)
        if response.status_code == 400 and "JSON mode is not enabled" in response.text:
            payload = self._payload(left_path, right_path, json_mode=False)
            response = requests.post(
                endpoint,
                json=payload,
                timeout=self.config.verification.request_timeout_sec,
                proxies=proxies,
            )
        response.raise_for_status()
        data = response.json()
        if data.get("promptFeedback", {}).get("blockReason"):
            reason = data["promptFeedback"]["blockReason"]
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
        confidence = parsed.get("confidence")
        reason = parsed.get("reason", "")
        if label not in {"duplicate", "distinct", "blocked"}:
            label = "error"
        confidence_value = max(0.0, min(1.0, float(confidence))) if isinstance(confidence, (int, float)) else None
        return VerificationResult(label, confidence_value, reason, raw_response)


def resolve_api_keys(config: AppConfig) -> list[str]:
    api_keys = [key for key in config.verification.api_keys if key]
    if api_keys:
        return api_keys
    if DEFAULT_CONFIG_PATH.exists():
        try:
            payload = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return []
        fallback = [key for key in payload.get("verification", {}).get("api_keys", []) if key]
        if fallback:
            return fallback
    return []


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
    lock = threading.Lock()
    counters = {"verified": 0, "duplicates": 0, "distinct": 0, "blocked": 0, "errors": 0}

    def worker(api_key: str) -> None:
        while True:
            try:
                item = tasks.get_nowait()
            except queue.Empty:
                return
            try:
                result = verifier.verify_pair(item["left_path"], item["right_path"], api_key)
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

    workers = [
        threading.Thread(target=worker, args=(api_key,), daemon=True)
        for api_key in api_keys[: max(1, config.verification.concurrency)]
    ]
    for thread in workers:
        thread.start()
    for thread in workers:
        thread.join()
    return {"queued": total, **counters}
