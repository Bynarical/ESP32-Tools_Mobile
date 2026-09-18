/**
 * What this browser, at this URL, can actually do - and why not, when it can't.
 *
 * A browser front end for this board is hemmed in by three separate rules that
 * have nothing to do with each other, and each one silently disables a
 * different half of the app:
 *
 *   1. Web Bluetooth needs a *secure context* (https, or localhost) and an
 *      implementation. Safari has neither, on any platform, and every browser
 *      on iOS is Safari underneath.
 *   2. Mixed content: a page on https may not touch http://<board> at all.
 *      The board speaks plain HTTP and has no certificate, so an https-hosted
 *      page can never reach it.
 *   3. CORS: the firmware sends no Access-Control-Allow-Origin, so a page on a
 *      different origin may *send* to it but may not *read* the answer.
 *
 * Put together, no single way of serving this page enables everything, which
 * is a fact worth telling the user plainly rather than letting them discover
 * it as a broken button. This module is the pure decision; the UI just renders
 * it. Deliberately free of DOM imports so it can be tested in node.
 */

export type TransportId = 'ble' | 'wifi';

/** How well a transport works here: fully, with a caveat, or not at all. */
export type Grade = 'full' | 'degraded' | 'unusable';

export interface TransportState {
  id: TransportId;
  grade: Grade;
  /** One line for the badge. */
  summary: string;
  /** The why, in the user's terms. Empty when there is nothing to explain. */
  detail: string;
}

export interface PageEnv {
  /** location.protocol, with its colon: 'https:', 'http:', 'file:'. */
  protocol: string;
  /** location.hostname. */
  hostname: string;
  /** window.isSecureContext. */
  secureContext: boolean;
  /** Whether navigator.bluetooth exists. */
  hasWebBluetooth: boolean;
  /**
   * The board address the user is aiming at, when they have chosen one. Used
   * only to decide same-origin, which is what CORS turns on.
   */
  boardHost?: string;
}

export interface Capabilities {
  ble: TransportState;
  wifi: TransportState;
  /** True when the page is being served by the board it talks to. */
  sameOriginWithBoard: boolean;
  /** The one-line headline for the top of the screen. */
  headline: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLocalHost = (hostname: string): boolean =>
  LOCAL_HOSTS.has(hostname.toLowerCase());

/**
 * Web Bluetooth, or the reason there isn't any.
 *
 * The insecure origin is tested *first*, and that order matters. A browser on
 * an insecure origin does not merely refuse the call - it removes
 * `navigator.bluetooth` from the page entirely, so the missing API cannot be
 * told apart from Safari never having implemented it. Reporting "this browser
 * has no Web Bluetooth" to somebody running Chrome over plain http would be
 * both wrong and a dead end, while the secure-context reason is the one they
 * can act on. On a secure origin the absence is real, and only then is it
 * worth naming whose decision it was.
 */
export function assessBle(env: PageEnv): TransportState {
  if (!env.secureContext) {
    return {
      id: 'ble',
      grade: 'unusable',
      summary: 'Needs https or localhost',
      detail:
        'Web Bluetooth is only offered to a secure context, and this page is ' +
        `on ${env.protocol}//${env.hostname}, which is not one - the browser ` +
        'hides the API completely. Open the app from http://localhost on a ' +
        'computer, or serve it over https, and Bluetooth appears. On an ' +
        'iPhone it will not appear either way; use Wi-Fi there.',
    };
  }
  if (!env.hasWebBluetooth) {
    return {
      id: 'ble',
      grade: 'unusable',
      summary: 'Not available in this browser',
      detail:
        'This browser has no Web Bluetooth. Safari has never shipped it on ' +
        'any platform, and because every browser on iOS and iPadOS is ' +
        'required to use WebKit, Chrome and Firefox on iPhone cannot offer ' +
        'it either. Use Chrome or Edge on Windows, macOS, Linux or Android - ' +
        'or, on iPhone, use Wi-Fi instead.',
    };
  }
  return {
    id: 'ble',
    grade: 'full',
    summary: 'Ready',
    detail:
      'The browser picks the board through its own chooser - there is no ' +
      'free-running scan in Web Bluetooth. The board must already be paired ' +
      'in your system Bluetooth settings on desktop: the firmware encrypts ' +
      'its control and data characteristics, and Web Bluetooth has no pairing ' +
      'API of its own to bond with.',
  };
}

/**
 * Wi-Fi, or the reason there isn't any.
 *
 * The degraded case is the interesting one and it is worth keeping rather than
 * refusing: cross-origin, the bytes still reach the board - a POST with a
 * safelisted content type is sent without a preflight, and the firmware never
 * looks at Content-Type - but the answer is opaque. That is enough to run an
 * update; it is not enough to *read* the verdict, which then has to be
 * inferred from the board rebooting. Saying so is the difference between a
 * tool and a guess.
 */
export function assessWifi(env: PageEnv): TransportState {
  if (env.protocol === 'https:') {
    return {
      id: 'wifi',
      grade: 'unusable',
      summary: 'Blocked by mixed content',
      detail:
        'This page is on https and the board speaks plain http with no ' +
        'certificate, so the browser refuses the request before it is sent. ' +
        'No header or setting on the board changes this. Open this page over ' +
        'http instead - from the board itself, or from any plain-http server ' +
        'on the same network.',
    };
  }
  if (env.protocol === 'file:') {
    return {
      id: 'wifi',
      grade: 'unusable',
      summary: 'Not from a file:// page',
      detail:
        'A page opened straight from disk has the origin "null", and every ' +
        'request it makes to the board is rejected as cross-origin. Serve ' +
        'the folder over http - "npm run serve:web" does exactly that - and ' +
        'open it through that address.',
    };
  }
  if (env.protocol !== 'http:') {
    return {
      id: 'wifi',
      grade: 'unusable',
      summary: `Not from ${env.protocol}`,
      detail: 'Wi-Fi upload needs the page to be served over plain http.',
    };
  }

  const sameOrigin =
    !!env.boardHost && env.boardHost.toLowerCase() === env.hostname.toLowerCase();

  if (sameOrigin) {
    return {
      id: 'wifi',
      grade: 'full',
      summary: 'Served by the board',
      detail:
        'This page came from the board it is talking to, so there is no ' +
        'cross-origin rule in the way: the upload reports real progress and ' +
        'the board’s own answer is read back.',
    };
  }
  return {
    id: 'wifi',
    grade: 'degraded',
    summary: 'Works, verdict inferred',
    detail:
      'The board sends no CORS headers, so this page may send it an image ' +
      'but may not read the reply. The upload itself is real - progress is ' +
      'measured as the bytes leave - and the result is then inferred from ' +
      'the board going away and coming back on the network. A board that ' +
      'rejects the image looks the same as one that never got it, so the ' +
      'report says "probably" where it cannot say "yes".',
  };
}

/**
 * The headline quotes the failing transport's own summary rather than
 * restating a reason, which is what let it claim "this browser has no
 * Bluetooth" at an address where the browser had it and the origin was the
 * problem. One source of truth, so the two can never disagree again.
 */
function headlineFor(ble: TransportState, wifi: TransportState): string {
  const ok = (t: TransportState) => t.grade !== 'unusable';
  if (ok(ble) && ok(wifi)) return 'Bluetooth and Wi-Fi are both available here.';
  if (ok(ble)) return `Bluetooth only here. Wi-Fi: ${wifi.summary.toLowerCase()}.`;
  if (ok(wifi)) return `Wi-Fi only here. Bluetooth: ${ble.summary.toLowerCase()}.`;
  return 'Neither transport works at this address. See the notes below.';
}

export function assess(env: PageEnv): Capabilities {
  const ble = assessBle(env);
  const wifi = assessWifi(env);
  return {
    ble,
    wifi,
    sameOriginWithBoard:
      !!env.boardHost &&
      env.protocol === 'http:' &&
      env.boardHost.toLowerCase() === env.hostname.toLowerCase(),
    headline: headlineFor(ble, wifi),
  };
}
