from __future__ import annotations

import base64
import hashlib
import io
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps


Image.MAX_IMAGE_PIXELS = None


def sha256_for_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def load_normalized_image(path: Path) -> Image.Image:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    return image.convert("RGB")


@lru_cache(maxsize=8)
def _dct_matrix(size: int) -> np.ndarray:
    matrix = np.zeros((size, size), dtype=np.float32)
    factor = math.pi / (2.0 * size)
    scale0 = math.sqrt(1.0 / size)
    scale = math.sqrt(2.0 / size)
    for k in range(size):
        alpha = scale0 if k == 0 else scale
        for n in range(size):
            matrix[k, n] = alpha * math.cos((2 * n + 1) * k * factor)
    return matrix


def _dct2(values: np.ndarray) -> np.ndarray:
    matrix = _dct_matrix(values.shape[0])
    return matrix @ values @ matrix.T


def _bits_to_hex(bits: np.ndarray) -> str:
    payload = "".join("1" if int(bit) else "0" for bit in bits.flatten())
    return f"{int(payload, 2):0{len(payload) // 4}x}"


def _grayscale_array(image: Image.Image, size: tuple[int, int]) -> np.ndarray:
    return np.asarray(image.convert("L").resize(size, Image.Resampling.LANCZOS), dtype=np.float32)


def average_hash(image: Image.Image, hash_size: int = 8) -> str:
    pixels = _grayscale_array(image, (hash_size, hash_size))
    return _bits_to_hex(pixels > pixels.mean())


def difference_hash(image: Image.Image, hash_size: int = 8) -> str:
    pixels = _grayscale_array(image, (hash_size + 1, hash_size))
    return _bits_to_hex(pixels[:, 1:] > pixels[:, :-1])


def perceptual_hash(image: Image.Image, hash_size: int = 8, highfreq_factor: int = 4) -> str:
    size = hash_size * highfreq_factor
    pixels = _grayscale_array(image, (size, size))
    transformed = _dct2(pixels)
    low = transformed[:hash_size, :hash_size]
    median = np.median(low[1:, 1:])
    return _bits_to_hex(low > median)


def center_crop(image: Image.Image, scale: float = 0.82) -> Image.Image:
    width, height = image.size
    crop_width = max(16, int(width * scale))
    crop_height = max(16, int(height * scale))
    left = max(0, (width - crop_width) // 2)
    top = max(0, (height - crop_height) // 2)
    return image.crop((left, top, left + crop_width, top + crop_height))


def color_signature(image: Image.Image) -> str:
    array = np.asarray(image.resize((32, 32), Image.Resampling.BILINEAR), dtype=np.float32)
    averages = array.mean(axis=(0, 1))
    quantized = [str(int(channel // 16)) for channel in averages]
    return "-".join(quantized)


def hamming_distance(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def build_thumbnail(image: Image.Image, target_path: Path, max_side: int = 512) -> str:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    preview = image.copy()
    preview.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    preview.save(target_path, format="JPEG", quality=88)
    return str(target_path)


def image_record_for_path(path: Path, thumbnail_path: Path) -> dict[str, Any]:
    with load_normalized_image(path) as image:
        cropped = center_crop(image)
        preview_path = build_thumbnail(image, thumbnail_path)
        stat = path.stat()
        width, height = image.size
        return {
            "size_bytes": stat.st_size,
            "width": width,
            "height": height,
            "area": width * height,
            "mtime_ns": stat.st_mtime_ns,
            "sha256": sha256_for_file(path),
            "phash": perceptual_hash(image),
            "dhash": difference_hash(image),
            "ahash": average_hash(image),
            "center_phash": perceptual_hash(cropped),
            "center_dhash": difference_hash(cropped),
            "color_signature": color_signature(image),
            "thumbnail_path": preview_path,
        }


def encode_image_for_api(
    path: Path,
    *,
    max_side: int = 1024,
    jpeg_quality: int = 85,
) -> tuple[str, str]:
    with load_normalized_image(path) as image:
        prepared = image.copy()
        prepared.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        prepared.save(buffer, format="JPEG", quality=jpeg_quality)
    return base64.b64encode(buffer.getvalue()).decode("ascii"), "image/jpeg"
