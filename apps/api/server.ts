import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { JoviCore } from '../../src/core/bootstrap.js';
import { JoviError, NotFoundError, PermissionDeniedError, ValidationError } from '../../src/core/errors.js';
import { newId } from '../../src/core/ids.js';
import { GoalRequestSchema } from '../../src/core/orchestrator/orchestrator.js';
import { PERMISSION_DESCRIPTIONS } from '../../src/core/permissions/permissions.js';
import { models as modelsTable } from '../../src/database/schema.js';
import { MemoryInputSchema } from '../../src/memory/operational/operational-memory.js';
import { assessCompetition } from '../../src/models/competition/model-competition.js';
import { EvaluableOptionSchema } from '../../src/models/evaluator/rule-checks.js';
import { EventType, MemoryType } from '../../src/types/enums.js';

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
export function buildApiServer(core: JoviCore): FastifyInstance {
  const app = Fastify({
    loggerInstance: core.logger.child({ component: 'api' }) as FastifyBaseLogger,
    bodyLimit: 256 * 1024,
  });

  // Optional bearer-token auth (everything except /health).
  const token = core.config.api.token;
  if (token) {
    const expected = Buffer.from(`Bearer ${token}`);
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health') return;
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' });
      }
    });
  }

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.code, message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.code, message: error.message });
    if (error instanceof PermissionDeniedError) return reply.code(403).send({ error: error.code, message: error.message });
    if (error instanceof JoviError) return reply.code(500).send({ error: error.code, message: error.message });
    const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(statusCode).send({ error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message: error.message });
  });

  app.get('/health', async () => {
    core.database.sqlite.prepare('SELECT 1').get();
    const statuses = await core.providers.statusesFresh();
    return {
      status: 'ok',
      service: 'jovi-core',
      version: '0.1.0',
      phase: 6,
      database: 'ok',
      providers: statuses.map((s) => ({ provider: s.provider, available: s.available, model: s.selectedModel })),
      anyModelAvailable: statuses.some((s) => s.available),
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
    const result = await core.orchestrator.executeGoal(body);
    if (body.mode === 'async') return reply.code(202).send(result);
    if (result.status === 'FAILED') {
      const code = (result.error as { code?: string } | null)?.code;
      return reply.code(code === 'NO_MODEL_AVAILABLE' ? 503 : 500).send(result);
    }
    return reply.code(200).send(result);
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

  app.post('/api/memory', async (request, reply) => {
    const body = MemoryInputSchema.parse(request.body ?? {});
    const scope = core.events.scope(newId('correlation'));
    const { item, created } = core.memory.upsert(body, scope);
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
        LOW: 'prefer local (Ollama); cloud fallback',
        NORMAL: 'prefer configured cloud; local fallback',
        HIGH: 'cloud; local only as degraded fallback',
        STRATEGIC: 'cloud + independent evaluator when available',
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
      knownPillars: identity.profile.contentCategories,
      generatorModels,
      mode: body.mode,
      decisionId,
      subjectType: decisionId ? 'decision_options' : 'adhoc_options',
      trace: { purpose: 'evaluation', correlationId, scope },
    });
    return { correlationId, evaluation };
  });

  return app;
}
