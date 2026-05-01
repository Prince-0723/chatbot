import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHATS_DIR = process.env.CHATS_DIR?.trim()
  ? path.resolve(process.env.CHATS_DIR.trim())
  : path.join(__dirname, "chats");

async function ensureChatsDir() {
  await fs.mkdir(CHATS_DIR, { recursive: true });
}

function isValidSessionId(sessionId) {
  return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

function safeSessionId(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      "Invalid session id. Allowed characters: letters, numbers, _ and -"
    );
  }
  return sessionId;
}

function sessionPath(sessionId) {
  return path.join(CHATS_DIR, `${safeSessionId(sessionId)}.json`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Put it in .env (example: ${name}=...) and re-run.`
    );
  }
  return value;
}

function normalizeMongoUri(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";

  // Common copy/paste mistake: MONGODB_URI=MONGO_URI=mongodb+srv://...
  const srvIdx = s.indexOf("mongodb+srv://");
  if (srvIdx >= 0) return s.slice(srvIdx);

  const stdIdx = s.indexOf("mongodb://");
  if (stdIdx >= 0) return s.slice(stdIdx);

  return s;
}

export async function createSessionStore() {
  const mongoUri = normalizeMongoUri(process.env.MONGODB_URI);
  if (!mongoUri) {
    return createFileStore();
  }

  const required = /^(1|true)$/i.test(process.env.MONGODB_REQUIRED?.trim() || "");
  const looksValid =
    mongoUri.startsWith("mongodb://") || mongoUri.startsWith("mongodb+srv://");

  if (!looksValid) {
    const msg =
      [
        'Invalid MONGODB_URI value (must contain a URI that starts with "mongodb://" or "mongodb+srv://").',
        'If you pasted something like "MONGO_URI=...": keep only the URI part.',
      ].join(" ");
    if (required) throw new Error(msg);
    console.warn(`[mongo] ${msg} Falling back to file store.`);
    return createFileStore();
  }

  try {
    return await createMongoStore({ uri: mongoUri });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (required) {
      throw new Error(
        [
          "MongoDB connection failed.",
          "Check MONGODB_URI and your MongoDB Atlas Network Access IP allowlist.",
          "Original error: " + msg,
        ].join(" ")
      );
    }
    console.warn(
      `[mongo] MongoDB connection failed (${msg}). Falling back to file store.`
    );
    return createFileStore();
  }
}

function createFileStore() {
  return {
    kind: "file",
    async save(session) {
      await ensureChatsDir();
      await fs.writeFile(
        sessionPath(session.id),
        JSON.stringify(session, null, 2),
        "utf8"
      );
    },
    async load(sessionId) {
      const file = sessionPath(sessionId);
      const raw = await fs.readFile(file, "utf8");
      const session = JSON.parse(raw);
      if (!session?.id || !Array.isArray(session?.messages)) {
        throw new Error(`Invalid session file: ${file}`);
      }
      return session;
    },
    async list() {
      try {
        const entries = await fs.readdir(CHATS_DIR, { withFileTypes: true });
        const ids = entries
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name.replace(/\.json$/i, ""));

        const sessions = [];
        for (const id of ids) {
          try {
            const s = await this.load(id);
            sessions.push({
              id: s.id,
              updatedAt: s.updatedAt || s.createdAt || "",
              title: s.title,
            });
          } catch {
            // ignore invalid files
          }
        }

        sessions.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
        return sessions;
      } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
      }
    },
    async delete(sessionId) {
      const file = sessionPath(sessionId);
      try {
        await fs.unlink(file);
        return { ok: true, deleted: true };
      } catch (err) {
        if (err?.code === "ENOENT") return { ok: true, deleted: false };
        throw err;
      }
    },
    async clear() {
      try {
        const entries = await fs.readdir(CHATS_DIR, { withFileTypes: true });
        let deletedCount = 0;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".json")) continue;
          try {
            await fs.unlink(path.join(CHATS_DIR, entry.name));
            deletedCount++;
          } catch {}
        }
        return { ok: true, deletedCount };
      } catch (err) {
        if (err?.code === "ENOENT") return { ok: true, deletedCount: 0 };
        throw err;
      }
    },
    async close() {},
  };
}

async function createMongoStore({ uri }) {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();

  const dbName = process.env.MONGODB_DB?.trim() || "app";
  const collectionName = process.env.MONGODB_COLLECTION?.trim() || "chats";
  const col = client.db(dbName).collection(collectionName);

  await col.createIndex({ updatedAt: -1 });

  return {
    kind: "mongodb",
    async save(session) {
      await col.replaceOne({ _id: session.id }, { ...session, _id: session.id }, { upsert: true });
    },
    async load(sessionId) {
      const session = await col.findOne({ _id: sessionId });
      if (!session) throw new Error(`Chat session not found: ${sessionId}`);
      const { _id, ...rest } = session;
      if (!rest?.id || !Array.isArray(rest?.messages)) {
        throw new Error(`Invalid session in MongoDB for id: ${sessionId}`);
      }
      return rest;
    },
    async list() {
      const docs = await col
        .find(
          {},
          { projection: { _id: 1, updatedAt: 1, title: 1 }, sort: { updatedAt: -1 } }
        )
        .limit(200)
        .toArray();
      return docs.map((d) => ({
        id: d._id,
        updatedAt: d.updatedAt || "",
        title: d.title,
      }));
    },
    async delete(sessionId) {
      const res = await col.deleteOne({ _id: sessionId });
      return { ok: true, deleted: res.deletedCount > 0 };
    },
    async clear() {
      const res = await col.deleteMany({});
      return { ok: true, deletedCount: res.deletedCount ?? 0 };
    },
    async close() {
      await client.close();
    },
  };
}
