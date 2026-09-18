/**
 * The one place that reads the live browser environment.
 *
 * Kept apart from `capabilities.ts` so the decision itself stays pure and can
 * be tested in node against every combination of scheme, host and API - the
 * same boundary the mobile app draws at `firmwareFile.ts`.
 */
import type { PageEnv } from './capabilities';

export function currentEnv(boardHost?: string): PageEnv {
  const nav = navigator as Navigator & { bluetooth?: unknown };
  return {
    protocol: location.protocol,
    hostname: location.hostname,
    secureContext: window.isSecureContext,
    hasWebBluetooth: typeof nav.bluetooth === 'object' && nav.bluetooth !== null,
    boardHost,
  };
}
