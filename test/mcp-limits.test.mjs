import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoachLoopMcpServer } from "../mcp/coach-loop-tools.mjs";
import limits from "../mcp-limits.js";

const require = createRequire(import.meta.url);
const { handleRequest, startServer } = require("../server.js");
const { readMcpBody, MCP_MAX_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS,
  MCP_MAX_BATCH_MESSAGES, MCP_MAX_JSON_DEPTH, MCP_MAX_JSON_MEMBERS } = limits;

function rawRequest(chunks = [], headers = {}) {
  const req = Readable.from(chunks);
  req.headers = headers;
  return req;
}

function parsedRequest(body, headers = {}) {
  return { headers, body };
}

test("MCP body byte boundary applies to raw strings, buffers, streams, and pre-parsed objects", async () => {
  const accepted = { value: "a".repeat(MCP_MAX_BODY_BYTES - Buffer.byteLength('{"value":""}')) };
  const text = JSON.stringify(accepted);
  assert.equal(Buffer.byteLength(text), MCP_MAX_BODY_BYTES);
  const rejected = { value: accepted.value + "a" };
  for (const wrap of [
    (v) => parsedRequest(v),
    (v) => parsedRequest(JSON.stringify(v)),
    (v) => parsedRequest(Buffer.from(JSON.stringify(v))),
    (v) => rawRequest([Buffer.from(JSON.stringify(v))])
  ]) {
    assert.deepEqual(await readMcpBody(wrap(accepted)), accepted);
    await assert.rejects(readMcpBody(wrap(rejected)), (e) => e.statusCode === 413);
  }
});

test("MCP limits use UTF-8 bytes and include JSON escaping in pre-parsed bodies", async () => {
  for (const value of ["🙂".repeat(MCP_MAX_BODY_BYTES / 4), "\u0000".repeat(MCP_MAX_BODY_BYTES / 6)]) {
    assert.ok(value.length < MCP_MAX_BODY_BYTES);
    await assert.rejects(readMcpBody(parsedRequest({ value })), (e) => e.statusCode === 413);
  }
});

test("a declared oversized body is rejected before reading either body representation", async () => {
  const req = { headers: { "content-length": String(MCP_MAX_BODY_BYTES + 1) },
    get body() { throw new Error("must not inspect body"); } };
  await assert.rejects(readMcpBody(req), (e) => e.statusCode === 413);
});

test("streaming byte accounting handles split UTF-8 and absent Content-Length", async () => {
  const bytes = Buffer.from(JSON.stringify({ message: "A🙂B" }));
  assert.deepEqual(await readMcpBody(rawRequest([bytes.subarray(0, 15), bytes.subarray(15)])), { message: "A🙂B" });
  const req = rawRequest([Buffer.alloc(MCP_MAX_BODY_BYTES, 32), Buffer.from(" ")]);
  await assert.rejects(readMcpBody(req), (e) => e.statusCode === 413);
  assert.equal(req.isPaused(), true);
});

test("pre-parsed and streamed batches share an explicit 100-message ceiling", async () => {
  const message = { jsonrpc: "2.0", method: "notifications/initialized" };
  const accepted = Array.from({ length: MCP_MAX_BATCH_MESSAGES }, () => ({ ...message }));
  const rejected = [...accepted, { ...message }];
  assert.equal((await readMcpBody(parsedRequest(accepted))).length, MCP_MAX_BATCH_MESSAGES);
  for (const req of [parsedRequest(rejected), rawRequest([JSON.stringify(rejected)])]) {
    await assert.rejects(readMcpBody(req), (e) => e.statusCode === 400 && /batch exceeds/.test(e.message));
  }
});

test("deep, overly wide, cyclic, and accessor-containing pre-parsed bodies are bounded", async () => {
  let nested = {};
  for (let i = 0; i < MCP_MAX_JSON_DEPTH + 1; i++) nested = { next: nested };
  for (const req of [parsedRequest(nested), rawRequest([JSON.stringify(nested)])]) {
    await assert.rejects(readMcpBody(req), (e) => e.statusCode === 400 && /nesting/.test(e.message));
  }
  const wide = Array.from({ length: MCP_MAX_JSON_MEMBERS + 1 }, () => null);
  await assert.rejects(readMcpBody(parsedRequest({ wide })), (e) => e.statusCode === 413 && /JSON members/.test(e.message));
  const cyclic = {}; cyclic.next = cyclic;
  await assert.rejects(readMcpBody(parsedRequest(cyclic)), (e) => e.statusCode === 400);
  const accessor = { get value() { throw new Error("getter must not execute"); } };
  await assert.rejects(readMcpBody(parsedRequest(accessor)), (e) => e.statusCode === 400 && /accessors/.test(e.message));
  await assert.rejects(readMcpBody(parsedRequest({ toJSON() { throw new Error("hook must not execute"); } })), (e) => e.statusCode === 400);
});

test("empty, null, and malformed bodies have deterministic outcomes", async () => {
  assert.deepEqual(await readMcpBody(rawRequest()), {});
  assert.equal(await readMcpBody(parsedRequest(null)), null);
  await assert.rejects(readMcpBody(rawRequest(["not-json"])), (e) => e.statusCode === 400 && /valid JSON/.test(e.message));
});

async function connectedServer(t) {
  const server = createCoachLoopMcpServer({ apiUrl: "http://127.0.0.1:4173", apiToken: "synthetic-backend-token" });
  const client = new Client({ name: "limits-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("SDK collection ceiling rejects oversized arrays, objects and invalid constrained inputs before backend work", async (t) => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("backend must not be called"); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const client = await connectedServer(t);
  for (const args of [
    { name: "upsert_gear", arguments: { gear: Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS }, () => ({})) } },
    { name: "upsert_gear", arguments: { gear: Object.fromEntries(Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS }, (_, i) => [`item${i}`, 0])) } },
    { name: "import_weekly_plan", arguments: { plan: { week_start_date: "2026-11-02", goals: ["Fixture"], activities: Array(MCP_MAX_TOOL_INPUT_ELEMENTS).fill(null) } } }
  ]) {
    const result = await client.callTool(args);
    assert.equal(result.isError, true);
    const text = result.content.map((c) => c.text || "").join("");
    assert.match(text, /maximum of 10000 elements/);
    assert.ok(text.length < 500, "error must not amplify invalid input");
  }
  assert.equal(calls, 0);
});

test("SDK accepts the exact collection boundary and an ordinary complete weekly plan", async (t) => {
  const oldFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const client = await connectedServer(t);
  const gear = Object.fromEntries(Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS - 1 }, (_, i) => [`item${i}`, 0]));
  assert.notEqual((await client.callTool({ name: "upsert_gear", arguments: { gear } })).isError, true);
  const plan = { week_start_date: "2026-11-02", goals: ["Fixture training"], activities: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-11-${String(i + 2).padStart(2, "0")}`, title: "Synthetic strength session", type: "strength",
    subtasks: Array.from({ length: 8 }, (_, j) => ({ title: `Synthetic movement ${j}`, log_mode: "strength" }))
  })) };
  assert.notEqual((await client.callTool({ name: "import_weekly_plan", arguments: { plan } })).isError, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, plan);
});

function mcpEnvironment(t) {
  const values = { COACH_LOOP_API_TOKEN: "synthetic-owner-token", COACH_LOOP_MCP_TOKEN: "synthetic-mcp-token",
    COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL: undefined, COACH_LOOP_REQUIRE_MCP_OAUTH: undefined };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

async function handlerResponse(req) {
  req.method = "POST";
  req.url = "/mcp";
  req.headers = { host: "127.0.0.1", ...req.headers };
  return new Promise((resolve, reject) => {
    const res = new EventEmitter();
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.end = (body) => resolve({ status: res.status, text: body?.toString() || "" });
    handleRequest(req, res).catch(reject);
  });
}

test("main handler authenticates first and enforces limits on Vercel-style pre-parsed bodies", async (t) => {
  mcpEnvironment(t);
  const unauthenticated = { headers: {}, get body() { throw new Error("body must not be inspected"); } };
  assert.equal((await handlerResponse(unauthenticated)).status, 401);
  const declaredOverflow = { headers: { authorization: "Bearer synthetic-mcp-token", "content-length": String(MCP_MAX_BODY_BYTES + 1) },
    get body() { throw new Error("declared overflow must not inspect a pre-parsed body"); } };
  assert.equal((await handlerResponse(declaredOverflow)).status, 413);
  for (const body of ["x".repeat(MCP_MAX_BODY_BYTES + 1), Buffer.alloc(MCP_MAX_BODY_BYTES + 1), { value: "x".repeat(MCP_MAX_BODY_BYTES) }]) {
    assert.equal((await handlerResponse(parsedRequest(body, { authorization: "Bearer synthetic-mcp-token" }))).status, 413);
  }
  assert.equal((await handlerResponse(parsedRequest(Array(MCP_MAX_BATCH_MESSAGES + 1).fill(null), { authorization: "Bearer synthetic-mcp-token" }))).status, 400);
});

test("chunked HTTP overflows return 413 cleanly without a declared body length", async (t) => {
  mcpEnvironment(t);
  const server = startServer(0);
  if (!server.listening) await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/mcp", method: "POST",
      headers: { authorization: "Bearer synthetic-mcp-token", "content-type": "application/json", "transfer-encoding": "chunked" } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.write(Buffer.alloc(MCP_MAX_BODY_BYTES, 32));
    req.end(" ");
  });
  assert.equal(status, 413);
});
