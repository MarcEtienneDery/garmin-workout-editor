/**
 * loginThrottle.ts — how many wrong passwords one client address may try. A password is checked with scrypt, which costs a few
 * tens of milliseconds on purpose; this keeps a flood of wrong guesses from costing the server more than it costs the sender, and
 * a guess from being free. After `max` wrong passwords within `windowMs` the address waits out the rest of that window.
 */
export class LoginThrottle {
  private readonly seen = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    /** Addresses kept at most, so a flood from many addresses cannot grow the table without end. */
    private readonly capacity = 1000
  ) {}

  /** Milliseconds this address must wait before its next try; 0 when it may try. */
  waitMs(address: string, now = Date.now()): number {
    const entry = this.seen.get(address);
    if (!entry) return 0;
    if (now - entry.since >= this.windowMs) {
      this.seen.delete(address);
      return 0;
    }
    return entry.count >= this.max ? entry.since + this.windowMs - now : 0;
  }

  /** A wrong password from this address. */
  fail(address: string, now = Date.now()): void {
    const entry = this.seen.get(address);
    if (entry && now - entry.since < this.windowMs) {
      entry.count++;
      return;
    }
    this.seen.delete(address);
    if (this.seen.size >= this.capacity) this.makeRoom(now);
    this.seen.set(address, { count: 1, since: now });
  }

  /** A right password: the address starts again. */
  clear(address: string): void {
    this.seen.delete(address);
  }

  /** Drop the windows that ended, and if the table is still full the oldest address. */
  private makeRoom(now: number): void {
    for (const [address, entry] of this.seen) if (now - entry.since >= this.windowMs) this.seen.delete(address);
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
