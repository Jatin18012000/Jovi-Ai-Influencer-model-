import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { ConflictError, JoviError, NotFoundError, PermissionDeniedError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { GoalRequestSchema } from '../../src/core/orchestrator/orchestrator.js';
import { PERMISSION_DESCRIPTIONS } from '../../src/core/permissions/permissions.js';
import { models as modelsTable } from '../../src/database/schema.js';
import { ExternalMemoryInputSchema } from '../../src/memory/operational/operational-memory.js';
import { assessCompetition } from '../../src/models/competition/model-competition.js';
import { EvaluableOptionSchema } from '../../src/models/evaluator/rule-checks.js';
import { EventType, MemoryType } from '../../src/types/enums.js';
import { AuthFailureRecorder, checkHostAndOrigin, ExpensiveCallLimiter, WriteRateLimiter } from './security.js';
import type { ApiScope, Principal } from '../../src/core/auth/api-credentials.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook for every non-public route. */
    principal?: Principal;
  }
  interface FastifyContextConfig {
    /** Scope required by the route (default: read for GET, operate otherwise). */
    scope?: ApiScope;
  }
}
import { ProductionRequestSchema } from '../../src/agents/production/production-pipeline.js';
import { HumanDecisionSchema, MediaRegenerationSchema, type ArtifactKind } from '../../src/core/production/production-service.js';
import { VisualIdentityVersionInputSchema } from '../../src/core/identity/visual-identity.js';

const IdParams = z.object({ id: z.string().min(1).max(100) });

const EventsQuery = z.object({
  type: EventType.optional(),
  correlationId: z.string().optional(),
  entityId: z.string().optional(),
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const MemoryQuery = z.object({
  type: MemoryType.optional(),
  key: z.string().optional(),
  q: z.string().max(500).optional(),
  includeExpired: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const PlanningBody = z.object({
  goal: z.string().trim().min(5).max(2000),
  topic: z.string().trim().max(500).optional(),
  constraints: z.array(z.string().max(300)).max(10).optional(),
});

const EvaluateBody = z.union([
  z.object({ decisionId: z.string().min(1), mode: z.enum(['AUTO', 'RULES_ONLY']).default('AUTO') }),
  z.object({
    objective: z.string().min(3).max(1000),
    options: z.array(EvaluableOptionSchema).min(1).max(8),
    mode: z.enum(['AUTO', 'RULES_ONLY']).default('AUTO'),
  }),
]);

/**
 * Fastify API. Handlers are thin: validate with Zod, delegate to the core,
 * shape the response. All business logic lives in `src/`.
 */
export function buildApiServer(core: JoviCore, options: { limiter?: ExpensiveCallLimiter; writeLimiter?: WriteRateLimiter } = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: core.logger.child({ component: 'api' }) as FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    // R-05: a client gets this long to send the whole request (slow-client defence).
    // It does not limit how long a handler may run.
    requestTimeout: core.config.api.requestTimeoutMs,
  });
  const limiter = options.limiter ?? new ExpensiveCallLimiter(core.config.api.goalRateLimitPerMinute, core.config.api.maxConcurrentGoals);
  const writeLimiter = options.writeLimiter ?? new WriteRateLimiter(core.config.api.writeRateLimitPerMinute);
  /**
   * Runs an expensive (model-calling) handler under the rate limit and
   * concurrency cap. Unfinished async jobs keep holding their slot (R-05).
   */
  const guarded = async <T>(clientKey: string, fn: () => Promise<T>): Promise<T> => {
    core.jobs.assertCapacity();
    const release = limiter.acquire(clientKey, core.jobs.countPendingAsync());
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const { allowedHosts, allowedOrigins } = core.config.api;
  const PUBLIC_ROUTES = new Set(['/health']);
  // R-08: auth failures become (throttled) audit events, not only log lines.
  const authFailures = new AuthFailureRecorder((payload) => core.events.emit({ eventType: 'API_AUTH_FAILED', source: 'api.auth', payload }));
  const refuse = (request: FastifyRequest, reason: string, extra: Record<string, unknown> = {}) =>
    authFailures.failure(request.ip, { reason, method: request.method, path: request.url.split('?')[0]?.slice(0, 200) ?? '', ...extra });

  /**
   * Security remediation R-01/R-04. Every request:
   *  1. must name an allowed Host and, if a browser sent one, an allowed Origin
   *     (DNS-rebinding / cross-site defence) — including /health;
   *  2. must carry a valid bearer credential (except /health);
   *  3. must hold the route's scope: GET → read, POST → operate, unless the
   *     route declares a stricter one (approve, identity-admin).
   * The authenticated principal — never a request field — is the actor
   * recorded for approvals, regenerations and identity changes.
   */
  app.addHook('onRequest', async (request, reply) => {
    const refusal = checkHostAndOrigin({ host: request.headers.host, origin: request.headers.origin }, allowedHosts, allowedOrigins);
    if (refusal) {
      request.log.warn({ security: 'HOST_OR_ORIGIN_REFUSED', reason: refusal, url: request.url }, 'request refused');
      refuse(request, 'HOST_OR_ORIGIN_REFUSED', { host: String(request.headers.host ?? '').slice(0, 200), origin: request.headers.origin ? String(request.headers.origin).slice(0, 200) : null });
      return reply.code(403).send({ error: 'FORBIDDEN_HOST_OR_ORIGIN', message: 'Request refused: host or origin not allowed' });
    }
    if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) return;

    const header = request.headers.authorization ?? '';
    const principal = header.startsWith('Bearer ') ? core.credentials.verify(header.slice(7).trim()) : null;
    if (!principal) {
      request.log.warn({ security: 'AUTHENTICATION_FAILED', url: request.url, reason: header ? 'invalid credential' : 'missing credential' }, 'request refused');
      refuse(request, header ? 'INVALID_CREDENTIAL' : 'MISSING_CREDENTIAL');
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' });
    }
    const required: ApiScope = request.routeOptions.config?.scope ?? (request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'operate');
    if (!principal.scopes.includes(required)) {
      request.log.warn({ security: 'AUTHORIZATION_FAILED', principal: principal.id, required, url: request.url }, 'request refused');
      refuse(request, 'MISSING_SCOPE', { principal: principal.id, required });
      return reply.code(403).send({ error: 'FORBIDDEN_SCOPE', message: `This credential lacks the "${required}" scope` });
    }
    request.principal = principal;
  });

  // Baseline security headers for a JSON API.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    return payload;
  });

  const actor = (request: FastifyRequest): string => {
    if (!request.principal) throw new PermissionDeniedError('no authenticated principal');
    return request.principal.id;
  };

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.code, message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.code, message: error.message });
    if (error instanceof PermissionDeniedError) return reply.code(403).send({ error: error.code, message: error.message });
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.code, message: error.message });
    if (error instanceof RateLimitedError) {
      return reply.code(429).header('retry-after', String(error.retryAfterSeconds)).send({ error: error.code, message: error.message });
    }
    if (error instanceof JoviError) return reply.code(500).send({ error: error.code, message: error.message });
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(statusCode).send({ error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: error.message });
  });

  /** Unauthenticated liveness only — no provider or configuration details (F-12). */
  app.get('/health', async () => {
    core.database.sqlite.prepare('SELECT 1').get();
    return { status: 'ok', service: 'jovi-core', database: 'ok' };
  });

  app.get('/api/auth/whoami', async (request) => ({ principal: request.principal?.id, scopes: request.principal?.scopes }));

  /** Detailed status (formerly part of /health); requires the read scope. */
  app.get('/api/status', async () => {
    const statuses = await core.providers.statusesFresh();
    return {
      status: 'ok',
      service: 'jovi-core',
      version: '0.1.0',
      phase: 9,
      database: 'ok',
      simulationMode: core.providers.isSimulation(),
      providers: statuses.map((s) => ({ provider: s.provider, kind: s.kind, available: s.available, model: s.selectedModel, reason: s.reason })),
      lmStudio: statuses.find((s) => s.provider === 'lmstudio')?.details ?? { registered: false },
      mediaProviders: (await core.mediaProviders.statuses()).map((m) => ({ provider: m.provider, mediaKind: m.mediaKind, kind: m.kind, available: m.available, state: m.state, reason: m.reason })),
      mediaSimulationMode: core.mediaProviders.isSimulation(),
      anyModelAvailable: statuses.some((s) => s.available),
      cloudBudget: { dailyLimitUsd: core.budget.dailyLimitUsd, spentTodayUsd: core.budget.spentTodayUsd(), exhausted: core.budget.exhaustedReason() },
      jobs: { pending: core.jobs.countPending(), pendingAsync: core.jobs.countPendingAsync(), maxQueued: core.config.jobs.maxQueued },
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  // --- Jovi -----------------------------------------------------------------

  app.get('/api/jovi/identity', async () => {
    const active = core.identity.getActive();
    const versions = core.identity.listVersions().map((v) => ({
      version: v.version,
      changeSummary: v.changeSummary,
      approvedBy: v.approvedBy,
      createdAt: v.createdAt,
    }));
    return { identity: active, versions };
  });

  app.get('/api/jovi/strategy', async () => ({ strategy: core.strategy.getActive() }));

  app.post('/api/jovi/goal', async (request, reply) => {
    const body = GoalRequestSchema.parse(request.body ?? {});
    const result = await guarded(request.ip, () => core.orchestrator.executeGoal({ ...body, createdBy: 'api' }));
    if (body.mode === 'async') return reply.code(202).send(result);
    if (result.status === 'FAILED') {
      const code = (result.error as { code?: string } | null)?.code;
      return reply.code(code === 'NO_MODEL_AVAILABLE' ? 503 : 500).send(result);
    }
    return reply.code(200).send(result);
  });

  app.post('/api/jovi/planning', async (request) => {
    const body = PlanningBody.parse(request.body ?? {});
    return guarded(request.ip, () => core.planning.execute({ ...body, createdBy: 'api' }));
  });

  // --- Phase 8: creative production (ends at the human approval boundary) ----

  app.post('/api/productions', async (request, reply) => {
    const body = ProductionRequestSchema.parse(request.body ?? {});
    const result = await guarded(request.ip, () => core.production.start({ ...body, createdBy: 'api' }));
    if (body.mode === 'async') return reply.code(202).send(result);
    if (result.status === 'FAILED') return reply.code(result.productionId ? 500 : 422).send(result);
    return reply.code(200).send(result);
  });

  app.get('/api/productions/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    return core.production.getResult(id);
  });

  const artifactRoutes: Array<[string, ArtifactKind]> = [
    ['script', 'SCRIPT'],
    ['storyboard', 'STORYBOARD'],
    ['visual-prompts', 'VISUAL_PROMPTS'],
    ['edit-plan', 'EDIT_PLAN'],
    ['qa', 'QA_REPORT'],
  ];
  for (const [path, kind] of artifactRoutes) {
    app.get(`/api/productions/:id/${path}`, async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      core.productions.get(id);
      const artifact = core.productions.latestArtifact(id, kind);
      if (!artifact) return reply.code(404).send({ error: 'NOT_FOUND', message: `${kind} not produced yet for ${id}` });
      return { productionId: id, kind, artifact };
    });
  }

  app.get('/api/productions/:id/assets', async (request) => {
    const { id } = IdParams.parse(request.params);
    core.productions.get(id);
    return { productionId: id, assets: core.assets.list(id) };
  });

  app.get('/api/productions/:id/publishing-gate', async (request) => {
    const { id } = IdParams.parse(request.params);
    return core.productions.publishingGate(id);
  });

  /**
   * Human approval boundary. Records a human reviewer's decision; it never
   * publishes (there is no publishing endpoint in Phase 8). FAIL/BLOCKED QA
   * results cannot be approved (409).
   */
  app.post('/api/productions/:id/decision', { config: { scope: 'approve' } }, async (request) => {
    const { id } = IdParams.parse(request.params);
    // The reviewer is the authenticated principal; a body-supplied reviewer is rejected.
    const body = HumanDecisionSchema.omit({ reviewer: true }).strict().parse(request.body ?? {});
    writeLimiter.hit(`decision:${actor(request)}`);
    const decision = { ...body, reviewer: actor(request) };
    const production = core.productions.get(id);
    const updated = core.productions.recordHumanDecision(id, decision, core.events.scope(production.correlationId));
    return { production: updated, publishingGate: core.productions.publishingGate(id) };
  });

  /**
   * HUMAN/operator action: regenerate media for a BLOCKED or AWAITING_HUMAN_APPROVAL
   * production (text stages are reused). Ends again at the approval boundary.
   */
  app.post('/api/productions/:id/regenerate-media', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = MediaRegenerationSchema.omit({ requestedBy: true }).extend({ mode: z.enum(['sync', 'async']).default('sync') }).strict().parse(request.body ?? {});
    const result = await guarded(request.ip, () => core.production.regenerateMedia(id, { ...body, requestedBy: actor(request) }));
    return reply.code(body.mode === 'async' ? 202 : 200).send(result);
  });

  app.get('/api/media/providers', async () => {
    const statuses = await core.mediaProviders.statuses();
    const byId = new Map(core.mediaProviders.list().map((p) => [p.id, p]));
    return {
      simulationMode: core.mediaProviders.isSimulation(),
      preference: core.config.media.providerPreference,
      providers: statuses.map((s) => ({ ...s, capabilities: byId.get(s.provider)?.capabilities() ?? null })),
    };
  });

  // --- Visual identity (read: anyone with API access; write: human approval) ---

  app.get('/api/visual-identity', async () => ({ active: core.visualIdentity.getActive(), versions: core.visualIdentity.listVersions() }));

  /**
   * HUMAN action: record a new visual identity version (e.g. lock Jovi's
   * appearance anchors and reference sheet). No agent tool can do this.
   */
  app.post('/api/visual-identity', { config: { scope: 'identity-admin' } }, async (request, reply) => {
    const body = VisualIdentityVersionInputSchema.omit({ approvedBy: true }).strict().parse(request.body ?? {});
    const approvedBy = actor(request);
    writeLimiter.hit(`visual-identity:${approvedBy}`);
    const active = core.visualIdentity.createVersion(body.profile, approvedBy, body.changeSummary);
    return reply.code(201).send({ active, versions: core.visualIdentity.listVersions() });
  });

  app.get('/api/jovi/goal/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    return core.orchestrator.getGoalResult(id);
  });

  // --- Tasks, jobs, decisions, events ---------------------------------------

  app.get('/api/tasks/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const task = core.tasks.get(id);
    return { task, jobs: core.jobs.listByTask(id) };
  });

  app.get('/api/jobs/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    return { job: core.jobs.get(id) };
  });

  app.get('/api/decisions/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    return { decision: core.decisions.get(id) };
  });

  /**
   * R-08: verifies the whole event hash chain and returns its head (sequence +
   * hash) so it can be recorded outside this machine. O(events): approve scope.
   */
  app.get('/api/audit/verify', { config: { scope: 'approve' } }, async () => ({ chain: core.events.verifyChain() }));

  app.get('/api/events', async (request) => {
    const q = EventsQuery.parse(request.query);
    const events = core.events.list({
      limit: q.limit,
      ...(q.type ? { eventType: q.type } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.afterSequence !== undefined ? { afterSequence: q.afterSequence } : {}),
    });
    return { count: events.length, events };
  });

  // --- Memory ---------------------------------------------------------------

  // External memory is untrusted: restricted types, forced source "api", capped
  // importance, and it can never overwrite seed/agent memory (see writeExternal).
  app.post('/api/memory', async (request, reply) => {
    const body = ExternalMemoryInputSchema.parse(request.body ?? {});
    writeLimiter.hit(`memory:${actor(request)}`);
    const scope = core.events.scope(newId('correlation'));
    const { item, created } = core.memory.writeExternal(body, scope);
    return reply.code(created ? 201 : 200).send({ item, created });
  });

  app.get('/api/memory', async (request) => {
    const q = MemoryQuery.parse(request.query);
    const base = {
      limit: q.limit,
      includeExpired: q.includeExpired === 'true',
      ...(q.type ? { type: q.type } : {}),
      ...(q.key ? { key: q.key } : {}),
    };
    const items = q.q ? core.memory.search(q.q, base) : core.memory.list(base);
    return { count: items.length, items };
  });

  // --- Models & agents ------------------------------------------------------

  app.get('/api/models', async (request) => {
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh === 'true';
    const statuses = await core.providers.statusesFresh(refresh);
    const models = core.database.db.select().from(modelsTable).all();
    return {
      providers: statuses,
      models,
      competition: assessCompetition(statuses),
      routingPolicy: {
        LOW: `LM Studio (local)${core.config.providers.allowCloudFallback ? '; cloud fallback' : '; cloud fallback disabled'}`,
        NORMAL: 'prefer configured cloud; LM Studio fallback',
        HIGH: 'cloud; LM Studio only as degraded fallback',
        STRATEGIC: 'cloud + independent evaluator when available',
        LOCAL_ONLY: 'LM Studio only',
        mock: 'simulation mode only; never a fallback',
        cloudPreference: core.config.providers.cloudPreference,
      },
    };
  });

  app.get('/api/agents', async () => ({
    agents: core.agents.list().map(({ definition, status }) => ({ status, ...definition })),
    permissionCeiling: core.config.permissions.maxLevel,
    permissionLevels: PERMISSION_DESCRIPTIONS,
  }));

  // --- Evaluation -----------------------------------------------------------

  app.post('/api/evaluate', async (request) => {
    const body = EvaluateBody.parse(request.body ?? {});
    return guarded(request.ip, () => evaluate(body));
  });

  const evaluate = async (body: z.infer<typeof EvaluateBody>) => {
    const correlationId = newId('correlation');
    const scope = core.events.scope(correlationId);
    const identity = core.identity.getActive();

    let objective: string;
    let options: z.infer<typeof EvaluableOptionSchema>[];
    let generatorModels: string[] = [];
    let decisionId: string | null = null;
    if ('decisionId' in body) {
      const decision = core.decisions.get(body.decisionId);
      objective = decision.objective;
      options = z.array(EvaluableOptionSchema).parse(decision.options);
      generatorModels = z
        .array(z.object({ purpose: z.string(), provider: z.string(), model: z.string() }).loose())
        .parse(decision.modelsUsed)
        .filter((m) => m.purpose !== 'evaluation')
        .map((m) => `${m.provider}:${m.model}`);
      decisionId = decision.id;
    } else {
      objective = body.objective;
      options = body.options;
    }

    const evaluation = await core.evaluator.evaluate({
      objective,
      options,
      identity: identity.profile,
      generatorModels,
      mode: body.mode,
      decisionId,
      subjectType: decisionId ? 'decision_options' : 'adhoc_options',
      trace: { purpose: 'evaluation', correlationId, scope },
    });
    return { correlationId, evaluation };
  };

  return app;
}
