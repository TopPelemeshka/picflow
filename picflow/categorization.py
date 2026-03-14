from __future__ import annotations

import json
from pathlib import Path

import requests

from .config import AppConfig
from .db import Database
from .duplicates import PlannedAction, apply_planned_actions, utc_now
from .verifier import resolve_api_keys


def list_category_items(db: Database, config: AppConfig, filter_mode: str, limit: int, offset: int) -> list[dict]:
    items = db.list_category_images(filter_mode, limit, offset)
    for item in items:
        item["media_url"] = f"/media?path={item['path']}"
        item["effective_label"] = item.get("category_label") or "pending"
    return items


def _unique_target_path(target_dir: Path, file_name: str, reserved: set[str]) -> Path:
    candidate = target_dir / file_name
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while candidate.exists() or str(candidate).lower() in reserved:
        counter += 1
        candidate = target_dir / f"{stem}_{counter}{suffix}"
    reserved.add(str(candidate).lower())
    return candidate


def plan_export_actions(db: Database, config: AppConfig) -> list[PlannedAction]:
    items = db.list_category_queue()
    reserved: set[str] = set()
    actions: list[PlannedAction] = []
    for item in items:
        label = item.get("category_label")
        if not label or label == "blocked":
            continue
        target_dir = config.export_dir / label
        target_path = _unique_target_path(target_dir, item["file_name"], reserved)
        actions.append(
            PlannedAction(
                kind="move",
                image_id=item["id"],
                old_path=item["path"],
                new_path=str(target_path),
                note=f"category={label}",
            )
        )
    return actions


def apply_export_actions(db: Database, config: AppConfig, progress=None) -> dict[str, int]:
    actions = plan_export_actions(db, config)
    result = apply_planned_actions(db, config, actions, progress=progress)
    return {"export_actions": len(actions), **result}


CATEGORY_PROMPT = """Определи одну категорию для картинки из списка:
- ero-anime
- ero-real
- standart-art
- standart-meme
- single-meme

Опирайся строго на эти правила:
- ero-real: реальные эротические фотографии с настоящими людьми.
- ero-anime: эротические рисунки, аниме или любые эротические иллюстрации.
- standart-art: просто красивые картинки, арты или просто забавные изображения, которые не тянут на полноценный мем.
- standart-meme: обычные мемы, если это не авторский рисунок-мем.
- single-meme: картинки, которые являются мемами, но сделаны как авторские рисунки или авторские иллюстрации.

Если сомневаешься между standart-art и standart-meme:
- если главное в картинке мемный формат, реакция, шаблон, шутка или мемная подача — выбирай standart-meme;
- если это просто красивая, атмосферная или слегка забавная картинка без явного мемного формата — выбирай standart-art.

Если картинка является мемом и при этом это именно нарисованный авторский мем, выбирай single-meme.

Верни ТОЛЬКО JSON:
{"label":"ero-anime|ero-real|standart-art|standart-meme|single-meme|blocked","reason":"кратко"}

Если не можешь ответить из-за safety или цензуры, верни blocked.
"""


def _encode_image(path: Path, max_side: int = 1024, jpeg_quality: int = 85) -> tuple[str, str]:
    from .hashing import encode_image_for_api

    return encode_image_for_api(path, max_side=max_side, jpeg_quality=jpeg_quality)


def _endpoint(config: AppConfig, api_key: str) -> str:
    base = config.verification.base_url.rstrip("/")
    return f"{base}/models/{config.verification.model}:generateContent?key={api_key}"


def _classify_image(config: AppConfig, path: str, api_key: str) -> tuple[str, str]:
    image_b64, mime = _encode_image(
        Path(path),
        max_side=config.verification.max_image_side,
        jpeg_quality=config.verification.jpeg_quality,
    )
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": CATEGORY_PROMPT},
                    {"inlineData": {"mimeType": mime, "data": image_b64}},
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0,
        },
    }
    proxies = None
    if config.verification.proxy_url:
        proxies = {"http": config.verification.proxy_url, "https": config.verification.proxy_url}
    response = requests.post(
        _endpoint(config, api_key),
        json=payload,
        timeout=config.verification.request_timeout_sec,
        proxies=proxies,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("promptFeedback", {}).get("blockReason"):
        return "blocked", data["promptFeedback"]["blockReason"]
    candidates = data.get("candidates") or []
    if not candidates:
        return "blocked", "empty response"
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "\n".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        parsed = json.loads(text[start:end])
    except Exception:  # noqa: BLE001
        return "blocked", text[:500]
    label = parsed.get("label", "blocked")
    if label not in {*config.export_categories, "blocked"}:
        label = "blocked"
    return label, parsed.get("reason", "")


def run_categorization(db: Database, config: AppConfig, *, limit: int | None = None, force: bool = False, progress=None) -> dict[str, int]:
    api_keys = resolve_api_keys(config)
    if not api_keys:
        raise RuntimeError("В конфиге нет verification.api_keys")
    items = db.list_category_queue()
    if not force:
        items = [item for item in items if not item.get("category_label")]
    if limit is not None:
        items = items[:limit]
    if not items:
        return {"queued": 0, "classified": 0, "blocked": 0}
    total = len(items)
    blocked = 0
    for index, item in enumerate(items, start=1):
        api_key = api_keys[(index - 1) % len(api_keys)]
        label, reason = _classify_image(config, item["path"], api_key)
        if label == "blocked":
            blocked += 1
        db.update_category_label(item["id"], label, "ai", utc_now())
        if progress:
            progress(index / total, f"AI-категоризация {index}/{total}")
    return {"queued": total, "classified": total - blocked, "blocked": blocked}
