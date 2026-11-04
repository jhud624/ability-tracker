const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { handleRequest } = require("../server");

function setup(t, mode, apiToken) {
  const values = { NODE_ENV: undefined, VERCEL: undefined, COACH_LOOP_REQUIRE_MCP_OAUTH: "true",
    COACH_LOOP_API_TOKEN: apiToken, COACH_LOOP_OAUTH_PASSWORD: "synthetic-owner-password",
    COACH_LOOP_OAUTH_SIGNING_SECRET: "synthetic-signing-secret", COACH_LOOP_ALLOW_FILE_STORAGE: "true",
    COACH_LOOP_MCP_TOKEN: "synthetic-mcp-token", ...mode };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-config-"));
  values.COACH_LOOP_DATA_DIR = path.join(root, "data");
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

async function response(url, method = "GET") {
  const req = { url, method, headers: { host: "127.0.0.1", authorization: "Bearer synthetic-mcp-token" },
    get body() { throw new Error("incomplete hosted configuration must not inspect bodies"); } };
  return new Promise((resolve, reject) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { resolve({ status: this.status, headers: this.headers, body }); } };
    handleRequest(req, res).catch(reject);
  });
}

for (const mode of [{ NODE_ENV: "production" }, { VERCEL: "1" }]) {
  for (const token of [undefined, "   ", "''"]) {
    test(`incomplete hosted MCP configuration blocks sessions and discovery: ${JSON.stringify(mode)}, token ${String(token)}`, async (t) => {
      const root = setup(t, mode, token);
      for (const [url, method] of [["/api/session", "GET"], ["/api/session/login", "POST"],
        ["/oauth/authorize", "GET"], ["/oauth/authorize", "POST"], ["/oauth/token", "POST"],
        ["/mcp", "POST"], ["/mcp", "GET"]]) {
        const result = await response(url, method);
        assert.equal(result.status, 503, `${method} ${url}`);
        assert.equal(result.headers["set-cookie"], undefined);
      }
      assert.equal(fs.existsSync(path.join(root, "data")), false);
      const logout = await response("/api/session/logout", "POST");
      assert.equal(logout.status, 200);
      assert.match(logout.headers["set-cookie"], /Max-Age=0/);
    });
  }
}
