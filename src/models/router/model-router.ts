import { z } from 'zod';
import type { Logger } from '../../core/config/logger.js';
import { InvalidModelOutputError, NoModelAvailableError, ProviderError, errorMessage, isRetryable, serializeError } from '../../core/errors.js';
import type { CorrelationScope } from '../../core/events/event-bus.js';
import { newId, nowIso } from '../../core/ids.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import type { JoviDatabase } from '../../database/client.js';
import { modelRuns } from '../../database/schema.js';
import { CostClass, LatencyRequirement, PrivacyRequirement, RoutingTier, type ProviderKind } from '../../types/enums.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { GenerateRequest, GenerateResult, ProviderStatus } from '../types.js';

export const RoutingRequestSchema = z.object({
  taskType: z.string().min(1),
  complexity: RoutingTier.default('NORMAL'),
  /** Defaults to the complexity tier when omitted. */
  quality: RoutingTier.optional(),
  privacy: PrivacyRequirement.default('STANDARD'),
  costClass: CostClass.default('MEDIUM'),
  latency: LatencyRequirement.default('STANDARD'),
  /** `provider:model` ids to avoid (e.g. evaluator must differ from generator). */
  excludeModels: z.array(z.string()).default([]),
});

export type RoutingRequest = z.input<typeof RoutingRequestSchema>;
export type ResolvedRoutingRequest = z.output<typeof RoutingRequestSchema>;

export interface RouteCandidate {
  provider: string;
  model: string;
  kind: ProviderKind;
}

export interface RoutingPlan {
  category: RoutingTier;
  reason: string;
  candidates: RouteCandidate[];
  /** True when a HIGH/STRATEGIC request can only be served by a non-cloud model. */
  degraded: boolean;
  unavailable: Array<{ provider: string; reason: string }>;
}

export interface RunTrace {
  purpose: string;
  correlationId: string;
  scope?: CorrelationScope;
  taskId?: string | null;
  jobId?: string | null;
  agentRunId?: string | null;
}

export interface AttemptRecord {
  modelRunId: string;
  provider: string;
  model: string;
  status: 'SUCCEEDED' | 'FAILED' | 'INVALID_OUTPUT';
  isFallback: boolean;
  latencyMs: number;
  error?: string;
}

export interface RoutedGeneration<T> {
  result: GenerateResult;
  parsed: T;
  plan: RoutingPlan;
  fallbackUsed: boolean;
  attempts: AttemptRecord[];
}

const TIER_ORDER: RoutingTier[] = ['LOW', 'NORMAL', 'HIGH', 'STRATEGIC'];
const SOURCE = 'models.router';

/**
 * Model Router.
 *
 * Policy (Phase 5):
 *   LOW        → prefer local (Ollama); cloud as fallback.
 *   NORMAL     → prefer configured cloud; local as fallback.
 *   HIGH       → cloud; local only as a flagged (degraded) fallback.
 *   STRATEGIC  → cloud + independent evaluator when available.
 *   Privacy LOCAL_ONLY restricts to local; SENSITIVE prefers local.
 *   The mock provider, when enabled, is always the last resort.
 *
 * Every attempt is recorded in `model_runs` and surfaced as MODEL_SELECTED /
 * MODEL_FALLBACK events, so routing is fully observable.
 */
export class ModelRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly db: JoviDatabase,
    private readonly logger: Logger,
    private readonly prompts: PromptLibrary,
    private readonly options: { cloudPreference: string[]; timeoutMs: number },
  ) {}

  static tierOf(request: ResolvedRoutingRequest): RoutingTier {
    const c = TIER_ORDER.indexOf(request.complexity);
    const q = TIER_ORDER.indexOf(request.quality ?? request.complexity);
    return TIER_ORDER[Math.max(c, q)] ?? 'NORMAL';
  }

  async plan(input: RoutingRequest): Promise<RoutingPlan> {
    const request = RoutingRequestSchema.parse(input);
    const category = ModelRouter.tierOf(request);
    const statuses = await this.registry.statusesFresh();
    const unavailable = statuses.filter((s) => !s.available).map((s) => ({ provider: s.provider, reason: s.reason }));
    const usable = statuses.filter((s): s is ProviderStatus & { selectedModel: string } => s.available && s.selectedModel !== null);

    const toCandidate = (s: ProviderStatus & { selectedModel: string }): RouteCandidate => ({
      provider: s.provider,
      model: s.selectedModel,
      kind: s.kind,
    });
    const notExcluded = (c: RouteCandidate) => !request.excludeModels.includes(`${c.provider}:${c.model}`);

    const local = usable.filter((s) => s.kind === 'LOCAL').map(toCandidate).filter(notExcluded);
    const cloud = usable
      .filter((s) => s.kind === 'CLOUD')
      .map(toCandidate)
      .filter(notExcluded)
      .sort((a, b) => this.cloudRank(a.provider) - this.cloudRank(b.provider));
    const mock = usable.filter((s) => s.kind === 'MOCK').map(toCandidate).filter(notExcluded);

    let candidates: RouteCandidate[];
    let reason: string;
    if (request.privacy === 'LOCAL_ONLY') {
      candidates = [...local, ...mock];
      reason = 'privacy LOCAL_ONLY: restricted to local models';
    } else if (request.privacy === 'SENSITIVE') {
      candidates = [...local, ...cloud, ...mock];
      reason = 'privacy SENSITIVE: local preferred, cloud fallback';
    } else if (category === 'LOW' || request.costClass === 'FREE') {
      candidates = [...local, ...cloud, ...mock];
      reason = `${category} tier${request.costClass === 'FREE' ? ' / FREE cost class' : ''}: prefer local model`;
    } else {
      candidates = [...cloud, ...local, ...mock];
      reason =
        category === 'NORMAL'
          ? 'NORMAL tier: prefer configured cloud model'
          : category === 'HIGH'
            ? 'HIGH tier: cloud model required; local only as degraded fallback'
            : 'STRATEGIC tier: cloud model plus independent evaluator';
    }

    const first = candidates[0];
    const degraded = (category === 'HIGH' || category === 'STRATEGIC') && first !== undefined && first.kind !== 'CLOUD';
    if (degraded) reason += ` (degraded: no cloud model available, using ${first.provider})`;
    return { category, reason, candidates, degraded, unavailable };
  }

  /**
   * Generates with automatic fallback. `parse` validates the raw output; an
   * invalid output gets one repair attempt on the same model, then the router
   * falls back to the next candidate.
   */
  async generate<T>(
    request: Omit<GenerateRequest, 'requirements'> & { requirements?: GenerateRequest['requirements'] },
    routing: RoutingRequest,
    trace: RunTrace,
    parse: (output: string) => T,
  ): Promise<RoutedGeneration<T>> {
    const resolved = RoutingRequestSchema.parse(routing);
    const plan = await this.plan(resolved);
    if (plan.candidates.length === 0) {
      throw new NoModelAvailableError(
        `No model available for ${resolved.taskType} (${plan.category}). ` +
          `Configure a cloud API key, start Ollama with an installed model, or enable the mock provider (JOVI_ENABLE_MOCK_PROVIDER=true).`,
        { unavailable: plan.unavailable },
      );
    }

    const timeoutMs = this.timeoutFor(resolved.latency);
    const attempts: AttemptRecord[] = [];
    const errors: unknown[] = [];
    let attemptNo = 0;

    for (const [index, candidate] of plan.candidates.entries()) {
      const provider = this.registry.get(candidate.provider);
      if (!provider) continue;
      const isFallback = index > 0;
      const previous = plan.candidates[index - 1];

      if (!isFallback) {
        trace.scope?.emit('MODEL_SELECTED', SOURCE, `${candidate.provider}:${candidate.model}`, {
          purpose: trace.purpose,
          provider: candidate.provider,
          model: candidate.model,
          category: plan.category,
          reason: plan.reason,
          degraded: plan.degraded,
          candidates: plan.candidates.map((c) => `${c.provider}:${c.model}`),
        });
      } else {
        trace.scope?.emit('MODEL_FALLBACK', SOURCE, `${candidate.provider}:${candidate.model}`, {
          purpose: trace.purpose,
          from: previous ? `${previous.provider}:${previous.model}` : null,
          to: `${candidate.provider}:${candidate.model}`,
          category: plan.category,
          error: errorMessage(errors[errors.length - 1]),
        });
      }

      let generateRequest: GenerateRequest = {
        ...request,
        requirements: { ...request.requirements, model: candidate.model, timeoutMs: request.requirements?.timeoutMs ?? timeoutMs },
      };

      // Up to two tries per candidate: the original, plus one JSON repair.
      for (let repair = 0; repair < 2; repair += 1) {
        attemptNo += 1;
        const started = Date.now();
        let result: GenerateResult | undefined;
        try {
          result = await provider.generate(generateRequest);
          const parsed = parse(result.output);
          const run = this.record(trace, plan, candidate, attemptNo, isFallback, previous, 'SUCCEEDED', result, Date.now() - started);
          attempts.push({ modelRunId: run, provider: candidate.provider, model: result.model, status: 'SUCCEEDED', isFallback, latencyMs: result.latencyMs });
          this.logger.info(
            {
              correlationId: trace.correlationId,
              taskId: trace.taskId,
              purpose: trace.purpose,
              provider: candidate.provider,
              model: result.model,
              category: plan.category,
              fallback: isFallback,
              durationMs: Date.now() - started,
              estimatedApiCost: result.cost.estimatedApiCost,
              executionCostType: result.cost.executionCostType,
            },
            'model generation succeeded',
          );
          return { result, parsed, plan, fallbackUsed: isFallback, attempts };
        } catch (error) {
          const invalid = result !== undefined; // provider answered, parse failed
          const status = invalid ? 'INVALID_OUTPUT' : 'FAILED';
          const run = this.record(trace, plan, candidate, attemptNo, isFallback, previous, status, result, Date.now() - started, error);
          attempts.push({
            modelRunId: run,
            provider: candidate.provider,
            model: candidate.model,
            status,
            isFallback,
            latencyMs: Date.now() - started,
            error: errorMessage(error),
          });
          errors.push(error);
          this.logger.warn(
            { correlationId: trace.correlationId, purpose: trace.purpose, provider: candidate.provider, model: candidate.model, status, err: errorMessage(error) },
            'model attempt failed',
          );

          if (invalid && repair === 0 && result) {
            generateRequest = this.repairRequest(generateRequest, result.output, errorMessage(error));
            continue;
          }
          if (error instanceof ProviderError && !error.retryable) {
            this.registry.markUnavailable(candidate.provider, errorMessage(error));
          }
          break;
        }
      }
    }

    const anyRetryable = errors.some((e) => isRetryable(e) || e instanceof InvalidModelOutputError);
    throw new NoModelAvailableError(
      `All ${plan.candidates.length} candidate model(s) failed for ${resolved.taskType}: ${errors.map(errorMessage).join(' | ')}`,
      { attempts },
      anyRetryable,
    );
  }

  private repairRequest(original: GenerateRequest, badOutput: string, validationError: string): GenerateRequest {
    const repair = this.prompts.render('system/json-repair', {
      validation_error: validationError.slice(0, 1500),
      previous_output: badOutput.slice(0, 6000),
    });
    return { ...original, context: { system: original.context.system, prompt: `${original.context.prompt}\n\n${repair}` } };
  }

  private cloudRank(provider: string): number {
    const index = this.options.cloudPreference.indexOf(provider);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  private timeoutFor(latency: z.infer<typeof LatencyRequirement>): number {
    if (latency === 'INTERACTIVE') return Math.min(this.options.timeoutMs, 90_000);
    if (latency === 'BATCH') return this.options.timeoutMs * 2;
    return this.options.timeoutMs;
  }

  private record(
    trace: RunTrace,
    plan: RoutingPlan,
    candidate: RouteCandidate,
    attempt: number,
    isFallback: boolean,
    previous: RouteCandidate | undefined,
    status: 'SUCCEEDED' | 'FAILED' | 'INVALID_OUTPUT',
    result: GenerateResult | undefined,
    latencyMs: number,
    error?: unknown,
  ): string {
    const id = newId('modelRun');
    this.db
      .insert(modelRuns)
      .values({
        id,
        provider: candidate.provider,
        model: result?.model ?? candidate.model,
        purpose: trace.purpose,
        taskId: trace.taskId ?? null,
        jobId: trace.jobId ?? null,
        agentRunId: trace.agentRunId ?? null,
        correlationId: trace.correlationId,
        routingCategory: plan.category,
        routingReason: plan.reason,
        attempt,
        isFallback,
        fallbackFrom: isFallback && previous ? `${previous.provider}:${previous.model}` : null,
        status,
        inputTokens: result?.usage.inputTokens ?? null,
        outputTokens: result?.usage.outputTokens ?? null,
        latencyMs: result?.latencyMs ?? latencyMs,
        estimatedApiCost: result?.cost.estimatedApiCost ?? null,
        executionCostType: result?.cost.executionCostType ?? (candidate.kind === 'CLOUD' ? 'API' : candidate.kind === 'LOCAL' ? 'LOCAL_COMPUTE' : 'NONE'),
        error: error === undefined ? null : serializeError(error),
        createdAt: nowIso(),
      })
      .run();
    return id;
  }
}
