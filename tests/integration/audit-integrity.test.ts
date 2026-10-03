import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApiServer } from '../../apps/api/server.js';
import { AuthFailureRecorder } from '../../apps/api/security.js';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { PermissionDeniedError } from '../../src/core/errors.js';
import { PROTECTED_EVENT_TYPES } from '../../src/core/events/event-bus.js';
import { newId } from '../../src/core/ids.js';
import { MediaStore } from '../../src/media/media-store.js';
import { redactArgs, runProcess, setProcessAuditSink, type ProcessExecutionRecord } from '../../src/media/process-runner.js';
import { TestImageProvider, TestRenderProvider, TestVideoProvider, TestVoiceProvider } from '../fakes/fake-media.js';
import { countingLocalModel, DIRECT_IDEA, LOCKED_PROFILE, VOICE_DURATIONS } from '../fakes/production-fixtures.js';
import { bearer, createTestCore } from '../helpers.js';

/**
 * Regression tests for security remediation R-08 (audit F-09 / F-17,
 * red-team RT-05c and RT-17a): a hash-chained event log, protected
 * (attested) event types, approval reconciliation in the publishing gate,
 * auth-failure events and process-execution audit records.
 */

let dir: string;
let core: JoviCore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jovi-audit-'));
});
afterEach(async () => {
  setProcessAuditSink(() => undefined);
  await core?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function productionCore() {
  const store = new MediaStore(join(dir, 'media'), join(dir, 'references'));
  core = await createTestCore({
    providers: [countingLocalModel().model],
    mediaProviders: [new TestImageProvider(store), new TestVideoProvider(store), new TestVoiceProvider(store, VOICE_DURATIONS), new TestRenderProvider(store)],
    env: { JOVI_MEDIA_DIR: join(dir, 'media'), JOVI_REFERENCE_DIR: join(dir, 'references') },
  });
  core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock for tests');
  const result = await core.production.start({ idea: DIRECT_IDEA });
  expect(result.productionStatus).toBe('AWAITING_HUMAN_APPROVAL');
  return result;
}

describe('R-08 hash-chained event log', () => {
  it('chains every event and verifies the whole log', async () => {
    core = await createTestCore();
    await core.orchestrator.executeGoal({ goal: 'Create an Instagram Reel concept for Jovi.' });
    const chain = core.events.verifyChain();
    expect(chain).toMatchObject({ ok: true, legacyUnchained: 0, firstBreak: null });
    expect(chain.checked).toBeGreaterThan(5);
    expect(chain.head?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects an edited payload, a deleted row and an inserted forgery', async () => {
    core = await createTestCore();
    await core.orchestrator.executeGoal({ goal: 'Create an Instagram Reel concept for Jovi.' });
    const { sqlite } = core.database;
    const target = sqlite.prepare('SELECT id, sequence, payload FROM events ORDER BY sequence LIMIT 1 OFFSET 3').get() as { id: string; sequence: number; payload: string };

    sqlite.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify({ forged: true }), target.id);
    expect(core.events.verifyChain().firstBreak).toMatchObject({ sequence: target.sequence, reason: 'content does not match its hash' });
    sqlite.prepare('UPDATE events SET payload = ? WHERE id = ?').run(target.payload, target.id);
    expect(core.events.verifyChain().ok).toBe(true);

    sqlite.prepare('DELETE FROM events WHERE id = ?').run(target.id);
    expect(core.events.verifyChain().firstBreak?.reason).toMatch(/sequence gap/);
  });

  it('a forged row with a copied hash is detected by both the chain and the single-event check', async () => {
    core = await createTestCore();
    core.events.emit({ eventType: 'MEMORY_CREATED', source: 'test', payload: {} });
    const last = core.database.sqlite.prepare('SELECT * FROM events ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; hash: string };
    core.database.sqlite
      .prepare("INSERT INTO events (id, event_type, timestamp, source, entity_id, payload, schema_version, sequence, prev_hash, hash) VALUES ('evt_forged', 'PRODUCTION_APPROVED', '2026-10-03T00:00:00.000Z', 'production', 'prd_x', '{}', 1, ?, ?, ?)")
      .run(last.sequence + 1, last.hash, last.hash);
    expect(core.events.verifyEvent('evt_forged')).toEqual({ ok: false, reason: 'content does not match its hash' });
    expect(core.events.verifyChain().ok).toBe(false);
  });
});

describe('R-08 protected events (RT-17a)', () => {
  it('only the owning services can emit approval, identity and credential events', async () => {
    core = await createTestCore();
    const scope = core.events.scope(newId('correlation'));
    for (const type of PROTECTED_EVENT_TYPES) {
      expect(() => scope.emit(type, 'agents.script', 'prd_forged', { reviewer: 'nobody' })).toThrow(PermissionDeniedError);
      expect(() => core.events.emit({ eventType: type, source: 'api', payload: {} })).toThrow(PermissionDeniedError);
    }
    expect(core.events.list({ eventType: 'PRODUCTION_APPROVED', limit: 5 })).toHaveLength(0);
    // The capability is issued once, at bootstrap.
    expect(() => core.events.issueAttestation()).toThrow(PermissionDeniedError);
    // The owning services still emit them.
    core.credentials.create('ops', ['read'], 'test');
    core.visualIdentity.createVersion(LOCKED_PROFILE, 'human:art-director', 'lock');
    expect(core.events.list({ eventType: 'API_CREDENTIAL_CREATED', limit: 5 })).toHaveLength(1);
    expect(core.events.list({ eventType: 'VISUAL_IDENTITY_VERSION_CREATED', limit: 5 })[0]).toMatchObject({ source: 'identity.visual', payload: { approvedBy: 'human:art-director' } });
  });
});

describe('R-08 approval reconciliation in the publishing gate (RT-05c)', () => {
  it('a status set by editing the database is "approval not attested"', async () => {
    const result = await productionCore();
    core.database.sqlite.prepare("UPDATE productions SET status = 'APPROVED', approved_by = 'nobody' WHERE id = ?").run(result.productionId);
    const gate = core.productions.publishingGate(result.productionId!);
    expect(gate.eligibleForHumanPublishing).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/approval not attested: no PRODUCTION_APPROVED event/);
  });

  it('a genuine approval is attested; a later approver rewrite or event tampering is caught', async () => {
    const result = await productionCore();
    const id = result.productionId!;
    core.productions.recordHumanDecision(id, { decision: 'APPROVE', reviewer: 'api:jatin', acknowledgeWarnings: true }, core.events.scope(result.correlationId));
    expect(core.productions.publishingGate(id).blockers.join(' ')).not.toMatch(/not attested/);

    core.database.sqlite.prepare("UPDATE productions SET approved_by = 'api:someone-else' WHERE id = ?").run(id);
    expect(core.productions.publishingGate(id).blockers.join(' ')).toMatch(/does not match the recorded approver/);

    core.database.sqlite.prepare("UPDATE productions SET approved_by = 'api:jatin' WHERE id = ?").run(id);
    core.database.sqlite.prepare("UPDATE events SET timestamp = '2020-01-01T00:00:00.000Z' WHERE event_type = 'PRODUCTION_APPROVED' AND entity_id = ?").run(id);
    expect(core.productions.publishingGate(id).blockers.join(' ')).toMatch(/failed the audit hash chain/);
  });
});

describe('R-08 audit coverage: auth failures and process executions', () => {
  it('records 401/403 refusals as API_AUTH_FAILED events, throttled per client', async () => {
    core = await createTestCore();
    const app = buildApiServer(core);
    await app.inject({ method: 'GET', url: '/api/agents' });
    await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer jovi_wrong' } });
    await app.inject({ method: 'GET', url: '/api/agents', headers: { host: 'evil.example' } });
    await app.inject({ method: 'POST', url: '/api/jovi/goal', headers: bearer(core, ['read'], 'reader'), payload: { goal: 'x' } });
    const reasons = core.events.list({ eventType: 'API_AUTH_FAILED', limit: 10 }).map((e) => e.payload.reason);
    expect(reasons).toEqual(['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'HOST_OR_ORIGIN_REFUSED', 'MISSING_SCOPE']);
    // The audit verification route needs the approve scope.
    expect((await app.inject({ method: 'GET', url: '/api/audit/verify', headers: bearer(core, ['read', 'operate']) })).statusCode).toBe(403);
    const verify = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: bearer(core, ['approve']) });
    expect(verify.json().chain).toMatchObject({ ok: true });
    await app.close();

    let now = 0;
    const recorded: Array<Record<string, unknown>> = [];
    const recorder = new AuthFailureRecorder((p) => recorded.push(p), 3, () => now);
    for (let i = 0; i < 10; i += 1) recorder.failure('10.0.0.9', { reason: 'MISSING_CREDENTIAL' });
    expect(recorded).toHaveLength(3);
    now += 61_000;
    recorder.failure('10.0.0.9', { reason: 'MISSING_CREDENTIAL' });
    expect(recorded.at(-1)).toMatchObject({ suppressedSinceLastEvent: 7 });
  });

  it('logs every external process execution with redacted paths, duration and exit code', async () => {
    const records: ProcessExecutionRecord[] = [];
    setProcessAuditSink((r) => records.push(r));
    const result = await runProcess('test', process.execPath, ['-e', 'process.exit(3)', '/Users/jatin/private/clip.mp4'], { timeoutMs: 10_000 });
    expect(result.code).toBe(3);
    await expect(runProcess('test', '/definitely/missing/ffmpeg', [], { timeoutMs: 1000 })).rejects.toThrow(/not found/);
    expect(records[0]).toMatchObject({ provider: 'test', exitCode: 3, outcome: 'EXITED', args: ['-e', 'process.exit(3)', '<path>/clip.mp4'] });
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(records)).not.toContain('jatin');
    expect(records[1]).toMatchObject({ binary: 'ffmpeg', outcome: 'START_FAILED', exitCode: null });
    expect(records).toHaveLength(2);
    expect(redactArgs(['https://example.com/a', '-vf', 'scale=1080:1920'])).toEqual(['https://example.com/a', '-vf', 'scale=1080:1920']);
  });
});
