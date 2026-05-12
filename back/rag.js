/**
 * RAG (Retrieval-Augmented Generation) Router
 * Handles:
 * - file upload → parse → chunk → embed → upsert to Pinecone
 * - query → embed → search Pinecone → inject context → Groq stream
 *
 * Supports:
 * - txt
 * - pdf
 * - docx
 * - images (jpg/png/webp/gif)
 */

import express from "express";
import multer from "multer";
import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import Groq from "groq-sdk";

import { authenticate } from "./auth.js";
import { RagFile } from "./models/RagFile.js";
import { Chat } from "./models/Chat.js";

// ─────────────────────────────────────────────────────────────
// Lazy Clients
// ─────────────────────────────────────────────────────────────

function getGroq() {
  return new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });
}

function getPinecone() {
  return new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });
}

function getHf() {
  return new HfInference(process.env.HF_API_KEY);
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const PINECONE_INDEX = "chatbot-rag";

const EMBED_MODEL =
  "sentence-transformers/all-MiniLM-L6-v2";

const GROQ_MODEL = "llama-3.1-8b-instant";

// ─────────────────────────────────────────────────────────────
// Multer
// ─────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024,
  },

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

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file type: ${file.mimetype}`
        )
      );
    }
  },
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Split text into chunks
 */
function chunkText(
  text,
  chunkSize = 500,
  overlap = 50
) {
  const words = text
    .split(/\s+/)
    .filter(Boolean);

  const chunks = [];

  let i = 0;

  while (i < words.length) {
    chunks.push(
      words
        .slice(i, i + chunkSize)
        .join(" ")
    );

    i += chunkSize - overlap;
  }

  return chunks;
}

/**
 * Create embeddings
 */
async function embed(text) {
  const result =
    await getHf().featureExtraction({
      model: EMBED_MODEL,
      inputs: text,
    });

  // Convert safely into normal JS array
  const embedding = Array.from(
    result.flat
      ? result.flat()
      : result
  );

  return embedding.map(Number);
}

/**
 * Extract text from uploaded file
 */
async function extractText(
  buffer,
  mimetype
) {
  // TXT
  if (mimetype === "text/plain") {
    return buffer.toString("utf8");
  }

  // PDF
  if (mimetype === "application/pdf") {
    const parser = new PDFParse({
      data: buffer,
    });

    const result =
      await parser.getText();

    return result.text;
  }

  // DOCX / DOC
  if (
    mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimetype === "application/msword"
  ) {
    const result =
      await mammoth.extractRawText({
        buffer,
      });

    return result.value;
  }

  // Images
  if (mimetype.startsWith("image/")) {
    const base64 =
      buffer.toString("base64");

    const response =
      await getGroq().chat.completions.create(
        {
          model:
            "meta-llama/llama-4-scout-17b-16e-instruct",

          messages: [
            {
              role: "user",

              content: [
                {
                  type: "image_url",

                  image_url: {
                    url: `data:${mimetype};base64,${base64}`,
                  },
                },

                {
                  type: "text",

                  text:
                    "Describe this image in detail and extract visible text for retrieval purposes.",
                },
              ],
            },
          ],

          max_tokens: 1024,
        }
      );

    return (
      response.choices?.[0]?.message
        ?.content || ""
    );
  }

  throw new Error(
    `Cannot extract text from: ${mimetype}`
  );
}

/**
 * Upsert vectors to Pinecone
 */
async function upsertToPinecone(
  userId,
  fileId,
  chunks,
  filename
) {

  
  const index =
    getPinecone().index(
      PINECONE_INDEX
    );

  const namespace = `user-${userId}`;

  const vectors = await Promise.all(
    chunks.map(async (chunk, i) => {
      const values = await embed(chunk);

      return {
        id: `${fileId}-chunk-${i}`,
        values,                          // yeh same hai
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

  console.log(
    "Vectors count:",
    vectors.length
  );

  if (vectors.length === 0) {
    throw new Error(
      "No vectors generated"
    );
  }

  const batchSize = 100;

  for (
    let i = 0;
    i < vectors.length;
    i += batchSize
  ) {
    const batch = vectors.slice(
      i,
      i + batchSize
    );


    console.log(
      "Uploading batch size:",
      batch.length
    );

    console.log(
      "First vector:",
      JSON.stringify(batch[0], null, 2)
    );

    // if (batch.length > 0) {
    //   await index
    //     .namespace(namespace)
    //     .upsert(batch);
    // }

    if (batch.length > 0) {
      await index.namespace(namespace).upsert({ records: batch });  // ✅ v7 syntax
    }

  }


  return vectors.length;
}

/**
 * Query Pinecone
 */
async function queryPinecone(
  userId,
  queryText,
  fileIds = [],
  topK = 5
) {
  const index =
    getPinecone().index(
      PINECONE_INDEX
    );

  const namespace = `user-${userId}`;

  const queryVector =
    await embed(queryText);

  const filter =
    fileIds.length > 0
      ? {
        fileId: {
          $in: fileIds,
        },
      }
      : {
        userId: {
          $eq: userId,
        },
      };

  const results = await index
    .namespace(namespace)
    .query({
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
 * Upload
 */
router.post(
  "/upload",
  authenticate,
  upload.single("file"),

  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({
          error:
            "No file uploaded",
        });
    }

    const userId = req.user.sub;

    const {
      originalname,
      mimetype,
      buffer,
      size,
    } = req.file;

    try {
      // Save metadata
      const ragFile =
        await RagFile.create({
          userId,
          filename: originalname,
          mimetype,
          size,
          status: "processing",
          chunkCount: 0,
        });

      const fileId =
        ragFile._id.toString();

      // Extract text
      let text;

      try {
        text =
          await extractText(
            buffer,
            mimetype
          );
      } catch (err) {
        await RagFile.findByIdAndUpdate(
          fileId,
          {
            status: "error",
            error: err.message,
          }
        );

        return res
          .status(422)
          .json({
            error: `Text extraction failed: ${err.message}`,
          });
      }

      if (
        !text ||
        text.trim().length === 0
      ) {
        await RagFile.findByIdAndUpdate(
          fileId,
          {
            status: "error",
            error:
              "No text found",
          }
        );

        return res
          .status(422)
          .json({
            error:
              "Could not extract any text from file",
          });
      }

      // Chunk
      const chunks =
        chunkText(text);

      // Upsert
      const chunkCount =
        await upsertToPinecone(
          userId,
          fileId,
          chunks,
          originalname
        );

      // Mark ready
      await RagFile.findByIdAndUpdate(
        fileId,
        {
          status: "ready",
          chunkCount,

          extractedText:
            text.slice(0, 500),
        }
      );

      return res.json({
        fileId,
        filename:
          originalname,
        chunkCount,
        status: "ready",
      });
    } catch (err) {
      console.error(
        "[RAG upload error]",
        err
      );

      return res
        .status(500)
        .json({
          error:
            err?.message ||
            "Upload failed",
        });
    }
  }
);

/**
 * List files
 */
router.get(
  "/files",
  authenticate,

  async (req, res) => {
    try {
      const userId =
        req.user.sub;

      const files =
        await RagFile.find({
          userId,
          status: "ready",
        })
          .sort({
            createdAt: -1,
          })
          .lean();

      return res.json({
        files: files.map((f) => ({
          id: f._id.toString(),
          filename:
            f.filename,
          mimetype:
            f.mimetype,
          size: f.size,
          chunkCount:
            f.chunkCount,
          createdAt:
            f.createdAt,
        })),
      });
    } catch (err) {
      console.error(
        "[RAG files error]",
        err
      );

      return res
        .status(500)
        .json({
          error:
            err?.message ||
            "Failed to fetch files",
        });
    }
  }
);

/**
 * Delete file
 */
router.delete(
  "/files/:id",
  authenticate,

  async (req, res) => {
    const userId =
      req.user.sub;

    const fileId =
      req.params.id;

    const file =
      await RagFile.findOne({
        _id: fileId,
        userId,
      });

    if (!file) {
      return res
        .status(404)
        .json({
          error:
            "File not found",
        });
    }

    try {
      const index =
        getPinecone().index(
          PINECONE_INDEX
        );

      const namespace = `user-${userId}`;

      const toDelete = [];

      for (
        let i = 0;
        i < file.chunkCount;
        i++
      ) {
        toDelete.push(
          `${fileId}-chunk-${i}`
        );
      }

      if (
        toDelete.length > 0
      ) {
        await index
          .namespace(namespace)
          .deleteMany(
            toDelete
          );
      }

      await RagFile.deleteOne({
        _id: fileId,
      });

      return res.json({
        ok: true,
        deleted: true,
      });
    } catch (err) {
      console.error(
        "[RAG delete error]",
        err
      );

      return res
        .status(500)
        .json({
          error:
            err?.message ||
            "Delete failed",
        });
    }
  }
);

/**
 * Chat — with MongoDB history persistence
 */
router.post(
  "/chat",
  authenticate,

  async (req, res) => {
    const userId = req.user.sub;

    const message = (req.body?.message ?? "").trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    const useRag = req.body?.useRag !== false;
    const requestedSessionId = (req.body?.sessionId ?? "").trim();

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    let contextText = "";
    let sourcesUsed = [];

    // ── Retrieve RAG context ────────────────────────────────────────────────
    if (useRag) {
      try {
        const matches = await queryPinecone(userId, message, fileIds, 8);

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
      }
    }

    // ── Build system prompt ─────────────────────────────────────────────────
    const ragSystemPrompt = contextText
      ? `You are a helpful conversational AI assistant.\n\nThe user has uploaded documents. Use the provided document context naturally while answering. If the answer is unavailable in documents, answer using general knowledge.\n\n=== DOCUMENT CONTEXT ===\n\n${contextText}\n\n=== END CONTEXT ===`
      : `You are a helpful conversational AI assistant.`;

    // ── Load or create MongoDB chat session ─────────────────────────────────
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
        // Update system prompt with fresh RAG context
        chatDoc.messages[0] = { role: "system", content: ragSystemPrompt, createdAt: chatDoc.messages[0]?.createdAt ?? new Date() };
      }

      // Push user message
      chatDoc.messages.push({ role: "user", content: message, createdAt: new Date() });
      await chatDoc.save();
    } catch (dbErr) {
      console.error("[RAG chat db error]", dbErr.message);
      // Non-fatal: continue without history
    }

    // ── Build messages array for Groq (full history) ─────────────────────────
    const groqMessages = chatDoc
      ? chatDoc.messages.map((m) => ({ role: m.role, content: m.content }))
      : [
          { role: "system", content: ragSystemPrompt },
          { role: "user", content: message },
        ];

    // ── Response headers ────────────────────────────────────────────────────
    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (chatDoc) res.setHeader("x-session-id", chatDoc._id.toString());
    if (sourcesUsed.length > 0) {
      res.setHeader("x-rag-sources", JSON.stringify(sourcesUsed));
    }

    // ── Stream response ─────────────────────────────────────────────────────
    let assistantText = "";
    try {
      const stream = await getGroq().chat.completions.create({
        model: GROQ_MODEL,
        messages: groqMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          assistantText += delta;
          res.write(delta);
        }
      }

      // Save assistant reply + session title to MongoDB
      if (chatDoc) {
        chatDoc.messages.push({
          role: "assistant",
          content: assistantText,
          createdAt: new Date(),
        });
        if (!chatDoc.title) {
          const trimmed = message.trim();
          chatDoc.title = trimmed.length > 60 ? trimmed.slice(0, 57).trimEnd() + "..." : trimmed;
        }
        await chatDoc.save();
      }
    } catch (err) {
      res.write(`\n\n[Error] ${err?.message ?? String(err)}\n`);
    } finally {
      res.end();
    }
  }
);

export default router;