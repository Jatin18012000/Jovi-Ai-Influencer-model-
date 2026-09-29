import { AgentRegistry } from '../agents/agent-registry.js';
import { AgentRunner } from '../agents/agent-runner.js';
import type { ToolServices } from '../agents/toolkit.js';
import { ExecutiveAgent } from '../agents/executive/executive-agent.js';
import { PLANNED_AGENTS } from '../agents/planned-agents.js';
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
import { JobQueue } from './jobs/job-queue.js';
import { JobWorker } from './jobs/job-worker.js';
import { TaskService } from './jobs/task-service.js';
import { ContextEngine } from './orchestrator/context-engine.js';
import { JoviOrchestrator } from './orchestrator/orchestrator.js';
import { PromptLibrary } from './prompts/prompt-library.js';
import { StrategyService } from './strategy/strategy-service.js';

export interface CreateCoreOptions {
  config?: JoviConfig;
  /** Replaces the configured providers entirely (tests, custom deployments). */
  providers?: ModelProvider[];
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
  agents: AgentRegistry;
  runner: AgentRunner;
  executive: ExecutiveAgent;
  orchestrator: JoviOrchestrator;
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
  const tasks = new TaskService(db);
  const jobs = new JobQueue(db, sqlite, events, logger.child({ component: 'jobs' }), {
    defaultMaxAttempts: config.jobs.maxAttempts,
    backoffMs: config.jobs.backoffMs,
    heartbeatMs: config.jobs.heartbeatMs,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const worker = new JobWorker(jobs, logger.child({ component: 'worker' }), config.jobs.workerPollMs, config.jobs.staleMs);

  const identity = new IdentityService(db);
  const strategy = new StrategyService(db);
  const decisions = new DecisionService(db);
  const memory = new OperationalMemory(db, events);
  const knowledge = new KnowledgeBase(fromRoot('knowledge', 'jovi'));
  const semantic = new KeywordSemanticMemory();
  const prompts = new PromptLibrary(fromRoot('prompts'));

  const providers = new ProviderRegistry(db, logger.child({ component: 'providers' }), config.providers.statusTtlMs);
  for (const provider of options.providers ?? createProvidersFromConfig(config)) providers.register(provider);

  const router = new ModelRouter(providers, db, logger.child({ component: 'router' }), prompts, {
    cloudPreference: config.providers.cloudPreference,
    allowCloudFallback: config.providers.allowCloudFallback,
  });
  const evaluator = new Evaluator(router, prompts, db, logger.child({ component: 'evaluator' }));
  const contextEngine = new ContextEngine({ identity, strategy, memory, knowledge, semantic, decisions, providers });

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
    agentDirectory: () => agents.list().map(({ definition, status }) => ({ name: definition.name, permissionLevel: definition.permissionLevel, status })),
  };
  const runner = new AgentRunner(db, logger.child({ component: 'agents' }), config.permissions.maxLevel, toolServices);
  const orchestrator = new JoviOrchestrator({ tasks, jobs, events, runner, executive, logger: logger.child({ component: 'orchestrator' }) });

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
    agents,
    runner,
    executive,
    orchestrator,
    close: async () => {
      await worker.stop();
      database.close();
    },
  };
}
