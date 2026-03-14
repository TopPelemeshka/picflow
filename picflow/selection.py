from __future__ import annotations

from pathlib import Path

from .config import AppConfig
from .db import Database
from .duplicates import PlannedAction, apply_planned_actions


def list_selection_items(db: Database, config: AppConfig, filter_mode: str, limit: int, offset: int) -> list[dict]:
    items = db.list_selection_images(filter_mode, limit, offset)
    for item in items:
        item["media_url"] = f"/media?path={item['path']}"
        item["effective_label"] = item.get("selection_label") or "pending"
        item["queue_label"] = item["root_name"]
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


def plan_selection_actions(db: Database, config: AppConfig, through_image_id: int) -> list[PlannedAction]:
    queue = db.list_selection_queue()
    if not queue:
        return []
    ids = [item["id"] for item in queue]
    if through_image_id not in ids:
        raise ValueError("through_image_id not found in incoming queue")
    limit_index = ids.index(through_image_id)
    reserved_targets: set[str] = set()
    actions: list[PlannedAction] = []
    for item in queue[: limit_index + 1]:
        label = item.get("selection_label") or "bad"
        target_dir = config.approved_dir if label == "good" else config.rejected_dir
        target_path = _unique_target_path(target_dir, item["file_name"], reserved_targets)
        actions.append(
            PlannedAction(
                kind="move",
                image_id=item["id"],
                old_path=item["path"],
                new_path=str(target_path),
                note=f"selection={label}",
            )
        )
    return actions


def apply_selection_actions(
    db: Database,
    config: AppConfig,
    through_image_id: int,
    progress=None,
) -> dict[str, int]:
    actions = plan_selection_actions(db, config, through_image_id)
    result = apply_planned_actions(db, config, actions, progress=progress)
    return {"selection_actions": len(actions), **result}
