import mongoose from "mongoose";

const RagFileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    filename: { type: String, required: true },
    mimetype: { type: String, required: true },
    size: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["processing", "ready", "error"],
      default: "processing",
    },
    chunkCount: { type: Number, default: 0 },
    extractedText: { type: String, default: "" }, // preview (first 500 chars)
    error: { type: String, default: "" },
    // ── NEW: permanent Cloudinary URL for file preview/download ──────────────
    cloudinaryUrl: { type: String, default: "" },
    cloudinaryPublicId: { type: String, default: "" },
  },
  { timestamps: true }
);

RagFileSchema.index({ userId: 1, createdAt: -1 });

export const RagFile =
  mongoose.models.RagFile || mongoose.model("RagFile", RagFileSchema);
