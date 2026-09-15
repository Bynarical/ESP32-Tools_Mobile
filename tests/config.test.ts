/**
 * Board settings: the TLV wire format, and the write driven against a fake board.
 *
 * The format is two bytes of header and a key/length/value triple per field, so
 * every mistake in it is silent - a byte-counted limit applied to characters, a
 * password sent without its SSID, a truncated read-back parsed as real values.
 * None of that shows up as a crash; it shows up as a board that is no longer
 * reachable on any network. Hence this file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { utf8Decode, utf8Encode, utf8Length } from '../src/lib/bytes';
import {
  CFG_FLAG_RESTART,
  CFG_KEY_NAME,
  CFG_KEY_PASS,
  CFG_KEY_SSID,
  CFG_LIMITS,
  ConfigError,
  configProblem,
  decodeConfigTlv,
  describeConfig,
  encodeConfigTlv,
  pendingConfig,
  summarizeStored,
} from '../src/ota/config';
import {
  CfgIo,
  ConfigSession,
  MissingCharacteristicError,
} from '../src/ota/configSession';
import { EV_CFG, EV_ERROR } from '../src/ota/protocol';

// ------------------------------------------------------------------- UTF-8

test('utf8 round-trips and agrees with Node on byte counts', () => {
  const samples = [
    '',
    'ESP32C3-OTA',
    'Küche',
    '작업실 보드',
    'lab \u{1F6E0}\u{FE0F}',
  ];
  for (const s of samples) {
    const encoded = utf8Encode(s);
    assert.deepEqual(
      [...encoded],
      [...Buffer.from(s, 'utf8')],
      `encoding differs for ${JSON.stringify(s)}`
    );
    assert.equal(utf8Decode(encoded), s);
    assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'));
  }
});

test('utf8 counts bytes, which is what makes a short CJK name too long', () => {
  // Nine Hangul syllables are nine characters and twenty-seven bytes; the board
  // accepts twenty-six. Counting characters would have let this through.
  const name = '보드이름테스트하기';
  assert.equal(name.length, 9);
  assert.equal(utf8Length(name), 27);
  assert.ok(utf8Length(name) > CFG_LIMITS.name);
});

test('utf8Decode replaces malformed bytes instead of throwing', () => {
  // A read-back is diagnostic; one bad byte must not hide the other fields.
  assert.equal(utf8Decode(new Uint8Array([0xc3])), '\ufffd');
  assert.equal(utf8Decode(new Uint8Array([0x80, 0x41])), '\ufffdA');
  assert.equal(utf8Decode(new Uint8Array([0xe2, 0x28, 0xa1])), '\ufffd(\ufffd');
});

// --------------------------------------------------------------- the payload

test('one field encodes as flags, count and a single entry', () => {
  const tlv = encodeConfigTlv({ name: 'bench' }, false);
  assert.deepEqual(
    [...tlv],
    [0x00, 0x01, CFG_KEY_NAME, 5, ...Buffer.from('bench')]
  );
});

test('the restart flag is bit 0 of the header', () => {
  assert.equal(encodeConfigTlv({ name: 'x' }, true)[0], CFG_FLAG_RESTART);
  assert.equal(encodeConfigTlv({ name: 'x' }, false)[0], 0);
});

test('all three fields ride one payload, in key order', () => {
  const tlv = encodeConfigTlv(
    { name: 'bench', ssid: 'lab-ap', pass: 'hunter2' },
    true
  );
  assert.equal(tlv[1], 3);
  assert.deepEqual(decodeKeys(tlv), [CFG_KEY_NAME, CFG_KEY_SSID, CFG_KEY_PASS]);
});

test('an empty string is an entry of length 0, which erases the key', () => {
  // This is how Wi-Fi is turned back off: no SSID means BLE only. It has to be
  // distinguishable from "not sent", which leaves the stored value alone.
  const erase = encodeConfigTlv({ ssid: '', pass: '' }, false);
  assert.deepEqual([...erase], [0x00, 0x02, CFG_KEY_SSID, 0, CFG_KEY_PASS, 0]);

  const absent = encodeConfigTlv({ name: 'only' }, false);
  assert.equal(absent[1], 1);
});

test('the longest possible payload is the size the firmware buffers', () => {
  // OTA_CFG_TLV_MAX in main/ota_cfg.h: header plus all three at maximum length.
  const tlv = encodeConfigTlv(
    {
      name: 'n'.repeat(CFG_LIMITS.name),
      ssid: 's'.repeat(CFG_LIMITS.ssid),
      pass: 'p'.repeat(CFG_LIMITS.pass),
    },
    true
  );
  assert.equal(tlv.length, 2 + (2 + 26) + (2 + 32) + (2 + 63));
  assert.equal(tlv.length, 129);
});

test('an over-long field is refused here, not by the board a minute later', () => {
  assert.throws(
    () => encodeConfigTlv({ name: 'n'.repeat(27) }, false),
    (e: unknown) => e instanceof ConfigError && /26/.test((e as Error).message)
  );
  const problem = configProblem({ ssid: 's'.repeat(33) });
  assert.match(problem ?? '', /33 bytes; the board accepts 32/);
  assert.equal(configProblem({ ssid: 's'.repeat(32) }), null);
});

test('a NUL is refused - the firmware stores C strings', () => {
  assert.match(configProblem({ name: 'a\u0000b' }) ?? '', /NUL/);
  assert.throws(() => encodeConfigTlv({ name: 'a\u0000b' }, false), ConfigError);
});

test('an empty payload is refused rather than sent as a no-op', () => {
  assert.throws(() => encodeConfigTlv({}, true), ConfigError);
});

// ------------------------------------------------------------- the form rule

test('blank fields mean "keep what you have"', () => {
  assert.equal(pendingConfig({ name: '', ssid: '', pass: '' }), null);
  assert.equal(pendingConfig({ name: '   ' }), null);
  assert.deepEqual(pendingConfig({ name: '  bench  ' }), { name: 'bench' });
});

test('a password is only ever sent with its network', () => {
  // The pair has to stay consistent: a new SSID beside an old password leaves
  // the board unable to associate, and so unreachable.
  assert.equal(pendingConfig({ pass: 'orphan' }), null);
  assert.deepEqual(pendingConfig({ ssid: 'lab-ap', pass: '' }), {
    ssid: 'lab-ap',
    pass: '',
  });
  assert.deepEqual(pendingConfig({ ssid: 'lab-ap', pass: 'hunter2' }), {
    ssid: 'lab-ap',
    pass: 'hunter2',
  });
});

test('the descriptions never carry the password itself', () => {
  const text = describeConfig({ ssid: 'lab-ap', pass: 'hunter2' });
  assert.ok(!text.includes('hunter2'));
  assert.match(text, /with password/);
  assert.match(describeConfig({ ssid: 'lab-ap', pass: '' }), /open/);
  assert.match(
    summarizeStored({ name: 'bench', ssid: '', hasPass: false }),
    /bench.*none.*no password/s
  );
});

// ----------------------------------------------------------- the read-back

test('a read-back decodes, with the password as presence only', () => {
  const raw = describePayload({ name: 'bench', ssid: 'lab-ap', hasPass: true });
  assert.deepEqual(decodeConfigTlv(raw), {
    name: 'bench',
    ssid: 'lab-ap',
    hasPass: true,
  });
});

test('a never-provisioned board reads back as empty, not as an error', () => {
  assert.deepEqual(
    decodeConfigTlv(describePayload({ name: '', ssid: '', hasPass: false })),
    { name: '', ssid: '', hasPass: false }
  );
});

test('a truncated read-back yields nulls rather than invented values', () => {
  assert.deepEqual(decodeConfigTlv(new Uint8Array([])), {
    name: null,
    ssid: null,
    hasPass: null,
  });
  // Claims three entries, carries one and a half.
  const short = new Uint8Array([0, 3, CFG_KEY_NAME, 5, 0x62, 0x65]);
  const out = decodeConfigTlv(short);
  assert.equal(out.ssid, null);
  assert.equal(out.hasPass, null);
});

// ------------------------------------------------------- against a fake board

/**
 * A board that applies the firmware's rules: validate the whole payload, then
 * store it - or store nothing at all and report why.
 */
class FakeCfgBoard implements CfgIo {
  readonly chunkSize: number;
  stored: { name?: string; ssid?: string; pass?: string } = {};
  writes: Uint8Array[] = [];
  restarts = 0;

  /** Firmware older than the settings characteristic has no ff05 at all. */
  hasCfgChar = true;
  /** The board refuses settings while a transfer is running (0x34). */
  busy = false;
  /** Answer this device code instead of storing anything. */
  rejectWith: number | null = null;
  /** A board that stores the keys but never gets its notification out. */
  silent = false;
  /** Drop the link instead of acknowledging. */
  dropInstead = false;

  private session: ConfigSession | null = null;

  constructor(chunkSize = 512) {
    this.chunkSize = chunkSize;
  }

  attach(s: ConfigSession): void {
    this.session = s;
  }

  async readCfg(): Promise<Uint8Array> {
    if (!this.hasCfgChar) {
      throw new MissingCharacteristicError('characteristic not found');
    }
    return describePayload({
      name: this.stored.name ?? '',
      ssid: this.stored.ssid ?? '',
      hasPass: !!this.stored.pass,
    });
  }

  async writeCfg(bytes: Uint8Array): Promise<void> {
    if (!this.hasCfgChar) {
      throw new MissingCharacteristicError('characteristic not found');
    }
    this.writes.push(bytes);
    if (this.busy) return this.notify([EV_ERROR, 0x34]);
    if (this.rejectWith !== null) {
      return this.notify([EV_ERROR, this.rejectWith]);
    }
    if (this.dropInstead) {
      this.session?.noteDisconnected();
      return;
    }

    const limits: Record<number, number> = {
      [CFG_KEY_NAME]: CFG_LIMITS.name,
      [CFG_KEY_SSID]: CFG_LIMITS.ssid,
      [CFG_KEY_PASS]: CFG_LIMITS.pass,
    };
    const fields: Record<number, string> = {
      [CFG_KEY_NAME]: 'name',
      [CFG_KEY_SSID]: 'ssid',
      [CFG_KEY_PASS]: 'pass',
    } as Record<number, string>;

    // Validate everything first. A half-applied change is worse than a
    // rejected one, which is why the firmware does the same.
    const pending: Array<[string, string]> = [];
    let at = 2;
    for (let i = 0; i < bytes[1]; i++) {
      if (at + 2 > bytes.length) return this.notify([EV_ERROR, 0x30]);
      const key = bytes[at];
      const len = bytes[at + 1];
      at += 2;
      if (!(key in limits)) return this.notify([EV_ERROR, 0x32]);
      if (len > limits[key] || at + len > bytes.length) {
        return this.notify([EV_ERROR, 0x31]);
      }
      pending.push([fields[key], utf8Decode(bytes.subarray(at, at + len))]);
      at += len;
    }

    for (const [field, value] of pending) {
      if (value === '') delete (this.stored as Record<string, string>)[field];
      else (this.stored as Record<string, string>)[field] = value;
    }
    if (this.silent) return;
    this.notify([EV_CFG]);
    if (bytes[0] & CFG_FLAG_RESTART) this.restarts++;
  }

  private notify(bytes: number[]): void {
    this.session?.pushStatus(new Uint8Array(bytes));
  }
}

function drive(board: FakeCfgBoard, ackTimeoutMs = 60) {
  const logs: string[] = [];
  const session = new ConfigSession(
    board,
    { onLog: (m) => logs.push(m) },
    { ackTimeoutMs }
  );
  board.attach(session);
  return { session, logs };
}

test('a settings write stores the keys and is acknowledged', async () => {
  const board = new FakeCfgBoard();
  board.stored = { name: 'old-name', ssid: 'old-ap', pass: 'old-pass' };
  const { session } = drive(board);

  const outcome = await session.apply({ name: 'bench' }, true);

  assert.equal(outcome.ok, true);
  assert.equal(board.stored.name, 'bench');
  // The fields that were not sent kept their stored values - the whole point.
  assert.equal(board.stored.ssid, 'old-ap');
  assert.equal(board.stored.pass, 'old-pass');
  assert.equal(board.restarts, 1);
  // It reported what was there before, which is what the log line is for.
  assert.equal(outcome.stored?.name, 'old-name');
});

test('the restart is the caller’s decision, not the payload’s', async () => {
  // Riding along with an upload asks for no restart: that upload reboots anyway.
  const board = new FakeCfgBoard();
  const { session } = drive(board);
  assert.equal((await session.apply({ name: 'bench' }, false)).ok, true);
  assert.equal(board.restarts, 0);
});

test('changing only the password leaves the name and SSID alone', async () => {
  const board = new FakeCfgBoard();
  board.stored = { name: 'bench', ssid: 'lab-ap', pass: 'old' };
  const { session } = drive(board);

  const cfg = pendingConfig({ name: '', ssid: 'lab-ap', pass: 'new-secret' });
  assert.ok(cfg);
  assert.equal((await session.apply(cfg, true)).ok, true);
  assert.deepEqual(board.stored, {
    name: 'bench',
    ssid: 'lab-ap',
    pass: 'new-secret',
  });
});

test('an empty SSID and password turn Wi-Fi back off', async () => {
  const board = new FakeCfgBoard();
  board.stored = { name: 'bench', ssid: 'lab-ap', pass: 'old' };
  const { session } = drive(board);

  assert.equal((await session.apply({ ssid: '', pass: '' }, true)).ok, true);
  assert.deepEqual(board.stored, { name: 'bench' });
  assert.deepEqual(await readBack(board), {
    name: 'bench',
    ssid: '',
    hasPass: false,
  });
});

test('a rejection comes back with the board\u2019s own code and advice', async () => {
  // Firmware whose limits are tighter than this app's rejects the payload; the
  // difference between "it failed" and "the name is too long" is the whole
  // value of the error table.
  const board = new FakeCfgBoard();
  board.stored = { name: 'old-name' };
  board.rejectWith = 0x31;
  const { session } = drive(board);

  const outcome = await session.apply({ name: 'bench' }, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /A setting is too long \(device code 0x31\)/);
  assert.match(outcome.hint ?? '', /26 bytes for the name/);
  // Rejected means nothing was stored - a half-applied change is worse.
  assert.deepEqual(board.stored, { name: 'old-name' });
  assert.equal(board.restarts, 0);
});

test('a busy board is reported as busy, not as a mystery', async () => {
  const board = new FakeCfgBoard();
  board.busy = true;
  const { session } = drive(board);

  const outcome = await session.apply({ name: 'bench' }, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /0x34/);
  assert.match(outcome.error ?? '', /Busy with a firmware transfer/);
  assert.match(outcome.hint ?? '', /finish/);
  assert.deepEqual(board.stored, {});
});

test('firmware without the characteristic is diagnosed before anything is sent', async () => {
  const board = new FakeCfgBoard();
  board.hasCfgChar = false;
  const { session } = drive(board);

  const outcome = await session.apply({ name: 'bench' }, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unsupported, true);
  assert.match(outcome.error ?? '', /without the settings characteristic/);
  assert.match(outcome.hint ?? '', /Upload firmware/);
  // Nothing was written: the read is what caught it.
  assert.equal(board.writes.length, 0);
});

test('a board that never acknowledges ends the wait with a usable answer', async () => {
  const board = new FakeCfgBoard();
  board.silent = true;
  const started = Date.now();
  const { session } = drive(board, 50);

  const outcome = await session.apply({ name: 'bench' }, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /never confirmed/);
  assert.match(outcome.hint ?? '', /Read the settings again/);
  assert.ok(Date.now() - started < 2000, 'should not sit out a real timeout');
});

test('a link that drops before the ack says so at once', async () => {
  // Waiting out the full fifteen seconds to say "no answer" would be worse than
  // useless: the board is gone, and the write may or may not have landed.
  const board = new FakeCfgBoard();
  board.dropInstead = true;
  const started = Date.now();
  const { session } = drive(board, 5000);

  const outcome = await session.apply({ name: 'bench' }, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /dropped before/);
  assert.ok(Date.now() - started < 1000, 'returned on the disconnect');
});

test('a payload longer than the link carries is noted, not refused', async () => {
  // A 23-byte MTU leaves 20 payload bytes against a 129-byte maximum. The
  // stacks split it and the firmware reassembles, so this is a warning.
  const board = new FakeCfgBoard(20);
  const { session, logs } = drive(board);

  const outcome = await session.apply(
    { name: 'bench', ssid: 'a-fairly-long-network-name', pass: 'hunter2' },
    true
  );
  assert.equal(outcome.ok, true);
  assert.ok(logs.some((l) => /will be split/.test(l)));
});

test('reading never writes', async () => {
  const board = new FakeCfgBoard();
  board.stored = { name: 'bench', ssid: 'lab-ap', pass: 'x' };
  const { session } = drive(board);

  const outcome = await session.read();
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.stored, {
    name: 'bench',
    ssid: 'lab-ap',
    hasPass: true,
  });
  assert.equal(board.writes.length, 0);
});

// ------------------------------------------------------------------ helpers

/** The read-back framing, built the way the firmware's ota_cfg_describe does. */
function describePayload(v: {
  name: string;
  ssid: string;
  hasPass: boolean;
}): Uint8Array {
  const name = utf8Encode(v.name);
  const ssid = utf8Encode(v.ssid);
  return new Uint8Array([
    0,
    3,
    CFG_KEY_NAME,
    name.length,
    ...name,
    CFG_KEY_SSID,
    ssid.length,
    ...ssid,
    CFG_KEY_PASS,
    1,
    v.hasPass ? 1 : 0,
  ]);
}

function decodeKeys(tlv: Uint8Array): number[] {
  const keys: number[] = [];
  let at = 2;
  for (let i = 0; i < tlv[1]; i++) {
    keys.push(tlv[at]);
    at += 2 + tlv[at + 1];
  }
  return keys;
}

async function readBack(board: FakeCfgBoard) {
  return decodeConfigTlv(await board.readCfg());
}
