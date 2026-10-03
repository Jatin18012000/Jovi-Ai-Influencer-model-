import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { JoviDatabase } from '../../database/client.js';
import { apiCredentials } from '../../database/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { EventAttestation, EventBus } from '../events/event-bus.js';
import { newId, nowIso } from '../ids.js';

/**
 * API scopes (security remediation R-04). Human-only functions have their own
 * scopes so an automation credential (e.g. a future n8n integration) can run
 * work without being able to approve it or change Jovi's identity.
 *
 *   read            GET endpoints
 *   operate         goals, planning, productions, media regeneration, evaluation, external memory
 *   approve         the human approval decision
 *   identity-admin  visual identity versions
 */
export const ApiScope = z.enum(['read', 'operate', 'approve', 'identity-admin']);
export type ApiScope = z.infer<typeof ApiScope>;
export const ALL_SCOPES: readonly ApiScope[] = ApiScope.options;

/** Who performed an action. `id` is what gets recorded as reviewer / approver / requester. */
export interface Principal {
  id: string;
  kind: 'credential' | 'env' | 'local';
  name: string;
  scopes: readonly ApiScope[];
}

export const CredentialNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/i, 'name: 2-64 letters, digits, . _ - (starting with a letter or digit)');

/** Minimum length for an operator-supplied JOVI_API_TOKEN (generated tokens are 43+ chars). */
export const MIN_TOKEN_LENGTH = 32;

const TOKEN_PREFIX = 'jovi_';
const SOURCE = 'core.auth';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256 bits of randomness, URL-safe. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function parseScopes(value: string): ApiScope[] {
  const scopes = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(scopes.map((s) => ApiScope.parse(s)))];
}

/** The local OS account running the CLI. Shell access is the CLI's authentication. */
export function localPrincipal(): Principal {
  let user = 'unknown';
  try {
    user = userInfo().username || 'unknown';
  } catch {
    // userInfo can throw in unusual containers; fall back to a fixed label.
  }
  return { id: `local:${user}`, kind: 'local', name: user, scopes: ALL_SCOPES };
}

export interface CredentialSummary {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Scoped API credentials (security remediation R-01/R-04).
 *
 * Tokens are generated server-side (256-bit), shown once, and stored only as
 * SHA-256 hashes. An optional operator token from JOVI_API_TOKEN is accepted
 * as principal `env:JOVI_API_TOKEN` with JOVI_API_TOKEN_SCOPES (default
 * read,operate — it cannot approve or change identity unless granted).
 */
export class ApiCredentialService {
  private readonly envHash: Buffer | null;

  constructor(
    private readonly db: JoviDatabase,
    private readonly bus: EventBus,
    private readonly envToken: { token: string | undefined; scopes: readonly ApiScope[] },
    /** R-08: credential events are protected (attested) events. */
    private readonly attestation?: EventAttestation,
  ) {
    this.envHash = envToken.token ? Buffer.from(hashToken(envToken.token), 'hex') : null;
  }

  create(name: string, scopes: readonly ApiScope[], createdBy: string): { credential: CredentialSummary; token: string } {
    const validName = CredentialNameSchema.parse(name);
    const validScopes = z.array(ApiScope).min(1).parse([...new Set(scopes)]);
    if (this.db.select().from(apiCredentials).where(eq(apiCredentials.name, validName)).get()) {
      throw new ConflictError(`A credential named "${validName}" already exists (names are never reused, even after revocation)`);
    }
    const token = generateToken();
    const id = newId('credential');
    this.db.insert(apiCredentials).values({ id, name: validName, tokenHash: hashToken(token), scopes: validScopes, createdBy }).run();
    this.bus.emit({ eventType: 'API_CREDENTIAL_CREATED', source: SOURCE, entityId: id, payload: { name: validName, scopes: validScopes, createdBy }, ...this.attested() });
    return { credential: this.summary(id), token };
  }

  revoke(name: string, revokedBy: string): CredentialSummary {
    const row = this.db.select().from(apiCredentials).where(eq(apiCredentials.name, name)).get();
    if (!row) throw new NotFoundError('ApiCredential', name);
    if (row.revokedAt) throw new ConflictError(`Credential "${name}" is already revoked`);
    this.db.update(apiCredentials).set({ revokedAt: nowIso(), revokedBy }).where(eq(apiCredentials.id, row.id)).run();
    this.bus.emit({ eventType: 'API_CREDENTIAL_REVOKED', source: SOURCE, entityId: row.id, payload: { name, revokedBy }, ...this.attested() });
    return this.summary(row.id);
  }

  private attested() {
    return this.attestation ? { attestation: this.attestation } : {};
  }

  list(): CredentialSummary[] {
    return this.db
      .select()
      .from(apiCredentials)
      .orderBy(asc(apiCredentials.createdAt))
      .all()
      .map((r) => this.toSummary(r));
  }

  /** True when at least one way to authenticate exists. */
  hasUsableCredential(): boolean {
    if (this.envHash) return true;
    return this.db.select().from(apiCredentials).where(isNull(apiCredentials.revokedAt)).get() !== undefined;
  }

  /** Resolves a presented bearer token to a principal, or null. Never throws on bad input. */
  verify(token: string): Principal | null {
    if (!token || token.length > 512) return null;
    const hash = hashToken(token);
    if (this.envHash && timingSafeEqual(Buffer.from(hash, 'hex'), this.envHash)) {
      return { id: 'env:JOVI_API_TOKEN', kind: 'env', name: 'JOVI_API_TOKEN', scopes: this.envToken.scopes };
    }
    const row = this.db
      .select()
      .from(apiCredentials)
      .where(and(eq(apiCredentials.tokenHash, hash), isNull(apiCredentials.revokedAt)))
      .get();
    if (!row) return null;
    this.db.update(apiCredentials).set({ lastUsedAt: nowIso() }).where(eq(apiCredentials.id, row.id)).run();
    return { id: `api:${row.name}`, kind: 'credential', name: row.name, scopes: z.array(ApiScope).parse(row.scopes) };
  }

  private summary(id: string): CredentialSummary {
    const row = this.db.select().from(apiCredentials).where(eq(apiCredentials.id, id)).get();
    if (!row) throw new NotFoundError('ApiCredential', id);
    return this.toSummary(row);
  }

  private toSummary(row: typeof apiCredentials.$inferSelect): CredentialSummary {
    return {
      id: row.id,
      name: row.name,
      scopes: z.array(ApiScope).parse(row.scopes),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }
}

/** Validates an operator-supplied JOVI_API_TOKEN. */
export function assertStrongToken(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ValidationError(`JOVI_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (use \`npm run jovi -- --api-token create\` to generate one)`);
  }
}
