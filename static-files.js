const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

const PUBLIC_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/client-sync.js", ["client-sync.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

function createStaticHandler(root) {
  return async (req, res, pathname) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const asset = PUBLIC_ASSETS.get(pathname);
    if (!asset) {
      res.writeHead(404);
      res.end();
      return;
    }
    let file;
    try {
      const realRoot = await fs.realpath(root);
      const candidate = path.join(realRoot, asset[0]);
      if (await fs.realpath(candidate) !== candidate) throw new Error("Not a public file");
      file = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Not a public file");
      const content = req.method === "HEAD" ? null : await file.readFile();
      res.writeHead(200, {
        "content-type": asset[1],
        "content-length": stat.size,
        "x-content-type-options": "nosniff"
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end();
    } finally {
      await file?.close();
    }
  };
}

module.exports = { createStaticHandler };
