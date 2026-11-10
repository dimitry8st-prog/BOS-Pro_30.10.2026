# Локальный HTTP-транспорт BOS.pro

Дата: 10 ноября 2026 года. База: ветка `local-session-api`
(`7c5a2dda8ed17a7bc5efe35190ec4a2b943892d7`), поверх объединённого PostgreSQL.

## Результат и границы

Добавлен явно запускаемый HTTP-транспорт `LocalHttpServer` на встроенном
`node:http` без новых зависимостей. Он слушает только `127.0.0.1` и передаёт
`POST /api/v1/dispatch` в существующий `LocalTaskApi.dispatch`.
`GET /health` возвращает `{ "ok": true }` без конфигурации и секретов.

Импорт модуля и библиотечного `index` порт не открывает. Публичного `/login`,
регистрации и парольного входа нет. Сессию по-прежнему выдаёт только доверенный
bootstrap/demo-процесс через `LocalSessions.issue()`.

## Транспортные правила

- Доступ: заголовок `Authorization: Bearer <token>`. Токен не принимается из URL
  и не печатается.
- `Host` ограничен loopback (`127.0.0.1` / `localhost` / `[::1]` с портом сервера).
- Браузерный `Origin` отклоняется; CORS не включается.
- Только `POST` + `Content-Type: application/json` для dispatch.
- Тело ограничено 256 KiB во время чтения потока, до `JSON.parse`.
- Неверный JSON, обрыв и тайм-аут дают безопасные коды без SQL, stack и DSN.
- `close()` закрывает сервер и активные соединения; demo/тесты закрывают DB-пулы.

## Демонстрация

Нужна отдельная локальная база `bos_http_demo` (не production). Пароли только в
окружении.

```text
createdb -h 127.0.0.1 -p <port> -U postgres bos_http_demo
BOS_HTTP_DEMO_DATABASE=1
BOS_MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:<port>/bos_http_demo
BOS_ALICE_DATABASE_URL=postgres://alice:<password>@127.0.0.1:<port>/bos_http_demo
npm run demo:http
```

Команда создаёт/переиспользует LOGIN `alice` без `ALTER`, выдаёт сессию в
процессе, поднимает сервер на свободном loopback-порту и выполняет по HTTP:
создание task → prepare_draft → повтор ключа → чтение → revise с
`quality_gate=blocked`. Затем отзывает сессию и закрывает ресурсы. В stdout
только безопасный итог (статусы, `run_id`, revision, `quality_gate`).

## Проверки

Локально 2026-11-10 (Node 24.12.0):

```text
npm ci
npm run check                 # pass
npm test                      # 21/21: acceptance + sessions + HTTP transport
npm run test:http             # 5/5 transport
npm run test:postgres         # PGlite: Embedded ... HTTP transport tested
BOS_TEST_DATABASE_URL=...     # Native PG16: Native ... HTTP transport tested
npm run demo:http             # ok, quality_gate=blocked, revision>=2
```

PGlite и native PostgreSQL отмечаются отдельно в логе теста. CI поднимает
PostgreSQL 16 и выполняет `test:postgres`, включая сквозной HTTP-прогон.

## Ограничения

- Это локальный прототип, не публичный сервис.
- Способ публичной аутентификации не выбран.
- UI, реальные модели, публикация, туннели и деплой не добавлены.
- Административные миграции и membership остаются вне HTTP API.
