import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatSession } from "@/lib/chatTypes";

const DEFAULT_STORE_DIR = path.join(process.cwd(), "..", "chats");

function storeDir() {
  return process.env.CHAT_STORE_DIR
    ? path.resolve(process.env.CHAT_STORE_DIR)
    : DEFAULT_STORE_DIR;
}

function isValidSessionId(sessionId: string) {
  return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

function safeSessionId(sessionId: string) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      "Invalid session id. Allowed characters: letters, numbers, _ and -"
    );
  }
  return sessionId;
}

function sessionPath(sessionId: string) {
  return path.join(storeDir(), `${safeSessionId(sessionId)}.json`);
}

export function newSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

export async function ensureStoreDir() {
  await fs.mkdir(storeDir(), { recursive: true });
}

export function createNewSession({
  model,
  systemPrompt,
}: {
  model: string;
  systemPrompt: string;
}): ChatSession {
  const id = newSessionId();
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    model,
    systemPrompt,
    messages: [{ role: "system", content: systemPrompt, createdAt: now }],
  };
}

export async function saveSession(session: ChatSession) {
  await ensureStoreDir();
  session.updatedAt = new Date().toISOString();
  await fs.writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), {
    encoding: "utf8",
  });
}

export async function loadSession(sessionId: string): Promise<ChatSession> {
  const raw = await fs.readFile(sessionPath(sessionId), "utf8");
  const session = JSON.parse(raw) as ChatSession;
  if (!session?.id || !Array.isArray(session?.messages)) {
    throw new Error("Invalid session JSON");
  }
  return session;
}

export async function listSessions(): Promise<
  Array<Pick<ChatSession, "id" | "updatedAt" | "title">>
> {
  try {
    const entries = await fs.readdir(storeDir(), { withFileTypes: true });
    const ids = entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/i, ""));

    const sessions: Array<Pick<ChatSession, "id" | "updatedAt" | "title">> = [];
    for (const id of ids) {
      try {
        const s = await loadSession(id);
        sessions.push({ id: s.id, updatedAt: s.updatedAt, title: s.title });
      } catch {
        // ignore invalid files
      }
    }

    sessions.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    return sessions;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

export async function deleteSession(sessionId: string) {
  try {
    await fs.unlink(sessionPath(sessionId));
    return { ok: true, deleted: true };
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return { ok: true, deleted: false };
    throw err;
  }
}

export async function clearSessions() {
  try {
    const entries = await fs.readdir(storeDir(), { withFileTypes: true });
    let deletedCount = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      try {
        await fs.unlink(path.join(storeDir(), entry.name));
        deletedCount++;
      } catch {}
    }
    return { ok: true, deletedCount };
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return { ok: true, deletedCount: 0 };
    throw err;
  }
}
