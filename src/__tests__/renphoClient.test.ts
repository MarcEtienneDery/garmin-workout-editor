import { RenphoClient, RenphoError, decrypt, encrypt, parseJson } from "../shared/renphoClient";

import { fakeRenpho, loginHandler as login } from "./fixtures/renpho";

describe("the protocol", () => {
  it("encrypts with AES-128-ECB, in base64, and decrypts what it encrypted", () => {
    const text = JSON.stringify({ a: "é", n: [1, 2, 3] });
    const sealed = encrypt(text);
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(sealed, "base64").length % 16).toBe(0);
    expect(decrypt(sealed)).toBe(text);
    expect(encrypt("")).toBe(encrypt("")); // ECB: the same text, the same bytes
    expect(Buffer.from(encrypt(""), "base64").length).toBe(16);
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("keeps long integers as text instead of rounding them", () => {
    const parsed = parseJson('{"id":1234567890123456789,"small":12,"nested":[{"bUserId":9007199254740993,"w":81.7}]}');
    expect(parsed.id).toBe("1234567890123456789");
    expect(parsed.small).toBe(12);
    expect(parsed.nested[0]).toEqual({ bUserId: "9007199254740993", w: 81.7 });
  });
});

describe("signing in", () => {
  it("sends the encrypted login, and keeps the token and the account id for the calls after it", async () => {
    const { fetchFn, calls } = fakeRenpho({ ...login, "renpho-aggregation/device/count": () => ({ scale: [] }) });
    const client = new RenphoClient("me@x.y", "pw", "CA", fetchFn);
    await client.login();
    expect(client.userId).toBe("4242");
    expect(calls[0].body.login).toEqual(expect.objectContaining({ email: "me@x.y", password: "pw", areaCode: "CA", platform: "android" }));
    expect(calls[0].body.bindingList).toEqual({ deviceTypes: ["2"] });
    expect(calls[0].headers.token).toBeUndefined();
    await client.scaleTables();
    expect(calls[1].headers).toEqual(expect.objectContaining({ token: "tok", userId: "4242", platform: "android" }));
  });

  it("signs in by itself on the first call", async () => {
    const { fetchFn, calls } = fakeRenpho({ ...login, "renpho-aggregation/device/count": () => ({ scale: [{ tableName: "t1", userIds: ["1"], count: 2 }, { tableName: "bad" }] }) });
    const tables = await new RenphoClient("e@x.y", "pw", "US", fetchFn).scaleTables();
    expect(calls.map((c) => c.path)).toEqual(["renpho-aggregation/user/login", "renpho-aggregation/device/count"]);
    expect(tables).toEqual([{ tableName: "t1", userIds: ["1"], count: 2 }]); // a table without users is of no use
  });

  it("calls a refused login a login error that names what to check", async () => {
    const { fetchFn } = fakeRenpho({ "renpho-aggregation/user/login": () => ({ __raw: { code: 5001, msg: "wrong password" } }) });
    const error = await new RenphoClient("e@x.y", "bad", "US", fetchFn).login().catch((e) => e);
    expect(error).toBeInstanceOf(RenphoError);
    expect(error.kind).toBe("login");
    expect(error.message).toMatch(/code 5001 \(wrong password\).*email, the password and the area code/);
    expect(error.message).not.toContain("bad");
  });

  it("says a rate limit, a server error and an answer that does not make sense for what they are", async () => {
    const answer = (res: Response) => new RenphoClient("e@x.y", "pw", "US", fakeRenpho({ "renpho-aggregation/user/login": () => res }).fetchFn).login().catch((e) => e);
    expect(await answer(new Response("", { status: 429 }))).toEqual(expect.objectContaining({ kind: "rate" }));
    expect(await answer(new Response("", { status: 500 }))).toEqual(expect.objectContaining({ kind: "other", message: "Renpho answered HTTP 500." }));
    expect(await answer(new Response("<html>", { status: 200 }))).toEqual(expect.objectContaining({ kind: "other", message: "Renpho's answer is not JSON." }));
    expect(await answer(new Response(JSON.stringify({ code: 101, data: "not base64 of a cipher" }), { status: 200 }))).toEqual(expect.objectContaining({ message: expect.stringMatching(/could not be decoded/) }));
    const down = new RenphoClient("e@x.y", "pw", "US", (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch);
    expect(await down.login().catch((e) => e)).toEqual(expect.objectContaining({ kind: "other", message: expect.stringMatching(/Could not reach Renpho: getaddrinfo/) }));
  });
});

describe("reading the weigh-ins", () => {
  const table = { tableName: "t1", userIds: ["1"], count: 450 };
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), weight: 80 }));

  it("reads page after page until a page is not full", async () => {
    const { fetchFn, calls } = fakeRenpho({ ...login, "RenphoHealth/scale/queryAllMeasureDataList": (b) => (b.pageNum === 1 ? page(0, 200) : b.pageNum === 2 ? page(200, 200) : page(400, 50)) });
    const { rows, complete } = await new RenphoClient("e@x.y", "pw", "US", fetchFn).measurements(table);
    expect(rows).toHaveLength(450);
    expect(complete).toBe(true);
    const sent = calls.filter((c) => c.path.startsWith("RenphoHealth")).map((c) => c.body);
    expect(sent.map((b) => b.pageNum)).toEqual([1, 2, 3]);
    expect(sent[0]).toEqual({ pageNum: 1, pageSize: 200, tableName: "t1", userIds: ["1"] });
  });

  it("stops at the page limit and says the read is not complete", async () => {
    const { fetchFn, calls } = fakeRenpho({ ...login, "RenphoHealth/scale/queryAllMeasureDataList": () => page(0, 200) });
    const { rows, complete } = await new RenphoClient("e@x.y", "pw", "US", fetchFn).measurements(table);
    expect(complete).toBe(false);
    expect(rows).toHaveLength(200 * 50);
    expect(calls.filter((c) => c.path.startsWith("RenphoHealth"))).toHaveLength(50);
  });

  it("signs in again once when the session is refused, and gives up on a second refusal", async () => {
    let refused = 1, logins = 0;
    const handlers = {
      "renpho-aggregation/user/login": () => { logins++; return { login: { token: `t${logins}`, id: 1 } }; },
      "renpho-aggregation/device/count": (_b: any, h: Record<string, string>) => (refused-- > 0 ? new Response("", { status: 401 }) : { scale: [], seen: h.token }),
    };
    const { fetchFn } = fakeRenpho(handlers);
    expect(await new RenphoClient("e@x.y", "pw", "US", fetchFn).scaleTables()).toEqual([]);
    expect(logins).toBe(2);
    refused = 5; logins = 0;
    const error = await new RenphoClient("e@x.y", "pw", "US", fakeRenpho(handlers).fetchFn).scaleTables().catch((e) => e);
    expect(error).toEqual(expect.objectContaining({ kind: "login" }));
    expect(logins).toBe(2);
  });

  it("refuses a list of weigh-ins that is not a list", async () => {
    const { fetchFn } = fakeRenpho({ ...login, "RenphoHealth/scale/queryAllMeasureDataList": () => ({ oops: true }) });
    expect(await new RenphoClient("e@x.y", "pw", "US", fetchFn).measurements(table).catch((e) => e)).toEqual(expect.objectContaining({ message: expect.stringMatching(/not a list/) }));
  });
});
