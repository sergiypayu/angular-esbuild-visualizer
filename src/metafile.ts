import { readFile } from "node:fs/promises";
import type { EsbuildImport, EsbuildMetafile, EsbuildOutput } from "./types.ts";

export async function loadMetafile(statsPath: string): Promise<EsbuildMetafile> {
  const raw = await readFile(statsPath, "utf-8");
  const json = JSON.parse(raw) as unknown;
  if (
    typeof json !== "object" ||
    json === null ||
    !("outputs" in json) ||
    !("inputs" in json)
  ) {
    throw new Error(
      `${statsPath} is not an esbuild metafile (missing "inputs"/"outputs"). ` +
        `Build with the Angular esbuild builder and \`--stats-json\`.`,
    );
  }
  return json as EsbuildMetafile;
}

export const isJs = (file: string): boolean =>
  file.endsWith(".js") && !file.endsWith(".js.map");

/** Static (eager) import-statement edges out of an output, JS targets only. */
export function staticImports(out: EsbuildOutput): string[] {
  return edgeTargets(out.imports, "import-statement");
}

/** Dynamic-import (lazy) edges out of an output, JS targets only. */
export function dynamicImports(out: EsbuildOutput): string[] {
  return edgeTargets(out.imports, "dynamic-import");
}

function edgeTargets(imports: EsbuildImport[] | undefined, kind: string): string[] {
  if (!imports) return [];
  const seen = new Set<string>();
  for (const imp of imports) {
    if (imp.kind === kind && isJs(imp.path)) seen.add(imp.path);
  }
  return [...seen];
}
