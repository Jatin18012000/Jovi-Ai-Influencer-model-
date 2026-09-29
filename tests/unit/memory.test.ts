import { afterEach, describe, expect, it } from 'vitest';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { fromRoot } from '../../src/core/config/paths.js';
import { KnowledgeBase } from '../../src/memory/knowledge/knowledge-base.js';
import { KeywordSemanticMemory } from '../../src/memory/semantic/semantic-memory.js';
import { createTestCore } from '../helpers.js';

describe('Operational memory', () => {
  let core: JoviCore;
  afterEach(async () => core?.close());

  it('creates a memory item and emits MEMORY_CREATED', async () => {
    core = await createTestCore();
    const { item, created } = core.memory.upsert({
      type: 'LEARNING',
      key: 'learning.hooks',
      value: { insight: 'Direct-to-camera hooks outperform scenic openers' },
      importance: 0.7,
      confidence: 0.6,
      source: 'test',
      tags: ['hooks', 'reels'],
    });
    expect(created).toBe(true);
    expect(item.id).toMatch(/^mem_/);
    expect(item.type).toBe('LEARNING');
    expect(item.createdAt).toBeTruthy();
    expect(item.expiresAt).toBeNull();
    expect(core.memory.get(item.id).value).toEqual({ insight: 'Direct-to-camera hooks outperform scenic openers' });

    const events = core.events.list({ eventType: 'MEMORY_CREATED', entityId: item.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ type: 'LEARNING', key: 'learning.hooks' });
  });

  it('updates an existing (type, key) instead of duplicating, emitting MEMORY_UPDATED', async () => {
    core = await createTestCore();
    const first = core.memory.upsert({ type: 'FACT', key: 'fact.x', value: 1, source: 'test' });
    const second = core.memory.upsert({ type: 'FACT', key: 'fact.x', value: 2, importance: 0.9, source: 'test' });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.value).toBe(2);
    expect(core.memory.list({ type: 'FACT', key: 'fact.x' })).toHaveLength(1);
    expect(core.events.list({ eventType: 'MEMORY_UPDATED', entityId: first.item.id })).toHaveLength(1);
  });

  it('retrieves by type and ranks by relevance', async () => {
    core = await createTestCore();
    const prefs = core.memory.list({ type: 'PREFERENCE' });
    expect(prefs.length).toBeGreaterThan(3);
    expect(prefs.every((m) => m.type === 'PREFERENCE')).toBe(true);

    const results = core.memory.search('Reel about a modified G-Wagen at a car event', { limit: 3 });
    expect(results.map((r) => r.key)).toContain('lifestyle.cars');
    expect(results[0]!.relevance).toBeGreaterThan(0);
  });

  it('excludes expired items by default and purges them', async () => {
    core = await createTestCore();
    core.memory.upsert({ type: 'TEMPORARY', key: 'tmp.old', value: 'x', source: 'test', expiresAt: new Date(Date.now() - 1000).toISOString() });
    core.memory.upsert({ type: 'TEMPORARY', key: 'tmp.new', value: 'y', source: 'test', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(core.memory.list({ type: 'TEMPORARY' }).map((m) => m.key)).toEqual(['tmp.new']);
    expect(core.memory.list({ type: 'TEMPORARY', includeExpired: true })).toHaveLength(2);
    expect(core.memory.purgeExpired()).toBe(1);
  });

  it('validates memory input', async () => {
    core = await createTestCore();
    expect(() => core.memory.upsert({ type: 'NOT_A_TYPE' as never, key: 'k', value: 1, source: 's' })).toThrow();
    expect(() => core.memory.upsert({ type: 'FACT', key: 'k', value: 1, importance: 2, source: 's' })).toThrow();
  });

  it('seeds lifestyle knowledge and creator habits', async () => {
    core = await createTestCore();
    expect(core.memory.findByKey('PREFERENCE', 'lifestyle.cars')?.value).toMatchObject({
      favourite: 'G-Wagens, especially modified G-Wagens / Brabus',
    });
    expect(core.memory.findByKey('FACT', 'habit.city-exploring')).toBeDefined();
    expect(core.memory.findByKey('AUDIENCE', 'audience.relationship')).toBeDefined();
  });
});

describe('Knowledge base', () => {
  it('loads the Jovi Markdown documents and finds relevant sections', () => {
    const kb = new KnowledgeBase(fromRoot('knowledge', 'jovi'));
    expect(kb.listDocuments().sort()).toEqual(['character-bible', 'content-strategy', 'privacy-boundaries', 'visual-bible', 'voice-guide']);
    const matches = kb.search('Reel introduction for a new audience', 3);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.document === 'content-strategy')).toBe(true);
    expect(matches[0]!.excerpt.length).toBeLessThanOrEqual(700);
  });
});

describe('Semantic memory (lexical baseline)', () => {
  it('indexes and searches, and is labeled as non-vector', async () => {
    const semantic = new KeywordSemanticMemory();
    expect(semantic.isVectorBacked).toBe(false);
    await semantic.index({ id: 'a', text: 'Two truths and a glitch — Jovi introduces herself' });
    await semantic.index({ id: 'b', text: 'Five London coffees rated' });
    const results = await semantic.search('London coffee guide');
    expect(results[0]?.id).toBe('b');
    await semantic.remove('b');
    expect(await semantic.search('London coffee guide')).toHaveLength(0);
  });
});
