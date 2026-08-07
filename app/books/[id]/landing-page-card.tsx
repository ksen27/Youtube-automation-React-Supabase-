"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Settings {
  enabled: boolean;
  checkoutUrl: string;
  templateUrl: string;
  priceCents: number | null;
  compareAtCents: number | null;
  currency: string;
  guaranteeDays: number;
  engine: string;
}

interface PageState {
  state: string;
  url: string | null;
  error: string | null;
  hasDraft: boolean;
  updatedAt: string;
  isPublishable: boolean;
  blockers: string[];
}

/**
 * The sales landing page for a finished book — a side-car, not a pipeline stage.
 * It is written by its own queue after the book completes, and a failure here
 * never marks the book FAILED (see SIDECAR_QUEUES in the worker factory).
 *
 * Generation and publication are deliberately separate actions: the page is
 * written as a DRAFT and only reaches a public URL when the user publishes it,
 * and only once a checkout URL is set.
 */
export function LandingPageCard({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [publisherConfigured, setPublisherConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [price, setPrice] = useState("");

  // `cancelled` guards every state write: a fetch that resolves after the card
  // unmounts (navigating away mid-request) would otherwise setState on a dead
  // component. Same pattern as the thumbnails poller.
  const load = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const res = await fetch(`/api/books/projects/${projectId}/landing-page`, {
        cache: "no-store",
      });
      if (!res.ok || isCancelled?.()) return;
      const data = await res.json();
      if (isCancelled?.()) return;
      setSettings(data.settings);
      setPage(data.page);
      setCanPublish(Boolean(data.canPublish));
      setPublisherConfigured(Boolean(data.publisherConfigured));
      setCheckoutUrl(data.settings?.checkoutUrl ?? "");
      setPrice(
        typeof data.settings?.priceCents === "number"
          ? (data.settings.priceCents / 100).toFixed(2)
          : "",
      );
    } catch {
      /* leave the card in its previous state */
    }
  }, [projectId]);

  // Declared before the effects that depend on it (and before the early return
  // below, which hooks must not sit after).
  const working = page?.state === "GENERATING" || page?.state === "PUBLISHING";

  // Initial load, plus a poll while the page is being written. One effect rather
  // than two: the poll only exists to re-run the same fetch, and combining them
  // keeps the state writes inside the async callback instead of the effect body.
  //
  // The interval is cleared as soon as the page reaches a settled state, so a
  // finished card is not fetching every 5s for as long as it stays open.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    // Microtask, not a direct call — see the note in the editor's loader: a
    // cache-warm fetch can resolve inside the effect and cascade a render.
    queueMicrotask(() => {
      if (!cancelled) void load(isCancelled);
    });
    if (!working) return () => { cancelled = true; };
    const t = setInterval(() => {
      if (!cancelled) void load(isCancelled);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load, working]);

  async function saveSettings() {
    setBusy(true);
    setErr(null);
    try {
      const cents = Math.round(Number(price) * 100);
      const res = await fetch(`/api/books/projects/${projectId}/landing-page`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutUrl: checkoutUrl.trim(),
          ...(Number.isFinite(cents) && cents > 0 ? { priceCents: cents } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not save");
      else await load();
    } finally {
      setBusy(false);
    }
  }

  async function generate(publish: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/books/projects/${projectId}/landing-page?publish=${publish}`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not start generation");
      else await load();
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/books/projects/${projectId}/landing-page`, { method: "PUT" });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not publish");
      else await load();
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" /> Sales page
        </CardTitle>
        <CardDescription>
          An AI-written sales page for this book. Generated as a draft; publishing
          is a separate step and needs a checkout link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {page && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                page.state === "PUBLISHED"
                  ? "success"
                  : page.state === "FAILED"
                    ? "destructive"
                    : working
                      ? "info"
                      : "secondary"
              }
            >
              {page.state.toLowerCase()}
            </Badge>
            {page.url && (
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-brand-300 hover:underline"
              >
                View page <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {working && <Loader2 className="h-4 w-4 animate-spin text-fg-subtle" />}
          </div>
        )}

        {page?.error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{page.error}</span>
          </div>
        )}

        {page?.blockers && page.blockers.length > 0 && (
          <ul className="space-y-1 text-sm text-amber-300">
            {page.blockers.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="checkoutUrl">Checkout link</Label>
            <Input
              id="checkoutUrl"
              value={checkoutUrl}
              onChange={(e) => setCheckoutUrl(e.target.value)}
              placeholder="https://payhip.com/b/..."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="price">Price ({settings.currency})</Label>
            <Input
              id="price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="19.00"
              inputMode="decimal"
            />
          </div>
        </div>

        {err && (
          <p className="text-sm text-red-400" role="alert">
            {err}
          </p>
        )}

        {!publisherConfigured && (
          <p className="text-xs text-fg-subtle">
            Publishing is unavailable until NETLIFY_AUTH_TOKEN is set. The page can
            still be generated and previewed.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={saveSettings}>
            Save
          </Button>
          <Button variant="outline" size="sm" disabled={busy || working} onClick={() => generate(false)}>
            <RefreshCw className="h-4 w-4" />
            {page?.hasDraft ? "Regenerate" : "Generate"}
          </Button>
          <Button
            size="sm"
            variant="gradient"
            disabled={busy || working || !page?.hasDraft || !canPublish}
            onClick={publish}
          >
            Publish
          </Button>
          {page?.hasDraft && (
            <Button asChild variant="ghost" size="sm">
              <a
                href={`/api/books/projects/${projectId}/landing-page/preview`}
                target="_blank"
                rel="noreferrer"
              >
                Preview
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
