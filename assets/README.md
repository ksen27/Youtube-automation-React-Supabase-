# assets/

Build-time assets baked into the worker Docker image. `Dockerfile.worker`
copies the whole repo into `/app` (`COPY . .` with `WORKDIR /app`), so a file
committed here at `assets/<name>` is available at `/app/assets/<name>` inside
the running worker container.

## effect-overlay.mp4 — global full-video effect

A single effect clip that is screen-blended over **every frame of every
rendered video** (intro clips, the opening title card, and all body content)
as a post-pass after the final concat. Used for the client's particle/dust
effect (bright specks on a pure-black background). Screen blend keeps only the
bright pixels and makes the black background vanish, so the particles float
over the content with no dark wash.

### How to enable in production

1. Put the effect clip here as `assets/effect-overlay.mp4` and commit it.
   (If it's larger than ~10–20 MB, track it with Git LFS so it doesn't bloat
   history — it still ends up in the image the same way.)
2. Set the worker env / Fly secret `EFFECT_OVERLAY_ENABLED=true`.
3. Deploy. The worker finds the file at the default path
   `EFFECT_OVERLAY_PATH=./assets/effect-overlay.mp4` (resolved relative to
   `/app`) — no path override needed.

### Config knobs (see `lib/env.ts`)

| Env var | Default | Meaning |
| --- | --- | --- |
| `EFFECT_OVERLAY_ENABLED` | `false` | Master toggle. Off → renders behave exactly as before. |
| `EFFECT_OVERLAY_PATH` | `./assets/effect-overlay.mp4` | Local path **or** an `http(s)` URL. A URL is downloaded per-render into tmp (e.g. an R2 object); a local path is read straight from the image. |
| `EFFECT_OVERLAY_OPACITY` | `0.7` | 0–1 screen-blend strength. Particles on black wash nothing out even near 1.0; lower for a subtler effect. |

### Notes

- The overlay forces a full re-encode of the finished MP4 (compositing two
  video layers can't use the concat's `-c:v copy` fast path). Audio is
  stream-copied — the voiceover/music/SFX mix is already baked in.
- The pass is **best-effort**: a missing file, failed download, or ffmpeg
  error logs and ships the un-overlaid video. It never blocks a render.
- This is a *build-time* asset and belongs in the image, **not** on the
  `/data` Fly volume (that volume is for runtime state — Redis AOF, render
  cache). Putting it on `/data` would mean copying it onto every machine's
  volume by hand.
- Verify the effect's background is **true black** (0,0,0). If the encoder
  lifted blacks (e.g. 16,16,16), screen blend adds a faint gray veil over the
  whole video; a `lutrgb`/`curves` floor-to-black step before the blend fixes
  it.
