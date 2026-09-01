/**
 * ESP32 BLE OTA - one screen, three steps: find the board, pick the image,
 * send it.
 *
 * The protocol lives in src/ota/; this file is only presentation and wiring, so
 * that the part which can be wrong in a way you cannot see is the part that is
 * unit-tested.
 */
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
import { formatBytes } from './src/lib/bytes';
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

export default function App() {
  const [btState, setBtState] = useState<string>('unknown');
  const [scanning, setScanning] = useState(false);
  const [boards, setBoards] = useState<FoundBoard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [firmware, setFirmware] = useState<LoadedFirmware | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseText, setPhaseText] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [committed, setCommitted] = useState(0);
  const [result, setResult] = useState<
    { ok: boolean; message: string; hint?: string } | null
  >(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [armed, setArmed] = useState(false);

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
      }
    );

    // BLE scanning is expensive; ten seconds is plenty to find a board on a
    // bench and leaves the radio alone afterwards.
    setTimeout(() => {
      stopScanRef.current?.();
      stopScanRef.current = null;
      setScanning(false);
      addLog('scan finished');
    }, 10_000);
  }, [addLog]);

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
    setResult(null);
    setProgress(null);
    setCommitted(0);
    setPhase('idle');

    let link: BoardLink | null = null;
    try {
      addLog('connecting…');
      setPhaseText('connecting');

      // The session is constructed before the link so that notifications which
      // arrive during connect are never dropped on the floor.
      let session: OtaSession | null = null;
      link = await BoardLink.connect(
        selected,
        (bytes) => session?.pushStatus(bytes),
        () => addLog('board disconnected', 'warn')
      );
      addLog(`connected - ${link.chunkSize} bytes per write`);

      session = new OtaSession(
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
      setArmed(false);
      setPhase('idle');
      setPhaseText('');
    }
  }, [addLog, armed, firmware, selected]);

  const pct = progress ? Math.round((progress.sent / progress.total) * 100) : 0;
  const canUpload = !!selected && !!firmware && !busy;
  const problems = firmware?.info.problems ?? [];

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

        {/* ---------------------------------------------------- firmware */}
        <View style={s.card}>
          <Text style={s.h2}>2 · Firmware</Text>
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
          <Text style={s.h2}>3 · Upload</Text>
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
            <Text style={s.btnText}>
              {busy
                ? 'Uploading…'
                : armed
                ? 'Upload anyway'
                : problems.length > 0
                ? 'Upload (has problems)'
                : 'Upload over BLE'}
            </Text>
          </Pressable>

          {busy && (
            <Pressable
              style={[s.btn, s.btnGhost]}
              onPress={() => sessionRef.current?.cancel()}
            >
              <Text style={s.btnText}>Cancel</Text>
            </Pressable>
          )}

          {(busy || progress) && (
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
              {busy && phase === 'erasing' && (
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
