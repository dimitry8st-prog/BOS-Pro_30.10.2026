import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { limitationsForUrlStatus } from "../src/checks/draft-checks.js";
import { MembershipCheckNotImplemented } from "../src/boundaries/future-server.js";
import { toDraftReviewViewModel } from "../src/boundaries/future-ui.js";
import { assertTransition, canEnterWaitingApproval } from "../src/contract/transitions.js";
import { executePrepareDraft } from "../src/scenario/execute.js";
import { requestPublication } from "../src/scenario/publish.js";
import { recoverInterruptedRuns } from "../src/scenario/recover.js";
import { reviseDraft } from "../src/scenario/revise.js";
import { DevStore } from "../src/storage/dev-store.js";
import type { RunStore } from "../src/storage/store.js";
import { FixtureProvider } from "../src/provider/fixture-provider.js";
import { validatePrepareDraftInput } from "../src/contract/validate.js";
import type { ExecuteResult, RunRecord } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

type CliResult = { code: number; stdout: string; stderr: string };

function runNode(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseStdout(result: CliResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`stdout is not JSON\n${result.stdout}\n${result.stderr}`);
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "bos-dev-"));
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(repoRoot, file), "utf8")) as unknown;
}

async function countRuns(dir: string): Promise<number> {
  const names = await readdir(path.join(dir, "runs"));
  return names.filter((name) => name.endsWith(".json")).length;
}

function finishedRun(result: ExecuteResult): RunRecord {
  assert.equal(result.outcome, "finished");
  if (result.outcome !== "finished") throw new Error("unreachable");
  return result.run;
}

describe("учебный контракт prepare_draft v0.1", () => {
  test("1. валидный fixture-вход читается новым процессом", async () => {
    const dir = await tempDir();
    try {
      const created = await runNode([cli, "run", "--input", "fixtures/educational-input.json", "--store", dir]);
      assert.equal(created.code, 0, created.stderr + created.stdout);
      const payload = parseStdout(created);
      assert.equal(payload.storage_class, "development-only");
      assert.equal(payload.durable_production_storage, false);
      const result = payload.result as { outcome: string; run: RunRecord };
      assert.equal(result.outcome, "finished");
      assert.equal(result.run.status, "succeeded");
      assert.equal(result.run.fixture, true);
      assert.equal(result.run.provider_name, "FixtureProvider");
      assert.equal(result.run.test_scope.real_model, false);
      assert.equal(result.run.test_scope.live_site, false);
      assert.equal(result.run.test_scope.rls, false);
      assert.equal(result.run.test_scope.production, false);
      assert.equal(result.run.publication.status, "not_published");
      assert.equal(result.run.publication.permitted, false);
      assert.equal(result.run.verification?.status, "pass");
      assert.equal(result.run.costs.model.actual, null);
      assert.equal(result.run.costs.external.actual.amount, "0.00");
      assert.equal(result.run.access_check, "not_performed");
      assert.match(result.run.task_id, /^task_[a-f0-9]{32}$/);
      const task = JSON.parse(await readFile(path.join(dir, "tasks", `${result.run.task_id}.json`), "utf8")) as {
        workspace_id: string;
        project_id: string;
        workflow_version_id: string;
      };
      assert.equal(task.workspace_id, "ws_educational");
      assert.equal(task.project_id, "prj_educational");
      assert.equal(task.workflow_version_id, result.run.workflow_version_id);

      const shown = await runNode([cli, "show", "--run", result.run.run_id, "--store", dir]);
      assert.equal(shown.code, 0, shown.stderr);
      const show = parseStdout(shown);
      const body = show.result as { artifact: { text: string; content_hash: string }; fixture: boolean; run: RunRecord };
      assert.equal(body.fixture, true);
      assert.match(body.artifact.text, /Учебный черновик fixture/);
      assert.match(body.artifact.content_hash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(body.run.verification?.status, "pass");
      const marker = JSON.parse(await readFile(path.join(dir, "DEV_ONLY_STORAGE.json"), "utf8")) as {
        durable_production_storage: boolean;
        process_memory: boolean;
      };
      assert.equal(marker.durable_production_storage, false);
      assert.equal(marker.process_memory, false);
      const reopened = await DevStore.open(dir);
      const again = await reopened.readRun(result.run.run_id);
      assert.equal(again?.run_id, result.run.run_id);
      assert.ok(toDraftReviewViewModel(result.run, body.artifact.text).fixture);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("2. пустая тема, неизвестное поле, бюджет и отсутствие источников", async () => {
    const emptyTopic = validatePrepareDraftInput(await readJson("fixtures/examples/invalid-empty-topic.json"));
    const unknownResult = validatePrepareDraftInput(await readJson("fixtures/examples/invalid-unknown-field.json"));
    const negativeResult = validatePrepareDraftInput(await readJson("fixtures/examples/invalid-budget-negative.json"));
    const externalResult = validatePrepareDraftInput(await readJson("fixtures/examples/invalid-budget-external.json"));
    const omittedResult = validatePrepareDraftInput(await readJson("fixtures/examples/invalid-sources-omitted.json"));
    assert.equal(emptyTopic.ok, false);
    if (!emptyTopic.ok) assert.equal(emptyTopic.error.code, "invalid_topic");
    assert.equal(unknownResult.ok, false);
    if (!unknownResult.ok) assert.equal(unknownResult.error.code, "unknown_field");
    assert.equal(negativeResult.ok, false);
    if (!negativeResult.ok) assert.equal(negativeResult.error.code, "invalid_budget");
    assert.equal(externalResult.ok, false);
    if (!externalResult.ok) assert.equal(externalResult.error.code, "invalid_budget");
    assert.equal(omittedResult.ok, false);
    if (!omittedResult.ok) assert.equal(omittedResult.error.code, "invalid_shape");

    const numeric = await readJson("fixtures/examples/invalid-budget-negative.json");
    if (typeof numeric === "object" && numeric && "budget" in numeric) {
      (numeric as { budget: { amount: unknown } }).budget.amount = 0;
    }
    const numericResult = validatePrepareDraftInput(numeric);
    assert.equal(numericResult.ok, false);
    if (!numericResult.ok) assert.equal(numericResult.error.code, "invalid_budget");

    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const input = await readJson("fixtures/examples/empty-sources.json");
      const failed = await executePrepareDraft(input, { store, root: repoRoot, provider: new FixtureProvider() });
      const run = finishedRun(failed);
      assert.equal(run.status, "failed");
      assert.equal(run.stop?.code, "insufficient_sources");
      assert.equal(run.provider_invoked, false);
      assert.notEqual(run.status, "succeeded");
      const snapshot = await store.readSnapshot(run.run_id);
      assert.ok(snapshot);
      assert.equal(snapshot.input.sources.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("3. один ключ — один run, другой вход — конфликт, после нового процесса дубля нет", async () => {
    const dir = await tempDir();
    try {
      const args = [cli, "run", "--input", "fixtures/educational-input.json", "--store", dir];
      const [first, second] = await Promise.all([runNode(args), runNode(args)]);
      assert.equal(first.code, 0, first.stderr + first.stdout);
      assert.equal(second.code, 0, second.stderr + second.stdout);
      const left = parseStdout(first).result as { run: RunRecord };
      const right = parseStdout(second).result as { run: RunRecord };
      assert.equal(left.run.run_id, right.run.run_id);
      assert.equal(await countRuns(dir), 1);

      const third = await runNode(args);
      assert.equal(third.code, 0, third.stderr);
      const replay = parseStdout(third).result as { replay: boolean; run: RunRecord };
      assert.equal(replay.replay, true);
      assert.equal(replay.run.run_id, left.run.run_id);
      assert.equal(await countRuns(dir), 1);

      const conflictInput = JSON.parse(JSON.stringify(await readJson("fixtures/educational-input.json"))) as {
        topic: string;
      };
      conflictInput.topic = "Другая тема того же ключа";
      const conflictFile = path.join(dir, "conflict.json");
      await writeFile(conflictFile, JSON.stringify(conflictInput));
      const conflict = await runNode([cli, "run", "--input", conflictFile, "--store", dir]);
      assert.equal(conflict.code, 1, conflict.stdout);
      const conflictBody = parseStdout(conflict).result as { outcome: string; error: { code: string }; existing_run_id: string };
      assert.equal(conflictBody.outcome, "conflict");
      assert.equal(conflictBody.error.code, "idempotency_conflict");
      assert.equal(conflictBody.existing_run_id, left.run.run_id);
      assert.equal(await countRuns(dir), 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("4. отказ поставщика и ошибка сохранения не становятся succeeded", async () => {
    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const input = await readJson("fixtures/educational-input.json");
      const refused = await executePrepareDraft(input, { store, root: repoRoot, providerVariant: "refuse" });
      const refusedRun = finishedRun(refused);
      assert.equal(refusedRun.status, "failed");
      assert.equal(refusedRun.stop?.code, "provider_refused");
      assert.equal(refusedRun.artifact_id, null);
      assert.ok(await store.readSnapshot(refusedRun.run_id));
      assert.ok(refusedRun.journal.some((entry) => entry.step === "provider" && entry.error_code === "provider_refused"));

      const other = JSON.parse(JSON.stringify(input)) as { idempotency_key: string };
      other.idempotency_key = "edu-storage-error001";
      const failing = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "saveArtifactRevision") {
            return async () => {
              throw Object.assign(new Error("simulated SECRET_DISK"), { code: "storage_error" });
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as RunStore;
      const saved = await executePrepareDraft(other, { store: failing, root: repoRoot });
      const failedRun = finishedRun(saved);
      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.stop?.code, "storage_error");
      assert.notEqual(failedRun.status, "succeeded");
      const persisted = await readFile(path.join(dir, "runs", `${failedRun.run_id}.json`), "utf8");
      assert.equal(persisted.includes("SECRET_DISK"), false);
      assert.match(persisted, /storage_error/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("5. длина и ссылки исполняются, доступность не доказывает истинность", async () => {
    const input = await readJson("fixtures/educational-input.json");
    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const ok = finishedRun(await executePrepareDraft(input, { store, root: repoRoot }));
      const length = ok.verification?.checks.find((check) => check.code === "body_length");
      const links = ok.verification?.checks.find((check) => check.code === "sources_separate");
      assert.equal(length?.executed, true);
      assert.equal(length?.pass, true);
      assert.match(length?.detail ?? "", /Длина основного текста \d+ при максимуме 600/);
      assert.equal(links?.executed, true);
      assert.equal(links?.pass, true);
      assert.ok(ok.verification?.url_checks.every((item) => item.status === "not_checked" && item.checked_at === null));
      assert.match(ok.verification?.limitations.join("\n") ?? "", /не является доказательством истинности/);
      assert.match(limitationsForUrlStatus("reachable"), /не является доказательством истинности/);
      assert.equal(limitationsForUrlStatus("reachable").includes("утверждение доказано"), false);

      const longKey = JSON.parse(JSON.stringify(input)) as { idempotency_key: string };
      longKey.idempotency_key = "edu-overlong-check01";
      const longRun = finishedRun(await executePrepareDraft(longKey, { store, root: repoRoot, providerVariant: "overlong" }));
      const longCheck = longRun.verification?.checks.find((check) => check.code === "body_length");
      assert.equal(longRun.status, "succeeded");
      assert.equal(longCheck?.executed, true);
      assert.equal(longCheck?.pass, false);
      assert.match(longCheck?.detail ?? "", /Длина основного текста 6\d\d при максимуме 600/);
      assert.equal(longRun.quality_gate, "blocked");
      assert.equal(longRun.publication.permitted, false);

      const omitKey = JSON.parse(JSON.stringify(input)) as { idempotency_key: string };
      omitKey.idempotency_key = "edu-omit-sources001";
      const omitRun = finishedRun(await executePrepareDraft(omitKey, { store, root: repoRoot, providerVariant: "omit_sources" }));
      const separate = omitRun.verification?.checks.find((check) => check.code === "sources_separate");
      assert.equal(separate?.executed, true);
      assert.equal(separate?.pass, false);
      assert.equal(omitRun.verification?.status, "fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("6. правка текста создаёт новую версию и сохраняет прежнюю", async () => {
    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const input = await readJson("fixtures/educational-input.json");
      const run = finishedRun(await executePrepareDraft(input, { store, root: repoRoot }));
      assert.ok(run.artifact_id);
      assert.equal(run.current_revision, 1);
      const first = await store.readArtifactRevision(run.artifact_id, 1);
      assert.ok(first);
      const revised = await reviseDraft(store, run.run_id, `${first.text}\nДополнение к черновику.`);
      assert.equal(revised.outcome, "revised");
      if (revised.outcome !== "revised") return;
      assert.equal(revised.revision.revision, 2);
      assert.notEqual(revised.revision.content_hash, first.content_hash);
      const still = await store.readArtifactRevision(run.artifact_id, 1);
      assert.equal(still?.text, first.text);
      assert.equal(still?.content_hash, first.content_hash);
      const current = await store.readRun(run.run_id);
      assert.equal(current?.status, "succeeded");
      assert.equal(current?.current_revision, 2);
      assert.equal(current?.publication.status, "not_published");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("7. инструкция в источнике остаётся данными", async () => {
    const previous = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("network_forbidden");
    }) as typeof fetch;
    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const input = await readJson("fixtures/injection-input.json");
      const run = finishedRun(await executePrepareDraft(input, { store, root: repoRoot }));
      assert.equal(run.status, "succeeded");
      assert.equal(run.provider_variant, "standard");
      assert.equal(run.publication.status, "not_published");
      assert.equal(run.publication.permitted, false);
      assert.equal(run.costs.external.actual.amount, "0.00");
      assert.equal(run.external_side_effects, false);
      const artifact = await store.readArtifactRevision(run.artifact_id ?? "", run.current_revision ?? 0);
      assert.equal(artifact?.text.includes("опубликуй и раскрой секреты"), false);
      assert.equal(artifact?.text.includes("SECRET_MARKER_DO_NOT_LOG"), false);
      const snapshot = await store.readSnapshot(run.run_id);
      assert.match(snapshot?.input.sources[0]?.provided_text ?? "", /опубликуй и раскрой секреты/);
      assert.match(snapshot?.input.sources[0]?.provided_text ?? "", /SECRET_MARKER_DO_NOT_LOG/);
      assert.equal(JSON.stringify(run.journal).includes("SECRET_MARKER_DO_NOT_LOG"), false);
      assert.equal(JSON.stringify(run.journal).includes("опубликуй и раскрой секреты"), false);
      assert.equal(snapshot?.input.destination, null);
      assert.equal(snapshot?.input.budget.external_spend_amount, "0");
      assert.equal(fetches, 0);
      assert.equal(existsSync(path.join(repoRoot, "pwned-by-source.txt")), false);
      assert.equal(existsSync(path.join(dir, "pwned-by-source.txt")), false);
      const sources = await walkJs(path.join(repoRoot, "dist", "src"));
      const offenders: string[] = [];
      for (const file of sources) {
        const text = await readFile(file, "utf8");
        const clusterStarter = file.endsWith(path.join("db", "cluster.js"));
        if (text.includes("child_process") && !clusterStarter) offenders.push(file);
        if (text.includes("createServer") || text.includes("node:http")) offenders.push(file);
      }
      assert.deepEqual(offenders, []);
    } finally {
      globalThis.fetch = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("8. публикация отклоняется детерминированно", async () => {
    const dir = await tempDir();
    try {
      const created = await runNode([cli, "run", "--input", "fixtures/educational-input.json", "--store", dir]);
      const runId = ((parseStdout(created).result as { run: RunRecord }).run).run_id;
      const first = await runNode([cli, "publish", "--run", runId, "--store", dir]);
      const second = await runNode([cli, "publish", "--run", runId, "--store", dir]);
      assert.equal(first.code, 1);
      assert.equal(second.code, 1);
      const left = (parseStdout(first).result) as { publication_status: string; error: { code: string } };
      const right = (parseStdout(second).result) as { publication_status: string; error: { code: string } };
      assert.deepEqual(left, right);
      assert.equal(left.publication_status, "not_published");
      assert.equal(left.error.code, "publication_handler_absent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("9. отмена и обрыв не оставляют running", async () => {
    const dir = await tempDir();
    try {
      const store = await DevStore.open(dir);
      const input = await readJson("fixtures/educational-input.json");
      const cancelled = await executePrepareDraft(input, {
        store,
        root: repoRoot,
        onStep: async (step, runId) => {
          if (step === "before_provider") await store.requestCancel(runId);
        },
      });
      const cancelledRun = finishedRun(cancelled);
      assert.equal(cancelledRun.status, "cancelled");
      assert.equal(cancelledRun.stop?.code, "cancelled_by_user");
      assert.notEqual(cancelledRun.status, "running");

      const interruptFile = JSON.parse(JSON.stringify(input)) as { idempotency_key: string };
      interruptFile.idempotency_key = "edu-interrupt-000001";
      const interruptPath = path.join(dir, "interrupt.json");
      await writeFile(interruptPath, JSON.stringify(interruptFile));
      const interrupted = await runNode([
        cli,
        "run",
        "--input",
        interruptPath,
        "--store",
        dir,
        "--interrupt-after",
        "running",
      ]);
      assert.equal(interrupted.code, 3, interrupted.stdout + interrupted.stderr);
      const hanging = (parseStdout(interrupted).result as { outcome: string; run: RunRecord });
      assert.equal(hanging.outcome, "interrupted");
      assert.equal(hanging.run.status, "running");
      const recovered = await runNode([cli, "recover", "--store", dir]);
      assert.equal(recovered.code, 0, recovered.stderr + recovered.stdout);
      const rows = (parseStdout(recovered).result) as RunRecord[];
      const restored = rows.find((item) => item.run_id === hanging.run.run_id);
      assert.ok(restored);
      assert.equal(restored.status, "failed");
      assert.equal(restored.stop?.code, "interrupted");
      assert.equal(restored.recovery?.previous_status, "running");
      assert.match(restored.recovery?.message ?? "", /Восстановление/);
      const shown = await runNode([cli, "show", "--run", hanging.run.run_id, "--store", dir]);
      const shownRun = (parseStdout(shown).result as { run: RunRecord }).run;
      assert.equal(shownRun.status, "failed");
      assert.notEqual(shownRun.status, "running");

      const cancelInput = JSON.parse(JSON.stringify(input)) as { idempotency_key: string };
      cancelInput.idempotency_key = "edu-cancel-recover01";
      const abandoned = await executePrepareDraft(cancelInput, { store, root: repoRoot, interruptAfter: "running" });
      assert.equal(abandoned.outcome, "interrupted");
      if (abandoned.outcome !== "interrupted") return;
      abandoned.run.cancel_requested = true;
      await store.saveRun(abandoned.run);
      const second = await recoverInterruptedRuns(await DevStore.open(dir));
      const cancelledAfter = second.find((item) => item.run_id === abandoned.run.run_id);
      assert.equal(cancelledAfter?.status, "cancelled");
      assert.equal(cancelledAfter?.recovery?.code, "cancelled_by_user");
      const third = await recoverInterruptedRuns(await DevStore.open(dir));
      assert.equal(third.some((item) => item.run_id === abandoned.run.run_id), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("10. границы этапа: не модель, не RLS, не публикация, не waiting_approval", async () => {
    assert.throws(
      () => assertTransition("running", "waiting_approval"),
      (error: unknown) => (error as { code?: string }).code === "illegal_transition",
    );
    assert.equal(canEnterWaitingApproval(), false);
    await assert.rejects(
      () => new MembershipCheckNotImplemented().assertMember({ currentUserId: "user", workspaceId: "ws_educational", projectId: "prj_educational" }),
      (error: unknown) => (error as { code?: string }).code === "membership_check_not_implemented",
    );
    const dir = await tempDir();
    try {
      const library = await requestPublication(await DevStore.open(dir), "run_00000000000000000000000000000000");
      assert.equal(library.error.code, "publication_handler_absent");
      assert.equal(library.publication_status, "not_published");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function walkJs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkJs(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}
