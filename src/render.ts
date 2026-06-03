import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VisualizerData } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function readClientAsset(name: string): Promise<string> {
  for (const base of [join(here, "client"), join(here, "..", "src", "client")]) {
    try {
      return await readFile(join(base, name), "utf-8");
    } catch {
      /* try next */
    }
  }
  throw new Error(`Could not locate client asset ${name}`);
}

// The JS line/paragraph separators (U+2028 / U+2029) are illegal in pre-ES2019
// string literals; escape them defensively along with < and > so the JSON is
// safe to embed inside a <script> element. Built from char codes to keep the
// raw separator characters out of this source file.
const UNSAFE = new RegExp("[<>" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(UNSAFE, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function renderHtml(data: VisualizerData): Promise<string> {
  const css = await readClientAsset("style.css");
  const js = await readClientAsset("app.js");
  const title = escapeHtml(data.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <span class="gen" title="generated ${escapeHtml(data.generatedAt)}">${escapeHtml(data.source)}</span>
  <div class="stats" id="stats"></div>
</header>
<div class="legend">
  <span><i class="swatch" style="background:#746ac1"></i> entry (index.html)</span>
  <span><i class="swatch" style="background:#428f6b"></i> eager (static import)</span>
  <span><i class="swatch" style="background:#f49634"></i> lazy (dynamic import / route)</span>
  <span><i class="swatch" style="background:#3a4d91"></i> shared-eager ref</span>
  <span><i class="swatch" style="background:#5a6577"></i> seen ref (expanded elsewhere)</span>
</div>
<div class="toolbar">
  <input type="search" id="search" placeholder="filter chunks / modules / routes...">
  <button class="link" id="expand-all">expand all</button>
  <button class="link" id="collapse-all">collapse all</button>
  <span class="spacer"></span>
</div>
<main>
  <div class="pane tree" id="tree"></div>
  <div class="resizer" id="resizer" title="Drag to resize"></div>
  <div class="pane detail" id="detail"><div class="empty">Select a chunk to inspect its original-module contents.</div></div>
</main>
<div class="tip" id="tip"></div>
<script>window.__VIZ__ = ${safeJson(data)};</script>
<script>${js}</script>
</body>
</html>
`;
}
