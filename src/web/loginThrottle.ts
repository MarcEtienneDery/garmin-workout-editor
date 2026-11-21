import type { IncomingHttpHeaders } from "http";
import { isIP } from "net";

export type TrustProxy = "off" | "cloudflare" | "proxy";

export function trustProxyOf(value: string | undefined): TrustProxy {
  const asked = (value ?? "").trim().toLowerCase();
  if (asked === "" || asked === "off" || asked === "0" || asked === "false") return "off";
  if (asked === "cloudflare") return "cloudflare";
  if (asked === "proxy" || asked === "1" || asked === "true") return "proxy";
  throw new Error(`TRUST_PROXY must be cloudflare, proxy or off (got "${value}").`);
}

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
    private readonly capacity = 1000
  ) {}

  waitMs(address: string, now = Date.now()): number {
    const entry = this.seen.get(address);
    if (!entry) return 0;
    if (now - entry.since >= this.windowMs) {
      this.seen.delete(address);
      return 0;
    }
    return entry.count >= this.max ? entry.since + this.windowMs - now : 0;
  }

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

  clear(address: string): void {
    this.seen.delete(address);
  }

  private makeRoom(now: number): void {
    for (const [address, entry] of this.seen) if (now - entry.since >= this.windowMs) this.seen.delete(address);
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
