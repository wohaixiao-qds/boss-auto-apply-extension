import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}/dist`;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = ["background", "content", "dashboard", "popup", "options"];
for (const entry of entries) {
  await build({
    entryPoints: [`${root}/src/${entry}.ts`],
    outfile: `${dist}/${entry}.js`,
    bundle: true,
    format: entry === "background" ? "esm" : "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    minify: false
  });
}

for (const asset of ["manifest.json", "dashboard.html", "dashboard.css", "popup.html", "popup.css", "options.html", "options.css", "content.css"]) {
  const source = asset === "manifest.json" ? `${root}/${asset}` : `${root}/src/${asset}`;
  await cp(source, `${dist}/${asset}`);
}
