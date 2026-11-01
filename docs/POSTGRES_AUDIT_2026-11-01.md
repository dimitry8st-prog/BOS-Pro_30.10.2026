# Аудит PostgreSQL-хранилища BOS.pro — 2026-11-01

## Проверенные ревизии

| Роль | SHA | Примечание |
|------|-----|------------|
| Исходный проверенный коммит PR №2 | `411b94c57537e2d9c1238cee6de146a903521ec6` | Совпадал с `origin/postgres-storage` на старте аудита |
| Известный зелёный CI этого SHA | [actions/runs/41219664672](https://github.com/dimitry8st-prog/BOS-Pro_30.10.2026/actions/runs/41219664672) | До аудита |
| Итоговая ревизия аудита | *см. HEAD после push* | Коммит(ы) с миграцией 002 и регрессиями |

Целевая ветка PR: `postgres-storage` → `main`. PR №2 не объединялся.

WIP предыдущей сессии (Internal Error) сохранён вне ветки в
`C:\Users\user\BOS-Pro_wip_backup_2026-11-01` и не смешивался со слепым
переносом: изменения пересмотрены независимо и доведены.

## Граница доверия

- Runtime-соединение может вызывать `set_config` для `bos.workspace_id`
  (и теоретически `bos.user_id`). Эти GUC предполагают **доверенный сервер** и
  **не** заменяют публичную аутентификацию.
- После миграции 002 доступ по личности берётся из `session_user` (login-роль).
  Подмена `bos.user_id` чужие строки не открывает.
- `PostgresStore` сверяет `session_user` с `identity.userId` и отклоняет
  superuser / `BYPASSRLS` / владельца таблиц (`runtime_role_rejected`).
- Проверка приложения в native-режиме идёт через отдельные LOGIN
  (`alice` / `bob` / `viewer`), а не через `SET ROLE` из административного
  пула.

## Подтверждённые дефекты (на `411b94c`) и исправления

1. **Подмена личности через GUC**  
   `bos.can_access` доверял `current_setting('bos.user_id')`; тест поднимал
   `bos_runtime` через `SET LOCAL ROLE` от admin-пула.  
   **Исправление:** миграция `002_session_identity.sql` — `session_user`;
   адаптер `assertRuntimeSession`; тесты на настоящих LOGIN.

2. **Снятие `cancel_requested`**  
   Позднее сохранение могло очистить флаг; в БД не было запрета.  
   **Исправление:** триггер `guard_run` + `COALESCE` при merge в `saveRun`;
   регрессия гонки cancel/save.

3. **Изменение artifact/verification**  
   Runtime без GRANT UPDATE, но суперпользователь мог переписать строки.  
   **Исправление:** триггеры `artifact_revision_immutable` /
   `verification_immutable`.

4. **Membership без FORCE RLS**  
   **Исправление:** `FORCE ROW LEVEL SECURITY` на `workspace_membership` в 002.

5. **Журнал без привязки к login**  
   **Исправление:** `audit_event.actor_user_id` из `session_user`.

6. **CHECK статуса/ключей и NULL**  
   `CHECK (payload->>'status' IN (...))` пропускал отсутствие ключа: в SQL
   `NULL IN (...)` даёт UNKNOWN, а CHECK принимает UNKNOWN. То же для
   сравнения `run_id`/`workspace_id`.  
   **Исправление:** constraint `run_payload_keys_present` в 002; регрессия
   до/после.

7. **Исторический checksum 001**  
   Базы с формой `CREATE ROLE` из `516fc5a` ломались на повторном runner.  
   **Исправление:** accepted checksums + `migrations/history/001_core_516fc5a.sql`;
   001 не переписывается; апгрейд через 002.

## Что проверено

- Атомарность миграций, повтор, checksum mismatch без удаления строк
- Вторая БД того же кластера / апгрейд `bos_upgrade_test` при существующей
  `bos_runtime`
- RLS SELECT/INSERT/UPDATE, составные FK, viewer/owner/editor
- Запрет membership write, immutability версий, cancel permanence
- JSON payload vs ключевые колонки (NULL / missing keys)
- Изоляция двух workspace; отказ impostor (`runtime_role_rejected`)
- GUC `bos.user_id` не открывает чужой workspace
- Конкурентные одинаковые idempotency key; conflict на другой вход
- Параллельные правки → две новые revision без потери
- Отмена, гонка cancel/complete, recover interrupted
- Ошибка после начальных записей (полный откат → `diagnostics_only`)
- Ошибка artifact path → failed-run с журналом, без успешного артефакта
- SAVEPOINT между artifact и verification
- Повторное подключение сохраняет версии/отчёты
- Смена текста → `quality_gate=blocked`, без наследования pass
- PGlite отдельно (не доказательство TCP); native PG 16 отдельно

## Команды и результаты (эта машина)

```text
npm ci --ignore-scripts
npm run check          # pass
npm test               # 11/11 pass
npm run test:postgres  # PGlite: 2/2 pass
```

Native (одноразовая Docker PostgreSQL 16, не production):

```text
BOS_TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/bos_audit_run3
npm run test:postgres  # Native transport + upgrade: 2/2 pass
```

Секреты в отчёт не выводились. Production-БД не использовалась.

## Воспроизводимый запуск (admin ≠ runtime)

1. Администратор: пустая локальная БД, `BOS_MIGRATION_DATABASE_URL`,
   `npm run migrate:postgres`.
2. Администратор создаёт LOGIN без superuser/`BYPASSRLS`/владения таблицами,
   `GRANT bos_runtime TO <login>`, membership, project, task.
3. Сервер открывает Pool строкой **runtime**-логина и передаёт
   `PostgresStore(pool, { userId: session_user, workspaceId, taskId })`.
4. Учебный сценарий с раздельными URL:
   `docs/POSTGRES_STAGE.md` → `npm run scenario:postgres`
   (`BOS_MIGRATION_DATABASE_URL` + `BOS_ALICE_DATABASE_URL` + `BOS_BOB_DATABASE_URL`).

## CI

После push итогового SHA проверить run на ветке `postgres-storage`.
Локальный прогон CI не заменяет.

## Ограничения

- Публичной аутентификации / HTTP API нет
- `FixtureProvider` и файловый CLI сохранены
- PGlite не доказывает сетевую конкуренцию; для смены login на PGlite
  требуется reopen каталога (особенность SESSION AUTHORIZATION)
- Длинные вызовы модели внутри одной транзакции не поддержаны
- PR №2 не merge, main/production не менялись

## Verdict

**PostgreSQL-этап хранения и изоляции — готов к ревью PR №2** после зелёного CI
итогового SHA. Публичный доступ и серверная сессия — следующий этап
(`docs/SERVER_ACCESS_CONTRACT_V0_1.md`), не часть этого merge.
