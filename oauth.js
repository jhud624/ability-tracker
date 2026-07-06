const crypto = require("node:crypto");

const BODY_LIMIT_BYTES = 128 * 1024;
const SCOPES = ["coach:read", "coach:write"];
const DEFAULT_LONG_LIVED_TTL_SECONDS = 60 * 60 * 24 * 365;
const authFailures = new Map();

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlJson(value) {
  return base64Url(JSON.stringify(value));
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function oauthSecret() {
  const secret = cleanSecret(process.env.COACH_LOOP_OAUTH_SIGNING_SECRET) || cleanSecret(process.env.COACH_LOOP_API_TOKEN);
  if (secret) return secret;
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("COACH_LOOP_OAUTH_SIGNING_SECRET or COACH_LOOP_API_TOKEN is required in production");
  }
  return "coach-loop-dev-secret";
}

function ownerPassword() {
  return cleanSecret(process.env.COACH_LOOP_OAUTH_PASSWORD) || cleanSecret(process.env.COACH_LOOP_API_TOKEN) || "";
}

function cleanSecret(value) {
  const text = String(value || "").trim();
  if (!text || text === "\"\"" || text === "''") return "";
  return text;
}

function positiveTtl(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value) {
  return crypto.createHmac("sha256", oauthSecret()).update(value).digest("base64url");
}

function signedToken(payload) {
  const encoded = base64UrlJson(payload);
  return `${encoded}.${sign(encoded)}`;
}

function verifySignedToken(token, expectedType) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    throw new Error("Invalid token");
  }
  const [encoded, signature] = token.split(".");
  const expected = sign(encoded);
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
    throw new Error("Invalid token signature");
  }
  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    throw new Error("Invalid token signature");
  }
  const payload = JSON.parse(fromBase64Url(encoded));
  if (expectedType && payload.type !== expectedType) throw new Error("Invalid token type");
  if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
}

function originFor(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("127.0.0.1") ? "http" : "https");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function clientAddress(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.headers.host || "unknown")
    .split(",")[0]
    .trim();
}

function authRateLimit(req, bucket, { limit = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const key = `${bucket}:${clientAddress(req)}`;
  const now = Date.now();
  const entry = authFailures.get(key);
  if (!entry || entry.reset_at <= now) {
    return { limited: false, key, remaining: limit };
  }
  if (entry.count >= limit) {
    return {
      limited: true,
      key,
      retry_after_seconds: Math.max(1, Math.ceil((entry.reset_at - now) / 1000))
    };
  }
  return { limited: false, key, remaining: limit - entry.count };
}

function recordAuthFailure(req, bucket, { windowMs = 15 * 60 * 1000 } = {}) {
  const key = `${bucket}:${clientAddress(req)}`;
  const now = Date.now();
  const entry = authFailures.get(key);
  if (!entry || entry.reset_at <= now) {
    authFailures.set(key, { count: 1, reset_at: now + windowMs });
    return;
  }
  entry.count += 1;
  authFailures.set(key, entry);
}

function clearAuthFailures(req, bucket) {
  authFailures.delete(`${bucket}:${clientAddress(req)}`);
}

function oauthConfig(req) {
  const origin = originFor(req).replace(/\/$/, "");
  return {
    origin,
    issuer: process.env.COACH_LOOP_OAUTH_ISSUER || origin,
    resource: process.env.COACH_LOOP_OAUTH_RESOURCE || `${origin}/mcp`,
    scopes: SCOPES
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store"
  });
  res.end();
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isSafeRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readParams(req) {
  const body = await readBody(req);
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const contentType = String(req.headers["content-type"] || "");
  const text = String(body || "");
  if (contentType.includes("application/json")) {
    return text.trim() ? JSON.parse(text) : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function parseScopes(scope) {
  return String(scope || SCOPES.join(" "))
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scopeString(scope) {
  const requested = parseScopes(scope);
  const allowed = requested.filter((item) => SCOPES.includes(item));
  return (allowed.length ? allowed : SCOPES).join(" ");
}

function protectedResourceMetadata(req) {
  const config = oauthConfig(req);
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Coach Loop"
  };
}

function authorizationServerMetadata(req) {
  const config = oauthConfig(req);
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.origin}/oauth/authorize`,
    token_endpoint: `${config.origin}/oauth/token`,
    registration_endpoint: `${config.origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: config.scopes
  };
}

function registeredClientFromId(clientId) {
  const prefix = "coach_loop_";
  if (!String(clientId || "").startsWith(prefix)) throw new Error("client_id is invalid");
  const client = verifySignedToken(String(clientId).slice(prefix.length), "client");
  return {
    ...client,
    redirect_uris: Array.isArray(client.redirect_uris) ? client.redirect_uris : []
  };
}

function redirectUriAllowedForClient(clientId, redirectUri) {
  const client = registeredClientFromId(clientId);
  return client.redirect_uris.includes(redirectUri);
}

function sendProtectedResourceMetadata(req, res) {
  sendJson(res, 200, protectedResourceMetadata(req));
}

function sendAuthorizationServerMetadata(req, res) {
  sendJson(res, 200, authorizationServerMetadata(req));
}

async function handleClientRegistration(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }
  const body = await readParams(req);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(isSafeRedirectUri) : [];
  if (!redirectUris.length) {
    sendJson(res, 400, { error: "invalid_redirect_uris" });
    return;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientId = `coach_loop_${signedToken({
    type: "client",
    client_name: String(body.client_name || "ChatGPT"),
    redirect_uris: redirectUris,
    iat: issuedAt
  })}`;
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: body.client_name || "ChatGPT",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: SCOPES.join(" ")
  });
}

function authorizeErrorRedirect(redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (description) url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function createAuthorizationCode(params, req) {
  const config = oauthConfig(req);
  const now = Math.floor(Date.now() / 1000);
  return signedToken({
    type: "authorization_code",
    iss: config.issuer,
    sub: "owner",
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    resource: params.resource || config.resource,
    scope: scopeString(params.scope),
    iat: now,
    exp: now + 5 * 60
  });
}

function validateAuthorizeParams(params) {
  if (params.response_type !== "code") throw new Error("response_type must be code");
  if (!params.client_id) throw new Error("client_id is required");
  if (!params.redirect_uri || !isSafeRedirectUri(params.redirect_uri)) throw new Error("redirect_uri is invalid");
  if (!redirectUriAllowedForClient(params.client_id, params.redirect_uri)) throw new Error("redirect_uri is not registered for this client");
  if (!params.code_challenge) throw new Error("code_challenge is required");
  if (params.code_challenge_method !== "S256") throw new Error("code_challenge_method must be S256");
}

function renderAuthorizeForm(params, error = "") {
  const hiddenInputs = Object.entries(params)
    .filter(([key]) => key !== "password")
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Coach Loop</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f4ed; color: #16211f; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #d8d4ca; border-radius: 8px; background: #fffdf8; padding: 24px; box-shadow: 0 12px 36px rgba(22, 33, 31, 0.08); }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: #53625f; line-height: 1.45; }
    label { display: grid; gap: 8px; font-weight: 700; font-size: 13px; color: #53625f; text-transform: uppercase; }
    input[type="password"] { height: 42px; border: 1px solid #bfc7c2; border-radius: 6px; padding: 0 12px; font-size: 16px; }
    button { margin-top: 16px; width: 100%; height: 44px; border: 0; border-radius: 6px; background: #16211f; color: white; font-weight: 800; font-size: 15px; cursor: pointer; }
    .error { margin-bottom: 12px; color: #b42318; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Coach Loop</h1>
    <p>Allow ChatGPT to read and update your workout goals, gear, plan, check-ins, and actuals.</p>
    ${error ? `<div class="error">${htmlEscape(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hiddenInputs}
      <label>
        Owner password
        <input name="password" type="password" autocomplete="current-password" required autofocus>
      </label>
      <button type="submit">Authorize ChatGPT</button>
    </form>
  </main>
</body>
</html>`;
}

async function handleAuthorize(req, res) {
  const url = new URL(req.url, originFor(req));
  const params = req.method === "GET" ? Object.fromEntries(url.searchParams) : await readParams(req);
  try {
    validateAuthorizeParams(params);
  } catch (error) {
    sendHtml(res, 400, renderAuthorizeForm(params, error.message));
    return;
  }

  if (req.method === "GET") {
    sendHtml(res, 200, renderAuthorizeForm(params));
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
    return;
  }

  const limit = authRateLimit(req, "oauth_authorize");
  if (limit.limited) {
    sendHtml(res, 429, renderAuthorizeForm(params, "Too many failed attempts. Try again in a few minutes."), {
      "retry-after": String(limit.retry_after_seconds)
    });
    return;
  }

  if (!verifyOwnerPassword(params.password)) {
    recordAuthFailure(req, "oauth_authorize");
    sendHtml(res, 401, renderAuthorizeForm(params, "That password did not match."));
    return;
  }
  clearAuthFailures(req, "oauth_authorize");

  const code = createAuthorizationCode(params, req);
  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (params.state) redirectUrl.searchParams.set("state", params.state);
  redirect(res, redirectUrl.toString());
}

async function handleToken(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }
  try {
    const params = await readParams(req);
    if (params.grant_type !== "authorization_code") throw new Error("unsupported_grant_type");
    if (!params.code || !params.code_verifier || !params.redirect_uri || !params.client_id) {
      throw new Error("invalid_request");
    }

    const code = verifySignedToken(params.code, "authorization_code");
    if (code.client_id !== params.client_id) throw new Error("invalid_grant");
    if (code.redirect_uri !== params.redirect_uri) throw new Error("invalid_grant");
    if (!redirectUriAllowedForClient(params.client_id, params.redirect_uri)) throw new Error("invalid_grant");
    if (code.code_challenge_method !== "S256") throw new Error("invalid_grant");
    if (sha256Base64Url(params.code_verifier) !== code.code_challenge) throw new Error("invalid_grant");

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = positiveTtl(process.env.COACH_LOOP_OAUTH_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_LONG_LIVED_TTL_SECONDS);
    const accessToken = signedToken({
      type: "access_token",
      iss: code.iss,
      sub: code.sub,
      aud: code.resource,
      scope: code.scope,
      iat: now,
      exp: now + expiresIn
    });

    sendJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: code.scope
    });
  } catch (error) {
    sendJson(res, 400, {
      error: ["unsupported_grant_type", "invalid_request", "invalid_grant"].includes(error.message) ? error.message : "invalid_grant"
    });
  }
}

function verifyAccessToken(req, requiredScopes = []) {
  const token = bearerToken(req);
  const payload = verifySignedToken(token, "access_token");
  const config = oauthConfig(req);
  if (payload.aud && payload.aud !== config.resource && payload.aud !== config.origin) throw new Error("Invalid audience");
  const scopes = parseScopes(payload.scope);
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error("Insufficient scope");
  return payload;
}

function createOwnerSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = positiveTtl(process.env.COACH_LOOP_OWNER_SESSION_TTL_SECONDS, DEFAULT_LONG_LIVED_TTL_SECONDS);
  return signedToken({
    type: "owner_session",
    sub: "owner",
    iat: now,
    exp: now + expiresIn
  });
}

function ownerSessionTtlSeconds() {
  return positiveTtl(process.env.COACH_LOOP_OWNER_SESSION_TTL_SECONDS, DEFAULT_LONG_LIVED_TTL_SECONDS);
}

function verifyOwnerPassword(password) {
  const expectedPassword = ownerPassword();
  return Boolean(expectedPassword) && safeStringEqual(password, expectedPassword);
}

function verifyOwnerSessionToken(token) {
  return verifySignedToken(token, "owner_session");
}

function mcpOAuthRequired() {
  return process.env.COACH_LOOP_REQUIRE_MCP_OAUTH === "true" || process.env.COACH_LOOP_MCP_AUTH === "oauth";
}

function sendMcpAuthChallenge(req, res, message = "Authorization required") {
  const config = oauthConfig(req);
  sendJson(
    res,
    401,
    {
      jsonrpc: "2.0",
      error: { code: -32001, message },
      id: null
    },
    {
      "www-authenticate": `Bearer realm="Coach Loop", resource_metadata="${config.origin}/.well-known/oauth-protected-resource", scope="${SCOPES.join(" ")}"`
    }
  );
}

function authorizeMcpRequest(req, res, requiredScopes = ["coach:read"]) {
  const staticMcpToken = process.env.COACH_LOOP_MCP_TOKEN;
  if (staticMcpToken && bearerToken(req) === staticMcpToken) return true;
  if (!mcpOAuthRequired() && !staticMcpToken) return true;

  if (mcpOAuthRequired()) {
    try {
      verifyAccessToken(req, requiredScopes);
      return true;
    } catch {
      sendMcpAuthChallenge(req, res);
      return false;
    }
  }

  sendMcpAuthChallenge(req, res, "Missing or invalid Coach Loop MCP token");
  return false;
}

module.exports = {
  SCOPES,
  authorizationServerMetadata,
  authRateLimit,
  authorizeMcpRequest,
  clearAuthFailures,
  createOwnerSessionToken,
  handleAuthorize,
  handleClientRegistration,
  handleToken,
  mcpOAuthRequired,
  ownerSessionTtlSeconds,
  protectedResourceMetadata,
  recordAuthFailure,
  sendAuthorizationServerMetadata,
  sendMcpAuthChallenge,
  sendProtectedResourceMetadata,
  verifyAccessToken,
  verifyOwnerPassword,
  verifyOwnerSessionToken
};
