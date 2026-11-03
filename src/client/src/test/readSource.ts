// Reads a client source file as text in tests. Vitest runs with `css: false`, which empties CSS even when it is
// imported with `?raw`, and the project has no @types/node, so Node's fs is reached through
// process.getBuiltinModule (Node >= 22.3) with a minimal local type.

interface MinimalFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}

interface MinimalProcess {
  getBuiltinModule(id: "node:fs"): MinimalFs;
}

/** The text of `relativePath`, resolved from `src/client/src/test/`. */
export function readSource(relativePath: string): string {
  const { process } = globalThis as unknown as { process: MinimalProcess };
  return process.getBuiltinModule("node:fs").readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
