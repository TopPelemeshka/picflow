from __future__ import annotations

import unittest
import uuid
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from picflow.config import AppConfig, DuplicateThresholds
from picflow.db import Database
from picflow.duplicates import build_duplicate_candidates, compare_images, plan_duplicate_actions, scan_library, utc_now
from picflow.hashing import image_record_for_path


ROOT = Path(__file__).resolve().parent.parent
SCRATCH = ROOT / "test_scratch"
SCRATCH.mkdir(exist_ok=True)


def create_base_image(path: Path) -> None:
    image = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 236, 236), outline="black", width=6)
    draw.ellipse((70, 80, 190, 200), fill="tomato", outline="black")
    draw.line((30, 220, 220, 40), fill="navy", width=10)
    image.save(path, quality=95)


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


class PicFlowSmokeTests(unittest.TestCase):
    def make_case_dir(self) -> Path:
        target = SCRATCH / uuid.uuid4().hex
        target.mkdir(parents=True, exist_ok=True)
        return target

    def test_compare_images_accepts_slight_crop(self) -> None:
        tmp_path = self.make_case_dir()
        base_path = tmp_path / "base.jpg"
        cropped_path = tmp_path / "cropped.jpg"
        create_base_image(base_path)

        base = Image.open(base_path)
        cropped = base.crop((10, 10, 246, 246)).resize((256, 256))
        cropped.save(cropped_path, quality=90)

        base_record = image_record_for_path(base_path, tmp_path / "thumb_base.jpg")
        cropped_record = image_record_for_path(cropped_path, tmp_path / "thumb_cropped.jpg")

        metrics = compare_images(base_record, cropped_record, DuplicateThresholds())
        self.assertIsNotNone(metrics)
        assert metrics is not None
        self.assertGreater(metrics["candidate_score"], 0.3)

    def test_compare_images_rejects_different_image(self) -> None:
        tmp_path = self.make_case_dir()
        left_path = tmp_path / "left.jpg"
        right_path = tmp_path / "right.jpg"
        create_base_image(left_path)

        base = Image.open(left_path)
        inverted = ImageChops.invert(base.convert("RGB"))
        inverted.save(right_path, quality=95)

        left_record = image_record_for_path(left_path, tmp_path / "thumb_left.jpg")
        right_record = image_record_for_path(right_path, tmp_path / "thumb_right.jpg")
        self.assertIsNone(compare_images(left_record, right_record, DuplicateThresholds()))

    def test_plan_keeps_reference_image(self) -> None:
        tmp_path = self.make_case_dir()
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
        self.assertIn("meme_copy.jpg", delete_targets)
        self.assertNotIn("meme.jpg", delete_targets)

    def test_plan_renames_global_filename_collision(self) -> None:
        tmp_path = self.make_case_dir()
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
        self.assertEqual(len(rename_actions), 1)
        self.assertIsNotNone(rename_actions[0].new_path)
        assert rename_actions[0].new_path is not None
        self.assertIn("2_batch", rename_actions[0].new_path)


if __name__ == "__main__":
    unittest.main()
