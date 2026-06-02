// Post-build step for the published package (run by `npm run build`).
//
// 1. tsc only compiles the .ts sources; the dependency-free browser client
//    (style.css + app.js) is inlined at runtime by render.js, so copy it next
//    to the compiled output where readClientAsset() looks first (dist/client).
// 2. The source shebang enables --experimental-strip-types so src/cli.ts can be
//    run directly in development. The compiled CLI is plain JS and ships under a
//    consumer's node_modules (where type-stripping is forbidden anyway), so give
//    dist/cli.js a plain `node` shebang.
import { cpSync, readFileSync, writeFileSync } from "node:fs";

cpSync("src/client", "dist/client", { recursive: true });

const cli = "dist/cli.js";
const text = readFileSync(cli, "utf8").replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n");
writeFileSync(cli, text);

console.log("postbuild: copied src/client → dist/client, normalized dist/cli.js shebang");
