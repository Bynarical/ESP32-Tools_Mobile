/**
 * The one screen.
 *
 * Plain DOM on purpose. The interesting code is all shared with the mobile app
 * - the protocol, the image inspector, the transfer state machine, the
 * settings TLV and the retry policy are imported from `../../src`, unchanged -
 * so a framework here would add a dependency and a build step without adding
 * anything the app needs. What is written here is the part that genuinely
 * differs: two transports, and an honest account of which of them this browser
 * will allow at this address.
 */
import { formatBytes } from '../../src/lib/bytes';
import { summarize } from '../../src/ota/image';
import {
  CFG_LIMITS,
  type BoardConfig,
  configProblem,
  describeConfig,
  pendingConfig,
  type StoredConfig,
  summarizeStored,
} from '../../src/ota/config';
import { ConfigSession, type CfgOutcome } from '../../src/ota/configSession';
import { OtaSession } from '../../src/ota/session';
import { describeAttempt, retrying } from '../../src/ota/retry';
import {
  RETRY_DELAY_MS,
  SETTINGS_ATTEMPTS,
  UPLOAD_RETRIES,
  isFatalDeviceCode,
} from '../../src/ota/protocol';

import { type Capabilities, assess } from './capabilities';
import { currentEnv } from './env';
import { type LoadedFirmware, readFirmware } from './files';
import {
  WebBoardLink,
  type BluetoothDeviceLike,
  describeWebBleError,
  pickBoard,
  radioAvailable,
} from './transport/webble';
import {
  DEFAULT_PORT,
  probe,
  splitHostPort,
  uploadOverWifi,
  watchReboot,
} from './transport/wifi';

// ------------------------------------------------------------------- helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

// --------------------------------------------------------------------- state

type Transport = 'ble' | 'wifi';

interface State {
  transport: Transport;
  firmware: LoadedFirmware | null;
  device: BluetoothDeviceLike | null;
  busy: boolean;
  caps: Capabilities;
}

const S: State = {
  transport: 'wifi',
  firmware: null,
  device: null,
  busy: false,
  caps: assess(currentEnv()),
};

let abort: AbortController | null = null;

// ----------------------------------------------------------------------- log
// In memory only, for one opening of the page - the same decision the mobile
// app makes, and for the same reason: nothing here, least of all a Wi-Fi
// password, has any business outliving the tab.

type Level = 'info' | 'warn' | 'error';
const lines: Array<{ t: string; msg: string; level: Level }> = [];

function log(msg: string, level: Level = 'info'): void {
  const t = new Date().toLocaleTimeString();
  lines.push({ t, msg, level });
  const box = $('log');
  const row = document.createElement('div');
  row.className = `log__row log__row--${level}`;
  row.textContent = `${t}  ${msg}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function clearLog(): void {
  lines.length = 0;
  $('log').textContent = '';
}

// ---------------------------------------------------------------- capability

function renderCaps(): void {
  const boardHost = splitHostPort($<HTMLInputElement>('host').value).host;
  S.caps = assess(currentEnv(boardHost || undefined));

  $('headline').textContent = S.caps.headline;

  for (const t of [S.caps.ble, S.caps.wifi]) {
    const badge = $(`cap-${t.id}`);
    badge.textContent = t.summary;
    badge.className = `badge badge--${t.grade}`;
    $(`cap-${t.id}-detail`).textContent = t.detail;
  }

  // A transport the browser will not allow should not look clickable.
  for (const t of ['ble', 'wifi'] as Transport[]) {
    const tab = $<HTMLButtonElement>(`tab-${t}`);
    const state = t === 'ble' ? S.caps.ble : S.caps.wifi;
    tab.disabled = state.grade === 'unusable';
    tab.title = state.grade === 'unusable' ? state.detail : '';
  }
  updateRunButton();
}

function selectTransport(t: Transport): void {
  S.transport = t;
  for (const id of ['ble', 'wifi'] as Transport[]) {
    $(`tab-${id}`).classList.toggle('tab--on', id === t);
    $(`panel-${id}`).hidden = id !== t;
  }
  updateRunButton();
}

// -------------------------------------------------------------------- upload

function setPhase(text: string): void {
  $('phase').textContent = text;
}

function setProgress(sent: number, total: number, bps?: number, eta?: number | null): void {
  const pct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  $('bar-fill').style.width = `${pct}%`;
  const rate = bps ? ` · ${formatBytes(bps)}/s` : '';
  const left = eta != null && eta > 0 ? ` · ${eta.toFixed(0)}s left` : '';
  $('progress-text').textContent =
    `${formatBytes(sent)} of ${formatBytes(total)} (${pct.toFixed(0)}%)${rate}${left}`;
}

function resetProgress(): void {
  $('bar-fill').style.width = '0%';
  $('progress-text').textContent = '';
  setPhase('');
}

function readSettings(): BoardConfig | null {
  const name = $<HTMLInputElement>('cfg-name').value;
  const ssid = $<HTMLInputElement>('cfg-ssid').value;
  const pass = $<HTMLInputElement>('cfg-pass').value;
  if (!name && !ssid && !pass) return null;
  return pendingConfig({ name, ssid, pass });
}

/**
 * Settings on their own, with no firmware involved.
 *
 * The CFG characteristic is write-encrypted exactly like CTRL and DATA, so
 * this is the same connect-and-bond dance as an upload, just far shorter. The
 * session is built after the link but its sink is wired before it, so an
 * acknowledgement arriving during setup is not dropped. Mirrors
 * `withConfigSession` in the mobile app.
 */
async function withConfigSession<T>(
  fn: (session: ConfigSession) => Promise<T>
): Promise<T> {
  if (!S.device) throw new Error('No board chosen.');
  let link: WebBoardLink | null = null;
  try {
    let session: ConfigSession | null = null;
    link = await WebBoardLink.connect(
      S.device,
      (bytes) => session?.pushStatus(bytes),
      () => session?.noteDisconnected()
    );
    session = new ConfigSession(link, { onLog: log, onStored: noteStored });
    return await fn(session);
  } finally {
    await link?.close();
  }
}

function noteStored(stored: StoredConfig | null): void {
  const box = $('stored');
  if (!stored) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = `the board currently holds: ${summarizeStored(stored)}`;
}

/**
 * A settings write with the desktop backend's patience: three attempts when
 * the link is what failed, none when the board answered - a verdict is final.
 */
function writeSettingsWithRetries(
  cfg: BoardConfig,
  restart: boolean
): Promise<CfgOutcome> {
  return retrying<CfgOutcome>(
    () => withConfigSession((c) => c.apply(cfg, restart)),
    {
      attempts: SETTINGS_ATTEMPTS,
      delayMs: RETRY_DELAY_MS,
      // A returned outcome is the board's answer, good or bad; only a thrown
      // error - the link - is worth another go.
      retryable: (o) => !o.ok,
      onRetry: (attempt, o) =>
        log(
          `attempt ${attempt - 1} of ${SETTINGS_ATTEMPTS} failed: ` +
            `${describeAttempt<CfgOutcome>(o, (v) => v.error ?? 'no answer')}` +
            ' - trying again',
          'warn'
        ),
    }
  );
}

/** Read what the board is holding now, without changing anything. */
async function readFromBoard(): Promise<void> {
  if (S.busy) return;
  S.busy = true;
  updateRunButton();
  try {
    log('reading the board settings...');
    const outcome = await withConfigSession((c) => c.read());
    if (!outcome.ok) {
      finish(false, outcome.error ?? 'The settings could not be read.', outcome.hint);
    }
  } catch (e) {
    const d = describeWebBleError(e);
    finish(false, d.message, d.hint);
  } finally {
    S.busy = false;
    updateRunButton();
  }
}

/**
 * Store settings and nothing else.
 *
 * `restart` is true here, unlike the settings-before-upload path: there is no
 * later reboot to apply them, so this one has to ask for its own.
 */
async function writeSettingsOnly(): Promise<void> {
  if (S.busy) return;
  const cfg = readSettings();
  if (!cfg) {
    log('Fill in at least one setting first.', 'warn');
    return;
  }
  const problem = configProblem(cfg);
  if (problem) {
    log(problem, 'error');
    return;
  }

  const warning =
    `Write ${describeConfig(cfg)} to the board?` +
    (cfg.ssid
      ? ' If the network is wrong it falls back to Bluetooth, so it stays reachable.'
      : '');
  if (!window.confirm(warning)) {
    log('settings write cancelled - nothing was sent', 'warn');
    return;
  }

  S.busy = true;
  $('result').hidden = true;
  updateRunButton();
  try {
    log('connecting...');
    const outcome = await writeSettingsWithRetries(cfg, true);
    if (outcome.ok) {
      // Whatever was read a moment ago describes a board that is restarting
      // into different values, so that much is no longer true. The fields stay
      // as typed: clearing the password while the SSID remained filled would
      // make a second press send that network with no password at all.
      noteStored(null);
      finish(
        true,
        'Settings written. The board is restarting to apply them.',
        'Give it a few seconds, then choose it again' +
          (cfg.name ? ` - it will advertise as "${cfg.name}"` : '') +
          (cfg.ssid ? `, joining "${cfg.ssid}"` : '') +
          '.'
      );
    } else {
      finish(false, outcome.error ?? 'The settings were not stored.', outcome.hint);
    }
  } catch (e) {
    const d = describeWebBleError(e);
    finish(false, d.message, d.hint);
  } finally {
    S.busy = false;
    updateRunButton();
  }
}

/** One BLE attempt: connect, optionally store settings, then transfer. */
async function bleAttempt(firmware: LoadedFirmware, cfg: BoardConfig | null) {
  if (!S.device) throw new Error('No board chosen.');

  let sink: ((b: Uint8Array) => void) | null = null;
  let dropped: (() => void) | null = null;

  const link = await WebBoardLink.connect(
    S.device,
    (bytes) => sink?.(bytes),
    () => {
      log('board disconnected', 'warn');
      dropped?.();
    }
  );

  try {
    log(`connected - ${link.chunkSize} bytes per write`);

    if (cfg) {
      setPhase('storing the settings');
      const cfgSession = new ConfigSession(link, {
        onLog: log,
        onStored: noteStored,
      });
      sink = (b) => cfgSession.pushStatus(b);
      dropped = () => cfgSession.noteDisconnected();
      const outcome = await cfgSession.apply(cfg, false);
      if (outcome.ok) {
        log('settings stored - they apply when the board reboots into the new image');
      } else if (outcome.unsupported) {
        log(
          'this board has no settings characteristic yet - the upload adds it, ' +
            'so store the settings again once the new firmware is running',
          'warn'
        );
      } else {
        // Same refusal as the mobile app: a board that comes back on the old
        // network under the old name, having reported success, is worse than
        // a no-op.
        return {
          ok: false,
          error:
            'Settings were not stored, so the firmware was not sent: ' +
            (outcome.error ?? 'the board did not accept them'),
          hint: outcome.hint,
          stopped: true,
        };
      }
    }

    const session = new OtaSession(
      link,
      firmware.bytes,
      {
        onPhase: (p, text) => setPhase(text ? `${p} - ${text}` : p),
        onProgress: (p) =>
          setProgress(p.sent, p.total, p.bytesPerSecond, p.etaSeconds),
        onLog: log,
      },
      { fast: true }
    );
    sink = (b) => session.pushStatus(b);
    dropped = null;
    return await session.run();
  } finally {
    await link.close();
  }
}

async function runBle(firmware: LoadedFirmware): Promise<void> {
  const cfg = readSettings();
  if (cfg) {
    const problem = configProblem(cfg);
    if (problem) {
      log(problem, 'error');
      return;
    }
    log(`settings to store: ${describeConfig(cfg)}`);
  }

  // The desktop backend's policy, imported rather than restated: a link
  // failure gets two more tries two seconds apart, a verdict about the image
  // does not.
  const outcome = await retrying(
    () => bleAttempt(firmware, cfg),
    {
      attempts: UPLOAD_RETRIES + 1,
      delayMs: RETRY_DELAY_MS,
      retryable: (o) => {
        if (!o.ok) return true;
        const v = o.value as { ok: boolean; cancelled?: boolean; stopped?: boolean; deviceCode?: number | null };
        if (v.ok || v.cancelled || v.stopped) return false;
        return !isFatalDeviceCode(v.deviceCode ?? null);
      },
      onRetry: (attempt) => log(`retrying - attempt ${attempt}`, 'warn'),
    }
  );

  const v = outcome as { ok: boolean; error?: string; hint?: string };
  if (v.ok) {
    setPhase('done');
    log('the board accepted the image and is rebooting into it');
    finish(true, 'Upload complete. The board is rebooting into the new firmware.');
  } else {
    finish(false, v.error ?? 'The upload failed.', v.hint);
  }
}

async function runWifi(firmware: LoadedFirmware): Promise<void> {
  const { host, port } = splitHostPort(
    $<HTMLInputElement>('host').value,
    DEFAULT_PORT
  );
  if (!host) {
    log('Enter the board’s address first.', 'error');
    return;
  }
  const sameOrigin = S.caps.sameOriginWithBoard;

  setPhase('checking the address');
  const found = await probe(host, port, sameOrigin);
  log(found.reason, found.reachable ? 'info' : 'warn');
  if (!found.reachable) {
    finish(false, `Nothing answered at ${host}:${port}.`,
      'Check the address, and that this device is on the same network as the board.');
    return;
  }
  if (found.project) {
    log(`board reports ${found.project} ${found.version ?? ''}`.trim());
  }

  abort = new AbortController();
  const outcome = await uploadOverWifi(host, port, firmware.bytes, {
    sameOrigin,
    onProgress: (p) =>
      setProgress(p.sent, p.total, p.bytesPerSecond, p.etaSeconds),
    onPhase: (p, text) => setPhase(text ? `${p} - ${text}` : p),
    onLog: log,
    signal: abort.signal,
  });

  if (outcome.cancelled) {
    finish(false, 'Cancelled.');
    return;
  }
  if (!outcome.ok) {
    finish(false, outcome.error ?? 'The upload failed.', outcome.hint);
    return;
  }
  if (outcome.confirmed) {
    finish(true, 'Upload complete. The board accepted the image and is rebooting.');
    return;
  }

  // Cross-origin: the bytes went out but the reply was withheld, so the only
  // evidence left is the board's own behaviour.
  setPhase('watching the board reboot');
  const seen = await watchReboot(host, port, sameOrigin, (m) => log(m));
  if (seen.wentAway && seen.cameBack) {
    finish(
      true,
      'The board rebooted and came back, which is what a successful update ' +
        'looks like from here.',
      'The browser would not let this page read the board’s answer, so ' +
        'this is inferred rather than read. Open the board’s own page, or ' +
        'use the desktop app, if you need the version confirmed.'
    );
  } else if (seen.wentAway) {
    finish(
      false,
      'The board rebooted but has not come back on this network yet.',
      'If new Wi-Fi settings were part of this image it may have joined a ' +
        'different network. Otherwise give it a moment and check the address.'
    );
  } else {
    finish(
      false,
      'The board never rebooted, so it did not take the image.',
      'It keeps its current firmware. Check the image is for this board, or ' +
        'use Bluetooth, which reports the board’s own verdict.'
    );
  }
}

function finish(ok: boolean, message: string, hint?: string): void {
  const box = $('result');
  box.hidden = false;
  box.className = `result result--${ok ? 'ok' : 'bad'}`;
  box.textContent = message + (hint ? `\n\n${hint}` : '');
  log(message, ok ? 'info' : 'error');
}

async function run(): Promise<void> {
  if (S.busy || !S.firmware) return;
  S.busy = true;
  $('result').hidden = true;
  resetProgress();
  updateRunButton();

  try {
    if (S.transport === 'ble') await runBle(S.firmware);
    else await runWifi(S.firmware);
  } catch (e) {
    const d = S.transport === 'ble'
      ? describeWebBleError(e)
      : { message: e instanceof Error ? e.message : String(e) };
    finish(false, d.message, d.hint);
  } finally {
    S.busy = false;
    abort = null;
    updateRunButton();
  }
}

function updateRunButton(): void {
  const btn = $<HTMLButtonElement>('run');
  const state = S.transport === 'ble' ? S.caps.ble : S.caps.wifi;
  const needsDevice = S.transport === 'ble' && !S.device;
  const blocked =
    S.busy ||
    !S.firmware ||
    state.grade === 'unusable' ||
    needsDevice ||
    (S.firmware?.info.problems.length ?? 0) > 0;
  btn.disabled = blocked;
  btn.textContent = S.busy
    ? 'Working…'
    : S.transport === 'ble'
      ? 'Upload over Bluetooth'
      : 'Upload over Wi-Fi';
  $<HTMLButtonElement>('cancel').hidden = !S.busy || S.transport !== 'wifi';

  // The settings buttons need a board and a working radio, but no image:
  // changing a board's name has nothing to do with having firmware to hand.
  const cfgBlocked = S.busy || S.caps.ble.grade === 'unusable' || !S.device;
  $<HTMLButtonElement>('read-settings').disabled = cfgBlocked;
  $<HTMLButtonElement>('write-settings').disabled = cfgBlocked;
}

// ------------------------------------------------------------------- wiring

function wireFilePicker(): void {
  const input = $<HTMLInputElement>('file');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const fw = await readFirmware(file);
    S.firmware = fw;

    const box = $('image');
    box.hidden = false;
    box.textContent = `${fw.name} · ${formatBytes(fw.size)}\n${summarize(fw.info)}`;

    for (const p of fw.info.problems) log(p, 'error');
    for (const w of fw.info.warnings) log(w, 'warn');
    if (fw.info.problems.length === 0 && fw.info.warnings.length === 0) {
      log(`${fw.name} looks like a valid image for this board`);
    }
    updateRunButton();
  });
}

function wireSettingsCounters(): void {
  for (const field of ['name', 'ssid', 'pass'] as const) {
    const input = $<HTMLInputElement>(`cfg-${field}`);
    const counter = $(`cfg-${field}-count`);
    const limit = CFG_LIMITS[field];
    const update = () => {
      const n = utf8Len(input.value);
      counter.textContent = `${n}/${limit} bytes`;
      counter.classList.toggle('over', n > limit);
    };
    input.addEventListener('input', update);
    update();
  }
}

async function wireBle(): Promise<void> {
  $('pick-board').addEventListener('click', async () => {
    try {
      const device = await pickBoard($<HTMLInputElement>('any-device').checked);
      S.device = device;
      $('board-name').textContent = device.name ?? '(unnamed board)';
      log(`chose ${device.name ?? 'a board'}`);
      updateRunButton();
    } catch (e) {
      const d = describeWebBleError(e);
      log(d.message, 'warn');
      if (d.hint) log(d.hint, 'info');
    }
  });

  $('read-settings').addEventListener('click', () => void readFromBoard());
  $('write-settings').addEventListener('click', () => void writeSettingsOnly());

  const radio = await radioAvailable();
  if (radio === false) {
    log('No Bluetooth radio is available to this browser.', 'warn');
  }
}

function wireWifi(): void {
  $('host').addEventListener('input', renderCaps);
  $('check').addEventListener('click', async () => {
    const { host, port } = splitHostPort($<HTMLInputElement>('host').value);
    if (!host) return;
    log(`checking ${host}:${port}…`);
    const found = await probe(host, port, S.caps.sameOriginWithBoard);
    log(found.reason, found.reachable ? 'info' : 'warn');
    if (found.project) {
      log(`board reports ${found.project} ${found.version ?? ''}`.trim());
    }
  });
  $('cancel').addEventListener('click', () => {
    abort?.abort();
    log('cancelling…', 'warn');
  });
}

function main(): void {
  wireFilePicker();
  wireSettingsCounters();
  wireWifi();
  void wireBle();

  $('tab-ble').addEventListener('click', () => selectTransport('ble'));
  $('tab-wifi').addEventListener('click', () => selectTransport('wifi'));
  $('clear-log').addEventListener('click', clearLog);

  renderCaps();
  // Start on whichever transport this address actually allows.
  selectTransport(S.caps.ble.grade !== 'unusable' ? 'ble' : 'wifi');
  log(S.caps.headline);
}

document.addEventListener('DOMContentLoaded', main);
