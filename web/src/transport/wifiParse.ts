/**
 * The parsing half of the Wi-Fi transport, with nothing network in it.
 *
 * Split out from `wifi.ts` so it can be tested in node beside the rest of the
 * pure modules: the strictness of `parsePing` is exactly the sort of thing
 * that looks right and is quietly wrong, and it is the check that stops an
 * image being sent to someone else's web server.
 *
 * Ported from `_parse_ping` in ESP32-Tools' `backend/otad/wifiota.py`.
 */

export const PING_PATH = '/ping';
export const OTA_PATH = '/ota';
export const DEFAULT_PORT = 80;

/** How long the board may take to come back after an update. */
export const COMEBACK_TIMEOUT_MS = 45_000;
export const COMEBACK_POLL_MS = 1_500;
/** Give the HTTP server a moment after the first answer, as the daemon does. */
export const COMEBACK_SETTLE_MS = 2_000;
export const PROBE_TIMEOUT_MS = 2_500;

export interface PingBody {
  ok: true;
  project?: string;
  version?: string;
  idf?: string;
  [key: string]: unknown;
}

/**
 * The OTA firmware's /ping answer, or null for anything else.
 *
 * Strict on purpose, exactly as the desktop's is: a project's own web server
 * may answer every path with its single-page app - HTTP 200 and all - and the
 * letters "ok" somewhere in that HTML must not make it a board. Only a JSON
 * object with ok === true is one.
 */
export function parsePing(status: number, body: string): PingBody | null {
  if (status !== 200) return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (obj.ok !== true) return null;
  return obj as PingBody;
}

/** "192.168.0.127" or "192.168.0.127:8080" -> a base URL. */
export function baseUrl(host: string, port: number = DEFAULT_PORT): string {
  const trimmed = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (/:\d+$/.test(trimmed)) return `http://${trimmed}`;
  return port === DEFAULT_PORT ? `http://${trimmed}` : `http://${trimmed}:${port}`;
}

/** Split whatever the user typed into a host and a port. */
export function splitHostPort(
  input: string,
  fallback: number = DEFAULT_PORT
): { host: string; port: number } {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const m = /^(.*):(\d+)$/.exec(trimmed);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: trimmed, port: fallback };
}
