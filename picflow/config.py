from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "picflow.settings.json"
DOTENV_PATHS = [PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"]
_DOTENV_LOADED = False


@dataclass(slots=True)
class DuplicateThresholds:
    phash_distance: int = 12
    dhash_distance: int = 12
    ahash_distance: int = 10
    center_phash_distance: int = 10
    center_dhash_distance: int = 12
    min_size_ratio: float = 0.45
    max_candidates_per_image: int = 12


@dataclass(slots=True)
class VerificationSettings:
    base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    proxy_url: str | None = "http://127.0.0.1:12334"
    model: str = "gemma-3-27b-it"
    api_keys: list[str] = field(default_factory=list)
    request_timeout_sec: int = 60
    max_image_side: int = 1024
    jpeg_quality: int = 85
    prompt_version: str = "v1"
    concurrency: int = 3


@dataclass(slots=True)
class AppConfig:
    project_root: Path = PROJECT_ROOT
    library_root: Path = Path(r"D:\tg-bot_photo")
    reference_dir_name: str = "all_photos"
    export_dir_name: str = "export"
    approved_dir_name: str = "approved_unsorted"
    rejected_dir_name: str = "rejected_pool"
    excluded_top_level_dirs: list[str] = field(default_factory=lambda: ["13_old_export"])
    state_dir: Path = PROJECT_ROOT / ".picflow"
    database_path: Path = PROJECT_ROOT / ".picflow" / "picflow.sqlite3"
    thumbnail_dir: Path = PROJECT_ROOT / ".picflow" / "thumbnails"
    quarantine_dir: Path = PROJECT_ROOT / ".picflow" / "quarantine_duplicates"
    duplicate_action: str = "delete"
    supported_extensions: list[str] = field(
        default_factory=lambda: [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]
    )
    export_categories: list[str] = field(
        default_factory=lambda: [
            "ero-anime",
            "ero-real",
            "standart-art",
            "standart-meme",
            "single-meme",
        ]
    )
    duplicate_thresholds: DuplicateThresholds = field(default_factory=DuplicateThresholds)
    verification: VerificationSettings = field(default_factory=VerificationSettings)

    @property
    def approved_dir(self) -> Path:
        return self.library_root / self.approved_dir_name

    @property
    def rejected_dir(self) -> Path:
        return self.library_root / self.rejected_dir_name

    @property
    def reference_dir(self) -> Path:
        return self.library_root / self.reference_dir_name

    @property
    def export_dir(self) -> Path:
        return self.library_root / self.export_dir_name

    @property
    def reserved_top_level_dirs(self) -> set[str]:
        return {
            self.reference_dir_name,
            self.export_dir_name,
            self.approved_dir_name,
            self.rejected_dir_name,
            *self.excluded_top_level_dirs,
        }

    def role_for_path(self, path: Path) -> str:
        try:
            rel = path.resolve().relative_to(self.library_root.resolve())
        except ValueError:
            return "external"
        top_level = rel.parts[0] if rel.parts else ""
        if top_level == self.reference_dir_name:
            return "reference"
        if top_level == self.export_dir_name:
            return "export"
        if top_level == self.approved_dir_name:
            return "approved"
        if top_level == self.rejected_dir_name:
            return "rejected"
        if top_level in self.excluded_top_level_dirs:
            return "excluded"
        return "incoming"

    def category_for_path(self, path: Path) -> str | None:
        try:
            rel = path.resolve().relative_to(self.library_root.resolve())
        except ValueError:
            return None
        if len(rel.parts) >= 2 and rel.parts[0] in {self.reference_dir_name, self.export_dir_name}:
            return rel.parts[1]
        return None

    def ensure_state_dirs(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.thumbnail_dir.mkdir(parents=True, exist_ok=True)
        self.quarantine_dir.mkdir(parents=True, exist_ok=True)

    def ensure_runtime_library_dirs(self) -> None:
        self.approved_dir.mkdir(parents=True, exist_ok=True)
        self.rejected_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["project_root"] = str(self.project_root)
        payload["library_root"] = str(self.library_root)
        payload["state_dir"] = str(self.state_dir)
        payload["database_path"] = str(self.database_path)
        payload["thumbnail_dir"] = str(self.thumbnail_dir)
        payload["quarantine_dir"] = str(self.quarantine_dir)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AppConfig":
        thresholds = DuplicateThresholds(**payload.get("duplicate_thresholds", {}))
        verification_payload = dict(payload.get("verification", {}))
        base_url = verification_payload.get("base_url")
        proxy_url = verification_payload.get("proxy_url")
        if isinstance(base_url, str) and base_url.startswith(("http://127.0.0.1", "http://localhost")) and not proxy_url:
            verification_payload["proxy_url"] = base_url
            verification_payload["base_url"] = "https://generativelanguage.googleapis.com/v1beta"
        verification = VerificationSettings(**verification_payload)
        return cls(
            project_root=Path(payload.get("project_root", PROJECT_ROOT)),
            library_root=Path(payload.get("library_root", r"D:\tg-bot_photo")),
            reference_dir_name=payload.get("reference_dir_name", "all_photos"),
            export_dir_name=payload.get("export_dir_name", "export"),
            approved_dir_name=payload.get("approved_dir_name", "approved_unsorted"),
            rejected_dir_name=payload.get("rejected_dir_name", "rejected_pool"),
            excluded_top_level_dirs=list(payload.get("excluded_top_level_dirs", ["13_old_export"])),
            state_dir=Path(payload.get("state_dir", PROJECT_ROOT / ".picflow")),
            database_path=Path(payload.get("database_path", PROJECT_ROOT / ".picflow" / "picflow.sqlite3")),
            thumbnail_dir=Path(payload.get("thumbnail_dir", PROJECT_ROOT / ".picflow" / "thumbnails")),
            quarantine_dir=Path(payload.get("quarantine_dir", PROJECT_ROOT / ".picflow" / "quarantine_duplicates")),
            duplicate_action=payload.get("duplicate_action", "delete"),
            supported_extensions=list(
                payload.get(
                    "supported_extensions",
                    [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"],
                )
            ),
            export_categories=list(
                payload.get(
                    "export_categories",
                    ["ero-anime", "ero-real", "standart-art", "standart-meme", "single-meme"],
                )
            ),
            duplicate_thresholds=thresholds,
            verification=verification,
        )

    def save(self, path: Path | None = None) -> None:
        target = resolve_config_path(path)
        target.write_text(json.dumps(self.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")


def ensure_dotenv_loaded() -> None:
    global _DOTENV_LOADED
    if _DOTENV_LOADED:
        return
    for dotenv_path in DOTENV_PATHS:
        if not dotenv_path.exists():
            continue
        for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)
    _DOTENV_LOADED = True


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _split_api_keys(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    normalized = raw_value.replace(";", "\n").replace(",", "\n")
    return [item.strip() for item in normalized.splitlines() if item.strip()]


def apply_env_overrides(config: AppConfig) -> AppConfig:
    ensure_dotenv_loaded()
    if library_root := os.environ.get("PICFLOW_LIBRARY_ROOT"):
        config.library_root = Path(library_root)
    if duplicate_action := os.environ.get("PICFLOW_DUPLICATE_ACTION"):
        config.duplicate_action = duplicate_action
    if base_url := os.environ.get("PICFLOW_GEMINI_BASE_URL"):
        config.verification.base_url = base_url
    if proxy_url := os.environ.get("PICFLOW_PROXY_URL"):
        config.verification.proxy_url = proxy_url
    if model := os.environ.get("PICFLOW_GEMINI_MODEL"):
        config.verification.model = model
    env_keys = _split_api_keys(os.environ.get("PICFLOW_GEMINI_API_KEYS"))
    if env_keys:
        config.verification.api_keys = env_keys
    config.verification.request_timeout_sec = _env_int(
        "PICFLOW_GEMINI_REQUEST_TIMEOUT_SEC",
        config.verification.request_timeout_sec,
    )
    config.verification.concurrency = max(
        1,
        _env_int("PICFLOW_GEMINI_CONCURRENCY", config.verification.concurrency),
    )
    return config


def resolve_config_path(path: Path | str | None = None) -> Path:
    ensure_dotenv_loaded()
    if path is not None:
        return Path(path)
    env_path = os.environ.get("PICFLOW_CONFIG")
    if env_path:
        return Path(env_path)
    return DEFAULT_CONFIG_PATH


def load_or_create_config(path: Path | str | None = None) -> AppConfig:
    target = resolve_config_path(path)
    if target.exists():
        payload = json.loads(target.read_text(encoding="utf-8"))
        config = apply_env_overrides(AppConfig.from_dict(payload))
    else:
        config = apply_env_overrides(AppConfig())
        config.save(target)
    config.ensure_state_dirs()
    return config
