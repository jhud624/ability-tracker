const fs = require("node:fs");
const path = require("node:path");
const { Redis } = require("@upstash/redis");

const ROOT = __dirname;

let redisClient = null;
let fileWriteQueue = Promise.resolve();

function dataDir() {
  return process.env.COACH_LOOP_DATA_DIR || (process.env.VERCEL ? "/tmp/coach-loop-data" : path.join(ROOT, "data"));
}

function storePath() {
  return path.join(dataDir(), "store.json");
}

function storeKey() {
  return process.env.COACH_LOOP_STORE_KEY || "coach-loop:store";
}

function lockKey() {
  return `${storeKey()}:lock`;
}

function backupListKey() {
  return `${storeKey()}:backups`;
}

function backupLimit() {
  const value = Number(process.env.COACH_LOOP_BACKUP_LIMIT || 120);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 500) : 120;
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

function redis() {
  const config = redisConfig();
  if (!config) return null;
  if (!redisClient) redisClient = new Redis(config);
  return redisClient;
}

function storageMode() {
  return redisConfig() ? "redis" : "file";
}

async function readStoreData(createDefaultState) {
  const client = redis();
  if (client) {
    const existing = await client.get(storeKey());
    if (existing) return existing;
    const initial = createDefaultState();
    await client.set(storeKey(), initial);
    return initial;
  }

  fs.mkdirSync(dataDir(), { recursive: true });
  if (!fs.existsSync(storePath())) {
    const initial = createDefaultState();
    fs.writeFileSync(storePath(), `${JSON.stringify(initial, null, 2)}\n`);
    return initial;
  }
  return JSON.parse(fs.readFileSync(storePath(), "utf8"));
}

async function writeStoreData(store) {
  const client = redis();
  if (client) {
    await client.set(storeKey(), store);
    return store;
  }

  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

function backupMetadata(envelope) {
  return {
    backup_id: envelope.backup_id,
    created_at: envelope.created_at,
    reason: envelope.reason,
    revision: envelope.store?.revision || 0,
    updated_at: envelope.store?.updated_at || null
  };
}

function createBackupEnvelope(store, reason = "manual") {
  const createdAt = new Date().toISOString();
  const revision = Number(store?.revision || 0);
  return {
    backup_id: `backup-${createdAt.replace(/[:.]/g, "-")}-rev-${revision}`,
    created_at: createdAt,
    reason,
    store
  };
}

function backupDir() {
  return path.join(dataDir(), "backups");
}

async function createStoreBackup(store, reason = "manual") {
  const envelope = createBackupEnvelope(store, reason);
  const client = redis();
  if (client) {
    await client.lpush(backupListKey(), envelope);
    await client.ltrim(backupListKey(), 0, backupLimit() - 1);
    return backupMetadata(envelope);
  }

  fs.mkdirSync(backupDir(), { recursive: true });
  fs.writeFileSync(path.join(backupDir(), `${envelope.backup_id}.json`), `${JSON.stringify(envelope, null, 2)}\n`);
  const files = fs.readdirSync(backupDir())
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
  files.slice(backupLimit()).forEach((file) => fs.rmSync(path.join(backupDir(), file), { force: true }));
  return backupMetadata(envelope);
}

async function listStoreBackups(limit = 30) {
  const max = Math.max(1, Math.min(Number(limit) || 30, backupLimit()));
  const client = redis();
  if (client) {
    const envelopes = await client.lrange(backupListKey(), 0, max - 1);
    return envelopes.map(backupMetadata);
  }

  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir())
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, max)
    .map((file) => backupMetadata(JSON.parse(fs.readFileSync(path.join(backupDir(), file), "utf8"))));
}

async function readStoreBackup(backupId) {
  const client = redis();
  if (client) {
    const envelopes = await client.lrange(backupListKey(), 0, backupLimit() - 1);
    return envelopes.find((envelope) => envelope.backup_id === backupId) || null;
  }

  const file = path.join(backupDir(), `${backupId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function restoreStoreBackup(backupId) {
  const envelope = await readStoreBackup(backupId);
  if (!envelope?.store) throw new Error("Backup not found");
  const restored = {
    ...envelope.store,
    restored_at: new Date().toISOString(),
    restored_from_backup_id: backupId
  };
  await writeStoreData(restored);
  return restored;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRedisLock(client, fn) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const acquired = await client.set(lockKey(), token, { nx: true, ex: 5 });
    if (acquired === "OK" || acquired === true) {
      try {
        return await fn();
      } finally {
        const current = await client.get(lockKey());
        if (current === token) await client.del(lockKey());
      }
    }
    await sleep(40 + attempt * 10);
  }
  throw new Error("Coach Loop store is busy. Retry in a moment.");
}

async function updateStoreData(createDefaultState, updater) {
  const client = redis();
  if (client) {
    return withRedisLock(client, async () => {
      const existing = await client.get(storeKey());
      const current = existing || createDefaultState();
      const next = await updater(current);
      await client.set(storeKey(), next);
      await createStoreBackup(next, "auto-write");
      return next;
    });
  }

  const run = async () => {
    const current = await readStoreData(createDefaultState);
    const next = await updater(current);
    await writeStoreData(next);
    await createStoreBackup(next, "auto-write");
    return next;
  };
  fileWriteQueue = fileWriteQueue.then(run, run);
  return fileWriteQueue;
}

module.exports = {
  createStoreBackup,
  listStoreBackups,
  restoreStoreBackup,
  storageMode,
  readStoreData,
  updateStoreData,
  writeStoreData
};
