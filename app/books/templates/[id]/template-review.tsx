"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Action = "keep" | "relabel" | "remove";

interface Placeholder {
  placeholder: string;
  kind: string;
  maxChars: number | null;
  originalText: string | null;
  losesInlineMarkup: boolean;
}

interface Override {
  placeholder: string;
  action: Action;
  replacement?: string;
  matchText?: string;
}

interface TemplateData {
  id: string;
  sourceUrl: string;
  name: string | null;
  state: string;
  revision: number;
  failureReason: string | null;
  placeholders: Placeholder[];
  overrides: Override[];
  detected: { repeaters: string[]; placeholders: number };
  assets: { count: number; bytes: number; degradedFonts: number };
  report: { findings?: Array<{ severity: string; code: string; message: string }> } | null;
}

/** One row's editable decision. */
interface Draft {
  action: Action;
  replacement: string;
}

/**
 * Template review.
 *
 * A cloned page only replaces the text the extractor TAGGED as a placeholder;
 * everything it missed ships as the reference site wrote it. That is why a
 * cloned page can still read like the original — the fix is not to regenerate
 * it, it is to correct the labelling here and re-extract.
 *
 * Corrections are stored as intent ("this text is the hero subtitle"), not as
 * node ids: ids move when the source page changes, but the intent survives a
 * re-extraction, which is what lets review work be re-applied instead of redone.
 */
export function TemplateReview({ templateId }: { templateId: string }) {
  const [data, setData] = useState<TemplateData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await fetch(`/api/books/landing-templates/${templateId}`, { cache: "no-store" });
      if (!res.ok || isCancelled?.()) {
        if (!res.ok) setErr("Could not load that template");
        return;
      }
      const d: TemplateData = await res.json();
      if (isCancelled?.()) return;
      setData(d);
      // Seed each row from any correction already recorded.
      const seeded: Record<string, Draft> = {};
      for (const o of d.overrides ?? []) {
        seeded[o.placeholder] = { action: o.action, replacement: o.replacement ?? "" };
      }
      setDrafts(seeded);
    } catch {
      setErr("Could not load that template");
    } finally {
      if (!isCancelled?.()) setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load(() => cancelled);
    });
    return () => { cancelled = true; };
  }, [load]);

  function setDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [key]: { action: prev[key]?.action ?? "keep", replacement: prev[key]?.replacement ?? "", ...patch },
    }));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // Only send rows that actually changed something — "keep" with no
      // replacement is the default and carries no information.
      const overrides: Override[] = Object.entries(drafts)
        .filter(([, d]) => d.action !== "keep" || d.replacement.trim())
        .map(([placeholder, d]) => ({
          placeholder,
          action: d.action,
          ...(d.replacement.trim() ? { replacement: d.replacement.trim() } : {}),
        }));
      const res = await fetch(`/api/books/landing-templates/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      const body = await res.json();
      if (!res.ok) setErr(body.error ?? "Could not save");
      else setMsg("Saved. These apply the next time this template is extracted.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-run extraction on the same URL with `force`.
   *
   * The only way to APPLY anything on this page: saved corrections are re-read
   * on the next extraction, and an improved annotation pass only reaches an
   * existing template by re-running it. Without this the template is frozen at
   * whatever the first capture decided.
   */
  async function recopy() {
    if (!data) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/books/landing-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: data.sourceUrl, attestOwnership: true, force: true }),
      });
      const body = await res.json();
      if (!res.ok) setErr(body.error ?? "Could not re-copy");
      else setMsg("Copying the site again. Reload in a minute to see the new labelling.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this template? Pages already built from it are unaffected.")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/books/landing-templates/${templateId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErr(body.error ?? "Could not delete");
      } else {
        window.location.href = "/books";
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="grid place-items-center py-24 text-fg-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="px-6 py-8 max-w-3xl mx-auto">
        <p className="text-sm text-red-400">{err ?? "Template not found."}</p>
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-8 py-8 max-w-4xl mx-auto space-y-6">
      <div>
        <Link
          href="/books"
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All books
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-fg truncate">
          {data.name?.trim() || data.sourceUrl}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant={data.state === "READY" ? "success" : data.state === "FAILED" ? "destructive" : "info"}>
            {data.state.toLowerCase()}
          </Badge>
          <span className="text-xs text-fg-subtle">
            revision {data.revision} · {data.placeholders.length} replaceable regions ·{" "}
            {data.assets.count} assets
          </span>
        </div>
      </div>

      {data.failureReason && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{data.failureReason}</span>
        </div>
      )}

      {(data.report?.findings ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extraction report</CardTitle>
            <CardDescription>What the capture noticed about this page.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {(data.report?.findings ?? []).map((f, i) => (
              <p
                key={i}
                className={cn(
                  "text-sm",
                  f.severity === "BLOCKER" ? "text-red-300"
                  : f.severity === "WARN" ? "text-amber-300"
                  : "text-fg-muted",
                )}
              >
                <span className="text-xs uppercase tracking-wide opacity-70">{f.code}</span>{" "}
                {f.message}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What gets replaced</CardTitle>
          <CardDescription>
            Only these regions take your book&apos;s content. Anything not listed here
            ships exactly as the reference site wrote it — which is why a cloned page
            can still read like the original. Correct a wrong label below, then copy
            the site again to apply it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.placeholders.length === 0 && (
            <p className="py-6 text-center text-sm text-fg-muted">
              The extractor tagged nothing on this page. It is not usable as a template.
            </p>
          )}
          {data.placeholders.map((p) => {
            const d = drafts[p.placeholder] ?? { action: "keep" as Action, replacement: "" };
            return (
              <div
                key={p.placeholder}
                className={cn(
                  "rounded-md border border-border p-3 space-y-2",
                  d.action !== "keep" && "border-brand-500/50 bg-surface-hover",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-surface px-1.5 py-0.5 text-xs text-brand-300">
                    {p.placeholder}
                  </code>
                  <span className="text-xs text-fg-subtle">{p.kind}</span>
                  {p.maxChars ? (
                    <span className="text-xs text-fg-subtle">≤{p.maxChars} chars</span>
                  ) : null}
                  {p.losesInlineMarkup && (
                    <span className="text-xs text-amber-300">drops inline styling</span>
                  )}
                </div>

                {p.originalText && (
                  <p className="text-sm text-fg-muted line-clamp-3">
                    &ldquo;{p.originalText}&rdquo;
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {(["keep", "relabel", "remove"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setDraft(p.placeholder, { action: a })}
                      className={cn(
                        "rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors border",
                        d.action === a
                          ? "border-brand-500 bg-surface text-fg"
                          : "border-border text-fg-muted hover:text-fg",
                      )}
                    >
                      {a}
                    </button>
                  ))}
                  {d.action === "relabel" && (
                    <Input
                      value={d.replacement}
                      onChange={(e) => setDraft(p.placeholder, { replacement: e.target.value })}
                      placeholder="Correct label, e.g. HERO_SUBTITLE"
                      className="h-8 min-w-[14rem] flex-1 text-xs"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {err && <p className="text-sm text-red-400">{err}</p>}
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="gradient" disabled={busy} onClick={save}>
          <Save className="h-4 w-4" /> Save corrections
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={recopy}>
          <RefreshCw className="h-4 w-4" /> Copy the site again
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
          <Trash2 className="h-4 w-4" /> Delete template
        </Button>
      </div>
    </div>
  );
}
