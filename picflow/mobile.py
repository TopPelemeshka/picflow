from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .config import AppConfig
from .db import Database
from .duplicates import PlannedAction, apply_planned_actions, utc_now


PAIRING_TTL_MINUTES = 10
VALID_DECISIONS = {None, "good", "bad", "purge"}


class MobileError(Exception):
    pass


class MobileAuthError(MobileError):
    pass


class MobileValidationError(MobileError):
    pass


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise MobileValidationError(f"Некорректная дата: {value}") from exc


def _review_target_path(target_dir: Path, file_name: str, reserved: set[str]) -> Path:
    candidate = target_dir / file_name
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while candidate.exists() or str(candidate).lower() in reserved:
        counter += 1
        candidate = target_dir / f"{stem}_{counter}{suffix}"
    reserved.add(str(candidate).lower())
    return candidate


def _serialize_batch(batch: dict[str, Any], counts: dict[str, int]) -> dict[str, Any]:
    payload = dict(batch)
    payload["selected_roots"] = json.loads(payload.get("selected_roots") or "[]")
    payload["counts"] = counts
    return payload


@dataclass(slots=True)
class BatchPlan:
    actions: list[PlannedAction]
    action_by_item_id: dict[int, str]
    counts: dict[str, int]
    auto_bad_item_ids: list[int]


def _load_batch(db: Database, batch_uid: str, device_id: int | None = None) -> dict[str, Any]:
    batch = db.get_review_batch(batch_uid, device_id)
    if not batch:
        raise MobileValidationError("Батч не найден")
    return batch


def create_pairing_code(db: Database, ttl_minutes: int = PAIRING_TTL_MINUTES) -> dict[str, str]:
    code = secrets.token_hex(3).upper()
    created_at = utc_now()
    expires_at = (datetime.now(UTC) + timedelta(minutes=ttl_minutes)).isoformat(timespec="seconds")
    db.create_mobile_pairing_code(_hash_secret(code), created_at, expires_at)
    return {"code": code, "created_at": created_at, "expires_at": expires_at}


def pair_device(db: Database, code: str, device_name: str) -> dict[str, Any]:
    normalized_code = code.strip().upper()
    if not normalized_code:
        raise MobileValidationError("Нужен pairing code")
    clean_name = device_name.strip()
    if not clean_name:
        raise MobileValidationError("Нужно имя устройства")
    with db.connect() as conn:
        row = conn.execute(
            """
            SELECT *
            FROM mobile_pairing_codes
            WHERE code_hash = ?
              AND consumed_at IS NULL
            ORDER BY id DESC
            LIMIT 1
            """,
            (_hash_secret(normalized_code),),
        ).fetchone()
        if not row:
            raise MobileAuthError("Неверный или уже использованный pairing code")
        record = dict(row)
        expires_at = _parse_utc(record["expires_at"])
        if not expires_at or expires_at < datetime.now(UTC):
            raise MobileAuthError("Pairing code уже истек")
        conn.execute(
            "UPDATE mobile_pairing_codes SET consumed_at = ? WHERE id = ?",
            (utc_now(), record["id"]),
        )
    access_token = secrets.token_urlsafe(32)
    created = db.create_mobile_device(
        clean_name,
        _hash_secret(access_token),
        created_at=utc_now(),
        last_seen_at=utc_now(),
    )
    return {
        "device": created,
        "access_token": access_token,
    }


def authenticate_device(db: Database, access_token: str) -> dict[str, Any]:
    token = access_token.strip()
    if not token:
        raise MobileAuthError("Нужен access token")
    device = db.get_mobile_device_by_token_hash(_hash_secret(token))
    if not device:
        raise MobileAuthError("Устройство не авторизовано")
    db.touch_mobile_device(int(device["id"]), utc_now())
    device["last_seen_at"] = utc_now()
    return device


def list_mobile_roots(db: Database) -> list[dict[str, Any]]:
    roots = db.list_mobile_root_counts()
    result: list[dict[str, Any]] = []
    for row in roots:
        total = int(row["total"])
        reserved = int(row["reserved"] or 0)
        result.append(
            {
                "root_name": row["root_name"],
                "total": total,
                "reserved": reserved,
                "available": max(0, total - reserved),
            }
        )
    return result


def create_review_batch(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    *,
    root_names: list[str] | None,
    batch_size: int,
    name: str | None = None,
) -> dict[str, Any]:
    if batch_size <= 0:
        raise MobileValidationError("batch_size должен быть положительным")
    selected_roots = sorted({item.strip() for item in (root_names or []) if item and item.strip()})
    available_roots = {item["root_name"] for item in list_mobile_roots(db)}
    unknown_roots = [root for root in selected_roots if root not in available_roots]
    if unknown_roots:
        raise MobileValidationError(f"Неизвестные папки: {', '.join(unknown_roots)}")
    images = db.list_available_review_images(selected_roots or None, batch_size)
    if not images:
        raise MobileValidationError("Нет доступных incoming-фото для нового батча")
    now = utc_now()
    batch_name = (name or "").strip() or (
        f"Mobile batch: {', '.join(selected_roots)}" if selected_roots else "Mobile batch"
    )
    batch = db.create_review_batch(
        uid=secrets.token_hex(12),
        device_id=int(device["id"]),
        name=batch_name,
        selected_roots=json.dumps(selected_roots, ensure_ascii=False),
        total_items=len(images),
        created_at=now,
        updated_at=now,
    )
    items = []
    for position, image in enumerate(images):
        items.append(
            {
                "image_id": image["id"],
                "position": position,
                "snapshot_path": image["path"],
                "snapshot_root_name": image["root_name"],
                "snapshot_file_name": image["file_name"],
                "snapshot_width": image["width"],
                "snapshot_height": image["height"],
                "snapshot_size_bytes": image["size_bytes"],
            }
        )
    db.add_review_batch_items(int(batch["id"]), items)
    return get_review_batch(db, config, device, str(batch["uid"]))


def get_review_batch(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    counts = db.review_batch_decision_counts(int(batch["id"]))
    payload = _serialize_batch(batch, counts)
    payload["available_originals"] = _count_available_originals(db, int(batch["id"]))
    return payload


def list_review_batches(db: Database, config: AppConfig, device: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for batch in db.list_review_batches(int(device["id"])):
        counts = db.review_batch_decision_counts(int(batch["id"]))
        payload = _serialize_batch(batch, counts)
        payload["available_originals"] = _count_available_originals(db, int(batch["id"]))
        result.append(payload)
    return result


def _count_available_originals(db: Database, batch_id: int) -> int:
    items = db.list_review_batch_items(batch_id, limit=100000, offset=0)
    total = 0
    for item in items:
        if item.get("is_deleted") == 0 and item.get("path"):
            total += 1
    return total


def list_review_batch_items(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
    *,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    rows = db.list_review_batch_items(int(batch["id"]), limit=limit, offset=offset)
    items = []
    for row in rows:
        active_path = row.get("path")
        is_available = row.get("is_deleted") == 0 and bool(active_path)
        items.append(
            {
                "id": row["id"],
                "image_id": row["image_id"],
                "position": row["position"],
                "decision": row["decision"],
                "client_updated_at": row["client_updated_at"],
                "decision_updated_at": row["decision_updated_at"],
                "applied_action": row["applied_action"],
                "applied_at": row["applied_at"],
                "root_name": row.get("root_name") or row["snapshot_root_name"],
                "file_name": row.get("file_name") or row["snapshot_file_name"],
                "width": row.get("width") or row["snapshot_width"],
                "height": row.get("height") or row["snapshot_height"],
                "size_bytes": row.get("size_bytes") or row["snapshot_size_bytes"],
                "is_available": is_available,
                "original_url": f"/api/mobile/batches/{batch_uid}/items/{row['id']}/original" if is_available else None,
            }
        )
    return {
        "batch": _serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"]))),
        "items": items,
        "limit": limit,
        "offset": offset,
    }


def sync_review_batch(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
    *,
    cursor_index: int | None,
    updates: list[dict[str, Any]],
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    batch_id = int(batch["id"])
    total_items = int(batch["total_items"])
    if cursor_index is not None and (cursor_index < 0 or cursor_index > total_items):
        raise MobileValidationError("cursor_index вне диапазона батча")
    applied = 0
    skipped = 0
    batch_items = {item["id"]: item for item in db.list_review_batch_items(batch_id, limit=100000, offset=0)}
    for update in updates:
        item_id = int(update.get("item_id", 0))
        if item_id not in batch_items:
            raise MobileValidationError(f"Элемент {item_id} не принадлежит батчу")
        decision = update.get("decision")
        if decision == "clear":
            decision = None
        if decision not in VALID_DECISIONS:
            raise MobileValidationError("Некорректное решение, ожидается good/bad/purge/clear")
        client_updated_at = update.get("client_updated_at") or utc_now()
        existing = batch_items[item_id]
        if existing.get("applied_at"):
            skipped += 1
            continue
        existing_client_dt = _parse_utc(existing.get("client_updated_at"))
        new_client_dt = _parse_utc(client_updated_at)
        if existing_client_dt and new_client_dt and new_client_dt < existing_client_dt:
            skipped += 1
            continue
        db.update_review_batch_item_decision(
            batch_id,
            item_id,
            decision,
            client_updated_at,
            utc_now(),
        )
        applied += 1
    db.update_review_batch(
        batch_id,
        cursor_index=cursor_index if cursor_index is not None else int(batch["cursor_index"]),
        updated_at=utc_now(),
    )
    return {
        "updated": applied,
        "skipped": skipped,
        "batch": get_review_batch(db, config, device, batch_uid),
    }


def plan_review_batch_apply(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    plan = _build_batch_plan(
        db,
        config,
        int(batch["id"]),
        include_pending_as_bad=_batch_is_fully_reviewed(batch),
    )
    preview = [
        {
            "kind": action.kind,
            "old_path": action.old_path,
            "new_path": action.new_path,
            "note": action.note,
        }
        for action in plan.actions[:100]
    ]
    return {
        "batch": _serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"]))),
        "total": len(plan.actions),
        "counts": plan.counts,
        "auto_bad_pending": len(plan.auto_bad_item_ids),
        "requires_purge_confirmation": plan.counts.get("purge", 0) > 0,
        "preview": preview,
    }


def apply_review_batch(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
    *,
    confirm_purge: bool,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    batch_id = int(batch["id"])
    plan = _build_batch_plan(
        db,
        config,
        batch_id,
        include_pending_as_bad=_batch_is_fully_reviewed(batch),
    )
    if plan.counts.get("purge", 0) > 0 and not confirm_purge:
        raise MobileValidationError("Для purge-операций нужно confirm_purge=true")
    result = apply_planned_actions(db, config, plan.actions)
    item_ids = list(plan.action_by_item_id.keys())
    applied_at = utc_now()
    if plan.auto_bad_item_ids:
        db.bulk_update_review_batch_item_decisions(
            [("bad", applied_at, applied_at, item_id) for item_id in plan.auto_bad_item_ids]
        )
    applied_rows = [(plan.action_by_item_id[item_id], applied_at, item_id) for item_id in item_ids]
    db.mark_review_batch_items_applied(applied_rows)
    remaining = _build_batch_plan(db, config, batch_id)
    if remaining.actions:
        db.update_review_batch(batch_id, updated_at=applied_at)
    else:
        db.update_review_batch(batch_id, status="completed", updated_at=applied_at, completed_at=applied_at)
    return {
        "applied_items": len(item_ids),
        "counts": plan.counts,
        "result": result,
        "batch": get_review_batch(db, config, device, batch_uid),
    }


def resolve_review_batch_item_path(
    db: Database,
    device: dict[str, Any],
    batch_uid: str,
    item_id: int,
) -> Path:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    item = db.get_review_batch_item(int(batch["id"]), item_id)
    if not item:
        raise MobileValidationError("Элемент батча не найден")
    if item.get("is_deleted") != 0 or not item.get("path"):
        raise MobileValidationError("Оригинал больше недоступен")
    return Path(str(item["path"]))


def _batch_is_fully_reviewed(batch: dict[str, Any]) -> bool:
    total_items = int(batch.get("total_items") or 0)
    if total_items <= 0:
        return False
    return int(batch.get("cursor_index") or 0) >= total_items - 1


def _build_batch_plan(
    db: Database,
    config: AppConfig,
    batch_id: int,
    *,
    include_pending_as_bad: bool = False,
) -> BatchPlan:
    items = db.list_review_batch_items(batch_id, limit=100000, offset=0)
    reserved_targets: set[str] = set()
    actions: list[PlannedAction] = []
    action_by_item_id: dict[int, str] = {}
    counts = {"good": 0, "bad": 0, "purge": 0, "skipped": 0}
    auto_bad_item_ids: list[int] = []
    for item in items:
        decision = item.get("decision")
        if decision is None and include_pending_as_bad:
            decision = "bad"
            auto_bad_item_ids.append(int(item["id"]))
        if decision not in {"good", "bad", "purge"}:
            continue
        if item.get("applied_at"):
            continue
        current_path = item.get("path")
        if item.get("is_deleted") != 0 or not current_path:
            counts["skipped"] += 1
            continue
        if decision == "purge":
            actions.append(
                PlannedAction(
                    kind="purge",
                    image_id=item.get("image_id"),
                    old_path=str(current_path),
                    new_path=None,
                    note=f"review_batch={batch_id}",
                )
            )
            action_by_item_id[int(item["id"])] = "purge"
            counts["purge"] += 1
            continue
        target_dir = config.approved_dir if decision == "good" else config.rejected_dir
        target_path = _review_target_path(target_dir, str(item.get("file_name") or item["snapshot_file_name"]), reserved_targets)
        actions.append(
            PlannedAction(
                kind="move",
                image_id=item.get("image_id"),
                old_path=str(current_path),
                new_path=str(target_path),
                note=f"mobile_selection={decision};batch={batch_id}",
            )
        )
        action_by_item_id[int(item["id"])] = decision
        counts[decision] += 1
    return BatchPlan(actions=actions, action_by_item_id=action_by_item_id, counts=counts, auto_bad_item_ids=auto_bad_item_ids)


def mobile_capabilities(config: AppConfig) -> dict[str, Any]:
    return {
        "selection_modes": ["single", "feed", "grid-masonry"],
        "supports_originals_only": True,
        "supports_partial_sync": True,
        "supports_purge": True,
        "approved_dir": str(config.approved_dir),
        "rejected_dir": str(config.rejected_dir),
    }


def admin_mobile_overview(db: Database, config: AppConfig) -> dict[str, Any]:
    devices = db.list_mobile_devices()
    batches = db.list_all_review_batches()
    return {
        "capabilities": mobile_capabilities(config),
        "roots": list_mobile_roots(db),
        "devices": devices,
        "batches": [_serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"]))) for batch in batches],
        "stats": db.mobile_stats(),
    }


def admin_list_batches(
    db: Database,
    config: AppConfig,
    *,
    status: str | None = None,
    device_id: int | None = None,
) -> list[dict[str, Any]]:
    batches = db.list_all_review_batches(status=status, device_id=device_id)
    result = []
    for batch in batches:
        payload = _serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"])))
        payload["available_originals"] = _count_available_originals(db, int(batch["id"]))
        result.append(payload)
    return result


def admin_get_batch(db: Database, config: AppConfig, batch_uid: str) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    device = db.get_mobile_device(int(batch["device_id"]))
    if device:
        batch["device_name"] = device["device_name"]
        batch["device_last_seen_at"] = device["last_seen_at"]
        batch["device_revoked_at"] = device["revoked_at"]
    payload = _serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"])))
    payload["available_originals"] = _count_available_originals(db, int(batch["id"]))
    return payload


def admin_list_batch_items(
    db: Database,
    config: AppConfig,
    batch_uid: str,
    *,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    rows = db.list_review_batch_items(int(batch["id"]), limit=limit, offset=offset)
    items = []
    for row in rows:
        current_path = row.get("path")
        is_available = row.get("is_deleted") == 0 and bool(current_path)
        items.append(
            {
                "id": row["id"],
                "image_id": row["image_id"],
                "position": row["position"],
                "decision": row["decision"],
                "client_updated_at": row["client_updated_at"],
                "decision_updated_at": row["decision_updated_at"],
                "applied_action": row["applied_action"],
                "applied_at": row["applied_at"],
                "root_name": row.get("root_name") or row["snapshot_root_name"],
                "file_name": row.get("file_name") or row["snapshot_file_name"],
                "width": row.get("width") or row["snapshot_width"],
                "height": row.get("height") or row["snapshot_height"],
                "size_bytes": row.get("size_bytes") or row["snapshot_size_bytes"],
                "is_available": is_available,
                "current_path": current_path,
                "preview_url": f"/media?path={current_path}" if is_available else None,
            }
        )
    return {
        "batch": admin_get_batch(db, config, batch_uid),
        "items": items,
        "limit": limit,
        "offset": offset,
    }


def admin_plan_review_batch_apply(db: Database, config: AppConfig, batch_uid: str) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    plan = _build_batch_plan(db, config, int(batch["id"]))
    preview = [
        {
            "kind": action.kind,
            "old_path": action.old_path,
            "new_path": action.new_path,
            "note": action.note,
        }
        for action in plan.actions[:100]
    ]
    return {
        "batch": admin_get_batch(db, config, batch_uid),
        "total": len(plan.actions),
        "counts": plan.counts,
        "requires_purge_confirmation": plan.counts.get("purge", 0) > 0,
        "preview": preview,
    }


def admin_apply_review_batch(
    db: Database,
    config: AppConfig,
    batch_uid: str,
    *,
    confirm_purge: bool,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    device = {"id": batch["device_id"]}
    return apply_review_batch(db, config, device, batch_uid, confirm_purge=confirm_purge)


def admin_cancel_review_batch(db: Database, config: AppConfig, batch_uid: str) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    if batch["status"] != "open":
        raise MobileValidationError("Отменять можно только открытый батч")
    canceled_at = utc_now()
    db.update_review_batch(
        int(batch["id"]),
        status="canceled",
        updated_at=canceled_at,
        completed_at=canceled_at,
    )
    return admin_get_batch(db, config, batch_uid)


def admin_complete_review_batch(db: Database, config: AppConfig, batch_uid: str) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid)
    completed_at = utc_now()
    db.update_review_batch(
        int(batch["id"]),
        status="completed",
        updated_at=completed_at,
        completed_at=completed_at,
    )
    return admin_get_batch(db, config, batch_uid)


def delete_review_batch(
    db: Database,
    config: AppConfig,
    device: dict[str, Any],
    batch_uid: str,
) -> dict[str, Any]:
    batch = _load_batch(db, batch_uid, int(device["id"]))
    if batch["status"] == "open":
        raise MobileValidationError("Открытый батч сначала нужно завершить или отменить")
    payload = _serialize_batch(batch, db.review_batch_decision_counts(int(batch["id"])))
    db.delete_review_batch(int(batch["id"]))
    return {"deleted": True, "batch": payload}


def admin_revoke_device(db: Database, config: AppConfig, device_id: int) -> dict[str, Any]:
    device = db.get_mobile_device(device_id)
    if not device:
        raise MobileValidationError("Устройство не найдено")
    revoked_at = utc_now()
    db.revoke_mobile_device(device_id, revoked_at)
    for batch in db.list_review_batches(device_id, status="open"):
        db.update_review_batch(
            int(batch["id"]),
            status="canceled",
            updated_at=revoked_at,
            completed_at=revoked_at,
        )
    updated = db.get_mobile_device(device_id)
    if not updated:
        raise MobileValidationError("Устройство не найдено после revoke")
    return updated
