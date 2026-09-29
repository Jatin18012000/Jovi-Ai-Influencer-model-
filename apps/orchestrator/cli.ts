import { parseArgs } from 'node:util';
import { createJoviCore, type JoviCore } from '../../src/core/bootstrap.js';
import { loadConfig } from '../../src/core/config/config.js';
import { createLogger } from '../../src/core/config/logger.js';
import type { GoalExecutionResult } from '../../src/core/orchestrator/orchestrator.js';
import { RoutingTier } from '../../src/types/enums.js';

const USAGE = `Jovi Core v0.1 CLI

Usage:
  npm run jovi -- "<goal>"                 Execute a goal through the Executive Agent
  npm run jovi -- --mock "<goal>"          Same, with the deterministic mock provider enabled
  npm run jovi -- --tier HIGH "<goal>"     Override routing tier (LOW | NORMAL | HIGH | STRATEGIC)
  npm run jovi -- --json "<goal>"          Print the raw JSON result
  npm run jovi -- --providers              Show model provider status
  npm run jovi -- --identity               Show Jovi's active identity

Logs go to stderr (level via JOVI_LOG_LEVEL, default "warn" for the CLI).
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mock: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      tier: { type: 'string' },
      providers: { type: 'boolean', default: false },
      identity: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig({ JOVI_LOG_LEVEL: 'warn', ...process.env });
  if (values.mock) config.providers.mock.enabled = true;
  const logger = createLogger(config.logLevel, 'jovi-cli', 'stderr');
  const core = await createJoviCore({ config, logger });

  try {
    if (values.providers) return await printProviders(core);
    if (values.identity) {
      process.stdout.write(`${JSON.stringify(core.identity.getActive(), null, 2)}\n`);
      return 0;
    }

    const goal = positionals.join(' ').trim();
    if (!goal) {
      process.stderr.write(USAGE);
      return 1;
    }
    const tier = values.tier ? RoutingTier.parse(values.tier.toUpperCase()) : undefined;

    const available = await core.providers.available();
    if (available.length === 0) {
      process.stderr.write(
        'No model provider is available.\n' +
          '  • Set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY, or\n' +
          '  • start Ollama (OLLAMA_URL) with an installed model, or\n' +
          '  • run with --mock (deterministic offline provider; no real inference).\n',
      );
      await printProviders(core);
      return 2;
    }

    const result = await core.orchestrator.executeGoal({ goal, ...(tier ? { tier } : {}), createdBy: 'cli' });
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printResult(result);
    return result.status === 'COMPLETED' ? 0 : 1;
  } finally {
    await core.close();
  }
}

async function printProviders(core: JoviCore): Promise<number> {
  const statuses = await core.providers.statusesFresh(true);
  process.stdout.write('\nModel providers\n');
  for (const s of statuses) {
    process.stdout.write(`  ${s.available ? '●' : '○'} ${s.provider.padEnd(10)} ${s.kind.padEnd(6)} ${(s.selectedModel ?? '-').padEnd(28)} ${s.reason}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

function printResult(r: GoalExecutionResult): void {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line();
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
  if (r.modelsUsed.some((m) => m.provider === 'mock')) {
    line('  (mock provider: deterministic canned output, no real model inference)');
  }
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
