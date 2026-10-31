import { readFile } from "node:fs/promises";
import path from "node:path";
import { STORAGE_CLASS } from "./contract/constants.js";
import type { ProviderVariant } from "./contract/types.js";
import { executePrepareDraft } from "./scenario/execute.js";
import { requestPublication } from "./scenario/publish.js";
import { recoverInterruptedRuns } from "./scenario/recover.js";
import { reviseDraft } from "./scenario/revise.js";
import { DevStore } from "./storage/dev-store.js";

const VARIANTS: readonly ProviderVariant[] = [
  "standard",
  "refuse",
  "overlong",
  "unbound",
  "savings",
  "omit_sources",
  "weak_fragment",
];

type Args = Map<string, string | boolean>;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  if (!command || command === "help" || args.has("help")) {
    emit({ command: "usage", storage_class: STORAGE_CLASS, durable_production_storage: false, error: usageError() }, 2);
    return;
  }
  const storePath = args.get("store");
  if (typeof storePath !== "string") {
    emit({ command, storage_class: STORAGE_CLASS, durable_production_storage: false, error: usageError("Нужен --store") }, 2);
    return;
  }
  const store = await DevStore.open(path.resolve(storePath));
  if (command === "run") {
    await runCommand(store, args);
    return;
  }
  if (command === "show") {
    await showCommand(store, args);
    return;
  }
  if (command === "publish") {
    await publishCommand(store, args);
    return;
  }
  if (command === "recover") {
    const recovered = await recoverInterruptedRuns(store);
    emit({ command: "recover", storage_class: STORAGE_CLASS, durable_production_storage: false, result: recovered }, 0);
    return;
  }
  if (command === "revise") {
    await reviseCommand(store, args);
    return;
  }
  emit({ command: "usage", storage_class: STORAGE_CLASS, durable_production_storage: false, error: usageError() }, 2);
}

async function runCommand(store: DevStore, args: Args): Promise<void> {
  const inputPath = args.get("input");
  if (typeof inputPath !== "string") {
    emit(envelope("run", { error: usageError("Нужен --input") }), 2);
    return;
  }
  const variantArg = args.get("provider");
  const variant: ProviderVariant = typeof variantArg === "string" ? (variantArg as ProviderVariant) : "standard";
  if (!VARIANTS.includes(variant)) {
    emit(envelope("run", { error: usageError("Неизвестный --provider") }), 2);
    return;
  }
  const interrupt = args.get("interrupt-after");
  if (interrupt !== undefined && interrupt !== "running") {
    emit(envelope("run", { error: usageError("Поддерживается только --interrupt-after running") }), 2);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as unknown;
  } catch {
    emit(envelope("run", { result: { outcome: "rejected", error: { code: "invalid_shape", message: "Файл входа не является JSON.", field: null }, run: null } }), 1);
    return;
  }
  const result = await executePrepareDraft(raw, {
    store,
    root: process.cwd(),
    providerVariant: variant,
    ...(interrupt === "running" ? { interruptAfter: "running" as const } : {}),
  });
  const code = exitCode(result.outcome, result.outcome === "finished" ? result.run.status : null);
  emit(envelope("run", { result }), code);
}

async function showCommand(store: DevStore, args: Args): Promise<void> {
  const runId = args.get("run");
  if (typeof runId !== "string") {
    emit(envelope("show", { error: usageError("Нужен --run") }), 2);
    return;
  }
  const run = await store.readRun(runId);
  if (!run) {
    emit(envelope("show", { error: { code: "not_found", message: "Запуск не найден в локальном учебном хранилище.", field: "run" } }), 1);
    return;
  }
  const artifact =
    run.artifact_id !== null && run.current_revision !== null
      ? await store.readArtifactRevision(run.artifact_id, run.current_revision)
      : null;
  const snapshot = await store.readSnapshot(runId);
  emit(
    envelope("show", {
      result: {
        run,
        artifact,
        snapshot_kept: snapshot !== null,
        fixture: true,
        storage_class: STORAGE_CLASS,
      },
    }),
    0,
  );
}

async function publishCommand(store: DevStore, args: Args): Promise<void> {
  const runId = args.get("run");
  if (typeof runId !== "string") {
    emit(envelope("publish", { error: usageError("Нужен --run") }), 2);
    return;
  }
  const result = await requestPublication(store, runId);
  emit(envelope("publish", { result }), 1);
}

async function reviseCommand(store: DevStore, args: Args): Promise<void> {
  const runId = args.get("run");
  const textFile = args.get("text-file");
  if (typeof runId !== "string" || typeof textFile !== "string") {
    emit(envelope("revise", { error: usageError("Нужны --run и --text-file") }), 2);
    return;
  }
  const text = await readFile(path.resolve(textFile), "utf8");
  const result = await reviseDraft(store, runId, text.replace(/\r\n/g, "\n"));
  emit(envelope("revise", { result }), result.outcome === "rejected" ? 1 : 0);
}

function exitCode(outcome: string, status: string | null): number {
  if (outcome === "interrupted") return 3;
  if (outcome === "finished" && status === "succeeded") return 0;
  return 1;
}

function envelope(command: string, body: Record<string, unknown>): Record<string, unknown> {
  return { command, storage_class: STORAGE_CLASS, durable_production_storage: false, ...body };
}

function usageError(message = "Команды: run, show, publish, recover, revise."): { code: string; message: string; field: null } {
  return { code: "usage", message, field: null };
}

function emit(payload: unknown, code: number): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
}

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args.set(key, true);
    else {
      args.set(key, next);
      index += 1;
    }
  }
  return args;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "cli_error";
  process.stdout.write(
    `${JSON.stringify({ command: "error", storage_class: STORAGE_CLASS, durable_production_storage: false, error: { code: "storage_error", message, field: null } })}\n`,
  );
  process.exitCode = 1;
});
