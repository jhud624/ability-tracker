const { timingSafeEqual } = require("node:crypto");

function cleanSecret(value) {
  const text = String(value || "").trim();
  return text === '""' || text === "''" ? "" : text;
}

function secretsEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(expected);
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1";
}

function hostedMcpConfigurationError() {
  const hosted = process.env.VERCEL || process.env.NODE_ENV === "production";
  const mcpEnabled = process.env.COACH_LOOP_REQUIRE_MCP_OAUTH === "true" ||
    process.env.COACH_LOOP_MCP_AUTH === "oauth" || cleanSecret(process.env.COACH_LOOP_MCP_TOKEN);
  if (hosted && mcpEnabled && !cleanSecret(process.env.COACH_LOOP_API_TOKEN)) {
    return "Hosted MCP requires a configured internal API token";
  }
  return null;
}

function allowUnauthenticatedLocal(req) {
  if (process.env.COACH_LOOP_ALLOW_UNAUTHENTICATED_LOCAL !== "true" ||
      process.env.VERCEL || process.env.NODE_ENV === "production") return false;
  if (["COACH_LOOP_API_TOKEN", "COACH_LOOP_MCP_TOKEN", "COACH_LOOP_OAUTH_PASSWORD",
    "COACH_LOOP_OAUTH_SIGNING_SECRET"].some((key) => cleanSecret(process.env[key]))) return false;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress)) return false;
  if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]
    .some((name) => req.headers[name] !== undefined)) return false;
  try {
    const url = new URL(`http://${req.headers.host}`);
    return !url.username && !url.password && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

module.exports = { allowUnauthenticatedLocal, cleanSecret, hostedMcpConfigurationError, isLoopbackHost, secretsEqual };
