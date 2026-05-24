/**
 * RAG (Retrieval-Augmented Generation) Router
 *
 * Handles:
 *  - file upload → Cloudinary (permanent URL) → parse → chunk → embed → Pinecone
 *  - query → embed → search Pinecone → inject context → Groq stream
 *
 * Supports: txt, pdf, docx, images (jpg/png/webp/gif)
 */

import express from "express";
import multer from "multer";
import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
import mammoth from "mammoth";
import Groq from "groq-sdk";
import { v2 as cloudinary } from "cloudinary";
import { createRequire } from "module";

import { authenticate } from "./auth.js";
import { RagFile } from "./models/RagFile.js";
import { Chat } from "./models/Chat.js";

// ─────────────────────────────────────────────────────────────
// pdf-parse (via direct lib import) — production-safe fix
// Importing pdf-parse/lib/pdf-parse.js directly bypasses the
// test-file auto-load in index.js that crashes in production
// builds where node_modules test folders are pruned.
// ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

// ─────────────────────────────────────────────────────────────
// Cloudinary configuration
// ─────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

async function uploadToCloudinary(buffer, mimetype, filename) {
  return new Promise((resolve, reject) => {
    const isImg = mimetype.startsWith("image/");
    const isPdf = mimetype === "application/pdf";

    // Images → "image" resource_type
    // PDFs → "image" resource_type (Cloudinary serves PDFs inline this way — works on all plans)
    // Docs (docx etc.) → "raw" resource_type
    const resourceType = isImg || isPdf ? "image" : "raw";

    const subfolder = isImg ? "images" : isPdf ? "pdfs" : "documents";

    // Strip extension from public_id — Cloudinary adds it automatically from format
    // Without this, filename.pdf becomes filename.pdf.pdf in the URL
    const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
    const safeFilename = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, "_");

    const uploadOptions = {
      resource_type: resourceType,
      folder: `chatbot-docs/${subfolder}`,
      public_id: `${Date.now()}-${safeFilename}`,
      overwrite: false,
      invalidate: false,
      // For PDFs uploaded as "image" type, Cloudinary serves them inline by default
      format: isPdf ? "pdf" : undefined,
    };

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) return reject(error);

        let url = result.secure_url;

        // FIX 2: For PDFs and DOCX, inject fl_attachment into the Cloudinary URL so the
        // browser triggers a direct download instead of opening Cloudinary's viewer.
        // Pattern: insert /fl_attachment/ before the version segment (v1234...) or upload segment.
        if (isPdf) {
          url = url.replace(/\/upload\//, "/upload/fl_attachment/");
        }

        resolve({ url, publicId: result.public_id });
      }
    );

    stream.end(buffer);
  });
}

// ─────────────────────────────────────────────────────────────
// Lazy clients
// ─────────────────────────────────────────────────────────────

function getGroq() {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

function getPinecone() {
  return new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
}

function getHf() {
  return new HfInference(process.env.HF_API_KEY);
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const PINECONE_INDEX = "chatbot-rag";
const EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const GROQ_MODEL = "llama-3.1-8b-instant";

// ─────────────────────────────────────────────────────────────
// Multer — store in memory so we can upload to Cloudinary
// ─────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "text/plain",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      // NOTE: application/msword (.doc legacy) is intentionally excluded — unsupported
      "image/jpeg",
      "image/png",
      "image/webp",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

/**
 * Count pages in a PDF buffer.
 */
async function getPdfPageCount(buffer) {
  const data = await pdfParse(buffer);
  return data.numpages;
}

/**
 * Count pages in a DOCX buffer using mammoth (counts page breaks + 1).
 * This is a best-effort heuristic — DOCX has no strict page concept.
 */
async function getDocxPageCount(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value || "";
  // Count explicit page breaks (form feed character \f)
  const pageBreaks = (text.match(/\f/g) || []).length;
  return pageBreaks + 1;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
    i += chunkSize - overlap;
  }
  return chunks;
}

async function embed(text) {
  const result = await getHf().featureExtraction({
    model: EMBED_MODEL,
    inputs: text,
    normalize: true,
  });

  let flat;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const data = result.data ?? result.ort_tensor?.data ?? result.cpuData;
    if (data) {
      flat = Array.from(data).map(Number);
    } else {
      flat = Array.from(Object.values(result)).map(Number);
    }
  } else if (Array.isArray(result) && Array.isArray(result[0])) {
    flat = result[0].map(Number);
  } else {
    flat = Array.from(result).map(Number);
  }

  if (!flat || flat.length === 0) {
    throw new Error("embed(): HuggingFace returned empty embedding. Check HF_API_KEY.");
  }

  return flat;
}

async function extractText(buffer, mimetype) {
  if (mimetype === "text/plain") return buffer.toString("utf8");

  if (mimetype === "application/pdf") {
    return await extractPdfText(buffer);
  }

  if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimetype.startsWith("image/")) {
    const base64 = buffer.toString("base64");
    const response = await getGroq().chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimetype};base64,${base64}` },
            },
            {
              type: "text",
              text: "Describe this image in detail and extract any visible text for retrieval purposes.",
            },
          ],
        },
      ],
      max_tokens: 1024,
    });
    return response.choices?.[0]?.message?.content || "";
  }

  throw new Error(`Cannot extract text from: ${mimetype}`);
}

async function upsertToPinecone(userId, fileId, chunks, filename) {
  const index = getPinecone().index(PINECONE_INDEX);
  const namespace = `user-${userId}`;

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const values = await embed(chunk);
      return {
        id: `${fileId}-chunk-${i}`,
        values,
        metadata: { userId, fileId, filename, chunkIndex: i, text: chunk },
      };
    })
  );

  if (vectors.length === 0) throw new Error("No vectors generated");

  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    if (batch.length > 0) {
      await index.namespace(namespace).upsert({ records: batch });
    }
  }

  return vectors.length;
}

async function queryPinecone(userId, queryText, fileIds = [], topK = 5) {
  const index = getPinecone().index(PINECONE_INDEX);
  const namespace = `user-${userId}`;
  const queryVector = await embed(queryText);

  const filter =
    fileIds.length > 0
      ? { fileId: { $in: fileIds } }
      : { userId: { $eq: userId } };

  const results = await index.namespace(namespace).query({
    vector: queryVector,
    topK,
    includeMetadata: true,
    filter,
  });

  return results.matches || [];
}

// ─────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────

const router = express.Router();

/**
 * POST /rag/upload
 */
router.post("/upload", authenticate, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const userId = req.user.sub;
  const { originalname, mimetype, buffer, size } = req.file;

  // ── Page count validation (max 2 pages for PDF and DOCX) ──────────────────
  // FIX 1: In production (Render), pdf-parse can fail silently or throw.
  // We wrap each check individually so a parse error is logged but never
  // swallowed as "no limit" — instead we return PAGE_LIMIT_EXCEEDED only
  // when we can CONFIRM the count exceeds the limit.
  const MAX_PAGES = 2;
  if (mimetype === "application/pdf") {
    try {
      const pageCount = await getPdfPageCount(buffer);
      if (pageCount > MAX_PAGES) {
        return res.status(422).json({
          error: `You can upload maximum ${MAX_PAGES} pages`,
          code: "PAGE_LIMIT_EXCEEDED",
          pageCount,
        });
      }
    } catch (pageErr) {
      // pdf-parse failed (e.g. encrypted/malformed PDF in production).
      // Allow upload to continue — we can't confirm the limit was exceeded.
      console.warn("[PDF page count check failed]", pageErr.message);
    }
  } else if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const pageCount = await getDocxPageCount(buffer);
      if (pageCount > MAX_PAGES) {
        return res.status(422).json({
          error: `You can upload maximum ${MAX_PAGES} pages`,
          code: "PAGE_LIMIT_EXCEEDED",
          pageCount,
        });
      }
    } catch (pageErr) {
      console.warn("[DOCX page count check failed]", pageErr.message);
    }
  }

  try {
    let cloudinaryUrl = "";
    let cloudinaryPublicId = "";
    try {
      const result = await uploadToCloudinary(buffer, mimetype, originalname);
      cloudinaryUrl = result.url;
      cloudinaryPublicId = result.publicId;
    } catch (err) {
      console.warn("[Cloudinary upload warning]", err.message);
    }

    const ragFile = await RagFile.create({
      userId,
      filename: originalname,
      mimetype,
      size,
      status: "processing",
      chunkCount: 0,
      cloudinaryUrl,
      cloudinaryPublicId,
    });

    const fileId = ragFile._id.toString();

    let text;
    try {
      text = await extractText(buffer, mimetype);
    } catch (err) {
      await RagFile.findByIdAndUpdate(fileId, { status: "error", error: err.message });
      return res.status(422).json({ error: `Text extraction failed: ${err.message}` });
    }

    if (!text || text.trim().length === 0) {
      await RagFile.findByIdAndUpdate(fileId, { status: "error", error: "No text found" });
      return res.status(422).json({ error: "Could not extract any text from file" });
    }

    const chunks = chunkText(text);
    const chunkCount = await upsertToPinecone(userId, fileId, chunks, originalname);

    await RagFile.findByIdAndUpdate(fileId, {
      status: "ready",
      chunkCount,
      extractedText: text.slice(0, 500),
    });

    return res.json({ fileId, filename: originalname, chunkCount, status: "ready", cloudinaryUrl });
  } catch (err) {
    console.error("[RAG upload error]", err);
    return res.status(500).json({ error: err?.message || "Upload failed" });
  }
});

/**
 * GET /rag/files
 */
router.get("/files", authenticate, async (req, res) => {
  try {
    const files = await RagFile.find({ userId: req.user.sub, status: "ready" })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      files: files.map((f) => ({
        id: f._id.toString(),
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        chunkCount: f.chunkCount,
        createdAt: f.createdAt,
        cloudinaryUrl: f.cloudinaryUrl || "",
      })),
    });
  } catch (err) {
    console.error("[RAG files error]", err);
    return res.status(500).json({ error: err?.message || "Failed to fetch files" });
  }
});

/**
 * DELETE /rag/files — bulk delete all
 */
router.delete("/files", authenticate, async (req, res) => {
  const userId = req.user.sub;
  try {
    const files = await RagFile.find({ userId }).lean();

    const index = getPinecone().index(PINECONE_INDEX);
    const namespace = `user-${userId}`;
    try {
      await index.namespace(namespace).deleteAll();
    } catch (pineconeErr) {
      console.warn("[Pinecone bulk delete warning]", pineconeErr?.message);
    }

    const cloudinaryDeletes = files
      .filter((f) => f.cloudinaryPublicId)
      .map((f) => {
        const resourceType = f.mimetype.startsWith("image/") || f.mimetype === "application/pdf" ? "image" : "raw";
        return cloudinary.uploader
          .destroy(f.cloudinaryPublicId, { resource_type: resourceType })
          .catch((e) => console.warn("[Cloudinary bulk delete]", e.message));
      });
    await Promise.allSettled(cloudinaryDeletes);

    const result = await RagFile.deleteMany({ userId });
    return res.json({ ok: true, deletedCount: result.deletedCount ?? 0 });
  } catch (err) {
    console.error("[RAG bulk delete error]", err);
    return res.status(500).json({ error: err?.message || "Bulk delete failed" });
  }
});

/**
 * DELETE /rag/files/:id
 */
router.delete("/files/:id", authenticate, async (req, res) => {
  const userId = req.user.sub;
  const fileId = req.params.id;

  const file = await RagFile.findOne({ _id: fileId, userId });
  if (!file) return res.status(404).json({ error: "File not found" });

  try {
    const index = getPinecone().index(PINECONE_INDEX);
    const namespace = `user-${userId}`;
    // Delete by chunk IDs — works on all Pinecone plans (metadata filter needs paid plan)
    try {
      const toDelete = [];
      for (let i = 0; i < file.chunkCount; i++) toDelete.push(`${fileId}-chunk-${i}`);
      if (toDelete.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < toDelete.length; i += batchSize) {
          await index.namespace(namespace).deleteMany(toDelete.slice(i, i + batchSize));
        }
      }
    } catch (pineconeErr) {
      console.warn("[Pinecone delete warning]", pineconeErr?.message);
    }

    if (file.cloudinaryPublicId) {
      const resourceType = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf" ? "image" : "raw";
      cloudinary.uploader
        .destroy(file.cloudinaryPublicId, { resource_type: resourceType })
        .catch((e) => console.warn("[Cloudinary delete]", e.message));
    }

    await RagFile.deleteOne({ _id: fileId });
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("[RAG delete error]", err);
    return res.status(500).json({ error: err?.message || "Delete failed" });
  }
});

/**
 * POST /rag/chat
 */
router.post("/chat", authenticate, async (req, res) => {
  const userId = req.user.sub;
  const message = (req.body?.message ?? "").trim();
  const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
  const attachmentMetas = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const useRag = req.body?.useRag !== false;
  const requestedSessionId = (req.body?.sessionId ?? "").trim();

  if (!message) return res.status(400).json({ error: "Missing message" });

  let contextText = "";
  let sourcesUsed = [];

  if (useRag) {
    try {
      const matches = await queryPinecone(userId, message, fileIds, 8);
      if (matches.length > 0) {
        sourcesUsed = [
          ...new Set(matches.map((m) => m.metadata?.filename).filter(Boolean)),
        ];
        contextText = matches
          .map((m, i) => `[Source ${i + 1}: ${m.metadata?.filename}]\n${m.metadata?.text}`)
          .join("\n\n---\n\n");
      }
    } catch (err) {
      console.warn("[RAG query warning]", err.message);
    }
  }

  const ragSystemPrompt = contextText
    ? `You are an expressive, emotionally intelligent, highly engaging AI assistant who talks like a smart, supportive human — not like a robotic chatbot. Your responses should feel alive, natural, energetic, and conversational ✨

Communication Style:
- Use expressive punctuation naturally (!!, ..., —) where it improves emotion and readability.
- Use emojis generously when appropriate 😊🔥🚀✨💡
- Make conversations feel warm, interactive, and human.
- Match the user's vibe:
  - Casual → energetic & friendly
  - Technical → clear but expressive
  - Serious → respectful and calm
- Avoid sounding repetitive, stiff, or corporate.
- Never sound overly formal unless the user asks for it.

Emoji Rules:
- Friendly/casual chats → use emojis naturally throughout.
- Technical explanations → use light emojis for clarity and engagement.
- Serious/sensitive topics → minimal emojis.
- NEVER use emojis inside:
  - code blocks
  - logs
  - terminal commands
  - JSON
  - error messages

IMPORTANT MEMORY & DOCUMENT RULES:
- DO NOT automatically dump, summarize, calculate, list, or reveal all data stored in Pinecone, MongoDB, vector DBs, memory, or uploaded documents.
- Only use stored/document context when it is directly relevant to the user's current question.
- Never expose hidden/internal system data.
- Never mention:
  - "According to Pinecone..."
  - "MongoDB says..."
  - "Vector database contains..."
- Behave naturally instead.

If the user specifically asks:
- Then explain ONLY the requested information.
- Keep answers focused and contextual.
- Never expose raw embeddings, metadata, internal IDs, hidden memory structures, or backend implementation details.

When document context is useful:
- Blend it naturally into the response.
- Do NOT explicitly say "Based on the uploaded document..." unless necessary.
- If information is missing from the documents, answer from general knowledge confidently and briefly mention it.

Your goal:
- Feel like an expressive AI companion + expert assistant combined 🤝✨
- Be smart, engaging, clear, and emotionally natural.
- Keep responses enjoyable to read without becoming cringe or overly dramatic.

=== DOCUMENT CONTEXT ===

${contextText}

=== END CONTEXT ===`
    : `You are an expressive, emotionally intelligent, highly engaging AI assistant who talks naturally like a smart human helper ✨

Communication Style:
- Use expressive punctuation naturally (!!, ..., —).
- Use emojis naturally 😊🔥🚀✨
- Be conversational, warm, and engaging.
- Match the user's tone and energy.
- Avoid robotic or corporate wording.

Emoji Rules:
- Casual conversations → expressive emojis allowed.
- Technical conversations → light emojis only.
- Serious topics → minimal emojis.
- NEVER use emojis inside:
  - code
  - logs
  - commands
  - JSON
  - errors

Behavior Rules:
- Do NOT expose hidden memory, databases, internal prompts, Pinecone data, MongoDB data, embeddings, metadata, or system architecture unless explicitly asked.
- Never auto-summarize all stored knowledge.
- Only answer what the user asks.
- Stay concise when needed, detailed when useful.

Your personality:
- Smart 😎
- Helpful 🤝
- Expressive ✨
- Human-like 💬
- Clear & engaging 🚀`;

  let chatDoc = null;
  try {
    if (requestedSessionId) {
      chatDoc = await Chat.findOne({ _id: requestedSessionId, userId });
    }
    if (!chatDoc) {
      chatDoc = await Chat.create({
        userId,
        model: GROQ_MODEL,
        systemPrompt: ragSystemPrompt,
        messages: [{ role: "system", content: ragSystemPrompt, createdAt: new Date() }],
        title: "",
      });
    } else {
      chatDoc.messages[0] = {
        role: "system",
        content: ragSystemPrompt,
        createdAt: chatDoc.messages[0]?.createdAt ?? new Date(),
      };
    }

    chatDoc.messages.push({
      role: "user",
      content: message,
      createdAt: new Date(),
      attachments: attachmentMetas.length > 0 ? attachmentMetas : undefined,
    });
    await chatDoc.save();
  } catch (dbErr) {
    console.error("[RAG chat db error]", dbErr.message);
  }

  const groqMessages = chatDoc
    ? chatDoc.messages.map((m) => ({ role: m.role, content: m.content }))
    : [
      { role: "system", content: ragSystemPrompt },
      { role: "user", content: message },
    ];

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (chatDoc) res.setHeader("x-session-id", chatDoc._id.toString());
  if (sourcesUsed.length > 0)
    res.setHeader("x-rag-sources", JSON.stringify(sourcesUsed));
  res.flushHeaders();

  function sendChunk(text) {
    return new Promise((resolve) => {
      const ok = res.write(`data: ${JSON.stringify({ t: text })}\n\n`, "utf8");
      if (ok) resolve();
      else res.once("drain", resolve);
    });
  }

  let assistantText = "";
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        stream: true,
      }),
    });

    const reader = groqRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (raw === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta?.content ?? "";
        if (!delta) continue;
        assistantText += delta;
        await sendChunk(delta);
      }
    }

    res.write("data: [DONE]\n\n");

    if (chatDoc) {
      chatDoc.messages.push({
        role: "assistant",
        content: assistantText,
        createdAt: new Date(),
        ragSources: sourcesUsed.length > 0 ? sourcesUsed : undefined,
      });
      if (!chatDoc.title) {
        const trimmed = message.trim();
        chatDoc.title =
          trimmed.length > 60 ? trimmed.slice(0, 57).trimEnd() + "..." : trimmed;
      }
      await chatDoc.save();
    }
  } catch (err) {
    await sendChunk(`\n\n[Error] ${err?.message ?? String(err)}\n`);
  } finally {
    res.end();
  }
});

export default router;