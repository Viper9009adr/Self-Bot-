/**
 * src/platform/capabilities.ts
 * Platform capability registry — no adapter imports, pure data.
 */

export type PlatformCapability =
  | 'send-image'
  | 'send-audio'
  | 'send-voice'
  | 'receive-image'
  | 'receive-audio'
  | 'receive-voice';

export const PLATFORM_CAPABILITIES: Record<string, Set<PlatformCapability>> = {
  telegram: new Set(['send-image', 'send-audio', 'send-voice', 'receive-image', 'receive-audio', 'receive-voice']),
  whatsapp: new Set(['send-image', 'send-audio', 'receive-image', 'receive-audio']),
  web: new Set(['send-image', 'receive-image']),
};

/**
 * Returns true if the given platform supports the given capability.
 * Unknown platforms always return false (fail-safe).
 */
export function platformSupports(platform: string, cap: PlatformCapability): boolean {
  return PLATFORM_CAPABILITIES[platform]?.has(cap) ?? false;
}
