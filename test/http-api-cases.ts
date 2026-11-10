import assert from 'node:assert/strict';
import type { PrepareDraftInput } from '../src/contract/types.js';
import { LocalHttpServer } from '../src/server/local-http.js';
import { LocalSessions } from '../src/server/local-sessions.js';
import { LocalTaskApi } from '../src/server/local-task-api.js';
import { PostgresStore, type SqlPool } from '../src/storage/postgres-store.js';
import { reviseDraft } from '../src/scenario/revise.js';

async function dispatch(
  base: string,
  token: string | null,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/api/v1/dispatch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { code: 'invalid_json_response' };
  }
  return { status: response.status, body: parsed, text };
}

/** End-to-end LocalTaskApi through the loopback HTTP transport. */
export async function verifyHttpApi(
  userPool: (user: 'alice' | 'bob' | 'viewer' | 'editor' | 'postgres') => SqlPool,
  fixture: PrepareDraftInput,
): Promise<void> {
  const pools = new Map<string, SqlPool>(['alice', 'bob', 'viewer', 'editor', 'postgres'].map((user) => [
    user,
    userPool(user as 'alice' | 'bob' | 'viewer' | 'editor' | 'postgres'),
  ]));
  let now = 1_000;
  const sessions = new LocalSessions({ now: () => now });
  const api = new LocalTaskApi(sessions, (user) => {
    const pool = pools.get(user);
    if (!pool) throw new Error('postgres://secret-must-not-leak');
    return pool;
  }, process.cwd());
  const server = new LocalHttpServer({ api });
  const listen = await server.listen();
  const base = `http://127.0.0.1:${listen.port}`;
  try {
    const alice = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' });
    const bob = sessions.issue({ userId: 'bob', workspaceId: 'ws_other' });
    const viewer = sessions.issue({ userId: 'viewer', workspaceId: 'ws_educational' });
    const editor = sessions.issue({ userId: 'editor', workspaceId: 'ws_educational' });
    const create = { operation: 'create_task', task_id: 'http_task', project_id: 'prj_educational' };

    assert.equal((await dispatch(base, null, create)).status, 401);
    assert.equal((await dispatch(base, 'fabricated-token-value-xxxxxxxxxxxxxxxxx', create)).status, 401);
    assert.equal((await dispatch(base, alice, { ...create, user_id: 'bob' })).status, 400);
    assert.equal((await dispatch(base, viewer, create)).status, 403);
    assert.equal((await dispatch(base, alice, create)).status, 201);
    const duplicate = await dispatch(base, alice, create);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.replay, true);

    const { workspace_id: _workspace, ...input } = fixture;
    const prepare = {
      operation: 'prepare_draft',
      task_id: 'http_task',
      input: { ...input, idempotency_key: 'http-fixture-01' },
    };
    assert.equal((await dispatch(base, viewer, prepare)).status, 403);
    const first = await dispatch(base, alice, prepare);
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.status, 'succeeded');
    const runId = String(first.body.run_id);
    const replay = await dispatch(base, alice, prepare);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.run_id, runId);
    assert.equal(replay.body.replay, true);
    assert.equal((await dispatch(base, alice, {
      ...prepare,
      input: { ...prepare.input, topic: 'Другая тема' },
    })).status, 409);

    const read = { operation: 'read_result', run_id: runId };
    assert.equal((await dispatch(base, alice, read)).status, 200);
    assert.equal((await dispatch(base, bob, read)).status, 404);
    assert.equal((await dispatch(base, viewer, read)).status, 200);

    const revise = {
      operation: 'revise_draft',
      run_id: runId,
      text: 'HTTP-правка: нужна повторная проверка.',
    };
    assert.equal((await dispatch(base, bob, revise)).status, 404);
    assert.equal((await dispatch(base, viewer, revise)).status, 403);
    const changed = await dispatch(base, editor, revise);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.quality_gate, 'blocked');
    assert.equal(changed.body.unchanged, false);
    const artifact = changed.body.artifact as { revision: number };
    assert.equal(artifact.revision, 2);
    const unchanged = await dispatch(base, alice, revise);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.unchanged, true);
    assert.equal(unchanged.body.quality_gate, 'blocked');

    const checker = new PostgresStore(pools.get('alice')!, {
      userId: 'alice',
      workspaceId: 'ws_educational',
      taskId: 'http_task',
    });
    const run = await checker.readRun(runId);
    assert.ok(run?.artifact_id);
    const revisions = await checker.listArtifactRevisions(run.artifact_id);
    assert.deepEqual(revisions.map((value) => value.revision), [1, 2]);
    assert.notEqual(revisions[0]?.text, revisions[1]?.text);

    // Parallel writer between initial read and revision lock must not return a stale open gate.
    const racePrepare = await dispatch(base, alice, {
      ...prepare,
      input: { ...prepare.input, idempotency_key: 'http-race-key-01' },
    });
    assert.equal(racePrepare.body.quality_gate, 'open');
    const raceId = String(racePrepare.body.run_id);
    const raceText = 'Параллельная HTTP-правка без подтверждённых утверждений.';
    const basePool = pools.get('alice')!;
    let pending: Promise<unknown> = Promise.resolve();
    let triggered = false;
    const racingPool: SqlPool = {
      async connect() {
        await pending;
        const client = await basePool.connect();
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
    const racingServer = new LocalHttpServer({ api: racingApi });
    const racingListen = await racingServer.listen();
    try {
      const raceResponse = await dispatch(`http://127.0.0.1:${racingListen.port}`, alice, {
        operation: 'revise_draft',
        run_id: raceId,
        text: raceText,
      });
      assert.equal(triggered, true);
      assert.equal(raceResponse.status, 200);
      assert.equal(raceResponse.body.unchanged, true);
      assert.equal(raceResponse.body.quality_gate, 'blocked');
      assert.equal((raceResponse.body.artifact as { revision: number }).revision, 2);
    } finally {
      await racingServer.close();
    }

    for (const response of [first, replay, changed, unchanged, await dispatch(base, alice, read)]) {
      for (const secret of ['provided_text', 'snapshot_ref', 'postgres://', 'bos_disposable_test_only', alice]) {
        assert.equal(response.text.includes(String(secret)), false, String(secret));
      }
    }

    const foreignWorkspace = sessions.issue({ userId: 'alice', workspaceId: 'ws_other' });
    assert.equal((await dispatch(base, foreignWorkspace, read)).status, 403);
    now = 1_000 + 15 * 60 * 1_000;
    assert.equal((await dispatch(base, editor, read)).status, 401);
    const fresh = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' });
    sessions.revoke(fresh);
    assert.equal((await dispatch(base, fresh, read)).status, 401);

    assert.equal((await dispatch(base, alice, revise, { origin: 'http://localhost:3000' })).status, 403);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await server.close();
  }
}
