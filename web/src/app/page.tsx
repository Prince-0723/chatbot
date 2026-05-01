"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Loader2 ko import kiya gaya hai loading spinner ke liye
import { ArrowUp, PanelLeftClose, Trash2, X, Menu, Loader2, Divide } from "lucide-react";
import { GoogleLogin } from "@react-oauth/google";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ThemeToggle = dynamic(() => import("./ThemeToggle"), { ssr: false });

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string; createdAt?: string };

type SessionMeta = { id: string; updatedAt: string; title?: string; messageCount?: number };
type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  systemPrompt: string;
  title?: string;
  messages: ChatMessage[];
};

type AuthUser = { id: string; email: string; name: string; picture: string };
type AuthResponse = { token: string; user: AuthUser };

const STORAGE_TOKEN_KEY = "jwt";
const STORAGE_USER_KEY = "user";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export default function Home() {
  const backendBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_BACKEND_URL || "";
    return raw.replace(/\/+$/, "");
  }, []);

  const apiUrl = useCallback((path: string) => {
    if (backendBase) return `${backendBase}${path}`;
    return path;
  }, [backendBase]);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarDesktopOpen, setIsSidebarDesktopOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const isAuthed = Boolean(authToken && authUser);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system"),
    [messages]
  );

  const displaySessions = useMemo(() => {
    return sessions.filter(s => (s.title && s.title !== "New chat") || s.id === activeSessionId);
  }, [sessions, activeSessionId]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    function sync() {
      if (mq.matches) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarDesktopOpen(false);
      }
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  function scrollToBottom() {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    try {
      const token = localStorage.getItem(STORAGE_TOKEN_KEY);
      const userRaw = localStorage.getItem(STORAGE_USER_KEY);
      const user = userRaw ? (JSON.parse(userRaw) as AuthUser) : null;
      if (token && user?.email) {
        setAuthToken(token);
        setAuthUser(user);
      }
    } catch { }
  }, []);

  function logout() {
    try {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      localStorage.removeItem(STORAGE_USER_KEY);
    } catch { }
    setAuthToken(null);
    setAuthUser(null);
    setSessions([]);
    setActiveSessionId(null);
    setMessages([]);
    setError(null);
  }

  async function logoutWithLoading() {
    if (isAuthBusy) return;
    setIsAuthBusy(true);
    await new Promise((r) => setTimeout(r, 250));
    logout();
    setIsAuthBusy(false);
  }

  const refreshSessions = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride ?? authToken;
    if (!token) {
      setSessions([]);
      return [];
    }
    try {
      const data = await fetchJson<{ sessions: SessionMeta[] }>(apiUrl("/sessions"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSessions(data.sessions);
      return data.sessions;
    } catch (e) {
      console.error("Failed to refresh sessions", e);
      return [];
    }
  }, [apiUrl, authToken]);

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setError(null);
      setIsAuthBusy(true);
      try {
        const data = await fetchJson<AuthResponse>(apiUrl("/auth/google"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential }),
        });
        setAuthToken(data.token);
        setAuthUser(data.user);
        try {
          localStorage.setItem(STORAGE_TOKEN_KEY, data.token);
          localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(data.user));
        } catch { }
        await refreshSessions(data.token);
      } finally {
        setIsAuthBusy(false);
      }
    },
    [apiUrl, refreshSessions]
  );

  async function openSession(sessionId: string) {
    if (!isAuthed) return;
    if (sessionId === activeSessionId) return;
    setError(null);
    setActiveSessionId(sessionId);
    const data = await fetchJson<{ session: Session }>(apiUrl(`/sessions/${sessionId}`), {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    setMessages(data.session.messages);
    setIsSidebarOpen(false);
    queueMicrotask(scrollToBottom);
  }

  async function createSession(resetMessages = true): Promise<string | null> {
    if (!isAuthed) return null;
    if (resetMessages && messages.length === 0 && activeSessionId) {
      setIsSidebarOpen(false);
      return activeSessionId;
    }
    setError(null);
    try {
      const data = await fetchJson<{ sessionId: string }>(apiUrl("/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({}),
      });
      await refreshSessions();
      setActiveSessionId(data.sessionId);
      if (resetMessages) setMessages([]);
      setIsSidebarOpen(false);
      return data.sessionId;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function deleteSession(sessionId: string) {
    if (!isAuthed) return;
    if (isStreaming) return;
    if (!window.confirm("Delete this chat?")) return;
    setError(null);
    try {
      await fetchJson(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const nextSessions = await refreshSessions();
      if (activeSessionId === sessionId) {
        if (nextSessions.length > 0) {
          await openSession(nextSessions[0].id);
        } else {
          setActiveSessionId(null);
          setMessages([]);
          await createSession();
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clearHistory() {
    if (!isAuthed) return;
    if (isStreaming) return;
    if (!window.confirm("Clear all chat history? This will delete all chats.")) return;
    setError(null);
    try {
      await fetchJson(apiUrl("/sessions"), { method: "DELETE", headers: { Authorization: `Bearer ${authToken}` } });
      setMessages([]);
      setActiveSessionId(null);
      setSessions([]);
      await createSession();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!isSidebarDesktopOpen) setIsSidebarOpen(false);
  }, [isSidebarDesktopOpen]);

  useEffect(() => {
    if (!backendBase) {
      setError("Missing NEXT_PUBLIC_BACKEND_URL.");
      return;
    }

    if (!isAuthed) {
      setSessions([]);
      setActiveSessionId(null);
      return;
    }

    refreshSessions().catch((e) => setError(e.message));
  }, [backendBase, refreshSessions, isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    if (sessions.length > 0 && !activeSessionId) {
      openSession(sessions[0].id);
    } else if (sessions.length === 0 && !activeSessionId && backendBase) {
      createSession();
    }
  }, [sessions, activeSessionId, backendBase, isAuthed]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setError(null);
    setInput("");
    setIsStreaming(true);
    const userMsg: ChatMessage = { role: "user", content: text, createdAt: new Date().toISOString() };
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    queueMicrotask(scrollToBottom);
    try {
      const ensuredSessionId = isAuthed ? (activeSessionId || (await createSession(false))) : null;
      const res = await fetch(apiUrl("/chat"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(isAuthed && authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          ...(ensuredSessionId ? { sessionId: ensuredSessionId } : {}),
          message: text,
        }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Chat failed: ${res.status}`);
      }
      const sessionIdHeader = res.headers.get("x-session-id");
      if (sessionIdHeader && sessionIdHeader !== activeSessionId) {
        setActiveSessionId(sessionIdHeader);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, content: assistantText };
          }
          return next;
        });
        scrollToBottom();
      }
      if (isAuthed) await refreshSessions();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsStreaming(false);
      queueMicrotask(scrollToBottom);
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* SIDEBAR */}
      <aside
        className={[
          "z-50 border-r bg-white dark:bg-zinc-900",
          "border-zinc-200 dark:border-white/10",
          "fixed inset-y-0 left-0 w-72 sm:w-80 transition-transform duration-300 lg:static lg:translate-x-0",
          isSidebarDesktopOpen ? "lg:flex" : "lg:hidden",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full",
          "shadow-lg lg:shadow-none",
          "flex h-full flex-col overflow-hidden",
        ].join(" ")}
      >
        {/* --- Header Section Fix --- */}
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 h-14 border-b border-zinc-200 dark:border-white/10">

          {/* "Chats" text ko baseline center karne ke liye mt-0.5 add kiya hai */}
          <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5">
            Chats
          </div>

          <div className="flex items-center gap-1.5">
            {/* 'New' Button - Fixed height 'h-8' and flex items-center */}
            <button
              className="flex items-center justify-center rounded-md bg-zinc-900/5 px-3 h-8 text-sm font-medium hover:bg-zinc-900/10 dark:bg-white/10 dark:hover:bg-white/15 transition-colors"
              onClick={() => createSession()}
              disabled={!isAuthed || isStreaming}
            >
              New
            </button>

            {/* 'Clear' Button */}
            <button
              className="flex items-center justify-center rounded-md px-3 h-8 text-sm font-medium bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300 transition-colors"
              onClick={() => clearHistory()}
              disabled={!isAuthed || isStreaming || sessions.length === 0}
            >
              Clear
            </button>

            {/* Sidebar Toggle Icons - Icon buttons ko center karne ke liye p-1.5 */}
            <button
              className="lg:hidden p-1.5 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-md flex items-center justify-center text-zinc-500 transition-colors"
              onClick={() => setIsSidebarOpen(false)}
            >
              <PanelLeftClose size={18} />
            </button>

            <button
              type="button"
              className="hidden lg:flex p-1.5 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-md items-center justify-center text-zinc-500 transition-colors"
              onClick={() => setIsSidebarDesktopOpen(false)}
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
        </div>

        {/* <div className="px-4 pb-3 border-b border-zinc-200 dark:border-white/10"> */}
        {isAuthed && authUser ? (
          <div className="pt-3 pl-3 flex items-center gap-3">
            {authUser.picture ? (
              <img
                src={authUser.picture}
                alt={authUser.name || authUser.email}
                className="h-10 w-10 rounded-full border border-zinc-200 dark:border-white/10 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-10 w-10 rounded-full border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-white/10" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{authUser.name || "User"}</div>
              <div className="text-xs text-zinc-500 truncate">{authUser.email}</div>
            </div>
          </div>
        ) : null}
        {/* </div> */}
        {authUser && (
          <div className="px-4 pb-3 border-b border-zinc-200 dark:border-white/10"></div>
        )}

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {!isAuthed ? (
            <div className="px-2 py-3 text-sm text-zinc-500 dark:text-zinc-400">
              Chat history is available after login.
            </div>
          ) : displaySessions.length === 0 ? (
            <div className="px-2 py-3 text-sm text-zinc-500 dark:text-zinc-400">
              No history yet.
            </div>
          ) : (
            <ul className="space-y-1 pt-2">
              {displaySessions.map((s) => (
                <li key={s.id}>
                  <div className="flex items-stretch gap-1 group">
                    <button
                      className={[
                        "flex-1 rounded-md px-3 py-2 text-left text-sm truncate transition-colors",
                        s.id === activeSessionId ? "bg-zinc-900/10 dark:bg-white/10" : "hover:bg-zinc-900/5 dark:hover:bg-white/5",
                      ].join(" ")}
                      onClick={() => openSession(s.id)}
                      disabled={isStreaming}
                    >
                      <div className="truncate font-medium">{s.title || "New chat"}</div>
                      <div className="truncate text-xs text-zinc-500">
                        {new Date(s.updatedAt).toLocaleString()}
                      </div>
                    </button>
                    {(s.messageCount && s.messageCount > 0) || (s.title && s.title !== "New chat") ? (
                      <button
                        className="shrink-0 p-2 text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSession(s.id);
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-200 dark:border-white/10 p-4">
          {isAuthed ? (
            <button
              className="w-full rounded-md bg-zinc-900 text-white px-3 py-2 text-sm font-semibold hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
              onClick={logoutWithLoading}
              disabled={isStreaming || isAuthBusy}
            >
              <span className="inline-flex items-center justify-center gap-2">
                {isAuthBusy ? <Loader2 size={16} className="animate-spin" /> : null}
                <span>{isAuthBusy ? "Logging out..." : "Logout"}</span>
              </span>
            </button>
          ) : (
            <div className="w-full">
              <div
                className={[
                  "flex justify-center",
                  isAuthBusy ? "pointer-events-none opacity-60" : "",
                ].join(" ")}
              >
                <GoogleLogin
                  onSuccess={async (resp) => {
                    const credential = resp.credential;
                    if (!credential) {
                      setError("Google login failed: missing credential");
                      return;
                    }
                    try {
                      await handleGoogleCredential(credential);
                    } catch (e: unknown) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                  onError={() => setError("Google login failed")}
                />
              </div>
              {isAuthBusy ? (
                <div className="mt-2 flex items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Signing you in...</span>
                </div>
              ) : null}
              <div className="mt-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
                Login with Google to enable chat history.
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden relative">
        <header className="shrink-0 border-b border-zinc-200 px-4 py-4 dark:border-white/10 flex items-center justify-between bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm z-10">
          <div className="flex items-center gap-3">
            <button
              className={[
                "p-2 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-md",
                isSidebarDesktopOpen ? "lg:hidden" : "block"
              ].join(" ")}
              onClick={() => {
                setIsSidebarOpen(true);
                setIsSidebarDesktopOpen(true);
              }}
            >
              <Menu size={20} />
            </button>
            <div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold bg-gradient-to-r from-indigo-500 to-purple-500 bg-clip-text text-transparent">
                    MY AI
                  </span>
                  <span className="hidden sm:inline-block h-1 w-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                  <span className="hidden sm:inline-block text-[10px] font-medium text-zinc-500 uppercase tracking-widest">
                    v1.0
                  </span>
                </div>
                <div className="text-[10px] text-zinc-400 font-medium">
                  Developed by <span className="text-indigo-400">Prince Yaduvanshi</span>
                </div>
              </div>
            </div>
          </div>
          <ThemeToggle />
        </header>

        <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth">
          {visibleMessages.length === 0 ? (
            <div className="mx-auto mt-20 max-w-xl rounded-2xl border border-dashed border-zinc-300 p-12 text-center text-zinc-500 dark:border-zinc-800">
              {!isAuthed ? (
                <>
                  <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                    Welcome to AI Chat
                  </h2>
                  <p className="text-sm text-zinc-500">Ask me anything to get started.</p>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                    {greeting}, {authUser?.name || "there"}.
                  </h2>
                  <p className="text-sm text-zinc-500">
                    I&apos;m your AI assistant. Ask me anything and I&apos;ll help you out.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-8 pb-10">
              {visibleMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={[
                    "rounded-2xl px-5 py-4 text-sm transition-all shadow-sm",
                    m.role === "user"
                      ? "ml-auto max-w-[85%] bg-indigo-600 text-white"
                      : "mr-auto w-full border border-zinc-200 bg-white dark:bg-zinc-900 dark:border-zinc-800",
                  ].join(" ")}
                >
                  {/* Assistant Thinking / Loading State */}
                  {m.role === "assistant" && m.content === "" && isStreaming ? (
                    <div className="flex items-center gap-3 text-zinc-500 dark:text-zinc-400 py-2">
                      <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                      <span className="font-medium animate-pulse">Thinking...</span>
                    </div>
                  ) : (
                    <div className={`prose dark:prose-invert max-w-none 
                        ${m.role === 'user' ? 'prose-p:text-white' : ''}
                        prose-p:mb-4 prose-p:leading-7 
                        prose-headings:font-bold prose-headings:text-zinc-900 dark:prose-headings:text-white`}>

                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h3: ({ children }) => <h3 className="text-xl font-bold mt-6 mb-3">{children}</h3>,
                          ol: ({ children }) => <ol className="list-decimal pl-6 space-y-4 my-4 font-bold text-zinc-900 dark:text-zinc-50">{children}</ol>,
                          ul: ({ children }) => <ul className="list-disc pl-6 space-y-2 my-4 font-normal text-zinc-700 dark:text-zinc-300">{children}</ul>,
                          p: ({ children }) => <p className="mb-4 leading-relaxed tracking-wide last:mb-0">{children}</p>,
                          li: ({ children }) => <li className="pl-1 font-normal text-zinc-800 dark:text-zinc-200">{children}</li>,
                          strong: ({ children }) => <strong className="font-bold text-zinc-950 dark:text-white">{children}</strong>
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* FOOTER */}
        <footer className="shrink-0 p-4 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md border-t border-zinc-200 dark:border-white/10">
          <div className="mx-auto max-w-3xl relative flex items-end gap-2">
            <textarea
              className="flex-1 resize-none rounded-2xl border border-zinc-300 bg-white p-4 pr-12 text-sm outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-zinc-900 dark:border-zinc-800 transition-all shadow-inner min-h-[56px] max-h-48"
              placeholder="Ask anything..."
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
            <button
              className="absolute right-2 bottom-2 bg-indigo-600 text-white p-2.5 rounded-xl hover:bg-indigo-700 disabled:opacity-30 disabled:hover:bg-indigo-600 transition-all shadow-md"
              onClick={() => sendMessage()}
              disabled={!input.trim() || isStreaming}
            >
              {isStreaming ? <Loader2 size={20} className="animate-spin" /> : <ArrowUp size={20} />}
            </button>
          </div>
          {error && <p className="text-red-500 text-xs mt-3 text-center font-medium animate-bounce">{error}</p>}
          <p className="text-[10px] text-zinc-400 text-center mt-3">AI can make mistakes. Verify important info.</p>
        </footer>
      </main>
    </div>
  );
}
