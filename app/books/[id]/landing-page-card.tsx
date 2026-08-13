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

/**
 * How long a GENERATING/PUBLISHING row is believed before the card treats it as
 * abandoned. Mirrors the stale guard in the POST route, deliberately — if the
 * API would accept a fresh run, the button must not still be disabled.
 */
const STALE_RUN_MS = 10 * 60_000;

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
 * One entry per copied SITE, not per extraction attempt.
 *
 * The API returns every row, and a re-copy inserts a NEW row rather than
 * overwriting: the extract route only hands back an existing template when it
 * is READY (landing-templates/route.ts), so every failed or abandoned attempt
 * on a URL leaves a row behind. Until extraction succeeds those rows have no
 * name and are labelled by their source URL, so the dropdown filled up with
 * several identical-looking entries for the one site the user copied.
 *
 * Which row of a group survives: the newest READY one, else the newest of the
 * rest — so a site still EXTRACTING, or one that failed with its reason, stays
 * visible. `templates` arrives newest-first, so "newest" is simply "first seen".
 *
 * The SELECTED row is kept too when it is not that survivor, and this is not a
 * nicety. Re-copying a site mints a NEW template id rather than overwriting the
 * old one, and nothing re-points the project at it, so after a re-copy the
 * project still names the previous capture. Preferring the selected row hid the
 * new one completely: the seller re-copied to pick up better labelling,
 * regenerated, and got the old labelling back with no way to see why. The
 * superseded row is marked so the two are told apart.
 */
function dedupeBySource(list: Template[], selectedId: string): Array<Template & { superseded?: boolean }> {
  const chosen = new Map<string, Template>();
  for (const t of list) {
    const prev = chosen.get(t.sourceUrl);
    if (!prev) { chosen.set(t.sourceUrl, t); continue; }
    if (prev.state !== "READY" && t.state === "READY") chosen.set(t.sourceUrl, t);
  }
  return list
    .filter((t) => chosen.get(t.sourceUrl)?.id === t.id || t.id === selectedId)
    .map((t) => (chosen.get(t.sourceUrl)?.id === t.id ? t : { ...t, superseded: true }));
}

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
  const [publisherConfigured, setPublisherConfigured] = useState(false);
  // See `working` below: a GENERATING/PUBLISHING row whose run never reported back.
  const [stalled, setStalled] = useState(false);
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
  /**
   * Which engine builds the page. Defaults to "style" for a project that has
   * not chosen — the reliable path, and the one the sibling project ships
   * exclusively. A project already on a cloned template stays on "exact" so
   * opening the card never silently changes how its page is built.
   */
  const [design, setDesign] = useState<"style" | "exact">("style");
  const [templates, setTemplates] = useState<Array<Template & { superseded?: boolean }>>([]);
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
      setStalled(
        data.page ? Date.now() - new Date(data.page.updatedAt).getTime() > STALE_RUN_MS : false,
      );
      setPublisherConfigured(Boolean(data.publisherConfigured));
      setCheckoutUrl(s.checkoutUrl ?? "");
      setPrice(centsToInput(s.priceCents));
      setMode(s.mode ?? "single");
      setBundlePrice(centsToInput(s.bundlePriceCents));
      setBundleUrl(s.bundleCheckoutUrl ?? "");
      setPhotoPath(s.authorPhotoPath ?? "");
      setEnabled(Boolean(s.enabled));
      setTemplateId(s.templateId ?? "");
      setTemplateUrl(s.templateUrl ?? "");
      // The stored settings ARE the engine choice — `templateId` set means the
      // clone engine runs — so the toggle reads from them rather than keeping a
      // second copy of the truth that could disagree with the server.
      setDesign(s.templateId ? "exact" : "style");
      setTemplates(dedupeBySource(tData.templates ?? [], s.templateId ?? ""));
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

  /**
   * A run this card should wait for, as opposed to one that never finished.
   *
   * GENERATING/PUBLISHING live on the landing_pages row, and a worker that dies
   * mid-run (a redeploy during a publish is the easy way to see it) leaves the
   * row in that state permanently — which disabled BOTH buttons with no way
   * back, because the row says a run is in flight and nothing ever contradicts
   * it. The POST route already stops believing such a row after ten minutes; the
   * card has to agree or the page is stuck for good.
   *
   * `stalled` is evaluated when the row is FETCHED, not during render: a clock read
   * in render is impure (react-hooks/purity) and would make the verdict depend
   * on unrelated re-renders. The five-second poll re-evaluates it while a run is
   * genuinely live, which is exactly when it can change.
   */
  const working = (page?.state === "GENERATING" || page?.state === "PUBLISHING") && !stalled;

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
    // "Design it in a site's style" builds nothing first — the reference is
    // fetched and photographed inside the generation job. The template id is
    // cleared EXPLICITLY: it is what selects the clone engine server-side, so a
    // project switching over with an old template still stored would otherwise
    // keep cloning while the card showed a reference URL.
    if (design === "style") {
      const reference = templateUrl.trim();
      if (reference && !isHttpUrl(reference)) {
        return setErr("The reference page must be a full URL (https://…).");
      }
      setTemplateId("");
      setEnabled(true);
      if (!(await saveSettings({ enabled: true, templateId: "" }))) return;
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
      return;
    }

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

  /**
   * Which books on this page have no buy link, as 1-based positions — computed
   * from the FORM, not from the saved project.
   *
   * The server's `missingCheckoutPositions` reads the STORED values, and the
   * form's only two persistence paths are Generate and Publish itself. Gating
   * the Publish button on the stored list therefore deadlocks anyone who typed
   * their checkout link and did not regenerate: the button that would save it is
   * the button the missing value disables, and the amber warning kept naming a
   * field that was visibly filled in. `publish()` calls saveSettings() before it
   * PUTs, so the form is the honest signal here — and the use case still refuses
   * outright if the value somehow never landed.
   */
  const missingCheckoutHere = [
    ...(checkoutUrl.trim() ? [] : [1]),
    ...(mode === "triple" ? siblings.flatMap((s, i) => (s.checkoutUrl.trim() ? [] : [i + 2])) : []),
  ];
  // Everything that must be true before a draft may go live, EXCEPT the stored
  // checkout links (above). Verification is NOT part of it — see
  // markPublishing(); the seller reviews the rendered page and decides. The two
  // gates left are the ones no review can satisfy: no token, no buy link.
  const publishBlocked = !publisherConfigured || missingCheckoutHere.length > 0;

  /**
   * Why Publish is greyed out, in the order the user has to fix them.
   *
   * A disabled button with no explanation is indistinguishable from a broken
   * one: every gate below lives somewhere else (an env var on the server, a
   * field further up this form, a verification verdict on the draft, a queue
   * job), and a seller looking at the button has no way to tell which. Rendered
   * beside the button rather than logged.
   */
  const publishHint =
    working ? "A run is in progress — this becomes available when it finishes."
    : !page?.hasDraft ? "Generate the page before publishing it."
    : !publisherConfigured ? "Publishing needs NETLIFY_AUTH_TOKEN set for the web app, not only the worker."
    : missingCheckoutHere.length > 0
      ? `Add a checkout link for ${missingCheckoutHere.length === 1 ? "book" : "books"} ${missingCheckoutHere.join(", ")}.`
    : null;

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
            {/* Says out loud why a row reading "generating"/"publishing" is not
                spinning: nothing is running, the run just never reported back. */}
            {stalled && (page.state === "GENERATING" || page.state === "PUBLISHING") && (
              <span className="text-xs text-amber-300">
                this run stopped without finishing — start it again
              </span>
            )}
          </div>
        )}

        {page?.error && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{page.error}</span>
          </div>
        )}

        {/* The verification findings are NOT shown. They stopped gating the
            publish, and as advice they were wrong often enough to be noise: the
            page renders correctly and the report still named an empty FAQ
            repeater and 18% "drift" against the template. The API still returns
            `blockers`, and the worker still logs them, so a real regression
            across several books is still visible where it belongs. */}

        {/* ── design ─────────────────────────────────────────────────────────
            TWO engines, and until now only the riskier one was reachable.

            "style"  → GenerateLandingPageUseCase. The reference is fetched and
                       photographed, and the model writes our own markup from
                       its headings, CSS, type treatment and screenshots. No
                       node labelling, no asset re-hosting, no repeater binding,
                       no markup contract — the four stages every extraction
                       failure has come from. The sibling ebookgenerator project
                       ships ONLY this, which is why it copies sites reliably.
            "exact"  → the clone engine: that page's own markup with our content
                       swapped in. Pixel-faithful when it works, and it is the
                       only way to get a replica, so it stays — as a choice
                       someone makes rather than the only road.

            The engine is chosen server-side by `landingTemplateId ? clone :
            builtin`, so picking "style" must CLEAR that id — which is why
            generate() passes an explicit override rather than leaving a stale
            template selected underneath a reference URL. */}
        <div className="space-y-3">
          <Label>How should this page look?</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            {([
              {
                value: "style" as const,
                label: "Design it in a site's style",
                hint: "Recommended — reliable, and looks like that site",
              },
              {
                value: "exact" as const,
                label: "Copy a page exactly",
                hint: "A replica of that page. Can fail on complex sites",
              },
            ]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDesign(opt.value)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                  design === opt.value
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

        {design === "style" && (
          <div className="space-y-3">
            <Label htmlFor="referenceUrl">Reference page to copy the layout from</Label>
            <Input
              id="referenceUrl"
              value={templateUrl}
              onChange={(e) => setTemplateUrl(e.target.value)}
              placeholder="https://the-page-to-follow.com"
              inputMode="url"
            />
            <p className="text-xs text-fg-subtle">
              That page is read and photographed, and your page is built to follow
              it — same section order, palette and type treatment, written around
              your book. Not a pixel copy, and nothing of theirs is republished.
              Leave blank for the built-in design.
            </p>
          </div>
        )}

        {design === "exact" && (
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
                    {/* Named, because "the same site twice" is otherwise
                        indistinguishable and picking the wrong one regenerates
                        against the labelling the re-copy was meant to replace. */}
                    {t.superseded ? " — older copy" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* The re-copy trap: a forced re-copy mints a new template and leaves
              this project on the old one, so regenerating quietly rebuilds the
              page from the labelling that was just replaced. */}
          {templates.find((t) => t.id === templateId)?.superseded && (
            <p className="text-xs text-amber-300">
              You copied this site again since this page was built. Pick the newer
              copy above and regenerate to use its labelling.
            </p>
          )}

          {templates.find((t) => t.id === templateId)?.failureReason && (
            <p className="text-xs text-amber-300">
              {templates.find((t) => t.id === templateId)?.failureReason}
            </p>
          )}
          {/* A cloned page only replaces what the extractor TAGGED; untagged text
              ships as the reference wrote it. This is where that gets fixed. */}
          {templateId && (
            <a
              href={`/books/templates/${templateId}`}
              className="inline-block text-xs text-brand-300 hover:underline"
            >
              Review what this design replaces →
            </a>
          )}
          {cloneMsg && <p className="text-xs text-emerald-400">{cloneMsg}</p>}
        </div>
        )}

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

        {/* The two standing notes that used to live here — "book N needs a
            checkout link" and "NETLIFY_AUTH_TOKEN is not set" — are now part of
            publishHint below, next to the button they explain. Two places saying
            the same thing let them disagree. */}

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
            disabled={busy || working || !page?.hasDraft || publishBlocked}
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

        {publishHint && <p className="text-xs text-amber-300">Publish: {publishHint}</p>}
      </CardContent>
    </Card>
  );
}
