from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from picflow.config import AppConfig
from picflow.db import Database
from picflow.duplicates import build_duplicate_candidates, plan_duplicate_actions, scan_library, utc_now


def make_image(path: Path, color: str, text: str) -> None:
    image = Image.new("RGB", (180, 180), color)
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 160, 160), outline="black", width=4)
    draw.text((34, 80), text, fill="white")
    image.save(path, quality=95)


def make_config(tmp_path: Path) -> AppConfig:
    library_root = tmp_path / "library"
    config = AppConfig(
        project_root=tmp_path,
        library_root=library_root,
        state_dir=tmp_path / ".picflow",
        database_path=tmp_path / ".picflow" / "picflow.sqlite3",
        thumbnail_dir=tmp_path / ".picflow" / "thumbnails",
        quarantine_dir=tmp_path / ".picflow" / "quarantine",
    )
    config.ensure_state_dirs()
    return config


def test_plan_keeps_reference_image(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    reference_dir = config.reference_dir / "standart-meme"
    incoming_dir = config.library_root / "1_batch"
    reference_dir.mkdir(parents=True)
    incoming_dir.mkdir(parents=True)

    reference_file = reference_dir / "meme.jpg"
    incoming_file = incoming_dir / "meme_copy.jpg"
    make_image(reference_file, "purple", "same")
    incoming_file.write_bytes(reference_file.read_bytes())

    db = Database(config.database_path)
    db.init()
    scan_library(db, config)
    build_duplicate_candidates(db, config)

    candidate = db.list_candidates("all", 10, 0)[0]
    db.update_candidate_manual(candidate["id"], "duplicate", utc_now())

    actions = plan_duplicate_actions(db, config)
    delete_targets = {Path(action.old_path).name for action in actions if action.kind == "delete"}
    assert "meme_copy.jpg" in delete_targets
    assert "meme.jpg" not in delete_targets


def test_plan_renames_global_filename_collision(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    left_dir = config.library_root / "1_batch"
    right_dir = config.library_root / "2_batch"
    left_dir.mkdir(parents=True)
    right_dir.mkdir(parents=True)

    make_image(left_dir / "same_name.jpg", "teal", "one")
    make_image(right_dir / "same_name.jpg", "orange", "two")

    db = Database(config.database_path)
    db.init()
    scan_library(db, config)

    actions = plan_duplicate_actions(db, config)
    rename_actions = [action for action in actions if action.kind == "rename"]
    assert len(rename_actions) == 1
    assert rename_actions[0].new_path is not None
    assert "2_batch" in rename_actions[0].new_path
