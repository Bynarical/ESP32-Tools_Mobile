/**
 * ESP32 BLE OTA - one screen: find the board, change its settings if you want
 * to, pick the image, send it.
 *
 * The protocol lives in src/ota/; this file is only presentation and wiring, so
 * that the part which can be wrong in a way you cannot see is the part that is
 * unit-tested.
 */
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  BoardLink,
  FoundBoard,
  bluetoothState,
  describeBleError,
  requestBlePermissions,
  scanForBoards,
} from './src/ble/transport';
import { formatBytes, utf8Length } from './src/lib/bytes';
import {
  CFG_LIMITS,
  StoredConfig,
  configProblem,
  describeConfig,
  pendingConfig,
  summarizeStored,
} from './src/ota/config';
import { ConfigSession } from './src/ota/configSession';
import { DEFAULT_DEVICE_NAME } from './src/ota/protocol';
import { LoadedFirmware, pickFirmware } from './src/ota/firmwareFile';
import { summarize } from './src/ota/image';
import { OtaSession, Phase, Progress } from './src/ota/session';

const C = {
  bg: '#0d0f14',
  card: '#151926',
  card2: '#1b2130',
  line: '#252c3d',
  text: '#e6eaf2',
  muted: '#8b93a7',
  dim: '#6b7285',
  accent: '#4dd8e6',
  ok: '#3fd08a',
  warn: '#f2b34b',
  err: '#f2646a',
};

type LogLine = { msg: string; level: 'info' | 'warn' | 'error' };

const PHASE_TEXT: Record<Phase, string> = {
  idle: 'Idle',
  erasing: 'Erasing the target slot',
  uploading: 'Uploading',
  finalizing: 'Verifying the signature',
  done: 'Done',
};

/**
 * Connect, run one settings exchange, close.
 *
 * The CFG characteristic is write-encrypted exactly like CTRL and DATA, so this
 * is the same connect-and-bond dance as an upload - just far shorter. The
 * session is built after the link but the sink is wired before it, so an
 * acknowledgement that arrives during setup is not dropped on the floor.
 */
async function withConfigSession<T>(
  deviceId: string,
  addLog: (msg: string, level?: LogLine['level']) => void,
  onStored: (s: StoredConfig) => void,
  fn: (session: ConfigSession) => Promise<T>
): Promise<T> {
  let link: BoardLink | null = null;
  try {
    let session: ConfigSession | null = null;
    link = await BoardLink.connect(
      deviceId,
      (bytes) => session?.pushStatus(bytes),
      () => session?.noteDisconnected()
    );
    session = new ConfigSession(link, { onLog: addLog, onStored });
    return await fn(session);
  } finally {
    await link?.close();
  }
}

/**
 * Alert.alert as a promise - the phone's version of the desktop app's confirm
 * dialog. A settings write restarts the board, so it gets the same "here is
 * exactly what is about to happen" step rather than firing on one tap.
 */
function confirm(
  title: string,
  message: string,
  confirmLabel: string
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

/**
 * One settings field, with its length shown in BYTES.
 *
 * Bytes rather than characters because that is what the board counts: a
 * 26-character CJK name is 78 bytes and would be rejected at 0x31 after a
 * connect, a bond and a write. Showing the real number makes that visible while
 * it can still be fixed.
 */
function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  limit: number;
  editable: boolean;
  secure?: boolean;
  note?: string;
}): React.ReactElement {
  const used = utf8Length(props.value);
  const over = used > props.limit;
  return (
    <View style={s.field}>
      <View style={s.fieldTop}>
        <Text style={s.label}>{props.label}</Text>
        <Text style={[s.count, over && s.countOver]}>
          {used}/{props.limit} bytes
        </Text>
      </View>
      <TextInput
        style={[s.input, over && s.inputOver]}
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={C.dim}
        editable={props.editable}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={props.secure}
      />
      {props.note ? <Text style={s.fieldNote}>{props.note}</Text> : null}
    </View>
  );
}

export default function App() {
  const [btState, setBtState] = useState<string>('unknown');
  const [scanning, setScanning] = useState(false);
  const [boards, setBoards] = useState<FoundBoard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<LoadedFirmware | null>(null);
  const [busy, setBusy] = useState(false);
  // Busy covers a settings write too; this one gates the transfer panel, which
  // has nothing to show for one.
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseText, setPhaseText] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [committed, setCommitted] = useState(0);
  const [result, setResult] = useState<
    { ok: boolean; message: string; hint?: string } | null
  >(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [armed, setArmed] = useState(false);

  // Settings. Held in component state only - nothing is written to the phone,
  // least of all the Wi-Fi password.
  const [cfgName, setCfgName] = useState('');
  const [cfgSsid, setCfgSsid] = useState('');
  const [cfgPass, setCfgPass] = useState('');
  const [stored, setStored] = useState<StoredConfig | null>(null);
  const [sendCfg, setSendCfg] = useState(false);

  const stopScanRef = useRef<null | (() => void)>(null);
  const sessionRef = useRef<OtaSession | null>(null);

  const addLog = useCallback((msg: string, level: LogLine['level'] = 'info') => {
    setLog((prev) => [...prev.slice(-200), { msg, level }]);
  }, []);

  useEffect(() => {
    bluetoothState()
      .then((s) => setBtState(String(s)))
      .catch(() => setBtState('unavailable'));
    return () => {
      stopScanRef.current?.();
    };
  }, []);

  const startScan = useCallback(async () => {
    setResult(null);
    const perms = await requestBlePermissions();
    if (!perms.granted) {
      setResult({
        ok: false,
        message: 'Bluetooth permission was denied.',
        hint:
          'Grant "Nearby devices" for this app in Android settings, then scan ' +
          'again.',
      });
      return;
    }

    const state = String(await bluetoothState());
    setBtState(state);
    if (state !== 'PoweredOn') {
      setResult({ ok: false, message: `Bluetooth is ${state}.`, hint: 'Turn Bluetooth on.' });
      return;
    }

    setBoards([]);
    setScanning(true);
    addLog('scanning for boards…');

    stopScanRef.current = scanForBoards(
      (board) => {
        setBoards((prev) => {
          const next = prev.filter((b) => b.id !== board.id).concat(board);
          // OTA boards first, then by signal strength.
          next.sort(
            (a, b) =>
              Number(b.isOtaBoard) - Number(a.isOtaBoard) ||
              (b.rssi ?? -999) - (a.rssi ?? -999)
          );
          return next;
        });
        if (board.isOtaBoard) {
          setSelected((cur) => cur ?? board.id);
        }
      },
      (err) => {
        const { message, hint } = describeBleError(err);
        addLog(message, 'error');
        setResult({ ok: false, message, hint });
        setScanning(false);
      },
      // A board renamed from this screen no longer answers to the default, so
      // the name in the field is what the scan marks as an OTA board.
      cfgName.trim() || undefined
    );

    // BLE scanning is expensive; ten seconds is plenty to find a board on a
    // bench and leaves the radio alone afterwards.
    setTimeout(() => {
      stopScanRef.current?.();
      stopScanRef.current = null;
      setScanning(false);
      addLog('scan finished');
    }, 10_000);
  }, [addLog, cfgName]);

  const choose = useCallback(async () => {
    try {
      const loaded = await pickFirmware();
      if (!loaded) return;
      setFirmware(loaded);
      setArmed(false);
      setResult(null);
      addLog(`selected ${loaded.name} - ${summarize(loaded.info)}`);
      for (const p of loaded.info.problems) addLog(p, 'error');
      for (const w of loaded.info.warnings) addLog(w, 'warn');
    } catch (e) {
      const { message, hint } = describeBleError(e);
      setResult({ ok: false, message, hint });
    }
  }, [addLog]);

  // What the three fields add up to on the wire. Blank means "leave it alone",
  // so an empty form is null and nothing is sent at all.
  const cfgPending = useMemo(
    () => pendingConfig({ name: cfgName, ssid: cfgSsid, pass: cfgPass }),
    [cfgName, cfgSsid, cfgPass]
  );

  const readSettings = useCallback(async () => {
    if (!selected) return;
    stopScanRef.current?.();
    stopScanRef.current = null;
    setScanning(false);
    setBusy(true);
    setResult(null);
    try {
      addLog('reading the board settings…');
      const outcome = await withConfigSession(selected, addLog, setStored, (c) =>
        c.read()
      );
      if (!outcome.ok) {
        setResult({
          ok: false,
          message: outcome.error ?? 'Could not read the settings.',
          hint: outcome.hint,
        });
      }
    } catch (e) {
      const { message, hint } = describeBleError(e);
      addLog(message, 'error');
      setResult({ ok: false, message, hint });
    } finally {
      setBusy(false);
    }
  }, [addLog, selected]);

  /**
   * Change a running board's settings with no cable.
   *
   * The same three values a USB provision writes, but into NVS over the
   * settings characteristic. Nothing else on the flash is touched: both app
   * slots, otadata and - the part that matters day to day - the board's
   * Bluetooth bonds all survive, so the phone does not have to pair again.
   */
  const writeSettings = useCallback(async () => {
    if (!selected) {
      setResult({
        ok: false,
        message: 'No board selected.',
        hint:
          'Press Scan and pick the board first. This goes over the air, so ' +
          'the board has to be running the OTA firmware already - a blank ' +
          'chip is provisioned over USB with the desktop app.',
      });
      return;
    }
    if (!cfgPending) {
      setResult({
        ok: false,
        message: 'Nothing to send.',
        hint:
          'Enter a Bluetooth name, a Wi-Fi network, or both. Fields left ' +
          'blank are not sent at all, so the board keeps what it has.',
      });
      return;
    }
    const problem = configProblem(cfgPending);
    if (problem) {
      setResult({ ok: false, message: 'That does not fit.', hint: problem });
      return;
    }

    const go = await confirm(
      'Change settings over BLE',
      `${describeConfig(cfgPending)}\n\n` +
        (stored ? `It currently reports: ${summarizeStored(stored)}\n\n` : '') +
        'Only these keys change - the firmware in both slots, the boot ' +
        'selection and the Bluetooth pairing are left alone. The board ' +
        'restarts to apply them, which takes a few seconds.' +
        (cfgPending.ssid
          ? ' If the network is wrong it falls back to Bluetooth, so it stays ' +
            'reachable.'
          : ''),
      'Write settings'
    );
    if (!go) {
      addLog('settings write cancelled - nothing was sent', 'warn');
      return;
    }

    stopScanRef.current?.();
    stopScanRef.current = null;
    setScanning(false);
    setBusy(true);
    setResult(null);
    try {
      addLog('connecting…');
      const outcome = await withConfigSession(selected, addLog, setStored, (c) =>
        c.apply(cfgPending, true)
      );
      if (outcome.ok) {
        // The fields stay as they were typed. Clearing the password while the
        // SSID remained filled would make a second press send that network with
        // *no* password - which erases the stored one and opens the network.
        // Whatever was read a moment ago describes a board that is restarting
        // into different values, so that much is no longer true.
        setStored(null);
        setResult({
          ok: true,
          message: 'Settings written. The board is restarting to apply them.',
          hint:
            'Give it a few seconds, then press Scan' +
            (cfgPending.name ? ` - it will advertise as "${cfgPending.name}"` : '') +
            (cfgPending.ssid ? `, joining "${cfgPending.ssid}"` : '') +
            '.',
        });
      } else {
        setResult({
          ok: false,
          message: outcome.error ?? 'The settings were not stored.',
          hint: outcome.hint,
        });
      }
    } catch (e) {
      const { message, hint } = describeBleError(e);
      addLog(message, 'error');
      setResult({ ok: false, message, hint });
    } finally {
      setBusy(false);
    }
  }, [addLog, cfgPending, selected, stored]);

  const upload = useCallback(async () => {
    if (!selected || !firmware) return;

    const problems = firmware.info.problems;
    if (problems.length > 0 && !armed) {
      // One deliberate second tap rather than a silent block: the inspection is
      // a strong signal, not an oracle, and a BLE upload costs a minute to
      // discover the same thing.
      setArmed(true);
      return;
    }

    stopScanRef.current?.();
    stopScanRef.current = null;
    setScanning(false);
    setBusy(true);
    setUploading(true);
    setResult(null);
    setProgress(null);
    setCommitted(0);
    setPhase('idle');

    let link: BoardLink | null = null;
    try {
      addLog('connecting…');
      setPhaseText('connecting');

      // One sink, switched between the two state machines that share this
      // link, so notifications arriving during connect are never dropped and a
      // settings acknowledgement never reaches the transfer.
      let sink: ((bytes: Uint8Array) => void) | null = null;
      let dropped: (() => void) | null = null;
      link = await BoardLink.connect(
        selected,
        (bytes) => sink?.(bytes),
        () => {
          addLog('board disconnected', 'warn');
          dropped?.();
        }
      );
      addLog(`connected - ${link.chunkSize} bytes per write`);

      // Settings first when both were asked for. They live in NVS, which no OTA
      // touches, and the reboot at the end of this upload is what puts them into
      // effect - so no second restart is asked for here. If they cannot be
      // stored we stop instead of flashing: a board that comes back on the old
      // network under the old name, having reported success, is worse than a
      // no-op.
      if (sendCfg && cfgPending) {
        setPhaseText('storing the settings');
        const cfgSession = new ConfigSession(link, {
          onLog: addLog,
          onStored: setStored,
        });
        sink = (bytes) => cfgSession.pushStatus(bytes);
        dropped = () => cfgSession.noteDisconnected();
        const cfgOutcome = await cfgSession.apply(cfgPending, false);
        if (!cfgOutcome.ok) {
          setResult({
            ok: false,
            message:
              'Settings were not stored, so the firmware was not sent: ' +
              (cfgOutcome.error ?? 'the board did not accept them'),
            hint:
              cfgOutcome.hint ??
              'Fix the settings, or turn the settings switch off to upload ' +
                'firmware only.',
          });
          return; // the link is closed and the flags reset in `finally`
        }
        addLog(
          'settings stored - they take effect when the board reboots into the ' +
            'new image'
        );
        // What was read a moment ago describes a board that is about to
        // reboot into different values, so it is no longer true.
        setStored(null);
      }

      const session = new OtaSession(
        link,
        firmware.bytes,
        {
          onPhase: (p, text) => {
            setPhase(p);
            setPhaseText(text ?? '');
          },
          onProgress: setProgress,
          onDeviceProgress: setCommitted,
          onLog: addLog,
        },
        { fast: true }
      );
      sink = (bytes) => session.pushStatus(bytes);
      dropped = null;
      sessionRef.current = session;

      const outcome = await session.run();
      if (outcome.ok) {
        setResult({
          ok: true,
          message: 'Upload accepted. The board is rebooting into the new image.',
          hint: outcome.hint,
        });
      } else {
        setResult({
          ok: false,
          message: outcome.error ?? 'Upload failed.',
          hint: outcome.hint,
        });
      }
    } catch (e) {
      const { message, hint } = describeBleError(e);
      addLog(message, 'error');
      setResult({ ok: false, message, hint });
    } finally {
      sessionRef.current = null;
      await link?.close();
      setBusy(false);
      setUploading(false);
      setArmed(false);
      setPhase('idle');
      setPhaseText('');
    }
  }, [addLog, armed, cfgPending, firmware, selected, sendCfg]);

  const pct = progress ? Math.round((progress.sent / progress.total) * 100) : 0;
  const canUpload = !!selected && !!firmware && !busy;
  const problems = firmware?.info.problems ?? [];
  const willSendCfg = sendCfg && !!cfgPending;
  const uploadLabel = busy
    ? 'Uploading…'
    : armed
    ? 'Upload anyway'
    : (problems.length > 0 ? 'Upload (has problems)' : 'Upload over BLE') +
      (willSendCfg ? ' + settings' : '');

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <Text style={s.title}>ESP32 BLE OTA</Text>
          <Text style={s.sub}>Bluetooth: {btState}</Text>
        </View>

        {/* ------------------------------------------------------- board */}
        <View style={s.card}>
          <Text style={s.h2}>1 · Board</Text>
          <Pressable
            style={[s.btn, scanning && s.btnDisabled]}
            disabled={scanning || busy}
            onPress={startScan}
          >
            <Text style={s.btnText}>{scanning ? 'Scanning…' : 'Scan'}</Text>
          </Pressable>

          {boards.length === 0 ? (
            <Text style={s.empty}>
              {scanning ? 'Looking for boards…' : 'No boards yet. Press Scan.'}
            </Text>
          ) : (
            boards.map((b) => (
              <Pressable
                key={b.id}
                style={[s.row, selected === b.id && s.rowSelected]}
                onPress={() => setSelected(b.id)}
                disabled={busy}
              >
                <View style={s.rowMain}>
                  <Text style={s.rowTitle}>
                    {b.name ?? '(unnamed)'}
                    {b.isOtaBoard ? '  ✓ OTA' : ''}
                  </Text>
                  <Text style={s.rowSub}>
                    {b.id}
                    {b.rssi != null ? `   ${b.rssi} dBm` : ''}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </View>

        {/* ---------------------------------------------------- settings */}
        <View style={s.card}>
          <Text style={s.h2}>2 · Board settings</Text>
          <Text style={s.cardNote}>
            The Bluetooth name and the Wi-Fi credentials live in NVS, not in the
            firmware image, so they can be changed over the air. Nothing else is
            touched: both app slots, the boot selection and the pairing all
            survive. A blank field is not sent at all, so the board keeps what it
            already has.
          </Text>

          <Field
            label="Bluetooth name"
            value={cfgName}
            onChange={setCfgName}
            placeholder={DEFAULT_DEVICE_NAME}
            limit={CFG_LIMITS.name}
            editable={!busy}
          />
          <Field
            label="Wi-Fi network"
            value={cfgSsid}
            onChange={setCfgSsid}
            placeholder="SSID"
            limit={CFG_LIMITS.ssid}
            editable={!busy}
          />
          <Field
            label="Wi-Fi password"
            value={cfgPass}
            onChange={setCfgPass}
            placeholder="empty = open network"
            limit={CFG_LIMITS.pass}
            editable={!busy}
            secure
            note="Sent only alongside a network name, so the two always match."
          />

          {stored && (
            <Text style={s.storedLine}>
              Board reports: {summarizeStored(stored)}
            </Text>
          )}

          <Pressable
            style={[s.btn, s.btnGhost, (!selected || busy) && s.btnDisabled]}
            disabled={!selected || busy}
            onPress={readSettings}
          >
            <Text style={s.btnText}>Read from board</Text>
          </Pressable>
          <Pressable
            style={[
              s.btn,
              (!selected || !cfgPending || busy) && s.btnDisabled,
            ]}
            disabled={!selected || !cfgPending || busy}
            onPress={writeSettings}
          >
            <Text style={s.btnText}>Change settings over BLE</Text>
          </Pressable>

          <Text style={s.pairNote}>
            {!selected
              ? 'Scan and pick a board first - this goes over the air, so the board has to be running the OTA firmware already.'
              : !cfgPending
              ? 'Fill in a name or a network above to enable the write.'
              : 'The board stores them and restarts to apply them, which takes a few seconds.'}
          </Text>
        </View>

        {/* ---------------------------------------------------- firmware */}
        <View style={s.card}>
          <Text style={s.h2}>3 · Firmware</Text>
          <Pressable style={s.btn} disabled={busy} onPress={choose}>
            <Text style={s.btnText}>
              {firmware ? 'Choose a different .bin' : 'Choose a .bin file'}
            </Text>
          </Pressable>

          {firmware && (
            <>
              <Text style={s.fwName}>{firmware.name}</Text>
              <Text style={s.fwMeta}>{summarize(firmware.info)}</Text>
              {firmware.info.problems.map((p) => (
                <Text key={p} style={[s.note, s.noteErr]}>
                  {p}
                </Text>
              ))}
              {firmware.info.warnings.map((w) => (
                <Text key={w} style={[s.note, s.noteWarn]}>
                  {w}
                </Text>
              ))}
            </>
          )}
        </View>

        {/* ------------------------------------------------------ upload */}
        <View style={s.card}>
          <Text style={s.h2}>4 · Upload</Text>

          {/* The desktop app's "also apply the settings above" checkbox. Both
              changes then ride one visit, and the upload's own reboot applies
              them together - a settings write on its own would ask for a second
              restart for nothing. */}
          <View style={s.switchRow}>
            <Switch
              value={willSendCfg}
              onValueChange={setSendCfg}
              disabled={busy || !cfgPending}
              trackColor={{ false: C.line, true: '#17364a' }}
              thumbColor={willSendCfg ? C.accent : C.muted}
            />
            <Text style={[s.switchLabel, !cfgPending && s.switchLabelOff]}>
              {cfgPending
                ? 'Store the settings above first; this upload\'s reboot applies both'
                : 'Fill in a name or a network above to send settings too'}
            </Text>
          </View>

          <Pressable
            style={[
              s.btn,
              s.btnPrimary,
              !canUpload && s.btnDisabled,
              armed && s.btnDanger,
            ]}
            disabled={!canUpload}
            onPress={upload}
          >
            <Text style={s.btnText}>{uploadLabel}</Text>
          </Pressable>

          {uploading && (
            <Pressable
              style={[s.btn, s.btnGhost]}
              onPress={() => sessionRef.current?.cancel()}
            >
              <Text style={s.btnText}>Cancel</Text>
            </Pressable>
          )}

          {(uploading || progress) && (
            <View style={s.progressWrap}>
              <View style={s.progressTop}>
                <Text style={s.phase}>
                  {PHASE_TEXT[phase]}
                  {phaseText ? ` — ${phaseText}` : ''}
                </Text>
                <Text style={s.pct}>{pct}%</Text>
              </View>
              <View style={s.bar}>
                <View style={[s.barFill, { width: `${pct}%` }]} />
              </View>
              {progress && (
                <Text style={s.stats}>
                  {formatBytes(progress.sent)} / {formatBytes(progress.total)}
                  {'   '}
                  {(progress.bytesPerSecond / 1024).toFixed(1)} KB/s
                  {progress.etaSeconds != null
                    ? `   ${Math.round(progress.etaSeconds)}s left`
                    : ''}
                </Text>
              )}
              {committed > 0 && (
                <Text style={s.stats}>
                  board committed {formatBytes(committed)}
                </Text>
              )}
              {uploading && phase === 'erasing' && (
                <ActivityIndicator color={C.accent} style={{ marginTop: 8 }} />
              )}
            </View>
          )}

          {result && (
            <View
              style={[
                s.result,
                result.ok ? s.resultOk : s.resultErr,
              ]}
            >
              <Text style={s.resultText}>{result.message}</Text>
              {result.hint && <Text style={s.resultHint}>{result.hint}</Text>}
            </View>
          )}

          <Text style={s.pairNote}>
            The board only accepts firmware over an encrypted link, so Android
            shows a pairing prompt the first time — accept it.
          </Text>
        </View>

        {/* --------------------------------------------------------- log */}
        <View style={s.card}>
          <Text style={s.h2}>Log</Text>
          {log.length === 0 ? (
            <Text style={s.empty}>Nothing yet.</Text>
          ) : (
            log
              .slice()
              .reverse()
              .map((l, i) => (
                <Text
                  key={`${i}-${l.msg}`}
                  style={[
                    s.logLine,
                    l.level === 'warn' && { color: C.warn },
                    l.level === 'error' && { color: C.err },
                  ]}
                >
                  {l.msg}
                </Text>
              ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 14, paddingTop: 48, gap: 12 },
  header: { marginBottom: 2 },
  title: { color: C.text, fontSize: 22, fontWeight: '700' },
  sub: { color: C.dim, fontSize: 12, marginTop: 2 },

  card: {
    backgroundColor: C.card,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  h2: {
    color: C.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  btn: {
    backgroundColor: C.card2,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: '#17364a', borderColor: C.accent },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: '#3a1d22', borderColor: C.err },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: C.text, fontWeight: '600', fontSize: 15 },

  empty: { color: C.dim, fontSize: 13, textAlign: 'center', paddingVertical: 10 },

  cardNote: { color: C.muted, fontSize: 12, lineHeight: 17 },
  field: { gap: 5 },
  fieldTop: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: C.text, fontSize: 13, fontWeight: '600' },
  count: { color: C.dim, fontSize: 11 },
  countOver: { color: C.err, fontWeight: '700' },
  input: {
    backgroundColor: '#0f131c',
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 10,
    color: C.text,
    fontSize: 15,
  },
  inputOver: { borderColor: C.err },
  fieldNote: { color: C.dim, fontSize: 11, lineHeight: 15 },
  storedLine: { color: C.accent, fontSize: 12, lineHeight: 17 },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchLabel: { color: C.text, fontSize: 12, lineHeight: 17, flex: 1 },
  switchLabelOff: { color: C.dim },

  row: {
    flexDirection: 'row',
    backgroundColor: C.card2,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 10,
    padding: 11,
  },
  rowSelected: { borderColor: C.accent },
  rowMain: { flex: 1 },
  rowTitle: { color: C.text, fontSize: 14, fontWeight: '600' },
  rowSub: { color: C.dim, fontSize: 11, marginTop: 2 },

  fwName: { color: C.text, fontSize: 14, fontWeight: '600' },
  fwMeta: { color: C.muted, fontSize: 12 },
  note: {
    fontSize: 12,
    lineHeight: 17,
    borderLeftWidth: 3,
    paddingLeft: 9,
    paddingVertical: 5,
  },
  noteErr: { color: '#f3b9bc', borderLeftColor: C.err },
  noteWarn: { color: '#f0d5a3', borderLeftColor: C.warn },

  progressWrap: { gap: 6 },
  progressTop: { flexDirection: 'row', justifyContent: 'space-between' },
  phase: { color: C.text, fontSize: 13, flex: 1 },
  pct: { color: C.text, fontSize: 15, fontWeight: '700' },
  bar: {
    height: 9,
    borderRadius: 6,
    backgroundColor: '#0f131c',
    borderColor: C.line,
    borderWidth: 1,
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: C.accent },
  stats: { color: C.dim, fontSize: 11 },

  result: { borderRadius: 10, borderWidth: 1, padding: 11, gap: 4 },
  resultOk: { backgroundColor: 'rgba(63,208,138,0.10)', borderColor: C.ok },
  resultErr: { backgroundColor: 'rgba(242,100,106,0.10)', borderColor: C.err },
  resultText: { color: C.text, fontSize: 13, fontWeight: '600' },
  resultHint: { color: C.muted, fontSize: 12, lineHeight: 17 },

  pairNote: { color: C.dim, fontSize: 11, lineHeight: 16 },
  logLine: { color: '#b9c1d4', fontSize: 11, lineHeight: 16 },
});
