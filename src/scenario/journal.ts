import { MESSAGES } from "../contract/constants.js";
import type { CostReport, JournalEntry, RunRecord } from "../contract/types.js";

export function appendJournal(
  run: RunRecord,
  step: string,
  outcome: JournalEntry["outcome"],
  errorCode: string | null,
  artifactRefs: string[] = [],
): void {
  const entry: JournalEntry = {
    run_id: run.run_id,
    step,
    at: new Date().toISOString(),
    outcome,
    error_code: errorCode,
    schema_version: run.schema_version,
    rules_version: run.rules_version,
    artifact_refs: artifactRefs,
    costs: structuredClone(run.costs) as CostReport,
  };
  run.journal.push(entry);
  run.updated_at = entry.at;
}

export function nextUserAction(run: RunRecord): string {
  if (run.status === "cancelled") {
    return "Запуск отменён. Повтор выполняется отдельным run со ссылкой на этот.";
  }
  if (run.status === "failed" && run.stop?.code === "insufficient_sources") {
    return "Добавьте разрешённый источник с текстом и повторите выполнение отдельным запуском. Этот запуск не переписывается.";
  }
  if (run.status === "failed") {
    return `Запуск остановлен (${run.stop?.code ?? "failed"}). Повтор выполняется отдельным run. ${run.stop?.message ?? ""}`.trim();
  }
  if (run.verification?.status === "pass") {
    return "Черновик сохранён и помечен fixture. Просмотрите текст и отчёт. Внешняя публикация на этом этапе недоступна.";
  }
  if (run.verification) {
    return "Проверка не пройдена. Внешнее действие заблокировано. Можно сохранить новую версию текста. Публикация недоступна.";
  }
  return MESSAGES.interrupted;
}
