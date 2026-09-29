import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JoviDatabase } from '../../database/client.js';
import { visualIdentityVersions } from '../../database/schema.js';
import { NotFoundError, ValidationError } from '../errors.js';
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
export class VisualIdentityService {
  constructor(
    private readonly db: JoviDatabase,
    private readonly identityId = 'jovi',
  ) {}

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
        profile: INITIAL_VISUAL_IDENTITY,
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
    return this.getActive();
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
