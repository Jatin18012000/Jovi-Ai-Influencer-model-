import type { JoviConfig } from '../../core/config/config.js';
import type { MediaStore } from '../media-store.js';
import type { AnyMediaProvider } from '../types.js';
import { ComfyUIImageProvider, ComfyUIVideoProvider } from './comfyui-providers.js';
import { FFmpegRenderProvider } from './ffmpeg-render-provider.js';
import { SimulatedImageProvider, SimulatedRenderProvider, SimulatedVideoProvider, SimulatedVoiceProvider } from './simulated-providers.js';
import { GoogleFlowVideoProvider } from './unintegrated-providers.js';
import { ElevenLabsVoiceProvider, MacOSSayVoiceProvider } from './voice-providers.js';

/**
 * Media providers from configuration. Every real provider is registered but
 * reports NOT_CONFIGURED until the operator configures it:
 *
 *   IMAGE   comfyui-image (LOCAL)            COMFYUI_URL + COMFYUI_IMAGE_WORKFLOW
 *   VIDEO   comfyui-video (LOCAL)            COMFYUI_URL + COMFYUI_VIDEO_WORKFLOW
 *           google-flow (CLOUD)              NOT_INTEGRATED (no executable API)
 *   VOICE   macos-say (LOCAL)                MACOS_SAY_VOICE (macOS only)
 *           elevenlabs (CLOUD)               ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
 *   RENDER  ffmpeg-render (LOCAL)            JOVI_FFMPEG_PATH
 *
 * Simulation mode: ONLY simulated providers (never mixed with real ones).
 */
export function createMediaProvidersFromConfig(config: JoviConfig, store: MediaStore): AnyMediaProvider[] {
  if (config.providers.simulation) {
    return [new SimulatedImageProvider(), new SimulatedVideoProvider(), new SimulatedVoiceProvider(), new SimulatedRenderProvider()];
  }
  const m = config.media;
  return [
    new ComfyUIImageProvider({ url: m.comfyuiUrl, workflowPath: m.comfyuiImageWorkflow, timeoutMs: m.comfyuiTimeoutMs }, store),
    new ComfyUIVideoProvider({ url: m.comfyuiUrl, workflowPath: m.comfyuiVideoWorkflow, timeoutMs: m.comfyuiTimeoutMs }, store),
    new GoogleFlowVideoProvider(),
    new MacOSSayVoiceProvider({ sayPath: m.sayPath, voice: m.sayVoice, timeoutMs: m.voiceTimeoutMs }, store),
    new ElevenLabsVoiceProvider({ ...m.elevenlabs, timeoutMs: m.voiceTimeoutMs }, store),
    new FFmpegRenderProvider({ ffmpegPath: m.ffmpegPath, timeoutMs: m.ffmpegTimeoutMs }, store),
  ];
}
