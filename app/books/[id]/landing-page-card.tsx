"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Globe, Image as ImageIcon, Loader2, RefreshCw, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type LandingMode = "single" | "triple";

/** The domain rejects a `triple` page that doesn't name exactly this many others. */
const SIBLING_SLOTS = 2;

interface SiblingSetting {
  projectId: string;
  priceCents: number | null;
  checkoutUrl: string;
}

interface Settings {
  enabled: boolean;
  checkoutUrl: string;
  templateUrl: string;
  templateId: string;
  priceCents: number | null;
  compareAtCents: number | null;
  currency: string;
  guaranteeDays: number;
  engine: string;
  mode: LandingMode;
  siblings: SiblingSetting[];
  bundlePriceCents: number | null;
  bundleCheckoutUrl: string;
  authorPhotoPath: string;
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

interface Candidate {
  projectId: string;
  title: string;
  channelUrl: string;
  sameChannel: boolean;
}

/** A cloned reference site this book's page can be built from. */
interface Template {
  id: string;
  sourceUrl: string;
  name: string | null;
  state: string;
  failureReason: string | null;
  stale: boolean;
}

/** One sibling row's editable state. */
interface SiblingDraft {
  projectId: string;
  price: string;
  checkoutUrl: string;
}

const EMPTY_SIBLING: SiblingDraft = { projectId: "", price: "", checkoutUrl: "" };

const centsToInput = (c: number | null): string => (typeof c === "number" ? (c / 100).toFixed(2) : "");

/** "19", "19.00" → 1900. Returns null for blank or unparseable input. */
function parsePrice(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

const isHttpUrl = (v: string): boolean => /^https?:\/\//i.test(v.trim());

/**
 * The sales landing page for a finished book — a side-car, not a pipeline stage.
 * It is written by its own queue after the book completes, and a failure here
 * never marks the book FAILED (see SIDECAR_QUEUES in the worker factory).
 *
 * TWO PAGE SHAPES, per the client's templates:
 *   single — this book alone.
 *   triple — this book plus exactly two other FINISHED books, each with its own
 *            price and checkout link, plus an optional bundle price/link for all
 *            three together.
 * The domain enforces the "exactly two" rule and refuses to quietly render a
 * misconfigured triple as a single, so the form validates it before saving.
 *
 * Generation and publication are deliberately separate actions: the page is
 * written as a DRAFT and only reaches a public URL when the user publishes it,
 * and only once every product on it has a checkout link.
 */
export function LandingPageCard({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [publisherConfigured, setPublisherConfigured] = useState(false);
  const [missingCheckout, setMissingCheckout] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // This book's own fields.
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [price, setPrice] = useState("");

  // Triple-mode fields.
  const [mode, setMode] = useState<LandingMode>("single");
  const [siblings, setSiblings] = useState<SiblingDraft[]>([EMPTY_SIBLING, EMPTY_SIBLING]);
  const [bundlePrice, setBundlePrice] = useState("");
  const [bundleUrl, setBundleUrl] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  // The author portrait. Stored (not embedded) so it survives regeneration —
  // the page reads it back from the saved path each time it is written.
  const [photoPath, setPhotoPath] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Master switch. Defaults to FALSE in the domain (landingPage in
  // SubmitChannel.dto.ts), and BOTH engines refuse outright with "Landing page
  // is not enabled for this project" until it is on — so it must be settable
  // here, not merely readable.
  const [enabled, setEnabled] = useState(false);

  // The reference site. TWO different mechanisms, deliberately kept apart in the
  // UI because they produce very different pages:
  //   templateId  → the CLONE engine: the page IS that site with our content
  //                 swapped in. This is what "make it look like the sample"
  //                 means, and it requires cloning the site first.
  //   templateUrl → the BUILT-IN renderer reads that page for its section
  //                 STRUCTURE and writes our own design from it.
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateUrl, setTemplateUrl] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [attest, setAttest] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState<string | null>(null);

  const load = useCallback(async (isCancelled?: () => boolean) => {
    try {
      const [sRes, cRes, tRes] = await Promise.all([
        fetch(`/api/books/projects/${projectId}/landing-page`, { cache: "no-store" }),
        fetch(`/api/books/projects/${projectId}/landing-page/candidates`, { cache: "no-store" }),
        fetch(`/api/books/landing-templates`, { cache: "no-store" }),
      ]);
      if (!sRes.ok || isCancelled?.()) return;
      const data = await sRes.json();
      const cData = cRes.ok ? await cRes.json() : { candidates: [] };
      const tData = tRes.ok ? await tRes.json() : { templates: [] };
      if (isCancelled?.()) return;

      const s: Settings = data.settings;
      setSettings(s);
      setPage(data.page);
      setCanPublish(Boolean(data.canPublish));
      setPublisherConfigured(Boolean(data.publisherConfigured));
      setMissingCheckout(data.missingCheckoutPositions ?? []);
      setCheckoutUrl(s.checkoutUrl ?? "");
      setPrice(centsToInput(s.priceCents));
      setMode(s.mode ?? "single");
      setBundlePrice(centsToInput(s.bundlePriceCents));
      setBundleUrl(s.bundleCheckoutUrl ?? "");
      setPhotoPath(s.authorPhotoPath ?? "");
      setEnabled(Boolean(s.enabled));
      setTemplateId(s.templateId ?? "");
      setTemplateUrl(s.templateUrl ?? "");
      setTemplates(tData.templates ?? []);
      setSiblings(
        Array.from({ length: SIBLING_SLOTS }, (_, i) => {
          const saved = s.siblings?.[i];
          return saved
            ? { projectId: saved.projectId, price: centsToInput(saved.priceCents), checkoutUrl: saved.checkoutUrl ?? "" }
            : EMPTY_SIBLING;
        }),
      );
      setCandidates(cData.candidates ?? []);
    } catch {
      /* leave the card in its previous state */
    }
  }, [projectId]);

  const working = page?.state === "GENERATING" || page?.state === "PUBLISHING";

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
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

  function updateSibling(i: number, patch: Partial<SiblingDraft>) {
    setSiblings((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  /**
   * Upload the author portrait.
   *
   * Sent as multipart form-data with a `file` field — the route sniffs the
   * actual bytes for a PNG/JPEG/WebP signature rather than trusting the
   * filename or content-type, so there is no point pre-filtering here beyond
   * giving the file picker a sensible `accept`.
   */
  async function uploadPhoto(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/books/projects/${projectId}/landing-page/avatar`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not upload that photo");
      else setPhotoPath(data.path ?? "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not upload that photo");
    } finally {
      setUploading(false);
      // Let the same file be picked again after a failure.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /**
   * Clone a reference site so this book's page can be built from it.
   *
   * Queued, not inline: extraction drives a real browser, takes six full-height
   * screenshots and sweeps the site's assets. The new template appears in the
   * list as EXTRACTING and becomes selectable once it is READY.
   *
   * `attestOwnership` is required by the API and is not a formality — this makes
   * a COMPLETE copy of someone's page, which is a different act from taking
   * design inspiration, and not a call the system can make for the seller.
   */
  async function cloneTemplate(): Promise<string | null> {
    const url = cloneUrl.trim();
    if (!url) { setErr("Paste the URL of the page to copy."); return null; }
    if (!isHttpUrl(url)) { setErr("The template URL must be a full URL (https://…)."); return null; }
    if (!attest) { setErr("Confirm you have the right to copy that page."); return null; }
    setCloning(true);
    setErr(null);
    setCloneMsg(null);
    try {
      const res = await fetch(`/api/books/landing-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url, attestOwnership: true, force: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not start the copy");
        return null;
      }
      // Select it immediately: an already-extracted template is usable now, and
      // a queued one becomes usable when it finishes.
      if (data.templateId) setTemplateId(data.templateId);
      // SAY WHAT HAPPENED. Re-copying a URL that is already READY returns the
      // existing template instantly and enqueues nothing — correct (a second
      // Chromium capture of the same page is wasted work), but with no message
      // the button looks broken and there is no worker log to explain it.
      setCloneMsg(
        data.alreadyExtracted
          ? "That site was already copied — selected it above."
          : "Copying that site now. It appears in the list above when it is ready.",
      );
      setAttest(false);
      await load();
      return data.templateId ?? null;
    } finally {
      setCloning(false);
    }
  }

  async function removePhoto() {
    setUploading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/books/projects/${projectId}/landing-page/avatar`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErr(data.error ?? "Could not remove the photo");
      } else {
        setPhotoPath("");
      }
    } finally {
      setUploading(false);
    }
  }

  /**
   * Persist the form. Returns false when validation or the request failed, so
   * callers that need the settings STORED before they act (generate, publish)
   * can stop rather than run against stale values.
   */
  async function saveSettings(
    // Explicit overrides. React state updates are asynchronous, so a value set
    // by the caller a moment ago (a freshly-copied templateId, the enable flag)
    // is not yet readable from state here and must be passed in.
    override: { enabled?: boolean; templateId?: string } = {},
  ): Promise<boolean> {
    setBusy(true);
    setErr(null);
    try {
      // Validate before sending: the domain rejects a triple with the wrong
      // sibling count outright, and a 422 after the fact is a worse experience
      // than saying which field is wrong.
      const chosen = mode === "triple" ? siblings.filter((s) => s.projectId) : [];
      if (mode === "triple") {
        if (chosen.length < SIBLING_SLOTS) {
          setErr(`A 3-book page needs exactly ${SIBLING_SLOTS} other finished books selected.`);
          return false;
        }
        if (new Set(chosen.map((s) => s.projectId)).size !== chosen.length) {
          setErr("Pick two different books.");
          return false;
        }
        if (bundleUrl.trim() && !isHttpUrl(bundleUrl)) {
          setErr("The bundle checkout link must be a full URL (https://…).");
          return false;
        }
      }
      if (checkoutUrl.trim() && !isHttpUrl(checkoutUrl)) {
        setErr("The checkout link must be a full URL (https://…).");
        return false;
      }

      const ownCents = parsePrice(price);
      const bundleCents = parsePrice(bundlePrice);
      const res = await fetch(`/api/books/projects/${projectId}/landing-page`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // NOTE the `landing` prefix on BOTH of these. The DTO's fields are
          // landingCheckoutUrl / landingPriceCents; sending the bare names is
          // not an error — Zod strips unknown keys silently — it just means the
          // checkout link and price were never saved at all.
          landingCheckoutUrl: checkoutUrl.trim(),
          ...(ownCents !== null ? { landingPriceCents: ownCents } : {}),
          landingPage: override.enabled ?? enabled,
          landingTemplateId: override.templateId ?? templateId,
          landingTemplateUrl: templateUrl.trim(),
          landingMode: mode,
          landingSiblings: chosen.map((s) => {
            const cents = parsePrice(s.price);
            return {
              projectId: s.projectId,
              checkoutUrl: s.checkoutUrl.trim(),
              ...(cents !== null ? { priceCents: cents } : {}),
            };
          }),
          ...(mode === "triple" && bundleCents !== null ? { landingBundlePriceCents: bundleCents } : {}),
          ...(mode === "triple" ? { landingBundleCheckoutUrl: bundleUrl.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Could not save");
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  /**
   * The one action: make the page.
   *
   * Does the whole sequence so the user does not have to know it exists —
   * copy the reference site if one was pasted, turn the sales page on, persist
   * the settings, then enqueue the render. The settings live on the project row
   * and the WORKER reads that row rather than this form, which is why the save
   * is not optional: skipping it silently generated against the old values.
   */
  async function generate(publish: boolean) {
    const pasted = cloneUrl.trim();
    let useTemplateId = templateId;

    if (pasted) {
      if (!isHttpUrl(pasted)) return setErr("That does not look like a full URL (https://…).");
      if (!attest) return setErr("Confirm you have the right to copy that page.");
      // Returns the template id: instantly for a URL already copied, or the id
      // of the job just queued. Either way the settings below can reference it.
      const id = await cloneTemplate();
      if (!id) return; // cloneTemplate already reported why
      useTemplateId = id;
      setTemplateId(id);
      setCloneUrl("");
    }

    // Generating IS asking for the page, so enabling it needs no separate tick.
    setEnabled(true);
    // Overrides passed explicitly: the two setState calls above are async and
    // are not readable from state inside saveSettings on this tick.
    if (!(await saveSettings({ enabled: true, templateId: useTemplateId }))) return;

    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/books/projects/${projectId}/landing-page?publish=${publish}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setErr(data.error ?? "Could not start generation");
      else await load();
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    // Same reasoning as generate(): publishing checks the STORED checkout links.
    if (!(await saveSettings())) return;
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

  // A sibling must be a DIFFERENT finished book, so exclude the other slot's pick.
  const optionsFor = (i: number) =>
    candidates.filter((c) => !siblings.some((s, j) => j !== i && s.projectId === c.projectId));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" /> Sales page
        </CardTitle>
        <CardDescription>
          An AI-written sales page for this book. Generated as a draft; publishing
          is a separate step and needs a checkout link for every product on it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {page && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                page.state === "PUBLISHED" ? "success"
                : page.state === "FAILED" ? "destructive"
                : working ? "info"
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

        {/* ── design ─────────────────────────────────────────────────────────
            ONE control. Paste the page to copy and press Generate; everything
            else — enabling the sales page, copying the site, saving the
            settings — happens behind that single action.

            It used to be six steps (tick enable → paste → tick attest → Copy
            site → wait → select → Save → Generate), which is how a user ended
            up with a page that would not generate and no indication why. */}
        <div className="space-y-3">
          <Label htmlFor="cloneUrl">Copy a site&apos;s design</Label>
          <Input
            id="cloneUrl"
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://the-page-to-copy.com"
          />
          <p className="text-xs text-fg-subtle">
            Your page will look like that page — same layout, fonts and colours,
            with your book&apos;s words in place of theirs. Leave blank to use the
            built-in design.
          </p>

          {/* The attestation cannot be assumed: this makes a COMPLETE copy of
              someone's page, the API requires it explicitly, and it is recorded.
              Shown only when a URL is actually entered, so the built-in path
              carries no legal furniture it does not need. */}
          {cloneUrl.trim() && (
            <label className="flex items-start gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={attest}
                onChange={(e) => setAttest(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-[var(--color-brand-500)]"
              />
              I have the right to copy this page&apos;s design.
            </label>
          )}

          {/* Previously-copied sites, so a second book can reuse one without
              waiting for another capture. Hidden until there are any. */}
          {templates.length > 0 && !cloneUrl.trim() && (
            <div className="space-y-1.5">
              <Label htmlFor="templatePick" className="text-xs">
                Or reuse a design you already copied
              </Label>
              <select
                id="templatePick"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              >
                <option value="">Built-in design</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.state !== "READY"}>
                    {t.name?.trim() || t.sourceUrl}
                    {t.state !== "READY" ? ` — ${t.state.toLowerCase()}…` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {templates.find((t) => t.id === templateId)?.failureReason && (
            <p className="text-xs text-amber-300">
              {templates.find((t) => t.id === templateId)?.failureReason}
            </p>
          )}
          {cloneMsg && <p className="text-xs text-emerald-400">{cloneMsg}</p>}
        </div>

        {/* ── page shape ─────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label>Page type</Label>
          <div className="flex gap-2">
            {([
              { value: "single" as const, label: "1 book", hint: "This book alone" },
              { value: "triple" as const, label: "3 books", hint: "This book + 2 others" },
            ]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                  mode === opt.value
                    ? "border-brand-500 bg-surface-hover"
                    : "border-border hover:bg-surface-hover",
                )}
              >
                <div className="text-sm font-medium text-fg">{opt.label}</div>
                <div className="text-xs text-fg-subtle">{opt.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {/* ── this book ──────────────────────────────────────────────────── */}
        <div className="space-y-3">
          {mode === "triple" && (
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Book 1 — this book</p>
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
        </div>

        {/* ── author portrait ────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label>Author photo</Label>
          <div className="flex flex-wrap items-center gap-3">
            {photoPath ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-fg-muted">
                <ImageIcon className="h-3.5 w-3.5" />
                Photo uploaded
              </span>
            ) : (
              <span className="text-xs text-fg-subtle">
                Optional — the page simply shows no portrait without one.
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadPhoto(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading || busy}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {photoPath ? "Replace" : "Upload"}
            </Button>
            {photoPath && (
              <Button type="button" variant="ghost" size="sm" disabled={uploading || busy} onClick={removePhoto}>
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-fg-subtle">PNG, JPEG or WebP, up to 5MB.</p>
        </div>

        {/* ── the other two books ────────────────────────────────────────── */}
        {mode === "triple" && (
          <div className="space-y-5">
            {candidates.length < SIBLING_SLOTS && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                A 3-book page needs {SIBLING_SLOTS} other FINISHED books;{" "}
                {candidates.length === 0 ? "none are" : `only ${candidates.length} is`} available so far.
              </p>
            )}
            {siblings.map((sib, i) => (
              <div key={i} className="space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Book {i + 2}</p>
                <select
                  value={sib.projectId}
                  onChange={(e) => updateSibling(i, { projectId: e.target.value })}
                  className="flex h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                >
                  <option value="">Select a finished book…</option>
                  {optionsFor(i).map((c) => (
                    <option key={c.projectId} value={c.projectId}>
                      {c.title}
                      {c.sameChannel ? " (same channel)" : ""}
                    </option>
                  ))}
                </select>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`sib-url-${i}`}>Checkout link</Label>
                    <Input
                      id={`sib-url-${i}`}
                      value={sib.checkoutUrl}
                      onChange={(e) => updateSibling(i, { checkoutUrl: e.target.value })}
                      placeholder="https://payhip.com/b/..."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`sib-price-${i}`}>Price ({settings.currency})</Label>
                    <Input
                      id={`sib-price-${i}`}
                      value={sib.price}
                      onChange={(e) => updateSibling(i, { price: e.target.value })}
                      placeholder="19.00"
                      inputMode="decimal"
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
                Bundle — all three together (optional)
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="bundleUrl">Bundle checkout link</Label>
                  <Input
                    id="bundleUrl"
                    value={bundleUrl}
                    onChange={(e) => setBundleUrl(e.target.value)}
                    placeholder="https://payhip.com/b/..."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bundlePrice">Bundle price ({settings.currency})</Label>
                  <Input
                    id="bundlePrice"
                    value={bundlePrice}
                    onChange={(e) => setBundlePrice(e.target.value)}
                    placeholder="47.00"
                    inputMode="decimal"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {err && (
          <p className="text-sm text-red-400" role="alert">
            {err}
          </p>
        )}

        {missingCheckout.length > 0 && (
          <p className="text-xs text-amber-300">
            {missingCheckout.length === 1 ? "Book" : "Books"} {missingCheckout.join(", ")} still{" "}
            {missingCheckout.length === 1 ? "needs a" : "need"} checkout {missingCheckout.length === 1 ? "link" : "links"} before publishing.
          </p>
        )}

        {!publisherConfigured && (
          <p className="text-xs text-fg-subtle">
            Publishing is unavailable until NETLIFY_AUTH_TOKEN is set. The page can
            still be generated and previewed.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {/* No Save button: Generate and Publish both persist first. A separate
              Save was a step users reasonably skipped, and skipping it generated
              against stale settings with a confusing error. */}
          <Button
            size="sm"
            variant={page?.hasDraft ? "outline" : "gradient"}
            disabled={busy || working || cloning}
            onClick={() => generate(false)}
          >
            {busy || cloning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {cloning ? "Copying site…" : page?.hasDraft ? "Regenerate" : "Generate page"}
          </Button>
          <Button
            size="sm"
            variant="outline"
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
