import { and, desc, eq } from 'drizzle-orm';
import type { JoviDatabase } from '../../database/client.js';
import { identityVersions, joviIdentity } from '../../database/schema.js';
import { JOVI_IDENTITY_ID } from '../../database/seed/identity.js';
import { NotFoundError } from '../errors.js';
import { newId, nowIso } from '../ids.js';
import { JoviIdentitySchema, type JoviIdentity } from './identity-schema.js';

export interface ActiveIdentity {
  id: string;
  version: number;
  profile: JoviIdentity;
  updatedAt: string;
}

/** Read access to Jovi's identity, plus versioned (never in-place) updates. */
export class IdentityService {
  constructor(private readonly db: JoviDatabase) {}

  getActive(identityId: string = JOVI_IDENTITY_ID): ActiveIdentity {
    const row = this.db.select().from(joviIdentity).where(eq(joviIdentity.id, identityId)).get();
    if (!row) throw new NotFoundError('JoviIdentity', identityId);
    return {
      id: row.id,
      version: row.activeVersion,
      profile: JoviIdentitySchema.parse(row.profile),
      updatedAt: row.updatedAt,
    };
  }

  listVersions(identityId: string = JOVI_IDENTITY_ID) {
    return this.db
      .select()
      .from(identityVersions)
      .where(eq(identityVersions.identityId, identityId))
      .orderBy(desc(identityVersions.version))
      .all();
  }

  getVersion(version: number, identityId: string = JOVI_IDENTITY_ID) {
    const row = this.db
      .select()
      .from(identityVersions)
      .where(and(eq(identityVersions.identityId, identityId), eq(identityVersions.version, version)))
      .get();
    if (!row) throw new NotFoundError('IdentityVersion', `${identityId}@${version}`);
    return row;
  }

  /**
   * Records a new identity version and activates it. Identity changes are
   * deliberate, human-approved acts — `approvedBy` is mandatory.
   */
  createVersion(profile: JoviIdentity, changeSummary: string, approvedBy: string, identityId: string = JOVI_IDENTITY_ID): ActiveIdentity {
    const valid = JoviIdentitySchema.parse(profile);
    return this.db.transaction((tx) => {
      const current = tx.select().from(joviIdentity).where(eq(joviIdentity.id, identityId)).get();
      if (!current) throw new NotFoundError('JoviIdentity', identityId);
      const version = current.activeVersion + 1;
      const now = nowIso();
      tx.insert(identityVersions)
        .values({ id: newId('identityVersion'), identityId, version, profile: valid, changeSummary, approvedBy, createdAt: now })
        .run();
      tx.update(joviIdentity)
        .set({ activeVersion: version, profile: valid, name: valid.name, creatorName: valid.creatorName, updatedAt: now })
        .where(eq(joviIdentity.id, identityId))
        .run();
      return { id: identityId, version, profile: valid, updatedAt: now };
    });
  }
}
