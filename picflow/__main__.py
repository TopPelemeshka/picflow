from __future__ import annotations

import argparse

from .categorization import apply_export_actions, plan_export_actions, run_categorization
from .config import load_or_create_config
from .db import Database
from .duplicates import build_duplicate_candidates, plan_duplicate_actions, scan_library
from .verifier import run_verification
from .web import run_server


def main() -> None:
    parser = argparse.ArgumentParser(description="PicFlow")
    parser.add_argument("--config", default=None, help="Путь к конфигу PicFlow")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("runserver", help="Запустить локальный веб-интерфейс")
    subparsers.add_parser("scan", help="Просканировать библиотеку")
    subparsers.add_parser("candidates", help="Построить кандидатов в дубли")
    verify_parser = subparsers.add_parser("verify", help="Запустить AI-проверку")
    verify_parser.add_argument("--limit", type=int, default=None)
    verify_parser.add_argument("--force", action="store_true", help="Переотправить в AI даже уже auto-marked пары")
    subparsers.add_parser("plan", help="Показать план удаления дублей")
    categorize_parser = subparsers.add_parser("categorize-ai", help="Запустить AI-категоризацию approved фото")
    categorize_parser.add_argument("--limit", type=int, default=None)
    categorize_parser.add_argument("--force", action="store_true")
    subparsers.add_parser("export-plan", help="Показать план экспорта категорий")
    subparsers.add_parser("export-apply", help="Применить экспорт категорий")

    args = parser.parse_args()
    config = load_or_create_config(args.config)
    db = Database(config.database_path)
    db.init()

    if args.command == "runserver":
        run_server(config_path=args.config)
        return
    if args.command == "scan":
        print(scan_library(db, config))
        return
    if args.command == "candidates":
        print(build_duplicate_candidates(db, config))
        return
    if args.command == "verify":
        print(run_verification(db, config, limit=args.limit, force=args.force))
        return
    if args.command == "plan":
        actions = plan_duplicate_actions(db, config)
        for action in actions[:50]:
            print(action)
        print({"total": len(actions)})
        return
    if args.command == "categorize-ai":
        print(run_categorization(db, config, limit=args.limit, force=args.force))
        return
    if args.command == "export-plan":
        actions = plan_export_actions(db, config)
        for action in actions[:50]:
            print(action)
        print({"total": len(actions)})
        return
    if args.command == "export-apply":
        print(apply_export_actions(db, config))


if __name__ == "__main__":
    main()
