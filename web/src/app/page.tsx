"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  PanelLeftClose,
  Trash2,
  Menu,
  Loader2,
  Paperclip,
  X,
  FileText,
  Copy,
  Check,
  Plus,
  MessageSquare,
} from "lucide-react";
import { GoogleLogin } from "@react-oauth/google";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ThemeToggle = dynamic(() => import("./ThemeToggle"), { ssr: false });

// ── Types ────────────────────────────────────────────────────────────────────
type ChatRole = "system" | "user" | "assistant";

type AttachmentMeta = {
  fileId: string;
  filename: string;
  mimetype: string;
  size: number;
  previewUrl?: string;
};

type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt?: string;
  attachments?: AttachmentMeta[];
  ragSources?: string[];
};

type PendingAttachment = {
  tempId: string;
  file: File;
  previewUrl?: string;
  status: "pending" | "uploading" | "ready" | "error";
  fileId?: string;
  error?: string;
};

type SessionMeta = { id: string; updatedAt: string; title?: string };
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mimetype: string) {
  return mimetype.startsWith("image/");
}

// ── Copy Button ───────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors py-1 px-2 rounded-md hover:bg-zinc-100 dark:hover:bg-white/10"
      title="Copy response"
    >
      {copied ? (
        <>
          <Check size={12} className="text-emerald-500" />
          <span className="text-emerald-500">Copied</span>
        </>
      ) : (
        <>
          <Copy size={12} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

// ── Attachment Card in message ────────────────────────────────────────────────
function AttachmentCard({ attachment }: { attachment: AttachmentMeta }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (isImage(attachment.mimetype) && attachment.previewUrl) {
    return (
      <>
        <button
          onClick={() => setLightboxOpen(true)}
          className="block rounded-xl overflow-hidden border border-white/20 hover:opacity-90 transition-opacity"
          style={{ maxWidth: 220 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachment.previewUrl}
            alt={attachment.filename}
            className="w-full object-cover"
            style={{ maxHeight: 160 }}
          />
          <div className="px-3 py-1.5 text-[11px] text-white/70 bg-black/20 text-left truncate">
            {attachment.filename}
          </div>
        </button>
        {lightboxOpen && (
          <div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => setLightboxOpen(false)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={attachment.previewUrl}
              alt={attachment.filename}
              className="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="absolute top-4 right-4 text-white/70 hover:text-white"
              onClick={() => setLightboxOpen(false)}
            >
              <X size={28} />
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2.5 bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2.5 border border-white/20 w-fit max-w-[260px]">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
        <FileText size={16} className="text-white/90" />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-white truncate">{attachment.filename}</div>
        <div className="text-[10px] text-white/60">{formatBytes(attachment.size)}</div>
      </div>
    </div>
  );
}

// ── Pending Attachment Preview Card ──────────────────────────────────────────
function PendingCard({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const showThumb = isImage(attachment.file.type) && attachment.previewUrl;

  return (
    <div className="relative group flex items-center gap-2.5 bg-zinc-100 dark:bg-zinc-800 rounded-xl px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 w-fit max-w-[220px] shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {showThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="w-10 h-10 rounded-lg object-cover shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center shrink-0">
          <FileText size={18} className="text-indigo-500" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
          {attachment.file.name}
        </div>
        <div className="text-[10px] text-zinc-500 mt-0.5">
          {attachment.status === "uploading" ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Processing…
            </span>
          ) : attachment.status === "error" ? (
            <span className="text-red-500">{attachment.error || "Failed"}</span>
          ) : attachment.status === "ready" ? (
            <span className="text-emerald-500 flex items-center gap-1">
              <Check size={10} />
              Ready
            </span>
          ) : (
            formatBytes(attachment.file.size)
          )}
        </div>
      </div>
      {attachment.status !== "uploading" && (
        <button
          onClick={onRemove}
          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-zinc-400 dark:bg-zinc-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 z-10"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function Home() {
  const backendBase = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_BACKEND_URL || "";
    return raw.replace(/\/+$/, "");
  }, []);

  const apiUrl = useCallback(
    (path: string) => (backendBase ? `${backendBase}${path}` : path),
    [backendBase]
  );

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const isAuthed = Boolean(authToken && authUser);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarDesktopOpen, setIsSidebarDesktopOpen] = useState(false);

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tracks all file IDs uploaded in the current session for persistent RAG context
  const sessionFileIds = useRef<string[]>([]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const displaySessions = useMemo(
    () =>
      sessions.filter(
        (s) => (s.title && s.title !== "New chat") || s.id === activeSessionId
      ),
    [sessions, activeSessionId]
  );

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    function sync() {
      if (mq.matches) setIsSidebarOpen(false);
      else setIsSidebarDesktopOpen(false);
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!isSidebarDesktopOpen) setIsSidebarOpen(false);
  }, [isSidebarDesktopOpen]);

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
    } catch {}
  }, []);

  function logout() {
    try {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      localStorage.removeItem(STORAGE_USER_KEY);
    } catch {}
    setAuthToken(null);
    setAuthUser(null);
    setSessions([]);
    setActiveSessionId(null);
    setMessages([]);
    setError(null);
    setPendingAttachments([]);
    sessionFileIds.current = [];
  }

  async function logoutWithLoading() {
    if (isAuthBusy) return;
    setIsAuthBusy(true);
    await new Promise((r) => setTimeout(r, 250));
    logout();
    setIsAuthBusy(false);
  }

  const refreshSessions = useCallback(
    async (tokenOverride?: string) => {
      const token = tokenOverride ?? authToken;
      if (!token) { setSessions([]); return []; }
      try {
        const data = await fetchJson<{ sessions: SessionMeta[] }>(
          apiUrl("/sessions"),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setSessions(data.sessions);
        return data.sessions;
      } catch {
        return [];
      }
    },
    [apiUrl, authToken]
  );

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
        } catch {}
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
    sessionFileIds.current = [];
    const data = await fetchJson<{ session: Session }>(
      apiUrl(`/sessions/${sessionId}`),
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({}),
      });
      await refreshSessions();
      setActiveSessionId(data.sessionId);
      sessionFileIds.current = [];
      if (resetMessages) setMessages([]);
      setIsSidebarOpen(false);
      return data.sessionId;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function deleteSession(sessionId: string) {
    if (!isAuthed || isStreaming) return;
    if (!window.confirm("Delete this chat?")) return;
    setError(null);
    try {
      await fetchJson(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const nextSessions = await refreshSessions();
      if (activeSessionId === sessionId) {
        if (nextSessions.length > 0) await openSession(nextSessions[0].id);
        else {
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
    if (!isAuthed || isStreaming) return;
    if (!window.confirm("Clear all chat history?")) return;
    setError(null);
    try {
      await fetchJson(apiUrl("/sessions"), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setMessages([]);
      setActiveSessionId(null);
      setSessions([]);
      await createSession();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!backendBase) { setError("Missing NEXT_PUBLIC_BACKEND_URL."); return; }
    if (!isAuthed) { setSessions([]); setActiveSessionId(null); return; }
    refreshSessions().catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendBase, isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    if (sessions.length > 0 && !activeSessionId) {
      openSession(sessions[0].id);
    } else if (sessions.length === 0 && !activeSessionId && backendBase) {
      createSession();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeSessionId, backendBase, isAuthed]);

  // ── File upload ───────────────────────────────────────────────────────────
  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !isAuthed) return;

    const newPending: PendingAttachment[] = Array.from(fileList).map((file) => ({
      tempId: `temp-${Date.now()}-${Math.random()}`,
      file,
      previewUrl: isImage(file.type) ? URL.createObjectURL(file) : undefined,
      status: "uploading" as const,
    }));

    setPendingAttachments((prev) => [...prev, ...newPending]);

    for (const pending of newPending) {
      try {
        const formData = new FormData();
        formData.append("file", pending.file);

        const res = await fetch(apiUrl("/rag/upload"), {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.tempId === pending.tempId
                ? { ...p, status: "error", error: err.error }
                : p
            )
          );
          continue;
        }

        const data = await res.json();
        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.tempId === pending.tempId
              ? { ...p, status: "ready", fileId: data.fileId }
              : p
          )
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.tempId === pending.tempId
              ? {
                  ...p,
                  status: "error",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : p
          )
        );
      }
    }
  }

  function removePending(tempId: string) {
    setPendingAttachments((prev) => {
      const found = prev.find((p) => p.tempId === tempId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((p) => p.tempId !== tempId);
    });
  }

  // ── Send message ──────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = input.trim();
    const readyAttachments = pendingAttachments.filter((p) => p.status === "ready");
    if ((!text && readyAttachments.length === 0) || isStreaming) return;

    setError(null);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const attachmentMetas: AttachmentMeta[] = readyAttachments.map((p) => ({
      fileId: p.fileId!,
      filename: p.file.name,
      mimetype: p.file.type,
      size: p.file.size,
      previewUrl: p.previewUrl,
    }));

    const newFileIds = readyAttachments.map((p) => p.fileId!);
    sessionFileIds.current = [...sessionFileIds.current, ...newFileIds];

    setPendingAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";

    setIsStreaming(true);

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      attachments: attachmentMetas.length > 0 ? attachmentMetas : undefined,
    };
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    queueMicrotask(scrollToBottom);

    try {
      const hasFileContext = sessionFileIds.current.length > 0;
      const endpoint = hasFileContext && isAuthed ? "/rag/chat" : "/chat";

      const ensuredSessionId =
        !hasFileContext && isAuthed
          ? activeSessionId || (await createSession(false))
          : null;

      const body: Record<string, unknown> = {
        message: text || "Please analyze and describe the attached file(s).",
      };
      if (ensuredSessionId) body.sessionId = ensuredSessionId;
      if (hasFileContext) {
        body.useRag = true;
        body.fileIds = sessionFileIds.current;
      }

      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(isAuthed && authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(t || `Chat failed: ${res.status}`);
      }

      const sourcesHeader = res.headers.get("x-rag-sources");
      let ragSources: string[] = [];
      if (sourcesHeader) {
        try { ragSources = JSON.parse(sourcesHeader); } catch {}
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
            next[next.length - 1] = { ...last, content: assistantText, ragSources };
          }
          return next;
        });
        scrollToBottom();
      }

      if (isAuthed && !hasFileContext) await refreshSessions();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsStreaming(false);
      queueMicrotask(scrollToBottom);
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  }

  const canSend =
    (input.trim().length > 0 || pendingAttachments.some((p) => p.status === "ready")) &&
    !isStreaming &&
    !pendingAttachments.some((p) => p.status === "uploading");

  const fileContextCount = sessionFileIds.current.length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#f8f7f4] text-zinc-900 dark:bg-[#111110] dark:text-zinc-100">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <aside
        className={[
          "z-50 flex h-full flex-col overflow-hidden",
          "bg-white dark:bg-[#1a1a19]",
          "border-r border-zinc-200 dark:border-white/[0.08]",
          "fixed inset-y-0 left-0 w-72 transition-transform duration-300",
          "lg:static lg:translate-x-0",
          isSidebarDesktopOpen ? "lg:flex" : "lg:hidden",
          isSidebarOpen ? "translate-x-0" : "-translate-x-full",
          "shadow-xl lg:shadow-none",
        ].join(" ")}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 h-14 border-b border-zinc-100 dark:border-white/[0.08]">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Conversations</span>
          <div className="flex items-center gap-1">
            <button
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 px-3 h-8 text-xs font-semibold hover:bg-zinc-700 dark:hover:bg-zinc-100 transition-colors disabled:opacity-40"
              onClick={() => createSession()}
              disabled={!isAuthed || isStreaming}
            >
              <Plus size={13} />
              New
            </button>
            <button
              className="lg:hidden p-1.5 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-lg text-zinc-500 transition-colors"
              onClick={() => setIsSidebarOpen(false)}
            >
              <PanelLeftClose size={17} />
            </button>
            <button
              className="hidden lg:flex p-1.5 hover:bg-zinc-100 dark:hover:bg-white/10 rounded-lg text-zinc-500 transition-colors"
              onClick={() => setIsSidebarDesktopOpen(false)}
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
        </div>

        {isAuthed && authUser && (
          <div className="px-4 pt-3 pb-3 flex items-center gap-3 border-b border-zinc-100 dark:border-white/[0.08]">
            {authUser.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={authUser.picture}
                alt={authUser.name}
                className="h-9 w-9 rounded-full border border-zinc-200 dark:border-white/15 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-zinc-200 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-zinc-600 dark:text-zinc-300">
                {(authUser.name || authUser.email)[0]?.toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{authUser.name || "User"}</div>
              <div className="text-[11px] text-zinc-400 truncate">{authUser.email}</div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {!isAuthed ? (
            <div className="px-3 py-8 text-sm text-zinc-400 dark:text-zinc-500 text-center">
              <MessageSquare size={32} className="mx-auto mb-2 opacity-30" />
              Sign in to save your chats
            </div>
          ) : displaySessions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-zinc-400 text-center">No conversations yet.</div>
          ) : (
            <ul className="space-y-0.5">
              {displaySessions.map((s) => (
                <li key={s.id}>
                  <div className="flex items-center gap-1 group">
                    <button
                      className={[
                        "flex-1 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                        s.id === activeSessionId
                          ? "bg-zinc-100 dark:bg-white/10 text-zinc-900 dark:text-white"
                          : "hover:bg-zinc-50 dark:hover:bg-white/5 text-zinc-700 dark:text-zinc-300",
                      ].join(" ")}
                      onClick={() => openSession(s.id)}
                      disabled={isStreaming}
                    >
                      <div className="truncate font-medium text-[13px]">{s.title || "New chat"}</div>
                      <div className="truncate text-[11px] text-zinc-400 mt-0.5">
                        {new Date(s.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      className="shrink-0 p-1.5 text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                      onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-100 dark:border-white/[0.08] p-4 space-y-2">
          {sessions.length > 0 && isAuthed && (
            <button
              className="w-full rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              onClick={clearHistory}
              disabled={isStreaming}
            >
              Clear all history
            </button>
          )}
          {isAuthed ? (
            <button
              className="w-full rounded-lg bg-zinc-900 text-white px-3 py-2.5 text-sm font-semibold hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100 transition-colors disabled:opacity-50"
              onClick={logoutWithLoading}
              disabled={isStreaming || isAuthBusy}
            >
              <span className="inline-flex items-center justify-center gap-2">
                {isAuthBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                {isAuthBusy ? "Signing out…" : "Sign out"}
              </span>
            </button>
          ) : (
            <div className="space-y-2">
              <div className={["flex justify-center", isAuthBusy ? "pointer-events-none opacity-60" : ""].join(" ")}>
                <GoogleLogin
                  onSuccess={async (resp) => {
                    if (!resp.credential) { setError("Google login failed"); return; }
                    try { await handleGoogleCredential(resp.credential); }
                    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
                  }}
                  onError={() => setError("Google login failed")}
                />
              </div>
              {isAuthBusy && (
                <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                  <Loader2 size={13} className="animate-spin" />
                  Signing in…
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN ──────────────────────────────────────────────────────────── */}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="shrink-0 flex items-center justify-between px-4 h-14 border-b border-zinc-200 dark:border-white/[0.08] bg-white/80 dark:bg-[#111110]/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <button
              className={[
                "p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors text-zinc-600 dark:text-zinc-400",
                isSidebarDesktopOpen ? "lg:hidden" : "block",
              ].join(" ")}
              onClick={() => { setIsSidebarOpen(true); setIsSidebarDesktopOpen(true); }}
            >
              <Menu size={20} />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500 bg-clip-text text-transparent">
                  MY AI
                </span>
                <span className="hidden sm:inline text-[10px] font-medium text-zinc-400 uppercase tracking-widest">v1.0</span>
              </div>
              <div className="text-[10px] text-zinc-400">
                by <span className="text-indigo-400 font-medium">Prince Yaduvanshi</span>
              </div>
            </div>
          </div>
          <ThemeToggle />
        </header>

        {/* Messages */}
        <div ref={scrollerRef} className="flex-1 overflow-y-auto scroll-smooth">
          {visibleMessages.length === 0 ? (
            <div className="flex items-center justify-center h-full px-6">
              <div className="max-w-lg w-full text-center space-y-5">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 mx-auto flex items-center justify-center shadow-lg shadow-indigo-500/20">
                  <MessageSquare size={28} className="text-white" />
                </div>
                {!isAuthed ? (
                  <>
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Welcome to AI Chat</h2>
                    <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed">
                      Ask me anything to get started.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                      {greeting}, {authUser?.name?.split(" ")[0] || "there"}.
                    </h2>
                    <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed">
                      Ask anything, or attach a file — I can read PDFs, Word docs, images, and more.
                    </p>
                  </>
                )}
                <div className="flex flex-wrap gap-2 justify-center">
                  {["Explain a concept", "Summarize a document", "Write something", "Answer my questions"].map((s) => (
                    <button
                      key={s}
                      className="text-xs px-3.5 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-white dark:hover:bg-white/5 hover:border-zinc-300 transition-all"
                      onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6 pb-10">
              {visibleMessages.map((m, idx) => (
                <div key={idx} className={["flex", m.role === "user" ? "justify-end" : "justify-start"].join(" ")}>
                  <div className={[
                    m.role === "user" ? "flex flex-col items-end gap-2 max-w-[85%]" : "flex flex-col items-start gap-1.5 w-full",
                  ].join(" ")}>
                    {/* Attachments above message */}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 justify-end">
                        {m.attachments.map((att, i) => (
                          <AttachmentCard key={i} attachment={att} />
                        ))}
                      </div>
                    )}

                    {/* Message bubble */}
                    {(m.content || m.role === "assistant") && (
                      <div className={[
                        "rounded-2xl px-4 py-3 text-sm",
                        m.role === "user"
                          ? "bg-indigo-600 text-white rounded-br-sm"
                          : "bg-white dark:bg-[#1e1e1d] border border-zinc-200 dark:border-white/[0.07] text-zinc-900 dark:text-zinc-100 rounded-bl-sm w-full shadow-sm",
                      ].join(" ")}>
                        {m.role === "assistant" && m.content === "" && isStreaming ? (
                          <div className="flex items-center gap-3 py-1">
                            <div className="flex gap-1">
                              {[0, 150, 300].map((delay) => (
                                <span
                                  key={delay}
                                  className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"
                                  style={{ animationDelay: `${delay}ms` }}
                                />
                              ))}
                            </div>
                            <span className="text-xs text-zinc-400">Thinking…</span>
                          </div>
                        ) : (
                          <div className={`prose dark:prose-invert max-w-none text-sm leading-relaxed
                            ${m.role === "user" ? "prose-p:text-white prose-headings:text-white prose-strong:text-white prose-li:text-white" : ""}
                            prose-p:mb-3 prose-p:last:mb-0 prose-headings:font-semibold prose-headings:mb-2
                            prose-code:text-xs prose-pre:rounded-xl prose-pre:bg-zinc-50 dark:prose-pre:bg-zinc-900/60
                            prose-pre:border prose-pre:border-zinc-200 dark:prose-pre:border-zinc-700/50
                          `}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {m.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Copy + sources row for assistant */}
                    {m.role === "assistant" && m.content && !isStreaming && (
                      <div className="flex items-center gap-2 flex-wrap pl-1">
                        <CopyButton text={m.content} />
                        {m.ragSources && m.ragSources.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-zinc-400">Sources:</span>
                            {m.ragSources.map((src, i) => (
                              <span
                                key={i}
                                className="text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-100 dark:border-indigo-800/40"
                              >
                                {src}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── FOOTER ────────────────────────────────────────────────────────── */}
        <footer className="shrink-0 bg-white/90 dark:bg-[#111110]/90 backdrop-blur-md border-t border-zinc-200 dark:border-white/[0.08] px-4 pt-3 pb-4">
          <div className="max-w-3xl mx-auto space-y-2">

            {/* Pending attachments */}
            {pendingAttachments.length > 0 && (
              <div className="flex gap-2 flex-wrap px-1 pb-1">
                {pendingAttachments.map((p) => (
                  <PendingCard
                    key={p.tempId}
                    attachment={p}
                    onRemove={() => removePending(p.tempId)}
                  />
                ))}
              </div>
            )}

            {/* Input box */}
            <div className="relative flex items-end gap-2 rounded-2xl border border-zinc-300 dark:border-zinc-700/80 bg-white dark:bg-[#1e1e1d] shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/30 focus-within:border-indigo-400 dark:focus-within:border-indigo-500/60 transition-all px-3 py-2">
              {isAuthed && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                  className="shrink-0 mb-1 p-1.5 rounded-lg text-zinc-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all disabled:opacity-30"
                  title="Attach a file (PDF, image, DOCX, TXT)"
                >
                  <Paperclip size={18} />
                </button>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.gif"
                multiple
                className="hidden"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />

              <textarea
                ref={textareaRef}
                className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500 min-h-[36px] max-h-40 py-1.5 leading-relaxed"
                placeholder={
                  !isAuthed
                    ? "Ask anything…"
                    : pendingAttachments.length > 0
                    ? "Ask about your file, or just send to analyze it…"
                    : "Ask anything or attach a file…"
                }
                rows={1}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />

              <button
                className={[
                  "shrink-0 mb-1 w-9 h-9 rounded-xl flex items-center justify-center transition-all",
                  canSend
                    ? "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm shadow-indigo-600/20"
                    : "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed",
                ].join(" ")}
                onClick={sendMessage}
                disabled={!canSend}
              >
                {isStreaming ? (
                  <Loader2 size={17} className="animate-spin" />
                ) : (
                  <ArrowUp size={17} />
                )}
              </button>
            </div>

            {error && (
              <p className="text-red-500 text-xs text-center animate-pulse">{error}</p>
            )}

            <p className="text-[10px] text-zinc-400 text-center">
              AI can make mistakes. Verify important information.
              {fileContextCount > 0 && (
                <span className="ml-1.5 text-indigo-400">
                  · {fileContextCount} file{fileContextCount > 1 ? "s" : ""} in context
                </span>
              )}
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}