/**
 * The retry policy, with an injected clock.
 *
 * What it must get right is the counting and the stop conditions: a link
 * failure earns another go, a verdict from the board does not, and the last
 * outcome - value or error - reaches the caller intact.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Attempt, describeAttempt, retrying } from '../src/ota/retry';

const noSleep = async () => {};

test('a first-time success runs exactly once', async () => {
  let runs = 0;
  const value = await retrying(
    async () => {
      runs++;
      return 'ok';
    },
    // The policy sees every outcome, so it is the policy that says a returned
    // value is fine: only thrown errors are worth another go here.
    { attempts: 3, delayMs: 0, retryable: (o) => !o.ok, sleep: noSleep }
  );
  assert.equal(value, 'ok');
  assert.equal(runs, 1);
});

test('thrown errors are retried up to the attempt count, then rethrown', async () => {
  let runs = 0;
  const retries: number[] = [];
  await assert.rejects(
    retrying(
      async () => {
        runs++;
        throw new Error(`link ${runs}`);
      },
      {
        attempts: 3,
        delayMs: 0,
        retryable: () => true,
        onRetry: (attempt) => retries.push(attempt),
        sleep: noSleep,
      }
    ),
    /link 3/
  );
  assert.equal(runs, 3);
  assert.deepEqual(retries, [2, 3]);
});

test('a returned failure the policy calls final is not retried', async () => {
  let runs = 0;
  const value = await retrying<{ ok: boolean; code?: number }>(
    async () => {
      runs++;
      return { ok: false, code: 0x11 };
    },
    {
      attempts: 3,
      delayMs: 0,
      retryable: (o) => o.ok && o.value.code !== 0x11,
      sleep: noSleep,
    }
  );
  assert.deepEqual(value, { ok: false, code: 0x11 });
  assert.equal(runs, 1);
});

test('a returned failure the policy allows is retried until it succeeds', async () => {
  let runs = 0;
  const value = await retrying<{ ok: boolean }>(
    async () => {
      runs++;
      return { ok: runs >= 2 };
    },
    { attempts: 3, delayMs: 0, retryable: (o) => o.ok && !o.value.ok, sleep: noSleep }
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(runs, 2);
});

test('the pause between attempts is the configured one, and only between', async () => {
  const slept: number[] = [];
  let runs = 0;
  await retrying(
    async () => {
      runs++;
      if (runs < 3) throw new Error('again');
      return runs;
    },
    {
      attempts: 3,
      delayMs: 2000,
      retryable: () => true,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }
  );
  assert.deepEqual(slept, [2000, 2000]);
});

test('one attempt means no retry at all, whatever the policy says', async () => {
  let runs = 0;
  await assert.rejects(
    retrying(
      async () => {
        runs++;
        throw new Error('once');
      },
      { attempts: 1, delayMs: 0, retryable: () => true, sleep: noSleep }
    ),
    /once/
  );
  assert.equal(runs, 1);
});

test('describeAttempt names the error or describes the value', () => {
  // The failed attempts are typed explicitly: assignment narrows a union to
  // the member assigned, which would otherwise leave T as unknown.
  const thrown: Attempt<string> = { ok: false, error: new Error('dropped') };
  assert.equal(describeAttempt<string>(thrown, (v) => v), 'dropped');
  const returned: Attempt<{ error?: string }> = { ok: true, value: { error: 'stalled' } };
  assert.equal(describeAttempt(returned, (v) => v.error ?? '?'), 'stalled');
  const bare: Attempt<string> = { ok: false, error: 'plain text' };
  assert.equal(describeAttempt<string>(bare, (v) => v), 'plain text');
});
