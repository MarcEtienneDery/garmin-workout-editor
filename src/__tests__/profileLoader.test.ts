import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findProfile, loadProfile } from "../shared/profileLoader";

describe("profile names", () => {
  let dir: string;
  const prevData = process.env.GARMIN_DATA_DIR;
  const prevProfiles = process.env.GARMIN_PROFILES_DIR;
  const addProfile = (name: string) => fs.writeFileSync(path.join(dir, `.env.${name}`), "GARMIN_EMAIL=a@b.c\nGARMIN_PASSWORD=x\n");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-test-"));
    process.env.GARMIN_PROFILES_DIR = dir;
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevData === undefined) delete process.env.GARMIN_DATA_DIR; else process.env.GARMIN_DATA_DIR = prevData;
    if (prevProfiles === undefined) delete process.env.GARMIN_PROFILES_DIR; else process.env.GARMIN_PROFILES_DIR = prevProfiles;
  });

  it("finds a profile whatever the case, and returns the spelling of its .env file", () => {
    addProfile("MED");
    addProfile("Sam");
    expect(findProfile("med")).toBe("MED");
    expect(findProfile("MED")).toBe("MED");
    expect(findProfile("SAM")).toBe("Sam");
    expect(findProfile("nobody")).toBeUndefined();
  });

  it("prefers the exact spelling, and refuses to guess between names that differ only in case", () => {
    addProfile("Sam");
    addProfile("sam");
    expect(findProfile("Sam")).toBe("Sam");
    expect(findProfile("sam")).toBe("sam");
    expect(findProfile("SAM")).toBeUndefined();
  });

  it("loads a profile by any case and keeps its data under the real name", () => {
    addProfile("MED");
    const profile = loadProfile("med");
    expect(profile.name).toBe("MED");
    expect(profile.dataDir).toBe(path.join(dir, "data", "MED"));
    expect(fs.readdirSync(path.join(dir, "data"))).toEqual(["MED"]);
  });
});
