/**
 * loginThrottle.ts — how many wrong passwords one client address may try. A password is checked with scrypt, which costs a few
 * tens of milliseconds on purpose; this keeps a flood of wrong guesses from costing the server more than it costs the sender, and
 * a guess from being free. After `max` wrong passwords within `windowMs` the address waits out the rest of that window.
 */
import type { IncomingHttpHeaders } from "http";
import { isIP } from "net";

/**
 * Whose address the throttle counts. Behind a tunnel or reverse proxy every connection comes from the proxy, so counting the socket
 * puts every visitor in one bucket: ten wrong passwords from anyone would lock the owner out. With a proxy in front, say which header to
 * believe (TRUST_PROXY): `cloudflare` reads CF-Connecting-IP, which Cloudflare sets itself; `proxy` reads the last X-Forwarded-For
 * entry, the address the one proxy in front saw (earlier entries are whatever the client sent). Only for a port that the proxy alone
 * can reach: anyone who can connect directly could send the header.
 */
export type TrustProxy = "off" | "cloudflare" | "proxy";

/** TRUST_PROXY as a setting: empty or `off`, `cloudflare`, or `proxy` (`1` and `true` too). Anything else is an error, so a typo does not leave it off unseen. */
export function trustProxyOf(value: string | undefined): TrustProxy {
  const asked = (value ?? "").trim().toLowerCase();
  if (asked === "" || asked === "off" || asked === "0" || asked === "false") return "off";
  if (asked === "cloudflare") return "cloudflare";
  if (asked === "proxy" || asked === "1" || asked === "true") return "proxy";
  throw new Error(`TRUST_PROXY must be cloudflare, proxy or off (got "${value}").`);
}

/** The address a request counts against: the one the trusted header names, else (no header, or not an IP address) the socket's own. */
export function clientAddress(headers: IncomingHttpHeaders, socketAddress: string, trust: TrustProxy): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[v.length - 1] : v)?.trim() ?? "";
  let claimed = "";
  if (trust === "cloudflare") claimed = one(headers["cf-connecting-ip"]);
  else if (trust === "proxy") claimed = one(headers["x-forwarded-for"]).split(",").pop()?.trim() ?? "";
  return isIP(claimed) ? claimed : socketAddress;
}

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
