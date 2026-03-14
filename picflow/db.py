from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


IMAGE_SELECT = """
SELECT
  id,
  path,
  root_name,
  role,
  category_hint,
  file_name,
  extension,
  size_bytes,
  width,
  height,
  area,
  mtime_ns,
  sha256,
  phash,
  dhash,
  ahash,
  center_phash,
  center_dhash,
  color_signature,
  thumbnail_path,
  selection_label,
  selection_updated_at,
  last_scanned_at,
  is_deleted
FROM images
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS images (
                  id INTEGER PRIMARY KEY,
                  path TEXT NOT NULL UNIQUE,
                  root_name TEXT NOT NULL,
                  role TEXT NOT NULL,
                  category_hint TEXT,
                  file_name TEXT NOT NULL,
                  extension TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  width INTEGER NOT NULL,
                  height INTEGER NOT NULL,
                  area INTEGER NOT NULL,
                  mtime_ns INTEGER NOT NULL,
                  sha256 TEXT NOT NULL,
                  phash TEXT NOT NULL,
                  dhash TEXT NOT NULL,
                  ahash TEXT NOT NULL,
                  center_phash TEXT NOT NULL,
                  center_dhash TEXT NOT NULL,
                  color_signature TEXT NOT NULL,
                  thumbnail_path TEXT,
                  selection_label TEXT,
                  selection_updated_at TEXT,
                  last_scanned_at TEXT NOT NULL,
                  is_deleted INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_images_role_deleted ON images(role, is_deleted);
                CREATE INDEX IF NOT EXISTS idx_images_sha256 ON images(sha256);
                CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);
                CREATE INDEX IF NOT EXISTS idx_images_center_phash ON images(center_phash);

                CREATE TABLE IF NOT EXISTS duplicate_candidates (
                  id INTEGER PRIMARY KEY,
                  left_image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                  right_image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                  candidate_score REAL NOT NULL,
                  exact_hash_match INTEGER NOT NULL DEFAULT 0,
                  phash_distance INTEGER NOT NULL,
                  dhash_distance INTEGER NOT NULL,
                  ahash_distance INTEGER NOT NULL,
                  center_phash_distance INTEGER NOT NULL,
                  center_dhash_distance INTEGER NOT NULL,
                  size_ratio REAL NOT NULL,
                  ai_label TEXT,
                  ai_confidence REAL,
                  ai_reason TEXT,
                  ai_raw_response TEXT,
                  manual_label TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  UNIQUE(left_image_id, right_image_id)
                );

                CREATE INDEX IF NOT EXISTS idx_candidates_ai_label ON duplicate_candidates(ai_label);
                CREATE INDEX IF NOT EXISTS idx_candidates_manual_label ON duplicate_candidates(manual_label);

                CREATE TABLE IF NOT EXISTS jobs (
                  id INTEGER PRIMARY KEY,
                  kind TEXT NOT NULL,
                  status TEXT NOT NULL,
                  progress REAL NOT NULL DEFAULT 0,
                  message TEXT,
                  payload TEXT,
                  result TEXT,
                  created_at TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT
                );

                CREATE TABLE IF NOT EXISTS action_log (
                  id INTEGER PRIMARY KEY,
                  kind TEXT NOT NULL,
                  old_path TEXT,
                  new_path TEXT,
                  image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
                  note TEXT,
                  created_at TEXT NOT NULL
                );
                """
            )
            self._ensure_column(conn, "images", "selection_label", "TEXT")
            self._ensure_column(conn, "images", "selection_updated_at", "TEXT")

    def _ensure_column(self, conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        current = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in current:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def fetch_image_index(self) -> dict[str, dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(f"{IMAGE_SELECT}").fetchall()
        return {row["path"]: dict(row) for row in rows}

    def upsert_image(self, record: dict[str, Any]) -> None:
        columns = [
            "path",
            "root_name",
            "role",
            "category_hint",
            "file_name",
            "extension",
            "size_bytes",
            "width",
            "height",
            "area",
            "mtime_ns",
            "sha256",
            "phash",
            "dhash",
            "ahash",
            "center_phash",
            "center_dhash",
            "color_signature",
            "thumbnail_path",
            "last_scanned_at",
            "is_deleted",
        ]
        values = [record.get(column) for column in columns]
        assignments = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        with self.connect() as conn:
            conn.execute(
                f"""
                INSERT INTO images ({", ".join(columns)})
                VALUES ({", ".join("?" for _ in columns)})
                ON CONFLICT(path) DO UPDATE SET {assignments}
                """,
                values,
            )

    def touch_existing_image(
        self,
        path: str,
        *,
        root_name: str,
        role: str,
        category_hint: str | None,
        last_scanned_at: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE images
                SET root_name = ?, role = ?, category_hint = ?, last_scanned_at = ?, is_deleted = 0
                WHERE path = ?
                """,
                (root_name, role, category_hint, last_scanned_at, path),
            )

    def mark_missing_images(self, active_paths: set[str], last_scanned_at: str) -> int:
        with self.connect() as conn:
            rows = conn.execute("SELECT path FROM images WHERE is_deleted = 0").fetchall()
            missing = [row["path"] for row in rows if row["path"] not in active_paths]
            if not missing:
                return 0
            conn.executemany(
                "UPDATE images SET is_deleted = 1, last_scanned_at = ? WHERE path = ?",
                [(last_scanned_at, path) for path in missing],
            )
        return len(missing)

    def list_active_images(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(f"{IMAGE_SELECT} WHERE is_deleted = 0").fetchall()
        return [dict(row) for row in rows]

    def clear_candidates(self) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM duplicate_candidates")

    def upsert_candidate(self, record: dict[str, Any]) -> None:
        columns = [
            "left_image_id",
            "right_image_id",
            "candidate_score",
            "exact_hash_match",
            "phash_distance",
            "dhash_distance",
            "ahash_distance",
            "center_phash_distance",
            "center_dhash_distance",
            "size_ratio",
            "ai_label",
            "ai_confidence",
            "ai_reason",
            "ai_raw_response",
            "manual_label",
            "created_at",
            "updated_at",
        ]
        values = [record.get(column) for column in columns]
        update_columns = [
            "candidate_score",
            "exact_hash_match",
            "phash_distance",
            "dhash_distance",
            "ahash_distance",
            "center_phash_distance",
            "center_dhash_distance",
            "size_ratio",
            "updated_at",
        ]
        assignments = ", ".join(f"{column}=excluded.{column}" for column in update_columns)
        with self.connect() as conn:
            conn.execute(
                f"""
                INSERT INTO duplicate_candidates ({", ".join(columns)})
                VALUES ({", ".join("?" for _ in columns)})
                ON CONFLICT(left_image_id, right_image_id) DO UPDATE SET {assignments}
                """,
                values,
            )

    def _candidate_query(self, where_clause: str = "", params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        query = f"""
        SELECT
          dc.id,
          dc.candidate_score,
          dc.exact_hash_match,
          dc.phash_distance,
          dc.dhash_distance,
          dc.ahash_distance,
          dc.center_phash_distance,
          dc.center_dhash_distance,
          dc.size_ratio,
          dc.ai_label,
          dc.ai_confidence,
          dc.ai_reason,
          dc.ai_raw_response,
          dc.manual_label,
          dc.created_at,
          dc.updated_at,
          li.id AS left_id,
          li.path AS left_path,
          li.root_name AS left_root_name,
          li.role AS left_role,
          li.file_name AS left_file_name,
          li.width AS left_width,
          li.height AS left_height,
          li.size_bytes AS left_size_bytes,
          li.thumbnail_path AS left_thumbnail_path,
          ri.id AS right_id,
          ri.path AS right_path,
          ri.root_name AS right_root_name,
          ri.role AS right_role,
          ri.file_name AS right_file_name,
          ri.width AS right_width,
          ri.height AS right_height,
          ri.size_bytes AS right_size_bytes,
          ri.thumbnail_path AS right_thumbnail_path
        FROM duplicate_candidates dc
        JOIN images li ON li.id = dc.left_image_id
        JOIN images ri ON ri.id = dc.right_image_id
        WHERE li.is_deleted = 0 AND ri.is_deleted = 0
        {where_clause}
        ORDER BY
          CASE COALESCE(dc.manual_label, dc.ai_label, 'pending')
            WHEN 'duplicate' THEN 0
            WHEN 'blocked' THEN 1
            WHEN 'pending' THEN 2
            ELSE 3
          END,
          dc.candidate_score DESC,
          dc.id ASC
        """
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def list_candidates(self, filter_mode: str = "needs-review", limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        where = ""
        params: list[Any] = []
        if filter_mode == "needs-review":
            where = "AND COALESCE(dc.manual_label, dc.ai_label, 'pending') IN ('pending', 'duplicate', 'blocked')"
        elif filter_mode == "duplicates":
            where = "AND COALESCE(dc.manual_label, dc.ai_label, 'pending') = 'duplicate'"
        elif filter_mode == "distinct":
            where = "AND COALESCE(dc.manual_label, dc.ai_label, 'pending') = 'distinct'"
        elif filter_mode == "blocked":
            where = "AND COALESCE(dc.manual_label, dc.ai_label, 'pending') = 'blocked'"
        params.extend([limit, offset])
        query = f"""
        SELECT
          dc.id,
          dc.candidate_score,
          dc.exact_hash_match,
          dc.phash_distance,
          dc.dhash_distance,
          dc.ahash_distance,
          dc.center_phash_distance,
          dc.center_dhash_distance,
          dc.size_ratio,
          dc.ai_label,
          dc.ai_confidence,
          dc.ai_reason,
          dc.ai_raw_response,
          dc.manual_label,
          dc.created_at,
          dc.updated_at,
          li.id AS left_id,
          li.path AS left_path,
          li.root_name AS left_root_name,
          li.role AS left_role,
          li.file_name AS left_file_name,
          li.width AS left_width,
          li.height AS left_height,
          li.size_bytes AS left_size_bytes,
          li.thumbnail_path AS left_thumbnail_path,
          ri.id AS right_id,
          ri.path AS right_path,
          ri.root_name AS right_root_name,
          ri.role AS right_role,
          ri.file_name AS right_file_name,
          ri.width AS right_width,
          ri.height AS right_height,
          ri.size_bytes AS right_size_bytes,
          ri.thumbnail_path AS right_thumbnail_path
        FROM duplicate_candidates dc
        JOIN images li ON li.id = dc.left_image_id
        JOIN images ri ON ri.id = dc.right_image_id
        WHERE li.is_deleted = 0 AND ri.is_deleted = 0
        {where}
        ORDER BY
          CASE COALESCE(dc.manual_label, dc.ai_label, 'pending')
            WHEN 'duplicate' THEN 0
            WHEN 'blocked' THEN 1
            WHEN 'pending' THEN 2
            ELSE 3
          END,
          dc.candidate_score DESC,
          dc.id ASC
        LIMIT ? OFFSET ?
        """
        with self.connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def get_candidate(self, candidate_id: int) -> dict[str, Any] | None:
        rows = self._candidate_query("AND dc.id = ?", (candidate_id,))
        return rows[0] if rows else None

    def candidate_counts(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT COALESCE(manual_label, ai_label, 'pending') AS label, COUNT(*) AS total
                FROM duplicate_candidates
                GROUP BY COALESCE(manual_label, ai_label, 'pending')
                """
            ).fetchall()
        counts = {row["label"]: row["total"] for row in rows}
        counts["total"] = sum(counts.values())
        return counts

    def list_selection_images(
        self,
        filter_mode: str = "all",
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = "WHERE is_deleted = 0 AND role = 'incoming'"
        if filter_mode == "pending":
            where += " AND COALESCE(selection_label, 'pending') = 'pending'"
        elif filter_mode == "good":
            where += " AND selection_label = 'good'"
        elif filter_mode == "bad":
            where += " AND selection_label = 'bad'"
        query = f"""
        SELECT
          id,
          path,
          root_name,
          role,
          file_name,
          width,
          height,
          size_bytes,
          thumbnail_path,
          selection_label,
          selection_updated_at
        FROM images
        {where}
        ORDER BY root_name ASC, path ASC
        LIMIT ? OFFSET ?
        """
        with self.connect() as conn:
            rows = conn.execute(query, (limit, offset)).fetchall()
        return [dict(row) for row in rows]

    def list_selection_queue(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT
                  id,
                  path,
                  root_name,
                  role,
                  file_name,
                  width,
                  height,
                  size_bytes,
                  thumbnail_path,
                  selection_label,
                  selection_updated_at
                FROM images
                WHERE is_deleted = 0 AND role = 'incoming'
                ORDER BY root_name ASC, path ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def update_selection_label(self, image_id: int, label: str | None, updated_at: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE images
                SET selection_label = ?, selection_updated_at = ?
                WHERE id = ?
                """,
                (label, updated_at, image_id),
            )

    def selection_counts(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT COALESCE(selection_label, 'pending') AS label, COUNT(*) AS total
                FROM images
                WHERE is_deleted = 0 AND role = 'incoming'
                GROUP BY COALESCE(selection_label, 'pending')
                """
            ).fetchall()
        counts = {row["label"]: row["total"] for row in rows}
        counts["total"] = sum(counts.values())
        return counts

    def list_candidates_for_verification(self, limit: int | None = None) -> list[dict[str, Any]]:
        query = """
        SELECT
          dc.id,
          dc.candidate_score,
          dc.left_image_id,
          dc.right_image_id,
          li.path AS left_path,
          li.file_name AS left_file_name,
          ri.path AS right_path,
          ri.file_name AS right_file_name
        FROM duplicate_candidates dc
        JOIN images li ON li.id = dc.left_image_id
        JOIN images ri ON ri.id = dc.right_image_id
        WHERE li.is_deleted = 0
          AND ri.is_deleted = 0
          AND dc.manual_label IS NULL
          AND (dc.ai_label IS NULL OR dc.ai_label IN ('blocked', 'error'))
        ORDER BY dc.candidate_score DESC, dc.id ASC
        """
        params: tuple[Any, ...] = ()
        if limit is not None:
            query += " LIMIT ?"
            params = (limit,)
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [dict(row) for row in rows]

    def update_candidate_ai(
        self,
        candidate_id: int,
        *,
        label: str,
        confidence: float | None,
        reason: str,
        raw_response: str,
        updated_at: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE duplicate_candidates
                SET ai_label = ?, ai_confidence = ?, ai_reason = ?, ai_raw_response = ?, updated_at = ?
                WHERE id = ?
                """,
                (label, confidence, reason, raw_response, updated_at, candidate_id),
            )

    def update_candidate_manual(self, candidate_id: int, label: str | None, updated_at: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE duplicate_candidates SET manual_label = ?, updated_at = ? WHERE id = ?",
                (label, updated_at, candidate_id),
            )

    def confirmed_duplicate_pairs(self) -> list[tuple[int, int]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT left_image_id, right_image_id
                FROM duplicate_candidates
                WHERE COALESCE(manual_label, ai_label, 'pending') = 'duplicate'
                """
            ).fetchall()
        return [(row["left_image_id"], row["right_image_id"]) for row in rows]

    def create_job(self, kind: str, payload: dict[str, Any], created_at: str) -> int:
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO jobs (kind, status, progress, message, payload, result, created_at)
                VALUES (?, 'queued', 0, '', ?, '', ?)
                """,
                (kind, json.dumps(payload, ensure_ascii=False), created_at),
            )
            return int(cursor.lastrowid)

    def update_job(
        self,
        job_id: int,
        *,
        status: str | None = None,
        progress: float | None = None,
        message: str | None = None,
        result: dict[str, Any] | None = None,
        started_at: str | None = None,
        finished_at: str | None = None,
    ) -> None:
        parts: list[str] = []
        values: list[Any] = []
        if status is not None:
            parts.append("status = ?")
            values.append(status)
        if progress is not None:
            parts.append("progress = ?")
            values.append(progress)
        if message is not None:
            parts.append("message = ?")
            values.append(message)
        if result is not None:
            parts.append("result = ?")
            values.append(json.dumps(result, ensure_ascii=False))
        if started_at is not None:
            parts.append("started_at = ?")
            values.append(started_at)
        if finished_at is not None:
            parts.append("finished_at = ?")
            values.append(finished_at)
        if not parts:
            return
        values.append(job_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE jobs SET {', '.join(parts)} WHERE id = ?", values)

    def list_jobs(self, limit: int = 10) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM jobs
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["payload"] = json.loads(item["payload"] or "{}")
            item["result"] = json.loads(item["result"] or "{}")
            result.append(item)
        return result

    def stats(self) -> dict[str, Any]:
        with self.connect() as conn:
            image_rows = conn.execute(
                """
                SELECT role, COUNT(*) AS total
                FROM images
                WHERE is_deleted = 0
                GROUP BY role
                """
            ).fetchall()
            image_total = conn.execute("SELECT COUNT(*) FROM images WHERE is_deleted = 0").fetchone()[0]
        return {
            "images_total": image_total,
            "images_by_role": {row["role"]: row["total"] for row in image_rows},
            "candidates": self.candidate_counts(),
            "selection": self.selection_counts(),
        }

    def log_action(
        self,
        kind: str,
        *,
        old_path: str | None = None,
        new_path: str | None = None,
        image_id: int | None = None,
        note: str = "",
        created_at: str,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO action_log (kind, old_path, new_path, image_id, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (kind, old_path, new_path, image_id, note, created_at),
            )
