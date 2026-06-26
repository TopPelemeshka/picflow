from __future__ import annotations

import unittest
import uuid
from pathlib import Path

from PIL import Image, ImageDraw

from picflow.config import AppConfig
from picflow.db import Database
from picflow.mobile import (
    MobileValidationError,
    admin_revoke_device,
    authenticate_device,
    create_pairing_code,
    create_review_batch,
    delete_review_batch,
    list_mobile_roots,
    list_review_batch_items,
    pair_device,
    plan_review_batch_apply,
    sync_review_batch,
    apply_review_batch,
)
from picflow.duplicates import scan_library

ROOT = Path(__file__).resolve().parent.parent
SCRATCH = ROOT / "test_scratch"
SCRATCH.mkdir(exist_ok=True)


def make_image(path: Path, color: str, text: str) -> None:
    image = Image.new("RGB", (180, 240), color)
    draw = ImageDraw.Draw(image)
    draw.rectangle((16, 16, 164, 224), outline="black", width=4)
    draw.text((32, 108), text, fill="white")
    path.parent.mkdir(parents=True, exist_ok=True)
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


def pair_test_device(db: Database) -> dict:
    payload = create_pairing_code(db, ttl_minutes=5)
    paired = pair_device(db, payload["code"], "Pixel test")
    return authenticate_device(db, paired["access_token"])


class MobileFlowTests(unittest.TestCase):
    def make_case_dir(self) -> Path:
        target = SCRATCH / uuid.uuid4().hex
        target.mkdir(parents=True, exist_ok=True)
        return target

    def test_mobile_batch_apply_reviews_only_reviewed_items(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        make_image(config.library_root / "1_batch" / "good.jpg", "green", "good")
        make_image(config.library_root / "1_batch" / "bad.jpg", "red", "bad")
        make_image(config.library_root / "1_batch" / "later.jpg", "blue", "later")

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        device = pair_test_device(db)

        roots = list_mobile_roots(db)
        self.assertEqual(roots[0]["root_name"], "1_batch")
        self.assertEqual(roots[0]["available"], 3)

        batch = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=3)
        page = list_review_batch_items(db, config, device, batch["uid"], limit=10, offset=0)
        self.assertEqual(len(page["items"]), 3)
        self.assertTrue(all(item["original_url"] for item in page["items"]))

        updates = [
            {"item_id": page["items"][0]["id"], "decision": "bad", "client_updated_at": "2026-06-26T10:00:00+00:00"},
            {"item_id": page["items"][1]["id"], "decision": "good", "client_updated_at": "2026-06-26T10:00:01+00:00"},
        ]
        synced = sync_review_batch(
            db,
            config,
            device,
            batch["uid"],
            cursor_index=1,
            updates=updates,
        )
        self.assertEqual(synced["updated"], 2)
        self.assertEqual(synced["batch"]["cursor_index"], 1)
        self.assertEqual(synced["batch"]["counts"]["good"], 1)
        self.assertEqual(synced["batch"]["counts"]["bad"], 1)
        self.assertEqual(synced["batch"]["counts"]["pending"], 1)

        plan = plan_review_batch_apply(db, config, device, batch["uid"])
        self.assertEqual(plan["total"], 2)
        self.assertEqual(plan["counts"]["good"], 1)
        self.assertEqual(plan["counts"]["bad"], 1)
        self.assertFalse(plan["requires_purge_confirmation"])

        result = apply_review_batch(db, config, device, batch["uid"], confirm_purge=False)
        self.assertEqual(result["applied_items"], 2)
        self.assertTrue((config.approved_dir / "good.jpg").exists() or (config.approved_dir / "bad.jpg").exists())
        self.assertTrue((config.rejected_dir / "good.jpg").exists() or (config.rejected_dir / "bad.jpg").exists())
        self.assertTrue((config.library_root / "1_batch" / "later.jpg").exists())

    def test_mobile_batch_reserves_images_from_other_open_batches(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        for name, color in [("one.jpg", "green"), ("two.jpg", "red"), ("three.jpg", "blue")]:
            make_image(config.library_root / "1_batch" / name, color, name)

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        device = pair_test_device(db)

        first = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=2)
        second = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=2)

        first_items = list_review_batch_items(db, config, device, first["uid"], limit=10, offset=0)["items"]
        second_items = list_review_batch_items(db, config, device, second["uid"], limit=10, offset=0)["items"]

        self.assertEqual(len(first_items), 2)
        self.assertEqual(len(second_items), 1)
        first_names = {item["file_name"] for item in first_items}
        second_names = {item["file_name"] for item in second_items}
        self.assertTrue(first_names.isdisjoint(second_names))

    def test_mobile_purge_requires_confirmation(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        original = config.library_root / "1_batch" / "delete_me.jpg"
        make_image(original, "purple", "purge")

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        device = pair_test_device(db)
        batch = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=1)
        item = list_review_batch_items(db, config, device, batch["uid"], limit=1, offset=0)["items"][0]

        sync_review_batch(
            db,
            config,
            device,
            batch["uid"],
            cursor_index=1,
            updates=[{"item_id": item["id"], "decision": "purge", "client_updated_at": "2026-06-26T10:00:00+00:00"}],
        )
        plan = plan_review_batch_apply(db, config, device, batch["uid"])
        self.assertTrue(plan["requires_purge_confirmation"])

        with self.assertRaises(MobileValidationError):
            apply_review_batch(db, config, device, batch["uid"], confirm_purge=False)

        result = apply_review_batch(db, config, device, batch["uid"], confirm_purge=True)
        self.assertEqual(result["applied_items"], 1)
        self.assertFalse(original.exists())

    def test_admin_revoke_device_cancels_open_batches_and_releases_items(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        for name, color in [("one.jpg", "green"), ("two.jpg", "red")]:
            make_image(config.library_root / "1_batch" / name, color, name)

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        first_device = pair_test_device(db)
        batch = create_review_batch(db, config, first_device, root_names=["1_batch"], batch_size=2)
        self.assertEqual(batch["status"], "open")

        revoked = admin_revoke_device(db, config, int(first_device["id"]))
        self.assertIsNotNone(revoked["revoked_at"])

        second_device = pair_test_device(db)
        second_batch = create_review_batch(db, config, second_device, root_names=["1_batch"], batch_size=2)
        self.assertEqual(second_batch["total_items"], 2)

    def test_mobile_can_delete_canceled_batch(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        for name, color in [("one.jpg", "green"), ("two.jpg", "red")]:
            make_image(config.library_root / "1_batch" / name, color, name)

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        device = pair_test_device(db)

        batch = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=2)
        db.update_review_batch(int(batch["id"]), status="canceled", updated_at="2026-06-27T00:00:00+00:00", completed_at="2026-06-27T00:00:00+00:00")

        deleted = delete_review_batch(db, config, device, batch["uid"])
        self.assertTrue(deleted["deleted"])
        self.assertEqual(deleted["batch"]["status"], "canceled")
        self.assertIsNone(db.get_review_batch(batch["uid"], int(device["id"])))

        second_batch = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=2)
        self.assertEqual(second_batch["total_items"], 2)

    def test_finished_batch_applies_pending_items_as_bad(self) -> None:
        tmp_path = self.make_case_dir()
        config = make_config(tmp_path)
        make_image(config.library_root / "1_batch" / "like.jpg", "green", "like")
        make_image(config.library_root / "1_batch" / "skip_a.jpg", "red", "skip_a")
        make_image(config.library_root / "1_batch" / "skip_b.jpg", "blue", "skip_b")

        db = Database(config.database_path)
        db.init()
        scan_library(db, config)
        device = pair_test_device(db)

        batch = create_review_batch(db, config, device, root_names=["1_batch"], batch_size=3)
        items = list_review_batch_items(db, config, device, batch["uid"], limit=10, offset=0)["items"]
        like_item = next(item for item in items if item["file_name"] == "like.jpg")

        sync_review_batch(
            db,
            config,
            device,
            batch["uid"],
            cursor_index=2,
            updates=[{"item_id": like_item["id"], "decision": "good", "client_updated_at": "2026-06-26T10:00:00+00:00"}],
        )

        plan = plan_review_batch_apply(db, config, device, batch["uid"])
        self.assertEqual(plan["counts"]["good"], 1)
        self.assertEqual(plan["counts"]["bad"], 2)
        self.assertEqual(plan["auto_bad_pending"], 2)

        result = apply_review_batch(db, config, device, batch["uid"], confirm_purge=False)
        self.assertEqual(result["applied_items"], 3)
        self.assertEqual(result["batch"]["status"], "completed")
        self.assertTrue((config.approved_dir / "like.jpg").exists())
        self.assertTrue((config.rejected_dir / "skip_a.jpg").exists())
        self.assertTrue((config.rejected_dir / "skip_b.jpg").exists())


if __name__ == "__main__":
    unittest.main()
