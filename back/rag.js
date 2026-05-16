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
// pdf2json — pure JS, no workers, no CJS/ESM issues
// ─────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

async function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataReady", () => {
      try {
        resolve(parser.getRawTextContent());
      } catch (e) {
        reject(new Error("PDF text extraction failed: " + e.message));
      }
    });
    parser.on("pdfParser_dataError", (err) => {
      reject(new Error(err?.parserError ?? "PDF parse failed"));
    });
    parser.parseBuffer(buffer);
  });
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
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });

  return new Promise((resolve, reject) => {
    const isPdf = mimetype === "application/pdf";
    const isImg = mimetype.startsWith("image/");
    const resourceType = isImg || isPdf ? "image" : "raw";

    const subfolder = isImg ? "images" : isPdf ? "pdfs" : "documents";
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder: `chatbot-docs/${subfolder}`,
        public_id: `${Date.now()}-${safeFilename}`,
        overwrite: false,
        invalidate: false,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id });
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
      "application/msword",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

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
    // ✅ pdf2json — pure JS, no worker, works on all Node versions
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
        const isPdf = f.mimetype === "application/pdf";
        const resourceType = f.mimetype.startsWith("image/") || isPdf ? "image" : "raw";
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
    try {
      await index.namespace(namespace).deleteMany({ fileId });
    } catch {
      const toDelete = [];
      for (let i = 0; i < file.chunkCount; i++) toDelete.push(`${fileId}-chunk-${i}`);
      if (toDelete.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < toDelete.length; i += batchSize) {
          await index.namespace(namespace).deleteMany(toDelete.slice(i, i + batchSize));
        }
      }
    }

    if (file.cloudinaryPublicId) {
      const isPdf = file.mimetype === "application/pdf";
      const resourceType = file.mimetype.startsWith("image/") || isPdf ? "image" : "raw";
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
    ? `You are a knowledgeable, friendly AI assistant. You speak naturally, like a helpful expert colleague — warm but not overly casual. You adapt your tone to the topic.

Emoji policy:
- Use emojis when they fit the context (friendly, celebratory, encouraging) and add clarity or warmth.
- For technical/serious topics, use 0–1 emojis; for casual chat, use 1–2.
- Never use emojis in code blocks, logs, command output, or error messages.

The user has shared some documents with you. Draw on them naturally when they're relevant. Don't announce that you're "referring to the document" unless it adds clarity. If the documents don't cover something, answer from your own knowledge and say so briefly.

=== DOCUMENT CONTEXT ===

${contextText}

=== END CONTEXT ===`
    : `You are a knowledgeable, friendly AI assistant. You speak naturally, like a helpful expert colleague — warm but concise. You think through problems carefully, communicate clearly, and match your tone to the situation.

Emoji policy:
- Use emojis when they fit the context (friendly, celebratory, encouraging) and add clarity or warmth.
- For technical/serious topics, use 0–1 emojis; for casual chat, use 1–2.
- Never use emojis in code blocks, logs, command output, or error messages.`;

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