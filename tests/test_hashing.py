from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from picflow.config import DuplicateThresholds
from picflow.duplicates import compare_images
from picflow.hashing import image_record_for_path


def create_base_image(path: Path) -> None:
    image = Image.new("RGB", (256, 256), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 236, 236), outline="black", width=6)
    draw.ellipse((70, 80, 190, 200), fill="tomato", outline="black")
    draw.line((30, 220, 220, 40), fill="navy", width=10)
    image.save(path, quality=95)


def test_compare_images_accepts_slight_crop(tmp_path: Path) -> None:
    base_path = tmp_path / "base.jpg"
    cropped_path = tmp_path / "cropped.jpg"
    create_base_image(base_path)

    base = Image.open(base_path)
    cropped = base.crop((10, 10, 246, 246)).resize((256, 256))
    cropped.save(cropped_path, quality=90)

    base_record = image_record_for_path(base_path, tmp_path / "thumb_base.jpg")
    cropped_record = image_record_for_path(cropped_path, tmp_path / "thumb_cropped.jpg")

    metrics = compare_images(base_record, cropped_record, DuplicateThresholds())
    assert metrics is not None
    assert metrics["candidate_score"] > 0.4


def test_compare_images_rejects_different_image(tmp_path: Path) -> None:
    left_path = tmp_path / "left.jpg"
    right_path = tmp_path / "right.jpg"
    create_base_image(left_path)

    base = Image.open(left_path)
    inverted = ImageChops.invert(base.convert("RGB"))
    inverted.save(right_path, quality=95)

    left_record = image_record_for_path(left_path, tmp_path / "thumb_left.jpg")
    right_record = image_record_for_path(right_path, tmp_path / "thumb_right.jpg")

    assert compare_images(left_record, right_record, DuplicateThresholds()) is None
