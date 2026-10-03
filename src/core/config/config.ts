import { z } from 'zod';
import { PermissionLevel } from '../../types/enums.js';
import { assertStrongToken, parseScopes, type ApiScope } from '../auth/api-credentials.js';
import { ValidationError } from '../errors.js';

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

/** R-17: optional SHA-256 pin (64 hex characters). */
const optionalSha256 = optionalString.refine((v) => v === undefined || /^[0-9a-f]{64}$/i.test(v), 'must be a 64-character hex SHA-256');

/** True for localhost / loopback hosts (used for trust warnings). */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

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
  /**
   * Optional operator bearer token (≥ 32 chars). Authentication is ALWAYS
   * required; without this, use scoped credentials (`npm run jovi -- --api-token create`).
   */
  JOVI_API_TOKEN: optionalSecret,
  /** R-13: the previous operator token, accepted alongside JOVI_API_TOKEN during a rollover. */
  JOVI_API_TOKEN_PREVIOUS: optionalSecret,
  /** Scopes granted to JOVI_API_TOKEN (default: read,operate — no approval, no identity changes). */
  JOVI_API_TOKEN_SCOPES: z.string().default('read,operate'),
  /** Host header values the API answers to (DNS-rebinding defence). Loopback names are always allowed. */
  JOVI_ALLOWED_HOSTS: z.string().default(''),
  /** Extra browser origins allowed to call the API (e.g. a future dashboard), comma-separated. */
  JOVI_ALLOWED_ORIGINS: z.string().default(''),
  /** Allow binding beyond loopback (containers). Authentication stays mandatory; use a TLS proxy. */
  JOVI_ALLOW_NETWORK_BIND: booleanFlag(false),
  JOVI_GOAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  JOVI_MAX_CONCURRENT_GOALS: z.coerce.number().int().positive().default(2),
  // R-05 resource limits.
  JOVI_MAX_QUEUED_JOBS: z.coerce.number().int().positive().default(20),
  JOVI_WRITE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
  JOVI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  JOVI_MAX_EXTERNAL_MEMORY_ITEMS: z.coerce.number().int().positive().default(500),
  JOVI_MAX_MEDIA_REGENERATIONS: z.coerce.number().int().min(0).default(5),
  JOVI_MEDIA_QUOTA_MB: z.coerce.number().int().positive().default(20_480),
  JOVI_SUPERSEDED_RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
  /** Daily cap on estimated cloud spend (model + media). 0 disables cloud providers. */
  JOVI_DAILY_CLOUD_BUDGET_USD: z.coerce.number().min(0).default(10),

  /** Phase 8 media. ComfyUI is optional; unset = image/video providers report NOT_CONFIGURED. */
  COMFYUI_URL: optionalString,
  COMFYUI_IMAGE_WORKFLOW: optionalString,
  COMFYUI_VIDEO_WORKFLOW: optionalString,
  COMFYUI_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /** Where provider outputs are written (relative to the project root). */
  JOVI_MEDIA_DIR: z.string().default('data/media'),
  JOVI_MEDIA_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  /** Phase 9 media. Every real provider is opt-in: unset = NOT_CONFIGURED. */
  /** Comma-separated media provider ids tried first (e.g. "comfyui-image,macos-say"). */
  JOVI_MEDIA_PROVIDER_PREFERENCE: z.string().default(''),
  /** Human-approved reference images (e.g. Jovi's reference sheet) live here. */
  JOVI_REFERENCE_DIR: z.string().default('data/references'),
  /** ffmpeg render engine, e.g. /opt/homebrew/bin/ffmpeg or "ffmpeg". */
  JOVI_FFMPEG_PATH: optionalString,
  /** Optional ffprobe for measuring durations/dimensions of generated media. */
  JOVI_FFPROBE_PATH: optionalString,
  JOVI_FFMPEG_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** macOS `say` voice (a human-approved system voice name, e.g. "Serena"). */
  MACOS_SAY_VOICE: optionalString,
  MACOS_SAY_PATH: z.string().default('/usr/bin/say'),
  ELEVENLABS_API_KEY: optionalSecret,
  /** Human-approved ElevenLabs voice id for Jovi. */
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  JOVI_VOICE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** R-17 trust pins (optional): SHA-256 of executables (absolute paths required) and approved workflows. */
  JOVI_FFMPEG_SHA256: optionalSha256,
  JOVI_FFPROBE_SHA256: optionalSha256,
  MACOS_SAY_SHA256: optionalSha256,
  COMFYUI_IMAGE_WORKFLOW_SHA256: optionalSha256,
  COMFYUI_VIDEO_WORKFLOW_SHA256: optionalSha256,

  /** R-18 retention. Events: 0 keeps the audit log forever (default). Agent/model runs hold prompts and outputs. */
  JOVI_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  JOVI_RUN_RETENTION_DAYS: z.coerce.number().int().min(0).default(180),

  JOVI_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Variables from earlier configurations that no longer do anything. */
const OBSOLETE_VARIABLES: Record<string, string> = {
  OLLAMA_URL: 'Ollama was removed; use LM_STUDIO_URL',
  OLLAMA_MODEL: 'Ollama was removed; use LM_STUDIO_MODEL',
  OLLAMA_ENABLED: 'Ollama was removed; use LM_STUDIO_ENABLED',
  JOVI_ENABLE_MOCK_PROVIDER: 'the mock is simulation-only; use JOVI_SIMULATION_MODE',
  JOVI_ALLOW_UNAUTHENTICATED_NETWORK: 'authentication is now always required; use JOVI_ALLOW_NETWORK_BIND to bind beyond loopback',
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
    /** R-05: non-terminal jobs allowed in the queue (enqueue beyond → 429). */
    maxQueued: number;
  };
  /** R-05: daily estimated cloud spend cap (USD, UTC day). */
  budget: { dailyCloudUsd: number };
  memory: { maxExternalItems: number };
  permissions: { maxLevel: PermissionLevel };
  api: {
    host: string;
    port: number;
    token: string | undefined;
    previousToken: string | undefined;
    tokenScopes: ApiScope[];
    allowedHosts: string[];
    allowedOrigins: string[];
    allowNetworkBind: boolean;
    goalRateLimitPerMinute: number;
    maxConcurrentGoals: number;
    /** R-05: per-principal limit for memory writes, decisions and visual identity changes. */
    writeRateLimitPerMinute: number;
    /** R-05: time allowed to receive a whole request (slow-client defence; not a response timeout). */
    requestTimeoutMs: number;
  };
  media: {
    comfyuiUrl: string | undefined;
    comfyuiImageWorkflow: string | undefined;
    comfyuiVideoWorkflow: string | undefined;
    comfyuiTimeoutMs: number;
    dir: string;
    maxAttempts: number;
    providerPreference: string[];
    referenceDir: string;
    ffmpegPath: string | undefined;
    ffprobePath: string | undefined;
    ffmpegTimeoutMs: number;
    sayVoice: string | undefined;
    sayPath: string;
    elevenlabs: { apiKey: string | undefined; voiceId: string | undefined; model: string; baseUrl: string };
    voiceTimeoutMs: number;
    maxRegenerations: number;
    quotaBytes: number;
    supersededRetentionDays: number;
    /** R-17: SHA-256 pins for executables and workflows (undefined = not pinned). */
    pins: { ffmpeg?: string; ffprobe?: string; say?: string; imageWorkflow?: string; videoWorkflow?: string };
  };
  /** R-18: retention in days (0 = keep forever). */
  retention: { eventDays: number; runDays: number };
  logLevel: z.infer<typeof EnvSchema>['JOVI_LOG_LEVEL'];
  /** Human-readable configuration warnings (e.g. obsolete variables). */
  warnings: string[];
};

const list = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** Loopback names are always allowed; a specific bind host and JOVI_ALLOWED_HOSTS are added. */
function allowedHostsFor(bindHost: string, extra: string): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  const bind = bindHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (bind !== '0.0.0.0' && bind !== '::') hosts.add(bind);
  for (const h of list(extra)) hosts.add(h.toLowerCase().replace(/^\[|\]$/g, ''));
  return [...hosts];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JoviConfig {
  const parsed = EnvSchema.parse(env);
  if (parsed.JOVI_API_TOKEN) assertStrongToken(parsed.JOVI_API_TOKEN);
  if (parsed.JOVI_API_TOKEN_PREVIOUS) {
    if (!parsed.JOVI_API_TOKEN) throw new ValidationError('JOVI_API_TOKEN_PREVIOUS is only valid together with JOVI_API_TOKEN (rollover)');
    assertStrongToken(parsed.JOVI_API_TOKEN_PREVIOUS, 'JOVI_API_TOKEN_PREVIOUS');
  }
  const warnings = Object.entries(OBSOLETE_VARIABLES)
    .filter(([name]) => env[name] !== undefined && env[name] !== '')
    .map(([name, hint]) => `${name} is obsolete and ignored: ${hint}`);
  // R-17: pinned executables must be absolute paths (a PATH lookup could resolve to a different binary).
  for (const [pin, path, name] of [
    [parsed.JOVI_FFMPEG_SHA256, parsed.JOVI_FFMPEG_PATH, 'JOVI_FFMPEG_PATH'],
    [parsed.JOVI_FFPROBE_SHA256, parsed.JOVI_FFPROBE_PATH, 'JOVI_FFPROBE_PATH'],
    [parsed.MACOS_SAY_SHA256, parsed.MACOS_SAY_PATH, 'MACOS_SAY_PATH'],
  ] as const) {
    if (pin && !(path ?? '').startsWith('/')) throw new ValidationError(`${name} must be an absolute path when its SHA-256 pin is set`);
  }
  // R-17: LM Studio and ComfyUI are unauthenticated plain-HTTP services; reaching them off-loopback is a trust decision.
  if (parsed.LM_STUDIO_ENABLED && !isLoopbackUrl(parsed.LM_STUDIO_URL)) {
    warnings.push(`LM_STUDIO_URL ${parsed.LM_STUDIO_URL} is not loopback: prompts and outputs travel over plain HTTP to a server Jovi cannot authenticate`);
  }
  if (parsed.COMFYUI_URL && !isLoopbackUrl(parsed.COMFYUI_URL)) {
    warnings.push(`COMFYUI_URL ${parsed.COMFYUI_URL} is not loopback: ComfyUI has no authentication; anyone who can reach it can run workflows and read uploads`);
  }
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
      maxQueued: parsed.JOVI_MAX_QUEUED_JOBS,
    },
    budget: { dailyCloudUsd: parsed.JOVI_DAILY_CLOUD_BUDGET_USD },
    memory: { maxExternalItems: parsed.JOVI_MAX_EXTERNAL_MEMORY_ITEMS },
    permissions: { maxLevel: parsed.JOVI_MAX_PERMISSION_LEVEL },
    api: {
      host: parsed.HOST,
      port: parsed.PORT,
      token: parsed.JOVI_API_TOKEN,
      previousToken: parsed.JOVI_API_TOKEN_PREVIOUS,
      tokenScopes: parseScopes(parsed.JOVI_API_TOKEN_SCOPES),
      allowedHosts: allowedHostsFor(parsed.HOST, parsed.JOVI_ALLOWED_HOSTS),
      allowedOrigins: list(parsed.JOVI_ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '').toLowerCase()),
      allowNetworkBind: parsed.JOVI_ALLOW_NETWORK_BIND,
      goalRateLimitPerMinute: parsed.JOVI_GOAL_RATE_LIMIT_PER_MINUTE,
      maxConcurrentGoals: parsed.JOVI_MAX_CONCURRENT_GOALS,
      writeRateLimitPerMinute: parsed.JOVI_WRITE_RATE_LIMIT_PER_MINUTE,
      requestTimeoutMs: parsed.JOVI_REQUEST_TIMEOUT_MS,
    },
    media: {
      comfyuiUrl: parsed.COMFYUI_URL,
      comfyuiImageWorkflow: parsed.COMFYUI_IMAGE_WORKFLOW,
      comfyuiVideoWorkflow: parsed.COMFYUI_VIDEO_WORKFLOW,
      comfyuiTimeoutMs: parsed.COMFYUI_TIMEOUT_MS,
      dir: parsed.JOVI_MEDIA_DIR,
      maxAttempts: parsed.JOVI_MEDIA_MAX_ATTEMPTS,
      providerPreference: parsed.JOVI_MEDIA_PROVIDER_PREFERENCE.split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      referenceDir: parsed.JOVI_REFERENCE_DIR,
      ffmpegPath: parsed.JOVI_FFMPEG_PATH,
      ffprobePath: parsed.JOVI_FFPROBE_PATH,
      ffmpegTimeoutMs: parsed.JOVI_FFMPEG_TIMEOUT_MS,
      sayVoice: parsed.MACOS_SAY_VOICE,
      sayPath: parsed.MACOS_SAY_PATH,
      elevenlabs: { apiKey: parsed.ELEVENLABS_API_KEY, voiceId: parsed.ELEVENLABS_VOICE_ID, model: parsed.ELEVENLABS_MODEL, baseUrl: parsed.ELEVENLABS_BASE_URL },
      voiceTimeoutMs: parsed.JOVI_VOICE_TIMEOUT_MS,
      maxRegenerations: parsed.JOVI_MAX_MEDIA_REGENERATIONS,
      quotaBytes: parsed.JOVI_MEDIA_QUOTA_MB * 1024 * 1024,
      supersededRetentionDays: parsed.JOVI_SUPERSEDED_RETENTION_DAYS,
      pins: {
        ...(parsed.JOVI_FFMPEG_SHA256 ? { ffmpeg: parsed.JOVI_FFMPEG_SHA256 } : {}),
        ...(parsed.JOVI_FFPROBE_SHA256 ? { ffprobe: parsed.JOVI_FFPROBE_SHA256 } : {}),
        ...(parsed.MACOS_SAY_SHA256 ? { say: parsed.MACOS_SAY_SHA256 } : {}),
        ...(parsed.COMFYUI_IMAGE_WORKFLOW_SHA256 ? { imageWorkflow: parsed.COMFYUI_IMAGE_WORKFLOW_SHA256 } : {}),
        ...(parsed.COMFYUI_VIDEO_WORKFLOW_SHA256 ? { videoWorkflow: parsed.COMFYUI_VIDEO_WORKFLOW_SHA256 } : {}),
      },
    },
    retention: { eventDays: parsed.JOVI_EVENT_RETENTION_DAYS, runDays: parsed.JOVI_RUN_RETENTION_DAYS },
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
    api: { ...config.api, token: mask(config.api.token), previousToken: mask(config.api.previousToken) },
    media: { ...config.media, elevenlabs: { ...config.media.elevenlabs, apiKey: mask(config.media.elevenlabs.apiKey) } },
  };
}
