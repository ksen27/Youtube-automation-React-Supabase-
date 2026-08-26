"use client";

import * as React from "react";
import { ExternalLink, Link2, Paperclip, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { boardsApi } from "@/lib/boards/client";
import { relativeTime } from "@/lib/boards/dates";
import type { BoardAttachment } from "@/lib/boards/types";

// Attachments: a pasted link, or a file uploaded straight to R2.
//
// The upload path is the one the rest of this app already uses (presign → PUT
// from the browser → record the row): a large file never travels through a
// Next.js route handler, so there is no body-size ceiling to trip over.

export interface AttachmentsSectionProps {
  boardId: string;
  cardId: string;
  actorId: string | null;
  attachments: BoardAttachment[];
  canEdit: boolean;
  now: Date;
  onChanged: () => void;
  onError: (message: string) => void;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsSection({
  boardId,
  cardId,
  actorId,
  attachments,
  canEdit,
  now,
  onChanged,
  onError,
}: AttachmentsSectionProps) {
  const [linkUrl, setLinkUrl] = React.useState("");
  const [linkName, setLinkName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const addLink = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    setBusy(true);
    try {
      await boardsApi.createAttachment(boardId, actorId, cardId, {
        name: linkName.trim() || url,
        url,
      });
      setLinkUrl("");
      setLinkName("");
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not attach that link.");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const presigned = await boardsApi.presignAttachment(boardId, actorId, cardId, {
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
      });

      const put = await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      // The row is only written after the object is actually in the bucket, so
      // a failed upload cannot leave an attachment pointing at nothing.
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      await boardsApi.createAttachment(boardId, actorId, cardId, {
        name: file.name,
        url: presigned.publicUrl,
        storageKey: presigned.storageKey,
        contentType: file.type || null,
        sizeBytes: file.size,
      });
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not upload that file.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (attachmentId: string) => {
    try {
      await boardsApi.deleteAttachment(boardId, actorId, attachmentId);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not remove that attachment.");
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        <Paperclip className="h-3.5 w-3.5" />
        Attachments
      </h3>

      <ul className="space-y-1.5">
        {attachments.map((attachment) => (
          <li
            key={attachment.id}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-2/40 px-2.5 py-1.5"
          >
            <Link2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <a
              href={attachment.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 flex-1 truncate text-sm text-brand-300 hover:underline"
            >
              {attachment.name}
            </a>
            <span className="text-[11px] text-fg-subtle">
              {formatSize(attachment.sizeBytes)} · {relativeTime(attachment.createdAt, now)}
            </span>
            <ExternalLink className="h-3 w-3 text-fg-subtle" />
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => void remove(attachment.id)}
                className="text-fg-subtle hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {attachments.length === 0 && <p className="text-xs text-fg-subtle">Nothing attached yet.</p>}

      {canEdit && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="Paste a link"
              className="h-8 flex-1 min-w-[10rem] text-xs"
            />
            <Input
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              placeholder="Label (optional)"
              className="h-8 w-32 text-xs"
            />
            <Button size="sm" onClick={() => void addLink()} disabled={!linkUrl.trim() || busy}>
              Attach
            </Button>
          </div>

          <div>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className={cn(busy && "opacity-60")}
            >
              <Upload className="h-3.5 w-3.5" />
              {busy ? "Working…" : "Upload a file"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
