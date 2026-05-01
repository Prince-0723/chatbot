import { NextResponse } from "next/server";
import { groq } from "@/lib/groqClient";
import type { ChatMessage } from "@/lib/chatTypes";
import { createNewSession, loadSession, saveSession } from "@/lib/chatStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "llama-3.1-8b-instant";
const DEFAULT_SYSTEM = "You are a helpful assistant.";

type ChatRequest = {
  sessionId?: string;
  message: string;
  model?: string;
  systemPrompt?: string;
};

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const session = body.sessionId
    ? await loadSession(body.sessionId)
    : createNewSession({
        model: body.model || DEFAULT_MODEL,
        systemPrompt: body.systemPrompt || DEFAULT_SYSTEM,
      });

  if (body.model) session.model = body.model;

  if (body.systemPrompt && body.systemPrompt !== session.systemPrompt) {
    session.systemPrompt = body.systemPrompt;
    const now = new Date().toISOString();
    session.messages = [{ role: "system", content: session.systemPrompt, createdAt: now }];
  }

  const now = new Date().toISOString();
  const userMsg: ChatMessage = { role: "user", content: message, createdAt: now };
  session.messages.push(userMsg);

  await saveSession(session);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = "";
      try {
        const groqStream = await groq.chat.completions.create({
          model: session.model || DEFAULT_MODEL,
          messages: session.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
        });

        for await (const chunk of groqStream) {
          const delta = chunk?.choices?.[0]?.delta?.content ?? "";
          if (!delta) continue;
          assistantText += delta;
          controller.enqueue(encoder.encode(delta));
        }

        const ts = new Date().toISOString();
        session.messages.push({
          role: "assistant",
          content: assistantText,
          createdAt: ts,
        });

        if (!session.title) {
          session.title =
            message.length > 60 ? message.slice(0, 57).trimEnd() + "..." : message;
        }

        await saveSession(session);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`\n\n[Error] ${msg}\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-session-id": session.id,
    },
  });
}
