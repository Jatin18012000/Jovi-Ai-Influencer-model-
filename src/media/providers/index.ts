import type { JoviConfig } from '../../core/config/config.js';
import type { MediaStore } from '../media-store.js';
import type { AnyMediaProvider } from '../types.js';
import { ComfyUIImageProvider, ComfyUIVideoProvider } from './comfyui-providers.js';
import { SimulatedImageProvider, SimulatedRenderProvider, SimulatedVideoProvider, SimulatedVoiceProvider } from './simulated-providers.js';
import { GoogleFlowVideoProvider } from './unintegrated-providers.js';

/**
 * Media providers from configuration.
 *
 * Production: ComfyUI image + video (report NOT_CONFIGURED until COMFYUI_URL
 * and a workflow are set) and the Google Flow slot (NOT_INTEGRATED). No voice
 * or editing/render provider exists yet, so those kinds have none registered
 * and their assets are BLOCKED with PROVIDER_NOT_CONFIGURED.
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
  ];
}
