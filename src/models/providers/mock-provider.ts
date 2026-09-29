import { InvalidModelOutputError, ProviderError } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import type { ProviderKind } from '../../types/enums.js';
import { MOCK_COST } from '../pricing.js';
import { mockPlanning, mockProduction } from './mock-creative.js';
import type { GenerateRequest, GenerateResult, ModelProvider, ProviderStatus } from '../types.js';

export interface MockProviderOptions {
  id?: string;
  kind?: ProviderKind;
  model?: string;
  available?: boolean;
  /** Fail the first N generate calls. */
  failures?: number;
  failureMode?: 'TEMPORARY' | 'PERMANENT' | 'INVALID_OUTPUT';
  /** Custom output for tests; defaults to the built-in Jovi responses. */
  responder?: (request: GenerateRequest) => string | Promise<string>;
}

/**
 * SIMULATION / TEST ONLY. Deterministic, offline provider that performs no
 * inference: it returns canned, schema-valid Jovi responses so the pipeline
 * can be exercised without paid APIs or a local model. The provider registry
 * refuses to combine it with real providers, so it can never be a production
 * fallback; results are flagged `simulated: true`.
 */
export class MockProvider implements ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly calls: GenerateRequest[] = [];
  private failuresRemaining: number;

  constructor(private readonly options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.kind = options.kind ?? 'MOCK';
    this.model = options.model ?? 'jovi-mock-v1';
    this.failuresRemaining = options.failures ?? 0;
  }

  async checkAvailability(): Promise<ProviderStatus> {
    const available = this.options.available ?? true;
    return {
      provider: this.id,
      kind: this.kind,
      available,
      reason: available ? 'deterministic mock provider (no real inference)' : 'mock provider disabled',
      selectedModel: available ? this.model : null,
      models: available
        ? [{ provider: this.id, model: this.model, kind: this.kind, isDefault: true, capabilities: ['chat', 'json'] }]
        : [],
      checkedAt: nowIso(),
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(request);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      const mode = this.options.failureMode ?? 'TEMPORARY';
      if (mode === 'INVALID_OUTPUT') {
        return this.result('{"this is": "not a valid executive proposal"}');
      }
      throw new ProviderError(this.id, `simulated ${mode.toLowerCase()} failure`, { retryable: mode === 'TEMPORARY' });
    }
    const output = this.options.responder ? await this.options.responder(request) : defaultResponse(request);
    return this.result(output);
  }

  private result(output: string): GenerateResult {
    return {
      provider: this.id,
      model: this.model,
      executionType: this.kind,
      output,
      usage: { inputTokens: null, outputTokens: null },
      latencyMs: 1,
      cost: MOCK_COST,
      metadata: { mock: true },
    };
  }
}

function extractTag(prompt: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(prompt);
  return match?.[1]?.trim();
}

function defaultResponse(request: GenerateRequest): string {
  switch (request.task.type) {
    case 'executive.proposal':
      return JSON.stringify(mockExecutiveProposal(extractTag(request.context.prompt, 'goal') ?? 'Grow Jovi’s audience'));
    case 'evaluation.options':
      return JSON.stringify(mockEvaluation(extractTag(request.context.prompt, 'options_json')));
    default: {
      const canned = request.task.type.startsWith('planning.')
        ? mockPlanning(request.task.type, request.context.prompt)
        : mockProduction(request.task.type, request.context.prompt);
      if (canned !== null) return JSON.stringify(canned);
      throw new InvalidModelOutputError(`mock provider has no canned response for task type ${request.task.type}`);
    }
  }
}

export function mockExecutiveProposal(goal: string) {
  return {
    objective: goal,
    interpretation:
      "[SIMULATED — canned output, no model inference] Introduce Jovi to people who have never met her: in one short Reel they should get her humour, her taste and the fact that she's openly AI — and want to see what she does next.",
    priorities: [
      'Personality first: the viewer should remember Jovi, not a format',
      'Own the AI transparency with confidence and wit',
      'Hook in the first 2 seconds for discovery',
      "Give Jovi's Crew an easy way to join in (comment prompt)",
    ],
    contentDirection:
      'Playful, cheeky self-introduction anchored in real Jovi details (London, coffee, G-Wagen obsession, travel) with a light AI wink — confident, never corporate.',
    options: [
      {
        id: 'A',
        title: 'Two Truths and a Glitch',
        format: 'REEL',
        pillar: 'Entertainment & Personality',
        hook: '"Three facts about me. One of them is a glitch. Go."',
        concept:
          'Jovi rapid-fires three facts — London girl with Indian-Russian roots, has an unreasonable crush on modified G-Wagens, and "has never needed sleep" — then winks: the glitch is the one that gives away she\'s AI. Viewers guess in the comments.',
        structure: [
          '0–2s: direct-to-camera hook in a London café, coffee in hand',
          '2–10s: three quick-cut facts with matching B-roll (street, G-Wagen, city at night)',
          '10–13s: playful pause — "which one is the glitch?"',
          '13–15s: reveal teaser + "Welcome to Jovi\'s Crew"',
        ],
        personalityTraits: ['witty', 'playful', 'confident', 'mysterious'],
        audienceValue: 'An entertaining 15-second game that makes her AI identity a charming reveal instead of a disclaimer.',
        originalityNote: 'Turns AI transparency into the punchline of a classic game rather than hiding it.',
        risks: ['Reveal must stay clearly honest that Jovi is AI — no ambiguity about being human'],
        estimatedEffort: 'MEDIUM',
      },
      {
        id: 'B',
        title: 'My London, in Five Coffees',
        format: 'REEL',
        pillar: 'Travel & Exploration',
        hook: '"Rating London by its coffee — because that\'s how I judge every city."',
        concept:
          'Jovi hops between five hidden London cafés she researched in advance, rating each with a one-liner. Personality comes through the ratings; the last café is "the one I work from — not telling you which table."',
        structure: [
          '0–2s: hook with first coffee order',
          '2–12s: five fast café cuts with cheeky ratings',
          '12–15s: mysterious sign-off + "drop your city\'s best café"',
        ],
        personalityTraits: ['curious', 'cheeky', 'sophisticated'],
        audienceValue: 'Useful recommendations plus a clear taste profile; invites comments with city recs.',
        originalityNote: 'Café-hopping is common; the rating voice and mystery table give it Jovi flavour.',
        risks: ['Could read as a generic café listicle if the one-liners are weak'],
        estimatedEffort: 'MEDIUM',
      },
      {
        id: 'C',
        title: 'What My Touch-Up Bag Says About Me',
        format: 'REEL',
        pillar: 'Fashion & Beauty',
        hook: '"You can judge me by my bag. Everyone does."',
        concept:
          'Jovi empties her touch-up bag item by item — each product becomes a tiny personality reveal (always-done nails, the lipstick for spontaneous dinners, the sunglasses "for mountain views and bad decisions").',
        structure: [
          '0–2s: bag drop hook',
          '2–12s: item-by-item reveals with one-line personality jokes',
          '12–15s: "what\'s the one thing always in your bag?"',
        ],
        personalityTraits: ['feminine', 'witty', 'playful'],
        audienceValue: 'Relatable beauty content with personality in every beat.',
        originalityNote: 'What\'s-in-my-bag is a known format; strength depends on the jokes.',
        risks: ['Format is familiar — needs strong writing to avoid feeling generic'],
        estimatedEffort: 'LOW',
      },
    ],
    recommendedOptionId: 'A',
    rationaleSummary:
      '[SIMULATED] Option A introduces the most of Jovi in the fewest seconds — heritage, taste, humour and AI identity — and gives new viewers a reason to comment. B and C are strong follow-ups once the audience knows who she is.',
    confidence: 0.72,
    nextActions: [
      { action: 'Write the 15-second script and on-screen text for the selected concept', agent: 'script' },
      { action: 'Storyboard the selected concept consistent with the visual bible', agent: 'storyboard' },
      { action: 'Run QA against voice guide and privacy boundaries', agent: 'qa' },
      { action: 'Publish the Reel to Instagram once approved', agent: 'publishing' },
    ],
  };
}

function mockEvaluation(optionsJson: string | undefined) {
  let ids: string[] = ['A'];
  try {
    const parsed = JSON.parse(optionsJson ?? '[]') as Array<{ id?: string }>;
    const found = parsed.map((o) => o.id).filter((id): id is string => typeof id === 'string');
    if (found.length) ids = found;
  } catch {
    // Keep default ids.
  }
  return {
    evaluations: ids.map((id, index) => {
      const s = Math.max(2, 4 - index);
      return {
        optionId: id,
        scores: { quality: s, brandFit: s + (index === 0 ? 1 : 0), objectiveFit: s, originality: s, audienceFit: s, risk: 2, cost: 2 },
        strengths: [index === 0 ? 'Strong personality reveal' : 'Solid supporting concept'],
        concerns: [index === 0 ? 'Keep AI reveal unambiguous' : 'Less distinctive as an introduction'],
      };
    }),
    recommendedOptionId: ids[0],
    summary: '[SIMULATED] Mock evaluation: prefers the first option as the clearest personality introduction.',
  };
}
