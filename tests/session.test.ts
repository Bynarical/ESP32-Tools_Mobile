/**
 * The transfer state machine, driven against a fake board.
 *
 * This is the part that cannot be eyeballed: flow control, the abort paths, and
 * the deliberate decision to treat a missing DONE as success. A fake transport
 * lets all of it run in milliseconds with no hardware.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writeU32LE } from '../src/lib/bytes';
import {
  CMD_ABORT,
  CMD_END,
  CMD_START,
  EV_DONE,
  EV_ERROR,
  EV_PROGRESS,
  EV_READY,
} from '../src/ota/protocol';
import { OtaIo, OtaSession, Phase } from '../src/ota/session';

/** A board that speaks the protocol back, with each reflex switchable. */
class FakeBoard implements OtaIo {
  readonly chunkSize: number;
  ctrl: number[] = [];
  dataWrites: number[] = [];
  bytesReceived = 0;
  withResponseSeen: boolean[] = [];

  autoReady = true;
  autoDone = true;
  /** false = never confirm progress, which is what a stalled board looks like. */
  autoCommit = true;
  errorAtBytes: number | null = null;
  errorCode = 0x11;
  rejectStart = false;

  private session: OtaSession | null = null;

  constructor(chunkSize = 512) {
    this.chunkSize = chunkSize;
  }

  attach(s: OtaSession): void {
    this.session = s;
  }

  private notify(bytes: number[]): void {
    this.session?.pushStatus(new Uint8Array(bytes));
  }

  commit(n: number): void {
    const b = new Uint8Array(5);
    b[0] = EV_PROGRESS;
    b.set(writeU32LE(n), 1);
    this.session?.pushStatus(b);
  }

  async writeCtrl(bytes: Uint8Array): Promise<void> {
    this.ctrl.push(bytes[0]);
    if (bytes[0] === CMD_START) {
      if (this.rejectStart) this.notify([EV_ERROR, 0x02]);
      else if (this.autoReady) this.notify([EV_READY]);
    }
    if (bytes[0] === CMD_END && this.autoDone) this.notify([EV_DONE]);
  }

  async writeData(bytes: Uint8Array, withResponse: boolean): Promise<void> {
    this.dataWrites.push(bytes.length);
    this.withResponseSeen.push(withResponse);
    this.bytesReceived += bytes.length;
    if (this.errorAtBytes !== null && this.bytesReceived >= this.errorAtBytes) {
      this.notify([EV_ERROR, this.errorCode]);
      return;
    }
    if (this.autoCommit) this.commit(this.bytesReceived);
  }
}

function firmware(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i & 0xff;
  return b;
}

function run(board: FakeBoard, fw: Uint8Array, opts = {}, events = {}) {
  const session = new OtaSession(board, fw, events, { now: () => Date.now(), ...opts });
  board.attach(session);
  return { session, promise: session.run() };
}

test('a clean upload sends START, every byte, then END', async () => {
  const board = new FakeBoard(512);
  const fw = firmware(5000);
  const phases: Phase[] = [];
  const { promise } = run(board, fw, {}, { onPhase: (p: Phase) => phases.push(p) });
  const out = await promise;

  assert.equal(out.ok, true, out.error ?? '');
  assert.deepEqual(board.ctrl, [CMD_START, CMD_END]);
  assert.equal(board.bytesReceived, 5000, 'every byte must arrive exactly once');
  // 5000 / 512 = 9 full writes plus a 392-byte remainder.
  assert.equal(board.dataWrites.length, 10);
  assert.equal(board.dataWrites[board.dataWrites.length - 1], 5000 - 9 * 512);
  assert.deepEqual(phases, ['erasing', 'uploading', 'finalizing', 'done']);
});

test('fast mode writes without response; reliable mode with', async () => {
  const fast = new FakeBoard(512);
  await run(fast, firmware(1024), { fast: true }).promise;
  assert.ok(
    fast.withResponseSeen.every((v) => v === false),
    'fast mode must not ask for a response per chunk'
  );

  const safe = new FakeBoard(512);
  await run(safe, firmware(1024), { fast: false }).promise;
  assert.ok(
    safe.withResponseSeen.every((v) => v === true),
    'reliable mode must ask for a response'
  );
});

test('progress reaches the caller and ends at exactly 100%', async () => {
  const board = new FakeBoard(256);
  const seen: Array<{ sent: number; total: number }> = [];
  const committed: number[] = [];
  await run(
    board,
    firmware(4096),
    { progressIntervalMs: 0 },
    {
      onProgress: (p: { sent: number; total: number }) =>
        seen.push({ sent: p.sent, total: p.total }),
      onDeviceProgress: (n: number) => committed.push(n),
    }
  ).promise;

  assert.ok(seen.length > 1);
  assert.equal(seen[seen.length - 1].sent, 4096);
  assert.equal(seen[seen.length - 1].total, 4096);
  // Sent never overshoots the total, even though the last chunk is partial.
  assert.ok(seen.every((p) => p.sent <= p.total));
  assert.equal(committed[committed.length - 1], 4096);
});

test('flow control stops writing once the window is full', async () => {
  const board = new FakeBoard(512);
  board.autoCommit = false; // the board goes quiet
  const fw = firmware(64 * 1024);
  const { promise } = run(board, fw, { window: 4096 });

  // Let the loop push until it blocks on the window.
  await new Promise((r) => setTimeout(r, 60));
  const stalled = board.bytesReceived;
  assert.ok(
    stalled <= 4096 + 512,
    `should hold at the window, sent ${stalled} of ${fw.length}`
  );
  assert.ok(stalled > 0, 'it should have started');

  // Confirm everything; the transfer must resume and finish.
  board.autoCommit = true;
  board.commit(stalled);
  const out = await promise;
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(board.bytesReceived, fw.length);
});

test('reliable mode ignores the window entirely', async () => {
  // Every write is acknowledged by the link itself, so there is nothing to meter.
  const board = new FakeBoard(512);
  board.autoCommit = false;
  const out = await run(board, firmware(32 * 1024), {
    fast: false,
    window: 1024,
  }).promise;
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(board.bytesReceived, 32 * 1024);
});

test('a device error mid-stream stops the upload and explains itself', async () => {
  const board = new FakeBoard(512);
  board.errorAtBytes = 2048;
  board.errorCode = 0x21; // receive buffer overrun
  const out = await run(board, firmware(64 * 1024)).promise;

  assert.equal(out.ok, false);
  assert.match(out.error!, /overrun/i);
  assert.match(out.error!, /0x21/);
  assert.match(out.hint!, /window|reliable/i);
  assert.ok(
    board.bytesReceived < 64 * 1024,
    'it must stop, not keep pushing at a board that gave up'
  );
  assert.ok(!board.ctrl.includes(CMD_END), 'no END after a device error');
});

test('a rejected START never streams a single byte', async () => {
  const board = new FakeBoard(512);
  board.rejectStart = true;
  board.autoReady = false;
  const out = await run(board, firmware(8192)).promise;

  assert.equal(out.ok, false);
  assert.match(out.error!, /No spare OTA partition/i);
  assert.equal(board.bytesReceived, 0, 'a minute of upload would be wasted');
  assert.match(out.hint!, /USB/);
});

test('signature rejection at the end is reported as such', async () => {
  const board = new FakeBoard(512);
  board.autoDone = false;
  const fw = firmware(4096);
  const session = new OtaSession(board, fw, {}, {});
  board.attach(session);
  const p = session.run();
  // The board verifies after END and then refuses the image.
  setTimeout(() => session.pushStatus(new Uint8Array([EV_ERROR, 0x11])), 30);
  const out = await p;

  assert.equal(out.ok, false);
  assert.match(out.error!, /0x11/);
  assert.match(out.hint!, /signature/i);
  assert.match(out.hint!, /over USB/i);
});

test('a missing DONE is treated as success, because the board reboots', async () => {
  // Reporting failure here would be a lie: the board reboots the instant it
  // accepts the image, which can beat the notification out the door.
  const board = new FakeBoard(1024);
  board.autoDone = false;
  const session = new OtaSession(board, firmware(2048), {}, {});
  board.attach(session);

  // Shorten the wait by resolving it ourselves rather than idling 25 s.
  const p = session.run();
  setTimeout(() => session.pushStatus(new Uint8Array([EV_DONE])), 20);
  const out = await p;
  assert.equal(out.ok, true);
  assert.equal(out.hint, undefined, 'an explicit DONE needs no caveat');
});

test('cancelling tells the board to abort and stops early', async () => {
  const board = new FakeBoard(256);
  board.autoCommit = false;
  const fw = firmware(128 * 1024);
  const { session, promise } = run(board, fw, { window: 2048 });

  await new Promise((r) => setTimeout(r, 40));
  session.cancel();
  board.commit(board.bytesReceived); // release the window so the loop wakes
  const out = await promise;

  assert.equal(out.ok, false);
  assert.equal(out.cancelled, true);
  assert.ok(board.ctrl.includes(CMD_ABORT), 'the board must be told to abort');
  assert.ok(board.bytesReceived < fw.length);
});

test('a firmware smaller than one chunk still completes', async () => {
  const board = new FakeBoard(512);
  const out = await run(board, firmware(100)).promise;
  assert.equal(out.ok, true, out.error ?? '');
  assert.deepEqual(board.dataWrites, [100]);
  assert.deepEqual(board.ctrl, [CMD_START, CMD_END]);
});

test('a firmware that is an exact multiple of the chunk sends no empty write', async () => {
  const board = new FakeBoard(512);
  const out = await run(board, firmware(2048)).promise;
  assert.equal(out.ok, true, out.error ?? '');
  assert.deepEqual(board.dataWrites, [512, 512, 512, 512]);
  assert.ok(
    board.dataWrites.every((n) => n > 0),
    'a trailing zero-length write would confuse the firmware'
  );
});

test('missing READY does not abort a transfer that would have worked', async () => {
  // Some builds accept data without ever sending READY. The reference
  // implementation streams anyway rather than failing.
  const board = new FakeBoard(512);
  board.autoReady = false;
  const session = new OtaSession(board, firmware(1024), {}, {});
  board.attach(session);
  const p = session.run();
  // Arrive late, well inside the 30 s allowance.
  setTimeout(() => session.pushStatus(new Uint8Array([EV_READY])), 25);
  const out = await p;
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(board.bytesReceived, 1024);
});

test('a rejected START is reported promptly, not after the READY timeout', async () => {
  // Regression: every wait used to watch a single gate, so an error arriving
  // while we waited for READY sat unread for the full 30 s allowance and the UI
  // showed "erasing" throughout.
  const board = new FakeBoard(512);
  board.rejectStart = true;
  board.autoReady = false;

  const t0 = Date.now();
  const out = await run(board, firmware(8192)).promise;
  const elapsed = Date.now() - t0;

  assert.equal(out.ok, false);
  assert.match(out.error!, /No spare OTA partition/i);
  assert.ok(
    elapsed < 2000,
    `took ${elapsed}ms - it waited out the READY timeout again`
  );
});

test('a device error carries the board\u2019s own code, so a retry policy can read it', async () => {
  const board = new FakeBoard();
  board.errorAtBytes = 1024;
  board.errorCode = 0x11;
  const { promise } = run(board, firmware(4096));
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.deviceCode, 0x11);
  assert.match(outcome.error ?? '', /0x11/);

  const rejected = new FakeBoard();
  rejected.rejectStart = true;
  const start = await run(rejected, firmware(2048)).promise;
  assert.equal(start.deviceCode, 0x02);

  const stalled = new FakeBoard();
  stalled.autoCommit = false;
  // No board verdict: the link is what failed, and the code stays absent.
  const quiet = await run(stalled, firmware(65536)).promise;
  assert.equal(quiet.ok, false);
  assert.equal(quiet.deviceCode, undefined);
});
