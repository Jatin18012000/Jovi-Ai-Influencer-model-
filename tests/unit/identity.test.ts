import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { seedDatabase } from '../../src/database/seed.js';
import { createTestCore } from '../helpers.js';

describe('Jovi identity', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('seeds and loads the approved identity', async () => {
    core = await createTestCore();
    const identity = core.identity.getActive();

    expect(identity.version).toBe(1);
    expect(identity.profile.name).toBe('Jovira');
    expect(identity.profile.creatorName).toBe('Jovi');
    expect(identity.profile.age).toBe(25);
    expect(identity.profile.origin).toBe('London, UK');
    expect(identity.profile.heritage).toBe('Indian + Russian + Western influence');
    expect(identity.profile.communityName).toBe("Jovi's Crew");
    expect(identity.profile.transparency.isOpenlyAI).toBe(true);
    expect(identity.profile.transparency.mustNeverClaimHuman).toBe(true);
    expect(identity.profile.voice.goldenRule).toBe('Jovi should never sound like an AI writing an Instagram caption.');
    expect(identity.profile.corePillars).toEqual(['Travel & Exploration', 'Fashion & Beauty', 'Entertainment & Personality']);
    expect(identity.profile.contentCategories).toHaveLength(8);
    const voiceTotal = identity.profile.voice.mix.reduce((sum, m) => sum + m.weight, 0);
    expect(voiceTotal).toBeCloseTo(1);
    const audienceTotal = identity.profile.audienceRelationship.reduce((sum, m) => sum + m.weight, 0);
    expect(audienceTotal).toBeCloseTo(1);
  });

  it('seeds the initial strategy version without locking numbers as rules', async () => {
    core = await createTestCore();
    const strategy = core.strategy.getActive();
    expect(strategy.version).toBe(1);
    expect(strategy.objective).toBe("Build awareness and community around Jovi's identity.");
    expect(strategy.content.approach).toBe('CORE_PLUS_ROTATION');
    expect(strategy.content.formatPriorities.map((f) => f.format)).toEqual(['REEL', 'STORY', 'CAROUSEL', 'PHOTO']);
    expect(strategy.content.contentMix.enforcement).toBe('GUIDELINE');
    expect(strategy.content.cadence.enforcement).toBe('GUIDELINE');
  });

  it('is idempotent when seeded again', async () => {
    core = await createTestCore();
    const report = seedDatabase(core.database);
    expect(report).toEqual({ identity: 'exists', strategy: 'exists', memoriesCreated: 0, memoriesExisting: report.memoriesExisting });
    expect(report.memoriesExisting).toBeGreaterThan(10);
    expect(core.identity.listVersions()).toHaveLength(1);
  });

  it('versions identity changes instead of editing in place', async () => {
    core = await createTestCore();
    const current = core.identity.getActive();
    const updated = core.identity.createVersion(
      { ...current.profile, supportingPillars: [...current.profile.supportingPillars] },
      'No-op re-approval for test',
      'test-suite',
    );
    expect(updated.version).toBe(2);
    expect(core.identity.getActive().version).toBe(2);
    expect(core.identity.listVersions().map((v) => v.version)).toEqual([2, 1]);
    expect(core.identity.getVersion(1).approvedBy).toBe('phase-5-specification');
  });

  it('rejects an identity that would allow claiming to be human', async () => {
    core = await createTestCore();
    const current = core.identity.getActive();
    const invalid = { ...current.profile, transparency: { ...current.profile.transparency, mustNeverClaimHuman: false } };
    expect(() => core.identity.createVersion(invalid as never, 'bad', 'test')).toThrow();
    expect(core.identity.getActive().version).toBe(1);
  });

  it('versions strategy and archives the previous active version', async () => {
    core = await createTestCore();
    const v1 = core.strategy.getActive();
    const v2 = core.strategy.createVersion({
      name: 'Test v2',
      objective: v1.objective,
      content: { ...v1.content, contentMix: { ...v1.content.contentMix, original: 0.7, trend: 0.3 } },
      rationale: 'test',
      createdBy: 'test',
    });
    expect(v2.version).toBe(2);
    expect(core.strategy.getActive().content.contentMix.original).toBe(0.7);
    expect(core.strategy.list().find((s) => s.version === 1)?.status).toBe('ARCHIVED');
  });
});
