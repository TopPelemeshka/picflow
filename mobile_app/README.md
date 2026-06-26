# PicFlow Mobile App

Отдельное мобильное приложение лежит прямо в этом репозитории в папке `mobile_app`.

## Стек

- Expo / React Native
- TypeScript
- AsyncStorage для локального состояния
- `expo-file-system` для кэша оригиналов батча

## Что уже умеет

- pairing с ПК по одноразовому коду;
- выбор и скачивание мобильных батчей;
- локальный кэш оригиналов для офлайн-разбора;
- сохранение последнего адреса сервера и имени устройства;
- быстрый возврат к незавершенному батчу;
- синхронизация решений прямо из списка батчей;
- фильтры `all / pending / reviewed / purge`;
- подтверждение для `purge`;
- три режима ревью:
  - `Single`
  - `Feed`
  - `Grid`
- сохранение прогресса и решений на телефоне;
- частичная синхронизация обратно в PicFlow.

## Запуск

1. Перейти в папку:

```bash
cd mobile_app
```

2. Установить зависимости:

```bash
npm install
```

3. Запустить Expo:

```bash
npm run start
```

4. Для Android:

```bash
npm run android
```

5. Для генерации нативного Android-проекта:

```bash
npm run android:prebuild
```

6. Для прогрева Android-зависимостей и кэша Gradle:

```bash
npm run android:deps:warm
```

7. Для dev APK, который требует Metro:

```bash
npm run android:apk:debug
```

Готовый debug APK после успешной сборки будет лежать в:

```text
mobile_app/android/app/build/outputs/apk/debug/app-debug.apk
```

8. Для автономного APK на телефон:

```bash
npm run android:apk:standalone
```

Он будет лежать в:

```text
mobile_app/android/app/build/outputs/apk/release/app-release.apk
```

## Что нужно на ПК

1. Запустить backend PicFlow:

```bash
python -m picflow runserver --host 0.0.0.0 --port 8765
```

2. Открыть на ПК страницу:

```text
http://127.0.0.1:8765/mobile-review
```

3. Сгенерировать pairing-code и ввести его в приложении.

## Замечания

- Обычный web-интерфейс PicFlow с телефона по сети не доступен, открыт только mobile API.
- Приложение хранит скачанные оригиналы у себя локально в sandbox-хранилище Expo.
- Для `userInterfaceStyle` на Android добавлен `expo-system-ui`.
- Android prebuild уже совместим с `edge-to-edge`.
- `android:apk:debug` не автономен: этот APK ждёт Metro dev server и не подходит для обычной установки на телефон.
- Для реального теста на устройстве используй `android:apk:standalone` или `android:apk:release`.
- Скрипт `android:toolchain` сам поднимает локальный toolchain в `~/.cache/picflow-mobile-toolchain`:
  - JDK 17;
  - Android command-line tools;
  - Android SDK platform/build-tools;
  - NDK 27.1.12297006;
  - локальные Gradle/Android home-каталоги без зависимости от системного Android Studio.
- Первый `android:deps:warm` или `android:apk:debug` может идти долго, потому что Gradle молча скачивает крупные React Native AAR из Maven.
- Если локальной Android-среды нет, можно использовать EAS Build с профилем `preview`.
