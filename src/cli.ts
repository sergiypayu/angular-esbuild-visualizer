#!/usr/bin/env -S node --experimental-strip-types
import { access, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildAgentReport } from "./agent-report.ts";
import { buildModel } from "./graph.ts";
import { parseHtmlEntries } from "./html-entry.ts";
import { loadMetafile } from "./metafile.ts";
import { renderHtml } from "./render.ts";

interface Args {
  dir: string;
  stats?: string;
  html?: string;
  /** Explicit -o/--filename; when absent, defaults to ./angular-deps.html. */
  filename?: string;
  title: string;
  top: number;
  open: boolean;
  json: boolean;
}

const HELP = `angular-esbuild-visualizer — visualize the import branch of an Angular esbuild bundle.

Usage:
  angular-esbuild-visualizer [dir] [options]

Arguments:
  dir                 Angular build output directory: either the output root
                      (stats.json here, index.html under browser/) or the
                      browser subdir itself — the other half is found
                      automatically. Default: cwd.

Options:
  --stats <path>      Path to the esbuild metafile (Angular --stats-json).
                      Default: <dir>/stats.json, else <dir>/../stats.json
  --html <path>       Path to index.html.
                      Default: <dir>/index.html, else <dir>/browser/index.html
  -o, --filename <p>  Output HTML file. Default: ./angular-deps.html
  --title <text>      Document title. Default: "Angular Import Visualizer"
  --top <n>           Module names shown in each chunk's [..] label. Default: 3
  --open              Open the result in the default browser.
  --json              Print a machine-readable JSON report to stdout (for AI
                      agents / scripts). Skips the HTML file unless -o is also
                      given. Progress messages go to stderr.
  -h, --help          Show this help.

Examples:
  angular-esbuild-visualizer dist/my-app/browser -o /tmp/deps.html --open
  angular-esbuild-visualizer dist/my-app/browser --json > deps.json
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: process.cwd(),
    title: "Angular Import Visualizer",
    top: 3,
    open: false,
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0); break;
      case "--stats": args.stats = next(); break;
      case "--html": args.html = next(); break;
      case "-o": case "--filename": args.filename = next(); break;
      case "--title": args.title = next(); break;
      case "--top": args.top = Math.max(1, parseInt(next(), 10) || 3); break;
      case "--open": args.open = true; break;
      case "--json": args.json = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        positional.push(a);
    }
  }
  if (positional[0]) args.dir = positional[0];
  return args;
}

/** First candidate that exists on disk; else the first one (so the eventual
 * read error names the canonical location). */
async function firstExisting(...candidates: string[]): Promise<string> {
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return candidates[0]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  // The Angular application builder writes stats.json at the output *root* but
  // index.html (+ chunks) under browser/ — accept either directory as <dir>
  // and look one level up/down for the missing half.
  const statsPath = args.stats
    ? resolve(args.stats)
    : await firstExisting(join(dir, "stats.json"), join(dir, "..", "stats.json"));
  const htmlPath = args.html
    ? resolve(args.html)
    : await firstExisting(join(dir, "index.html"), join(dir, "browser", "index.html"));
  // With --json the HTML file is opt-in (explicit -o); stdout carries the report.
  const writeHtml = !args.json || args.filename !== undefined;
  const filename = args.filename ?? "./angular-deps.html";
  const outPath = isAbsolute(filename) ? filename : resolve(process.cwd(), filename);

  process.stderr.write(`• metafile : ${statsPath}\n`);
  process.stderr.write(`• index    : ${htmlPath}\n`);

  const [meta, html] = await Promise.all([loadMetafile(statsPath), parseHtmlEntries(htmlPath)]);
  const data = await buildModel(meta, html, {
    title: args.title,
    dir,
    chunkDir: dirname(htmlPath), // chunks are emitted next to index.html
    topModules: args.top,
  });

  process.stderr.write(
    `• chunks   : ${data.summary.jsChunkCount} JS  (eager ${data.summary.eagerChunkCount} / lazy ${data.summary.lazyChunkCount})\n` +
    `• eager JS : ${(data.summary.eagerJsBytes / 1024).toFixed(0)} KB initial · total ${(data.summary.totalJsBytes / 1024 / 1024).toFixed(2)} MB\n` +
    `• routes   : ${data.routes.length} dynamic root(s), ${data.summary.dynamicEdgeCount} dynamic edge(s)\n`,
  );

  if (args.json) {
    process.stdout.write(JSON.stringify(buildAgentReport(data, meta), null, 2) + "\n");
  }

  if (writeHtml) {
    const out = await renderHtml(data);
    await writeFile(outPath, out, "utf-8");
    process.stderr.write(`✓ wrote ${outPath}\n`);
  }

  if (args.open && !writeHtml) {
    process.stderr.write(`• --open ignored: no HTML written (pass -o together with --json)\n`);
  } else if (args.open) {
    // Open with the `open` package (as esbuild-visualizer does): launches the
    // OS default handler for the file. Note that's the `text/html` MIME default,
    // which may differ from the default web browser if mis-associated.
    const { default: open } = await import("open");
    await open(outPath);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
