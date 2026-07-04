import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const { startServer } = require("../server.js");

function codeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

async function startHttpServer() {
  const server = startServer(0);
  if (!server.listening) await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

test("Coach Loop MCP lists tools and can read the coach summary", async () => {
  const { server, url } = await startHttpServer();
  const client = new Client({ name: "coach-loop-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/coach-loop-mcp.mjs"],
    cwd: process.cwd(),
    env: {
      COACH_LOOP_API_URL: url,
      PATH: process.env.PATH || ""
    },
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_coach_summary"));
    assert.ok(names.includes("get_gear"));
    assert.ok(names.includes("upsert_gear"));
    assert.ok(names.includes("import_weekly_plan"));
    assert.ok(names.includes("update_goals"));
    assert.ok(names.includes("patch_goals"));
    assert.ok(names.includes("update_run_plan"));
    assert.ok(names.includes("get_run_plan"));
    assert.ok(names.includes("update_coach_notes"));

    const result = await client.callTool({ name: "get_coach_summary", arguments: {} });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /Coach summary/);
    assert.doesNotMatch(result.content[0].text, /route_map|heart_rate_series|route_shape/);

    const stateResult = await client.callTool({ name: "get_state", arguments: {} });
    assert.equal(stateResult.content[0].type, "text");
    assert.doesNotMatch(stateResult.content[0].text, /route_map|heart_rate_series|route_shape/);

    const runPlanResult = await client.callTool({ name: "get_run_plan", arguments: {} });
    assert.equal(runPlanResult.content[0].type, "text");
    assert.match(runPlanResult.content[0].text, /run_plan/);
    assert.match(runPlanResult.content[0].text, /planned_distances_miles/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Coach Loop MCP can patch goals and run plan without replacing goals", async () => {
  const { server, url } = await startHttpServer();
  const client = new Client({ name: "coach-loop-run-plan-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/coach-loop-mcp.mjs"],
    cwd: process.cwd(),
    env: {
      COACH_LOOP_API_URL: url,
      PATH: process.env.PATH || ""
    },
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    await client.callTool({
      name: "patch_goals",
      arguments: {
        goals: {
          primary: "Half marathon test goal",
          back_health: "Preserve this field"
        }
      }
    });
    await client.callTool({
      name: "update_run_plan",
      arguments: {
        race_date: "2026-10-18",
        weekly_runs: 4,
        peak_long_run_miles: 11,
        cutback_every_weeks: 4
      }
    });

    const stateResult = await client.callTool({ name: "get_state", arguments: {} });
    const state = JSON.parse(stateResult.content[0].text);
    assert.equal(state.goals.primary, "Half marathon test goal");
    assert.equal(state.goals.back_health, "Preserve this field");
    assert.equal(state.goals.race_date, "2026-10-18");
    assert.equal(state.goals.run_frequency_per_week, 4);
    assert.equal(state.goals.run_plan.weekly_runs, 4);
    assert.equal(state.goals.run_plan.peak_long_run_miles, 11);

    const runPlanResult = await client.callTool({ name: "get_run_plan", arguments: {} });
    const runPlanPayload = JSON.parse(runPlanResult.content[0].text);
    assert.equal(runPlanPayload.run_plan.race.date, "2026-10-18");
    assert.equal(runPlanPayload.run_plan.assumptions.weekly_runs, 4);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Coach Loop hosted MCP endpoint works over Streamable HTTP", async () => {
  const { server, url } = await startHttpServer();
  const client = new Client({ name: "coach-loop-http-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_planning_context"));

    const result = await client.callTool({ name: "get_planning_context", arguments: {} });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /gear/);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Coach Loop hosted MCP writes persist through the protected API path", async () => {
  const previousEnv = {
    COACH_LOOP_API_TOKEN: process.env.COACH_LOOP_API_TOKEN,
    COACH_LOOP_DATA_DIR: process.env.COACH_LOOP_DATA_DIR
  };
  process.env.COACH_LOOP_API_TOKEN = "test-api-token";
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-hosted-mcp-write-test-`);

  const { server, url } = await startHttpServer();
  const client = new Client({ name: "coach-loop-http-write-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));

  try {
    await client.connect(transport);
    await client.callTool({
      name: "patch_goals",
      arguments: {
        goals: {
          primary: "Persist hosted MCP writes"
        }
      }
    });
    const response = await fetch(`${url}/api/state`, {
      headers: { authorization: "Bearer test-api-token" }
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.goals.primary, "Persist hosted MCP writes");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test("Coach Loop OAuth flow protects MCP access", async () => {
  const previousEnv = {
    COACH_LOOP_API_TOKEN: process.env.COACH_LOOP_API_TOKEN,
    COACH_LOOP_OAUTH_PASSWORD: process.env.COACH_LOOP_OAUTH_PASSWORD,
    COACH_LOOP_REQUIRE_MCP_OAUTH: process.env.COACH_LOOP_REQUIRE_MCP_OAUTH
  };
  process.env.COACH_LOOP_API_TOKEN = "test-api-token";
  process.env.COACH_LOOP_OAUTH_PASSWORD = "test-owner-password";
  process.env.COACH_LOOP_REQUIRE_MCP_OAUTH = "true";

  const { server, url } = await startHttpServer();

  try {
    const metadata = await fetch(`${url}/.well-known/oauth-protected-resource`).then((response) => response.json());
    assert.deepEqual(metadata.authorization_servers, [url]);
    assert.equal(metadata.resource, `${url}/mcp`);

    const openidMetadata = await fetch(`${url}/.well-known/openid-configuration`).then((response) => response.json());
    assert.equal(openidMetadata.issuer, url);
    assert.equal(openidMetadata.token_endpoint, `${url}/oauth/token`);

    const registration = await fetch(`${url}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OAuth test",
        redirect_uris: ["https://chat.openai.com/aip/callback"]
      })
    }).then((response) => response.json());
    assert.match(registration.client_id, /^coach_loop_/);

    const verifier = "oauth-test-verifier-with-enough-entropy";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/callback",
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      state: "state-123",
      scope: "coach:read coach:write",
      resource: `${url}/mcp`
    };

    const authorizePage = await fetch(`${url}/oauth/authorize?${new URLSearchParams(authorizeParams)}`);
    assert.equal(authorizePage.status, 200);
    assert.match(await authorizePage.text(), /Authorize Coach Loop/);

    const authorizeResponse = await fetch(`${url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...authorizeParams,
        password: "test-owner-password"
      })
    });
    assert.equal(authorizeResponse.status, 302);
    const callbackUrl = new URL(authorizeResponse.headers.get("location"));
    assert.equal(callbackUrl.searchParams.get("state"), "state-123");
    const code = callbackUrl.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        redirect_uri: "https://chat.openai.com/aip/callback",
        code_verifier: verifier,
        code
      })
    });
    assert.equal(tokenResponse.status, 200);
    const tokenPayload = await tokenResponse.json();
    assert.equal(tokenPayload.token_type, "Bearer");
    assert.ok(tokenPayload.access_token);

    const unauthenticated = await fetch(`${url}/mcp`, {
      headers: { accept: "application/json, text/event-stream" }
    });
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate"), /oauth-protected-resource/);

    const unsupportedStream = await fetch(`${url}/mcp`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${tokenPayload.access_token}`
      }
    });
    assert.equal(unsupportedStream.status, 405);
    assert.equal(unsupportedStream.headers.get("allow"), "POST, DELETE, OPTIONS");

    const client = new Client({ name: "coach-loop-oauth-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${tokenPayload.access_token}`
        }
      }
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.map((tool) => tool.name).includes("get_planning_context"));
    } finally {
      await client.close();
    }
  } finally {
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Coach Loop OAuth rejects redirect URIs not registered to the client", async () => {
  const previousEnv = {
    COACH_LOOP_API_TOKEN: process.env.COACH_LOOP_API_TOKEN,
    COACH_LOOP_OAUTH_PASSWORD: process.env.COACH_LOOP_OAUTH_PASSWORD,
    COACH_LOOP_REQUIRE_MCP_OAUTH: process.env.COACH_LOOP_REQUIRE_MCP_OAUTH
  };
  process.env.COACH_LOOP_API_TOKEN = "test-api-token";
  process.env.COACH_LOOP_OAUTH_PASSWORD = "test-owner-password";
  process.env.COACH_LOOP_REQUIRE_MCP_OAUTH = "true";

  const { server, url } = await startHttpServer();

  try {
    const registration = await fetch(`${url}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "OAuth redirect test",
        redirect_uris: ["https://chat.openai.com/aip/callback"]
      })
    }).then((response) => response.json());

    const verifier = "oauth-redirect-test-verifier";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://attacker.example/callback",
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      scope: "coach:read coach:write",
      resource: `${url}/mcp`
    };

    const authorizePage = await fetch(`${url}/oauth/authorize?${new URLSearchParams(authorizeParams)}`);
    assert.equal(authorizePage.status, 400);
    assert.match(await authorizePage.text(), /redirect_uri is not registered/);
  } finally {
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Coach Loop MCP requires write scope for mutating tools", async () => {
  const previousEnv = {
    COACH_LOOP_API_TOKEN: process.env.COACH_LOOP_API_TOKEN,
    COACH_LOOP_OAUTH_PASSWORD: process.env.COACH_LOOP_OAUTH_PASSWORD,
    COACH_LOOP_REQUIRE_MCP_OAUTH: process.env.COACH_LOOP_REQUIRE_MCP_OAUTH
  };
  process.env.COACH_LOOP_API_TOKEN = "test-api-token";
  process.env.COACH_LOOP_OAUTH_PASSWORD = "test-owner-password";
  process.env.COACH_LOOP_REQUIRE_MCP_OAUTH = "true";

  const { server, url } = await startHttpServer();

  try {
    const registration = await fetch(`${url}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Read-only OAuth test",
        redirect_uris: ["https://chat.openai.com/aip/callback"]
      })
    }).then((response) => response.json());

    const verifier = "read-only-oauth-test-verifier";
    const authorizeParams = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: "https://chat.openai.com/aip/callback",
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
      state: "read-only-state",
      scope: "coach:read",
      resource: `${url}/mcp`
    };

    const authorizeResponse = await fetch(`${url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...authorizeParams,
        password: "test-owner-password"
      })
    });
    assert.equal(authorizeResponse.status, 302);
    const code = new URL(authorizeResponse.headers.get("location")).searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        redirect_uri: "https://chat.openai.com/aip/callback",
        code_verifier: verifier,
        code
      })
    });
    assert.equal(tokenResponse.status, 200);
    const tokenPayload = await tokenResponse.json();
    assert.equal(tokenPayload.scope, "coach:read");

    const client = new Client({ name: "coach-loop-read-only-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${tokenPayload.access_token}`
        }
      }
    });

    try {
      await client.connect(transport);
      const stateResult = await client.callTool({ name: "get_state", arguments: {} });
      assert.equal(stateResult.content[0].type, "text");
      await assert.rejects(
        () => client.callTool({ name: "update_goals", arguments: { goals: { primary: "Should not write" } } }),
        /Authorization|401|Unauthorized|MCP|error/i
      );
    } finally {
      await client.close();
    }
  } finally {
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await new Promise((resolve) => server.close(resolve));
  }
});
