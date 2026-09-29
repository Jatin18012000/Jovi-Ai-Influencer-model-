import { z } from 'zod';
import type { Logger } from '../../core/config/logger.js';
import { ValidationError, errorMessage } from '../../core/errors.js';
import type { EventBus } from '../../core/events/event-bus.js';
import type { IdentityService } from '../../core/identity/identity-service.js';
import type { VisualIdentityService } from '../../core/identity/visual-identity.js';
import { newId } from '../../core/ids.js';
import type { Job, JobQueue } from '../../core/jobs/job-queue.js';
import type { Task, TaskService } from '../../core/jobs/task-service.js';
import type { AssetService, MediaAsset } from '../../core/production/asset-service.js';
import type { MediaService } from '../../core/production/media-service.js';
import type { ProductionService } from '../../core/production/production-service.js';
import type { PublishingGateResult } from '../../core/production/publishing-gate.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import type { StrategyService } from '../../core/strategy/strategy-service.js';
import { AspectRatio } from '../../media/types.js';
import { PrivacyRequirement, type MediaKind, type ProductionStatus } from '../../types/enums.js';
import type { AgentRunner } from '../agent-runner.js';
import type { AnyAgent } from '../agent.js';
import { IdeationOutput, type CreatorPlanningPipeline, type PlanningResult } from '../planning/planning-agents.js';
import { ScriptAgent, StoryboardAgent, VisualPromptAgent } from './creative-agents.js';
import { EditingAgent, ImageGenerationAgent, VideoGenerationAgent, VoiceAgent } from './media-agents.js';
import {
  ProductionContextSchema,
  ProductionIdeaSchema,
  type EditPlan,
  type ProductionContext,
  type ProductionIdea,
  type QAReport,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from './production-schemas.js';
import { QAAgent } from './qa-agent.js';

export const CREATIVE_PRODUCTION_JOB = 'creative.production';

/**
 * Start a production from Phase 7 output (a planning task and optionally an
 * idea id), from a goal (runs Phase 7 planning first), or from an explicit idea.
 */
export const ProductionRequestSchema = z
  .object({
    planningTaskId: z.string().min(1).optional(),
    ideaId: z.string().min(1).optional(),
    idea: ProductionIdeaSchema.optional(),
    goal: z.string().trim().min(5).max(2000).optional(),
    aspectRatio: AspectRatio.default('9:16'),
    privacy: PrivacyRequirement.optional(),
    mode: z.enum(['sync', 'async']).default('sync'),
    createdBy: z.string().max(100).default('api'),
  })
  .refine((r) => [r.planningTaskId, r.idea, r.goal].filter(Boolean).length === 1, {
    message: 'provide exactly one of planningTaskId, idea or goal',
  });
export type ProductionRequest = z.input<typeof ProductionRequestSchema>;

export interface ProductionResult {
  status: Task['status'];
  productionId: string | null;
  productionStatus: ProductionStatus | null;
  qaStatus: QAReport['status'] | null;
  simulated: boolean;
  taskId: string | null;
  jobId: string | null;
  correlationId: string;
  source: { type: 'PLANNING' | 'DIRECT'; planningTaskId: string | null; ideaId: string; ideaTitle: string } | null;
  artifacts: { script: boolean; storyboard: boolean; visualPrompts: boolean; editPlan: boolean; qaReport: boolean };
  assets: Array<{ assetId: string; kind: string; sceneId: string | null; status: string; provider: string | null; reason: string | null }>;
  qa: { status: QAReport['status']; recommendedAction: QAReport['recommendedAction']; failedChecks: string[]; requiredFixes: string[] } | null;
  publishingGate: PublishingGateResult | null;
  eventsGenerated: Array<{ eventType: string; entityId: string | null }>;
  attempts: number;
  error: unknown;
}

interface PipelineDeps {
  tasks: TaskService;
  jobs: JobQueue;
  events: EventBus;
  runner: AgentRunner;
  productions: ProductionService;
  assets: AssetService;
  media: MediaService;
  identity: IdentityService;
  visualIdentity: VisualIdentityService;
  strategy: StrategyService;
  planning: CreatorPlanningPipeline;
  prompts: PromptLibrary;
  isSimulation: () => boolean;
  logger: Logger;
}

/**
 * Phase 8 creative production:
 *
 *   Idea → Script → Storyboard → Visual prompts → {Image ∥ Video ∥ Voice} → Edit plan → QA → human approval boundary
 *
 * Runs as one CREATIVE_PRODUCTION task executed by a SQLite-backed job, so
 * retries, heartbeat and crash recovery come from the existing JobQueue. Each
 * stage is persisted; a retried job resumes at the first unfinished stage.
 * The pipeline has no publish capability — its furthest state is
 * AWAITING_HUMAN_APPROVAL (or BLOCKED when QA does not pass).
 */
export class CreativeProductionPipeline {
  readonly agents: {
    script: ScriptAgent;
    storyboard: StoryboardAgent;
    visualPrompt: VisualPromptAgent;
    image: ImageGenerationAgent;
    video: VideoGenerationAgent;
    voice: VoiceAgent;
    editing: EditingAgent;
    qa: QAAgent;
  };

  constructor(private readonly deps: PipelineDeps) {
    this.agents = {
      script: new ScriptAgent(deps.prompts),
      storyboard: new StoryboardAgent(deps.prompts),
      visualPrompt: new VisualPromptAgent(deps.prompts),
      image: new ImageGenerationAgent(),
      video: new VideoGenerationAgent(),
      voice: new VoiceAgent(),
      editing: new EditingAgent(),
      qa: new QAAgent(deps.prompts),
    };
    deps.jobs.registerHandler(CREATIVE_PRODUCTION_JOB, {
      execute: ({ job, scope }) => this.executeJob(job, scope),
      onFinalFailure: ({ job, scope }, error) => {
        const production = this.deps.productions.findByTask(job.taskId);
        if (production) this.deps.productions.fail(production.id, error, scope);
        const task = this.deps.tasks.find(job.taskId);
        if (task && task.status !== 'COMPLETED' && task.status !== 'CANCELLED') this.deps.tasks.fail(job.taskId, error, scope);
      },
    });
  }

  allAgents(): AnyAgent[] {
    return Object.values(this.agents);
  }

  async start(request: ProductionRequest): Promise<ProductionResult> {
    const input = ProductionRequestSchema.parse(request);
    const correlationId = newId('correlation');

    let planning: PlanningResult | null = null;
    let planningTaskId: string | null = null;
    if (input.goal) {
      // Phase 8 starts from Phase 7 output: a goal runs the existing planning pipeline first.
      planning = await this.deps.planning.execute({ goal: input.goal, createdBy: input.createdBy });
      if (planning.status !== 'COMPLETED' || !planning.ideation) {
        return this.emptyResult(correlationId, `planning failed: ${errorMessage((planning.error as { message?: string })?.message ?? planning.error)}`);
      }
      planningTaskId = planning.taskId;
    } else if (input.planningTaskId) {
      planningTaskId = input.planningTaskId;
      planning = this.loadPlanning(input.planningTaskId);
    }

    const { idea, context, sourceType } = planning
      ? this.fromPlanning(planning, input.ideaId, input.privacy)
      : { idea: input.idea as ProductionIdea, context: this.directContext(input.privacy), sourceType: 'DIRECT' as const };

    const scope = this.deps.events.scope(correlationId);
    const task = this.deps.tasks.create({ type: 'CREATIVE_PRODUCTION', goal: `Produce: ${idea.title}`, input: { ideaId: idea.id, planningTaskId, aspectRatio: input.aspectRatio }, createdBy: input.createdBy }, scope);
    const identity = this.deps.identity.getActive();
    const visual = this.deps.visualIdentity.getActive();
    const production = this.deps.productions.create(
      {
        taskId: task.id,
        sourceType,
        sourcePlanningTaskId: planningTaskId,
        ideaId: idea.id,
        idea,
        productionContext: { ...context, aspectRatio: input.aspectRatio },
        identityVersion: identity.version,
        visualIdentityVersion: visual.version,
        simulated: this.deps.isSimulation(),
      },
      scope,
    );
    const job = this.deps.jobs.enqueue({ taskId: task.id, type: CREATIVE_PRODUCTION_JOB, payload: { productionId: production.id }, reserve: input.mode === 'sync' }, scope);
    if (input.mode === 'async') return this.getResult(production.id);
    await this.deps.jobs.run(job.id);
    return this.getResult(production.id);
  }

  /** Assembles the current state of a production from persisted records. */
  getResult(productionId: string): ProductionResult {
    const production = this.deps.productions.get(productionId);
    const task = this.deps.tasks.get(production.taskId);
    const job = this.deps.jobs.listByTask(task.id).at(-1);
    const qa = this.deps.productions.latestArtifact<QAReport>(productionId, 'QA_REPORT');
    const idea = ProductionIdeaSchema.parse(production.idea);
    const assets = this.deps.assets.list(productionId);
    const has = (kind: Parameters<ProductionService['latestArtifact']>[1]) => this.deps.productions.latestArtifact(productionId, kind) !== null;
    return {
      status: task.status,
      productionId,
      productionStatus: production.status as ProductionStatus,
      qaStatus: (production.qaStatus as QAReport['status'] | null) ?? null,
      simulated: production.simulated || assets.some((a) => a.simulated),
      taskId: task.id,
      jobId: job?.id ?? null,
      correlationId: production.correlationId,
      source: { type: production.sourceType, planningTaskId: production.sourcePlanningTaskId, ideaId: idea.id, ideaTitle: idea.title },
      artifacts: { script: has('SCRIPT'), storyboard: has('STORYBOARD'), visualPrompts: has('VISUAL_PROMPTS'), editPlan: has('EDIT_PLAN'), qaReport: has('QA_REPORT') },
      assets: assets.map((a) => ({ assetId: a.id, kind: a.kind, sceneId: a.sceneId, status: a.status, provider: a.provider, reason: a.statusReason })),
      qa: qa ? { status: qa.status, recommendedAction: qa.recommendedAction, failedChecks: qa.failedChecks.map((c) => c.id), requiredFixes: qa.requiredFixes } : null,
      publishingGate: this.deps.productions.publishingGate(productionId),
      eventsGenerated: this.deps.events.list({ correlationId: production.correlationId, limit: 1000 }).map((e) => ({ eventType: e.eventType, entityId: e.entityId })),
      attempts: job?.attempts ?? 0,
      error: production.error ?? task.error ?? job?.lastError ?? null,
    };
  }

  // ---------------------------------------------------------------------------

  private async executeJob(job: Job, scope: ReturnType<EventBus['scope']>): Promise<unknown> {
    const { productionId } = job.payload as { productionId: string };
    const { productions } = this.deps;
    this.deps.tasks.start(job.taskId, scope);
    const production = productions.get(productionId);
    const idea = ProductionIdeaSchema.parse(production.idea);
    const context = ProductionContextSchema.parse(production.productionContext);
    const aspectRatio = AspectRatio.parse((production.productionContext as { aspectRatio?: string }).aspectRatio ?? '9:16');
    const privacy = context.privacy;
    const run = <O>(agent: AnyAgent, input: unknown) =>
      this.deps.runner.run(agent, input, { taskId: job.taskId, jobId: job.id, scope }).then((r) => r.output as O);
    const status = () => productions.get(productionId).status as ProductionStatus;

    if (status() === 'CREATED') productions.advance(productionId, 'SCRIPTING', scope);

    if (status() === 'SCRIPTING') {
      if (!productions.latestArtifact(productionId, 'SCRIPT')) {
        await run<Script>(this.agents.script, { productionId, idea, productionContext: context, privacy });
      }
      productions.advance(productionId, 'STORYBOARDING', scope);
    }
    const script = productions.latestArtifact<Script>(productionId, 'SCRIPT')!;

    if (status() === 'STORYBOARDING') {
      if (!productions.latestArtifact(productionId, 'STORYBOARD')) {
        await run<Storyboard>(this.agents.storyboard, { productionId, idea, script, aspectRatio, privacy });
      }
      productions.advance(productionId, 'PROMPTING', scope);
    }
    const storyboard = productions.latestArtifact<Storyboard>(productionId, 'STORYBOARD')!;

    if (status() === 'PROMPTING') {
      if (!productions.latestArtifact(productionId, 'VISUAL_PROMPTS')) {
        await run<VisualPrompts>(this.agents.visualPrompt, { productionId, storyboard, privacy });
      }
      productions.advance(productionId, 'GENERATING_ASSETS', scope);
    }
    const prompts = productions.latestArtifact<VisualPrompts>(productionId, 'VISUAL_PROMPTS')!;

    if (status() === 'GENERATING_ASSETS') {
      await this.generateAssets(productionId, script, prompts, aspectRatio, run, scope);
      productions.advance(productionId, 'EDITING', scope);
    }

    if (status() === 'EDITING') {
      if (!productions.latestArtifact(productionId, 'EDIT_PLAN')) {
        await run<EditPlan>(this.agents.editing, { productionId, script, storyboard });
      }
      productions.advance(productionId, 'QA', scope);
    }

    if (status() === 'QA') {
      scope.emit('QA_STARTED', 'production', productionId, { taskId: job.taskId });
      const report = await run<QAReport>(this.agents.qa, { productionId, idea, privacy });
      const passed = report.status === 'PASS' || report.status === 'PASS_WITH_WARNINGS';
      productions.advance(productionId, passed ? 'AWAITING_HUMAN_APPROVAL' : 'BLOCKED', scope);
    }

    const final = productions.get(productionId);
    const summary = { productionId, productionStatus: final.status, qaStatus: final.qaStatus };
    this.deps.tasks.complete(job.taskId, summary, scope);
    return summary;
  }

  /**
   * Image, video and voice run in parallel. When the video provider animates
   * source images, video waits for images (identity consistency); voice never
   * depends on visuals. Kinds already generated on a previous attempt are not
   * regenerated; assets interrupted mid-flight are marked FAILED.
   */
  private async generateAssets(
    productionId: string,
    script: Script,
    prompts: VisualPrompts,
    aspectRatio: AspectRatio,
    run: <O>(agent: AnyAgent, input: unknown) => Promise<O>,
    scope: ReturnType<EventBus['scope']>,
  ): Promise<void> {
    const existing = this.deps.assets.list(productionId);
    for (const a of existing.filter((x) => ['REQUESTED', 'QUEUED', 'GENERATING'].includes(x.status))) {
      this.deps.assets.transition(a.id, 'FAILED', { statusReason: 'interrupted: generation did not finish before a restart' }, scope);
    }
    const done = new Set(existing.map((a: MediaAsset) => a.kind as MediaKind));
    const image = () => (done.has('IMAGE') ? Promise.resolve() : run(this.agents.image, { productionId, prompts: prompts.prompts }));
    const video = (useSourceImages: boolean) =>
      done.has('VIDEO') ? Promise.resolve() : run(this.agents.video, { productionId, prompts: prompts.prompts, useSourceImages });
    const voice = () => (done.has('VOICE') ? Promise.resolve() : run(this.agents.voice, { productionId, script }));

    const conditionOnImages = await this.deps.media.videoNeedsSourceImages(aspectRatio);
    await Promise.all(conditionOnImages ? [image().then(() => video(true)), voice()] : [image(), video(false), voice()]);
  }

  private loadPlanning(taskId: string): PlanningResult {
    const task = this.deps.tasks.get(taskId);
    if (task.type !== 'CREATOR_PLANNING') throw new ValidationError(`task ${taskId} is not a CREATOR_PLANNING task`);
    if (task.status !== 'COMPLETED') throw new ValidationError(`planning task ${taskId} is ${task.status}, not COMPLETED`);
    return task.result as PlanningResult;
  }

  private fromPlanning(planning: PlanningResult, ideaId: string | undefined, privacy: z.infer<typeof PrivacyRequirement> | undefined) {
    // Re-validate through the Phase 7 contract (normalises ids and recommendedIdeaIds).
    const ideation = IdeationOutput.parse(planning.ideation);
    const chosenId = ideaId ?? ideation.recommendedIdeaIds[0];
    const chosen = ideation.ideas.find((i) => i.id === chosenId);
    if (!chosen) throw new ValidationError(`idea ${chosenId} not found in planning task ${planning.taskId} (ideas: ${ideation.ideas.map((i) => i.id).join(', ')})`);
    const context: ProductionContext = ProductionContextSchema.parse({
      goal: null,
      audience: planning.research?.audienceAngles ?? [],
      strategy: {
        objective: planning.strategy?.objective ?? this.deps.strategy.getActive().objective,
        guardrails: planning.strategy?.guardrails ?? [],
        formats: planning.strategy?.formats ?? [],
      },
      ...(privacy ? { privacy } : {}),
    });
    return { idea: ProductionIdeaSchema.parse(chosen), context, sourceType: 'PLANNING' as const };
  }

  private directContext(privacy: z.infer<typeof PrivacyRequirement> | undefined): ProductionContext {
    const strategy = this.deps.strategy.getActive();
    return ProductionContextSchema.parse({
      goal: null,
      audience: [],
      strategy: {
        objective: strategy.objective,
        guardrails: strategy.content.guidelines,
        formats: strategy.content.formatPriorities.map((f) => ({ format: f.format, role: f.role })),
      },
      ...(privacy ? { privacy } : {}),
    });
  }

  private emptyResult(correlationId: string, error: string): ProductionResult {
    return {
      status: 'FAILED',
      productionId: null,
      productionStatus: null,
      qaStatus: null,
      simulated: this.deps.isSimulation(),
      taskId: null,
      jobId: null,
      correlationId,
      source: null,
      artifacts: { script: false, storyboard: false, visualPrompts: false, editPlan: false, qaReport: false },
      assets: [],
      qa: null,
      publishingGate: null,
      eventsGenerated: [],
      attempts: 0,
      error: { message: error },
    };
  }
}
