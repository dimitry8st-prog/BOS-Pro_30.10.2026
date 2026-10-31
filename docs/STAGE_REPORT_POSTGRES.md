# Отчёт: локальный PostgreSQL для учебного сценария

Это запись исполнителя о фактически выполненных командах. Контракт v0.1 по-прежнему не утверждён владельцем. Учебный адаптер не является защитой публичного сервиса.

Среда: Node.js `24.12.0`, PostgreSQL `16.10`, отдельный каталог `var/pg-test`, `127.0.0.1:54329`. Пакеты: `pg` `8.23.1`, `@types/pg` `8.23.1`, TypeScript `7.0.2`, `@types/node` `24.19.2`.

## Команды и результат

`npm run check` — код выхода `0`.

`npm test` — 10 тестов файлового хранилища, pass 10, fail 0, duration_ms `7495.541`.

`npm run test:pg` — 8 тестов PostgreSQL, pass 8, fail 0, duration_ms `8110.7425`. Перед ними `resetEducationalDatabase` удалил и создал только базу `bos_pro_test`.

`node dist/src/db/bootstrap.js` — код выхода `0` на уже созданном кластере.

`node dist/src/cli.js run --input fixtures/educational-input.json --database-url postgres://usr_educational@127.0.0.1:54329/bos_pro_test --actor usr_educational` — код выхода `0`. Это та же команда, что `npm run scenario:postgres`. Результат: `replay: true`, `run_id` `run_876c0e21b81befcabed021ba848cd28e`, статус `succeeded`, `verification.status` `pass`, `publication.status` `not_published`, `access_check` `educational_membership_checked`, `durable_production_storage` `false`. Повтор вернул запуск, созданный тестом сценария, и не создал второй.

## Что проверено на PostgreSQL

- Миграция `0001_scenario_tables` применяется к чистой базе. Таблиц `campaign` и `experiment` нет.
- Роль `usr_educational` не является superuser и не имеет `BYPASSRLS`. Таблица `schema_migration` ей недоступна.
- Учебный вход создаёт task, run, версию артефакта и verification. Новый процесс читает тот же запуск.
- `usr_other` не видит и не изменяет строки `usr_educational`.
- Задача в `ws_educational` не связывается с `prj_other`. Вставка в чужой workspace отклоняется RLS.
- Два одновременных процесса с одним ключом создают один run. Другой вход с тем же ключом даёт `idempotency_conflict`.
- Отказ поставщика — `failed` / `provider_refused`. Отмена — `cancelled`. Прерывание после `running` восстанавливается в `failed` / `interrupted`. Сбой записи успешного результата оставляет статус `failed`, без строки artifact.
- Правка создаёт revision 2. `UPDATE` artifact и verification отклоняются. Новый ключ создаёт новый run и новую task.
- Поле `user_id` в теле запроса отклоняется как `unknown_field`.

## Ограничения

Файловое хранилище по-прежнему не проверяет membership. Идентичность в PostgreSQL — роль входа локального теста, а не выбранная владельцем аутентификация. `FixtureProvider` не вызывает модель. URL не запрашиваются. Публикация отсутствует. Кластер слушает только `127.0.0.1:54329` и не является размещением сервиса.
