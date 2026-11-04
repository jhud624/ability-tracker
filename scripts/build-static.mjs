import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_ASSETS = ["index.html", "client-sync.js", "app.js", "styles.css"];
const ROOT = fileURLToPath(new URL("../", import.meta.url));

export async function buildStaticOutput(root = ROOT) {
  for (const asset of PUBLIC_ASSETS) {
    if (!(await lstat(path.join(root, asset))).isFile()) {
      throw new Error(`Public asset must be a regular file: ${asset}`);
    }
  }
  const output = path.join(root, "dist");
  await rm(output, { recursive: true, force: true });
  await mkdir(output);
  for (const asset of PUBLIC_ASSETS) await copyFile(path.join(root, asset), path.join(output, asset));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStaticOutput();
  console.log(`Built public output: ${PUBLIC_ASSETS.join(", ")}`);
}
