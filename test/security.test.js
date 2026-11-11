const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { handleRequest, startServer } = require("../server");
const { createStaticHandler } = require("../static-files");

const AUTH_ENV = ["NODE_ENV", "VERCEL", "COACH_LOOP_API_TOKEN", "COACH_LOOP_MCP_TOKEN",
  "COACH_LOOP_REQUIRE_MCP_OAUTH", "COACH_LOOP_MCP_AUTH", "COACH_LOOP_OAUTH_PASSWORD",
  "COACH_LOOP_OAUTH_SIGNING_SECRET", "COACH_LOOP_CRON_SECRET", "CRON_SECRET",
  "COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL", "COACH_LOOP_ALLOW_FILE_STORAGE",
  "COACH_LOOP_DATA_DIR", "COACH_LOOP_HOST"];

function environment(t, values = {}) {
  const before = Object.fromEntries(AUTH_ENV.map((key) => [key, process.env[key]]));
  AUTH_ENV.forEach((key) => delete process.env[key]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-security-"));
  Object.assign(process.env, { COACH_LOOP_DATA_DIR: path.join(root, "data"),
    COACH_LOOP_ALLOW_FILE_STORAGE: "true", ...values });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function request(handler, { method = "GET", url = "/api/state", headers = {},
  peer = "127.0.0.1", body = "", ...options } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", ...headers };
  req.socket = { remoteAddress: peer };
  return new Promise((resolve, reject) => {
    const res = {
      status: 200, headers: {},
      writeHead(status, responseHeaders = {}) { this.status = status; this.headers = responseHeaders; },
      end(value) { resolve({ status: this.status, headers: this.headers, text: value?.toString() || "" }); }
    };
    Promise.resolve(handler(req, res, options.pathname)).catch(reject);
  });
}

for (const mode of [{}, { NODE_ENV: "production" }, { VERCEL: "1" },
  { NODE_ENV: "production", COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL: "true" },
  { VERCEL: "1", COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL: "true" }]) {
  test(`missing auth fails closed before storage or MCP body parsing: ${JSON.stringify(mode)}`, async (t) => {
    const root = environment(t, mode);
    for (const url of ["/api/state", "/api/backups", "/api/backups/create"]) {
      const response = await request(handleRequest, { url });
      assert.equal(response.status, 401, url);
    }
    const write = await request(handleRequest, { method: "POST", url: "/api/goals", body: "invalid-json" });
    assert.equal(write.status, 401);
    const mcp = await request(handleRequest, { method: "POST", url: "/mcp", body: "invalid-json" });
    assert.equal(mcp.status, 401);
    assert.equal(fs.existsSync(path.join(root, "data")), false, "rejected requests must not initialize storage");
  });
}

test("an owner API token cannot silently grant unauthenticated MCP access", async (t) => {
  const root = environment(t, { COACH_LOOP_API_TOKEN: "synthetic-owner-token",
    COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL: "true" });
  for (const authorization of [undefined, "Bearer synthetic-owner-token", "Bearer wrong"]) {
    const response = await request(handleRequest, { url: "/mcp", method: "POST",
      headers: authorization ? { authorization } : {}, body: "invalid-json" });
    assert.equal(response.status, 401);
  }
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});

test("configured API and MCP bearer tokens still work and reject wrong tokens", async (t) => {
  environment(t, { COACH_LOOP_API_TOKEN: "synthetic-owner-token", COACH_LOOP_MCP_TOKEN: "synthetic-mcp-token" });
  assert.equal((await request(handleRequest, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request(handleRequest, { headers: { authorization: "Bearer synthetic-owner-token" } })).status, 200);
  assert.equal((await request(handleRequest, { url: "/mcp", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await request(handleRequest, { url: "/mcp", headers: { authorization: "Bearer synthetic-mcp-token" } })).status, 405);
});

test("blank tokens and a development-signed cookie do not authorize a configured service", async (t) => {
  environment(t, { COACH_LOOP_API_TOKEN: "   ", COACH_LOOP_MCP_TOKEN: "''" });
  const payload = Buffer.from(JSON.stringify({ type: "owner_session", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const signature = crypto.createHmac("sha256", "coach-loop-dev-secret").update(payload).digest("base64url");
  assert.equal((await request(handleRequest, { headers: { cookie: `coach_loop_session=${payload}.${signature}` } })).status, 401);
  assert.equal((await request(handleRequest, { url: "/mcp" })).status, 401);
});

test("unauthenticated development is explicit, loopback-only, and unavailable behind forwarding headers", async (t) => {
  environment(t, { COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL: "true" });
  assert.equal((await request(handleRequest)).status, 200);
  assert.equal((await request(handleRequest, { url: "/mcp" })).status, 405);
  assert.equal((await request(handleRequest, { peer: "192.0.2.10" })).status, 401);
  assert.equal((await request(handleRequest, { headers: { host: "untrusted.example" } })).status, 401);
  assert.equal((await request(handleRequest, { headers: { "x-forwarded-for": "192.0.2.10" } })).status, 401);
  assert.equal((await request(handleRequest, { url: "/api/backups/create" })).status, 401);
  process.env.COACH_LOOP_HOST = "0.0.0.0";
  assert.throws(() => startServer(0), /requires a loopback host/);
});

test("cron requires its own nonblank bearer before accessing storage", async (t) => {
  const root = environment(t, { COACH_LOOP_API_TOKEN: "synthetic-owner-token", COACH_LOOP_CRON_SECRET: "synthetic-cron-token" });
  for (const authorization of ["Bearer wrong", "Bearer synthetic-owner-token"]) {
    assert.equal((await request(handleRequest, { url: "/api/backups/create", headers: { authorization } })).status, 401);
  }
  assert.equal(fs.existsSync(path.join(root, "data")), false);
  assert.equal((await request(handleRequest, { url: "/api/backups/create", headers: { authorization: "Bearer synthetic-cron-token" } })).status, 201);
});

test("public health and login state remain available without opening storage", async (t) => {
  const root = environment(t);
  assert.equal((await request(handleRequest, { url: "/api/healthz" })).status, 200);
  const session = await request(handleRequest, { url: "/api/session" });
  assert.equal(JSON.parse(session.text).authenticated, false);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});

test("static serving allows only named assets and rejects private paths and traversals", async (t) => {
  const root = environment(t);
  const web = path.join(root, "web");
  fs.mkdirSync(web);
  for (const name of ["index.html", "app.js", "client-sync.js", "styles.css", ".env", "server.js", "package.json"]) {
    fs.writeFileSync(path.join(web, name), `fixture ${name}`);
  }
  fs.mkdirSync(path.join(web, "data"));
  fs.writeFileSync(path.join(web, "data/store.json"), "private fixture");
  fs.mkdirSync(`${web}-sibling`);
  fs.writeFileSync(path.join(`${web}-sibling`, "canary.txt"), "sibling fixture");
  const handler = createStaticHandler(web);
  for (const pathname of ["/", "/index.html", "/app.js", "/client-sync.js", "/styles.css"]) {
    const response = await request(handler, { pathname });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  for (const pathname of ["/.env", "/.git/config", "/server.js", "/package.json", "/data/store.json",
    "/docs", "/%2eenv", "/%2e%2e/web-sibling/canary.txt", "/../web-sibling/canary.txt",
    "/%252e%252e/web-sibling/canary.txt", "/app.js/../.env"]) {
    const response = await request(handler, { pathname });
    assert.equal(response.status, 404, pathname);
    assert.equal(response.text, "");
  }
  const head = await request(handler, { method: "HEAD", pathname: "/app.js" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.equal((await request(handler, { method: "POST", pathname: "/app.js" })).status, 405);
  fs.unlinkSync(path.join(web, "app.js"));
  fs.symlinkSync(path.join(`${web}-sibling`, "canary.txt"), path.join(web, "app.js"));
  assert.equal((await request(handler, { pathname: "/app.js" })).status, 404);
});

test("the main handler denies repository paths and starts on loopback by default", async (t) => {
  environment(t);
  for (const url of ["/server.js", "/oauth.js", "/package.json", "/.git/config", "/%2eenv", "/%2e%2fserver.js"]) {
    assert.equal((await request(handleRequest, { url })).status, 404, url);
  }
  assert.equal((await request(handleRequest, { url: "/" })).status, 200);
  const { once } = require("node:events");
  const server = startServer(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (!server.listening) await once(server, "listening");
  assert.equal(server.address().address, "127.0.0.1");
});
