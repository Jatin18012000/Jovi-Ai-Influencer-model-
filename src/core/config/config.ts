import { z } from 'zod';
import { PermissionLevel } from '../../types/enums.js';

/**
 * Runtime configuration. Secrets come exclusively from environment variables
 * and are never logged, persisted, or placed into prompts.
 */

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined));

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

  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  OLLAMA_ENABLED: booleanFlag(true),

  /** Deterministic offline provider. Off by default so real runs never silently use canned output. */
  JOVI_ENABLE_MOCK_PROVIDER: booleanFlag(false),

  /** Comma separated preference order for cloud providers. */
  JOVI_CLOUD_PREFERENCE: z.string().default('anthropic,openai,gemini'),
  JOVI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  JOVI_PROVIDER_STATUS_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),

  JOVI_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOVI_JOB_BACKOFF_MS: z.coerce.number().int().nonnegative().default(2_000),
  JOVI_WORKER_ENABLED: booleanFlag(true),
  JOVI_WORKER_POLL_MS: z.coerce.number().int().positive().default(1_000),

  /** Hard ceiling for any agent's permissions in this deployment (Phase 6: no external actions). */
  JOVI_MAX_PERMISSION_LEVEL: PermissionLevel.default('LEVEL_3_EXECUTE'),

  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Optional bearer token for the API. Unset = no auth (local development only). */
  JOVI_API_TOKEN: optionalSecret,

  JOVI_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type JoviConfig = {
  env: string;
  database: { url: string; autoSeed: boolean };
  providers: {
    anthropic: { apiKey: string | undefined; model: string; baseUrl: string };
    openai: { apiKey: string | undefined; model: string; baseUrl: string };
    gemini: { apiKey: string | undefined; model: string; baseUrl: string };
    ollama: { enabled: boolean; url: string; model: string | undefined };
    mock: { enabled: boolean };
    cloudPreference: string[];
    timeoutMs: number;
    statusTtlMs: number;
  };
  jobs: { maxAttempts: number; backoffMs: number; workerEnabled: boolean; workerPollMs: number };
  permissions: { maxLevel: PermissionLevel };
  api: { host: string; port: number; token: string | undefined };
  logLevel: z.infer<typeof EnvSchema>['JOVI_LOG_LEVEL'];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JoviConfig {
  const parsed = EnvSchema.parse(env);
  return {
    env: parsed.NODE_ENV,
    database: { url: parsed.DATABASE_URL, autoSeed: parsed.JOVI_AUTO_SEED },
    providers: {
      anthropic: { apiKey: parsed.ANTHROPIC_API_KEY, model: parsed.ANTHROPIC_MODEL, baseUrl: parsed.ANTHROPIC_BASE_URL },
      openai: { apiKey: parsed.OPENAI_API_KEY, model: parsed.OPENAI_MODEL, baseUrl: parsed.OPENAI_BASE_URL },
      gemini: { apiKey: parsed.GEMINI_API_KEY, model: parsed.GEMINI_MODEL, baseUrl: parsed.GEMINI_BASE_URL },
      ollama: { enabled: parsed.OLLAMA_ENABLED, url: parsed.OLLAMA_URL, model: parsed.OLLAMA_MODEL },
      mock: { enabled: parsed.JOVI_ENABLE_MOCK_PROVIDER },
      cloudPreference: parsed.JOVI_CLOUD_PREFERENCE.split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean),
      timeoutMs: parsed.JOVI_PROVIDER_TIMEOUT_MS,
      statusTtlMs: parsed.JOVI_PROVIDER_STATUS_TTL_MS,
    },
    jobs: {
      maxAttempts: parsed.JOVI_JOB_MAX_ATTEMPTS,
      backoffMs: parsed.JOVI_JOB_BACKOFF_MS,
      workerEnabled: parsed.JOVI_WORKER_ENABLED,
      workerPollMs: parsed.JOVI_WORKER_POLL_MS,
    },
    permissions: { maxLevel: parsed.JOVI_MAX_PERMISSION_LEVEL },
    api: { host: parsed.HOST, port: parsed.PORT, token: parsed.JOVI_API_TOKEN },
    logLevel: parsed.JOVI_LOG_LEVEL,
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
    },
    api: { ...config.api, token: mask(config.api.token) },
  };
}
