import { z } from 'zod';
import { errorMessage } from '../../core/errors.js';
import { identityPromptVariables, renderIdentityBrief } from '../../core/identity/identity-prompt.js';
import { escapeData } from '../../core/orchestrator/context-engine.js';
import type { PromptLibrary } from '../../core/prompts/prompt-library.js';
import { parseModelJson } from '../../models/json-output.js';
import type { Agent, AgentDefinition, AgentRunContext } from '../agent.js';
import {
  ProductionIdeaSchema,
  QA_MODEL_CHECKS,
  QAModelReviewSchema,
  QAReportSchema,
  type EditPlan,
  type QAReport,
  type Script,
  type Storyboard,
  type VisualPrompts,
} from './production-schemas.js';
import { runCreativeQA } from './qa-engine.js';

export const QA_AGENT_DEFINITION: AgentDefinition = {
  name: 'qa',
  version: '0.1.0',
  description: 'Structured creative QA across identity, personality, brand, content, visual, safety and technical checks; can block approval.',
  capabilities: ['creative-qa', 'identity-qa', 'safety-qa', 'technical-qa'],
  // QA reads everything it judges and writes only its report. It cannot approve, publish or change assets.
  allowedTools: ['identity.read', 'strategy.read', 'knowledge.read', 'production.read', 'production.write', 'model.generate'],
  permissionLevel: 'LEVEL_2_MODIFY',
  modelRequirements: { defaultTier: 'NORMAL', privacy: 'STANDARD', latency: 'STANDARD', structuredOutput: true },
  costClass: 'MEDIUM',
  riskLevel: 'LOW',
};

export const QAAgentInputSchema = z.object({
  productionId: z.string().min(1),
  idea: ProductionIdeaSchema,
  privacy: z.enum(['STANDARD', 'SENSITIVE', 'LOCAL_ONLY']).optional(),
});
export type QAAgentInput = z.infer<typeof QAAgentInputSchema>;

export class QAAgent implements Agent<QAAgentInput, QAReport, null> {
  readonly definition = QA_AGENT_DEFINITION;
  readonly inputSchema = QAAgentInputSchema;
  readonly outputSchema = QAReportSchema;

  constructor(private readonly prompts: PromptLibrary) {}

  async loadContext(): Promise<null> {
    return null;
  }

  async execute(input: QAAgentInput, _c: null, ctx: AgentRunContext): Promise<QAReport> {
    const { tools } = ctx;
    const identity = tools.identity.getActive();
    const visual = tools.identity.getVisual();
    const script = tools.production.getArtifact<Script>(input.productionId, 'SCRIPT');
    const storyboard = tools.production.getArtifact<Storyboard>(input.productionId, 'STORYBOARD');
    const prompts = tools.production.getArtifact<VisualPrompts>(input.productionId, 'VISUAL_PROMPTS');
    const editPlan = tools.production.getArtifact<EditPlan>(input.productionId, 'EDIT_PLAN');
    const assets = tools.production.listAssets(input.productionId);

    let modelReview: Parameters<typeof runCreativeQA>[0]['modelReview'] = null;
    let modelReviewError: string | undefined;
    if (script && storyboard) {
      try {
        const routed = await tools.models.generate(
          {
            task: { type: 'production.qa_review', description: 'Independent creative QA review' },
            context: {
              system: this.prompts.render('production/creative-system', { ...identityPromptVariables(identity.profile), role: 'QA Agent' }),
              prompt: this.prompts.render('production/qa-review', {
                identity: escapeData(renderIdentityBrief(identity.profile)),
                idea_json: escapeData(JSON.stringify(input.idea, null, 2)),
                script_json: escapeData(JSON.stringify(script, null, 2)),
                storyboard_json: escapeData(JSON.stringify(storyboard, null, 2)),
                checks: QA_MODEL_CHECKS.map(([id, , name]) => `- ${id}: ${name}`).join('\n'),
              }),
            },
            requirements: { json: true, temperature: 0.2, maxOutputTokens: 2500 },
          },
          { taskType: 'production.qa_review', complexity: 'NORMAL', privacy: input.privacy ?? 'STANDARD', costClass: 'MEDIUM', latency: 'STANDARD' },
          'production.qa_review',
          (text) => parseModelJson(QAModelReviewSchema, text),
        );
        modelReview = { review: routed.parsed, provider: routed.result.provider, model: routed.result.model };
      } catch (error) {
        // No model is not a pass: the model-judged checks become NOT_VERIFIABLE (human review).
        modelReviewError = errorMessage(error);
      }
    }

    return runCreativeQA({
      identity: identity.profile,
      identityVersion: identity.version,
      visual,
      idea: input.idea,
      script,
      storyboard,
      prompts,
      editPlan,
      assets,
      modelReview,
      ...(modelReviewError ? { modelReviewError } : {}),
    });
  }

  persist(output: QAReport, input: QAAgentInput, ctx: AgentRunContext): void {
    ctx.tools.production.saveArtifact(input.productionId, 'QA_REPORT', output);
  }
}
