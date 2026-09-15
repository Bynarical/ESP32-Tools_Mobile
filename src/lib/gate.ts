/**
 * An awaitable flag, and a race over several of them.
 *
 * Equivalent to the `asyncio.Event` the desktop backend waits on, extracted
 * here because both the firmware transfer and the settings write need the same
 * shape: wait for the thing you asked for, but end the moment the board reports
 * an error instead. Kept free of React Native imports so both stay testable in
 * plain node.
 */

export class Gate {
  private flagged = false;
  private waiters = new Set<() => void>();

  get isSet(): boolean {
    return this.flagged;
  }

  set(): void {
    this.flagged = true;
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const w of pending) w();
  }

  clear(): void {
    this.flagged = false;
  }

  /** Subscribe once. Returns an unsubscribe, so a race can drop the losers. */
  onSet(cb: () => void): () => void {
    if (this.flagged) {
      cb();
      return () => {};
    }
    this.waiters.add(cb);
    return () => {
      this.waiters.delete(cb);
    };
  }

  /** Resolves true when set, false on timeout. */
  wait(timeoutMs: number): Promise<boolean> {
    return waitAny([this], timeoutMs).then((i) => i >= 0);
  }
}

/**
 * Resolve as soon as any gate is set, giving its index, or -1 on timeout.
 *
 * Every wait in a transfer has a second way to end: the board sends an error.
 * Waiting on one gate at a time meant that error sat unread until the original
 * timeout expired, which is a long time to show the wrong phase. The timer and
 * the losing subscriptions are all cancelled, so nothing is left pending.
 */
export function waitAny(gates: Gate[], timeoutMs: number): Promise<number> {
  const ready = gates.findIndex((g) => g.isSet);
  if (ready >= 0) return Promise.resolve(ready);

  return new Promise((resolve) => {
    let settled = false;
    const unsubscribes: Array<() => void> = [];

    const finish = (index: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const off of unsubscribes) off();
      resolve(index);
    };

    const timer = setTimeout(() => finish(-1), timeoutMs);
    gates.forEach((gate, i) => {
      unsubscribes.push(gate.onSet(() => finish(i)));
    });
  });
}
