"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowDown,
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
  ExternalLink,
  MoreVertical,
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
  cloudinaryUrl?: string;
  previewUrl?: string;
};

type PendingAttachment = {
  tempId: string;
  file: File;
  previewUrl?: string;
  status: "pending" | "uploading" | "ready" | "error";
  fileId?: string;
  cloudinaryUrl?: string;
  error?: string;
};

type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt?: string;
  attachments?: AttachmentMeta[];
  ragSources?: string[];
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

// ── Strip markdown for plain-text copy ───────────────────────────────────────
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, (m) =>
      m.replace(/```[\w]*\n?/g, "").replace(/```/g, "")
    )
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m)
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/!\[.*?\]\(.+?\)/g, "")
    .replace(/^>\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Copy Button ───────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(stripMarkdown(text));
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

// ── RAG Source Badge — clickable, opens original document ────────────────────
// FIX 3: Sources are now clickable with pointer cursor and open the original doc
// ── Profile three-dot menu ────────────────────────────────────────────────────
function ProfileMenu({ onDeleteAccount }: { onDeleteAccount: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors"
        title="More options"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900 shadow-lg shadow-black/10 py-1 animate-in fade-in slide-in-from-top-2 duration-150">
          <button
            onClick={() => { setOpen(false); onDeleteAccount(); }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors rounded-lg mx-auto"
          >
            <Trash2 size={14} />
            Delete account
          </button>
        </div>
      )}
    </div>
  );
}

function RagSourceBadge({
  src,
  ragFiles,
}: {
  src: string;
  ragFiles: Array<{ id: string; filename: string; cloudinaryUrl?: string; mimetype?: string }>;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const match = ragFiles.find((f) => f.filename === src);
  const url = match?.cloudinaryUrl || null;
  const mimetype = match?.mimetype || "";
  const isImg = mimetype.startsWith("image/");

  const badgeBase =
    "inline-flex items-center gap-1 text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-100 dark:border-indigo-800/40 cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-800/50 hover:border-indigo-300 transition-colors";

  if (url) {
    // Images: badge click → lightbox (same behaviour as AttachmentCard)
    if (isImg) {
      return (
        <>
          <button
            onClick={() => setLightboxOpen(true)}
            title={`Preview ${src}`}
            className={badgeBase}
          >
            {src}
            <ExternalLink size={9} className="shrink-0 opacity-70" />
          </button>

          {lightboxOpen && (
            <div
              className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
              onClick={() => setLightboxOpen(false)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={src}
                className="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                className="absolute top-4 right-4 text-white/70 hover:text-white"
                onClick={() => setLightboxOpen(false)}
                title="Close"
              >
                <X size={28} />
              </button>
            </div>
          )}
        </>
      );
    }

    // TXT: open in new tab (plain text renders fine in browser)
    if (mimetype === "text/plain") {
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`View ${src}`}
          className={badgeBase}
        >
          {src}
          <ExternalLink size={9} className="shrink-0 opacity-70" />
        </a>
      );
    }

    // PDF / DOCX: force download (open-in-tab broken in prod)
    return (
      <a
        href={url}
        download={src}
        title={`Download ${src}`}
        className={badgeBase}
      >
        {src}
        <ArrowDown size={9} className="shrink-0 opacity-70" />
      </a>
    );
  }

  // No URL — static badge
  return (
    <span
      title={src}
      className="inline-flex items-center gap-1 text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-100 dark:border-indigo-800/40 cursor-default"
    >
      {src}
    </span>
  );
}

// ── Attachment Card shown inside chat messages ────────────────────────────────
function AttachmentCard({ attachment }: { attachment: AttachmentMeta }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const viewUrl = attachment.cloudinaryUrl || attachment.previewUrl || "";
  const canOpen = Boolean(viewUrl);
  const isPdf = attachment.mimetype === "application/pdf";
  const isTxt = attachment.mimetype === "text/plain";

  // ── Images: thumbnail → lightbox preview (no download, just view) ──────────
  if (isImage(attachment.mimetype) && viewUrl) {
    return (
      <>
        <button
          onClick={() => setLightboxOpen(true)}
          className="block rounded-xl overflow-hidden border border-white/20 hover:opacity-90 transition-opacity cursor-zoom-in"
          style={{ maxWidth: 220 }}
          title="Click to preview image"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={viewUrl}
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
              src={viewUrl}
              alt={attachment.filename}
              className="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="absolute top-4 right-4 text-white/70 hover:text-white"
              onClick={() => setLightboxOpen(false)}
              title="Close"
            >
              <X size={28} />
            </button>
          </div>
        )}
      </>
    );
  }

  // ── TXT: open/view in new tab (plain text renders fine in all browsers/prod) ─
  if (isTxt && canOpen) {
    return (
      <a
        href={viewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2.5 bg-zinc-700/80 dark:bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2.5 border border-zinc-600/40 dark:border-white/20 w-fit max-w-[260px] hover:bg-zinc-600/80 dark:hover:bg-white/20 transition-colors cursor-pointer no-underline"
        title="View file"
      >
        <div className="shrink-0 w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
          <FileText size={16} className="text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-xs font-medium text-white truncate">{attachment.filename}</div>
          <div className="text-[10px] text-white/60">{formatBytes(attachment.size)} · View</div>
        </div>
        <ExternalLink size={13} className="shrink-0 text-white/50" />
      </a>
    );
  }

  // ── PDF / DOCX: direct download (open-in-tab broken in prod for these types) ─
  if (canOpen) {
    const accentClass = isPdf ? "bg-red-500/20" : "bg-indigo-500/20";
    const iconClass   = isPdf ? "text-red-300"  : "text-indigo-300";
    return (
      <a
        href={viewUrl}
        download={attachment.filename}
        className="flex items-center gap-2.5 bg-zinc-700/80 dark:bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2.5 border border-zinc-600/40 dark:border-white/20 w-fit max-w-[260px] hover:bg-zinc-600/80 dark:hover:bg-white/20 transition-colors cursor-pointer no-underline"
        title="Download file"
      >
        <div className={`shrink-0 w-8 h-8 rounded-lg ${accentClass} flex items-center justify-center`}>
          <FileText size={16} className={iconClass} />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="text-xs font-medium text-white truncate">{attachment.filename}</div>
          <div className="text-[10px] text-white/60">{formatBytes(attachment.size)} · Download</div>
        </div>
        <ArrowDown size={13} className="shrink-0 text-white/50" />
      </a>
    );
  }

  // ── Fallback: no URL available ─────────────────────────────────────────────
  return (
    <div className="flex items-center gap-2.5 bg-zinc-700/80 dark:bg-white/15 backdrop-blur-sm rounded-xl px-3 py-2.5 border border-zinc-600/40 dark:border-white/20 w-fit max-w-[260px]">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-zinc-600/50 dark:bg-white/20 flex items-center justify-center">
        <FileText size={16} className="text-white/90" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-white truncate">{attachment.filename}</div>
        <div className="text-[10px] text-white/60">{formatBytes(attachment.size)}</div>
      </div>
    </div>
  );
}

// ── Pending Attachment Preview Card ───────────────────────────────────────────
function PendingCard({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
}) {
  const showThumb = isImage(attachment.file.type) && attachment.previewUrl;

  // FIX 4: bg-zinc-200/border-zinc-300 in light mode so card is clearly visible against white footer
  return (
    <div className="relative group flex items-center gap-2.5 bg-zinc-200 dark:bg-zinc-800 rounded-xl px-3 py-2.5 border border-zinc-300 dark:border-zinc-700 w-fit max-w-[220px] shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {showThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="w-10 h-10 rounded-lg object-cover shrink-0 border border-zinc-200 dark:border-zinc-600"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center shrink-0 border border-indigo-200 dark:border-indigo-800/40">
          <FileText size={18} className="text-indigo-500" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate" title={attachment.file.name}>
          {attachment.file.name}
        </div>
        <div className="text-[10px] text-zinc-500 mt-0.5">
          {attachment.status === "uploading" ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Uploading…
            </span>
          ) : attachment.status === "error" ? (
            <span className="text-red-500" title={attachment.error}>{attachment.error || "Failed"}</span>
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

  // FIX 3: track RAG files with their cloudinaryUrls for source linking
  const [ragFiles, setRagFiles] = useState<Array<{ id: string; filename: string; cloudinaryUrl?: string; mimetype?: string }>>([]);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarDesktopOpen, setIsSidebarDesktopOpen] = useState(false);

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showLoginPopup, setShowLoginPopup] = useState(false);

  // File validation popups
  const [fileValidationPopup, setFileValidationPopup] = useState<{
    type: "unsupported" | "page_limit";
    message: string;
  } | null>(null);
  const fileValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const SUPPORTED_MIME_TYPES = useMemo(() => new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]), []);

  function showFilePopup(type: "unsupported" | "page_limit", message: string) {
    if (fileValidationTimerRef.current) clearTimeout(fileValidationTimerRef.current);
    setFileValidationPopup({ type, message });
  }

  function dismissFilePopup() {
    if (fileValidationTimerRef.current) clearTimeout(fileValidationTimerRef.current);
    setFileValidationPopup(null);
  }

  // Custom confirm modal state — replaces all window.confirm() calls
  const [confirmModal, setConfirmModal] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  /** Drop-in replacement for window.confirm() that shows a styled modal */
  function appConfirm(message: string, onConfirm: () => void) {
    setConfirmModal({ message, onConfirm });
  }

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

  // FIX 3: fetch RAG files list (with cloudinaryUrls) whenever authed
  const refreshRagFiles = useCallback(
    async (tokenOverride?: string) => {
      const token = tokenOverride ?? authToken;
      if (!token || !backendBase) return;
      try {
        const res = await fetch(`${backendBase}/rag/files`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setRagFiles(
          (data.files || []).map((f: { id: string; filename: string; cloudinaryUrl?: string; mimetype?: string }) => ({
            id: f.id,
            filename: f.filename,
            cloudinaryUrl: f.cloudinaryUrl || "",
            mimetype: f.mimetype || "",
          }))
        );
      } catch {}
    },
    [authToken, backendBase]
  );

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
    setRagFiles([]);
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
        await refreshRagFiles(data.token);
      } finally {
        setIsAuthBusy(false);
      }
    },
    [apiUrl, refreshSessions, refreshRagFiles]
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
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

  // FIX 2: deleteSession — also removes RAG vectors + Cloudinary files from DB
  // The backend's DELETE /sessions/:id already deletes from MongoDB.
  // RAG files are stored separately; we additionally delete all rag files
  // that were referenced in this session's messages.
  async function deleteSession(sessionId: string) {
    if (!isAuthed || isStreaming) return;
    appConfirm("Delete this chat?", async () => {
    setError(null);
    try {
      // 1. Load session messages to find any attached RAG file IDs
      const ragFileIdsToDelete: string[] = [];
      try {
        const data = await fetchJson<{ session: Session }>(
          apiUrl(`/sessions/${sessionId}`),
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        // Gather unique fileIds from all user message attachments
        const seen = new Set<string>();
        for (const msg of data.session.messages) {
          if (msg.attachments) {
            for (const att of msg.attachments) {
              if (att.fileId && !seen.has(att.fileId)) {
                seen.add(att.fileId);
                ragFileIdsToDelete.push(att.fileId);
              }
            }
          }
        }
      } catch {
        // non-fatal — proceed with session deletion even if we can't read messages
      }

      // 2. Delete associated RAG files from Pinecone + Cloudinary + MongoDB
      for (const fileId of ragFileIdsToDelete) {
        try {
          await fetch(apiUrl(`/rag/files/${fileId}`), {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
          });
        } catch {}
      }

      // 3. Delete the chat session from MongoDB
      await fetchJson(apiUrl(`/sessions/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });

      // 4. Refresh RAG files list
      await refreshRagFiles();

      const nextSessions = await refreshSessions();
      if (activeSessionId === sessionId) {
        if (nextSessions.length > 0) await openSession(nextSessions[0].id);
        else { setActiveSessionId(null); setMessages([]); await createSession(); }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    }); // end appConfirm
  } 
  async function clearHistory() {
    if (!isAuthed || isStreaming) return;
    appConfirm("Clear all chat history? This will also remove all uploaded files.", async () => {
      setError(null);
      try {
        // 1. Bulk-delete ALL RAG files: Pinecone vectors + Cloudinary assets + MongoDB records
        //    Uses DELETE /rag/files which handles everything server-side in one request.
        try {
          await fetch(apiUrl("/rag/files"), {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
          });
        } catch {}

        // 2. Delete all chat sessions from MongoDB
        await fetchJson(apiUrl("/sessions"), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${authToken}` },
        });

        setMessages([]);
        setActiveSessionId(null);
        setSessions([]);
        setRagFiles([]);
        sessionFileIds.current = [];
        await createSession();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  // ── Delete account ────────────────────────────────────────────────────────
  async function deleteAccount() {
    if (!isAuthed || isStreaming) return;
    appConfirm(
      "Are you sure you want to delete your account?\n\nThis will permanently delete:\n• All your chat history\n• All uploaded files (Cloudinary + Pinecone)\n• Your account from our database\n\nThis action cannot be undone.",
      async () => {
        setError(null);
        try {
          // 1. Delete all RAG files (Pinecone + Cloudinary + MongoDB RagFile records)
          try {
            await fetch(apiUrl("/rag/files"), {
              method: "DELETE",
              headers: { Authorization: `Bearer ${authToken}` },
            });
          } catch {}
          // 2. Delete account (Chat sessions + User record from MongoDB)
          await fetchJson(apiUrl("/account"), {
            method: "DELETE",
            headers: { Authorization: `Bearer ${authToken}` },
          });
          // 3. Log out locally
          setAuthToken(null);
          setAuthUser(null);
          setMessages([]);
          setActiveSessionId(null);
          setSessions([]);
          setRagFiles([]);
          sessionFileIds.current = [];
          localStorage.removeItem(STORAGE_TOKEN_KEY);
          localStorage.removeItem(STORAGE_USER_KEY);
        } catch (e: unknown) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    );
  }

  useEffect(() => {
    if (!backendBase) { setError("Missing NEXT_PUBLIC_BACKEND_URL."); return; }
    if (!isAuthed) { setSessions([]); setActiveSessionId(null); return; }
    refreshSessions().catch((e) => setError(e.message));
    refreshRagFiles().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendBase, isAuthed]);

  useEffect(() => {
    if (!isAuthed) return;
    if (sessions.length > 0 && !activeSessionId) openSession(sessions[0].id);
    else if (sessions.length === 0 && !activeSessionId && backendBase) createSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeSessionId, backendBase, isAuthed]);

  // ── File upload ───────────────────────────────────────────────────────────
  async function handleFilesSelected(fileList: FileList | File[] | null) {
    if (!fileList || fileList.length === 0 || !isAuthed) return;

    const files = Array.from(fileList);

    // ── Client-side file type validation ────────────────────────────────────
    const unsupportedFiles = files.filter((f) => !SUPPORTED_MIME_TYPES.has(f.type));
    if (unsupportedFiles.length > 0) {
      showFilePopup("unsupported", "This document is not supported");
      return;
    }

    const newPending: PendingAttachment[] = files.map((file) => ({
      tempId: `temp-${Date.now()}-${Math.random()}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
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
          const errData = await res.json().catch(() => ({ error: "Upload failed" }));

          // Show page-limit popup and remove the pending card
          if (errData.code === "PAGE_LIMIT_EXCEEDED") {
            showFilePopup("page_limit", "You can upload maximum 2 pages");
            setPendingAttachments((prev) => prev.filter((p) => p.tempId !== pending.tempId));
            continue;
          }

          setPendingAttachments((prev) =>
            prev.map((p) =>
              p.tempId === pending.tempId ? { ...p, status: "error", error: errData.error } : p
            )
          );
          continue;
        }

        const data = await res.json();

        let resolvedUrl: string = data.cloudinaryUrl || "";
        if (!resolvedUrl && !pending.file.type.startsWith("image/")) {
          resolvedUrl = URL.createObjectURL(pending.file);
        }

        // add newly uploaded file to ragFiles for source linking
        if (data.fileId) {
          setRagFiles((prev) => {
            if (prev.find((f) => f.id === data.fileId)) return prev;
            return [
              { id: data.fileId, filename: pending.file.name, cloudinaryUrl: resolvedUrl, mimetype: pending.file.type },
              ...prev,
            ];
          });
        }

        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.tempId === pending.tempId
              ? { ...p, status: "ready", fileId: data.fileId, cloudinaryUrl: resolvedUrl }
              : p
          )
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.tempId === pending.tempId
              ? { ...p, status: "error", error: err instanceof Error ? err.message : "Upload failed" }
              : p
          )
        );
      }
    }
  }

  // ── Paste support — handle files pasted into the chat input ───────────────
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const fileItems = items.filter((item) => item.kind === "file");
    if (fileItems.length === 0) return; // no files — let normal text paste happen

    e.preventDefault();
    if (!isAuthed) {
      setShowLoginPopup(true);
      return;
    }

    const pastedFiles: File[] = fileItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);

    if (pastedFiles.length > 0) {
      handleFilesSelected(pastedFiles);
    }
  }

  // ── Delete attachment (UI + Cloudinary + MongoDB) ─────────────────────────
  async function removePending(tempId: string) {
    const found = pendingAttachments.find((p) => p.tempId === tempId);
    if (!found) return;

    // Revoke any blob URLs to free memory
    if (found.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(found.previewUrl);
    if (found.cloudinaryUrl?.startsWith("blob:")) URL.revokeObjectURL(found.cloudinaryUrl);

    // Remove from UI immediately
    setPendingAttachments((prev) => prev.filter((p) => p.tempId !== tempId));

    // If the file was successfully uploaded, delete it from Cloudinary + MongoDB
    if (found.fileId && isAuthed) {
      try {
        await fetch(apiUrl(`/rag/files/${found.fileId}`), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${authToken}` },
        });
        // Remove from sessionFileIds so it's no longer in context
        sessionFileIds.current = sessionFileIds.current.filter((id) => id !== found.fileId);
        // Remove from ragFiles list
        setRagFiles((prev) => prev.filter((f) => f.id !== found.fileId));
      } catch {
        // Non-fatal — UI already updated
      }
    }
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
      cloudinaryUrl: p.cloudinaryUrl || "",
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
          : hasFileContext && isAuthed
          ? activeSessionId || null
          : null;

      const body: Record<string, unknown> = {
        message: text || "Please analyze and describe the attached file(s).",
      };
      if (ensuredSessionId) body.sessionId = ensuredSessionId;
      if (hasFileContext) {
        body.useRag = true;
        body.fileIds = sessionFileIds.current;
        body.attachments = attachmentMetas.map((a) => ({
          fileId: a.fileId,
          filename: a.filename,
          mimetype: a.mimetype,
          size: a.size,
          cloudinaryUrl: a.cloudinaryUrl || "",
        }));
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
      let buffer = "";

      // Token queue + drainer — gives a natural word-by-word typing feel.
      // Tokens arrive from the SSE stream and are queued; the drainer
      // renders them one at a time with a small random delay so the output
      // feels like it's being typed rather than dumped in chunks.
      const tokenQueue: string[] = [];
      let draining = false;

      function drainQueue() {
        if (draining) return;
        draining = true;
        function step() {
          if (tokenQueue.length === 0) { draining = false; return; }
          const token = tokenQueue.shift()!;
          assistantText += token;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, content: assistantText, ragSources };
            }
            return next;
          });
          scrollToBottom();
          // 15–35 ms random delay per token — smooth without feeling slow
          setTimeout(step, 15 + Math.random() * 20);
        }
        step();
      }

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by "\n\n"
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? ""; // keep incomplete last frame
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") break;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.t) {
              tokenQueue.push(parsed.t);
              drainQueue();
            }
          } catch {
            // malformed frame — skip
          }
        }
      }

      // Wait for drain to finish before marking streaming done
      await new Promise<void>((resolve) => {
        function waitForDrain() {
          if (tokenQueue.length === 0 && !draining) { resolve(); return; }
          setTimeout(waitForDrain, 30);
        }
        waitForDrain();
      });

      if (isAuthed) await refreshSessions();
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
    <div className="flex h-dvh w-screen overflow-hidden bg-[#f8f7f4] text-zinc-900 dark:bg-[#111110] dark:text-zinc-100">
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
          <div className="px-4 pt-3 pb-3 flex items-center gap-3 border-b border-zinc-100 dark:border-white/[0.08] relative">
            {authUser.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={authUser.picture}
                alt={authUser.name}
                className="h-9 w-9 rounded-full border border-zinc-200 dark:border-white/15 object-cover shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-zinc-200 dark:bg-white/10 flex items-center justify-center text-sm font-bold text-zinc-600 dark:text-zinc-300 shrink-0">
                {(authUser.name || authUser.email)[0]?.toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{authUser.name || "User"}</div>
              <div className="text-[11px] text-zinc-400 truncate">{authUser.email}</div>
            </div>
            {/* Three-dot menu */}
            <ProfileMenu onDeleteAccount={deleteAccount} />
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
                  {/* FIX 1: no horizontal scroll — title truncated with ellipsis, date on same line */}
                  <div className="flex items-center gap-1 group">
                    <button
                      className={[
                        "flex-1 min-w-0 rounded-lg px-3 py-2.5 text-left transition-colors overflow-hidden",
                        s.id === activeSessionId
                          ? "bg-zinc-100 dark:bg-white/10 text-zinc-900 dark:text-white"
                          : "hover:bg-zinc-50 dark:hover:bg-white/5 text-zinc-700 dark:text-zinc-300",
                      ].join(" ")}
                      onClick={() => openSession(s.id)}
                      disabled={isStreaming}
                    >
                      {/* FIX 1: single line with overflow ellipsis — no wrapping that causes scroll */}
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="truncate font-medium text-[13px] flex-1 min-w-0 block">
                          {s.title || "New chat"}
                        </span>
                        <span className="shrink-0 text-[10px] text-zinc-400 whitespace-nowrap">
                          {new Date(s.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </button>
                    {s.title && s.title.trim() !== "" && (
                    <button
                        className="shrink-0 p-1.5 text-zinc-400 hover:text-red-500
                          opacity-100
                          transition-all rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                        title="Delete chat"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-100 dark:border-white/[0.08] p-4 space-y-2">
          {isAuthed && sessions.some((s) => s.title && s.title.trim() !== "") && (
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
                    {/* Attachments above message bubble */}
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
                          <div className={[
                            "prose max-w-none text-sm leading-7",
                            m.role === "user"
                              ? "prose-invert prose-p:text-white prose-headings:text-white prose-strong:text-white prose-li:text-white prose-code:text-white/90"
                              : [
                                  "dark:prose-invert",
                                  "prose-headings:font-bold prose-headings:text-zinc-800 dark:prose-headings:text-zinc-100",
                                  "prose-h1:text-xl prose-h2:text-lg prose-h3:text-base",
                                  "prose-headings:mt-5 prose-headings:mb-2 prose-headings:border-b prose-headings:border-zinc-100 dark:prose-headings:border-zinc-700/50 prose-headings:pb-1",
                                  "prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-p:mb-3 prose-p:last:mb-0",
                                  "prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-strong:font-semibold",
                                  "prose-em:text-zinc-600 dark:prose-em:text-zinc-400",
                                  "prose-ul:my-2 prose-ul:list-disc prose-ul:pl-5 prose-li:my-0.5 prose-li:text-zinc-700 dark:prose-li:text-zinc-300",
                                  "prose-ol:my-2 prose-ol:list-decimal prose-ol:pl-5",
                                  "prose-code:text-indigo-600 dark:prose-code:text-indigo-300 prose-code:bg-indigo-50 dark:prose-code:bg-indigo-900/30 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-xs prose-code:font-medium prose-code:before:content-none prose-code:after:content-none",
                                  "prose-pre:rounded-xl prose-pre:bg-zinc-900 dark:prose-pre:bg-black/40 prose-pre:border prose-pre:border-zinc-200 dark:prose-pre:border-zinc-700/50 prose-pre:shadow-sm prose-pre:overflow-x-auto",
                                  "prose-pre:my-3 prose-pre:text-zinc-100",
                                  "prose-blockquote:border-l-4 prose-blockquote:border-indigo-300 dark:prose-blockquote:border-indigo-600 prose-blockquote:bg-indigo-50/50 dark:prose-blockquote:bg-indigo-900/10 prose-blockquote:rounded-r-lg prose-blockquote:px-4 prose-blockquote:py-1 prose-blockquote:my-3 prose-blockquote:text-zinc-600 dark:prose-blockquote:text-zinc-400 prose-blockquote:not-italic",
                                  "prose-hr:border-zinc-200 dark:prose-hr:border-zinc-700",
                                  "prose-table:text-sm prose-th:bg-zinc-50 dark:prose-th:bg-zinc-800 prose-th:font-semibold",
                                ].join(" "),
                          ].join(" ")}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {m.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Copy + RAG sources row for assistant */}
                    {m.role === "assistant" && m.content && !isStreaming && (
                      <div className="flex items-center gap-2 flex-wrap pl-1">
                        <CopyButton text={m.content} />
                        {m.ragSources && m.ragSources.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] text-zinc-400">Sources:</span>
                            {/* FIX 3: clickable source badges that open original document */}
                            {m.ragSources.map((src, i) => (
                              <RagSourceBadge key={i} src={src} ragFiles={ragFiles} />
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
        <footer className="shrink-0 bg-white/90 dark:bg-[#111110]/90 backdrop-blur-md border-t border-zinc-200 dark:border-white/[0.08] px-4 pt-3 pb-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
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
              {/* Attachment button + validation popup */}
              <div className="relative shrink-0 mb-1">
                <button
                  type="button"
                  onClick={() => {
                    if (!isAuthed) {
                      setShowLoginPopup(true);
                    } else {
                      fileInputRef.current?.click();
                    }
                  }}
                  disabled={isAuthed && isStreaming}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all disabled:opacity-30"
                  title={isAuthed ? "Attach a file (PDF, DOCX, TXT, JPG, PNG, WEBP)" : "Login to attach files"}
                >
                  <Paperclip size={18} />
                </button>

                {/* File validation popup — anchored to the paperclip button */}
                {fileValidationPopup && (
                  <div className="absolute bottom-full left-0 mb-2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                    <div className={[
                      "flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium shadow-lg border whitespace-nowrap",
                      fileValidationPopup.type === "unsupported"
                        ? "bg-red-50 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-700/50"
                        : "bg-amber-50 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-700/50",
                    ].join(" ")}>
                      <span>{fileValidationPopup.message}</span>
                      <button
                        onClick={dismissFilePopup}
                        className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
                        aria-label="Dismiss"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {/* Arrow pointer */}
                    <div className={[
                      "w-2.5 h-2.5 rotate-45 -mt-[5px] ml-3 border-b border-r",
                      fileValidationPopup.type === "unsupported"
                        ? "bg-red-50 dark:bg-red-900/40 border-red-200 dark:border-red-700/50"
                        : "bg-amber-50 dark:bg-amber-900/40 border-amber-200 dark:border-amber-700/50",
                    ].join(" ")} />
                  </div>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.pdf,.docx,.jpg,.jpeg,.png,.webp"
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
                onPaste={handlePaste}
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

      {/* ── LOGIN POPUP ──────────────────────────────────────────────────── */}
      {showLoginPopup && (
        <div
          className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setShowLoginPopup(false)}
        >
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl bg-white dark:bg-[#1a1a19] border border-zinc-200 dark:border-white/10 shadow-2xl shadow-black/20 p-6 animate-in slide-in-from-bottom-4 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setShowLoginPopup(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors"
              title="Close"
            >
              <X size={18} />
            </button>

            {/* Icon */}
            <div className="w-12 h-12 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center mb-4">
              <Paperclip size={22} className="text-indigo-500" />
            </div>

            {/* Text */}
            <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              Login required
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6 leading-relaxed">
              For uploading a file you have to login to AI. Sign in with Google to attach and analyze files.
            </p>

            {/* Google Login */}
            <div
              className={[
                "flex justify-center",
                isAuthBusy ? "pointer-events-none opacity-60" : "",
              ].join(" ")}
            >
              <GoogleLogin
                onSuccess={async (resp) => {
                  if (!resp.credential) { setError("Google login failed"); return; }
                  try {
                    await handleGoogleCredential(resp.credential);
                    setShowLoginPopup(false);
                  } catch (e: unknown) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
                onError={() => setError("Google login failed")}
              />
            </div>

            {isAuthBusy && (
              <div className="flex items-center justify-center gap-2 text-xs text-zinc-400 mt-3">
                <Loader2 size={13} className="animate-spin" />
                Signing in&hellip;
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CONFIRM MODAL ─────────────────────────────────────────────────── */}
      {confirmModal && (
        <div
          className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setConfirmModal(null)}
        >
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl bg-white dark:bg-[#1a1a19] border border-zinc-200 dark:border-white/10 shadow-2xl shadow-black/20 p-6 animate-in slide-in-from-bottom-4 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setConfirmModal(null)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors"
              title="Close"
            >
              <X size={18} />
            </button>
            <div className="w-12 h-12 rounded-xl bg-red-50 dark:bg-red-900/30 flex items-center justify-center mb-4">
              <Trash2 size={22} className="text-red-500" />
            </div>
            <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-2">Are you sure?</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6 leading-relaxed whitespace-pre-line">
              {confirmModal.message}
            </p>
            <div className="flex gap-3">
              <button
                className="flex-1 rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-white/5 transition-colors"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 rounded-xl bg-red-500 hover:bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors"
                onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}