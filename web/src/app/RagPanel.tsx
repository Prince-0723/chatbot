"use client";

import { useCallback, useRef, useState } from "react";
import {
  FileText,
  Image,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
  X,
  CheckCircle2,
  AlertCircle,
  Brain,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
export type RagFile = {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  chunkCount: number;
  createdAt: string;
};

type UploadingFile = {
  id: string; // temp client id
  filename: string;
  status: "uploading" | "ready" | "error";
  error?: string;
};

type Props = {
  authToken: string;
  backendBase: string;
  /** Called whenever selected file IDs change — parent passes these into RAG chat */
  onSelectionChange: (fileIds: string[]) => void;
  /** Is RAG mode currently enabled */
  ragEnabled: boolean;
  onToggleRag: (enabled: boolean) => void;
};

// ── Helpers ────────────────────────────────────────────────────────────────
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimetype: string) {
  if (mimetype.startsWith("image/"))
    return <Image size={16} className="text-violet-400 shrink-0" />;
  return <FileText size={16} className="text-indigo-400 shrink-0" />;
}

const ACCEPTED = ".txt,.pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.gif";

// ── Component ──────────────────────────────────────────────────────────────
export default function RagPanel({
  authToken,
  backendBase,
  onSelectionChange,
  ragEnabled,
  onToggleRag,
}: Props) {
  const [files, setFiles] = useState<RagFile[]>([]);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const apiUrl = (path: string) =>
    `${backendBase.replace(/\/+$/, "")}${path}`;

  // Fetch indexed files
  const fetchFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const res = await fetch(apiUrl("/rag/files"), {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error("Failed to fetch files");
      const data = await res.json();
      setFiles(data.files || []);
      setHasFetched(true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingFiles(false);
    }
  }, [authToken, backendBase]);

  function togglePanel() {
    const next = !isOpen;
    setIsOpen(next);
    if (next && !hasFetched) fetchFiles();
  }

  // Upload file(s)
  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;

    for (const file of Array.from(fileList)) {
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      const uploadingEntry: UploadingFile = {
        id: tempId,
        filename: file.name,
        status: "uploading",
      };

      setUploading((prev) => [...prev, uploadingEntry]);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(apiUrl("/rag/upload"), {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          setUploading((prev) =>
            prev.map((u) =>
              u.id === tempId
                ? { ...u, status: "error", error: err.error }
                : u
            )
          );
          continue;
        }

        const data = await res.json();
        // Add to indexed files list
        const newFile: RagFile = {
          id: data.fileId,
          filename: data.filename,
          mimetype: file.type,
          size: file.size,
          chunkCount: data.chunkCount,
          createdAt: new Date().toISOString(),
        };
        setFiles((prev) => [newFile, ...prev]);
        setUploading((prev) => prev.filter((u) => u.id !== tempId));
      } catch (err) {
        setUploading((prev) =>
          prev.map((u) =>
            u.id === tempId
              ? {
                  ...u,
                  status: "error",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : u
          )
        );
      }
    }
  }

  // Delete a file
  async function deleteFile(fileId: string) {
    try {
      await fetch(apiUrl(`/rag/files/${fileId}`), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        onSelectionChange([...next]);
        return next;
      });
    } catch (e) {
      console.error(e);
    }
  }

  // Toggle file selection
  function toggleSelect(fileId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      onSelectionChange([...next]);
      return next;
    });
  }

  // Select all / none
  function toggleSelectAll() {
    if (selectedIds.size === files.length && files.length > 0) {
      setSelectedIds(new Set());
      onSelectionChange([]);
    } else {
      const allIds = files.map((f) => f.id);
      setSelectedIds(new Set(allIds));
      onSelectionChange(allIds);
    }
  }

  const totalSelected = selectedIds.size;

  return (
    <div className="border-t border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900">
      {/* Toggle bar */}
      <div className="flex items-center justify-between px-4 py-2 gap-3">
        <button
          onClick={togglePanel}
          className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
        >
          <Brain size={15} className={ragEnabled ? "text-indigo-500" : ""} />
          <span>
            RAG Documents
            {totalSelected > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-full text-[10px]">
                {totalSelected} selected
              </span>
            )}
          </span>
          <span className="ml-1 text-zinc-400">{isOpen ? "▲" : "▼"}</span>
        </button>

        {/* RAG toggle */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {ragEnabled ? "RAG ON" : "RAG OFF"}
          </span>
          <button
            role="switch"
            aria-checked={ragEnabled}
            onClick={() => onToggleRag(!ragEnabled)}
            className={[
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
              ragEnabled
                ? "bg-indigo-600"
                : "bg-zinc-300 dark:bg-zinc-700",
            ].join(" ")}
          >
            <span
              className={[
                "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
                ragEnabled ? "translate-x-4" : "translate-x-1",
              ].join(" ")}
            />
          </button>
        </div>
      </div>

      {/* Expandable panel */}
      {isOpen && (
        <div className="px-4 pb-4 space-y-3">
          {/* Upload area */}
          <div
            className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-xl p-4 text-center cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 transition-colors"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFilesSelected(e.dataTransfer.files);
            }}
          >
            <Upload
              size={20}
              className="mx-auto mb-1.5 text-zinc-400 dark:text-zinc-500"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Drop files here or{" "}
              <span className="text-indigo-500 font-medium">browse</span>
            </p>
            <p className="text-[10px] text-zinc-400 mt-1">
              TXT · PDF · DOCX · JPG · PNG · WEBP
            </p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              multiple
              className="hidden"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
          </div>

          {/* Uploading items */}
          {uploading.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-2 text-xs rounded-lg bg-zinc-50 dark:bg-zinc-800 px-3 py-2"
            >
              {u.status === "uploading" && (
                <Loader2 size={13} className="animate-spin text-indigo-500 shrink-0" />
              )}
              {u.status === "error" && (
                <AlertCircle size={13} className="text-red-500 shrink-0" />
              )}
              <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                {u.filename}
              </span>
              {u.status === "uploading" && (
                <span className="text-zinc-400">Uploading…</span>
              )}
              {u.status === "error" && (
                <span className="text-red-500 truncate">{u.error}</span>
              )}
              {u.status === "error" && (
                <button
                  onClick={() =>
                    setUploading((p) => p.filter((x) => x.id !== u.id))
                  }
                  className="shrink-0 text-zinc-400 hover:text-red-500"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          ))}

          {/* File list */}
          {loadingFiles && (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={18} className="animate-spin text-zinc-400" />
            </div>
          )}

          {!loadingFiles && hasFetched && files.length === 0 && uploading.length === 0 && (
            <p className="text-center text-xs text-zinc-400 py-2">
              No documents indexed yet.
            </p>
          )}

          {files.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-zinc-400 font-semibold">
                  Indexed Files ({files.length})
                </span>
                <button
                  onClick={toggleSelectAll}
                  className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium"
                >
                  {selectedIds.size === files.length ? "Deselect all" : "Select all"}
                </button>
              </div>

              <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {files.map((f) => {
                  const isSelected = selectedIds.has(f.id);
                  return (
                    <li
                      key={f.id}
                      className={[
                        "flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer text-xs transition-colors group",
                        isSelected
                          ? "bg-indigo-50 dark:bg-indigo-900/30 ring-1 ring-indigo-400/30"
                          : "bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700",
                      ].join(" ")}
                      onClick={() => toggleSelect(f.id)}
                    >
                      {fileIcon(f.mimetype)}

                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium text-zinc-800 dark:text-zinc-200">
                          {f.filename}
                        </div>
                        <div className="text-zinc-400 text-[10px]">
                          {formatBytes(f.size)} · {f.chunkCount} chunks
                        </div>
                      </div>

                      {isSelected && (
                        <CheckCircle2
                          size={14}
                          className="text-indigo-500 shrink-0"
                        />
                      )}

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteFile(f.id);
                        }}
                        className="shrink-0 text-zinc-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {totalSelected > 0 && (
            <p className="text-[10px] text-center text-indigo-500 dark:text-indigo-400">
              {totalSelected} file{totalSelected > 1 ? "s" : ""} selected — RAG will
              search these when you send a message.
            </p>
          )}
          {ragEnabled && totalSelected === 0 && files.length > 0 && (
            <p className="text-[10px] text-center text-zinc-400">
              RAG is ON — will search all your files. Select specific files to narrow scope.
            </p>
          )}
        </div>
      )}
    </div>
  );
}