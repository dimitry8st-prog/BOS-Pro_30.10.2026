export const SCHEMA_VERSION = "0.1.0";
export const SCENARIO_VERSION = "prepare_draft/0.1.0";
export const RULES_VERSION = "draft_checks/0.1.0";
export const WORKFLOW_VERSION = "prepare_draft_educational/0.1.0";

export const STORAGE_CLASS = "development-only" as const;

export const ACCESS_CHECK_NOTE =
  "Серверная проверка membership, ролей и RLS на этом этапе не реализована и не считается пройденной.";

export const REACHABILITY_IS_NOT_TRUTH =
  "Доступность ссылки не является доказательством истинности утверждения. Статус reachable означал бы только ответ адреса, а не верность связанного фрагмента.";

export const FIXTURE_LIMITATION =
  "Прогон использует FixtureProvider на локальных fixture. Это проверка управления выполнением, а не оценка качества модели, живого сайта, RLS или production.";

export const MESSAGES = {
  unknown_field: "Во входе есть поле, которого нет в контракте v0.1.",
  invalid_topic: "Тема пустая или длиннее допустимого.",
  invalid_budget:
    "Бюджет не соответствует контракту: нужны неотрицательные десятичные строки, валюта из трёх заглавных букв и нулевой внешний расход в учебном режиме.",
  invalid_shape: "Форма входа не совпадает с контрактом v0.1.",
  schema_version_unsupported: "Версия схемы входа не поддерживается этим каркасом.",
  mode_not_enabled: "На этом этапе разрешён только учебный режим educational.",
  format_not_enabled: "На этом этапе разрешён только формат short_note.",
  operation_not_enabled: "На этом этапе разрешена только операция prepare_draft.",
  provenance_not_enabled: "На этом этапе provenance.kind может быть только fixture.",
  destination_not_metadata:
    "Назначение либо null, либо метаданные будущего действия с metadata_only=true. Исполняемое назначение не принимается.",
  unknown_fixture: "fixture_id нет в локальном каталоге. Путь из текста источника не читается.",
  fixture_mismatch: "Текст источника не совпадает с локальным fixture каталога.",
  insufficient_sources:
    "Недостаточно источников: нужен хотя бы один разрешённый источник с предоставленным текстом.",
  idempotency_conflict:
    "Тот же ключ идемпотентности в этом workspace и этой операции уже связан с другим входом.",
  provider_refused:
    "Учебный поставщик FixtureProvider отказал по явной настройке прогона. Это не оценка модели.",
  storage_error: "Хранилище не записало результат. Запуск не считается succeeded.",
  interrupted:
    "Запуск остался незавершённым после остановки процесса. Восстановление перевело его из незавершённого состояния и оставило отчёт.",
  publication_handler_absent:
    "Обработчик внешней публикации на этом этапе отсутствует. Запрос отклонён.",
  cancelled_by_user: "Запуск отменён по запросу пользователя до завершения.",
  illegal_transition: "Переход состояния запуска запрещён.",
  membership_check_not_implemented:
    "Серверная проверка membership не реализована. Вызов не подтверждает доступ.",
  artifact_missing: "У запуска нет сохранённой версии результата для правки.",
  revision_unchanged: "Текст совпадает с текущей версией. Новая версия не создана.",
  lock_timeout: "Не удалось дождаться блокировки идемпотентности.",
} as const;

export type ErrorCode = keyof typeof MESSAGES;

export const LIMITS = {
  topicMax: 200,
  audienceMax: 200,
  titleMax: 200,
  noteMax: 500,
  providedTextMax: 20_000,
  urlMax: 2_000,
  sourcesMax: 10,
  bodyCharsMax: 20_000,
  channelMax: 64,
  targetMax: 200,
  weakFragmentMin: 12,
  idempotencyMin: 8,
  idempotencyMax: 128,
} as const;

export const FIXTURE_CATALOG: Readonly<Record<string, string>> = {
  "readme-bos-pro-9b46b60": "fixtures/readme-bos-pro.md",
  "readme-bos-pro-injection-9b46b60": "fixtures/readme-bos-pro-injection.md",
};
