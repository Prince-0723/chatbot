process.stdout.setEncoding("utf8");

import Groq from "groq-sdk";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import { connectMongo } from "./db.js";
import { Chat } from "./models/Chat.js";
import { User } from "./models/User.js";
import { assertEnv, authenticate, maybeAuthenticate, signJwt } from "./auth.js";
import ragRouter from "./rag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

const groq = new Groq({ apiKey: assertEnv("GROQ_API_KEY") });
const googleClient = new OAuth2Client(assertEnv("GOOGLE_CLIENT_ID"));

const DEFAULT_MODEL = "llama-3.1-8b-instant";

// ── Improved system prompt: natural, warm, not robotic ──────────────────────
const DEFAULT_SYSTEM = `You are a knowledgeable, friendly AI assistant. Think of yourself as a thoughtful expert colleague — someone who gives clear, useful answers without being stiff or preachy.

How to communicate:
- Use emojis when they fit the context (friendly, celebratory, encouraging) and add clarity or warmth.
- For technical/serious topics, use 0–1 emojis; for casual chat, use 1–2.
- Never use emojis in code blocks, logs, command output, or error messages.
- Be natural and conversational. Write like a real person, not a manual.
- Match the user's energy: casual chat gets a lighter tone; technical or serious topics get focused, precise answers.
- Be concise. Don't pad responses. If something can be said in two sentences, say it in two sentences.
- When you use structure (headers, bullets, code blocks), use it because it genuinely helps — not by default.
- Show personality through word choice and clarity, not through filler phrases like "Great question!" or "Certainly!".
- If you're uncertain, say so briefly and helpfully rather than hedging every sentence.
- When it's appropriate, think through a problem step by step — but skip the theatrics.

Your goal: give the user exactly what they need, in a way that feels human and respectful of their time.`.trim();

function toSession(doc) {
  return {
    id: doc._id.toString(),
    createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    model: doc.model,
    systemPrompt: doc.systemPrompt,
    title: doc.title || "",
    messages: (doc.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt?.toISOString?.() ?? undefined,
      // ── Persist attachment metadata (including cloudinaryUrl) ──────────────
      attachments: m.attachments?.length > 0
        ? m.attachments.map((a) => ({
            fileId: a.fileId,
            filename: a.filename,
            mimetype: a.mimetype,
            size: a.size,
            cloudinaryUrl: a.cloudinaryUrl || "",
          }))
        : undefined,
      // ── Persist RAG source names shown below assistant messages ────────────
      ragSources: m.ragSources?.length > 0 ? m.ragSources : undefined,
    })),
  };
}

function titleFromUserMessage(message) {
  const trimmed = (message || "").trim();
  if (!trimmed) return "";
  return trimmed.length > 60 ? trimmed.slice(0, 57).trimEnd() + "..." : trimmed;
}

async function startServer() {
  await connectMongo();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const defaultOrigin = "http://localhost:3000";
  const origin = process.env.CORS_ORIGIN?.trim() || defaultOrigin;
  app.use(
    cors({
      origin: origin === "*" ? "*" : origin,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      exposedHeaders: ["x-session-id", "x-rag-sources"],
      maxAge: 86400,
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, message: "Backend running", time: new Date().toISOString() });
  });

  app.use("/rag", ragRouter);

  // ── Google OAuth ─────────────────────────────────────────────────────────
  app.post("/auth/google", async (req, res) => {
    const credential = (req.body?.credential ?? "").trim();
    if (!credential) {
      res.status(400).json({ error: "Missing credential" });
      return;
    }
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: assertEnv("GOOGLE_CLIENT_ID"),
      });
      const payload = ticket.getPayload();
      const email = payload?.email || "";
      if (!email) { res.status(400).json({ error: "Google token missing email" }); return; }

      const user = await User.findOneAndUpdate(
        { email },
        { $set: { email, name: payload?.name || "", picture: payload?.picture || "", googleSub: payload?.sub || "" } },
        { new: true, upsert: true }
      );

      const token = signJwt(user);
      res.json({ token, user: { id: user._id.toString(), email: user.email, name: user.name, picture: user.picture } });
    } catch (err) {
      res.status(401).json({ error: err?.message ?? "Invalid Google token" });
    }
  });

  // ── Session routes ───────────────────────────────────────────────────────
  app.get("/sessions", authenticate, async (req, res) => {
    const chats = await Chat.find({ userId: req.user?.sub }).sort({ updatedAt: -1 }).limit(200).lean();
    res.json({
      sessions: chats.map((c) => ({
        id: c._id.toString(),
        updatedAt: c.updatedAt?.toISOString?.() ?? "",
        title: c.title || "",
      })),
    });
  });

  app.post("/sessions", authenticate, async (req, res) => {
    const userId = req.user?.sub;
    const model = req.body?.model || DEFAULT_MODEL;
    const systemPrompt = req.body?.systemPrompt || DEFAULT_SYSTEM;
    const now = new Date();
    const chat = await Chat.create({
      userId,
      model,
      systemPrompt,
      messages: [{ role: "system", content: systemPrompt, createdAt: now }],
      title: "",
    });
    res.json({ sessionId: chat._id.toString() });
  });

  app.get("/sessions/:id", authenticate, async (req, res) => {
    const chat = await Chat.findOne({ _id: req.params.id, userId: req.user?.sub });
    if (!chat) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ session: toSession(chat) });
  });

  app.delete("/sessions/:id", authenticate, async (req, res) => {
    const result = await Chat.deleteOne({ _id: req.params.id, userId: req.user?.sub });
    res.json({ ok: true, deleted: (result.deletedCount ?? 0) > 0 });
  });

  app.delete("/sessions", authenticate, async (req, res) => {
    const result = await Chat.deleteMany({ userId: req.user?.sub });
    res.json({ ok: true, deletedCount: result.deletedCount ?? 0 });
  });

  // ── Main chat endpoint ───────────────────────────────────────────────────
  app.post("/chat", maybeAuthenticate, async (req, res) => {
    const message = (req.body?.message ?? "").trim();
    if (!message) { res.status(400).json({ error: "Missing message" }); return; }

    const authedUserId = req.user?.sub || null;
    const requestedModel = req.body?.model;
    const requestedSystem = req.body?.systemPrompt;
    const requestedSessionId = (req.body?.sessionId ?? "").trim();

    let chatDoc = null;
    let sessionMessages = [];
    let model = requestedModel || DEFAULT_MODEL;
    let systemPrompt = requestedSystem || DEFAULT_SYSTEM;

    if (authedUserId) {
      if (requestedSessionId) {
        chatDoc = await Chat.findOne({ _id: requestedSessionId, userId: authedUserId });
      }
      if (!chatDoc) {
        const now = new Date();
        chatDoc = await Chat.create({
          userId: authedUserId, model, systemPrompt,
          messages: [{ role: "system", content: systemPrompt, createdAt: now }],
          title: "",
        });
      }
      if (requestedModel) chatDoc.model = requestedModel;
      if (requestedSystem && requestedSystem !== chatDoc.systemPrompt) {
        chatDoc.systemPrompt = requestedSystem;
        chatDoc.messages = [{ role: "system", content: requestedSystem, createdAt: new Date() }];
      }
      chatDoc.messages.push({ role: "user", content: message, createdAt: new Date() });
      await chatDoc.save();
      model = chatDoc.model || DEFAULT_MODEL;
      systemPrompt = chatDoc.systemPrompt || DEFAULT_SYSTEM;
      sessionMessages = chatDoc.messages;
      res.setHeader("x-session-id", chatDoc._id.toString());
    } else {
      const now = new Date().toISOString();
      sessionMessages = [
        { role: "system", content: systemPrompt, createdAt: now },
        { role: "user", content: message, createdAt: now },
      ];
    }

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    let assistantText = "";
    try {
      const groqStream = await groq.chat.completions.create({
        model,
        messages: sessionMessages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      });
      for await (const chunk of groqStream) {
        const delta = chunk?.choices?.[0]?.delta?.content ?? "";
        if (!delta) continue;
        assistantText += delta;
        res.write(delta);
      }
      if (authedUserId && chatDoc) {
        chatDoc.messages.push({ role: "assistant", content: assistantText, createdAt: new Date() });
        if (!chatDoc.title) chatDoc.title = titleFromUserMessage(message);
        await chatDoc.save();
      }
    } catch (err) {
      res.write(`\n\n[Error] ${err?.message ?? String(err)}\n`);
    } finally {
      res.end();
    }
  });

  const port = Number(process.env.PORT) || 4000;
  app.listen(port, () => {
    console.log(`Backend running at http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
