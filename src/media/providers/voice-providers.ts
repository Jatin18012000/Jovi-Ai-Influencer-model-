import { ProviderError } from '../../core/errors.js';
import { nowIso } from '../../core/ids.js';
import { LOCAL_COMPUTE_COST } from '../../models/pricing.js';
import { BYTE_CAPS, readBodyCapped, readErrorSnippet } from '../../models/providers/http.js';
import type { CostEstimate } from '../../models/types.js';
import type { MediaStore } from '../media-store.js';
import { runProcess } from '../process-runner.js';
import type { AspectRatio, MediaCapabilities, MediaGenerationResult, MediaProviderStatus, VoiceGenerationProvider, VoiceGenerationRequest } from '../types.js';

const ALL_RATIOS: AspectRatio[] = ['9:16', '4:5', '1:1', '16:9'];

// ---------------------------------------------------------------------------
// macOS `say` (LOCAL)
// ---------------------------------------------------------------------------

export interface MacOSSayOptions {
  sayPath: string;
  /** Human-approved system voice for Jovi (MACOS_SAY_VOICE); unset = NOT_CONFIGURED. */
  voice: string | undefined;
  timeoutMs: number;
  /** Tests may run a stand-in binary on other platforms. */
  requireDarwin?: boolean;
  statusTtlMs?: number;
}

/** Words per minute by script pacing. */
const SAY_RATE = { slow: 160, natural: 185, fast: 210 } as const;

/** Parses `say -v ?` output lines: "Name   en_GB    # sample sentence". */
export function parseSayVoices(output: string): Array<{ name: string; language: string }> {
  return output
    .split('\n')
    .map((line) => /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1]!.trim(), language: m[2]!.replace('_', '-') }));
}

/**
 * Local speech synthesis with macOS `say`, writing 16-bit WAV. Free, offline
 * and deterministic enough for drafts; the voice must be chosen and approved
 * by a human (MACOS_SAY_VOICE). Text is passed on stdin, never as arguments.
 */
export class MacOSSayVoiceProvider implements VoiceGenerationProvider {
  readonly id = 'macos-say';
  readonly kind = 'LOCAL' as const;
  readonly mediaKind = 'VOICE' as const;
  private cached: { at: number; status: MediaProviderStatus; language: string | null } | null = null;

  constructor(
    private readonly options: MacOSSayOptions,
    private readonly store: MediaStore,
  ) {}

  supportedModels(): string[] {
    return this.options.voice ? [`say:${this.options.voice}`] : [];
  }

  capabilities(): MediaCapabilities {
    const language = this.cached?.language ?? null;
    return { aspectRatios: ALL_RATIOS, maxDurationSeconds: null, imageToVideo: false, referenceImages: false, languages: language ? [language.split('-')[0]!] : null, outputFormats: ['.wav'] };
  }

  estimateCost() {
    return LOCAL_COMPUTE_COST;
  }

  async inspectAvailability(): Promise<MediaProviderStatus> {
    const ttl = this.options.statusTtlMs ?? 60_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.status;
    const base = { provider: this.id, kind: this.kind, mediaKind: this.mediaKind, models: this.supportedModels(), checkedAt: nowIso() };
    let status: MediaProviderStatus;
    let language: string | null = null;
    if (!this.options.voice) {
      status = { ...base, available: false, state: 'NOT_CONFIGURED', reason: 'MACOS_SAY_VOICE not set (choose and approve a system voice for Jovi)' };
    } else if ((this.options.requireDarwin ?? true) && process.platform !== 'darwin') {
      status = { ...base, available: false, state: 'UNREACHABLE', reason: `macOS say is not available on ${process.platform}` };
    } else {
      try {
        const result = await runProcess(this.id, this.options.sayPath, ['-v', '?'], { timeoutMs: 15_000 });
        const voices = parseSayVoices(result.stdout);
        const match = voices.find((v) => v.name.toLowerCase() === this.options.voice!.toLowerCase());
        if (result.code !== 0) status = { ...base, available: false, state: 'MISCONFIGURED', reason: `say exited with code ${result.code}` };
        else if (!match) status = { ...base, available: false, state: 'MISCONFIGURED', reason: `voice "${this.options.voice}" is not installed (${voices.length} voices found; see \`say -v '?'\`)` };
        else {
          language = match.language;
          status = { ...base, available: true, state: 'AVAILABLE', reason: `voice ${match.name} (${match.language})`, details: { voice: match.name, language: match.language } };
        }
      } catch (error) {
        status = { ...base, available: false, state: 'UNREACHABLE', reason: `say not runnable at ${this.options.sayPath}: ${(error as Error).message}` };
      }
    }
    this.cached = { at: Date.now(), status, language };
    return status;
  }

  async synthesizeSpeech(request: VoiceGenerationRequest): Promise<MediaGenerationResult> {
    if (!this.options.voice) throw new ProviderError(this.id, 'MACOS_SAY_VOICE not set', { retryable: false });
    const output = this.store.prepare(request.productionId, request.assetId, '.wav');
    const started = Date.now();
    const result = await runProcess(
      this.id,
      this.options.sayPath,
      ['-v', this.options.voice, '-r', String(SAY_RATE[request.pacing]), '--file-format=WAVE', '--data-format=LEI16@22050', '-o', output, '-f', '-'],
      { timeoutMs: this.options.timeoutMs, stdin: request.text },
    );
    if (result.code !== 0) throw new ProviderError(this.id, `say exited with code ${result.code}: ${result.stderr.slice(0, 300)}`, { retryable: false });
    return {
      provider: this.id,
      model: `say:${this.options.voice}`,
      status: 'COMPLETED',
      location: output,
      mimeType: 'audio/wav',
      cost: LOCAL_COMPUTE_COST,
      metadata: { voice: this.options.voice, rateWpm: SAY_RATE[request.pacing], synthesisMs: Date.now() - started },
    };
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs (CLOUD)
// ---------------------------------------------------------------------------

export interface ElevenLabsOptions {
  apiKey: string | undefined;
  /** Human-approved voice id for Jovi (ELEVENLABS_VOICE_ID). */
  voiceId: string | undefined;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  statusTtlMs?: number;
}

const ELEVENLABS_COST: CostEstimate = { estimatedApiCost: null, executionCostType: 'API', currency: 'USD', basis: 'ElevenLabs character-based pricing (plan dependent; not estimated)' };

/**
 * Cloud speech synthesis via the ElevenLabs text-to-speech HTTP API
 * (POST /v1/text-to-speech/{voice_id}, MP3 output). Requires an API key and a
 * human-approved voice id. The key is sent only as the xi-api-key header and
 * never logged. Excluded automatically for LOCAL_ONLY productions.
 */
export class ElevenLabsVoiceProvider implements VoiceGenerationProvider {
  readonly id = 'elevenlabs';
  readonly kind = 'CLOUD' as const;
  readonly mediaKind = 'VOICE' as const;
  private cached: { at: number; status: MediaProviderStatus } | null = null;

  constructor(
    private readonly options: ElevenLabsOptions,
    private readonly store: MediaStore,
  ) {}

  supportedModels(): string[] {
    return [this.options.model];
  }

  capabilities(): MediaCapabilities {
    return { aspectRatios: ALL_RATIOS, maxDurationSeconds: null, imageToVideo: false, referenceImages: false, languages: null, outputFormats: ['.mp3'] };
  }

  estimateCost() {
    return ELEVENLABS_COST;
  }

  private url(path: string) {
    return `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async inspectAvailability(): Promise<MediaProviderStatus> {
    const ttl = this.options.statusTtlMs ?? 60_000;
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.status;
    const base = { provider: this.id, kind: this.kind, mediaKind: this.mediaKind, models: this.supportedModels(), checkedAt: nowIso() };
    let status: MediaProviderStatus;
    if (!this.options.apiKey) status = { ...base, available: false, state: 'NOT_CONFIGURED', reason: 'ELEVENLABS_API_KEY not set' };
    else if (!this.options.voiceId) status = { ...base, available: false, state: 'MISCONFIGURED', reason: 'ELEVENLABS_VOICE_ID not set (choose and approve a voice for Jovi)' };
    else {
      try {
        const response = await fetch(this.url(`/v1/voices/${encodeURIComponent(this.options.voiceId)}`), {
          headers: { 'xi-api-key': this.options.apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const voice = (await readBodyCapped(response, BYTE_CAPS.json, this.id)
            .then((b) => JSON.parse(b.toString('utf8')) as unknown)
            .catch(() => ({}))) as { name?: string };
          status = { ...base, available: true, state: 'AVAILABLE', reason: `voice ${voice.name ?? this.options.voiceId}`, details: { voice: voice.name ?? null } };
        } else if (response.status === 401 || response.status === 403) status = { ...base, available: false, state: 'MISCONFIGURED', reason: `API key rejected (HTTP ${response.status})` };
        else if (response.status === 404) status = { ...base, available: false, state: 'MISCONFIGURED', reason: `voice ${this.options.voiceId} not found` };
        else status = { ...base, available: false, state: 'UNREACHABLE', reason: `HTTP ${response.status}` };
      } catch (error) {
        status = { ...base, available: false, state: 'UNREACHABLE', reason: `ElevenLabs not reachable: ${(error as Error).message}` };
      }
    }
    this.cached = { at: Date.now(), status };
    return status;
  }

  async synthesizeSpeech(request: VoiceGenerationRequest): Promise<MediaGenerationResult> {
    if (!this.options.apiKey || !this.options.voiceId) throw new ProviderError(this.id, 'ElevenLabs is not configured', { retryable: false });
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(this.url(`/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}?output_format=mp3_44100_128`), {
        method: 'POST',
        headers: { 'xi-api-key': this.options.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: request.text, model_id: this.options.model }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ProviderError(this.id, timedOut ? `request timed out after ${this.options.timeoutMs}ms` : `network error: ${(error as Error).message}`, { retryable: true, cause: error });
    }
    if (!response.ok) {
      const body = await readErrorSnippet(response);
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(this.id, `HTTP ${response.status}: ${body}`, { retryable, status: response.status });
    }
    const bytes = await readBodyCapped(response, BYTE_CAPS.audio, this.id);
    const output = this.store.write(request.productionId, request.assetId, '.mp3', bytes);
    return {
      provider: this.id,
      model: this.options.model,
      status: 'COMPLETED',
      location: output,
      mimeType: 'audio/mpeg',
      cost: ELEVENLABS_COST,
      metadata: { voiceId: this.options.voiceId, characters: request.text.length, synthesisMs: Date.now() - started },
    };
  }
}
