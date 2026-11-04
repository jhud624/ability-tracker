import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildStaticOutput, PUBLIC_ASSETS } from "../scripts/build-static.mjs";

const require = createRequire(import.meta.url);

test("generated static output excludes root backend/data files and stale output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coach-public-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of PUBLIC_ASSETS) await writeFile(path.join(root, file), `public fixture ${file}`);
  for (const file of ["server.js", "oauth.js", ".env", "package.json"]) await writeFile(path.join(root, file), "private fixture");
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/store.json"), "private fixture");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist/server.js"), "stale private fixture");
  const output = await buildStaticOutput(root);
  assert.deepEqual((await readdir(output)).sort(), [...PUBLIC_ASSETS].sort());
  for (const file of PUBLIC_ASSETS) assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(root, file)));
  assert.equal(await readFile(path.join(root, "server.js"), "utf8"), "private fixture");
});

test("a public asset symlink cannot copy backend source into deployed output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coach-public-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of PUBLIC_ASSETS) await writeFile(path.join(root, file), "public fixture");
  await writeFile(path.join(root, "server.js"), "private fixture");
  await unlink(path.join(root, "app.js"));
  await symlink(path.join(root, "server.js"), path.join(root, "app.js"));
  await assert.rejects(buildStaticOutput(root), /regular file/);
});

test("Vercel uses generated output while retaining both serverless handlers and rewrites", async () => {
  assert.deepEqual(PUBLIC_ASSETS, ["index.html", "client-sync.js", "app.js", "styles.css"]);
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="client-sync.js"') < html.indexOf('src="app.js"'));
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, "dist");
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(manifest.scripts.build, "node scripts/build-static.mjs");
  assert.deepEqual(config.rewrites, [
    { source: "/mcp", destination: "/api/mcp.js" },
    { source: "/.well-known/(.*)", destination: "/api/[...path].js" },
    { source: "/oauth/(.*)", destination: "/api/[...path].js" },
    { source: "/api/(.*)", destination: "/api/[...path].js" }
  ]);
  assert.deepEqual(config.crons, [{ path: "/api/backups/create", schedule: "20 8 * * *" }]);
  const { handleRequest } = require("../server.js");
  assert.equal(require("../api/mcp.js"), handleRequest);
  assert.equal(require("../api/[...path].js"), handleRequest);
});
