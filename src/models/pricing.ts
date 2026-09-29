import type { CostEstimate, TokenUsage } from './types.js';

/**
 * Approximate list prices in USD per 1M tokens, used only for *estimates*.
 * Prices change — treat these as configuration, not truth. Models missing
 * from this table report `estimatedApiCost: null` rather than a made-up figure.
 */
export const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'anthropic:claude-sonnet-5-5': { input: 3, output: 15 },
  'anthropic:claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai:gpt-4o': { input: 2.5, output: 10 },
  'gemini:gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini:gemini-2.5-pro': { input: 1.25, output: 10 },
};

export function estimateCloudCost(provider: string, model: string, usage: TokenUsage): CostEstimate {
  const price = PRICING_PER_MILLION[`${provider}:${model}`];
  if (!price || usage.inputTokens === null || usage.outputTokens === null) {
    return {
      estimatedApiCost: null,
      executionCostType: 'API',
      currency: 'USD',
      basis: price ? 'token usage not reported' : 'no pricing entry for model',
    };
  }
  const cost = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return {
    estimatedApiCost: Math.round(cost * 1_000_000) / 1_000_000,
    executionCostType: 'API',
    currency: 'USD',
    basis: `list-price estimate (${price.input}/${price.output} USD per 1M in/out tokens)`,
  };
}

/** Local inference has no API charge, but it is not literally free. */
export const LOCAL_COMPUTE_COST: CostEstimate = {
  estimatedApiCost: 0,
  executionCostType: 'LOCAL_COMPUTE',
  currency: 'USD',
  basis: 'no API charge; consumes local compute (hardware, power)',
};

export const MOCK_COST: CostEstimate = {
  estimatedApiCost: 0,
  executionCostType: 'NONE',
  currency: 'USD',
  basis: 'deterministic mock provider; no model inference',
};
