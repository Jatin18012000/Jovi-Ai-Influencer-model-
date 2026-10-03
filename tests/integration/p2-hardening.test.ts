import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { QA_AGENT_DEFINITION } from '../../src/agents/production/qa-agent.js';
import { SCRIPT_AGENT_DEFINITION } from '../../src/agents/production/creative-agents.js';
import { createToolKit } from '../../src/agents/toolkit.js';
import { estimateTokenBits } from '../../src/core/auth/api-credentials.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { PermissionDeniedError, ValidationError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { PermissionGuard } from '../../src/core/permissions/permissions.js';
import { openDatabase } from '../../src/database/client.js';
import { MediaStore } from '../../src/media/media-store.js';
import { runProcess, setExecutablePins } from '../../src/media/process-runner.js';
import { ComfyUIImageProvider } from '../../src/media/providers/comfyui-providers.js';
import { BYTE_CAPS, readBodyCapped } from '../../src/models/providers/http.js';
import { pngBytes, TEST_WORKFLOW } from '../fakes/fake-media.js';
import { LOCKED_PROFILE } from '../fakes/production-fixtures.js';
import { bearer, createTestCore } from '../helpers.js';

/**
 * Regression tests for the P2 security remediations R-09 … R-18 (audit
 * findings F-08, F-10 … F-16, F-18 … F-23). R-14 (container hardening) is
 * verified by the "Container (hardened compose)" CI job; R-19 is documentation.
 */

let dir: string;
let core: JoviCore | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-p2-'));
});
afterEach(async () => {
  setExecutablePins({});
  await core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('R-09 symlink-safe confinement (RT-09)', () => {
  it('refuses symlinked files and symlinked directories inside media/references; reads without following links', () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.png'), pngBytes(4, 4));
    const refs = join(dir, 'references');
    const media = join(dir, 'media');
    mkdirSync(refs);
    mkdirSync(join(media, 'prd_aaaaaaaa'), { recursive: true });
    const store = new MediaStore(media, refs);

    writeFileSync(join(refs, 'sheet.png'), pngBytes(4, 4));
    symlinkSync(join(outside, 'secret.png'), join(refs, 'link.png'));
    symlinkSync(outside, join(refs, 'linked-dir'));
    symlinkSync(join(outside, 'secret.png'), join(media, 'prd_aaaaaaaa', 'ast_bbbbbbbb.png'));

    expect(store.isReadableInput(join(refs, 'sheet.png'))).toBe(true);
    expect(store.isReadableInput(join(refs, 'link.png'))).toBe(false);
    expect(store.isReadableInput(join(refs, 'linked-dir', 'secret.png'))).toBe(false);
    expect(store.holdsFile(join(media, 'prd_aaaaaaaa', 'ast_bbbbbbbb.png'))).toBe(false);
    expect(store.readInput(join(refs, 'sheet.png')).length).toBeGreaterThan(0);
    expect(() => store.readInput(join(refs, 'link.png'))).toThrow(ValidationError);
    expect(() => store.readInput(join(refs, 'linked-dir', 'secret.png'))).toThrow(ValidationError);
  });
});

describe('R-10 artifact-scoped production writes (RT-04b)', () => {
  it('the script agent cannot write a QA report; only the QA agent can', async () => {
    core = await createTestCore();
    const c = core;
    const services = (c.runner as unknown as { services: Parameters<typeof createToolKit>[0] }).services;
    const kit = (def: typeof SCRIPT_AGENT_DEFINITION) =>
      createToolKit(services, new PermissionGuard(def.name, def.permissionLevel, def.allowedTools as never, 'LEVEL_3_EXECUTE'), {
        scope: c.events.scope(newId('correlation')),
        trace: () => ({ purpose: 'test', correlationId: 'x', scope: c.events.scope('x'), taskId: null, jobId: null, agentRunId: null }) as never,
      });
    const scope = c.events.scope(newId('correlation'));
    const task = c.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: 'r10', createdBy: 'test' }, scope);
    const p = c.productions.create({ taskId: task.id, sourceType: 'DIRECT', sourcePlanningTaskId: null, ideaId: 'i', idea: {}, productionContext: {}, identityVersion: 1, visualIdentityVersion: 1, simulated: false }, scope);

    expect(() => kit(SCRIPT_AGENT_DEFINITION).production.saveArtifact(p.id, 'QA_REPORT', { status: 'PASS' })).toThrow(PermissionDeniedError);
    expect(() => kit(SCRIPT_AGENT_DEFINITION).production.saveArtifact(p.id, 'SAFETY_REVIEW', { verdict: 'ALLOW', reasons: [] })).toThrow(PermissionDeniedError);
    expect(c.productions.get(p.id).qaStatus).toBeNull();
    kit(SCRIPT_AGENT_DEFINITION).production.saveArtifact(p.id, 'SCRIPT', { title: 't' });
    kit(QA_AGENT_DEFINITION).production.saveArtifact(p.id, 'QA_REPORT', { status: 'PASS' });
    expect(c.productions.get(p.id).qaStatus).toBe('PASS');
    expect(QA_AGENT_DEFINITION.allowedTools).toContain('production.write:QA_REPORT');
    expect(SCRIPT_AGENT_DEFINITION.allowedTools).not.toContain('production.write:QA_REPORT');
  });
});

describe('R-11 checks on human-entered visual identity (RT-19)', () => {
  it('refuses likeness, minors, explicit content and an apparent age that contradicts the identity', async () => {
    core = await createTestCore();
    const create = (profile: object) => core!.visualIdentity.createVersion({ ...LOCKED_PROFILE, ...profile } as never, 'human:art-director', 'test');
    expect(() => create({ face: 'exact lookalike of a famous pop star' })).toThrow(/REAL_PERSON_LIKENESS/);
    expect(() => create({ face: 'resembles a well-known actress' })).toThrow(/REAL_PERSON_LIKENESS/);
    expect(() => create({ body: 'petite, schoolgirl proportions' })).toThrow(/MINOR_DEPICTION/);
    expect(() => create({ signatureStyle: 'a 16 year old girl aesthetic' })).toThrow(/MINOR_DEPICTION/);
    expect(() => create({ signatureStyle: 'nude photoshoot styling' })).toThrow(/EXPLICIT/);
    expect(() => create({ apparentAge: 30 })).toThrow(/contradicts the active identity/);
    // Negated phrasing and a normal adult profile are accepted.
    expect(create({ face: 'oval face, not resembling any real person' }).status).toBe('LOCKED');
    expect(core.visualIdentity.getActive().profile.apparentAge).toBe(core.identity.getActive().profile.age);
  });
});

describe('R-12 generic 5xx bodies', () => {
  it('never returns internal error messages; the request id correlates with the server log', async () => {
    core = await createTestCore();
    (core.identity as unknown as { getActive: () => never }).getActive = () => {
      throw new Error('ENOENT: /Users/jatin/secret/jovi.db could not be opened');
    };
    const app = buildApiServer(core);
    const res = await app.inject({ method: 'GET', url: '/api/jovi/identity', headers: bearer(core) });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('jatin');
    expect(res.json()).toMatchObject({ error: 'INTERNAL_ERROR', message: 'Internal error; see the server log', requestId: expect.any(String) });
    await app.close();
  });
});

describe('R-13 token policy and rotation', () => {
  it('rejects guessable operator tokens; accepts random ones', () => {
    expect(() => loadConfig({ JOVI_API_TOKEN: 'x'.repeat(40) })).toThrow(/guessable/);
    expect(() => loadConfig({ JOVI_API_TOKEN: 'passwordpasswordpasswordpassword' })).toThrow(/guessable/);
    expect(() => loadConfig({ JOVI_API_TOKEN: 'short-token' })).toThrow(/at least 32/);
    const random = createHash('sha256').update('seed').digest('base64');
    expect(estimateTokenBits(random)).toBeGreaterThanOrEqual(128);
    expect(loadConfig({ JOVI_API_TOKEN: random }).api.token).toBe(random);
    expect(() => loadConfig({ JOVI_API_TOKEN_PREVIOUS: random })).toThrow(/only valid together with JOVI_API_TOKEN/);
  });

  it('accepts the previous operator token during a rollover', async () => {
    const current = createHash('sha256').update('current').digest('base64');
    const previous = createHash('sha256').update('previous').digest('base64');
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(() => loadConfig({ JOVI_API_TOKEN: current, JOVI_API_TOKEN_PREVIOUS: previous })).toThrow(/EXPIRES_AT/);
    expect(() => loadConfig({ JOVI_API_TOKEN: current, JOVI_API_TOKEN_PREVIOUS: previous, JOVI_API_TOKEN_PREVIOUS_EXPIRES_AT: '2099-01-01T00:00:00Z' })).toThrow(/30 days/);
    core = await createTestCore({ env: { JOVI_API_TOKEN: current, JOVI_API_TOKEN_PREVIOUS: previous, JOVI_API_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt } });
    const app = buildApiServer(core);
    const whoami = (token: string) => app.inject({ method: 'GET', url: '/api/auth/whoami', headers: { authorization: `Bearer ${token}` } });
    expect((await whoami(current)).json().principal).toBe('env:JOVI_API_TOKEN');
    expect((await whoami(previous)).json().principal).toBe('env:JOVI_API_TOKEN_PREVIOUS');
    expect((await whoami('jovi_not-a-token')).statusCode).toBe(401);
    await app.close();
  });

  it('stored credentials can expire and be rotated with a rollover window', async () => {
    core = await createTestCore();
    const { token: oldToken } = core.credentials.create('n8n', ['read', 'operate'], 'test');
    const rotated = core.credentials.rotate('n8n', 'test', 7);
    expect(rotated.credential.name).toBe('n8n.r2');
    expect(rotated.credential.scopes).toEqual(['read', 'operate']);
    expect(Date.parse(rotated.previous.expiresAt!)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    // Both tokens work during the rollover window…
    expect(core.credentials.verify(oldToken)?.id).toBe('api:n8n');
    expect(core.credentials.verify(rotated.token)?.id).toBe('api:n8n.r2');
    // …and the old one stops at its expiry.
    core.database.sqlite.prepare("UPDATE api_credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE name = 'n8n'").run();
    expect(core.credentials.verify(oldToken)).toBeNull();
    expect(core.credentials.rotate('n8n.r2', 'test').credential.name).toBe('n8n.r3');
    expect(() => core!.credentials.create('temp', ['read'], 'test', { expiresInDays: 0 })).toThrow(ValidationError);
    expect(core.credentials.create('temp', ['read'], 'test', { expiresInDays: 1 }).credential.expiresAt).not.toBeNull();
  });
});

describe('R-15 provider response byte caps', () => {
  const stream = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunks; i += 1) controller.enqueue(new Uint8Array(size));
        controller.close();
      },
    });

  it('refuses a declared oversize body and stops reading a streamed body past the cap', async () => {
    const declared = new Response('x', { headers: { 'content-length': String(BYTE_CAPS.image + 1) } });
    await expect(readBodyCapped(declared, BYTE_CAPS.image, 'test')).rejects.toThrow(/too large/);
    await expect(readBodyCapped(new Response(stream(10, 1024)), 4096, 'test')).rejects.toThrow(/exceeded 4096 bytes/);
    expect((await readBodyCapped(new Response(stream(3, 1024)), 4096, 'test')).length).toBe(3072);
    expect(BYTE_CAPS).toMatchObject({ image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 50 * 1024 * 1024 });
  });
});

describe('R-16 destructive actions classify as LEVEL_5', () => {
  it('flags filesystem and destructive verbs without catching creator language', () => {
    const level = (a: string) => PermissionGuard.classifyAction(a);
    for (const a of ['rm -rf data/', 'sudo rm the cache', 'Delete the old drafts folder', 'wipe the media directory', 'format the disk', 'drop table events', 'truncate the logs', 'chmod 777 data']) {
      expect(level(a), a).toBe('LEVEL_5_INFRASTRUCTURE');
    }
    for (const a of ['Drop a new reel on Friday', 'Use the reel format', 'She is killing it in this scene', 'Remove the filler words from the script']) {
      expect(level(a), a).not.toBe('LEVEL_5_INFRASTRUCTURE');
    }
  });
});

describe('R-17 trust pins and warnings', () => {
  it('runs a pinned executable only when its SHA-256 matches', async () => {
    const real = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    setExecutablePins({ [process.execPath]: '0'.repeat(64) });
    await expect(runProcess('test', process.execPath, ['-e', '0'], { timeoutMs: 10_000 })).rejects.toMatchObject({ code: 'BINARY_HASH_MISMATCH' });
    setExecutablePins({ [process.execPath]: real });
    expect((await runProcess('test', process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 10_000 })).code).toBe(0);
  });

  it('refuses a changed ComfyUI workflow when a pin is set', async () => {
    const path = join(dir, 'wf.json');
    writeFileSync(path, JSON.stringify(TEST_WORKFLOW));
    const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
    const pinned = new ComfyUIImageProvider({ url: 'http://127.0.0.1:9', workflowPath: path, workflowSha256: '0'.repeat(64), timeoutMs: 1000 }, store);
    const status = await pinned.inspectAvailability();
    expect(status).toMatchObject({ available: false, state: 'MISCONFIGURED' });
    expect(status.reason).toMatch(/not the approved version/);
  });

  it('requires absolute paths for pinned binaries and warns about non-loopback model/media servers', () => {
    expect(() => loadConfig({ JOVI_FFMPEG_PATH: 'ffmpeg', JOVI_FFMPEG_SHA256: 'a'.repeat(64) })).toThrow(/absolute path/);
    expect(() => loadConfig({ JOVI_FFMPEG_SHA256: 'not-a-hash' })).toThrow();
    const warnings = loadConfig({ LM_STUDIO_URL: 'http://192.168.1.20:1234/v1', COMFYUI_URL: 'http://gpu-box:8188' }).warnings.join(' ');
    expect(warnings).toMatch(/LM_STUDIO_URL .* is not loopback/);
    expect(warnings).toMatch(/COMFYUI_URL .* is not loopback/);
    expect(loadConfig({ COMFYUI_URL: 'http://127.0.0.1:8188' }).warnings.join(' ')).not.toMatch(/not loopback/);
  });
});

describe('R-18 data at rest', () => {
  it('creates the database owner-only (0600) in an owner-only directory (0700)', () => {
    const handle = openDatabase(join(dir, 'private', 'jovi.db'));
    handle.sqlite.prepare('CREATE TABLE t (x)').run();
    handle.close();
    expect(statSync(join(dir, 'private', 'jovi.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'private')).mode & 0o777).toBe(0o700);
  });

  it('prunes old runs and (when configured) old events behind a checkpoint; the chain still verifies', async () => {
    core = await createTestCore({ env: { JOVI_EVENT_RETENTION_DAYS: '30', JOVI_RUN_RETENTION_DAYS: '30', JOVI_SIMULATION_MODE: 'true' } });
    await core.orchestrator.executeGoal({ goal: 'Create an Instagram Reel concept for Jovi.' });
    const before = core.events.verifyChain();
    const runs = (core.database.sqlite.prepare('SELECT count(*) AS n FROM model_runs').get() as { n: number }).n;
    expect(runs).toBeGreaterThan(0);

    const future = new Date(Date.now() + 60 * 86_400_000);
    const dry = core.retention.apply({ dryRun: true, now: future });
    expect(dry.events.pruned).toBe(before.checked - 1);
    expect(core.events.verifyChain().checked).toBe(before.checked);

    const applied = core.retention.apply({ now: future });
    expect(applied).toMatchObject({ modelRuns: runs, events: { pruned: before.checked - 1 } });
    expect((core.database.sqlite.prepare('SELECT count(*) AS n FROM model_runs').get() as { n: number }).n).toBe(0);
    const after = core.events.verifyChain();
    expect(after).toMatchObject({ ok: true, firstBreak: null });
    expect(core.events.list({ eventType: 'RETENTION_APPLIED', limit: 5 })).toHaveLength(1);
    // The chain continues across the checkpoint.
    core.events.emit({ eventType: 'MEMORY_CREATED', source: 'test', payload: {} });
    expect(core.events.verifyChain().ok).toBe(true);
    const first = core.database.sqlite.prepare('SELECT id FROM events ORDER BY sequence LIMIT 1').get() as { id: string };
    expect(core.events.verifyEvent(first.id).ok).toBe(true);
    // Deleting the checkpoint is detected.
    core.database.sqlite.prepare('DELETE FROM audit_checkpoints').run();
    expect(core.events.verifyChain().ok).toBe(false);
  });

  it('event retention is off by default (the audit log is kept)', async () => {
    core = await createTestCore({ env: { JOVI_SIMULATION_MODE: 'true' } });
    await core.orchestrator.executeGoal({ goal: 'Create an Instagram Reel concept for Jovi.' });
    expect(core.retention.apply({ now: new Date(Date.now() + 3650 * 86_400_000) }).events.pruned).toBe(0);
  });

  it('writes an owner-only online backup and never overwrites one', async () => {
    core = await createTestCore();
    const target = join(dir, 'backup.db');
    const backup = await core.retention.backup(target);
    expect(backup.bytes).toBeGreaterThan(0);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const copy = new Database(target, { readonly: true });
    expect((copy.prepare('SELECT count(*) AS n FROM jovi_identity').get() as { n: number }).n).toBeGreaterThan(0);
    copy.close();
    await expect(core.retention.backup(target)).rejects.toThrow(/already exists/);
    expect(existsSync(target)).toBe(true);
  });
});
