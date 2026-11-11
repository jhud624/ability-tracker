const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { handleRequest } = require("../server");

async function request(path, method = "GET", body) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.url = path; req.method = method;
  req.headers = { host: "127.0.0.1", authorization: "Bearer synthetic-client-receipt", "content-type": "application/json" };
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status; }, end(value) { resolve({ status: this.status, value: JSON.parse(value) }); } };
    handleRequest(req, res).catch(reject);
  });
}

test("partial memory writes expose revision, restore generation and backup failure; summaries match saved state", async t => {
  const keys = ["COACH_LOOP_API_TOKEN", "COACH_LOOP_DATA_DIR"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  process.env.COACH_LOOP_API_TOKEN = "synthetic-client-receipt";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coach-client-receipts-"));
  process.env.COACH_LOOP_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, "backups"), "synthetic blocked directory");
  t.mock.method(console, "warn", () => {});
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const added = await request("/api/coach-memories/upsert", "POST", { coach_memories: [{ key: "synthetic", kind: "preference", category: "planning", text: "Synthetic preference" }] });
  assert.equal(added.status, 200);
  assert.ok(Number.isSafeInteger(added.value.revision));
  assert.equal(added.value.restored_at, null);
  assert.match(added.value.storage_warnings[0], /Primary data saved/);
  const removed = await request(`/api/coach-memories/${added.value.saved[0].memory_id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.ok(removed.value.revision > added.value.revision);
  assert.equal(removed.value.restored_at, null);
  assert.match(removed.value.storage_warnings[0], /Primary data saved/);
  const state = await request("/api/state"), summary = await request("/api/coach-summary");
  assert.equal(state.value.revision, removed.value.revision);
  assert.equal(summary.value.revision, removed.value.revision);
  assert.equal(summary.value.restored_at, null);
  assert.equal(state.value.storage_warnings, undefined, "warnings stay response-only");
});
