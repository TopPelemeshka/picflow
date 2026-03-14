# PicFlow

Локальная Python-программа с веб-интерфейсом для полуавтоматического отбора картинок для Telegram-бота.

## Что уже реализовано

- сканирование библиотеки изображений и индексирование в SQLite;
- поиск кандидатов в дубли по perceptual hash и точному SHA-256;
- AI-проверка пар через Gemini-compatible API с поддержкой нескольких ключей и локального прокси;
- ручное ревью дублей в веб-интерфейсе;
- удаление дублей с приоритетом сохранения файлов из `all_photos`;
- устранение конфликтов имен после удаления дублей;
- good/bad отбор входящих фото;
- разнос просмотренного префикса в `approved_unsorted` и `rejected_pool`;
- AI- и ручная категоризация `approved_unsorted`;
- экспорт размеченных фото в `export/<category>`.

## Хранение ключей

Ключи лучше хранить не в `picflow.settings.json`, а в `.env`.

Поддерживаемые переменные:

```dotenv
PICFLOW_CONFIG=D:\picflow\picflow.test.settings.json
PICFLOW_GEMINI_API_KEYS=KEY_1,KEY_2
PICFLOW_PROXY_URL=http://127.0.0.1:12334
PICFLOW_GEMINI_MODEL=gemma-3-27b-it
PICFLOW_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
PICFLOW_GEMINI_CONCURRENCY=3
PICFLOW_GEMINI_REQUEST_TIMEOUT_SEC=60
```

В репозитории есть шаблон: [`.env.example`](/D:/picflow/.env.example)

## Быстрый старт

1. Проверь `picflow.settings.json` или `picflow.test.settings.json`.
2. Добавь ключи и прокси в `.env`.
3. Запусти приложение:

```powershell
python -m picflow runserver
```

Для тестового каталога:

```powershell
python -m picflow --config picflow.test.settings.json runserver
```

После запуска интерфейс доступен на [http://127.0.0.1:8765](http://127.0.0.1:8765).

## Батник

В проект добавлен [run_picflow.bat](/D:/picflow/run_picflow.bat).

Запуск по умолчанию:

```bat
run_picflow.bat
```

Запуск на тестовом конфиге:

```bat
run_picflow.bat test
```

Можно сделать ярлык на этот батник и запускать приложение только через него.

## CLI

```powershell
python -m picflow scan
python -m picflow candidates
python -m picflow verify --limit 200
python -m picflow verify --force
python -m picflow plan
python -m picflow categorize-ai --limit 100
python -m picflow export-plan
python -m picflow export-apply
```

## Замечания

- По умолчанию `duplicate_action=delete`.
- Веб-интерфейс работает только с локальными файлами из `library_root` и `.picflow`.
- `picflow.settings.json` удобно держать без секретов и использовать его только для путей и структуры папок.
