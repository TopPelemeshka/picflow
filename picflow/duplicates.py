from __future__ import annotations

import shutil
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

from .config import AppConfig, DuplicateThresholds
from .db import Database
from .hashing import hamming_distance, image_record_for_path


ProgressCallback = Callable[[float, str], None]


ROLE_KEEP_RANK = {
    "reference": 0,
    "export": 0,
    "approved": 1,
    "incoming": 2,
    "rejected": 3,
    "external": 4,
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class BKTree:
    def __init__(self) -> None:
        self.value: int | None = None
        self.ids: list[int] = []
        self.children: dict[int, BKTree] = {}

    def add(self, value: int, image_id: int) -> None:
        if self.value is None:
            self.value = value
            self.ids = [image_id]
            return
        distance = (value ^ self.value).bit_count()
        if distance == 0:
            self.ids.append(image_id)
            return
        child = self.children.get(distance)
        if child is None:
            child = BKTree()
            self.children[distance] = child
        child.add(value, image_id)

    def query(self, value: int, max_distance: int) -> set[int]:
        if self.value is None:
            return set()
        found = set()
        distance = (value ^ self.value).bit_count()
        if distance <= max_distance:
            found.update(self.ids)
        lower = distance - max_distance
        upper = distance + max_distance
        for edge, child in self.children.items():
            if lower <= edge <= upper:
                found.update(child.query(value, max_distance))
        return found


def iter_library_images(config: AppConfig) -> list[Path]:
    extensions = {value.lower() for value in config.supported_extensions}
    items: list[Path] = []
    for path in config.library_root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in extensions:
            continue
        try:
            rel = path.resolve().relative_to(config.library_root.resolve())
        except ValueError:
            continue
        if not rel.parts:
            continue
        if rel.parts[0] in config.excluded_top_level_dirs:
            continue
        items.append(path)
    return sorted(items)


def scan_library(
    db: Database,
    config: AppConfig,
    progress: ProgressCallback | None = None,
) -> dict[str, int]:
    started_at = utc_now()
    config.ensure_state_dirs()
    existing = db.fetch_image_index()
    paths = iter_library_images(config)
    active_paths: set[str] = set()
    scanned = 0
    reused = 0
    errors = 0
    total = max(1, len(paths))
    for index, path in enumerate(paths, start=1):
        path_str = str(path.resolve())
        active_paths.add(path_str)
        role = config.role_for_path(path)
        root_name = path.relative_to(config.library_root).parts[0]
        category_hint = config.category_for_path(path)
        stat = path.stat()
        cached = existing.get(path_str)
        try:
            if cached and cached["mtime_ns"] == stat.st_mtime_ns and cached["size_bytes"] == stat.st_size:
                db.touch_existing_image(
                    path_str,
                    root_name=root_name,
                    role=role,
                    category_hint=category_hint,
                    last_scanned_at=started_at,
                )
                reused += 1
            else:
                thumb_name = f"{path.stem}_{stat.st_mtime_ns}.jpg"
                thumb_path = config.thumbnail_dir / root_name / thumb_name
                hashed = image_record_for_path(path, thumb_path)
                db.upsert_image(
                    {
                        "path": path_str,
                        "root_name": root_name,
                        "role": role,
                        "category_hint": category_hint,
                        "file_name": path.name,
                        "extension": path.suffix.lower(),
                        "last_scanned_at": started_at,
                        "is_deleted": 0,
                        **hashed,
                    }
                )
                scanned += 1
        except Exception as exc:  # noqa: BLE001
            errors += 1
            db.log_action(
                "scan_error",
                old_path=path_str,
                note=str(exc),
                created_at=utc_now(),
            )
        if progress:
            progress(index / total, f"Сканирование {index}/{len(paths)}")
    missing = db.mark_missing_images(active_paths, started_at)
    return {
        "discovered": len(paths),
        "scanned": scanned,
        "reused": reused,
        "missing": missing,
        "errors": errors,
    }


def _pair_order(left_id: int, right_id: int) -> tuple[int, int]:
    return (left_id, right_id) if left_id < right_id else (right_id, left_id)


def _candidate_score(metrics: dict[str, float], thresholds: DuplicateThresholds) -> float:
    if metrics["exact_hash_match"]:
        return 1.0
    strong = max(0.0, 1.0 - (metrics["phash_distance"] + metrics["dhash_distance"] + metrics["ahash_distance"]) / 36.0)
    crop = max(0.0, 1.0 - (metrics["center_phash_distance"] + metrics["center_dhash_distance"]) / 28.0)
    size_bonus = 0.1 if metrics["size_ratio"] >= thresholds.min_size_ratio else 0.0
    return round(min(0.99, max(strong, crop) + size_bonus), 4)


def compare_images(left: dict, right: dict, thresholds: DuplicateThresholds) -> dict[str, float] | None:
    metrics = {
        "exact_hash_match": int(left["sha256"] == right["sha256"]),
        "phash_distance": hamming_distance(left["phash"], right["phash"]),
        "dhash_distance": hamming_distance(left["dhash"], right["dhash"]),
        "ahash_distance": hamming_distance(left["ahash"], right["ahash"]),
        "center_phash_distance": hamming_distance(left["center_phash"], right["center_phash"]),
        "center_dhash_distance": hamming_distance(left["center_dhash"], right["center_dhash"]),
        "size_ratio": round(min(left["area"], right["area"]) / max(left["area"], right["area"]), 4),
    }
    strong_match = (
        metrics["phash_distance"] <= thresholds.phash_distance
        and metrics["dhash_distance"] <= thresholds.dhash_distance
        and metrics["ahash_distance"] <= thresholds.ahash_distance
    )
    crop_match = (
        metrics["center_phash_distance"] <= thresholds.center_phash_distance
        and metrics["center_dhash_distance"] <= thresholds.center_dhash_distance
        and metrics["size_ratio"] >= thresholds.min_size_ratio
    )
    exact_match = bool(metrics["exact_hash_match"])
    if not (exact_match or strong_match or crop_match):
        return None
    metrics["candidate_score"] = _candidate_score(metrics, thresholds)
    return metrics


def build_duplicate_candidates(
    db: Database,
    config: AppConfig,
    progress: ProgressCallback | None = None,
) -> dict[str, int]:
    thresholds = config.duplicate_thresholds
    images = db.list_active_images()
    images.sort(key=lambda row: (ROLE_KEEP_RANK.get(row["role"], 9), row["root_name"], row["path"].lower()))
    db.clear_candidates()
    by_id = {row["id"]: row for row in images}
    sha_index: dict[str, list[int]] = defaultdict(list)
    phash_tree = BKTree()
    center_tree = BKTree()
    total = max(1, len(images))
    created = 0
    for index, image in enumerate(images, start=1):
        if progress:
            progress(index / total, f"Поиск кандидатов {index}/{len(images)}")
        candidate_ids: set[int] = set(sha_index.get(image["sha256"], []))
        candidate_ids.update(phash_tree.query(int(image["phash"], 16), thresholds.phash_distance))
        candidate_ids.update(center_tree.query(int(image["center_phash"], 16), thresholds.center_phash_distance))
        scored: list[tuple[float, dict[str, float], dict[str, object]]] = []
        for candidate_id in candidate_ids:
            other = by_id[candidate_id]
            if ROLE_KEEP_RANK.get(image["role"], 9) == 0 and ROLE_KEEP_RANK.get(other["role"], 9) == 0:
                continue
            metrics = compare_images(other, image, thresholds)
            if not metrics:
                continue
            scored.append((metrics["candidate_score"], metrics, other))
        scored.sort(key=lambda item: item[0], reverse=True)
        for _, metrics, other in scored[: thresholds.max_candidates_per_image]:
            left_id, right_id = _pair_order(other["id"], image["id"])
            db.upsert_candidate(
                {
                    "left_image_id": left_id,
                    "right_image_id": right_id,
                    "candidate_score": metrics["candidate_score"],
                    "exact_hash_match": metrics["exact_hash_match"],
                    "phash_distance": metrics["phash_distance"],
                    "dhash_distance": metrics["dhash_distance"],
                    "ahash_distance": metrics["ahash_distance"],
                    "center_phash_distance": metrics["center_phash_distance"],
                    "center_dhash_distance": metrics["center_dhash_distance"],
                    "size_ratio": metrics["size_ratio"],
                    "ai_label": None,
                    "ai_confidence": None,
                    "ai_reason": "",
                    "ai_raw_response": "",
                    "manual_label": None,
                    "created_at": utc_now(),
                    "updated_at": utc_now(),
                }
            )
            created += 1
        sha_index[image["sha256"]].append(image["id"])
        phash_tree.add(int(image["phash"], 16), image["id"])
        center_tree.add(int(image["center_phash"], 16), image["id"])
    return {"images": len(images), "candidates": created}


@dataclass(slots=True)
class PlannedAction:
    kind: str
    image_id: int | None
    old_path: str
    new_path: str | None
    note: str = ""


class UnionFind:
    def __init__(self) -> None:
        self.parents: dict[int, int] = {}

    def find(self, item: int) -> int:
        root = self.parents.setdefault(item, item)
        if root != item:
            self.parents[item] = self.find(root)
        return self.parents[item]

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parents[right_root] = left_root

    def groups(self) -> dict[int, list[int]]:
        result: dict[int, list[int]] = defaultdict(list)
        for item in self.parents:
            result[self.find(item)].append(item)
        return result


def keep_sort_key(image: dict) -> tuple[int, int, int, str]:
    return (
        ROLE_KEEP_RANK.get(image["role"], 9),
        -int(image["area"]),
        -int(image["size_bytes"]),
        image["path"].lower(),
    )


def plan_duplicate_actions(db: Database, config: AppConfig) -> list[PlannedAction]:
    images = {row["id"]: row for row in db.list_active_images()}
    pairs = db.confirmed_duplicate_pairs()
    union = UnionFind()
    for left_id, right_id in pairs:
        union.union(left_id, right_id)
    planned: list[PlannedAction] = []
    duplicate_ids: set[int] = set()
    for _, members in union.groups().items():
        if len(members) < 2:
            continue
        member_rows = [images[member] for member in members if member in images]
        if len(member_rows) < 2:
            continue
        keeper = min(member_rows, key=keep_sort_key)
        for image in member_rows:
            if image["id"] == keeper["id"]:
                continue
            duplicate_ids.add(image["id"])
            planned.append(
                PlannedAction(
                    kind="delete" if config.duplicate_action == "delete" else "quarantine",
                    image_id=image["id"],
                    old_path=image["path"],
                    new_path=str(config.quarantine_dir / image["root_name"] / image["file_name"])
                    if config.duplicate_action != "delete"
                    else None,
                    note=f"keep={keeper['path']}",
                )
            )
    remaining = [
        image
        for image_id, image in images.items()
        if image_id not in duplicate_ids and image["role"] in {"incoming", "approved", "rejected"}
    ]
    remaining.sort(key=lambda item: item["path"].lower())
    name_counts: dict[str, int] = defaultdict(int)
    used_names: set[str] = set()
    for image in remaining:
        original = image["file_name"]
        lowered = original.lower()
        if lowered not in used_names:
            used_names.add(lowered)
            continue
        stem = Path(original).stem
        extension = Path(original).suffix
        while True:
            name_counts[lowered] += 1
            candidate_name = f"{stem}_{image['root_name']}_{name_counts[lowered]}{extension}"
            if candidate_name.lower() not in used_names:
                used_names.add(candidate_name.lower())
                new_path = str(Path(image["path"]).with_name(candidate_name))
                planned.append(
                    PlannedAction(
                        kind="rename",
                        image_id=image["id"],
                        old_path=image["path"],
                        new_path=new_path,
                        note="filename collision",
                    )
                )
                break
    return planned


def apply_planned_actions(
    db: Database,
    config: AppConfig,
    actions: list[PlannedAction],
    progress: ProgressCallback | None = None,
) -> dict[str, int]:
    config.ensure_state_dirs()
    total = max(1, len(actions))
    deleted = 0
    renamed = 0
    for index, action in enumerate(actions, start=1):
        if progress:
            progress(index / total, f"Применение изменений {index}/{len(actions)}")
        old_path = Path(action.old_path)
        if action.kind == "delete":
            if old_path.exists():
                old_path.unlink()
            deleted += 1
        elif action.kind == "quarantine":
            target = Path(action.new_path or "")
            target.parent.mkdir(parents=True, exist_ok=True)
            if old_path.exists():
                shutil.move(str(old_path), str(target))
            deleted += 1
        elif action.kind == "rename":
            target = Path(action.new_path or "")
            target.parent.mkdir(parents=True, exist_ok=True)
            if old_path.exists():
                old_path.rename(target)
            renamed += 1
        db.log_action(
            action.kind,
            old_path=action.old_path,
            new_path=action.new_path,
            image_id=action.image_id,
            note=action.note,
            created_at=utc_now(),
        )
    summary = scan_library(db, config, progress=None)
    db.clear_candidates()
    return {"deleted_or_moved": deleted, "renamed": renamed, **summary}
