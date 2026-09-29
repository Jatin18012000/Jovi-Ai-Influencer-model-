import { eq } from 'drizzle-orm';
import type { Logger } from '../core/config/logger.js';
import { ValidationError, errorMessage, serializeError } from '../core/errors.js';
import type { CorrelationScope } from '../core/events/event-bus.js';
import { newId, nowIso } from '../core/ids.js';
import { PermissionGuard } from '../core/permissions/permissions.js';
import type { JoviDatabase } from '../database/client.js';
import { agentRuns } from '../database/schema.js';
import type { PermissionLevel } from '../types/enums.js';
import type { Agent, AgentRunContext } from './agent.js';
import { createToolKit, type ToolServices } from './toolkit.js';

export interface AgentRunOptions {
  taskId: string | null;
  jobId: string | null;
  scope: CorrelationScope;
}

export interface AgentRunResult<O> {
  agentRunId: string;
  output: O;
  durationMs: number;
}

/**
 * Executes any agent through the standard lifecycle and records an
 * `agent_runs` row (including every tool call, allowed or denied) plus
 * AGENT_STARTED / AGENT_COMPLETED / AGENT_FAILED events.
 *
 * The runner is the only place that holds system services; it hands each
 * agent a permission-enforcing ToolKit built from the agent's definition.
 */
export class AgentRunner {
  constructor(
    private readonly db: JoviDatabase,
    private readonly logger: Logger,
    private readonly permissionCeiling: PermissionLevel,
    private readonly services: ToolServices,
  ) {}

  async run<I, O, C>(agent: Agent<I, O, C>, rawInput: unknown, options: AgentRunOptions): Promise<AgentRunResult<O>> {
    const def = agent.definition;
    const agentRunId = newId('agentRun');
    const started = Date.now();
    const { scope } = options;
    const logger = this.logger.child({
      agent: def.name,
      agentRunId,
      taskId: options.taskId,
      jobId: options.jobId,
      correlationId: scope.correlationId,
    });

    const guard = new PermissionGuard(def.name, def.permissionLevel, def.allowedTools, this.permissionCeiling);
    const tools = createToolKit(this.services, guard, {
      scope,
      trace: (purpose) => ({ purpose, correlationId: scope.correlationId, scope, taskId: options.taskId, jobId: options.jobId, agentRunId }),
    });
    const ctx: AgentRunContext = {
      agentRunId,
      taskId: options.taskId,
      jobId: options.jobId,
      correlationId: scope.correlationId,
      scope,
      logger,
      permissions: { agentName: guard.agentName, effectiveLevel: guard.effectiveLevel, can: (tool) => guard.can(tool) },
      tools,
    };

    this.db
      .insert(agentRuns)
      .values({
        id: agentRunId,
        agentId: def.name,
        agentVersion: def.version,
        taskId: options.taskId,
        jobId: options.jobId,
        correlationId: scope.correlationId,
        status: 'RUNNING',
        input: rawInput ?? null,
        startedAt: nowIso(),
      })
      .run();
    scope.emit('AGENT_STARTED', `agents.${def.name}`, agentRunId, {
      agent: def.name,
      version: def.version,
      taskId: options.taskId,
      permissionLevel: guard.effectiveLevel,
    });
    logger.info('agent started');

    try {
      // 1. validate input
      const parsedInput = agent.inputSchema.safeParse(rawInput);
      if (!parsedInput.success) {
        throw new ValidationError(`Invalid input for agent ${def.name}: ${parsedInput.error.issues.map((i) => i.message).join('; ')}`);
      }
      const input = parsedInput.data;

      // 2. load context
      const context = await agent.loadContext(input, ctx);
      const contextSummary = agent.summarizeContext?.(context) ?? null;
      this.db.update(agentRuns).set({ contextSummary }).where(eq(agentRuns.id, agentRunId)).run();

      // 3. execute
      const rawOutput = await agent.execute(input, context, ctx);

      // 4. validate output
      const parsedOutput = agent.outputSchema.safeParse(rawOutput);
      if (!parsedOutput.success) {
        throw new ValidationError(
          `Agent ${def.name} produced invalid output: ${parsedOutput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      const output = parsedOutput.data;

      // 5. persist
      await agent.persist?.(output, input, ctx);

      const durationMs = Date.now() - started;
      this.db
        .update(agentRuns)
        .set({ status: 'COMPLETED', output: output as unknown, toolCalls: tools.calls, completedAt: nowIso(), durationMs })
        .where(eq(agentRuns.id, agentRunId))
        .run();

      // 6. emit
      scope.emit('AGENT_COMPLETED', `agents.${def.name}`, agentRunId, { agent: def.name, durationMs, toolCalls: tools.calls.length });
      logger.info({ durationMs }, 'agent completed');

      // 7. return
      return { agentRunId, output, durationMs };
    } catch (error) {
      const durationMs = Date.now() - started;
      const denied = tools.calls.filter((c) => !c.allowed).map((c) => c.tool);
      this.db
        .update(agentRuns)
        .set({ status: 'FAILED', error: serializeError(error), toolCalls: tools.calls, completedAt: nowIso(), durationMs })
        .where(eq(agentRuns.id, agentRunId))
        .run();
      scope.emit('AGENT_FAILED', `agents.${def.name}`, agentRunId, {
        agent: def.name,
        durationMs,
        error: serializeError(error),
        ...(denied.length ? { deniedTools: denied } : {}),
      });
      logger.error({ durationMs, err: errorMessage(error), deniedTools: denied }, 'agent failed');
      throw error;
    }
  }
}
