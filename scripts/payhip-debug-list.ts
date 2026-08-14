import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

// Watch ONE book being listed on Payhip in a VISIBLE browser, end to end, on
// your own machine — independent of the queue and the worker.
//
//   npm run payhip:debug-list <projectId>
//
// Use this when the button in the app "does nothing": the queue hides every
// interesting detail behind a job that either finishes or doesn't, whereas here
// you watch the real dashboard being driven and see each step named as it
// starts. It runs the SAME use case, the same page object and the same
// selectors the worker runs — so what you watch IS the production flow.
//
// Forces a headed, slow-mo browser regardless of .env.local. Add --headless to
// watch only the printed steps (useful for timing the upload without a window
// stealing focus).
//
// ⚠️  THIS CREATES A REAL PRODUCT on your live storefront, exactly as the button
// does. It is not a dry run. The idempotency guard still applies: a book that
// already has a product prints the stored link and creates nothing, so re-running
// it is safe. Pass --force to deliberately create a second one.
//
// DELIBERATELY DOES NOT BUILD THE DI CONTAINER — see the note in
// scripts/payhip-connect.ts. Listing a book needs Supabase and a browser; it
// does not need Anthropic, YouTube or Redis, and `loadEnv()` demands all of
// them before it will return.

import { CreateCheckoutProductUseCase } from "@ebook/core";
import {
  SupabaseClientFactory,
  SupabaseProjectRepository,
  SupabaseBookRepository,
  SupabaseKnowledgeRepository,
  SupabaseExportArtifactRepository,
  SupabaseStorageAdapter,
  PayhipSessionStore,
  PayhipProductPublisher,
  SystemClock,
} from "@ebook/infra";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const projectId = args.find((a) => !a.startsWith("--"));

/** Console logger with the shape the use case's Logger port expects. */
const logger = {
  debug: () => {},
  info: (msg: string, meta?: Record<string, unknown>) => console.log(`  ${msg}`, meta ?? ""),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`  ⚠ ${msg}`, meta ?? ""),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`  ✖ ${msg}`, meta ?? ""),
  child: () => logger,
};

function supabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !url && "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)",
    !key && "SUPABASE_SERVICE_ROLE_KEY",
    !process.env.SECRET_BOX_KEY && "SECRET_BOX_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`Missing environment in .env.local:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
    process.exit(2);
  }
  return SupabaseClientFactory.serviceRole(url as string, key as string);
}

async function main() {
  if (!projectId) {
    console.error("Usage: npm run payhip:debug-list <projectId> [--force] [--headless]");
    console.error("  The projectId is the UUID in the book's URL: /books/<projectId>");
    process.exit(2);
  }

  const db = supabase();
  const sessions = new PayhipSessionStore(db);
  const storage = new SupabaseStorageAdapter(db);

  const publisher = new PayhipProductPublisher(
    sessions,
    {
      baseUrl: process.env.PAYHIP_BASE_URL || "https://payhip.com",
      timeoutMs: Number(process.env.PAYHIP_TIMEOUT_MS ?? 45_000),
      debugDir: process.env.PAYHIP_DEBUG_DIR || "/tmp/payhip-debug",
      // The whole point of this script. --headless opts out when you only want
      // the step log (and not a window taking over your screen).
      headed: !flag("headless"),
      slowMoMs: Number(process.env.PAYHIP_SLOWMO_MS || 400),
      // Each step, printed as it starts, with a running clock — so a long pause
      // is attributable to a specific step rather than to "it hung".
      onProgress: (step) => console.log(`  [${elapsed()}] ${step}`),
    },
    logger,
  );

  const useCase = new CreateCheckoutProductUseCase(
    new SupabaseProjectRepository(db),
    new SupabaseBookRepository(db),
    new SupabaseKnowledgeRepository(db),
    new SupabaseExportArtifactRepository(db),
    storage,
    publisher,
    new SystemClock(),
    logger,
  );

  console.log(`Listing project ${projectId} on Payhip…`);
  if (!flag("headless")) console.log("A browser window will open — watch it work. Do not close it.\n");
  else console.log("");

  const result = await useCase.execute({ projectId, force: flag("force") });

  if (result.isFail()) {
    console.error(`\n✖ Failed (${result.error.kind}): ${result.error.message}`);
    if (result.error.debugPaths?.length) {
      console.error("\nWhat the browser was looking at when it gave up:");
      for (const p of result.error.debugPaths) console.error(`  ${p}`);
      console.error("\nOpen the .png first — it usually shows the answer immediately.");
    }
    process.exit(1);
  }

  console.log(
    result.value.reused
      ? `\n✓ Already listed — nothing created.\n  ${result.value.buyUrl}`
      : `\n✓ Listed.\n  ${result.value.buyUrl}  (product ${result.value.productKey})`,
  );
  console.log("\nThe checkout link is saved on the project — reload the book's page to see it.");
  process.exit(0);
}

const startedAt = Date.now();
/** Seconds since launch, so the upload's real cost is visible in the log. */
function elapsed(): string {
  return `${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3, " ")}s`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
