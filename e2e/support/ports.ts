import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "../..");
const worktree = fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isFile() ?? false;
const own = 20000 + 2 * (crypto.createHash("sha1").update(root).digest().readUInt32BE(0) % 5000);
const base = Number(process.env.E2E_BASE_PORT || (worktree ? own : 8792));

export const MAIN = base;
export const MOCK = base + 1;

if (require.main === module) console.log(`app ${MAIN}, mock mode ${MOCK}`);
