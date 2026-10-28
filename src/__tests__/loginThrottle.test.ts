import { LoginThrottle, clientAddress, trustProxyOf } from "../web/loginThrottle";

describe("LoginThrottle", () => {
  it("lets an address fail `max` times, then makes it wait out the window", () => {
    const t = new LoginThrottle(3, 60_000);
    for (let i = 0; i < 3; i++) t.fail("a", 1000);
    expect(t.waitMs("a", 1000)).toBe(60_000);
    expect(t.waitMs("a", 31_000)).toBe(30_000);
    expect(t.waitMs("a", 61_000)).toBe(0);
    expect(t.waitMs("b", 1000)).toBe(0);
  });

  it("starts again after a right password", () => {
    const t = new LoginThrottle(2, 60_000);
    t.fail("a", 0);
    t.fail("a", 0);
    t.clear("a");
    expect(t.waitMs("a", 1)).toBe(0);
  });

  it("keeps at most `capacity` addresses", () => {
    const t = new LoginThrottle(1, 60_000, 2);
    t.fail("a", 0);
    t.fail("b", 0);
    t.fail("c", 0); // the oldest ("a") makes room
    expect(t.waitMs("a", 1)).toBe(0);
    expect(t.waitMs("b", 1)).toBeGreaterThan(0);
    expect(t.waitMs("c", 1)).toBeGreaterThan(0);
  });
});

describe("trustProxyOf", () => {
  it("reads TRUST_PROXY", () => {
    for (const off of [undefined, "", " ", "off", "0", "false"]) expect(trustProxyOf(off)).toBe("off");
    expect(trustProxyOf("Cloudflare")).toBe("cloudflare");
    for (const on of ["proxy", "1", "true"]) expect(trustProxyOf(on)).toBe("proxy");
  });

  it("refuses a value it does not know, so a typo does not leave the limit shared unseen", () => {
    expect(() => trustProxyOf("cloudfare")).toThrow(/TRUST_PROXY must be/);
  });
});

describe("clientAddress", () => {
  const socket = "172.18.0.5";

  it("is the socket's address unless a proxy is trusted", () => {
    expect(clientAddress({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.4" }, socket, "off")).toBe(socket);
  });

  it("reads CF-Connecting-IP for cloudflare, and ignores X-Forwarded-For", () => {
    expect(clientAddress({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.4" }, socket, "cloudflare")).toBe("203.0.113.9");
    expect(clientAddress({ "cf-connecting-ip": "2001:db8::1" }, socket, "cloudflare")).toBe("2001:db8::1");
  });

  it("reads the last X-Forwarded-For entry for proxy: the one the proxy saw, not the visitor's claim", () => {
    expect(clientAddress({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }, socket, "proxy")).toBe("203.0.113.9");
    expect(clientAddress({ "x-forwarded-for": " 203.0.113.9 " }, socket, "proxy")).toBe("203.0.113.9");
    expect(clientAddress({ "cf-connecting-ip": "203.0.113.9" }, socket, "proxy")).toBe(socket);
  });

  it("falls back to the socket's address when the header is missing or is no IP address", () => {
    expect(clientAddress({}, socket, "cloudflare")).toBe(socket);
    expect(clientAddress({ "cf-connecting-ip": "evil, 1.1.1.1" }, socket, "cloudflare")).toBe(socket);
    expect(clientAddress({ "x-forwarded-for": "1.1.1.1, nope" }, socket, "proxy")).toBe(socket);
    expect(clientAddress({ "x-forwarded-for": "" }, socket, "proxy")).toBe(socket);
  });
});
