import { z } from 'zod';
import { PermissionLevel } from '../../types/enums.js';

/**
 * Runtime configuration. Secrets come exclusively from environment variables
 * (optionally loaded from `.env` by the entry points, see load-env.ts) and are
 * never logged, persisted, or placed into prompts.
 */

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().default('data/jovi.db'),
  JOVI_AUTO_SEED: booleanFlag(true),

  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),

  OPENAI_API_KEY: optionalSecret,
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  GEMINI_API_KEY: optionalSecret,
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta'),

  /** LM Studio is the only local-model runtime (OpenAI-compatible local server). */
  LM_STUDIO_URL: z.string().default('http://localhost:1234/v1'),
  LM_STUDIO_MODEL: optionalString,
  LM_STUDIO_ENABLED: booleanFlag(true),
  /** Only needed if API authentication is enabled in LM Studio's server settings. */
  LM_STUDIO_API_KEY: optionalSecret,
  /** Local inference on a laptop can be slow; generous default (10 min). */
  LM_STUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  /**
   * Simulation mode: registers ONLY the deterministic MockProvider (no real
   * providers), and every result is flagged `simulated: true`. Never a fallback.
   */
  JOVI_SIMULATION_MODE: booleanFlag(false),

  /** Comma separated preference order for cloud providers. */
  JOVI_CLOUD_PREFERENCE: z.string().default('anthropic,openai,gemini'),
  /** Cloud request timeout. LM Studio uses LM_STUDIO_TIMEOUT_MS. */
  JOVI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  JOVI_PROVIDER_STATUS_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  /** May LOW-tier (local) tasks use a cloud provider when LM Studio is unavailable? */
  JOVI_ALLOW_CLOUD_FALLBACK: booleanFlag(true),

  JOVI_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOVI_JOB_BACKOFF_MS: z.coerce.number().int().nonnegative().default(2_000),
  JOVI_WORKER_ENABLED: booleanFlag(true),
  JOVI_WORKER_POLL_MS: z.coerce.number().int().positive().default(1_000),
  /** A job lock older than this (without heartbeat) is considered abandoned. */
  JOVI_JOB_STALE_MS: z.coerce.number().int().positive().default(300_000),
  JOVI_JOB_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),

  /** Hard ceiling for any agent's permissions in this deployment (Phase 6: no external actions). */
  JOVI_MAX_PERMISSION_LEVEL: PermissionLevel.default('LEVEL_3_EXECUTE'),

  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Bearer token for /api routes. Required when HOST is not a loopback address. */
  JOVI_API_TOKEN: optionalSecret,
  /** Escape hatch for container setups whose published port is itself loopback-only. */
  JOVI_ALLOW_UNAUTHENTICATED_NETWORK: booleanFlag(false),
  JOVI_GOAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  JOVI_MAX_CONCURRENT_GOALS: z.coerce.number().int().positive().default(2),

  /** Phase 8 media. ComfyUI is optional; unset = image/video providers report NOT_CONFIGURED. */
  COMFYUI_URL: optionalString,
  COMFYUI_IMAGE_WORKFLOW: optionalString,
  COMFYUI_VIDEO_WORKFLOW: optionalString,
  COMFYUI_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /** Where provider outputs are written (relative to the project root). */
  JOVI_MEDIA_DIR: z.string().default('data/media'),
  JOVI_MEDIA_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  JOVI_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Variables from earlier configurations that no longer do anything. */
const OBSOLETE_VARIABLES: Record<string, string> = {
  OLLAMA_URL: 'Ollama was removed; use LM_STUDIO_URL',
  OLLAMA_MODEL: 'Ollama was removed; use LM_STUDIO_MODEL',
  OLLAMA_ENABLED: 'Ollama was removed; use LM_STUDIO_ENABLED',
  JOVI_ENABLE_MOCK_PROVIDER: 'the mock is simulation-only; use JOVI_SIMULATION_MODE',
};

export type JoviConfig = {
  env: string;
  database: { url: string; autoSeed: boolean };
  providers: {
    anthropic: { apiKey: string | undefined; model: string; baseUrl: string };
    openai: { apiKey: string | undefined; model: string; baseUrl: string };
    gemini: { apiKey: string | undefined; model: string; baseUrl: string };
    lmstudio: { enabled: boolean; url: string; model: string | undefined; apiKey: string | undefined; timeoutMs: number };
    simulation: boolean;
    cloudPreference: string[];
    timeoutMs: number;
    statusTtlMs: number;
    allowCloudFallback: boolean;
  };
  jobs: {
    maxAttempts: number;
    backoffMs: number;
    workerEnabled: boolean;
    workerPollMs: number;
    staleMs: number;
    heartbeatMs: number;
  };
  permissions: { maxLevel: PermissionLevel };
  api: {
    host: string;
    port: number;
    token: string | undefined;
    allowUnauthenticatedNetwork: boolean;
    goalRateLimitPerMinute: number;
    maxConcurrentGoals: number;
  };
  media: {
    comfyuiUrl: string | undefined;
    comfyuiImageWorkflow: string | undefined;
    comfyuiVideoWorkflow: string | undefined;
    comfyuiTimeoutMs: number;
    dir: string;
    maxAttempts: number;
  };
  logLevel: z.infer<typeof EnvSchema>['JOVI_LOG_LEVEL'];
  /** Human-readable configuration warnings (e.g. obsolete variables). */
  warnings: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JoviConfig {
  const parsed = EnvSchema.parse(env);
  const warnings = Object.entries(OBSOLETE_VARIABLES)
    .filter(([name]) => env[name] !== undefined && env[name] !== '')
    .map(([name, hint]) => `${name} is obsolete and ignored: ${hint}`);
  return {
    env: parsed.NODE_ENV,
    database: { url: parsed.DATABASE_URL, autoSeed: parsed.JOVI_AUTO_SEED },
    providers: {
      anthropic: { apiKey: parsed.ANTHROPIC_API_KEY, model: parsed.ANTHROPIC_MODEL, baseUrl: parsed.ANTHROPIC_BASE_URL },
      openai: { apiKey: parsed.OPENAI_API_KEY, model: parsed.OPENAI_MODEL, baseUrl: parsed.OPENAI_BASE_URL },
      gemini: { apiKey: parsed.GEMINI_API_KEY, model: parsed.GEMINI_MODEL, baseUrl: parsed.GEMINI_BASE_URL },
      lmstudio: {
        enabled: parsed.LM_STUDIO_ENABLED,
        url: parsed.LM_STUDIO_URL,
        model: parsed.LM_STUDIO_MODEL,
        apiKey: parsed.LM_STUDIO_API_KEY,
        timeoutMs: parsed.LM_STUDIO_TIMEOUT_MS,
      },
      simulation: parsed.JOVI_SIMULATION_MODE,
      cloudPreference: parsed.JOVI_CLOUD_PREFERENCE.split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
      timeoutMs: parsed.JOVI_PROVIDER_TIMEOUT_MS,
      statusTtlMs: parsed.JOVI_PROVIDER_STATUS_TTL_MS,
      allowCloudFallback: parsed.JOVI_ALLOW_CLOUD_FALLBACK,
    },
    jobs: {
      maxAttempts: parsed.JOVI_JOB_MAX_ATTEMPTS,
      backoffMs: parsed.JOVI_JOB_BACKOFF_MS,
      workerEnabled: parsed.JOVI_WORKER_ENABLED,
      workerPollMs: parsed.JOVI_WORKER_POLL_MS,
      staleMs: parsed.JOVI_JOB_STALE_MS,
      heartbeatMs: Math.min(parsed.JOVI_JOB_HEARTBEAT_MS, Math.floor(parsed.JOVI_JOB_STALE_MS / 3)),
    },
    permissions: { maxLevel: parsed.JOVI_MAX_PERMISSION_LEVEL },
    api: {
      host: parsed.HOST,
      port: parsed.PORT,
      token: parsed.JOVI_API_TOKEN,
      allowUnauthenticatedNetwork: parsed.JOVI_ALLOW_UNAUTHENTICATED_NETWORK,
      goalRateLimitPerMinute: parsed.JOVI_GOAL_RATE_LIMIT_PER_MINUTE,
      maxConcurrentGoals: parsed.JOVI_MAX_CONCURRENT_GOALS,
    },
    media: {
      comfyuiUrl: parsed.COMFYUI_URL,
      comfyuiImageWorkflow: parsed.COMFYUI_IMAGE_WORKFLOW,
      comfyuiVideoWorkflow: parsed.COMFYUI_VIDEO_WORKFLOW,
      comfyuiTimeoutMs: parsed.COMFYUI_TIMEOUT_MS,
      dir: parsed.JOVI_MEDIA_DIR,
      maxAttempts: parsed.JOVI_MEDIA_MAX_ATTEMPTS,
    },
    logLevel: parsed.JOVI_LOG_LEVEL,
    warnings,
  };
}

/** Config view that is safe to log or return from the API. */
export function redactConfig(config: JoviConfig): Record<string, unknown> {
  const mask = (value: string | undefined) => (value ? 'configured' : 'missing');
  return {
    ...config,
    providers: {
      ...config.providers,
      anthropic: { ...config.providers.anthropic, apiKey: mask(config.providers.anthropic.apiKey) },
      openai: { ...config.providers.openai, apiKey: mask(config.providers.openai.apiKey) },
      gemini: { ...config.providers.gemini, apiKey: mask(config.providers.gemini.apiKey) },
      lmstudio: { ...config.providers.lmstudio, apiKey: mask(config.providers.lmstudio.apiKey) },
    },
    api: { ...config.api, token: mask(config.api.token) },
  };
}
