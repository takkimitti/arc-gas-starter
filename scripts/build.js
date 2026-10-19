import { cp, mkdir, rm } from "node:fs/promises";
const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(
  new URL("../index.html", import.meta.url),
  new URL("index.html", output),
);
await cp(new URL("../src/", import.meta.url), new URL("src/", output), {
  recursive: true,
});
// First Transfer page (new in v0.3-dev).
await mkdir(new URL("first-transfer/", output), { recursive: true });
await cp(
  new URL("../first-transfer/index.html", import.meta.url),
  new URL("first-transfer/index.html", output),
);
console.log("Built static app in dist/ (includes first-transfer/)");
