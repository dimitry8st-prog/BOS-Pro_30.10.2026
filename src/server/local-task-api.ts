import type { ArtifactRevision, RunRecord } from '../contract/types.js';
import { validatePrepareDraftInput } from '../contract/validate.js';
import { executePrepareDraft } from '../scenario/execute.js';
import { reviseDraft } from '../scenario/revise.js';
import { PostgresStore, type SqlPool } from '../storage/postgres-store.js';
import type { LocalSessions, SessionIdentity } from './local-sessions.js';

export type LocalApiResponse = { status: number; body: Record<string, unknown> };
type JsonObject = Record<string, unknown>;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request');
  return value as JsonObject;
}

function fields(value: JsonObject, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'unknown_field');
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ApiError(400, 'invalid_identifier');
  return value;
}

/** Explicit response projection: snapshots, credentials and source bodies never leave this boundary. */
function view(run: RunRecord, artifact: ArtifactRevision | null): Record<string, unknown> {
  return {
    run_id: run.run_id, status: run.status, quality_gate: run.quality_gate,
    cancel_requested: run.cancel_requested, publication: run.publication,
    stop: run.stop, costs: run.costs,
    artifact: artifact ? {
      artifact_id: artifact.artifact_id, revision: artifact.revision, text: artifact.text,
      content_hash: artifact.content_hash, verification: artifact.verification,
    } : null,
  };
}

/**
 * In-process server boundary, not an HTTP server or a public authentication method.
 * Only trusted server bootstrap may issue sessions or configure per-user pools.
 * No model tools, publication, arbitrary SQL, migrations or administrator connection.
 */
export class LocalTaskApi {
  constructor(
    private readonly sessions: LocalSessions,
    private readonly poolForUser: (userId: string) => SqlPool,
    private readonly root: string,
  ) {}

  async dispatch(token: unknown, raw: unknown): Promise<LocalApiResponse> {
    const identity = this.sessions.resolve(token);
    if (!identity) return { status: 401, body: { code: 'session_required' } };
    try {
      const request = object(raw);
      let encoded: string;
      try { encoded = JSON.stringify(request); } catch { throw new ApiError(400, 'invalid_request'); }
      if (Buffer.byteLength(encoded) > 262144) throw new ApiError(413, 'request_too_large');
      switch (request.operation) {
        case 'create_task': {
          fields(request, ['operation', 'task_id', 'project_id']);
          const taskId = id(request.task_id);
          const projectId = id(request.project_id);
          const store = this.store(identity, taskId);
          const result = await store.createTask(projectId);
          return { status: result.replay ? 200 : 201, body: { task_id: taskId, project_id: projectId, replay: result.replay } };
        }
        case 'prepare_draft': {
          fields(request, ['operation', 'task_id', 'input']);
          const taskId = id(request.task_id);
          const input = object(request.input);
          // workspace is chosen by a trusted session; it is never an assertion from JSON.
          if ('workspace_id' in input) throw new ApiError(400, 'unknown_field');
          const parsed = validatePrepareDraftInput({ ...input, workspace_id: identity.workspaceId });
          if (!parsed.ok) return { status: 400, body: { ...parsed.error } };
          const store = this.store(identity, taskId);
          await store.assertAccess(true);
          const project = await store.taskProject();
          if (project === null) throw new ApiError(404, 'resource_not_found');
          if (project !== parsed.value.project_id) throw new ApiError(409, 'task_project_mismatch');
          const result = await executePrepareDraft(parsed.value, { store, root: this.root });
          if (result.outcome === 'rejected') return { status: 400, body: { ...result.error } };
          if (result.outcome === 'conflict') return { status: 409, body: { code: 'idempotency_conflict' } };
          if (result.outcome === 'diagnostics_only') return { status: 500, body: { code: result.error.code } };
          if (result.outcome !== 'finished') return { status: 409, body: { code: 'run_interrupted' } };
          // A workspace-scoped key must not silently replay a different task's run.
          if (await store.taskForRun(result.run.run_id) !== taskId) throw new ApiError(409, 'idempotency_conflict');
          const artifact = await this.artifact(store, result.run);
          return { status: result.replay ? 200 : 201, body: { ...view(result.run, artifact), replay: result.replay } };
        }
        case 'read_result': {
          fields(request, ['operation', 'run_id']);
          const { store, run } = await this.findRun(identity, id(request.run_id), false);
          return { status: 200, body: view(run, await this.artifact(store, run)) };
        }
        case 'revise_draft': {
          fields(request, ['operation', 'run_id', 'text']);
          if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 50000) {
            throw new ApiError(400, 'invalid_text');
          }
          const { store, run } = await this.findRun(identity, id(request.run_id), true);
          const result = await reviseDraft(store, run.run_id, request.text);
          if (result.outcome === 'rejected') return { status: 409, body: { ...result.error } };
          return { status: 200, body: { ...view(result.run, result.revision), unchanged: result.outcome === 'unchanged' } };
        }
        default: throw new ApiError(400, 'unknown_operation');
      }
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { code: error.code } };
      const message = error instanceof Error ? error.message : '';
      if (message === 'workspace_access_denied' || message === 'runtime_role_rejected') {
        return { status: 403, body: { code: 'access_denied' } };
      }
      if (message === 'resource_not_found') return { status: 404, body: { code: message } };
      if (message === 'task_conflict') return { status: 409, body: { code: message } };
      // SQL errors and connection strings are not an API response or a log record.
      return { status: 500, body: { code: 'internal_error' } };
    }
  }

  private store(identity: SessionIdentity, taskId: string): PostgresStore {
    return new PostgresStore(this.poolForUser(identity.userId), { ...identity, taskId });
  }

  private async findRun(identity: SessionIdentity, runId: string, writing: boolean): Promise<{ store: PostgresStore; run: RunRecord }> {
    const lookup = this.store(identity, '_lookup');
    await lookup.assertAccess(writing);
    const taskId = await lookup.taskForRun(runId);
    if (taskId === null) throw new ApiError(404, 'resource_not_found');
    const store = this.store(identity, taskId);
    const run = await store.readRun(runId);
    if (!run) throw new ApiError(404, 'resource_not_found');
    return { store, run };
  }

  private async artifact(store: PostgresStore, run: RunRecord): Promise<ArtifactRevision | null> {
    return run.artifact_id && run.current_revision !== null
      ? store.readArtifactRevision(run.artifact_id, run.current_revision) : null;
  }
}
