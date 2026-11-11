const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;
const MCP_MAX_TOOL_INPUT_ELEMENTS = 10_000;
const MCP_MAX_BATCH_MESSAGES = 100;
const MCP_MAX_JSON_DEPTH = 64;
const MCP_MAX_JSON_MEMBERS = 100_000;

class McpInputError extends Error {
  constructor(message, statusCode = 413) {
    super(message);
    this.statusCode = statusCode;
  }
}

function bodyTooLarge() {
  return new McpInputError(`MCP request body exceeds ${MCP_MAX_BODY_BYTES} bytes`);
}

// Measure canonical JSON incrementally: never stringify an entire unbounded
// pre-parsed body, and reject non-JSON object graphs before invoking user hooks.
function assertParsedBodyLimits(body) {
  const stack = [{ value: body, depth: 1 }];
  const seen = new WeakSet();
  let bytes = 0;
  let members = 0;
  function addBytes(amount) {
    bytes += amount;
    if (bytes > MCP_MAX_BODY_BYTES) throw bodyTooLarge();
  }
  function stringBytes(value) {
    if (Buffer.byteLength(value) > MCP_MAX_BODY_BYTES) throw bodyTooLarge();
    return Buffer.byteLength(JSON.stringify(value));
  }
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (depth > MCP_MAX_JSON_DEPTH) {
      throw new McpInputError(`MCP JSON nesting exceeds ${MCP_MAX_JSON_DEPTH} levels`, 400);
    }
    if (value === null) addBytes(4);
    else if (typeof value === "string") addBytes(stringBytes(value));
    else if (typeof value === "boolean") addBytes(value ? 4 : 5);
    else if (typeof value === "number" && Number.isFinite(value)) addBytes(Buffer.byteLength(JSON.stringify(value)));
    else if (typeof value === "object") {
      if (seen.has(value)) throw new McpInputError("MCP request body must be a JSON tree", 400);
      seen.add(value);
      const array = Array.isArray(value);
      if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new McpInputError("MCP request body must contain plain JSON values", 400);
      }
      const keys = Object.keys(value);
      members += keys.length;
      if (members > MCP_MAX_JSON_MEMBERS) {
        throw new McpInputError(`MCP request exceeds ${MCP_MAX_JSON_MEMBERS} JSON members`);
      }
      if (array && keys.length !== value.length) throw new McpInputError("MCP arrays must be dense JSON arrays", 400);
      addBytes(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new McpInputError("MCP request body must not contain accessors", 400);
        if (!array) addBytes(stringBytes(key) + 1);
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
    } else throw new McpInputError("MCP request body must contain JSON values", 400);
  }
}

function parseRawBody(body) {
  if (Buffer.byteLength(body) > MCP_MAX_BODY_BYTES) throw bodyTooLarge();
  const text = body.toString("utf8");
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new McpInputError("MCP request body must be valid JSON", 400);
  }
}

function readStream(req) {
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MCP_MAX_BODY_BYTES) {
        settled = true;
        req.pause();
        reject(bodyTooLarge());
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new McpInputError("Unable to read MCP request body", 400));
      }
    });
    req.on("aborted", () => {
      if (!settled) {
        settled = true;
        reject(new McpInputError("MCP request body was aborted", 400));
      }
    });
  });
}

async function readMcpBody(req) {
  const length = req.headers["content-length"];
  if (length !== undefined && /^\d+$/.test(String(length)) && Number(length) > MCP_MAX_BODY_BYTES) throw bodyTooLarge();
  let body;
  if (req.body !== undefined) {
    body = typeof req.body === "string" || Buffer.isBuffer(req.body) ? parseRawBody(req.body) : req.body;
  } else body = parseRawBody(await readStream(req));
  if (Array.isArray(body) && body.length > MCP_MAX_BATCH_MESSAGES) {
    throw new McpInputError(`MCP batch exceeds ${MCP_MAX_BATCH_MESSAGES} messages`, 400);
  }
  assertParsedBodyLimits(body);
  return body;
}

module.exports = {
  MCP_MAX_BODY_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS, MCP_MAX_BATCH_MESSAGES,
  MCP_MAX_JSON_DEPTH, MCP_MAX_JSON_MEMBERS, McpInputError, readMcpBody
};
