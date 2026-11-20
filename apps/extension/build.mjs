import { build } from "esbuild";
import { mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const vendor = join(here, "vendor");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(vendor, { recursive: true });

await build({
  entryPoints: {
    background: join(here, "src/background.ts"),
    content: join(here, "src/content.ts"),
    "probe-wpp": join(here, "src/probe-wpp.ts"),
    "page-bridge": join(here, "src/page-bridge.ts"),
    popup: join(here, "src/popup.ts"),
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: out,
  sourcemap: false,
  logLevel: "info",
});

const candidateSources = [
  join(here, "node_modules/@wppconnect/wa-js/dist/wppconnect-wa.js"),
  join(here, "../../node_modules/@wppconnect/wa-js/dist/wppconnect-wa.js"),
];
const wppSrc = candidateSources.find((src) => existsSync(src));
const wppDst = join(vendor, "wppconnect-wa.js");
const distVendor = join(out, "vendor");
mkdirSync(distVendor, { recursive: true });
if (wppSrc) {
  copyFileSync(wppSrc, wppDst);
  copyFileSync(wppSrc, join(distVendor, "wppconnect-wa.js"));
  console.log("wa-js copied to vendor/ and dist/vendor/ from", wppSrc);
} else {
  console.warn("wa-js not found in node_modules; skipping vendor copy (PR 9 will need it)");
}

const noticeText = `Lead Desk Connector vendors @wppconnect/wa-js (version 4.7.2).
Licensed under the Apache License, Version 2.0.
Source: https://github.com/wppconnect-team/wa-js
`;
writeFileSync(join(vendor, "NOTICE"), noticeText, "utf8");
writeFileSync(join(out, "vendor", "NOTICE"), noticeText, "utf8");

copyFileSync(join(here, "manifest.json"), join(out, "manifest.json"));
if (existsSync(join(here, "popup.html"))) {
  copyFileSync(join(here, "popup.html"), join(out, "popup.html"));
}
