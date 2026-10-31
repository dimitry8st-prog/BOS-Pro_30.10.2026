import pg from "pg";
import { EducationalAuthAdapter } from "../auth/educational-auth.js";
import { EDUCATIONAL_ACCESS_NOTE, EDUCATIONAL_WORKFLOW_VERSION_ID, MESSAGES, RULES_VERSION, SCENARIO_VERSION } from "../contract/constants.js";
import { newId } from "../contract/hash.js";
import {
  isTerminal,
  type ArtifactRevision,
  type IdempotencyRecord,
  type InputSnapshot,
  type RunRecord,
  type RunStatus,
} from "../contract/types.js";
import { isLocalActor, LOCAL_DATABASE, LOCAL_HOST, LOCAL_PORT, localPassword } from "../db/local-test.js";
import type { RunStore } from "./store.js";

type RunRow = { record: RunRecord; status: string; cancel_requested: boolean; scope_hash?: string };
type JsonRow<T> = { record: T };

export class PostgresStore implements RunStore {
  readonly kind = "postgres" as const;
  readonly durableProduction = false as const;
  readonly accessCheck = "educational_membership_checked" as const;
  readonly accessCheckNote = EDUCATIONAL_ACCESS_NOTE;
  failNextCommit = false;

  private readonly pendingArtifacts = new Map<string, ArtifactRevision>();
  private readonly pendingSnapshots = new Map<string, InputSnapshot>();

  private constructor(
    private readonly pool: pg.Pool,
    readonly actor: EducationalAuthAdapter,
  ) {}

  static async open(userId: string): Promise<PostgresStore> {
    if (!isLocalActor(userId)) {
      throw Object.assign(new Error("Учебный адаптер знает только usr_educational и usr_other."), { code: "usage" });
    }
    const actor = new EducationalAuthAdapter(userId);
    const pool = new pg.Pool({
      host: LOCAL_HOST,
      port: LOCAL_PORT,
      database: LOCAL_DATABASE,
      user: actor.userId,
      password: localPassword(userId),
      max: 12,
      connectionTimeoutMillis: 5_000,
    });
    const store = new PostgresStore(pool, actor);
    try {
      await store.assertRestrictedRole();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createRun(run: RunRecord, snapshot: InputSnapshot, idempotency: IdempotencyRecord): Promise<void> {
    if (run.workflow_version_id !== EDUCATIONAL_WORKFLOW_VERSION_ID) {
      throw coded("storage_error", MESSAGES.storage_error);
    }
    await this.transaction(async (client) => {
      const member = await client.query<{ member: boolean }>("SELECT bos_is_member($1) AS member", [run.workspace_id]);
      if (member.rows[0]?.member !== true) throw coded("membership_denied", MESSAGES.membership_denied);
      const project = await client.query("SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2", [
        run.project_id,
        run.workspace_id,
      ]);
      if ((project.rowCount ?? 0) === 0) throw coded("project_not_in_workspace", MESSAGES.project_not_in_workspace);
      await client.query(
        `INSERT INTO workflow_version (id, workspace_id, scenario_version, rules_version, definition, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id, workspace_id) DO NOTHING`,
        [
          run.workflow_version_id,
          run.workspace_id,
          SCENARIO_VERSION,
          RULES_VERSION,
          JSON.stringify({ scenario_version: SCENARIO_VERSION, rules_version: RULES_VERSION, immutable: true }),
          run.created_at,
        ],
      );
      await client.query(
        `INSERT INTO task (id, workspace_id, project_id, title, created_by, created_at)
         VALUES ($1, $2, $3, $4, current_user, $5)`,
        [run.task_id, run.workspace_id, run.project_id, snapshot.input.topic, run.created_at],
      );
      await client.query(
        `INSERT INTO run (
           id, workspace_id, project_id, task_id, workflow_version_id, status, operation,
           idempotency_key, input_hash, scope_hash, record, snapshot, cancel_requested,
           publication_status, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'prepare_draft',
           $7, $8, $9, $10::jsonb, $11::jsonb, $12,
           'not_published', $13, $14
         )`,
        [
          run.run_id,
          run.workspace_id,
          run.project_id,
          run.task_id,
          run.workflow_version_id,
          run.status,
          idempotency.idempotency_key,
          idempotency.input_hash,
          idempotency.scope_hash,
          JSON.stringify(run),
          JSON.stringify(snapshot),
          run.cancel_requested,
          run.created_at,
          run.updated_at,
        ],
      );
      await insertSteps(client, run);
      await insertAudit(client, run, "run_created", null);
    });
    this.pendingSnapshots.set(run.run_id, snapshot);
  }

  async saveRun(run: RunRecord): Promise<void> {
    const current = await this.readRun(run.run_id);
    if (current?.cancel_requested) run.cancel_requested = true;
    if (current && isTerminal(current.status) && run.status !== current.status) {
      throw coded("illegal_transition", MESSAGES.illegal_transition);
    }
    const staged = [...this.pendingArtifacts.values()].filter((revision) => revision.run_id === run.run_id);
    const flushed = run.status === "succeeded" ? staged : [];
    await this.transaction(async (client) => {
      for (const revision of flushed) {
        await client.query(
          `INSERT INTO artifact (id, revision, run_id, workspace_id, content_hash, body, record, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            revision.artifact_id,
            revision.revision,
            revision.run_id,
            run.workspace_id,
            revision.content_hash,
            revision.text,
            JSON.stringify(revision),
            revision.created_at,
          ],
        );
        await client.query(
          `INSERT INTO verification (id, workspace_id, artifact_id, artifact_revision, status, record, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            newId("ver"),
            run.workspace_id,
            revision.artifact_id,
            revision.revision,
            revision.verification.status,
            JSON.stringify(revision.verification),
            revision.created_at,
          ],
        );
      }
      const updated = await client.query(
        `UPDATE run
         SET status = $2,
             record = jsonb_set($3::jsonb, '{cancel_requested}', to_jsonb(cancel_requested OR $4::boolean)),
             cancel_requested = cancel_requested OR $4::boolean,
             publication_status = 'not_published',
             updated_at = $5
         WHERE id = $1`,
        [run.run_id, run.status, JSON.stringify(run), run.cancel_requested, run.updated_at],
      );
      if ((updated.rowCount ?? 0) === 0) throw coded("storage_error", MESSAGES.storage_error);
      await insertSteps(client, run);
      await insertAudit(client, run, "run_saved", run.stop?.code ?? null);
    });
    for (const revision of flushed) this.pendingArtifacts.delete(artifactKey(revision));
  }

  async readRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>("SELECT record, status, cancel_requested FROM run WHERE id = $1", [runId]);
    const row = result.rows[0];
    return row ? hydrate(row) : null;
  }

  async listRuns(): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      "SELECT record, status, cancel_requested FROM run ORDER BY created_at, id",
    );
    return result.rows.map((row) => hydrate(row));
  }

  async saveSnapshot(snapshot: InputSnapshot): Promise<void> {
    this.pendingSnapshots.set(snapshot.run_id, snapshot);
  }

  async readSnapshot(runId: string): Promise<InputSnapshot | null> {
    const pending = this.pendingSnapshots.get(runId);
    if (pending) return pending;
    const result = await this.pool.query<{ snapshot: InputSnapshot }>("SELECT snapshot FROM run WHERE id = $1", [runId]);
    return result.rows[0]?.snapshot ?? null;
  }

  async saveArtifactRevision(revision: ArtifactRevision): Promise<void> {
    const key = artifactKey(revision);
    if (this.pendingArtifacts.has(key)) throw coded("storage_error", MESSAGES.storage_error);
    const existing = await this.pool.query("SELECT 1 FROM artifact WHERE id = $1 AND revision = $2", [
      revision.artifact_id,
      revision.revision,
    ]);
    if ((existing.rowCount ?? 0) > 0) throw coded("storage_error", MESSAGES.storage_error);
    this.pendingArtifacts.set(key, revision);
  }

  async readArtifactRevision(artifactId: string, revision: number): Promise<ArtifactRevision | null> {
    const pending = this.pendingArtifacts.get(`${artifactId}:${revision}`);
    if (pending) return pending;
    const result = await this.pool.query<JsonRow<ArtifactRevision>>(
      "SELECT record FROM artifact WHERE id = $1 AND revision = $2",
      [artifactId, revision],
    );
    return result.rows[0]?.record ?? null;
  }

  async listArtifactRevisions(artifactId: string): Promise<ArtifactRevision[]> {
    const result = await this.pool.query<JsonRow<ArtifactRevision>>(
      "SELECT record FROM artifact WHERE id = $1 ORDER BY revision",
      [artifactId],
    );
    const revisions = result.rows.map((row) => row.record);
    for (const revision of this.pendingArtifacts.values()) {
      if (revision.artifact_id === artifactId && !revisions.some((item) => item.revision === revision.revision)) {
        revisions.push(revision);
      }
    }
    revisions.sort((left, right) => left.revision - right.revision);
    return revisions;
  }

  async getIdempotency(scopeHash: string): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query<RunRow & { scope_hash: string }>(
      "SELECT record, status, cancel_requested, scope_hash FROM run WHERE scope_hash = $1",
      [scopeHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    const run = hydrate(row);
    return {
      scope_hash: row.scope_hash,
      workspace_id: run.workspace_id,
      operation: "prepare_draft",
      idempotency_key: run.idempotency_key,
      input_hash: run.input_hash,
      run_id: run.run_id,
      created_at: run.created_at,
    };
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    const existing = await this.getIdempotency(record.scope_hash);
    if (!existing || existing.run_id !== record.run_id || existing.input_hash !== record.input_hash) {
      throw coded("storage_error", MESSAGES.storage_error);
    }
  }

  async requestCancel(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `UPDATE run
         SET cancel_requested = true,
             record = jsonb_set(record, '{cancel_requested}', 'true'::jsonb),
             updated_at = now()
         WHERE id = $1
           AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
        [runId],
      );
    });
  }

  async withIdempotencyLock<T>(scopeHash: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [advisoryKey(scopeHash)]);
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryKey(scopeHash)]).catch(() => undefined);
      client.release();
    }
  }

  private async assertRestrictedRole(): Promise<void> {
    const result = await this.pool.query<{ user_id: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user AS user_id, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`,
    );
    const row = result.rows[0];
    if (!row || row.user_id !== this.actor.userId || row.rolsuper || row.rolbypassrls) {
      throw coded("usage", "Учебное хранилище подключается только ролью без superuser и без BYPASSRLS.");
    }
  }

  private async transaction(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw coded("storage_error", MESSAGES.storage_error);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapPg(error);
    } finally {
      client.release();
    }
  }
}

function hydrate(row: RunRow): RunRecord {
  const run = row.record;
  run.status = row.status as RunStatus;
  run.cancel_requested = row.cancel_requested;
  return run;
}

function artifactKey(revision: ArtifactRevision): string {
  return `${revision.artifact_id}:${revision.revision}`;
}

function advisoryKey(scopeHash: string): string {
  const value = BigInt(`0x${scopeHash.slice(0, 16)}`);
  const limit = 1n << 63n;
  const signed = value >= limit ? value - (limit << 1n) : value;
  return signed.toString();
}

async function insertSteps(client: pg.PoolClient, run: RunRecord): Promise<void> {
  for (let index = 0; index < run.journal.length; index += 1) {
    const entry = run.journal[index];
    if (!entry) continue;
    await client.query(
      `INSERT INTO run_step (id, run_id, workspace_id, step_index, step, outcome, error_code, at, artifact_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (run_id, step_index) DO NOTHING`,
      [
        newId("stp"),
        run.run_id,
        run.workspace_id,
        index,
        entry.step,
        entry.outcome,
        entry.error_code,
        entry.at,
        JSON.stringify(entry.artifact_refs),
      ],
    );
  }
}

async function insertAudit(client: pg.PoolClient, run: RunRecord, action: string, errorCode: string | null): Promise<void> {
  await client.query(
    `INSERT INTO audit_event (id, workspace_id, actor_user_id, action, entity, entity_id, error_code, at, record)
     VALUES ($1, $2, current_user, $3, 'run', $4, $5, now(), $6::jsonb)`,
    [newId("aud"), run.workspace_id, action, run.run_id, errorCode, JSON.stringify({ status: run.status, task_id: run.task_id })],
  );
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function mapPg(error: unknown): Error {
  if (!(error instanceof Error)) return coded("storage_error", MESSAGES.storage_error);
  const code = (error as { code?: string }).code;
  if (
    code === "membership_denied" ||
    code === "project_not_in_workspace" ||
    code === "storage_error" ||
    code === "idempotency_conflict" ||
    code === "illegal_transition" ||
    code === "usage"
  ) {
    return error;
  }
  if (code === "42501") return coded("membership_denied", MESSAGES.membership_denied);
  if (code === "23503") return coded("project_not_in_workspace", MESSAGES.project_not_in_workspace);
  if (code === "P0001" && error.message.includes("illegal_transition")) return coded("illegal_transition", MESSAGES.illegal_transition);
  return coded("storage_error", MESSAGES.storage_error);
}
