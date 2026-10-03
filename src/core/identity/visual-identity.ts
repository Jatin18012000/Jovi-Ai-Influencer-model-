import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JoviDatabase } from '../../database/client.js';
import { visualIdentityVersions } from '../../database/schema.js';
import { findAppearanceViolations } from '../../agents/production/identity-guard.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { EventAttestation, EventBus } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

/**
 * Jovi's visual identity. Fields that have not been approved by a human stay
 * `null` — creative agents must never invent them, and QA reports identity
 * checks against unlocked fields as NOT_VERIFIABLE (which blocks approval).
 */
export const VisualIdentitySchema = z.object({
  /** Always-true constraints (from the locked Phase 5 identity). */
  apparentAge: z.number().int().min(21),
  isVirtualCharacter: z.literal(true),
  mustNotResembleRealPeople: z.literal(true),
  aesthetic: z.string().min(1),
  /** Human-approved appearance anchors; null = not locked yet. */
  face: z.string().nullable(),
  hair: z.string().nullable(),
  eyes: z.string().nullable(),
  skin: z.string().nullable(),
  beautyMark: z.string().nullable(),
  body: z.string().nullable(),
  signatureStyle: z.string().nullable(),
  /** Paths/URLs of approved reference sheets (for image-conditioned providers). */
  referenceImages: z.array(z.string()).default([]),
  platformSafety: z.string().min(1),
});
export type VisualIdentity = z.infer<typeof VisualIdentitySchema>;

/** Appearance fields that must be locked before identity QA can pass. */
export const LOCKABLE_FIELDS = ['face', 'hair', 'eyes', 'skin', 'beautyMark', 'body', 'signatureStyle'] as const;
export type LockableField = (typeof LOCKABLE_FIELDS)[number];

export const INITIAL_VISUAL_IDENTITY: VisualIdentity = {
  apparentAge: 25,
  isVirtualCharacter: true,
  mustNotResembleRealPeople: true,
  aesthetic: 'Global lifestyle virtual creator; polished but lived-in; luxury when she wants it, normal life when she wants it.',
  face: null,
  hair: null,
  eyes: null,
  skin: null,
  beautyMark: null,
  body: null,
  signatureStyle: null,
  referenceImages: [],
  platformSafety: 'Tasteful and platform-safe; sensual confidence through attitude, styling and composition — never explicit.',
};

export interface ActiveVisualIdentity {
  version: number;
  status: 'NOT_LOCKED' | 'LOCKED';
  profile: VisualIdentity;
  unlockedFields: LockableField[];
}

/**
 * Read access for agents (via the `identity.read` tool) and versioned,
 * human-approved updates. There is deliberately no agent tool that writes it.
 */
export const VisualIdentityVersionInputSchema = z.object({
  profile: VisualIdentitySchema,
  approvedBy: z.string().trim().min(2).max(100),
  changeSummary: z.string().trim().min(3).max(1000),
});
export type VisualIdentityVersionInput = z.input<typeof VisualIdentityVersionInputSchema>;

export class VisualIdentityService {
  private readonly bus: EventBus | undefined;
  /** Re-audit N-10: runtime-private capability for the attested version event. */
  readonly #attestation: EventAttestation | undefined;

  constructor(
    private readonly db: JoviDatabase,
    private readonly identityId = 'jovi',
    /** Validates reference image paths (must be real files in the reference/media directories). */
    private readonly referenceCheck: (path: string) => boolean = () => true,
    /** R-08: the version event is a protected (attested) audit event emitted here, not by callers. */
    audit?: { bus: EventBus; attestation: EventAttestation },
    /** R-19 (D-19): the core identity's age (and names), so the visual identity cannot drift from it. */
    private readonly identityFacts?: () => { age: number; names: string[] },
    /** Re-audit R2-02: independent model review of human-entered anchors (fail-closed). */
    private readonly reviewer?: (anchors: string[]) => Promise<{ allow: boolean; reasons: string[] }>,
  ) {
    this.bus = audit?.bus;
    this.#attestation = audit?.attestation;
  }

  /**
   * The entry point for humans (API and CLI). Runs the heuristic checks and
   * the independent model review of the anchors before recording the version.
   */
  async createReviewedVersion(profile: VisualIdentity, approvedBy: string, changeSummary: string): Promise<ActiveVisualIdentity> {
    const valid = VisualIdentitySchema.parse(profile);
    this.assertAppearance(valid);
    if (!this.reviewer) throw new ValidationError('visual identity review is not configured; refusing an unreviewed identity change');
    const review = await this.reviewer(this.anchorTexts(valid));
    if (!review.allow) throw new ValidationError(`visual identity rejected by the independent review: ${review.reasons.join('; ').slice(0, 600)}`);
    return this.createVersion(valid, approvedBy, changeSummary);
  }

  private anchorTexts(valid: VisualIdentity): string[] {
    return [valid.aesthetic, valid.platformSafety, ...LOCKABLE_FIELDS.map((f) => valid[f] ?? '')].filter((t) => t.trim());
  }

  private assertAppearance(valid: VisualIdentity): void {
    const facts = this.identityFacts?.();
    // R-11 / R2-02: human-entered anchors get the same likeness / minor / explicit checks as generated text.
    const violations = findAppearanceViolations(this.anchorTexts(valid), facts?.names ?? []);
    if (violations.length) {
      throw new ValidationError(`visual identity rejected: ${violations.map((v) => `${v.rule} ("${v.match}")`).join('; ')}. Jovi is an original adult virtual character who must not resemble a real person.`);
    }
    if (facts && valid.apparentAge !== facts.age) {
      throw new ValidationError(`apparentAge ${valid.apparentAge} contradicts the active identity (age ${facts.age}); the core identity is immutable`);
    }
  }

  listVersions(): Array<{ version: number; status: 'NOT_LOCKED' | 'LOCKED'; isActive: boolean; approvedBy: string; changeSummary: string; createdAt: string }> {
    return this.db
      .select()
      .from(visualIdentityVersions)
      .where(eq(visualIdentityVersions.identityId, this.identityId))
      .orderBy(desc(visualIdentityVersions.version))
      .all()
      .map((r) => ({ version: r.version, status: r.status, isActive: r.isActive, approvedBy: r.approvedBy, changeSummary: r.changeSummary, createdAt: r.createdAt }));
  }

  getActive(): ActiveVisualIdentity {
    const row = this.db
      .select()
      .from(visualIdentityVersions)
      .where(and(eq(visualIdentityVersions.identityId, this.identityId), eq(visualIdentityVersions.isActive, true)))
      .get();
    if (!row) throw new NotFoundError('VisualIdentity', this.identityId);
    const profile = VisualIdentitySchema.parse(row.profile);
    return { version: row.version, status: row.status, profile, unlockedFields: LOCKABLE_FIELDS.filter((f) => profile[f] === null) };
  }

  /** Seeds v1 if absent. Idempotent. */
  seed(): boolean {
    const existing = this.db.select().from(visualIdentityVersions).where(eq(visualIdentityVersions.identityId, this.identityId)).get();
    if (existing) return false;
    this.db
      .insert(visualIdentityVersions)
      .values({
        id: newId('visualIdentityVersion'),
        identityId: this.identityId,
        version: 1,
        status: 'NOT_LOCKED',
        isActive: true,
        // D-19: apparent age comes from the core identity when it is available.
        profile: { ...INITIAL_VISUAL_IDENTITY, apparentAge: this.identityFacts?.().age ?? INITIAL_VISUAL_IDENTITY.apparentAge },
        approvedBy: 'phase-5-specification',
        changeSummary: 'Initial constraints; appearance anchors not yet locked (visual bible: to be locked in the visual phase).',
        createdAt: nowIso(),
      })
      .run();
    return true;
  }

  /** Human-only: records a new approved version. LOCKED requires every appearance anchor. */
  createVersion(profile: VisualIdentity, approvedBy: string, changeSummary: string): ActiveVisualIdentity {
    if (!approvedBy.trim()) throw new ValidationError('approvedBy is required for visual identity changes');
    const valid = VisualIdentitySchema.parse(profile);
    this.assertAppearance(valid);
    const badReferences = valid.referenceImages.filter((path) => !this.referenceCheck(path));
    if (badReferences.length) {
      throw new ValidationError(`reference images must be existing files inside the reference or media directory: ${badReferences.join(', ')}`);
    }
    const status = LOCKABLE_FIELDS.every((f) => valid[f] !== null && valid[f]!.trim() !== '') ? 'LOCKED' : 'NOT_LOCKED';
    this.db.transaction((tx) => {
      const latest = tx
        .select()
        .from(visualIdentityVersions)
        .where(eq(visualIdentityVersions.identityId, this.identityId))
        .orderBy(desc(visualIdentityVersions.version))
        .get();
      tx.update(visualIdentityVersions).set({ isActive: false }).where(eq(visualIdentityVersions.identityId, this.identityId)).run();
      tx.insert(visualIdentityVersions)
        .values({
          id: newId('visualIdentityVersion'),
          identityId: this.identityId,
          version: (latest?.version ?? 0) + 1,
          status,
          isActive: true,
          profile: valid,
          approvedBy,
          changeSummary,
          createdAt: nowIso(),
        })
        .run();
    });
    const active = this.getActive();
    this.bus?.emit({
      eventType: 'VISUAL_IDENTITY_VERSION_CREATED',
      source: 'identity.visual',
      entityId: this.identityId,
      payload: { version: active.version, status: active.status, approvedBy, changeSummary },
      correlationId: newId('correlation'),
      ...(this.#attestation ? { attestation: this.#attestation } : {}),
    });
    return active;
  }
}

/** Canonical character block injected into every visual prompt (never model-authored). */
export function renderCharacterLock(visual: ActiveVisualIdentity, creatorName: string): string {
  const p = visual.profile;
  const anchors = LOCKABLE_FIELDS.map((f) => (p[f] ? `${f}: ${p[f]}` : null)).filter(Boolean);
  return [
    `${creatorName}, an original fictional virtual character (apparent age ${p.apparentAge}); not a real person and not resembling any real person.`,
    anchors.length ? `Locked appearance (visual identity v${visual.version}): ${anchors.join('; ')}.` : `Appearance anchors not yet locked (visual identity v${visual.version}): keep ${creatorName}'s look consistent with the approved reference sheet once locked.`,
    `Aesthetic: ${p.aesthetic}`,
  ].join(' ');
}
