import assert from 'node:assert/strict';
import type { PrepareDraftInput } from '../src/contract/types.js';
import { LocalSessions } from '../src/server/local-sessions.js';
import { LocalTaskApi } from '../src/server/local-task-api.js';
import { PostgresStore, type SqlPool } from '../src/storage/postgres-store.js';
import { reviseDraft } from '../src/scenario/revise.js';

/** Run against the same real LOGIN pools as the storage suite (or serialized PGlite). */
export async function verifyLocalApi(
  userPool: (user: 'alice' | 'bob' | 'viewer' | 'editor' | 'postgres') => SqlPool,
  fixture: PrepareDraftInput,
): Promise<void> {
  const pools = new Map<string, SqlPool>(['alice', 'bob', 'viewer', 'editor', 'postgres'].map(user => [
    user, userPool(user as 'alice' | 'bob' | 'viewer' | 'editor' | 'postgres'),
  ]));
  const sessions = new LocalSessions();
  const api = new LocalTaskApi(sessions, user => {
    const pool = pools.get(user);
    if (!pool) throw new Error('postgres://secret-must-not-leak');
    return pool;
  }, process.cwd());
  const alice = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' });
  const bob = sessions.issue({ userId: 'bob', workspaceId: 'ws_other' });
  const viewer = sessions.issue({ userId: 'viewer', workspaceId: 'ws_educational' });
  const editor = sessions.issue({ userId: 'editor', workspaceId: 'ws_educational' });
  const create = { operation: 'create_task', task_id: 'api_task', project_id: 'prj_educational' };
  assert.equal((await api.dispatch(null, create)).status, 401);
  assert.equal((await api.dispatch('fabricated', create)).status, 401);
  assert.equal((await api.dispatch(alice, { ...create, user_id: 'bob' })).status, 400);
  assert.equal((await api.dispatch(alice, { ...create, role: 'owner' })).status, 400);
  assert.equal((await api.dispatch(alice, { ...create, workspace_id: 'ws_other' })).status, 400);
  assert.equal((await api.dispatch(viewer, create)).status, 403);
  assert.equal((await api.dispatch(alice, create)).status, 201);
  const duplicate = await api.dispatch(alice, create);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.replay, true);
  assert.equal((await api.dispatch(alice, { ...create, project_id: 'prj_api' })).status, 409);
  assert.equal((await api.dispatch(alice, { ...create, task_id: 'api_foreign', project_id: 'prj_other' })).status, 404);
  assert.equal((await api.dispatch(editor, { ...create, task_id: 'api_editor' })).status, 201);

  const { workspace_id: _workspace, ...input } = fixture;
  const prepare = { operation: 'prepare_draft', task_id: 'api_task', input: { ...input, idempotency_key: 'api-fixture-01' } };
  assert.equal((await api.dispatch(alice, { ...prepare, input: fixture })).status, 400);
  assert.equal((await api.dispatch(alice, { ...prepare, input: { ...prepare.input, user_id: 'bob' } })).status, 400);
  assert.equal((await api.dispatch(alice, { ...prepare, task_id: 'missing' })).status, 404);
  assert.equal((await api.dispatch(alice, { ...prepare, input: { ...prepare.input, project_id: 'prj_api' } })).status, 409);
  assert.equal((await api.dispatch(viewer, prepare)).status, 403);
  const first = await api.dispatch(alice, prepare);
  assert.equal(first.status, 201, JSON.stringify(first));
  assert.equal(first.body.status, 'succeeded');
  const runId = first.body.run_id;
  assert.equal(typeof runId, 'string');
  const replay = await api.dispatch(alice, prepare);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.run_id, runId);
  assert.equal(replay.body.replay, true);
  assert.equal((await api.dispatch(alice, { ...prepare, input: { ...prepare.input, topic: 'Другая тема' } })).status, 409);
  await api.dispatch(alice, { ...create, task_id: 'api_task2' });
  assert.equal((await api.dispatch(alice, { ...prepare, task_id: 'api_task2' })).status, 409);

  const read = { operation: 'read_result', run_id: runId };
  assert.equal((await api.dispatch(alice, read)).status, 200);
  assert.equal((await api.dispatch(bob, read)).status, 404);
  assert.equal((await api.dispatch(viewer, read)).status, 200);
  assert.equal((await api.dispatch(alice, { ...read, task_id: 'api_task2' })).status, 400);
  const revise = { operation: 'revise_draft', run_id: runId, text: 'Новая версия: нужна повторная проверка.' };
  assert.equal((await api.dispatch(bob, revise)).status, 404);
  assert.equal((await api.dispatch(viewer, revise)).status, 403);
  const changed = await api.dispatch(editor, revise);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.quality_gate, 'blocked');
  assert.equal(changed.body.unchanged, false);
  const unchanged = await api.dispatch(alice, revise);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.unchanged, true);
  const checker = new PostgresStore(pools.get('alice')!, { userId: 'alice', workspaceId: 'ws_educational', taskId: 'api_task' });
  const run = await checker.readRun(String(runId));
  assert.ok(run?.artifact_id);
  const revisions = await checker.listArtifactRevisions(run.artifact_id);
  assert.deepEqual(revisions.map(value => value.revision), [1, 2]);
  assert.notEqual(revisions[0]?.text, revisions[1]?.text);
  assert.equal((await api.dispatch(alice, read)).body.quality_gate, 'blocked');
  // Force another writer between the API's initial read and the revision lock.
  // The unchanged response must use the run captured inside that lock, not a stale open gate.
  const race = await api.dispatch(alice, { ...prepare, input: { ...prepare.input, idempotency_key: 'api-race-key-01' } });
  assert.equal(race.body.quality_gate, 'open');
  const raceId = String(race.body.run_id);
  const raceText = 'Параллельная новая версия без подтверждённых утверждений.';
  const base = pools.get('alice')!;
  let pending: Promise<unknown> = Promise.resolve();
  let triggered = false;
  const racingPool: SqlPool = {
    async connect() {
      await pending;
      const client = await base.connect();
      let observed = false;
      return {
        async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
          if (sql.includes('SELECT payload FROM bos.run') && values?.[1] === raceId) observed = true;
          return client.query<T>(sql, values);
        },
        release() {
          client.release();
          if (observed && !triggered) {
            triggered = true;
            pending = reviseDraft(checker, raceId, raceText);
          }
        },
      };
    },
  };
  const racingApi = new LocalTaskApi(sessions, () => racingPool, process.cwd());
  const raceResponse = await racingApi.dispatch(alice, { operation: 'revise_draft', run_id: raceId, text: raceText });
  assert.equal(triggered, true);
  assert.equal(raceResponse.status, 200);
  assert.equal(raceResponse.body.unchanged, true);
  assert.equal(raceResponse.body.quality_gate, 'blocked');
  assert.equal((raceResponse.body.artifact as { revision: number }).revision, 2);
  for (const response of [first, replay, changed, unchanged, await api.dispatch(alice, read)]) {
    const json = JSON.stringify(response);
    for (const secret of ['provided_text', 'snapshot_ref', 'postgres://', 'bos_disposable_test_only']) {
      assert.equal(json.includes(secret), false, secret);
    }
  }
  const foreignWorkspace = sessions.issue({ userId: 'alice', workspaceId: 'ws_other' });
  assert.equal((await api.dispatch(foreignWorkspace, read)).status, 403);
  const badMapping = new LocalTaskApi(sessions, () => pools.get('alice')!, process.cwd());
  assert.equal((await badMapping.dispatch(bob, read)).status, 403);
  const admin = sessions.issue({ userId: 'postgres', workspaceId: 'ws_educational' });
  assert.equal((await api.dispatch(admin, read)).status, 403);
  const unmapped = sessions.issue({ userId: 'unknown', workspaceId: 'ws_educational' });
  assert.deepEqual(await api.dispatch(unmapped, read), { status: 500, body: { code: 'internal_error' } });
  assert.equal((await api.dispatch(alice, { operation: 'publish' })).status, 400);
  assert.equal((await api.dispatch(alice, { ...revise, text: '' })).status, 400);
  assert.equal((await api.dispatch(alice, { ...revise, text: 'a'.repeat(270000) })).status, 413);
  sessions.revoke(alice);
  assert.equal((await api.dispatch(alice, read)).status, 401);
}
