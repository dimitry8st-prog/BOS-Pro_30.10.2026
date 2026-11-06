# Проверка PostgreSQL-хранилища BOS.pro — 2026-11-06

## Состояние GitHub на старте

| Объект | Значение |
|--------|----------|
| `main` | `1137698` — объединён PR №1 (учебный контракт, файловое хранилище) |
| PR №2 | [Add PostgreSQL storage and workspace isolation](https://github.com/dimitry8st-prog/BOS-Pro_30.10.2026/pull/2) — открыт, `MERGEABLE` |
| Ветка PR | `postgres-storage` |
| Предыдущий проверенный SHA | `dc6641109d13aff09f1f914b208e54150d620fed` |
| CI того SHA | [actions/runs/41342580929](https://github.com/dimitry8st-prog/BOS-Pro_30.10.2026/actions/runs/41342580929) — success |
| SHA исправления replay LOGIN | `fd6488e671ca99684559b008acf6a83b2e0e233a` |
| Итоговый push PR №2 | смотреть HEAD `postgres-storage` и CI после push |

Рабочее дерево на старте было чистым; чужая работа не затрагивалась.

## Что проверено независимо

Код и поведение (не только прежние отчёты):

- сохранение и чтение после переподключения;
- повтор того же ключа → тот же `run_id` (`replay`);
- конкурентные одинаковые ключи → один запуск;
- изоляция workspace (`alice` / `bob`);
- `viewer` читает и не пишет; `owner`/`editor` в своих пределах;
- подмена `bos.user_id` / чужого `workspace_id` не открывает чужие строки;
- runtime отклоняет superuser, `BYPASSRLS` и владельца таблиц;
- личность из `session_user`, сверка с `identity.userId`;
- неизменяемость artifact/verification;
- смена текста → `quality_gate=blocked`;
- откат при ошибке записи; cancel не затирается;
- миграции 001–003 повторяемы, checksum, апгрейд с исторической 001;
- секреты не попадают в audit payload.

Ограничение «один пользователь приложения = один DB LOGIN» подтверждено и **не** является публичной аутентификацией. См. [SERVER_ACCESS_CONTRACT_V0_1.md](SERVER_ACCESS_CONTRACT_V0_1.md).

## Найденная ошибка и исправление

**Дефект:** повтор `npm run scenario:postgres` на уже подготовленной учебной базе падал с
`role alice already exists; refusing to alter cluster roles`, хотя
[POSTGRES_STAGE.md](POSTGRES_STAGE.md) обещает возврат того же запуска.

**Причина:** `ensureLogin` после аудита 2026-11-01 отказывался от любого
существующего LOGIN и не умел безопасно переиспользовать роль с уже рабочим
паролем (в отличие от native-теста).

**Исправление:** `src/storage/ensure-runtime-login.ts` — создать LOGIN или
переиспользовать его после probe без `ALTER ROLE`; учебный сценарий проверяет
reuse и in-process replay того же ключа; native-регрессия в `test/postgres.test.ts`.

## Команды и результаты

Среда: Node.js `24.12.0`, npm `11.18.0`, Docker PostgreSQL `16`.

```text
npm ci
npm run check                 # pass
npm test                      # 11/11 pass
npm run test:postgres         # PGlite: 2/2 pass
                              # (Embedded PostgreSQL/PGlite tested; TCP transport not exercised)
```

Native (одноразовая Docker PostgreSQL 16, порт `55433`, базы `bos_audit_run5` /
`bos_upgrade_test`; admin URL только для миграции и seed; прикладные операции —
LOGIN `alice`/`bob`/`viewer`):

```text
BOS_TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:55433/bos_audit_run5
npm run test:postgres
# Native PostgreSQL transport tested
# Native PostgreSQL upgrade from migration 001 tested
# pass 2, fail 0
```

Учебный сценарий (отдельный кластер, порт `55434`, база `bos_educational`):

```text
BOS_EDUCATIONAL_DATABASE=1
BOS_MIGRATION_DATABASE_URL=...
BOS_ALICE_DATABASE_URL=...
BOS_BOB_DATABASE_URL=...
npm run scenario:postgres
# первый успешный прогон: status=succeeded, other_user_can_read=false
# повтор на той же базе: тот же run_id, replay=true, alice_login=reused
```

Секреты в отчёт не выводились. Production-БД не использовалась.

## CI после push

После push нового SHA проверить Actions ветки `postgres-storage` / PR №2.
Локальный прогон CI не заменяет.

## Ограничения (без изменений этапа)

- Публичной аутентификации, серверного API/UI и деплоя нет.
- `FixtureProvider` и файловый CLI сохранены.
- PGlite не доказывает сетевую конкуренцию.
- Длинные вызовы модели внутри одной транзакции не поддержаны.
- PR №2 не объединялся автоматически.

## Verdict

Дефект повторного учебного сценария закрыт кодом и проверками. После зелёного CI
нового SHA PR №2 готов к решению владельца об объединении. Публичная
аутентификация — следующий этап, не часть этого PR.
