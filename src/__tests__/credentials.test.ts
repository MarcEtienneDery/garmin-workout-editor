import { SealKeyError, SqliteStore, sealing } from "../shared/store";
import { isSealed, open, seal } from "../shared/store/seal";

const KEY = "k".repeat(32);
let store: SqliteStore;
const saved = process.env.CREDENTIALS_KEY;
const raw = (profile = "MED", service = "garmin") => (store as any).db.prepare("SELECT password FROM credentials WHERE profile = ? AND service = ?").get(profile, service).password as string;

beforeEach(() => {
  delete process.env.CREDENTIALS_KEY;
  store = SqliteStore.open(":memory:");
});
afterEach(() => {
  store.close();
  if (saved === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = saved;
});

describe("sealing a secret", () => {
  it("keeps it as given without a key, and encrypts it with one", () => {
    expect(sealing()).toBe(false);
    expect(seal("hunter2", "a|b")).toBe("hunter2");
    process.env.CREDENTIALS_KEY = KEY;
    expect(sealing()).toBe(true);
    const sealed = seal("hunter2", "a|b");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("hunter2");
    expect(open(sealed, "a|b")).toBe("hunter2");
    expect(seal("hunter2", "a|b")).not.toBe(sealed); // a nonce of its own each time
  });

  it("refuses a value moved to another row, a wrong key and a missing key, saying why", () => {
    process.env.CREDENTIALS_KEY = KEY;
    const sealed = seal("hunter2", "MED|garmin");
    expect(() => open(sealed, "SAM|garmin")).toThrow(SealKeyError);
    process.env.CREDENTIALS_KEY = "other".repeat(8);
    expect(() => open(sealed, "MED|garmin")).toThrow(/not the key/);
    delete process.env.CREDENTIALS_KEY;
    expect(() => open(sealed, "MED|garmin")).toThrow(/CREDENTIALS_KEY is not set/);
    expect(open("plain", "x")).toBe("plain");
  });
});

describe("the credentials table", () => {
  it("keeps a login per profile and service, and forgets it", () => {
    expect(store.credentials.get("MED", "garmin")).toBeNull();
    store.credentials.put("MED", "garmin", "a@b.c", "pw1", 5);
    store.credentials.put("MED", "renpho", "r@b.c", "pw2");
    store.credentials.put("SAM", "garmin", "s@b.c", "pw3");
    expect(store.credentials.get("MED", "garmin")).toEqual({ email: "a@b.c", password: "pw1", updatedAt: 5 });
    expect(store.credentials.get("MED", "renpho")!.email).toBe("r@b.c");
    expect(store.credentials.profiles("garmin")).toEqual(["MED", "SAM"]);
    store.credentials.put("MED", "garmin", "a@b.c", "pw9");
    expect(store.credentials.get("MED", "garmin")!.password).toBe("pw9");
    store.credentials.delete("MED", "garmin");
    expect(store.credentials.get("MED", "garmin")).toBeNull();
    expect(store.credentials.profiles("garmin")).toEqual(["SAM"]);
  });

  it("stores the password encrypted when there is a key, and says how many are plain", () => {
    store.credentials.put("MED", "garmin", "a@b.c", "plainpw");
    expect(raw()).toBe("plainpw");
    expect(store.credentials.plainCount()).toBe(1);
    process.env.CREDENTIALS_KEY = KEY;
    store.credentials.put("SAM", "garmin", "s@b.c", "secretpw");
    expect(isSealed(raw("SAM"))).toBe(true);
    expect(raw("SAM")).not.toContain("secretpw");
    expect(store.credentials.get("SAM", "garmin")!.password).toBe("secretpw");
    expect(store.credentials.plainCount()).toBe(1);
  });

  it("warns at start-up only while passwords are plain text and there is no key", () => {
    expect(store.credentials.plainWarning()).toBeNull(); // nothing saved
    store.credentials.put("MED", "garmin", "a@b.c", "plainpw");
    expect(store.credentials.plainWarning()).toMatch(/CREDENTIALS_KEY is not set: 1 saved Garmin\/Renpho password is stored as plain text/);
    store.credentials.put("MED", "renpho", "a@b.c", "plainpw");
    expect(store.credentials.plainWarning()).toMatch(/2 saved Garmin\/Renpho passwords are stored/);
    process.env.CREDENTIALS_KEY = KEY; // set, the plain ones are sealed when read: no warning to give
    expect(store.credentials.plainWarning()).toBeNull();
  });

  it("encrypts a plain password the first time it is read with a key", () => {
    store.credentials.put("MED", "garmin", "a@b.c", "plainpw");
    process.env.CREDENTIALS_KEY = KEY;
    expect(store.credentials.get("MED", "garmin")!.password).toBe("plainpw");
    expect(isSealed(raw())).toBe(true);
    expect(store.credentials.plainCount()).toBe(0);
    expect(store.credentials.get("MED", "garmin")!.password).toBe("plainpw");
  });

  it("says so when a login is encrypted and the key is gone, instead of answering as if there were none", () => {
    process.env.CREDENTIALS_KEY = KEY;
    store.credentials.put("MED", "garmin", "a@b.c", "pw");
    delete process.env.CREDENTIALS_KEY;
    expect(() => store.credentials.get("MED", "garmin")).toThrow(SealKeyError);
    expect(store.credentials.profiles("garmin")).toEqual(["MED"]); // the names do not need the key
  });
});
