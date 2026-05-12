/**
 * RAG (Retrieval-Augmented Generation) Router
 * Handles: file upload → parse → chunk → embed → upsert to Pinecone
 *          query → embed → search Pinecone → inject context → Groq stream
 *
 * Supports: .txt, .pdf, .docx, images (jpg/png/webp/gif)
 */

import express from "express";
import multer from "multer";
import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
// import pdfParse from "pdf-parse/lib/pdf-parse.js";
import * as pdfParse from "pdf-parse";
import mammoth from "mammoth";
import Groq from "groq-sdk";
import { authenticate } from "./auth.js";
import { RagFile } from "./models/RagFile.js";

// ── Lazy Clients (read env AFTER dotenv loads in app.js) ───────────────────
function getGroq() {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

function getPinecone() {
  return new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
}

function getHf() {
  return new HfInference(process.env.HF_API_KEY);
}

// ── Constants (safe to hardcode — won't change at runtime) ─────────────────
const PINECONE_INDEX = "chatbot-rag";
const EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"; // 384 dims, free on HF
const GROQ_MODEL = "llama-3.1-8b-instant";

// ── Multer (in-memory, 20 MB limit) ───────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Split text into overlapping chunks */
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

/** Get embedding vector from HuggingFace */
async function embed(text) {
  const result = await getHf().featureExtraction({
    model: EMBED_MODEL,
    inputs: text,
  });

  // Convert tensor-like object to plain array
  const arr = Array.from(result);

  // If model returned nested array, take first embedding
  return Array.isArray(arr[0]) ? arr[0] : arr;
}

/** Extract text from uploaded file buffer */
async function extractText(buffer, mimetype) {
  // Plain text
  if (mimetype === "text/plain") {
    return buffer.toString("utf8");
  }

  // PDF
  if (mimetype === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text;
  }

  // Word (.docx / .doc)
  if (
    mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Images → use Groq vision to extract text/description
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
              text: "Describe this image in detail. Extract any visible text. Be thorough so this description can be used for information retrieval.",
            },
          ],
        },
      ],
      max_tokens: 1024,
    });
    return response.choices[0]?.message?.content || "";
  }

  throw new Error(`Cannot extract text from: ${mimetype}`);
}

/** Embed chunks and upsert vectors to Pinecone */
async function upsertToPinecone(userId, fileId, chunks, filename) {
  const index = getPinecone().index(PINECONE_INDEX);
  const namespace = `user-${userId}`;

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const values = await embed(chunk);
      return {
        id: `${fileId}-chunk-${i}`,
        values,
        metadata: {
          userId,
          fileId,
          filename,
          chunkIndex: i,
          text: chunk,
        },
      };
    })
  );

  console.log("Vectors count:", vectors.length);
  console.log("First vector:", vectors[0]);

  // Pinecone recommends batches of 100
  // const batchSize = 100;
  // for (let i = 0; i < vectors.length; i += batchSize) {
  //   await index.namespace(namespace).upsert({
  //     vectors: vectors.slice(i, i + batchSize),
  //   });
  // }

  const batchSize = 100;

  for (let i = 0; i < vectors.length; i += batchSize) {
    await index.namespace(namespace).upsert({
      records: vectors.slice(i, i + batchSize),
    });
  }

  return vectors.length;
}

/** Query Pinecone for relevant chunks */
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

// ── Router ─────────────────────────────────────────────────────────────────
const router = express.Router();

/**
 * POST /rag/upload
 * Upload and index a file (auth required)
 */
router.post(
  "/upload",
  authenticate,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const userId = req.user.sub;
    const { originalname, mimetype, buffer, size } = req.file;

    try {
      // 1. Save metadata to MongoDB first (get fileId)
      const ragFile = await RagFile.create({
        userId,
        filename: originalname,
        mimetype,
        size,
        status: "processing",
        chunkCount: 0,
      });

      const fileId = ragFile._id.toString();

      // 2. Extract text
      let text;
      try {
        text = await extractText(buffer, mimetype);
      } catch (err) {
        await RagFile.findByIdAndUpdate(fileId, {
          status: "error",
          error: err.message,
        });
        return res
          .status(422)
          .json({ error: `Text extraction failed: ${err.message}` });
      }

      if (!text || text.trim().length === 0) {
        await RagFile.findByIdAndUpdate(fileId, {
          status: "error",
          error: "No text found",
        });
        return res
          .status(422)
          .json({ error: "Could not extract any text from file" });
      }

      // 3. Chunk text
      const chunks = chunkText(text);

      // 4. Embed + upsert to Pinecone
      const chunkCount = await upsertToPinecone(
        userId,
        fileId,
        chunks,
        originalname
      );

      // 5. Mark as ready
      await RagFile.findByIdAndUpdate(fileId, {
        status: "ready",
        chunkCount,
        extractedText: text.slice(0, 500), // preview only
      });

      res.json({
        fileId,
        filename: originalname,
        chunkCount,
        status: "ready",
      });
    } catch (err) {
      console.error("[RAG upload error]", err);
      res.status(500).json({ error: err?.message || "Upload failed" });
    }
  }
);

/**
 * GET /rag/files
 * List user's indexed files
 */
router.get("/files", authenticate, async (req, res) => {
  try {
    const userId = req.user.sub;
    const files = await RagFile.find({ userId, status: "ready" })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      files: files.map((f) => ({
        id: f._id.toString(),
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        chunkCount: f.chunkCount,
        createdAt: f.createdAt,
      })),
    });
  } catch (err) {
    console.error("[RAG files error]", err);
    res.status(500).json({ error: err?.message || "Failed to fetch files" });
  }
});

/**
 * DELETE /rag/files/:id
 * Delete a file and its Pinecone vectors
 */
router.delete("/files/:id", authenticate, async (req, res) => {
  const userId = req.user.sub;
  const fileId = req.params.id;

  const file = await RagFile.findOne({ _id: fileId, userId });
  if (!file) return res.status(404).json({ error: "File not found" });

  try {
    const index = getPinecone().index(PINECONE_INDEX);
    const namespace = `user-${userId}`;

    // Build list of all chunk IDs and delete them
    const toDelete = [];
    for (let i = 0; i < file.chunkCount; i++) {
      toDelete.push(`${fileId}-chunk-${i}`);
    }
    if (toDelete.length > 0) {
      await index.namespace(namespace).deleteMany(toDelete);
    }

    await RagFile.deleteOne({ _id: fileId });
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error("[RAG delete error]", err);
    res.status(500).json({ error: err?.message || "Delete failed" });
  }
});

/**
 * POST /rag/chat
 * RAG-augmented chat with streaming
 * Body: { message, fileIds?: string[], useRag?: boolean }
 */
router.post("/chat", authenticate, async (req, res) => {
  const userId = req.user.sub;
  const message = (req.body?.message ?? "").trim();
  const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
  const useRag = req.body?.useRag !== false; // default true

  if (!message) return res.status(400).json({ error: "Missing message" });

  let contextText = "";
  let sourcesUsed = [];

  // 1. Retrieve relevant chunks from Pinecone
  if (useRag) {
    try {
      const matches = await queryPinecone(userId, message, fileIds, 5);
      if (matches.length > 0) {
        sourcesUsed = [
          ...new Set(
            matches.map((m) => m.metadata?.filename).filter(Boolean)
          ),
        ];
        contextText = matches
          .map(
            (m, i) =>
              `[Source ${i + 1}: ${m.metadata?.filename}]\n${m.metadata?.text}`
          )
          .join("\n\n---\n\n");
      }
    } catch (err) {
      console.warn("[RAG query warning]", err.message);
      // Continue without RAG context on error
    }
  }

  // 2. Build system prompt
  const systemPrompt = contextText
    ? `You are a helpful AI assistant with access to uploaded documents.

Use the following retrieved context to answer the user's question accurately.
If the context doesn't contain relevant information, say so and answer from your general knowledge.

=== RETRIEVED CONTEXT ===
${contextText}
=== END CONTEXT ===

Instructions:
- Prioritize information from the context above
- Cite the source filename when referencing retrieved content
- Be concise and accurate`
    : `You are a helpful AI assistant. Answer the user's question using your general knowledge.`;

  // 3. Set response headers
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (sourcesUsed.length > 0) {
    res.setHeader("x-rag-sources", JSON.stringify(sourcesUsed));
  }

  // 4. Stream response from Groq
  try {
    const stream = await getGroq().chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content ?? "";
      if (delta) res.write(delta);
    }
  } catch (err) {
    res.write(`\n\n[Error] ${err?.message ?? String(err)}\n`);
  } finally {
    res.end();
  }
});

export default router;