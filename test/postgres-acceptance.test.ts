import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resetEducationalDatabase } from "../src/db/bootstrap.js";
import { LOCAL_DATABASE, LOCAL_HOST, LOCAL_PORT, localPassword, type LocalActor } from "../src/db/local-test.js";
import { executePrepareDraft } from "../src/scenario/execute.js";
import { recoverInterruptedRuns } from "../src/scenario/recover.js";
import { reviseDraft } from "../src/scenario/revise.js";
import { PostgresStore } from "../src/storage/postgres-store.js";
import type { ExecuteResult, PrepareDraftInput, RunRecord } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");
const localUrl = `postgres://usr_educational:${localPassword("usr_educational")}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DATABASE}`;

type CliResult = { code: number; stdout: string; stderr: string };

before(async () => {
  await resetEducationalDatabase();
});

describe("PostgreSQL учебного сценария prepare_draft", () => {
  test("миграции применяются на чистой базе, прикладная роль не обходит RLS", async () => {
    const admin = await adminClient();
    try {
      const versions = await admin.query<{ version: string }>("SELECT version FROM schema_migration ORDER BY version");
      assert.deepEqual(versions.rows.map((row) => row.version), ["0001_scenario_tables"]);
      const absent = await admin.query<{ campaign: string | null; experiment: string | null }>(
        "SELECT to_regclass('public.campaign') AS campaign, to_regclass('public.experiment') AS experiment",
      );
      assert.equal(absent.rows[0]?.campaign, null);
      assert.equal(absent.rows[0]?.experiment, null);
    } finally {
      await admin.end();
    }

    const names = await asUser<{ table_name: string }>(
      "usr_educational",
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    assert.deepEqual(names.rows.map((row) => row.table_name), [
      "artifact",
      "audit_event",
      "project",
      "run",
      "run_step",
      "task",
      "verification",
      "workflow_version",
      "workspace",
      "workspace_membership",
    ]);
    await assert.rejects(() => asUser("usr_educational", "SELECT version FROM schema_migration"));

    const role = await asUser<{ user_id: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "usr_educational",
      "SELECT current_user AS user_id, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(role.rows[0]?.user_id, "usr_educational");
    assert.equal(role.rows[0]?.rolsuper, false);
    assert.equal(role.rows[0]?.rolbypassrls, false);
  });

  test("задача проходит сценарий и читается новым процессом", async () => {
    const created = await runNode([
      cli,
      "run",
      "--input",
      "fixtures/educational-input.json",
      "--database-url",
      localUrl,
      "--actor",
      "usr_educational",
    ]);
    assert.equal(created.code, 0, created.stderr + created.stdout);
    const payload = JSON.parse(created.stdout) as { storage_kind: string; durable_production_storage: boolean; result: { run: RunRecord } };
    assert.equal(payload.storage_kind, "postgres");
    assert.equal(payload.durable_production_storage, false);
    const run = payload.result.run;
    assert.equal(run.status, "succeeded");
    assert.equal(run.access_check, "educational_membership_checked");
    assert.equal(run.publication.status, "not_published");
    assert.equal(run.verification?.status, "pass");
    assert.match(run.task_id, /^task_[a-f0-9]{32}$/);

    const shown = await runNode([
      cli,
      "show",
      "--run",
      run.run_id,
      "--database-url",
      localUrl,
      "--actor",
      "usr_educational",
    ]);
    assert.equal(shown.code, 0, shown.stderr + shown.stdout);
    const body = JSON.parse(shown.stdout) as { result: { artifact: { content_hash: string }; snapshot_kept: boolean } };
    assert.equal(body.result.snapshot_kept, true);
    assert.match(body.result.artifact.content_hash, /^sha256:[a-f0-9]{64}$/);

    const tasks = await asUser<{ count: number }>(
      "usr_educational",
      "SELECT count(*)::int AS count FROM task WHERE id = $1 AND workspace_id = 'ws_educational' AND project_id = 'prj_educational'",
      [run.task_id],
    );
    assert.equal(tasks.rows[0]?.count, 1);
    const versions = await asUser<{ count: number }>(
      "usr_educational",
      "SELECT count(*)::int AS count FROM verification WHERE artifact_id = $1 AND artifact_revision = 1",
      [run.artifact_id],
    );
    assert.equal(versions.rows[0]?.count, 1);
  });

  test("два пользователя из разных workspace не видят и не изменяют чужие данные", async () => {
    const store = await PostgresStore.open("usr_educational");
    const other = await PostgresStore.open("usr_other");
    try {
      const result = await executePrepareDraft(await loadInput("edu-pg-isolation-01"), { store, root: repoRoot });
      const run = finishedRun(result);
      assert.equal(await other.readRun(run.run_id), null);
      assert.equal((await other.listRuns()).some((item) => item.workspace_id === "ws_educational"), false);
      await other.requestCancel(run.run_id);
      const again = await store.readRun(run.run_id);
      assert.equal(again?.cancel_requested, false);
      assert.equal(again?.status, "succeeded");

      const hidden = await asUser<{ count: number }>("usr_other", "SELECT count(*)::int AS count FROM run");
      assert.equal(hidden.rows[0]?.count, 0);
      const updated = await asUser("usr_other", "UPDATE run SET status = 'cancelled' WHERE id = $1", [run.run_id]);
      assert.equal(updated.rowCount, 0);
      const denied = await asUser<{ count: number }>("usr_other", "SELECT count(*)::int AS count FROM workspace WHERE id = 'ws_educational'");
      assert.equal(denied.rows[0]?.count, 0);
    } finally {
      await store.close();
      await other.close();
    }
  });

  test("нельзя связать задачу с чужим проектом", async () => {
    const store = await PostgresStore.open("usr_educational");
    try {
      const result = await executePrepareDraft(await loadInput("edu-pg-foreign-0001", { project_id: "prj_other" }), {
        store,
        root: repoRoot,
      });
      assert.equal(result.outcome, "rejected");
      if (result.outcome !== "rejected") return;
      assert.equal(result.error.code, "project_not_in_workspace");
      const tasks = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM task WHERE title = 'Как проверять результат выполнения задачи' AND project_id = 'prj_other'",
      );
      assert.equal(tasks.rows[0]?.count, 0);
      await assert.rejects(() =>
        asUser(
          "usr_educational",
          `INSERT INTO task (id, workspace_id, project_id, title, created_by, created_at)
           VALUES ('task_foreignattempt00000000000001', 'ws_educational', 'prj_other', 'чужой проект', current_user, now())`,
        ),
      );
      await assert.rejects(() =>
        asUser(
          "usr_educational",
          `INSERT INTO task (id, workspace_id, project_id, title, created_by, created_at)
           VALUES ('task_otherworkspace0000000000001', 'ws_other', 'prj_other', 'чужой workspace', current_user, now())`,
        ),
      );
    } finally {
      await store.close();
    }
  });

  test("повторные и конкурентные запросы не создают дубль, другой вход даёт конфликт", async () => {
    const input = await loadInput("edu-pg-concurrent1");
    const file = await writeTempInput(input);
    try {
      const pair = await Promise.all([
        runNode([cli, "run", "--input", file, "--database-url", localUrl, "--actor", "usr_educational"]),
        runNode([cli, "run", "--input", file, "--database-url", localUrl, "--actor", "usr_educational"]),
      ]);
      for (const item of pair) assert.equal(item.code, 0, item.stderr + item.stdout);
      const ids = pair.map((item) => (JSON.parse(item.stdout) as { result: { run: RunRecord } }).result.run.run_id);
      assert.equal(ids[0], ids[1]);
      const count = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM run WHERE idempotency_key = 'edu-pg-concurrent1'",
      );
      assert.equal(count.rows[0]?.count, 1);

      const conflictInput = { ...input, topic: "Другая тема того же ключа" };
      const conflictFile = await writeTempInput(conflictInput);
      const conflict = await runNode([cli, "run", "--input", conflictFile, "--database-url", localUrl, "--actor", "usr_educational"]);
      assert.equal(conflict.code, 1, conflict.stdout);
      const body = JSON.parse(conflict.stdout) as { result: { outcome: string; error: { code: string } } };
      assert.equal(body.result.outcome, "conflict");
      assert.equal(body.result.error.code, "idempotency_conflict");
      const still = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM run WHERE idempotency_key = 'edu-pg-concurrent1'",
      );
      assert.equal(still.rows[0]?.count, 1);
    } finally {
      await rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  test("ошибка, отмена, прерывание и сбой записи отражаются без успешного частичного результата", async () => {
    const store = await PostgresStore.open("usr_educational");
    try {
      const refused = await executePrepareDraft(await loadInput("edu-pg-refuse-0001"), {
        store,
        root: repoRoot,
        providerVariant: "refuse",
      });
      const refusedRun = finishedRun(refused);
      assert.equal(refusedRun.status, "failed");
      assert.equal(refusedRun.stop?.code, "provider_refused");
      assert.equal(refusedRun.artifact_id, null);
      const refusedSteps = await asUser<{ error_code: string | null }>(
        "usr_educational",
        "SELECT error_code FROM run_step WHERE run_id = $1 AND step = 'provider'",
        [refusedRun.run_id],
      );
      assert.equal(refusedSteps.rows[0]?.error_code, "provider_refused");

      const cancelled = await executePrepareDraft(await loadInput("edu-pg-cancel-0001"), {
        store,
        root: repoRoot,
        onStep: async (step, runId) => {
          if (step === "before_provider") await store.requestCancel(runId);
        },
      });
      const cancelledRun = finishedRun(cancelled);
      assert.equal(cancelledRun.status, "cancelled");
      assert.equal(cancelledRun.stop?.code, "cancelled_by_user");
      const cancelAudit = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM audit_event WHERE entity_id = $1 AND actor_user_id = current_user",
        [cancelledRun.run_id],
      );
      assert.ok((cancelAudit.rows[0]?.count ?? 0) > 0);

      const interrupted = await executePrepareDraft(await loadInput("edu-pg-interrupt01"), {
        store,
        root: repoRoot,
        interruptAfter: "running",
      });
      assert.equal(interrupted.outcome, "interrupted");
      const recovered = await recoverInterruptedRuns(store);
      const recoveredRun = recovered.find((run) => run.idempotency_key === "edu-pg-interrupt01");
      assert.equal(recoveredRun?.status, "failed");
      assert.equal(recoveredRun?.stop?.code, "interrupted");
      assert.equal(recoveredRun?.recovery?.previous_status, "running");

      const broken = await executePrepareDraft(await loadInput("edu-pg-storage-001"), {
        store,
        root: repoRoot,
        onStep: (step) => {
          if (step === "before_persist") store.failNextCommit = true;
        },
      });
      const brokenRun = finishedRun(broken);
      assert.equal(brokenRun.status, "failed");
      assert.equal(brokenRun.stop?.code, "storage_error");
      assert.equal(brokenRun.artifact_id, null);
      const artifacts = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM artifact WHERE run_id = $1",
        [brokenRun.run_id],
      );
      assert.equal(artifacts.rows[0]?.count, 0);
      const persisted = await asUser<{ status: string }>("usr_educational", "SELECT status FROM run WHERE id = $1", [brokenRun.run_id]);
      assert.equal(persisted.rows[0]?.status, "failed");
      const failureStep = await asUser<{ error_code: string | null }>(
        "usr_educational",
        "SELECT error_code FROM run_step WHERE run_id = $1 AND step = 'persist'",
        [brokenRun.run_id],
      );
      assert.equal(failureStep.rows[0]?.error_code, "storage_error");
    } finally {
      await store.close();
    }
  });

  test("версия результата неизменяема, проверка относится к ней, повтор создаёт новый запуск", async () => {
    const store = await PostgresStore.open("usr_educational");
    try {
      const first = finishedRun(await executePrepareDraft(await loadInput("edu-pg-version-001"), { store, root: repoRoot }));
      assert.ok(first.artifact_id);
      const artifactId = first.artifact_id;
      if (!artifactId) return;
      const revised = await reviseDraft(store, first.run_id, `${(await store.readArtifactRevision(artifactId, 1))?.text ?? ""}\nДополнение.`);
      assert.equal(revised.outcome, "revised");
      if (revised.outcome !== "revised") return;
      assert.equal(revised.revision.revision, 2);
      assert.notEqual(revised.revision.content_hash, revised.previous.content_hash);
      const original = await store.readArtifactRevision(artifactId, 1);
      assert.equal(original?.text, revised.previous.text);
      const checks = await asUser<{ artifact_revision: number; count: number }>(
        "usr_educational",
        "SELECT artifact_revision, count(*)::int AS count FROM verification WHERE artifact_id = $1 GROUP BY artifact_revision ORDER BY artifact_revision",
        [artifactId],
      );
      assert.deepEqual(checks.rows, [
        { artifact_revision: 1, count: 1 },
        { artifact_revision: 2, count: 1 },
      ]);
      await assert.rejects(() => asUser("usr_educational", "UPDATE artifact SET body = 'подмена' WHERE id = $1 AND revision = 1", [artifactId]), /artifact_revision_immutable/);
      await assert.rejects(() => asUser("usr_educational", "UPDATE verification SET status = 'fail' WHERE artifact_id = $1 AND artifact_revision = 1", [artifactId]), /verification_immutable/);
      const kept = await asUser<{ body: string }>("usr_educational", "SELECT body FROM artifact WHERE id = $1 AND revision = 1", [artifactId]);
      assert.equal(kept.rows[0]?.body, original?.text);

      const retry = finishedRun(
        await executePrepareDraft(await loadInput("edu-pg-version-002", { retry_of_run_id: first.run_id }), { store, root: repoRoot }),
      );
      assert.notEqual(retry.run_id, first.run_id);
      assert.notEqual(retry.task_id, first.task_id);
      assert.equal(retry.retry_of_run_id, first.run_id);
    } finally {
      await store.close();
    }
  });

  test("user_id в теле запроса не принимается как личность", async () => {
    const store = await PostgresStore.open("usr_educational");
    try {
      const input = await loadInput("edu-pg-userid-0001");
      const result = await executePrepareDraft({ ...input, user_id: "usr_other" }, { store, root: repoRoot });
      assert.equal(result.outcome, "rejected");
      if (result.outcome !== "rejected") return;
      assert.equal(result.error.code, "unknown_field");
      assert.equal(result.error.field, "user_id");
      const runs = await asUser<{ count: number }>(
        "usr_educational",
        "SELECT count(*)::int AS count FROM run WHERE idempotency_key = 'edu-pg-userid-0001'",
      );
      assert.equal(runs.rows[0]?.count, 0);
    } finally {
      await store.close();
    }
  });
});

async function loadInput(key: string, patch: Record<string, unknown> = {}): Promise<PrepareDraftInput> {
  const base = JSON.parse(await readFile(path.join(repoRoot, "fixtures", "educational-input.json"), "utf8")) as PrepareDraftInput;
  return { ...base, ...patch, idempotency_key: key } as PrepareDraftInput;
}

async function writeTempInput(input: PrepareDraftInput): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bos-pg-"));
  const file = path.join(dir, "input.json");
  await writeFile(file, JSON.stringify(input), "utf8");
  return file;
}

function finishedRun(result: ExecuteResult): RunRecord {
  assert.equal(result.outcome, "finished");
  if (result.outcome !== "finished") throw new Error("unreachable");
  return result.run;
}

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

async function asUser<T extends pg.QueryResultRow>(user: LocalActor, sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    database: LOCAL_DATABASE,
    user,
    password: localPassword(user),
  });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

async function adminClient(): Promise<pg.Client> {
  const client = new pg.Client({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    database: LOCAL_DATABASE,
    user: "postgres",
  });
  await client.connect();
  return client;
}
