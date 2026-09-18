/**
 * Try again, the way the desktop backend does.
 *
 * ESP32-Tools retries a wireless upload twice and a settings write three
 * times, because on this hardware the connection itself stalls now and then
 * with nothing wrong on either side - and the board keeps its current firmware
 * until END is accepted, so starting over costs only time. What must not be
 * retried is a verdict: a board that rejected the image will reject it again,
 * and a person who cancelled has cancelled. The policy says which is which.
 *
 * Free of React Native imports, so the counting and the stop conditions are
 * tested in plain node with an injected clock.
 */

/** How one attempt ended: a value the function returned, or a throw. */
export type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface RetryPolicy<T> {
  /** Total attempts, the first included. 1 means "no retry at all". */
  attempts: number;
  /** Pause before each further attempt. */
  delayMs: number;
  /**
   * Whether this attempt's outcome is worth another go. A thrown error is
   * usually the link; a returned value may still be a failure the caller can
   * recognise - and some of those are final.
   */
  retryable: (outcome: Attempt<T>) => boolean;
  /** Called before each further attempt, with the attempt number about to run. */
  onRetry?: (attempt: number, outcome: Attempt<T>) => void;
  /** Injectable, so tests do not sit out real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it succeeds, is not worth retrying, or the attempts are used
 * up. The last outcome is what the caller gets: its value returned, or its
 * error rethrown - nothing is swallowed.
 */
export async function retrying<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy<T>
): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.attempts));
  const sleep = policy.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    let outcome: Attempt<T>;
    try {
      outcome = { ok: true, value: await fn(attempt) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (attempt >= attempts || !policy.retryable(outcome)) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }
    policy.onRetry?.(attempt + 1, outcome);
    await sleep(policy.delayMs);
  }
}

/** The one line the log wants about a failed attempt. */
export function describeAttempt<T>(
  outcome: Attempt<T>,
  describeValue: (value: T) => string
): string {
  if (outcome.ok) return describeValue(outcome.value);
  const e = outcome.error;
  return e instanceof Error ? e.message || e.name : String(e);
}
