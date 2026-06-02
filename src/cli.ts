#!/usr/bin/env -S node --experimental-strip-types
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { buildModel } from "./graph.ts";
import { parseHtmlEntries } from "./html-entry.ts";
import { loadMetafile } from "./metafile.ts";
import { renderHtml } from "./render.ts";

interface Args {
  dir: string;
  stats?: string;
  html?: string;
  filename: string;
  title: string;
  top: number;
  open: boolean;
}

const HELP = `angular-esbuild-visualizer — visualize the import branch of an Angular esbuild bundle.

Usage:
  angular-esbuild-visualizer [dir] [options]

Arguments:
  dir                 Built bundle directory (contains stats.json + index.html). Default: cwd.

Options:
  --stats <path>      Path to the esbuild metafile (Angular --stats-json). Default: <dir>/stats.json
  --html <path>       Path to index.html.                                   Default: <dir>/index.html
  -o, --filename <p>  Output HTML file. Default: ./angular-deps.html
  --title <text>      Document title. Default: "Angular Import Visualizer"
  --top <n>           Module names shown in each chunk's [..] label. Default: 3
  --open              Open the result in the default browser.
  -h, --help          Show this help.

Example:
  angular-esbuild-visualizer dist/my-app/browser -o /tmp/deps.html --open
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dir: process.cwd(),
    filename: "./angular-deps.html",
    title: "Angular Import Visualizer",
    top: 3,
    open: false,
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
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        positional.push(a);
    }
  }
  if (positional[0]) args.dir = positional[0];
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(args.dir);
  const statsPath = args.stats ? resolve(args.stats) : join(dir, "stats.json");
  const htmlPath = args.html ? resolve(args.html) : join(dir, "index.html");
  const outPath = isAbsolute(args.filename) ? args.filename : resolve(process.cwd(), args.filename);

  process.stderr.write(`• metafile : ${statsPath}\n`);
  process.stderr.write(`• index    : ${htmlPath}\n`);

  const [meta, html] = await Promise.all([loadMetafile(statsPath), parseHtmlEntries(htmlPath)]);
  const data = await buildModel(meta, html, { title: args.title, dir, topModules: args.top });

  process.stderr.write(
    `• chunks   : ${data.summary.jsChunkCount} JS  (eager ${data.summary.eagerChunkCount} / lazy ${data.summary.lazyChunkCount})\n` +
    `• eager JS : ${(data.summary.eagerJsBytes / 1024).toFixed(0)} KB initial · total ${(data.summary.totalJsBytes / 1024 / 1024).toFixed(2)} MB\n` +
    `• routes   : ${data.routes.length} dynamic root(s), ${data.summary.dynamicEdgeCount} dynamic edge(s)\n`,
  );

  const out = await renderHtml(data);
  await writeFile(outPath, out, "utf-8");
  process.stderr.write(`✓ wrote ${outPath}\n`);

  if (args.open) {
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
