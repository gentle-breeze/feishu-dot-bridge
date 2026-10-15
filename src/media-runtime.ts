import { BridgeError } from './types.js';
/** Default-on deployment switches, not a substitute for user approval. Unknown
 * values fail rather than silently enabling a broader media path. */
export function mediaInputEnabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.FEISHU_MEDIA_INPUT ?? 'images-v1';
  if (mode !== 'disabled' && mode !== 'images-v1') throw new BridgeError('invalid_media_mode');
  return mode === 'images-v1';
}

export function imageOutputEnabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.FEISHU_IMAGE_OUTPUT ?? 'on';
  if (mode !== 'off' && mode !== 'on') throw new BridgeError('invalid_image_output_configuration');
  return mode === 'on';
}
