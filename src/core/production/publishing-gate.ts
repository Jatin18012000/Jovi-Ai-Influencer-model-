import type { MediaAsset } from './asset-service.js';
import type { Production } from './production-service.js';

export interface PublishingGateResult {
  /** Every precondition for a (future, human-operated) publish is met. */
  eligibleForHumanPublishing: boolean;
  /** Always false: Phase 8 has no autonomous or automated publishing path. */
  autonomousPublishingAllowed: false;
  blockers: string[];
}

/**
 * Evaluates whether a production could be handed to a human publishing step.
 * It never publishes: there is no publish function, tool, endpoint or
 * production state for publishing in Phase 8.
 */
export function evaluatePublishingGate(production: Production, allAssets: MediaAsset[], approvalAttestationBlocker: string | null = null): PublishingGateResult {
  const blockers: string[] = [];
  // Superseded assets were replaced by a human-requested regeneration; they are audit history only.
  const assets = allAssets.filter((a) => a.status !== 'SUPERSEDED');
  if (production.qaStatus !== 'PASS' && production.qaStatus !== 'PASS_WITH_WARNINGS') {
    blockers.push(`QA status is ${production.qaStatus ?? 'not run'}`);
  }
  if (production.status !== 'APPROVED') blockers.push(`production status is ${production.status}; human approval is required`);
  if (approvalAttestationBlocker) blockers.push(approvalAttestationBlocker);
  if (production.simulated || assets.some((a) => a.simulated)) blockers.push('production contains simulated assets');
  const render = assets.find((a) => a.kind === 'RENDER' && a.status === 'COMPLETED');
  if (!render) blockers.push('no completed final render exists');
  const placeholders = (render?.metadata as { placeholderScenes?: string[] } | null)?.placeholderScenes ?? [];
  if (placeholders.length) blockers.push(`final render has placeholder (black) scenes: ${placeholders.join(', ')}`);
  const unusable = assets.filter((a) => ['FAILED', 'BLOCKED', 'REJECTED'].includes(a.status));
  if (unusable.length) blockers.push(`${unusable.length} asset(s) failed, blocked or rejected`);
  return { eligibleForHumanPublishing: blockers.length === 0, autonomousPublishingAllowed: false, blockers };
}
