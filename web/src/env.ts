/**
 * The one place that reads the live browser environment.
 *
 * Kept apart from `capabilities.ts` so the decision itself stays pure and can
 * be tested in node against every combination of scheme, host and API - the
 * same boundary the mobile app draws at `firmwareFile.ts`.
 */
import type { PageEnv } from './capabilities';

/**
 * An iPhone or iPad, however it is presenting itself.
 *
 * The user-agent test alone stopped working when iPadOS started claiming to be
 * a Mac: a modern iPad says "Macintosh" and is indistinguishable from a desktop
 * by that string. A Mac has no touch screen, so `maxTouchPoints` separates
 * them. Getting this wrong is cheap in one direction and not the other - a
 * desktop misread as an iPad would be pointed at an iPhone browser it cannot
 * install, so the Mac test is deliberately the strict one.
 */
function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/iPad/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function currentEnv(boardHost?: string): PageEnv {
  const nav = navigator as Navigator & { bluetooth?: unknown };
  return {
    protocol: location.protocol,
    hostname: location.hostname,
    secureContext: window.isSecureContext,
    hasWebBluetooth: typeof nav.bluetooth === 'object' && nav.bluetooth !== null,
    appleMobile: isAppleMobile(),
    boardHost,
  };
}
