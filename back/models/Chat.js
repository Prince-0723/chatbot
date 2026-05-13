import mongoose from "mongoose";

// Attachment metadata saved inside each user message
const AttachmentSchema = new mongoose.Schema(
  {
    fileId: { type: String, required: true },
    filename: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, default: 0 },
    // ── Permanent Cloudinary URL so old chats can still show the file ────────
    cloudinaryUrl: { type: String, default: "" },
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ["system", "user", "assistant"],
    },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    // Attachments only on user messages
    attachments: { type: [AttachmentSchema], default: undefined },
    // RAG source filenames shown below assistant messages
    ragSources: { type: [String], default: undefined },
  },
  { _id: false }
);

const ChatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    model: { type: String, required: true },
    systemPrompt: { type: String, required: true },
    title: { type: String, default: "" },
    messages: { type: [MessageSchema], default: [] },
  },
  { timestamps: true }
);

ChatSchema.index({ userId: 1, updatedAt: -1 });

export const Chat = mongoose.models.Chat || mongoose.model("Chat", ChatSchema);
