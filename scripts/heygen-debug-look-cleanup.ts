import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Headed test of the DELETE-AFTER-RENDER look cleanup (cleanupUploadedLook)
// WITHOUT burning a render credit: upload a look into the Switch-look grid,
// dump the tile's live DOM (to pin the real delete-control selectors), then run
// the exact production cleanup against it and report whether the delete landed.
//
//   npm run heygen:debug-look-cleanup -- --account you@x.com --image <face-photo-url>
//
// Flags:
//   --account <email>   REQUIRED — the pool account to drive (no lease taken).
//   --image <url>       Face photo to upload as the throwaway look. REQUIRED
//                       unless --src is given (HeyGen validates photos, so it
//                       must be a real face).
//   --src <img-src>     Skip the upload; delete an EXISTING look whose tile img
//                       src matches this (normalized origin+pathname).
//   --keep              Upload + dump DOM only; skip the delete (leaves the
//                       look in the grid for manual inspection).
//
// The browser is headed + slow-mo (HEYGEN_DEBUG=true), so you can watch every
// step. The hovered tile's outerHTML is written to heygen-look-tile-dump.html
// in the CWD — open it to pin exact selectors for the more-menu/Delete controls
// if the guessed ones miss.

process.env.HEYGEN_DEBUG = "true";

import fs from "node:fs/promises";
import { fetchOrThrow } from "@/lib/synthetic/http";
import { getAccountByEmail } from "@/lib/synthetic/heygen-accounts";
import { acquireJobPage, closeWarmSession } from "@/lib/synthetic/heygen-session";
import {
  cleanupUploadedLook,
  lookSrcKey,
  sweepLookTileSrcs,
  type GenerateAvatarInput,
} from "@/lib/synthetic/heygen";
import {
  avatarShotsNavEntry,
  avatarShotsLookPreview,
  avatarShotsSwitchLookButton,
  avatarShotsLookModal,
  avatarShotsLookUploadButton,
  avatarShotsLookValidating,
  avatarShotsLookTileImages,
  clickFirstVisible,
  waitFirstVisible,
  isVisible,
} from "@/lib/synthetic/heygen-selectors";

// PROBE the looks-DETAIL page tile's hover-state DOM (the Switch-look modal has
// NO delete — verified live; delete lives on Avatars → first avatar → looks
// grid). HeyGen mounts the tile's action buttons ("..." / select / ♡) into an
// empty top-right container ONLY on hover, so a resting-state dump shows
// nothing. We navigate there, hover our tile, dump its hover HTML, then click
// each candidate button and dump whatever menu/popover appears — everything
// needed to pin exact delete selectors. Appends to heygen-look-tile-dump.html.
async function probeDetailPage(p: import("playwright").Page, lookSrc: string): Promise<void> {
  const sections: string[] = [];
  const idMatch = /talking_photo\/([^/?#]+)\/([^/?#.]+)/.exec(lookSrc);
  const identity = idMatch ? `talking_photo/${idMatch[1]}/${idMatch[2]}` : "";
  if (!identity) {
    console.log("  probe: no talking_photo identity in src — skipping");
    return;
  }
  const baseUrl = process.env.HEYGEN_BASE_URL || "https://app.heygen.com";
  await p.goto(`${baseUrl}/avatar/avatars`, { waitUntil: "commit" }).catch(() => {});
  const { firstAvatarTile, avatarLooksDetailReady } = await import("@/lib/synthetic/heygen-selectors");
  const avatarTile = firstAvatarTile(p).first();
  await avatarTile.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await avatarTile.click({ timeout: 8000 }).catch(() => {});
  await avatarLooksDetailReady(p).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await p.waitForTimeout(1000);
  // Stamp our tile by identity (inlined — tsx __name).
  const found = await p.evaluate((ident) => {
    for (const el of Array.from(document.querySelectorAll("[data-va-probe]")))
      el.removeAttribute("data-va-probe");
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const im = img as HTMLImageElement;
      const s = im.currentSrc || im.src || "";
      if (!s || s.indexOf(ident) === -1) continue;
      const card =
        im.closest('[data-pacific-component="PrivatePhotoAvatarCard"]') ??
        im.closest('[class*="card" i]');
      if (card) { card.setAttribute("data-va-probe", "1"); }
    }
    return document.querySelectorAll('[data-va-probe="1"]').length;
  }, identity);
  if (!found) {
    console.log("  probe: tile not found on the looks-detail page — dumping first grid tile instead");
    await p.evaluate(() => {
      const card = document.querySelector('[data-pacific-component="PrivatePhotoAvatarCard"]');
      if (card) card.setAttribute("data-va-probe", "1");
    }).catch(() => {});
  }
  const tile = p.locator('[data-va-probe="1"]').last();
  await tile.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await tile.hover().catch(() => {});
  await p.waitForTimeout(800); // let hover-mounted buttons render

  const hoverHtml = await tile.evaluate((el) => el.outerHTML).catch(() => "");
  sections.push(`<!-- ===== TILE (HOVER STATE) ===== -->\n${hoverHtml}`);

  // Enumerate the tile's buttons in hover state and click each candidate
  // (skipping the "Choose look" commit — clicking it would close the modal),
  // dumping any menu/popover that opens.
  const buttons = tile.locator('button, [role="button"]');
  const n = await buttons.count().catch(() => 0);
  console.log(`  probe: ${n} button(s) present on hover`);
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const bHtml = (await b.evaluate((el) => el.outerHTML).catch(() => "")) ?? "";
    sections.push(`<!-- ===== TILE BUTTON ${i} ===== -->\n${bHtml}`);
    if (/choose look/i.test(bHtml)) continue; // don't commit the look
    await tile.hover().catch(() => {});
    await b.click({ timeout: 3000, force: true }).catch(() => {});
    await p.waitForTimeout(600);
    const menus = await p
      .evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-pacific-component*="Menu" i], [data-pacific-component*="Popover" i]',
          ),
        ).map((el) => (el as HTMLElement).outerHTML),
      )
      .catch(() => [] as string[]);
    if (menus.length) {
      sections.push(`<!-- ===== MENU OPENED BY BUTTON ${i} ===== -->\n${menus.join("\n\n")}`);
      console.log(`  probe: button ${i} opened a menu (${menus.length} element(s)) — dumped`);
    }
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(300);
    // A wrong icon may have navigated away (e.g. a create-video shortcut) —
    // come back so the remaining buttons can be probed.
    if (!(await avatarLooksDetailReady(p).first().isVisible().catch(() => false))) {
      await p.goBack().catch(() => {});
      await avatarLooksDetailReady(p).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      await tile.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    }
  }
  await fs.appendFile("heygen-look-tile-dump.html", `\n\n${sections.join("\n\n")}\n`);
  console.log("  probe: hover-state DOM appended to heygen-look-tile-dump.html");
}

function parseArgs(argv: string[]) {
  const out: { account?: string; image?: string; src?: string; keep?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") out.account = argv[++i];
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--src") out.src = argv[++i];
    else if (a === "--keep") out.keep = true;
    // npm strips --flags unless invoked with `npm run … -- --flag`; recover the
    // common bare values by shape like heygen-debug-gen does.
    else if (!out.account && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) out.account = a;
    else if (!out.image && /^https?:\/\//i.test(a)) out.image = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account) throw new Error("--account <email> is required");
  if (!args.image && !args.src) throw new Error("need --image <face-photo-url> (or --src to target an existing look)");

  const account = await getAccountByEmail(args.account);
  if (!account) throw new Error(`no HeyGen account found for ${args.account} (connect it first)`);

  console.log(`Driving ${args.account} (HEADED browser — watch it)…`);
  const { page: p } = await acquireJobPage(account);

  const baseUrl = process.env.HEYGEN_BASE_URL || "https://app.heygen.com";

  // Enter the Avatar-Shots composer via the direct entry (same path cleanup
  // itself uses; old-UI accounts without it are exactly the accounts cleanup
  // skips, so testing there is meaningless anyway).
  await clickFirstVisible(avatarShotsNavEntry(p), 8000, "Avatar Shots nav").catch(async () => {
    await p.goto(`${baseUrl}/avatar/avatar-shots`, { waitUntil: "commit" }).catch(() => {});
  });
  await avatarShotsLookPreview(p).first().waitFor({ state: "visible", timeout: 30_000 });

  let lookSrc = args.src ?? "";

  if (!lookSrc) {
    // Upload a throwaway look, mirroring applyLook's steps (light version).
    console.log("Opening Switch-look modal…");
    await avatarShotsLookPreview(p).first().hover().catch(() => {});
    await clickFirstVisible(avatarShotsSwitchLookButton(p), 20_000, "Switch look");
    await waitFirstVisible(avatarShotsLookModal(p), 20_000, "Switch-look modal");

    console.log("Sweeping pre-upload tile baseline…");
    const before = new Set(await sweepLookTileSrcs(p));
    console.log(`  ${before.size} existing look tiles (this is the shared-grid pollution)`);

    console.log("Fetching + uploading test image…");
    const imgRes = await fetchOrThrow(args.image!, { timeoutMs: 60_000 });
    const stagePath = "heygen-look-cleanup-test.jpg";
    await fs.writeFile(stagePath, Buffer.from(await imgRes.arrayBuffer()));
    try {
      const [chooser] = await Promise.all([
        p.waitForEvent("filechooser", { timeout: 20_000 }),
        clickFirstVisible(avatarShotsLookUploadButton(p), 20_000, "Switch-look Upload"),
      ]);
      await chooser.setFiles(stagePath);
    } finally {
      await fs.unlink(stagePath).catch(() => {});
    }

    // Wait out validation (appear then disappear; best-effort on builds where
    // the text differs), then find the new tile by sweep diff.
    const validating = avatarShotsLookValidating(p).first();
    const appeared = await validating.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
    console.log(`  validating text ${appeared ? "seen" : "NOT seen"}`);
    if (appeared) await validating.waitFor({ state: "hidden", timeout: 120_000 }).catch(() => {});
    await p.waitForTimeout(1000);

    const deadline = Date.now() + 30_000;
    while (!lookSrc && Date.now() < deadline) {
      // Normalization INLINED — tsx wraps inner named helpers with a __name()
      // that doesn't exist in the page (see sweepLookTileSrcs in heygen.ts).
      lookSrc = await avatarShotsLookTileImages(p)
        .evaluateAll(
          (imgs, beforeKeys) => {
            for (const el of imgs) {
              const im = el as HTMLImageElement;
              const s = im.currentSrc || im.src || "";
              if (!s || !im.complete || !(im.naturalWidth > 0)) continue;
              let k = s;
              try { const u = new URL(s, location.href); k = u.origin + u.pathname; } catch {}
              if (!beforeKeys.includes(k)) return s;
            }
            return "";
          },
          [...before],
        )
        .catch(() => "");
      if (!lookSrc) await p.waitForTimeout(500);
    }
    if (!lookSrc) throw new Error("uploaded look tile never appeared — cannot proceed");
    console.log(`  uploaded look src: ${lookSrc.slice(0, 120)}…`);

    // DOM DUMP for selector pinning: hover the new tile and capture its HTML.
    const dump = await p.evaluate((wanted) => {
      let wk = wanted;
      try { const u = new URL(wanted, location.href); wk = u.origin + u.pathname; } catch {}
      for (const img of Array.from(document.querySelectorAll('[data-pacific-component="PrivatePhotoAvatarCard"] img'))) {
        const im = img as HTMLImageElement;
        const s = im.currentSrc || im.src || "";
        let k = s;
        try { const u = new URL(s, location.href); k = u.origin + u.pathname; } catch {}
        if (s && k === wk) {
          return (im.closest('[data-pacific-component="PrivatePhotoAvatarCard"]') as HTMLElement)?.outerHTML ?? "";
        }
      }
      return "";
    }, lookSrc);
    if (dump) {
      await fs.writeFile("heygen-look-tile-dump.html", dump);
      console.log(`  tile DOM (${dump.length} chars) → heygen-look-tile-dump.html (pin delete selectors from this)`);
    }

    // Close the modal so cleanup starts from the same state it does in
    // production (post-render, modal closed).
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(800);
    if (await isVisible(avatarShotsLookModal(p), 500)) {
      await p.keyboard.press("Escape").catch(() => {});
    }
  }

  if (args.keep) {
    console.log("\n--keep: skipping delete. The look is left in the grid for manual inspection.");
  } else {
    console.log("\nRunning cleanupUploadedLook (the exact production flow)…");
    const fakeInput: GenerateAvatarInput = {
      projectId: "debug",
      segmentId: "debug-look-cleanup",
      jobId: "debug-look-cleanup",
      avatarImageUrl: args.image ?? "",
      script: "",
    };
    await cleanupUploadedLook(p, fakeInput, lookSrc);

    // Independent verification: cleanup left us on the Avatars detail page — go
    // back to the composer, reopen the Switch-look modal, and confirm the look's
    // stable talking_photo identity is gone from the grid.
    await p.keyboard.press("Escape").catch(() => {});
    await clickFirstVisible(avatarShotsNavEntry(p), 8000, "Avatar Shots nav (verify)").catch(async () => {
      await p.goto(`${baseUrl}/avatar/avatar-shots`, { waitUntil: "commit" }).catch(() => {});
    });
    await avatarShotsLookPreview(p).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await avatarShotsLookPreview(p).first().hover().catch(() => {});
    await clickFirstVisible(avatarShotsSwitchLookButton(p), 15_000, "Switch look (verify)").catch(() => {});
    await waitFirstVisible(avatarShotsLookModal(p), 15_000, "Switch-look modal (verify)").catch(() => {});
    await p.waitForTimeout(1500); // lazy grid
    const after = await sweepLookTileSrcs(p);
    const idm = /talking_photo\/([^/?#]+)\/([^/?#.]+)/.exec(lookSrc);
    const ident = idm ? `talking_photo/${idm[1]}/${idm[2]}` : "";
    const stillThere = ident
      ? after.some((k) => k.includes(ident))
      : after.includes(lookSrcKey(lookSrc));
    await p.keyboard.press("Escape").catch(() => {});
    if (stillThere) {
      console.log("\nProbing the looks-detail page DOM for selector pinning…");
      await probeDetailPage(p, lookSrc).catch((e) =>
        console.log(`  probe failed: ${(e as Error).message}`),
      );
    }
    console.log(
      stillThere
        ? "\n✗ DELETE DID NOT LAND — the look is still in the grid. Check the\n" +
          "  synthetic.heygen.avatar3_look_cleanup log line above and open\n" +
          "  heygen-look-tile-dump.html to pin the real delete selectors."
        : "\n✓ DELETE VERIFIED — the uploaded look is gone from the grid.",
    );
    process.exitCode = stillThere ? 1 : 0;
  }

  await closeWarmSession().catch(() => {});
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error("\n✗ FAILED:", (err as Error).message);
    await closeWarmSession().catch(() => {});
    process.exit(1);
  });
