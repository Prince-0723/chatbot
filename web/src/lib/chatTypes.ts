export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt?: string;
};

export type ChatSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  systemPrompt: string;
  title?: string;
  messages: ChatMessage[];
};

