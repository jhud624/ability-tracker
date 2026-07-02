const { authorizeMcpRequest } = require("../oauth");

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function originFor(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function cleanSecret(value) {
  const text = String(value || "").trim();
  if (!text || text === "\"\"" || text === "''") return "";
  return text;
}

const MCP_WRITE_TOOLS = new Set([
  "upsert_gear",
  "remove_gear",
  "import_weekly_plan",
  "update_day_plan",
  "link_actual_to_activity",
  "update_goals",
  "patch_goals",
  "update_run_plan",
  "update_coach_notes",
  "mark_activity",
  "save_activity_feedback",
  "save_exercise_log",
  "import_health_actuals"
]);

function mcpRequiredScopes(body) {
  const messages = Array.isArray(body) ? body : [body].filter(Boolean);
  const hasWriteToolCall = messages.some((message) => (
    message?.method === "tools/call" && MCP_WRITE_TOOLS.has(message.params?.name)
  ));
  return hasWriteToolCall ? ["coach:read", "coach:write"] : ["coach:read"];
}

async function readRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body.trim() ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString("utf8");
      return text.trim() ? JSON.parse(text) : {};
    }
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handleMcp(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type, authorization, mcp-session-id"
    });
    res.end();
    return;
  }

  let parsedBody = req.body;
  if (req.method === "POST") {
    try {
      parsedBody = await readRequestBody(req);
    } catch {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null
      });
      return;
    }
  }

  if (!authorizeMcpRequest(req, res, mcpRequiredScopes(parsedBody))) return;

  if (req.method === "GET") {
    sendJson(
      res,
      405,
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Standalone MCP SSE streams are not supported by this hosted endpoint. Use POST."
        },
        id: null
      },
      { allow: "POST, DELETE, OPTIONS" }
    );
    return;
  }

  try {
    const [{ StreamableHTTPServerTransport }, { createCoachLoopMcpServer }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("../mcp/coach-loop-tools.mjs")
    ]);
    const server = createCoachLoopMcpServer({
      apiUrl: process.env.COACH_LOOP_API_URL || originFor(req),
      apiToken: cleanSecret(process.env.COACH_LOOP_API_TOKEN)
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
};
