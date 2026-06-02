import { readFile } from "node:fs/promises";

export interface HtmlEntries {
  /** Chunks referenced by <script src> (module + classic), in document order. */
  scripts: string[];
  /** Chunks hinted via <link rel=modulepreload href>. */
  modulePreloads: string[];
}

/** Normalize an href/src like `/chunk-X.js` or `./chunk-X.js` to a bare basename. */
function toBasename(ref: string): string {
  const noQuery = ref.split(/[?#]/, 1)[0] ?? ref;
  const parts = noQuery.split("/");
  return parts[parts.length - 1] ?? noQuery;
}

/**
 * Extract the JS entry points from an Angular index.html: the <script> tags
 * (these are the true roots the browser executes) and the modulepreload hints.
 */
export async function parseHtmlEntries(htmlPath: string): Promise<HtmlEntries> {
  const html = await readFile(htmlPath, "utf-8");

  const scripts: string[] = [];
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js)["'][^>]*>/gi;
  for (let m = scriptRe.exec(html); m !== null; m = scriptRe.exec(html)) {
    scripts.push(toBasename(m[1]!));
  }

  const modulePreloads: string[] = [];
  const linkRe = /<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi;
  const hrefRe = /\bhref\s*=\s*["']([^"']+\.js)["']/i;
  for (let m = linkRe.exec(html); m !== null; m = linkRe.exec(html)) {
    const href = hrefRe.exec(m[0]);
    if (href) modulePreloads.push(toBasename(href[1]!));
  }

  return { scripts, modulePreloads };
}
