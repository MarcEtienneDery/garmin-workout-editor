/**
 * The ports of the suite's two servers: 8792 (the app) and 8793 (mock mode) in the repository's own checkout, two of its own in a
 * linked git worktree (from its path), so suites run in two worktrees at once neither meet nor reuse each other's servers, which
 * would test the other checkout's code. E2E_BASE_PORT sets them: the app on it, mock mode on the next. `npx tsx e2e/support/ports.ts`
 * prints them.
 */
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
