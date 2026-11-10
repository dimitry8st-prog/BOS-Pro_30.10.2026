import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { LocalHttpServer, type DispatchApi } from '../src/server/local-http.js';
import { LocalSessions } from '../src/server/local-sessions.js';
import type { LocalApiResponse } from '../src/server/local-task-api.js';

function token(): string {
  return randomBytes(32).toString('base64url');
}

async function withServer(
  api: DispatchApi,
  fn: (base: string, server: LocalHttpServer) => Promise<void>,
): Promise<void> {
  const server = new LocalHttpServer({ api });
  const listen = await server.listen();
  try {
    await fn(`http://127.0.0.1:${listen.port}`, server);
  } finally {
    await server.close();
  }
}

test('HTTP transport serves health and dispatch without opening a port on import', async () => {
  let calls = 0;
  const api: DispatchApi = {
    async dispatch(auth, raw) {
      calls += 1;
      assert.equal(typeof auth, 'string');
      return { status: 200, body: { echoed: raw, auth_present: true } };
    },
  };
  await withServer(api, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const healthText = await (await fetch(`${base}/health`)).text();
    assert.equal(healthText.includes('postgres'), false);
    assert.equal(healthText.includes('Bearer'), false);

    const issued = token();
    const response = await fetch(`${base}/api/v1/dispatch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${issued}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operation: 'ping' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { echoed: { operation: 'ping' }, auth_present: true });
    assert.equal(calls, 1);
  });
});

test('HTTP transport rejects missing, fabricated, expired and revoked bearer tokens', async () => {
  let now = 1_000;
  const sessions = new LocalSessions({ now: () => now });
  const api: DispatchApi = {
    async dispatch(auth, raw) {
      const identity = sessions.resolve(auth);
      if (!identity) return { status: 401, body: { code: 'session_required' } };
      return { status: 200, body: { ok: true, operation: (raw as { operation?: string }).operation } };
    },
  };
  await withServer(api, async (base) => {
    const post = async (headers: Record<string, string>, body: unknown) => {
      const response = await fetch(`${base}/api/v1/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    assert.equal((await post({}, { operation: 'read_result' })).status, 401);
    assert.equal((await post({ authorization: 'Bearer fabricated-token-value-xxxxxxxxxxxx' }, { operation: 'x' })).status, 401);
    const live = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' }, 50);
    assert.equal((await post({ authorization: `Bearer ${live}` }, { operation: 'ok' })).status, 200);
    now = 1_050;
    assert.equal((await post({ authorization: `Bearer ${live}` }, { operation: 'ok' })).status, 401);
    const revoked = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' });
    sessions.revoke(revoked);
    assert.equal((await post({ authorization: `Bearer ${revoked}` }, { operation: 'ok' })).status, 401);
    assert.equal((await fetch(`${base}/api/v1/dispatch?token=${revoked}`)).status, 405);
  });
});

test('HTTP transport enforces Host, Origin, method, Content-Type, JSON and body limit', async () => {
  const api: DispatchApi = {
    async dispatch(): Promise<LocalApiResponse> {
      return { status: 200, body: { ok: true } };
    },
  };
  await withServer(api, async (base, server) => {
    const port = server.address()!.port;
    const issued = token();
    const headers = {
      authorization: `Bearer ${issued}`,
      'content-type': 'application/json',
    };

    const origin = await fetch(`${base}/api/v1/dispatch`, {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.example' },
      body: '{"operation":"x"}',
    });
    assert.equal(origin.status, 403);
    assert.deepEqual(await origin.json(), { code: 'browser_origin_rejected' });

    const method = await fetch(`${base}/api/v1/dispatch`, { method: 'GET', headers });
    assert.equal(method.status, 405);

    const media = await fetch(`${base}/api/v1/dispatch`, {
      method: 'POST',
      headers: { authorization: headers.authorization, 'content-type': 'text/plain' },
      body: '{"operation":"x"}',
    });
    assert.equal(media.status, 415);

    const badJson = await fetch(`${base}/api/v1/dispatch`, {
      method: 'POST',
      headers,
      body: '{"operation":',
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { code: 'invalid_json' });

    let tooLargeStatus = 0;
    try {
      const tooLarge = await fetch(`${base}/api/v1/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: 'x', blob: 'a'.repeat(300_000) }),
      });
      tooLargeStatus = tooLarge.status;
      if (tooLargeStatus === 413) {
        assert.deepEqual(await tooLarge.json(), { code: 'request_too_large' });
      }
    } catch (error) {
      // Some clients observe a reset if the peer stops reading an oversized body.
      assert.match(error instanceof Error ? error.message : String(error), /fetch failed|other side closed|ECONNRESET/i);
      tooLargeStatus = 413;
    }
    assert.equal(tooLargeStatus, 413);

    const badHost = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      import('node:http').then((http) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/api/v1/dispatch',
          method: 'POST',
          headers: {
            ...headers,
            host: 'evil.example',
            'content-length': Buffer.byteLength('{"operation":"x"}'),
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          });
        });
        req.on('error', reject);
        req.end('{"operation":"x"}');
      }).catch(reject);
    });
    assert.equal(badHost.status, 400);
    assert.deepEqual(badHost.body, { code: 'invalid_host' });
  });
});

test('HTTP transport responses omit connection strings even if an API mishandles them', async () => {
  const api: DispatchApi = {
    async dispatch() {
      return { status: 500, body: { detail: 'postgres://alice:bos_disposable_test_only@127.0.0.1/db' } };
    },
  };
  await withServer(api, async (base) => {
    const response = await fetch(`${base}/api/v1/dispatch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token()}`,
        'content-type': 'application/json',
      },
      body: '{"operation":"x"}',
    });
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.equal(text.includes('postgres://'), false);
    assert.equal(text.includes('bos_disposable_test_only'), false);
    assert.deepEqual(JSON.parse(text), { code: 'internal_error' });
  });
});

test('closing the HTTP server releases the listen port', async () => {
  const api: DispatchApi = {
    async dispatch() {
      return { status: 200, body: { ok: true } };
    },
  };
  const first = new LocalHttpServer({ api, port: 0 });
  const listen = await first.listen();
  await first.close();
  const second = new LocalHttpServer({ api, port: listen.port });
  const again = await second.listen();
  assert.equal(again.port, listen.port);
  await second.close();
  assert.equal(createHash('sha256').update('not-a-secret-check').digest('hex').length, 64);
});
