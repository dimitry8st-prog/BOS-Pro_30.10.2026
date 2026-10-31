import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACCESS_CHECK_NOTE, EDUCATIONAL_WORKFLOW_VERSION_ID, MESSAGES, STORAGE_CLASS } from "../contract/constants.js";
import { isTerminal, type ArtifactRevision, type IdempotencyRecord, type InputSnapshot, type RunRecord } from "../contract/types.js";
import { pidAlive } from "./pid.js";
import type { RunStore } from "./store.js";

export type { RunStore };

const MARKER = {
  storage_class: STORAGE_CLASS,
  durable_production_storage: false,
  process_memory: false,
  note: "Локальный каталог учебного прогона. Файлы переживают перезапуск процесса только на диске этой машины. Это не PostgreSQL, не Supabase, не общее хранилище и не сервер.",
};

export class DevStore implements RunStore {
  readonly kind = "development-file" as const;
  readonly durableProduction = false as const;
  readonly accessCheck = "not_performed" as const;
  readonly accessCheckNote = ACCESS_CHECK_NOTE;

  private constructor(readonly directory: string) {}

  static async open(directory: string): Promise<DevStore> {
    const store = new DevStore(directory);
    await mkdir(directory, { recursive: true });
    const markerPath = path.join(directory, "DEV_ONLY_STORAGE.json");
    try {
      await writeFile(markerPath, JSON.stringify(MARKER, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return store;
  }

  async createRun(run: RunRecord, snapshot: InputSnapshot, idempotency: IdempotencyRecord): Promise<void> {
    assertSafeId(run.task_id, /^task_[a-f0-9]{32}$/);
    if (run.workflow_version_id !== EDUCATIONAL_WORKFLOW_VERSION_ID) {
      throw Object.assign(new Error(MESSAGES.storage_error), { code: "storage_error" });
    }
    const taskFile = path.join(this.directory, "tasks", `${run.task_id}.json`);
    await mkdir(path.dirname(taskFile), { recursive: true });
    await writeFile(
      taskFile,
      JSON.stringify(
        {
          task_id: run.task_id,
          workspace_id: run.workspace_id,
          project_id: run.project_id,
          workflow_version_id: run.workflow_version_id,
          topic: snapshot.input.topic,
          created_at: run.created_at,
        },
        null,
        2,
      ) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    const workflowFile = path.join(this.directory, "workflows", `${run.workflow_version_id}.json`);
    await mkdir(path.dirname(workflowFile), { recursive: true });
    try {
      await writeFile(
        workflowFile,
        JSON.stringify(
          {
            workflow_version_id: run.workflow_version_id,
            scenario_version: run.scenario_version,
            rules_version: run.rules_version,
            immutable: true,
          },
          null,
          2,
        ) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.saveSnapshot(snapshot);
    await this.saveRun(run);
    await this.putIdempotency(idempotency);
  }

  async saveRun(run: RunRecord): Promise<void> {
    assertSafeId(run.run_id, /^run_[a-f0-9]{32}$/);
    const file = this.runPath(run.run_id);
    const current = await this.readRun(run.run_id);
    if (current?.cancel_requested) run.cancel_requested = true;
    if (current && isTerminal(current.status) && run.status !== current.status) {
      throw Object.assign(new Error(MESSAGES.illegal_transition), { code: "illegal_transition" });
    }
    await atomicWrite(file, JSON.stringify(run, null, 2) + "\n");
  }

  async readRun(runId: string): Promise<RunRecord | null> {
    return readJson(this.runPath(runId));
  }

  async listRuns(): Promise<RunRecord[]> {
    const dir = path.join(this.directory, "runs");
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const run = await readJson<RunRecord>(path.join(dir, name));
      if (run) runs.push(run);
    }
    return runs;
  }

  async saveSnapshot(snapshot: InputSnapshot): Promise<void> {
    assertSafeId(snapshot.run_id, /^run_[a-f0-9]{32}$/);
    const file = path.join(this.directory, "snapshots", `${snapshot.run_id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  }

  async readSnapshot(runId: string): Promise<InputSnapshot | null> {
    assertSafeId(runId, /^run_[a-f0-9]{32}$/);
    return readJson(path.join(this.directory, "snapshots", `${runId}.json`));
  }

  async saveArtifactRevision(revision: ArtifactRevision): Promise<void> {
    assertSafeId(revision.artifact_id, /^art_[a-f0-9]{32}$/);
    if (!Number.isInteger(revision.revision) || revision.revision < 1) {
      throw Object.assign(new Error(MESSAGES.storage_error), { code: "storage_error" });
    }
    const file = path.join(this.directory, "artifacts", revision.artifact_id, `${revision.revision}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(revision, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  }

  async readArtifactRevision(artifactId: string, revision: number): Promise<ArtifactRevision | null> {
    assertSafeId(artifactId, /^art_[a-f0-9]{32}$/);
    return readJson(path.join(this.directory, "artifacts", artifactId, `${revision}.json`));
  }

  async listArtifactRevisions(artifactId: string): Promise<ArtifactRevision[]> {
    assertSafeId(artifactId, /^art_[a-f0-9]{32}$/);
    const dir = path.join(this.directory, "artifacts", artifactId);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const revisions: ArtifactRevision[] = [];
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const revision = await readJson<ArtifactRevision>(path.join(dir, name));
      if (revision) revisions.push(revision);
    }
    revisions.sort((left, right) => left.revision - right.revision);
    return revisions;
  }

  async getIdempotency(scopeHash: string): Promise<IdempotencyRecord | null> {
    assertSafeId(scopeHash, /^[a-f0-9]{64}$/);
    return readJson(path.join(this.directory, "idempotency", `${scopeHash}.json`));
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    assertSafeId(record.scope_hash, /^[a-f0-9]{64}$/);
    const file = path.join(this.directory, "idempotency", `${record.scope_hash}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  }

  async requestCancel(runId: string): Promise<void> {
    const run = await this.readRun(runId);
    if (!run || isTerminal(run.status)) return;
    run.cancel_requested = true;
    run.updated_at = new Date().toISOString();
    await atomicWrite(this.runPath(runId), JSON.stringify(run, null, 2) + "\n");
  }

  async withIdempotencyLock<T>(scopeHash: string, fn: () => Promise<T>): Promise<T> {
    assertSafeId(scopeHash, /^[a-f0-9]{64}$/);
    const lockDir = path.join(this.directory, "locks", scopeHash);
    const started = Date.now();
    for (;;) {
      let owned = false;
      try {
        await mkdir(path.dirname(lockDir), { recursive: true });
        await mkdir(lockDir);
        owned = true;
        await writeFile(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
          "utf8",
        );
        return await fn();
      } catch (error) {
        if (owned) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (await lockIsStale(lockDir)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > 20_000) {
          throw Object.assign(new Error(MESSAGES.lock_timeout), { code: "lock_timeout" });
        }
        await sleep(25);
      } finally {
        if (owned) await rm(lockDir, { recursive: true, force: true });
      }
    }
  }

  private runPath(runId: string): string {
    return path.join(this.directory, "runs", `${runId}.json`);
  }
}

export async function releaseDeadLocks(directory: string): Promise<void> {
  const locks = path.join(directory, "locks");
  let names: string[] = [];
  try {
    names = await readdir(locks);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const lockDir = path.join(locks, name);
    if (await lockIsStale(lockDir)) await rm(lockDir, { recursive: true, force: true });
  }
}

async function lockIsStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(lockDir, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown };
    if (typeof owner.pid === "number" && pidAlive(owner.pid)) return false;
    return true;
  } catch {
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs > 2_000;
    } catch {
      return true;
    }
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeId(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw Object.assign(new Error(MESSAGES.storage_error), { code: "storage_error" });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
