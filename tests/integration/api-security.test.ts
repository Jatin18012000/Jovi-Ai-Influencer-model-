import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { checkHostAndOrigin, hostnameOf } from '../../apps/api/security.js';
import { ApiScope, hashToken } from '../../src/core/auth/api-credentials.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { bearer, createTestCore, TEST_GOAL } from '../helpers.js';

/**
 * Regression tests for security remediations R-01 (mandatory authentication,
 * Host/Origin allow-list) and R-04 (scoped credentials, actor derived from the
 * credential). Each test corresponds to a red-team check in docs/audit.
 */

let core: JoviCore;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await core?.close();
});

async function start(env: Record<string, string> = {}) {
  core = await createTestCore({ env });
  app = buildApiServer(core);
  await app.ready();
}

const ROUTES: Array<{ method: 'GET' | 'POST'; url: string }> = [
  { method: 'GET', url: '/api/status' },
  { method: 'GET', url: '/api/jovi/identity' },
  { method: 'GET', url: '/api/jovi/strategy' },
  { method: 'POST', url: '/api/jovi/goal' },
  { method: 'POST', url: '/api/jovi/planning' },
  { method: 'POST', url: '/api/productions' },
  { method: 'GET', url: '/api/productions/prd_x' },
  { method: 'POST', url: '/api/productions/prd_x/decision' },
  { method: 'POST', url: '/api/productions/prd_x/regenerate-media' },
  { method: 'GET', url: '/api/media/providers' },
  { method: 'GET', url: '/api/visual-identity' },
  { method: 'POST', url: '/api/visual-identity' },
  { method: 'GET', url: '/api/events' },
  { method: 'POST', url: '/api/memory' },
  { method: 'GET', url: '/api/memory' },
  { method: 'GET', url: '/api/models' },
  { method: 'GET', url: '/api/agents' },
  { method: 'POST', url: '/api/evaluate' },
];

describe('R-01 mandatory authentication', () => {
  it('every non-public route refuses a request without a valid credential (RT-05b)', async () => {
    await start();
    for (const route of ROUTES) {
      const none = await app.inject({ ...route, payload: route.method === 'POST' ? {} : undefined });
      expect(none.statusCode, `${route.method} ${route.url}`).toBe(401);
      const wrong = await app.inject({ ...route, headers: { authorization: 'Bearer jovi_wrong' }, payload: route.method === 'POST' ? {} : undefined });
      expect(wrong.statusCode, `${route.method} ${route.url} (bad token)`).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('revoked credentials stop working; tokens are stored only as hashes', async () => {
    await start();
    const { credential, token } = core.credentials.create('temporary', ['read'], 'test');
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: auth })).statusCode).toBe(200);
    expect(core.credentials.list().find((c) => c.name === 'temporary')?.lastUsedAt).not.toBeNull();
    const rows = core.database.sqlite.prepare('SELECT * FROM api_credentials').all();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).toContain(hashToken(token));
    core.credentials.revoke(credential.name, 'test');
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: auth })).statusCode).toBe(401);
    expect(() => core.credentials.create('temporary', ['read'], 'test')).toThrow(/never reused/);
    expect(token).toMatch(/^jovi_[A-Za-z0-9_-]{43}$/);
  });

  it('a fresh deployment has no usable credential until one is created (first-run bootstrap)', async () => {
    await start();
    expect(core.credentials.hasUsableCredential()).toBe(false);
    core.credentials.create('owner', ApiScope.options, 'bootstrap:first-run');
    expect(core.credentials.hasUsableCredential()).toBe(true);
  });
});

describe('R-01 Host / Origin allow-list (DNS rebinding, RT-06)', () => {
  it('refuses foreign Host headers on every route, including /health and with a valid token', async () => {
    await start();
    const auth = bearer(core);
    for (const host of ['rebind.attacker.example', 'attacker.example:3000', '192.168.1.20:3000', 'localhost.attacker.example']) {
      for (const url of ['/health', '/api/agents']) {
        const res = await app.inject({ method: 'GET', url, headers: { ...auth, host } });
        expect(res.statusCode, `${host} ${url}`).toBe(403);
        expect(res.json().error).toBe('FORBIDDEN_HOST_OR_ORIGIN');
      }
    }
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST']) {
      expect((await app.inject({ method: 'GET', url: '/api/agents', headers: { ...auth, host } })).statusCode, host).toBe(200);
    }
  });

  it('refuses cross-site browser origins; allows loopback and configured origins', async () => {
    await start({ JOVI_ALLOWED_ORIGINS: 'https://dashboard.jovi.example' });
    const auth = bearer(core);
    const call = (origin: string) => app.inject({ method: 'GET', url: '/api/agents', headers: { ...auth, origin } });
    expect((await call('http://evil.example')).statusCode).toBe(403);
    expect((await call('null')).statusCode).toBe(403);
    expect((await call('http://localhost:5173')).statusCode).toBe(200);
    expect((await call('https://dashboard.jovi.example')).statusCode).toBe(200);
    expect((await call('https://dashboard.jovi.example.evil.com')).statusCode).toBe(403);
  });

  it('JOVI_ALLOWED_HOSTS admits named hosts such as a compose service', async () => {
    await start({ JOVI_ALLOWED_HOSTS: 'jovi-core' });
    expect((await app.inject({ method: 'GET', url: '/health', headers: { host: 'jovi-core:3000' } })).statusCode).toBe(200);
  });

  it('parses Host headers safely', () => {
    expect(hostnameOf('[::1]:3000')).toBe('::1');
    expect(hostnameOf('Localhost:3000')).toBe('localhost');
    expect(hostnameOf('::1')).toBe('::1');
    expect(hostnameOf(undefined)).toBeNull();
    expect(checkHostAndOrigin({ host: 'localhost' }, ['localhost'], [])).toBeNull();
    expect(checkHostAndOrigin({ host: 'localhost', origin: 'file://' }, ['localhost'], [])).toMatch(/origin/);
  });
});

describe('R-04 scoped credentials and principal-derived actors (RT-05d)', () => {
  async function production() {
    const res = await app.inject({ method: 'POST', url: '/api/productions', headers: bearer(core, ['operate', 'read']), payload: { idea: { id: 'i1', title: 'Coffee critic minute', format: 'REEL', pillar: 'Lifestyle', hook: 'Rating this flat white.', concept: 'Jovi reviews a flat white.' } } });
    expect(res.statusCode).toBe(200);
    return res.json().productionId as string;
  }

  it('read cannot operate; operate cannot approve or change identity', async () => {
    await start();
    const read = bearer(core, ['read'], 'reader');
    expect((await app.inject({ method: 'GET', url: '/api/agents', headers: read })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'POST', url: '/api/jovi/goal', headers: read, payload: { goal: TEST_GOAL } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('FORBIDDEN_SCOPE');

    const id = await production();
    const automation = bearer(core, ['read', 'operate'], 'n8n');
    expect((await app.inject({ method: 'POST', url: `/api/productions/${id}/decision`, headers: automation, payload: { decision: 'REJECT' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/visual-identity', headers: automation, payload: { profile: {}, changeSummary: 'x' } })).statusCode).toBe(403);
    expect(core.productions.get(id).approvalDecision).toBeNull();
  });

  it('the approver recorded is the credential principal; body-supplied actor fields are rejected', async () => {
    await start();
    const id = await production();
    const approver = bearer(core, ['approve'], 'jatin-reviewer');
    const spoof = await app.inject({ method: 'POST', url: `/api/productions/${id}/decision`, headers: approver, payload: { decision: 'REJECT', reviewer: 'Chief Security Officer' } });
    expect(spoof.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/productions/${id}/decision`, headers: approver, payload: { decision: 'REJECT', note: 'test' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().production.approvedBy).toBe('api:jatin-reviewer');
    const event = core.events.list({ eventType: 'PRODUCTION_REJECTED', limit: 5 }).at(-1);
    expect(event?.payload).toMatchObject({ reviewer: 'api:jatin-reviewer' });
  });

  it('operator JOVI_API_TOKEN defaults to read,operate and can be widened explicitly', async () => {
    const token = 'operator-token-0123456789-abcdefghij';
    await start({ JOVI_API_TOKEN: token, JOVI_API_TOKEN_SCOPES: 'read,operate,approve' });
    const whoami = await app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { authorization: `Bearer ${token}` } });
    expect(whoami.json()).toEqual({ principal: 'env:JOVI_API_TOKEN', scopes: ['read', 'operate', 'approve'] });
    await expect(createTestCore({ env: { JOVI_API_TOKEN_SCOPES: 'read,root' } })).rejects.toThrow();
  });
});

describe('security headers (F-12)', () => {
  it('sets baseline headers and keeps /health minimal', async () => {
    await start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Object.keys(res.json()).sort()).toEqual(['database', 'service', 'status']);
  });
});
