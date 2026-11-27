import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function privateDirectory(path) {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || realpathSync(directory) !== directory || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("BOT data requires a private, physical directory (0700).");
  }
  return directory;
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readRecord(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 4 * 1024 * 1024 || (info.mode & 0o022) ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("Invalid BOT record.");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A fully synced temporary inode is linked into place only once; a crash never exposes partial JSON.
export function putRecord(directory, name, record) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(name)) throw new Error("Invalid BOT record id.");
  const temp = join(directory, ".pending-" + randomUUID());
  const path = join(directory, name + ".json");
  const bytes = Buffer.from(JSON.stringify(record));
  if (bytes.length > 4 * 1024 * 1024) throw new Error("BOT record is too large.");
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, path); } catch (error) { if (error.code !== "EEXIST") throw error; }
    syncDirectory(directory);
    return readRecord(path);
  } finally { unlinkSync(temp); }
}

export function openIntentJournal(directory, { primaryDirectory, requireSeparateVolume = true } = {}) {
  // Operators mount and provision the independent volume before starting the real application.
  const root = realpathSync(directory);
  const mount = statSync(root);
  if (resolve(directory) !== root || !mount.isDirectory() || (mount.mode & 0o077) ||
      (process.getuid && mount.uid !== process.getuid())) throw new Error("Journal mount must be owned, private and canonical.");
  const device = mount.dev;
  if (requireSeparateVolume && device === statSync(primaryDirectory).dev) throw new Error("Real BOT journal needs a separate durable volume.");
  const marker = putRecord(root, "journal-identity", { id: randomUUID() });
  const assertAvailable = () => {
    if (statSync(root).dev !== device || readRecord(join(root, "journal-identity.json"))?.id !== marker.id) {
      throw new Error("Independent journal volume is unavailable.");
    }
  };
  const namespace = scope => join(root, digest(scope));
  function readNamespace(scope) {
    const path = namespace(scope);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) ||
          realpathSync(path) !== path) throw new Error("Intent namespace must be owned, private and canonical.");
      return path;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  return {
    get({ scope, key }) {
      assertAvailable();
      const dir = readNamespace(scope);
      return dir ? readRecord(join(dir, digest(key) + ".json")) : null;
    },
    append(entry) {
      assertAvailable();
      const dir = privateDirectory(namespace(entry.scope));
      syncDirectory(root);
      const stored = putRecord(dir, digest(entry.key), entry);
      if (stored?.key !== entry.key || stored.digest !== entry.digest) throw new Error("Intent journal key conflict.");
      return { key: stored.key, digest: stored.digest };
    },
    list({ scope }) {
      assertAvailable();
      const dir = readNamespace(scope);
      if (!dir) return [];
      return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readRecord(join(dir, name)))
        .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    },
  };
}
