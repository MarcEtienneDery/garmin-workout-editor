/**
 * The Settings view's Garmin check: sign in with the profile's login as it is now (the login saved in Settings, else the
 * .env file's) and say how it went. A session Garmin still accepts is reused, so a changed password is only tried when
 * the session is gone or the email changed.
 */
import { getSession, requireAuth } from "../context";
import { locked } from "./activities";

export async function testGarminLogin(profile: string): Promise<{ ok: boolean; message: string }> {
  try {
    const session = getSession(profile);
    if (session.mock) return { ok: false, message: "Mock mode: there is no Garmin to sign in to." };
    await locked(() => requireAuth(session));
    return { ok: true, message: "Garmin accepted the login." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
