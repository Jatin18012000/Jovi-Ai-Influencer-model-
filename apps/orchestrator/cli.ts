import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createJoviCore, type JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { loadEnvFile } from '../../src/core/config/load-env.js';
import { createLogger } from '../../src/core/config/logger.js';
import type { GoalExecutionResult } from '../../src/core/orchestrator/orchestrator.js';
import { VisualIdentityVersionInputSchema } from '../../src/core/identity/visual-identity.js';
import { newId } from '../../src/core/ids.js';
import { MediaKind, RoutingTier } from '../../src/types/enums.js';

const USAGE = `Jovi Core v0.1 CLI

Usage:
  npm run jovi -- "<goal>"                  Execute a goal through the Executive Agent
  npm run jovi -- --local-only "<goal>"     Keep generation + evaluation on LM Studio (no cloud)
  npm run jovi -- --tier HIGH "<goal>"      Override routing tier (LOW | NORMAL | HIGH | STRATEGIC)
  npm run jovi -- --json "<goal>"           Print the raw JSON result
  npm run jovi -- --providers               Show model provider status (incl. LM Studio discovery)
  npm run jovi -- --identity                Show Jovi's active identity
  npm run jovi -- --plan "<goal>"           Run Research → Trends → Strategy → Ideation
  npm run jovi -- --produce "<goal>"        Plan, then produce the recommended idea (script → … → QA)
  npm run jovi -- --produce --from-plan <planningTaskId> [--idea <ideaId>]
                                            Produce an idea from an existing Phase 7 planning task
  npm run jovi -- --production <productionId>          Show a production's status, assets and QA
  npm run jovi -- --decide <productionId> --decision APPROVE|REJECT --reviewer "<name>" [--acknowledge-warnings]
                                            Record a HUMAN approval decision (never publishes)
  npm run jovi -- --regenerate-media <productionId> --requested-by "<name>" [--kinds IMAGE,VIDEO,VOICE] [--include-completed]
                                            HUMAN request: regenerate media (script/storyboard/prompts reused), re-edit, re-QA
  npm run jovi -- --visual-identity         Show Jovi's active visual identity and its versions
  npm run jovi -- --set-visual-identity <profile.json> --approved-by "<name>" --summary "<why>"
                                            HUMAN action: record a new visual identity version (LOCKED when all anchors are set)
  npm run jovi -- --simulate ...            SIMULATION: canned mock output + simulated media only

Configuration is read from the environment and .env (see .env.example).
Logs go to stderr (level via JOVI_LOG_LEVEL, default "warn" for the CLI).
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      simulate: { type: 'boolean', default: false },
      'local-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      tier: { type: 'string' },
      providers: { type: 'boolean', default: false },
      identity: { type: 'boolean', default: false },
      plan: { type: 'boolean', default: false },
      produce: { type: 'boolean', default: false },
      'from-plan': { type: 'string' },
      idea: { type: 'string' },
      'aspect-ratio': { type: 'string' },
      production: { type: 'string' },
      decide: { type: 'string' },
      decision: { type: 'string' },
      reviewer: { type: 'string' },
      'acknowledge-warnings': { type: 'boolean', default: false },
      'regenerate-media': { type: 'string' },
      'requested-by': { type: 'string' },
      kinds: { type: 'string' },
      'include-completed': { type: 'boolean', default: false },
      'visual-identity': { type: 'boolean', default: false },
      'set-visual-identity': { type: 'string' },
      'approved-by': { type: 'string' },
      summary: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  loadEnvFile();
  const config = loadConfig({ JOVI_LOG_LEVEL: 'warn', ...process.env });
  if (values.simulate) config.providers.simulation = true;
  const logger = createLogger(config.logLevel, 'jovi-cli', 'stderr');
  const core = await createJoviCore({ config, logger });

  try {
    if (values.providers) return await printProviders(core);
    if (values.identity) {
      process.stdout.write(`${JSON.stringify(core.identity.getActive(), null, 2)}\n`);
      return 0;
    }

    if (values['visual-identity']) {
      process.stdout.write(`${JSON.stringify({ active: core.visualIdentity.getActive(), versions: core.visualIdentity.listVersions() }, null, 2)}\n`);
      return 0;
    }
    if (values['set-visual-identity']) {
      const input = VisualIdentityVersionInputSchema.parse({
        profile: JSON.parse(readFileSync(values['set-visual-identity'], 'utf8')) as unknown,
        approvedBy: values['approved-by'] ?? '',
        changeSummary: values.summary ?? '',
      });
      const active = core.visualIdentity.createVersion(input.profile, input.approvedBy, input.changeSummary);
      core.events.scope(newId('correlation')).emit('VISUAL_IDENTITY_VERSION_CREATED', 'cli', null, { version: active.version, status: active.status, approvedBy: input.approvedBy });
      process.stdout.write(`Visual identity v${active.version} recorded: ${active.status}${active.unlockedFields.length ? ` (unlocked: ${active.unlockedFields.join(', ')})` : ''}\n`);
      return 0;
    }
    if (values['regenerate-media']) {
      const kinds = values.kinds ? values.kinds.split(',').map((k) => MediaKind.parse(k.trim().toUpperCase())) : undefined;
      const result = await core.production.regenerateMedia(values['regenerate-media'], {
        requestedBy: values['requested-by'] ?? '',
        ...(kinds ? { kinds: kinds as Array<'IMAGE' | 'VIDEO' | 'VOICE'> } : {}),
        includeCompleted: values['include-completed'],
      });
      printProduction(result, values.json);
      return result.status === 'COMPLETED' ? 0 : 1;
    }

    if (values.production) {
      printProduction(core.production.getResult(values.production), values.json);
      return 0;
    }
    if (values.decide) {
      const production = core.productions.get(values.decide);
      const updated = core.productions.recordHumanDecision(
        values.decide,
        { decision: (values.decision ?? '').toUpperCase() as 'APPROVE' | 'REJECT', reviewer: values.reviewer ?? '', acknowledgeWarnings: values['acknowledge-warnings'] },
        core.events.scope(production.correlationId),
      );
      process.stdout.write(`${JSON.stringify({ production: { id: updated.id, status: updated.status, approvedBy: updated.approvedBy }, publishingGate: core.productions.publishingGate(updated.id) }, null, 2)}\n`);
      return 0;
    }

    const goal = positionals.join(' ').trim();
    if (!goal && !(values.produce && values['from-plan'])) {
      process.stderr.write(USAGE);
      return 1;
    }
    const tier = values.tier ? RoutingTier.parse(values.tier.toUpperCase()) : undefined;
    const localOnly = values['local-only'];

    const available = (await core.providers.available()).filter((s) => !localOnly || s.kind === 'LOCAL');
    if (available.length === 0 && !core.providers.isSimulation()) {
      process.stderr.write(
        `No ${localOnly ? 'local ' : ''}model provider is available.\n` +
          '  • Start LM Studio\'s local server and load a model (LM_STUDIO_URL, optional LM_STUDIO_MODEL), and/or\n' +
          (localOnly ? '' : '  • set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.\n') +
          '  • For a pipeline demo without any model: --simulate (canned output, clearly flagged).\n',
      );
      await printProviders(core);
      return 2;
    }

    if (values.produce) {
      const result = await core.production.start({
        ...(values['from-plan'] ? { planningTaskId: values['from-plan'], ...(values.idea ? { ideaId: values.idea } : {}) } : { goal }),
        ...(values['aspect-ratio'] ? { aspectRatio: values['aspect-ratio'] as '9:16' } : {}),
        ...(localOnly ? { privacy: 'LOCAL_ONLY' as const } : {}),
        createdBy: 'cli',
      });
      printProduction(result, values.json);
      return result.status === 'COMPLETED' ? 0 : 1;
    }

    if (values.plan) {
      const planning = await core.planning.execute({ goal, createdBy: 'cli' });
      process.stdout.write(`${JSON.stringify(planning, null, 2)}\n`);
      return planning.status === 'COMPLETED' ? 0 : 1;
    }

    const result = await core.orchestrator.executeGoal({
      goal,
      ...(tier ? { tier } : {}),
      ...(localOnly ? { privacy: 'LOCAL_ONLY' as const } : {}),
      createdBy: 'cli',
    });
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printResult(result);
    return result.status === 'COMPLETED' ? 0 : 1;
  } finally {
    await core.close();
  }
}

async function printProviders(core: JoviCore): Promise<number> {
  const statuses = await core.providers.statusesFresh(true);
  process.stdout.write(`\nModel providers${core.providers.isSimulation() ? ' (SIMULATION MODE)' : ''}\n`);
  for (const s of statuses) {
    process.stdout.write(`  ${s.available ? '●' : '○'} ${s.provider.padEnd(10)} ${s.kind.padEnd(6)} ${(s.selectedModel ?? '-').padEnd(28)} ${s.reason}\n`);
  }
  const lm = statuses.find((s) => s.provider === 'lmstudio')?.details as
    | { url: string; reachable: boolean; apiMode: string | null; modelsAvailable: string[]; loadedModels: string[] | null; selectedModel: string | null; loaded: boolean | null }
    | undefined;
  if (lm) {
    process.stdout.write('\nLM Studio:\n');
    process.stdout.write(`  url:             ${lm.url}\n`);
    process.stdout.write(`  reachable:       ${lm.reachable}\n`);
    process.stdout.write(`  api:             ${lm.apiMode ?? '-'}\n`);
    process.stdout.write(`  modelsAvailable: ${lm.modelsAvailable.length ? lm.modelsAvailable.join(', ') : '[]'}\n`);
    process.stdout.write(`  loadedModels:    ${lm.loadedModels === null ? 'unknown' : lm.loadedModels.length ? lm.loadedModels.join(', ') : '[]'}\n`);
    process.stdout.write(`  selectedModel:   ${lm.selectedModel ?? '-'}\n`);
    process.stdout.write(`  loaded:          ${lm.loaded === null ? 'unknown' : lm.loaded}\n`);
  }
  const media = await core.mediaProviders.statuses();
  process.stdout.write(`\nMedia providers${core.mediaProviders.isSimulation() ? ' (SIMULATION MODE)' : ''}\n`);
  const byId = new Map(core.mediaProviders.list().map((p) => [p.id, p]));
  for (const m of media) {
    process.stdout.write(`  ${m.available ? '●' : '○'} ${m.provider.padEnd(16)} ${m.mediaKind.padEnd(6)} ${m.kind.padEnd(5)} ${m.state.padEnd(15)} ${m.reason}\n`);
    const caps = byId.get(m.provider)?.capabilities();
    if (caps && m.available) {
      const flags = [caps.imageToVideo ? 'image-to-video' : null, caps.referenceImages ? 'reference-images' : null, caps.maxDurationSeconds ? `max ${caps.maxDurationSeconds}s` : null, caps.languages ? `lang ${caps.languages.join('/')}` : null].filter(Boolean);
      process.stdout.write(`      capabilities: ${caps.aspectRatios.join(' ')}${flags.length ? ` · ${flags.join(' · ')}` : ''}\n`);
    }
  }
  if (core.config.media.providerPreference.length) process.stdout.write(`  preference: ${core.config.media.providerPreference.join(' > ')}\n`);
  for (const kind of ['IMAGE', 'VIDEO', 'VOICE', 'RENDER'] as const) {
    if (!media.some((m) => m.mediaKind === kind)) process.stdout.write(`  ○ ${'(none)'.padEnd(16)} ${kind.padEnd(6)} NOT_CONFIGURED  no ${kind.toLowerCase()} provider is registered\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function printProduction(r: ReturnType<JoviCore['production']['getResult']>, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  const out: string[] = [''];
  if (r.simulated) out.push('*** SIMULATION — canned text and simulated media, NOT real generation ***');
  out.push(`Creative production — task ${r.status} · production ${r.productionStatus ?? '-'} · QA ${r.qaStatus ?? '-'}`);
  out.push(`  production ${r.productionId ?? '-'} · task ${r.taskId ?? '-'} · attempts ${r.attempts}${r.regenerations ? ` · media regenerations ${r.regenerations}` : ''}`);
  if (r.source) out.push(`  idea ${r.source.ideaId} "${r.source.ideaTitle}" (${r.source.type}${r.source.planningTaskId ? ` from ${r.source.planningTaskId}` : ''})`);
  out.push(`  artifacts: ${Object.entries(r.artifacts).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ')}`);
  out.push('  assets:');
  for (const a of r.assets.filter((x) => x.status !== 'SUPERSEDED')) out.push(`    - ${a.kind.padEnd(6)} ${String(a.sceneId ?? '-').padEnd(5)} ${a.status.padEnd(10)} ${a.provider ?? '-'}${a.reason ? ` — ${a.reason}` : ''}`);
  if (r.qa) {
    out.push(`  QA: ${r.qa.status} → ${r.qa.recommendedAction}`);
    for (const fix of r.qa.requiredFixes) out.push(`    • ${fix}`);
  }
  if (r.publishingGate) {
    out.push(`  publishing gate: eligibleForHumanPublishing=${r.publishingGate.eligibleForHumanPublishing}, autonomousPublishingAllowed=false`);
    for (const b of r.publishingGate.blockers) out.push(`    • ${b}`);
  }
  if (r.error) out.push(`  error: ${JSON.stringify(r.error)}`);
  process.stdout.write(`${out.join('\n')}\n`);
}

function printResult(r: GoalExecutionResult): void {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line();
  if (r.simulated) line('*** SIMULATION — canned mock output, NOT real model inference ***');
  line(`Jovi Core — goal ${r.status}`);
  line(`  task ${r.taskId} · job ${r.jobId} · attempts ${r.attempts}`);
  line(`  correlation ${r.correlationId}`);
  if (r.status !== 'COMPLETED') {
    line();
    line(`Error: ${JSON.stringify(r.error, null, 2)}`);
    process.stdout.write(`${out.join('\n')}\n`);
    return;
  }
  line(`  decision ${r.decisionId}`);
  line();
  line(`Objective: ${r.objective}`);
  line(`Interpretation: ${r.interpretation}`);
  line(`Direction: ${r.contentDirection}`);
  line();
  line('Options:');
  for (const o of r.options) {
    const mark = o.id === r.selectedAction?.id ? '★' : ' ';
    line(`  ${mark} [${o.id}] ${o.title} — ${o.format} · ${o.pillar}`);
    line(`       hook: ${o.hook}`);
  }
  if (r.selectedAction) {
    line();
    line(`Selected: [${r.selectedAction.id}] ${r.selectedAction.title}  (${r.selection?.method})`);
    line(`  ${r.selectedAction.concept}`);
    for (const beat of r.selectedAction.structure) line(`   • ${beat}`);
  }
  line();
  line(`Confidence: ${r.confidence}`);
  line(`Reasoning summary: ${r.reasoningSummary}`);
  line(`Evaluation: ${r.evaluationSummary}`);
  line();
  line('Next actions:');
  for (const a of r.nextActions) line(`  - [${a.agent}] ${a.action}  (${a.requiredPermission}${a.status === 'REQUIRES_APPROVAL' ? ', REQUIRES APPROVAL' : ''})`);
  line();
  line('Models used:');
  for (const m of r.modelsUsed) {
    const cost = m.estimatedApiCost === null ? 'cost unknown' : `$${m.estimatedApiCost} (${m.executionCostType})`;
    line(`  - ${m.purpose}: ${m.provider}:${m.model} · ${m.routingCategory}${m.fallbackUsed ? ' · FALLBACK' : ''} · ${m.latencyMs}ms · ${cost}`);
  }
  if (r.simulated) line('  (simulation: deterministic canned output, no real model inference)');
  line();
  line(`Events generated: ${r.eventsGenerated.length} (${[...new Set(r.eventsGenerated.map((e) => e.eventType))].join(', ')})`);
  process.stdout.write(`${out.join('\n')}\n`);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`jovi: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
