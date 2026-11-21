import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(__dirname, "..", "web", "public", "index.html"), "utf8");

const declared = (pattern: RegExp): string[] => {
  const seen = new Map<string, number>();
  for (const m of html.matchAll(pattern)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
};

describe("index.html's script", () => {
  it("declares no function twice at the top level", () => {
    expect(declared(/^(?:async )?function\*? (\w+)\(/gm)).toEqual([]);
  });

  it("declares no const, let or var twice at the top level", () => {
    expect(declared(/^(?:const|let|var) (\w+)\b/gm)).toEqual([]);
  });

  it("does not declare a function and a variable of the same name", () => {
    const functions = new Set([...html.matchAll(/^(?:async )?function\*? (\w+)\(/gm)].map((m) => m[1]));
    const clashing = [...html.matchAll(/^(?:const|let|var) (\w+)\b/gm)].map((m) => m[1]).filter((name) => functions.has(name));
    expect(clashing).toEqual([]);
  });
});
