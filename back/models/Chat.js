import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ["system", "user", "assistant"],
    },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
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

