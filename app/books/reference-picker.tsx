"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** A row of the reference library, as returned by GET /api/books/references. */
export interface ReferenceBook {
  id: string;
  title: string;
  author: string | null;
  source: "upload" | "generated";
  status: "PENDING" | "GENERATING" | "DONE" | "FAILED";
  wordCount: number;
  sectionCount: number;
  error: string | null;
}

const ACCEPTED = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
];

/** How often the library is re-fetched while something is still being read. */
const POLL_MS = 4000;

/**
 * Choose the reference book a new book is written in the style of — from the
 * library, or by uploading one.
 *
 * The upload is THREE steps and deliberately not one: ask for a signed URL, PUT
 * the file straight to storage, then tell the server to parse it. The bytes
 * never pass through the app, because a reference book is a whole book and a
 * serverless route caps request bodies far below that.
 *
 * A freshly uploaded book is not immediately selectable: its text has to be
 * parsed and its voice read, which happens in background jobs. Rather than
 * leave that as a mystery, this polls until the reference reaches DONE and then
 * selects it.
 */
export function ReferencePicker({
  value,
  onChange,
  disabled,
  initial,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** The library, rendered on the server so the picker is populated on first paint. */
  initial: ReferenceBook[];
}) {
  const [references, setReferences] = useState<ReferenceBook[]>(initial);
  const [mode, setMode] = useState<"library" | "upload">("library");
  const [uploadTitle, setUploadTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The reference we are waiting on, so polling can select it once it is ready.
  const awaitingId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/books/references");
      const data = await res.json();
      const rows: ReferenceBook[] = data.references ?? [];
      setReferences(rows);
      const waiting = awaitingId.current;
      if (waiting) {
        const row = rows.find((r) => r.id === waiting);
        if (row?.status === "DONE") {
          awaitingId.current = null;
          setBusy(null);
          onChange(row.id);
          setMode("library");
        } else if (row?.status === "FAILED") {
          awaitingId.current = null;
          setBusy(null);
          setError(row.error ?? "That file could not be read.");
        }
      }
      return rows;
    } catch {
      /* keep what we have */
      return [];
    }
  }, [onChange]);

  // Poll only while something is actually being read — an idle picker makes no
  // requests.
  const pending = references.some((r) => r.status === "PENDING" || r.status === "GENERATING");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  async function onUpload() {
    const title = uploadTitle.trim();
    if (!title || !file) {
      setError(!title ? "Give the reference book a title." : "Choose a file to upload.");
      return;
    }
    setError(null);
    setBusy("Uploading…");
    try {
      // 1. A signed URL, and the reference row it belongs to.
      const startRes = await fetch("/api/books/references/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          filename: file.name,
          contentType: file.type,
          size: file.size,
        }),
      });
      const start = await startRes.json();
      if (!startRes.ok) throw new Error(start.error ?? "Could not start the upload");

      // 2. The file itself, straight to storage. The signed URL carries its own
      // authorization, so this request is deliberately not credentialed.
      const put = await fetch(start.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`The upload failed (${put.status})`);

      // 3. Parsing starts server-side; the reference is not usable until it ends.
      const doneRes = await fetch("/api/books/references/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referenceBookId: start.referenceBookId }),
      });
      const done = await doneRes.json();
      if (!doneRes.ok) throw new Error(done.error ?? "Could not process the upload");

      awaitingId.current = start.referenceBookId;
      setBusy("Reading the book…");
      setUploadTitle("");
      setFile(null);
      await load();
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : "The upload failed");
    }
  }

  const rows = references;
  const usable = rows.filter((r) => r.status === "DONE");
  const unready = rows.filter((r) => r.status !== "DONE");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="referenceBook">Reference book</Label>
        <button
          type="button"
          onClick={() => setMode(mode === "library" ? "upload" : "library")}
          className="text-xs text-brand-300 hover:underline"
        >
          {mode === "library" ? "Upload a book" : "Choose from library"}
        </button>
      </div>

      {mode === "library" ? (
        <select
          id="referenceBook"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="flex h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <option value="">
            {usable.length === 0 ? "No reference books yet — upload one" : "Choose one…"}
          </option>
          {usable.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
              {r.source === "generated" ? " (generated)" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="space-y-2 rounded-md border border-border bg-surface/60 p-3">
          <Input
            value={uploadTitle}
            onChange={(e) => setUploadTitle(e.target.value)}
            placeholder="Title of the book you're uploading"
            disabled={Boolean(busy)}
          />
          <input
            type="file"
            accept={ACCEPTED.join(",")}
            disabled={Boolean(busy)}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-fg-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-fg"
          />
          <button
            type="button"
            onClick={() => void onUpload()}
            disabled={Boolean(busy)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-fg hover:bg-surface disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {busy ?? "Upload"}
          </button>
          <p className="text-xs text-fg-subtle">
            PDF, DOCX, TXT or Markdown. A scanned book cannot be read — its pages are images.
          </p>
        </div>
      )}

      {/* Anything mid-flight or broken, so a missing option is never a mystery. */}
      {unready.map((r) => (
        <p key={r.id} className="text-xs text-fg-subtle">
          {r.status === "FAILED" ? (
            <span className="text-red-400">
              {r.title}: {r.error ?? "could not be read"}
            </span>
          ) : (
            <span>{r.title}: still being read…</span>
          )}
        </p>
      ))}

      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
      {mode === "library" && (
        <p className="text-xs text-fg-subtle">The new book is written in this book&rsquo;s voice.</p>
      )}
    </div>
  );
}
