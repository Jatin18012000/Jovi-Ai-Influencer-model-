import { AgentRegistry } from '../agents/agent-registry.js';
import { AgentRunner } from '../agents/agent-runner.js';
import type { ToolServices } from '../agents/toolkit.js';
import { ExecutiveAgent } from '../agents/executive/executive-agent.js';
import { CreatorPlanningPipeline, IdeationAgent, ResearchAgent, StrategyAgent, TrendsAgent } from '../agents/planning/planning-agents.js';
import { PLANNED_AGENTS } from '../agents/planned-agents.js';
import { CreativeProductionPipeline } from '../agents/production/production-pipeline.js';
import { MediaInspector } from '../media/media-inspector.js';
import { ApiCredentialService } from './auth/api-credentials.js';
import { CloudBudget } from './budget/cloud-budget.js';
import { MediaProviderRegistry } from '../media/media-provider-registry.js';
import { MediaStore } from '../media/media-store.js';
import { setExecutablePins, setProcessAuditSink } from '../media/process-runner.js';
import { createMediaProvidersFromConfig } from '../media/providers/index.js';
import type { AnyMediaProvider } from '../media/types.js';
import { VisualIdentityService } from './identity/visual-identity.js';
import { AssetService } from './production/asset-service.js';
import { MediaService } from './production/media-service.js';
import { ProductionService } from './production/production-service.js';
import { openDatabase, runMigrations, type DatabaseHandle } from '../database/client.js';
import { seedDatabase, type SeedReport } from '../database/seed.js';
import { KnowledgeBase } from '../memory/knowledge/knowledge-base.js';
import { OperationalMemory } from '../memory/operational/operational-memory.js';
import { KeywordSemanticMemory, type SemanticMemory } from '../memory/semantic/semantic-memory.js';
import { Evaluator } from '../models/evaluator/evaluator.js';
import { createProvidersFromConfig } from '../models/providers/index.js';
import { ProviderRegistry } from '../models/providers/provider-registry.js';
import { ModelRouter } from '../models/router/model-router.js';
import type { ModelProvider } from '../models/types.js';
import { loadConfig, type JoviConfig } from './config/config.js';
import { createLogger, type Logger } from './config/logger.js';
import { fromRoot } from './config/paths.js';
import { DecisionService } from './decisions/decision-service.js';
import { EventBus } from './events/event-bus.js';
import { IdentityService } from './identity/identity-service.js';
import { newId } from './ids.js';
import { JobQueue } from './jobs/job-queue.js';
import { JobWorker } from './jobs/job-worker.js';
import { TaskService } from './jobs/task-service.js';
import { ContextEngine } from './orchestrator/context-engine.js';
import { JoviOrchestrator } from './orchestrator/orchestrator.js';
import { PromptLibrary } from './prompts/prompt-library.js';
import { RetentionService } from './retention/retention-service.js';
import { StrategyService } from './strategy/strategy-service.js';

export interface CreateCoreOptions {
  config?: JoviConfig;
  /** Replaces the configured providers entirely (tests, custom deployments). */
  providers?: ModelProvider[];
  /** Replaces the configured media providers entirely (tests, custom deployments). */
  mediaProviders?: AnyMediaProvider[];
  logger?: Logger;
  /** Override for job retry sleeping (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface JoviCore {
  config: JoviConfig;
  logger: Logger;
  database: DatabaseHandle;
  seedReport: SeedReport | null;
  jobRecovery: { requeued: number; failed: number; released: number };
  events: EventBus;
  credentials: ApiCredentialService;
  /** R-05: daily cloud spend cap. */
  budget: CloudBudget;
  /** R-18: retention and backups. */
  retention: RetentionService;
  tasks: TaskService;
  jobs: JobQueue;
  worker: JobWorker;
  identity: IdentityService;
  strategy: StrategyService;
  decisions: DecisionService;
  memory: OperationalMemory;
  knowledge: KnowledgeBase;
  semantic: SemanticMemory;
  prompts: PromptLibrary;
  providers: ProviderRegistry;
  router: ModelRouter;
  evaluator: Evaluator;
  contextEngine: ContextEngine;
  visualIdentity: VisualIdentityService;
  mediaStore: MediaStore;
  mediaProviders: MediaProviderRegistry;
  assets: AssetService;
  media: MediaService;
  productions: ProductionService;
  production: CreativeProductionPipeline;
  agents: AgentRegistry;
  runner: AgentRunner;
  executive: ExecutiveAgent;
  orchestrator: JoviOrchestrator;
  planning: CreatorPlanningPipeline;
  close(): Promise<void>;
}

/**
 * Composition root. The API server, CLI, worker and tests all build the core
 * through this function, so there is exactly one wiring of the system.
 */
export async function createJoviCore(options: CreateCoreOptions = {}): Promise<JoviCore> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.logLevel);

  const database = openDatabase(config.database.url);
  runMigrations(database);
  const seedReport = config.database.autoSeed ? seedDatabase(database) : null;
  const { db, sqlite } = database;

  const events = new EventBus(sqlite, logger.child({ component: 'events' }));
  // R-08: the capability to emit protected (attesting) events goes only to the services that own them.
  const attestation = events.issueAttestation();
  const credentials = new ApiCredentialService(db, events, { token: config.api.token, previousToken: config.api.previousToken, scopes: config.api.tokenScopes }, attestation);
  // R-08: every external process execution is logged (binary, redacted arguments, duration, exit code).
  const processLogger = logger.child({ component: 'process' });
  setProcessAuditSink((record) => processLogger.info({ audit: 'PROCESS_EXECUTED', ...record }, 'external process executed'));
  // R-17: optional hash pins for operator-configured executables.
  setExecutablePins({
    ...(config.media.ffmpegPath ? { [config.media.ffmpegPath]: config.media.pins.ffmpeg } : {}),
    ...(config.media.ffprobePath ? { [config.media.ffprobePath]: config.media.pins.ffprobe } : {}),
    [config.media.sayPath]: config.media.pins.say,
  });
  // R-05: daily cloud spend cap shared by the model router and the media service.
  const budget = new CloudBudget(sqlite, config.budget.dailyCloudUsd);
  const tasks = new TaskService(db);
  const jobs = new JobQueue(db, sqlite, events, logger.child({ component: 'jobs' }), {
    defaultMaxAttempts: config.jobs.maxAttempts,
    backoffMs: config.jobs.backoffMs,
    heartbeatMs: config.jobs.heartbeatMs,
    maxQueued: config.jobs.maxQueued,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  // R-05: the worker also garbage-collects files of superseded media once a day.
  // R-05/R-18: the worker garbage-collects superseded media and applies data retention once a day.
  const retention = new RetentionService(sqlite, events, config.retention);
  const worker = new JobWorker(jobs, logger.child({ component: 'worker' }), config.jobs.workerPollMs, config.jobs.staleMs, () => {
    const gc = media.collectSuperseded({ olderThanDays: config.media.supersededRetentionDays }, events.scope(newId('correlation')));
    if (gc.assets) logger.info({ ...gc }, 'superseded media collected');
    const kept = retention.apply();
    if (kept.events.pruned || kept.agentRuns || kept.modelRuns) logger.info({ ...kept }, 'retention applied');
  });

  const identity = new IdentityService(db);
  const strategy = new StrategyService(db);
  const decisions = new DecisionService(db);
  const memory = new OperationalMemory(db, events, config.memory.maxExternalItems);
  const knowledge = new KnowledgeBase(fromRoot('knowledge', 'jovi'));
  const semantic = new KeywordSemanticMemory();
  const prompts = new PromptLibrary(fromRoot('prompts'));

  const providers = new ProviderRegistry(db, logger.child({ component: 'providers' }), config.providers.statusTtlMs);
  for (const provider of options.providers ?? createProvidersFromConfig(config)) providers.register(provider);

  const router = new ModelRouter(providers, db, logger.child({ component: 'router' }), prompts, {
    cloudPreference: config.providers.cloudPreference,
    allowCloudFallback: config.providers.allowCloudFallback,
    budget,
  });
  const evaluator = new Evaluator(router, prompts, db, logger.child({ component: 'evaluator' }));
  const contextEngine = new ContextEngine({ identity, strategy, memory, knowledge, semantic, decisions, providers });

  // Phase 8: visual identity, media providers, assets and productions.
  // Phase 9: capability-based provider selection with fallback and verified outputs.
  const mediaStore = new MediaStore(config.media.dir, config.media.referenceDir);
  const visualIdentity = new VisualIdentityService(db, 'jovi', (path) => mediaStore.isReadableInput(path), { bus: events, attestation }, () => identity.getActive().profile.age);
  if (config.database.autoSeed) visualIdentity.seed();
  const mediaProviders = new MediaProviderRegistry(config.media.providerPreference);
  for (const provider of options.mediaProviders ?? createMediaProvidersFromConfig(config, mediaStore)) mediaProviders.register(provider);
  const assets = new AssetService(db);
  const mediaInspector = new MediaInspector({ ffprobePath: config.media.ffprobePath });
  const productions = new ProductionService(db, assets, { bus: events, attestation }, config.media.maxRegenerations);
  const media = new MediaService(
    mediaProviders,
    assets,
    mediaStore,
    mediaInspector,
    logger.child({ component: 'media' }),
    config.media.maxAttempts,
    (id) => productions.safetyClearance(id),
    { quotaBytes: config.media.quotaBytes, budget },
  );

  // Agents receive no services: only the runner holds them, behind the ToolKit.
  const executive = new ExecutiveAgent(prompts);
  const agents = new AgentRegistry();
  agents.register(executive);
  for (const def of PLANNED_AGENTS) agents.registerPlanned(def);
  agents.syncToDatabase(db);

  const toolServices: ToolServices = {
    identity,
    strategy,
    memory,
    knowledge,
    semantic,
    decisions,
    router,
    evaluator,
    contextEngine,
    visualIdentity,
    assets,
    production: productions,
    media,
    agentDirectory: () => agents.list().map(({ definition, status }) => ({ name: definition.name, permissionLevel: definition.permissionLevel, status })),
  };
  const runner = new AgentRunner(db, logger.child({ component: 'agents' }), config.permissions.maxLevel, toolServices);
  const orchestrator = new JoviOrchestrator({ tasks, jobs, events, runner, executive, logger: logger.child({ component: 'orchestrator' }) });
  const planningAgents = [new ResearchAgent(), new TrendsAgent(), new StrategyAgent(), new IdeationAgent()];
  for (const agent of planningAgents) agents.register(agent);
  agents.syncToDatabase(db);
  const planning = new CreatorPlanningPipeline({ tasks, events, runner });
  const production = new CreativeProductionPipeline({
    tasks,
    jobs,
    events,
    runner,
    productions,
    assets,
    media,
    identity,
    visualIdentity,
    strategy,
    planning,
    prompts,
    isSimulation: () => providers.isSimulation() || mediaProviders.isSimulation(),
    logger: logger.child({ component: 'production' }),
  });
  for (const agent of production.allAgents()) agents.register(agent);
  agents.syncToDatabase(db);

  // Crash recovery on every start (after job handlers are registered).
  const jobRecovery = await jobs.recoverStale(config.jobs.staleMs);
  for (const warning of config.warnings) logger.warn({ warning }, 'configuration warning');
  if (providers.isSimulation()) logger.warn('SIMULATION MODE: only the deterministic mock provider is registered; results are not real model output');

  // Warm the (lexical) semantic index with recent selected concepts.
  for (const d of decisions.recent(50)) {
    const sel = d.selectedAction as { title?: string; format?: string; pillar?: string; concept?: string } | null;
    if (sel?.title) {
      await semantic.index({ id: d.id, text: `${sel.title} — ${sel.format ?? ''} · ${sel.pillar ?? ''} — ${sel.concept ?? ''}` });
    }
  }

  return {
    config,
    logger,
    database,
    seedReport,
    jobRecovery,
    events,
    credentials,
    budget,
    retention,
    tasks,
    jobs,
    worker,
    identity,
    strategy,
    decisions,
    memory,
    knowledge,
    semantic,
    prompts,
    providers,
    router,
    evaluator,
    contextEngine,
    visualIdentity,
    mediaStore,
    mediaProviders,
    assets,
    media,
    productions,
    production,
    agents,
    runner,
    executive,
    orchestrator,
    planning,
    close: async () => {
      await worker.stop();
      database.close();
    },
  };
}
