/**
 * A fake Renpho for the tests: each path answered by a handler, in the encrypted envelope the real one uses
 * (nothing here is anyone's data).
 */
import { decrypt, encrypt } from "../../shared/renphoClient";

/** A fake Renpho: answers each path with what the handler gives, in the encrypted envelope the real one uses. */
export function fakeRenpho(handlers: Record<string, (body: any, headers: Record<string, string>) => unknown>) {
  const calls: { path: string; body: any; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const path = new URL(url).pathname.slice(1);
    const sent = JSON.parse(init.body).encryptData, plain = decrypt(sent), body = plain ? JSON.parse(plain) : undefined;
    calls.push({ path, body, headers: init.headers });
    const answer = handlers[path]?.(body, init.headers);
    if (answer instanceof Response) return answer;
    if (answer && typeof answer === "object" && "__raw" in (answer as any)) return new Response(JSON.stringify((answer as any).__raw), { status: 200 });
    return new Response(JSON.stringify({ code: 101, data: encrypt(JSON.stringify(answer ?? {})) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
export const loginHandler = { "renpho-aggregation/user/login": () => ({ login: { token: "tok", id: 4242 } }) };


/** One weigh-in the way Renpho lists it. */
export const renphoRow = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id), bUserId: "4242", subUserId: "7", timeStamp: 1_760_000_000 + id * 86_400, weight: 81.7, bodyfat: 17.8, water: 56.1, muscle: 44.5, bone: 3.8, bmi: 24.9, visfat: 7, bodyage: 34, bmr: 1850, weightUnit: 1, ...over,
});

/** A Renpho with the account's scale and these weigh-ins. */
export const renphoWith = (rows: Record<string, unknown>[], extra: Record<string, (b: any, h: Record<string, string>) => unknown> = {}) =>
  fakeRenpho({
    ...loginHandler,
    "renpho-aggregation/device/count": () => ({ scale: [{ tableName: "t1", userIds: ["7"], count: rows.length }] }),
    "RenphoHealth/scale/queryAllMeasureDataList": (b) => rows.slice((b.pageNum - 1) * 200, b.pageNum * 200),
    ...extra,
  });
