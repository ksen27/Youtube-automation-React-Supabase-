"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Image as ImageIcon, LayoutTemplate, Loader2, Plus, Sparkles, Upload, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// The /thumbnails feature is a TWO-STEP flow:
//   1. Analyze a channel  -> Gemini learns its style (saved, reusable).
//   2. Generate           -> pick a saved channel, type the title, optionally
//                            add 1–2 subject images, review/edit the auto-built
//                            prompt, then render via Pikzels.
// This component owns both steps and the saved-channel picker.

export interface ChannelRow {
  id: string;
  channel_input: string;
  channel_id: string;
  channel_title: string;
  style_prompt: string;
  sample_urls: string[];
  created_at: string;
}

// Up to 2 subject images (celebrity/person or AI avatar). Each is a pasted
// YouTube/image URL or an uploaded image (re-hosted to R2 → becomes a URL).
const MAX_SUBJECTS = 2;

// Up to 3 uploaded example images teaching a SPECIFIC thumbnail FORMAT/layout
// (e.g. a two-celebrity split, a breaking-news banner). Optional: when used, the
// tool learns that exact layout and generates in it instead of the averaged
// channel style. Kept in sync with MAX_FORMAT_IMAGES on the server.
const MAX_FORMAT_IMAGES = 3;

interface Subject {
  id: number;
  url: string;
  uploading: boolean;
}
let nextId = 1;
const newSubject = (): Subject => ({ id: nextId++, url: "", uploading: false });

// A single uploaded format example. url is the R2 URL once the upload finishes.
interface FormatImage {
  id: number;
  url: string;
  uploading: boolean;
}
const newFormatImage = (): FormatImage => ({ id: nextId++, url: "", uploading: false });

export function NewThumbnailForm({ channels: initialChannels }: { channels: ChannelRow[] }) {
  const router = useRouter();
  const [channels, setChannels] = useState<ChannelRow[]>(initialChannels);

  // Step 1 — analyze.
  const [channelInput, setChannelInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);

  // Step 2 — generate.
  const [selectedId, setSelectedId] = useState<string | null>(initialChannels[0]?.id ?? null);
  const [title, setTitle] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [subjects, setSubjects] = useState<Subject[]>([newSubject()]);
  // Optional format examples (learn a specific layout). Off by default; the user
  // opts in via the "Use a specific format" toggle.
  const [useFormat, setUseFormat] = useState(false);
  const [formatImages, setFormatImages] = useState<FormatImage[]>([newFormatImage()]);
  const [prompt, setPrompt] = useState("");
  // Non-error notice about the last build (e.g. AI fallback / format not learned).
  const [notice, setNotice] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({});
  const formatFileInputs = useRef<Record<number, HTMLInputElement | null>>({});

  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const filledSubjects = subjects.filter((s) => s.url.trim().length > 0);
  const filledFormatImages = formatImages.filter((f) => f.url.trim().length > 0);
  const anyUploading =
    subjects.some((s) => s.uploading) || formatImages.some((f) => f.uploading);

  // ----- Step 1: analyze a channel -----
  // `force` re-learns the style even if the channel is already saved (spends
  // quota); the default reuses a saved channel for free.
  async function analyzeChannel(input: string, force: boolean) {
    if (!input.trim() || analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: input.trim(), force }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Analyze failed (${r.status})`);
      const ch = json.channel as ChannelRow;
      setChannels((cs) => [ch, ...cs.filter((c) => c.id !== ch.id)]);
      setSelectedId(ch.id);
      setChannelInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analyze failed");
    } finally {
      setAnalyzing(false);
    }
  }

  function onAnalyze(e: React.FormEvent) {
    e.preventDefault();
    analyzeChannel(channelInput, false);
  }

  // Persist an edited style prompt back to the channel.
  async function saveStylePrompt(id: string, style_prompt: string) {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, style_prompt } : c)));
    try {
      await fetch("/api/thumbnails/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, style_prompt }),
      });
    } catch {
      // best-effort; the in-memory edit still applies to this session
    }
  }

  // ----- subject image rows -----
  function updateSubject(id: number, patch: Partial<Subject>) {
    setSubjects((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function addSubject() {
    setSubjects((ss) => (ss.length >= MAX_SUBJECTS ? ss : [...ss, newSubject()]));
  }
  function removeSubject(id: number) {
    setSubjects((ss) => (ss.length <= 1 ? [newSubject()] : ss.filter((s) => s.id !== id)));
  }
  async function onUpload(id: number, file: File) {
    setError(null);
    updateSubject(id, { uploading: true });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/thumbnails/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? `Upload failed (${r.status})`);
      const { url } = await r.json();
      updateSubject(id, { url, uploading: false });
    } catch (err) {
      updateSubject(id, { uploading: false });
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  // ----- format example images (optional) -----
  function updateFormatImage(id: number, patch: Partial<FormatImage>) {
    setFormatImages((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  function addFormatImage() {
    setFormatImages((fs) => (fs.length >= MAX_FORMAT_IMAGES ? fs : [...fs, newFormatImage()]));
  }
  function removeFormatImage(id: number) {
    setFormatImages((fs) => (fs.length <= 1 ? [newFormatImage()] : fs.filter((f) => f.id !== id)));
  }
  async function onUploadFormat(id: number, file: File) {
    setError(null);
    updateFormatImage(id, { uploading: true });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/thumbnails/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? `Upload failed (${r.status})`);
      const { url } = await r.json();
      updateFormatImage(id, { url, uploading: false });
    } catch (err) {
      updateFormatImage(id, { uploading: false });
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  // ----- Step 2a: build the editable prompt -----
  async function onBuildPrompt() {
    if (!selectedId || !title.trim() || building || anyUploading) return;
    setBuilding(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/thumbnails/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: selectedId,
          title: title.trim(),
          customPrompt: customPrompt.trim(),
          subjects: filledSubjects.map((s) => s.url.trim()),
          formatImages: useFormat ? filledFormatImages.map((f) => f.url.trim()) : [],
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Build failed (${r.status})`);
      setPrompt(json.prompt as string);

      // Surface build caveats so a title-less/format-less copy is never mistaken
      // for a real AI build (the original "it just copies the style" bug).
      const notices: string[] = [];
      if (json.usedFallback) {
        notices.push(
          json.fallbackReason === "gemini_not_configured"
            ? "AI prompt-writing is not configured, so the title was not applied — this is just the channel style. Set GEMINI_API_KEY."
            : "AI prompt-writing failed, so the title was not woven in (this is a fallback). Try Build prompt again.",
        );
      }
      if (json.formatFailed) {
        notices.push("Couldn't read the uploaded format images — the chosen format was not applied.");
      }
      setNotice(notices.length ? notices.join(" ") : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build prompt");
    } finally {
      setBuilding(false);
    }
  }

  // ----- Step 2b: generate -----
  async function onGenerate() {
    if (!selectedId || !title.trim() || !prompt.trim() || anyUploading || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: selectedId,
          title: title.trim(),
          prompt: prompt.trim(),
          subjects: filledSubjects.map((s) => s.url.trim()),
        }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? `Generate failed (${r.status})`);
      // Reset the generate inputs and refresh the gallery.
      setTitle("");
      setCustomPrompt("");
      setSubjects([newSubject()]);
      setFormatImages([newFormatImage()]);
      setUseFormat(false);
      setPrompt("");
      setNotice(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Step 1 — analyze a channel */}
      <form onSubmit={onAnalyze} className="space-y-2">
        <Label htmlFor="channel">1. Learn a channel&apos;s style</Label>
        <div className="flex items-center gap-2">
          <Input
            id="channel"
            value={channelInput}
            onChange={(e) => setChannelInput(e.target.value)}
            placeholder="YouTube channel URL or @handle"
            disabled={analyzing}
          />
          <Button type="submit" variant="outline" disabled={!channelInput.trim() || analyzing}>
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {analyzing ? "Analyzing…" : "Analyze"}
          </Button>
        </div>
        <p className="text-xs text-fg-subtle">
          We read the channel&apos;s recent thumbnails and learn its style. Saved and reusable.
        </p>
      </form>

      {channels.length === 0 ? (
        <p className="text-sm text-fg-muted">Analyze a channel above to get started.</p>
      ) : (
        <>
          {/* Saved channel picker */}
          <div className="space-y-2">
            <Label>2. Pick a channel</Label>
            <div className="flex flex-wrap gap-2">
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className={`rounded-full border px-3 h-8 text-xs font-medium transition-colors ${
                    c.id === selectedId
                      ? "border-brand-400 bg-brand-500/15 text-brand-200"
                      : "border-border text-fg-muted hover:bg-surface-hover"
                  }`}
                  title={c.channel_input}
                >
                  {c.channel_title || c.channel_input}
                </button>
              ))}
            </div>
          </div>

          {selected && (
            <>
              {/* Style prompt (editable, saved to the channel) + sample thumbnails */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="style">Channel style prompt (editable)</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={analyzing}
                    onClick={() => analyzeChannel(selected.channel_input, true)}
                    title="Re-learn this channel's style from its latest thumbnails (uses quota)"
                  >
                    {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    Re-analyze
                  </Button>
                </div>
                <Textarea
                  id="style"
                  value={selected.style_prompt}
                  onChange={(e) =>
                    setChannels((cs) =>
                      cs.map((c) => (c.id === selected.id ? { ...c, style_prompt: e.target.value } : c)),
                    )
                  }
                  onBlur={(e) => saveStylePrompt(selected.id, e.target.value.trim())}
                  rows={4}
                />
                {selected.sample_urls?.length > 0 && (
                  <div className="flex gap-1.5 overflow-x-auto pb-1">
                    {selected.sample_urls.slice(0, 24).map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={u}
                        src={u}
                        alt=""
                        className="h-12 w-[85px] shrink-0 rounded border border-border object-cover"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Title */}
              <div className="space-y-1.5">
                <Label htmlFor="title">3. New video title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Rome's Collapse"
                />
                <p className="text-xs text-fg-subtle">
                  Used to guide the scene — the full title is not stamped on the image.
                </p>
              </div>

              {/* Optional custom prompt */}
              <div className="space-y-1.5">
                <Label htmlFor="custom">Custom changes (optional)</Label>
                <Input
                  id="custom"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="e.g. make it darker, shocked face, no arrows"
                />
                <p className="text-xs text-fg-subtle">
                  Optional tweaks applied on top of the channel style. Leave empty to just use the channel style.
                </p>
              </div>

              {/* Optional subject images */}
              <div className="space-y-2">
                <Label>
                  Subject images ({filledSubjects.length}/{MAX_SUBJECTS}) — optional
                </Label>
                <div className="space-y-2">
                  {subjects.map((s, i) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <div className="h-10 w-[71px] shrink-0 rounded-md border border-border bg-surface-hover overflow-hidden grid place-items-center">
                        {s.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={previewFor(s.url)} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <ImageIcon className="h-3.5 w-3.5 text-fg-subtle" />
                        )}
                      </div>
                      <Input
                        value={s.url}
                        onChange={(e) => updateSubject(s.id, { url: e.target.value })}
                        placeholder={
                          i === 0
                            ? "Celebrity / person / AI avatar — image URL or upload"
                            : "Second person — image URL or upload (optional)"
                        }
                        disabled={s.uploading}
                      />
                      <input
                        ref={(el) => {
                          fileInputs.current[s.id] = el;
                        }}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onUpload(s.id, f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        title="Upload image"
                        disabled={s.uploading}
                        onClick={() => fileInputs.current[s.id]?.click()}
                      >
                        <Upload className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Remove"
                        onClick={() => removeSubject(s.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                {subjects.length < MAX_SUBJECTS && (
                  <Button type="button" variant="ghost" size="sm" onClick={addSubject}>
                    <Plus className="h-4 w-4" /> Add person
                  </Button>
                )}
                <p className="text-xs text-fg-subtle">
                  Add a celebrity/person or your AI avatar face here to use THAT exact face. When you add a
                  face, only the uploaded face is used for identity — the channel supplies the style only, so
                  a new/changed avatar face won&apos;t revert to the channel&apos;s old face. Leave empty to reuse the
                  channel&apos;s own face from its thumbnails.
                </p>
              </div>

              {/* Optional: upload a specific thumbnail FORMAT to learn its layout.
                  Off by default — a channel can run several distinct formats
                  (two-celebrity split, breaking-news banner, single shocked
                  face) that the averaged channel style can't capture. */}
              <div className="space-y-2 rounded-lg border border-border bg-surface/40 p-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-brand-500"
                    checked={useFormat}
                    onChange={(e) => setUseFormat(e.target.checked)}
                  />
                  <span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                      <LayoutTemplate className="h-4 w-4 text-brand-300" />
                      Use a specific thumbnail format (optional)
                    </span>
                    <span className="mt-0.5 block text-xs text-fg-subtle">
                      Upload 1–{MAX_FORMAT_IMAGES} example thumbnails of ONE format (e.g. a two-person split, a
                      breaking-news banner). The tool learns that exact layout and generates in it — instead of
                      the channel&apos;s averaged style.
                    </span>
                  </span>
                </label>

                {useFormat && (
                  <div className="space-y-2 pl-6">
                    {formatImages.map((f, i) => (
                      <div key={f.id} className="flex items-center gap-2">
                        <div className="h-10 w-[71px] shrink-0 rounded-md border border-border bg-surface-hover overflow-hidden grid place-items-center">
                          {f.url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={f.url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <LayoutTemplate className="h-3.5 w-3.5 text-fg-subtle" />
                          )}
                        </div>
                        <Input
                          value={f.url}
                          onChange={(e) => updateFormatImage(f.id, { url: e.target.value })}
                          placeholder={
                            i === 0
                              ? "Format example — image URL or upload"
                              : "Another example of the SAME format (optional)"
                          }
                          disabled={f.uploading}
                        />
                        <input
                          ref={(el) => {
                            formatFileInputs.current[f.id] = el;
                          }}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) onUploadFormat(f.id, file);
                            e.target.value = "";
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="Upload image"
                          disabled={f.uploading}
                          onClick={() => formatFileInputs.current[f.id]?.click()}
                        >
                          {f.uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Remove"
                          onClick={() => removeFormatImage(f.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    {formatImages.length < MAX_FORMAT_IMAGES && (
                      <Button type="button" variant="ghost" size="sm" onClick={addFormatImage}>
                        <Plus className="h-4 w-4" /> Add example
                      </Button>
                    )}
                    <p className="text-xs text-fg-subtle">
                      All examples should share the same layout. The tool describes that layout and reproduces it
                      for your title.
                    </p>
                  </div>
                )}
              </div>

              {/* Build prompt */}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onBuildPrompt}
                  disabled={!title.trim() || building || anyUploading}
                >
                  {building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {building ? "Building prompt…" : "Build prompt"}
                </Button>
              </div>

              {/* Build caveat (AI fallback / format not learned) — a warning,
                  not a hard error, so the user knows the output is degraded. */}
              {notice && (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {notice}
                </p>
              )}

              {/* Generated prompt (editable) */}
              {prompt && (
                <div className="space-y-1.5">
                  <Label htmlFor="prompt">4. Generated prompt (review &amp; edit)</Label>
                  <Textarea
                    id="prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={5}
                  />
                  <p className="text-xs text-fg-subtle">
                    Edit anything you like before generating. No links — the prompt can&apos;t contain a URL.
                  </p>
                </div>
              )}

              {/* Generate */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant="gradient"
                  size="lg"
                  onClick={onGenerate}
                  disabled={!title.trim() || !prompt.trim() || anyUploading || generating}
                >
                  <ImageIcon className="h-4 w-4" />
                  {generating ? "Generating…" : "Generate thumbnail"}
                </Button>
                {error && <p className="text-xs text-danger">{error}</p>}
              </div>
            </>
          )}
        </>
      )}
      {channels.length === 0 && error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

// A YouTube link previews via its thumbnail; a direct URL previews as itself.
function previewFor(url: string): string {
  const m = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/,
  );
  if (m) return `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg`;
  return url;
}
