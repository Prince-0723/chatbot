import { NextResponse } from "next/server";
import { clearSessions, createNewSession, listSessions, saveSession } from "@/lib/chatStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "llama-3.1-8b-instant";
const DEFAULT_SYSTEM = "You are a helpful assistant.";

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    systemPrompt?: string;
  };

  const session = createNewSession({
    model: body.model || DEFAULT_MODEL,
    systemPrompt: body.systemPrompt || DEFAULT_SYSTEM,
  });
  await saveSession(session);

  return NextResponse.json({ sessionId: session.id });
}

export async function DELETE() {
  try {
    const result = await clearSessions();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
