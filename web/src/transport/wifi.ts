/**
 * The board's HTTP OTA endpoint, from a browser.
 *
 * Ported from `backend/otad/wifiota.py` in ESP32-Tools - the same two routes
 * (`GET /ping`, `POST /ota`), the same strictness about what counts as a
 * board, the same 45-second wait for it to come back. What the browser adds is
 * a wall the desktop never meets: the firmware sends no CORS headers, so a
 * page on a different origin may send to the board but may not read its answer.
 *
 * Rather than refuse, this runs in one of two modes, and is honest in the UI
 * about which:
 *
 *   **Same-origin** - the page was served by the board. Nothing is in the way.
 *   Real progress, the board's own status code and body.
 *
 *   **Cross-origin** - the POST goes out with `Content-Type: text/plain`,
 *   which is CORS-safelisted and therefore sent without a preflight the board
 *   would answer 404 to. The firmware never looks at Content-Type - it reads
 *   `content_len` and nothing else - so the bytes land exactly as they would
 *   from the desktop app. `upload.onprogress` still fires, so progress is
 *   measured, not guessed. Only the *reply* is withheld, so the verdict is
 *   inferred from the board dropping off the network and returning.
 *
 * The parsing half is pure and tested; only the transfer half touches XHR.
 */

import {
  COMEBACK_POLL_MS,
  COMEBACK_SETTLE_MS,
  COMEBACK_TIMEOUT_MS,
  DEFAULT_PORT,
  OTA_PATH,
  PING_PATH,
  PROBE_TIMEOUT_MS,
  baseUrl,
  parsePing,
} from './wifiParse';

// Re-exported so callers have one import for the transport, while the parsing
// itself stays in a module node can run without a DOM.
export {
  COMEBACK_POLL_MS,
  COMEBACK_SETTLE_MS,
  COMEBACK_TIMEOUT_MS,
  DEFAULT_PORT,
  OTA_PATH,
  PING_PATH,
  PROBE_TIMEOUT_MS,
  baseUrl,
  parsePing,
  splitHostPort,
} from './wifiParse';
export type { PingBody } from './wifiParse';

export interface ProbeResult {
  reachable: boolean;
  /** Whether the answer could be read, or only observed to exist. */
  readable: boolean;
  project?: string;
  version?: string;
  latencyMs?: number;
  /** One line for the UI. */
  reason: string;
}

const timeoutSignal = (ms: number): AbortSignal => {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};

/**
 * Ask one address who is there.
 *
 * Cross-origin the body is unreadable, so this falls back to asking only
 * whether *something* answered: an opaque response resolves when the server
 * replied at all and rejects when nothing is listening. That is weaker than
 * the desktop's identity check and the UI says so, but it is the difference
 * between "the board is there" and "nothing is at that address".
 */
export async function probe(
  host: string,
  port: number = DEFAULT_PORT,
  sameOrigin = false,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProbeResult> {
  const url = `${baseUrl(host, port)}${PING_PATH}`;
  const started = Date.now();

  if (sameOrigin) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: timeoutSignal(timeoutMs),
      });
      const text = await res.text();
      const ping = parsePing(res.status, text);
      const latencyMs = Date.now() - started;
      if (!ping) {
        return {
          reachable: true,
          readable: true,
          latencyMs,
          reason:
            `Something answered at ${host}, but not the OTA firmware’s ` +
            `/ping (HTTP ${res.status}).`,
        };
      }
      return {
        reachable: true,
        readable: true,
        project: typeof ping.project === 'string' ? ping.project : undefined,
        version: typeof ping.version === 'string' ? ping.version : undefined,
        latencyMs,
        reason: 'The board answered /ping.',
      };
    } catch {
      return {
        reachable: false,
        readable: true,
        reason: `Nothing answered at ${host}:${port}.`,
      };
    }
  }

  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: timeoutSignal(timeoutMs),
    });
    return {
      reachable: true,
      readable: false,
      latencyMs: Date.now() - started,
      reason:
        `Something is listening at ${host}:${port}. The board sends no CORS ` +
        'headers, so this page cannot read what it said - only that it spoke.',
    };
  } catch {
    return {
      reachable: false,
      readable: false,
      reason:
        `Nothing answered at ${host}:${port}. Check the address, and that ` +
        'this device is on the same network as the board.',
    };
  }
}

/** Is anything listening? Used to watch a board leave and return. */
export async function alive(
  host: string,
  port: number,
  sameOrigin: boolean,
  timeoutMs = 1_500
): Promise<boolean> {
  try {
    await fetch(`${baseUrl(host, port)}${PING_PATH}`, {
      mode: sameOrigin ? 'cors' : 'no-cors',
      cache: 'no-store',
      signal: timeoutSignal(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export interface UploadProgress {
  sent: number;
  total: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface WifiUploadOutcome {
  ok: boolean;
  /** True when the board's own answer was read, not inferred. */
  confirmed: boolean;
  error?: string;
  hint?: string;
  cancelled?: boolean;
}

export interface WifiUploadOptions {
  sameOrigin: boolean;
  onProgress?: (p: UploadProgress) => void;
  onPhase?: (phase: string, text?: string) => void;
  onLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  signal?: AbortSignal;
}

/**
 * POST an image to the board.
 *
 * Mirrors `http_upload_blocking`: Content-Length is required by the firmware
 * and the browser sets it from the body, so the body must be a buffer and not
 * a stream. XHR rather than fetch for one reason - `upload.onprogress`. Fetch
 * cannot report upload progress without a duplex stream, which needs HTTP/2
 * the board does not speak.
 */
export function uploadOverWifi(
  host: string,
  port: number,
  image: Uint8Array,
  opts: WifiUploadOptions
): Promise<WifiUploadOutcome> {
  const { sameOrigin } = opts;
  const total = image.byteLength;
  const url = `${baseUrl(host, port)}${OTA_PATH}`;
  const started = Date.now();

  return new Promise<WifiUploadOutcome>((resolve) => {
    const xhr = new XMLHttpRequest();
    let finished = false;
    let fullySent = false;

    const settle = (outcome: WifiUploadOutcome) => {
      if (finished) return;
      finished = true;
      resolve(outcome);
    };

    xhr.open('POST', url, true);
    // Cross-origin this has to stay CORS-safelisted or the browser sends a
    // preflight the firmware has no handler for. The firmware reads
    // content_len and ignores the type, so text/plain lands identically.
    xhr.setRequestHeader(
      'Content-Type',
      sameOrigin ? 'application/octet-stream' : 'text/plain'
    );
    xhr.timeout = 180_000;
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      const sent = e.loaded;
      const elapsed = Math.max((Date.now() - started) / 1000, 1e-6);
      const bps = sent / elapsed;
      opts.onProgress?.({
        sent,
        total,
        bytesPerSecond: bps,
        etaSeconds: bps > 0 ? (total - sent) / bps : null,
      });
      if (sent >= total) {
        fullySent = true;
        opts.onPhase?.('finalizing', 'the board is writing and verifying');
      }
    };

    xhr.upload.onload = () => {
      fullySent = true;
      opts.onPhase?.('finalizing', 'the board is writing and verifying');
    };

    xhr.onload = () => {
      const status = xhr.status;
      const body = (xhr.responseText || '').slice(0, 512).trim();
      if (status === 200) {
        const secs = Math.max((Date.now() - started) / 1000, 1e-6);
        opts.onLog?.(
          `uploaded ${total.toLocaleString()} bytes over Wi-Fi in ` +
            `${secs.toFixed(1)}s (${(total / secs / 1024).toFixed(0)} KB/s)`
        );
        settle({ ok: true, confirmed: true });
        return;
      }
      settle({
        ok: false,
        confirmed: true,
        error: `The board rejected the image (HTTP ${status}${
          xhr.statusText ? ' ' + xhr.statusText : ''
        })${body ? ': ' + body : ''}`,
        hint:
          status === 400
            ? 'The firmware answers 400 when the image is larger than the OTA ' +
              'slot, or when Content-Length was missing.'
            : undefined,
      });
    };

    // Cross-origin, this is the *expected* ending: the bytes went out, the
    // reply came back, and the browser refused to hand it over. Only a failure
    // before the body finished is a real failure.
    xhr.onerror = () => {
      if (!sameOrigin && fullySent) {
        opts.onLog?.(
          'the image was sent; the reply is hidden by the browser, so the ' +
            'result will be checked by watching the board reboot',
          'warn'
        );
        settle({ ok: true, confirmed: false });
        return;
      }
      settle({
        ok: false,
        confirmed: false,
        error: 'The upload did not reach the board.',
        hint:
          'Check that the address is right and that this device is on the ' +
          'same network. If the page is on https, the browser blocks plain ' +
          'http to the board entirely.',
      });
    };

    xhr.ontimeout = () =>
      settle({
        ok: false,
        confirmed: false,
        error: 'The board stopped responding during the upload.',
        hint: 'It keeps its current firmware unless the transfer completed.',
      });

    xhr.onabort = () =>
      settle({ ok: false, confirmed: false, cancelled: true, error: 'Cancelled.' });

    opts.signal?.addEventListener('abort', () => {
      try {
        xhr.abort();
      } catch {
        // Already finished.
      }
    });

    opts.onPhase?.('uploading');
    // A copy, because the underlying buffer may be a view into a larger one.
    xhr.send(image.slice().buffer as ArrayBuffer);
  });
}

/**
 * Watch the board leave and come back, which is what a successful update looks
 * like from outside.
 *
 * Mirrors `_confirm_back_on_network` in the daemon. Seeing it go is the
 * stronger signal - a board that never went away never rebooted, so the image
 * was not taken. A board that goes and returns did reboot; whether it booted
 * the *new* image cannot be told from here without a readable /ping, and the
 * caller says so.
 */
export async function watchReboot(
  host: string,
  port: number,
  sameOrigin: boolean,
  onLog?: (msg: string) => void,
  timeoutMs = COMEBACK_TIMEOUT_MS
): Promise<{ wentAway: boolean; cameBack: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let wentAway = false;

  while (Date.now() < deadline) {
    const up = await alive(host, port, sameOrigin);
    if (!up && !wentAway) {
      wentAway = true;
      onLog?.('the board dropped off the network - it is rebooting');
    } else if (up && wentAway) {
      await new Promise((r) => setTimeout(r, COMEBACK_SETTLE_MS));
      onLog?.('the board is back on the network');
      return { wentAway: true, cameBack: true };
    }
    await new Promise((r) => setTimeout(r, COMEBACK_POLL_MS));
  }
  return { wentAway, cameBack: false };
}
