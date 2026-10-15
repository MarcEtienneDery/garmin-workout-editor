/**
 * storeCli.ts — look after the document store from the command line.
 *
 *   npm run store -- list [prefix]
 *   npm run store -- history <path>
 *   npm run store -- show <path> [revisionId]
 *   npm run store -- restore <path> [revisionId]     # last revision by default; also brings back a deleted document
 *   npm run store -- trash                           # deleted documents that can be restored
 *   npm run store -- owner <path> <profile|shared>   # who sees a plan under workout-plans/
 *   npm run store -- export <dir>                    # write every document back out as a file
 *
 * In the container: docker exec garmin-mcp node dist/storeCli.js <command>
 */
import { StoreError, closeStore, exportFiles, getStore, normalizeLogicalPath } from "./shared/store";

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function runStoreCli(args: string[], out: (line: string) => void): number {
  const [command, ...rest] = args;
  const store = getStore();
  const path = () => {
    if (!rest[0]) throw new Error(`${command}: missing <path>`);
    return normalizeLogicalPath(rest[0]);
  };
  const revisionId = (index: number) => (rest[index] === undefined ? undefined : Number(rest[index]));

  switch (command) {
    case "list": {
      const metas = store.list(rest[0] ?? "");
      for (const m of metas) out(`${m.path}\tv${m.version}\t${m.size} B\t${when(m.updatedAt)}\t${m.source}${m.owner && !m.path.startsWith("data/") ? `\towner ${m.owner}` : ""}`);
      out(`${metas.length} document(s) in the store (${store.location})`);
      return 0;
    }
    case "history": {
      const target = path();
      const current = store.head(target);
      if (current) out(`now\tv${current.version}\t${current.size} B\t${when(current.updatedAt)}\t${current.source}`);
      for (const r of store.history(target)) out(`#${r.id}\tv${r.version}\t${r.size} B\t${when(r.savedAt)}\t${r.source}`);
      if (!current && store.history(target).length === 0) throw new Error(`No document or history for ${target}`);
      return 0;
    }
    case "show": {
      const target = path();
      const id = revisionId(1);
      const text = id === undefined ? store.get(target)?.text : store.revision(target, id)?.text;
      if (text === undefined) throw new Error(id === undefined ? `File not found: ${target}` : `No revision #${id} of ${target}`);
      out(text);
      return 0;
    }
    case "restore": {
      const target = path();
      const id = revisionId(1) ?? store.history(target)[0]?.id;
      const revision = id === undefined ? undefined : store.revision(target, id);
      if (!revision) throw new Error(`Nothing to restore for ${target}`);
      const meta = store.head(target)
        ? store.put(target, revision.text, { replace: true, source: "restore" })
        : store.put(target, revision.text, { create: true, source: "restore" });
      out(`Restored ${target} from revision #${revision.id} (saved ${when(revision.savedAt)} by ${revision.source}); now v${meta.version}`);
      return 0;
    }
    case "trash": {
      const gone = store.deleted();
      for (const r of gone) out(`${r.path}\t#${r.id}\t${r.size} B\tlast saved ${when(r.savedAt)} by ${r.source}`);
      out(`${gone.length} deleted document(s); restore one with: restore <path>`);
      return 0;
    }
    case "owner": {
      const target = path();
      const who = rest[1];
      if (!who) throw new Error("owner: say a profile name, or \"shared\"");
      const meta = store.setOwner(target, who === "shared" ? null : who);
      out(`${target} is now ${meta.owner ? `owned by ${meta.owner}` : "shared"}`);
      return 0;
    }
    case "export": {
      if (!rest[0]) throw new Error("export: missing <dir>");
      const written = exportFiles(store, rest[0]);
      out(`Wrote ${written.length} file(s) under ${rest[0]}`);
      return 0;
    }
    default:
      out("Usage: store <list [prefix] | history <path> | show <path> [id] | restore <path> [id] | trash | owner <path> <profile|shared> | export <dir>>");
      return command ? 2 : 0;
  }
}

if (require.main === module) {
  try {
    process.exitCode = runStoreCli(process.argv.slice(2), (line) => console.log(line));
  } catch (error) {
    console.error(error instanceof StoreError || error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    closeStore();
  }
}
