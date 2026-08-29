// ── Utilities ───────────────────────────────────────────────────────────────
export * from './util/SystemClock';
export * from './util/UuidGenerator';
export * from './util/Sha256Hasher';
export * from './observability/PinoLogger';
export * from './observability/PinoTelemetry';

// ── AI (Anthropic Claude — text; OpenAI — cover; 69labs — illustrations) ────
export * from './ai/anthropic/ClaudeTextGenerator';
export * from './ai/openai/OpenAIImageGenerator';
export * from './ai/labs69/Labs69ImageGenerator';
export * from './ai/labs69/SharedPoolImageGenerator';
export * from './ai/FallbackImageGenerator';

// ── Image processing (sharp) ────────────────────────────────────────────────
export * from './image/SharpImageProcessor';
export * from './image/SharpColorSampler';

// ── Networking (proxy rotation, static hosting) ─────────────────────────────
export * from './net/ProxyRotator';
export * from './net/NetlifyDeployer';
export * from './net/HttpReferencePageFetcher';
export * from './net/HttpImageFetcher';
export * from './net/PuppeteerReferenceScreenshotter';
export * from './net/PuppeteerTemplateCapturer';
export * from './net/HttpWebFontFetcher';
export * from './persistence/supabase/SupabaseLandingLayoutRepository';

// ── Landing page (sales page renderer) ──────────────────────────────────────
export * from './landing/LandingPageHtmlRenderer';
export * from './landing/GeneratedPageAssembler';
export * from './landing/TemplateBinder';
export * from './landing/SharpPageDiffer';
export * from './landing/SupabaseTemplateArtifactStore';
export * from './landing/AssetRehoster';
export * from './landing/CssBundler';

// ── Payhip (store listing via browser automation) ───────────────────────────
export * from './integrations/payhip/PayhipSessionStore';
export * from './integrations/payhip/PayhipProductPublisher';
export * from './integrations/payhip/PayhipErrors';
export * from './integrations/payhip/PayhipProductPage';
export * from './integrations/payhip/PayhipBrowser';
export * from './integrations/payhip/login';
export * from './integrations/payhip/keepAlive';

// ── Storage ─────────────────────────────────────────────────────────────────
export * from './reference/FileTextExtractor';
export * from './storage/SupabaseStorageAdapter';

// ── Export (PDF / DOCX) ─────────────────────────────────────────────────────
export * from './export/PuppeteerPdfExporter';
export * from './export/DocxExporter';
export * from './export/cookbookHtml';

// ── Queue (BullMQ) ──────────────────────────────────────────────────────────
export * from './queue/connection';
export * from './queue/queues';
export * from './queue/BullJobQueue';

// ── Persistence (Supabase) ──────────────────────────────────────────────────
export * from './persistence/supabase/SupabaseClientFactory';
export * from './persistence/supabase/SupabaseProjectRepository';
export * from './persistence/supabase/SupabaseBookRepository';
export * from './persistence/supabase/SupabaseKnowledgeRepository';
export * from './persistence/supabase/SupabaseReferenceBookRepository';
export * from './persistence/supabase/SupabaseExportArtifactRepository';
export * from './persistence/supabase/SupabaseLandingPageRepository';
export * from './persistence/supabase/SupabaseLandingTemplateRepository';
export * from './persistence/supabase/SupabaseUnitOfWork';
export * from './persistence/supabase/SupabaseIdempotencyStore';
