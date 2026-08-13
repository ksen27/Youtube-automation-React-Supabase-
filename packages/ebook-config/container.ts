import {
  PipelineOrchestrator,
  SubmitChannelUseCase,
  StartQueuedProjectsUseCase,
  IngestChannelUseCase,
  FetchVideoDataUseCase,
  FetchTranscriptUseCase,
  TranscribeAudioUseCase,
  SummarizeVideoUseCase,
  AnalyzeCommentsUseCase,
  BuildKnowledgeBaseUseCase,
  GenerateBookStrategyUseCase,
  GenerateOutlineUseCase,
  GenerateChapterResearchUseCase,
  StartChapterGenerationUseCase,
  GenerateChapterUseCase,
  StartBookPolishUseCase,
  PolishChapterUseCase,
  AssembleEbookUseCase,
  ExportEbookUseCase,
  RegenerateChapterUseCase,
  EditChapterUseCase,
  EditBookSectionUseCase,
  AddSectionUseCase,
  AddExtraContentUseCase,
  GenerateExtraContentUseCase,
  GenerateFrontBackMatterUseCase,
  GenerateCoverImageUseCase,
  GenerateIllustrationsUseCase,
  GenerateLandingPageUseCase,
  GenerateClonedLandingPageUseCase,
  ExtractTemplateUseCase,
  PublishLandingPageUseCase,
  type DocumentExporter,
} from '@ebook/core';
import {
  SystemClock,
  UuidGenerator,
  Sha256Hasher,
  PinoLogger,
  PinoTelemetry,
  ClaudeTextGenerator,
  OpenAIImageGenerator,
  Labs69ImageGenerator,
  SharedPoolImageGenerator,
  FallbackImageGenerator,
  SharpImageProcessor,
  SharpColorSampler,
  NetlifyDeployer,
  LandingPageHtmlRenderer,
  GeneratedPageAssembler,
  HttpReferencePageFetcher,
  HttpImageFetcher,
  PuppeteerReferenceScreenshotter,
  HttpWebFontFetcher,
  labs69ProxyRotator,
  YouTubeDataApiProvider,
  YouTubeTranscriptProvider,
  WhisperSpeechToText,
  YtDlpAudioDownloader,
  SupabaseStorageAdapter,
  PuppeteerPdfExporter,
  DocxExporter,
  getRedisConnection,
  BullJobQueue,
  SupabaseClientFactory,
  SupabaseProjectRepository,
  SupabaseVideoRepository,
  SupabaseChannelRepository,
  SupabaseBookRepository,
  SupabaseKnowledgeRepository,
  SupabaseExportArtifactRepository,
  SupabaseLandingPageRepository,
  SupabaseLandingLayoutRepository,
  SupabaseLandingTemplateRepository,
  SupabaseTemplateArtifactStore,
  PuppeteerTemplateCapturer,
  SharpPageDiffer,
  TemplateBinder,
  SupabaseIdempotencyStore,
} from '@ebook/infra';
import { loadEnv, type Env } from './env';

/**
 * Composition root. Constructs every adapter behind its port and assembles the
 * use cases. This is the ONLY place infrastructure is bound to abstractions —
 * swapping an adapter (e.g. Whisper → faster-whisper) is a one-line change here.
 */
export function buildContainer(env: Env = loadEnv()) {
  // ── primitives ──
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const hasher = new Sha256Hasher();
  const logger = PinoLogger.create(env.LOG_LEVEL);
  const telemetry = new PinoTelemetry(logger.child({ component: 'telemetry' }));

  // ── external clients ──
  const supabase = SupabaseClientFactory.serviceRole(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const redis = getRedisConnection(env.REDIS_URL);

  // ── adapters (implement core ports) ──
  const storage = new SupabaseStorageAdapter(supabase);
  const queue = new BullJobQueue(redis);
  const ai = ClaudeTextGenerator.fromApiKey(env.ANTHROPIC_API_KEY, telemetry);
  // OpenAI gpt-image-1 powers the COVER art.
  const images = OpenAIImageGenerator.fromApiKey(env.OPENAI_API_KEY ?? '');
  // 69labs (img-flux) powers the in-chapter ILLUSTRATIONS — cheap and fast — but
  // its jobs fail intermittently, so OpenAI gpt-image-1 is a reliable fallback:
  // FallbackImageGenerator only pays for OpenAI when a 69labs job fails.
  // 69labs blocks datacenter IPs, so route its requests through residential
  // proxies (LABS69_PROXIES, else the shared YT_DLP_PROXIES pool).
  // PORT NOTE: the key comes from the app-wide SIXTYNINE_LABS_API_KEY (lib/env.ts),
  // not a separate LABS69_API_KEY — the ebook product and the video engines bill
  // the SAME 69labs account, and two env vars would invite them to drift apart.
  const labs69Key = env.SIXTYNINE_LABS_API_KEY ?? '';
  const labs69 = Labs69ImageGenerator.fromApiKey(
    labs69Key,
    env.LABS69_IMAGE_MODEL,
    logger.child({ adapter: '69labs' }),
    labs69ProxyRotator(),
  );
  // ...and gate it behind the SHARED Redis slot pool, so illustrating a book
  // queues against video renders instead of overcommitting the account. The
  // account id must match lib/synthetic/sixtynine-labs.ts's `key.slice(0, 10)`
  // or the two products would contend on two different semaphores.
  const pooledLabs69 = new SharedPoolImageGenerator(labs69, labs69Key.slice(0, 10));
  // The OpenAI fallback is deliberately NOT pooled — it never touches 69labs, so
  // taking a 69labs slot for it would throttle the account for no reason.
  const illustrationImages = new FallbackImageGenerator(pooledLabs69, images, logger.child({ adapter: 'image-fallback' }));
  // Downscales generated illustrations to a print-appropriate JPEG before storage.
  const imageProcessor = new SharpImageProcessor();
  // The landing page takes its whole colour scheme from the book's cover art.
  const colorSampler = new SharpColorSampler();
  const landingRenderer = new LandingPageHtmlRenderer();
  // Assembles a model-generated layout into the finished document.
  const landingAssembler = new GeneratedPageAssembler();
  // Reads the reference sales page a book's layout should follow.
  const referencePages = new HttpReferencePageFetcher();
  // Pulls the YouTube channel avatar in as the landing page's brand mark.
  const imageFetcher = new HttpImageFetcher();
  // Screenshots the reference so the layout model can see how it looks, not
  // just how it is structured.
  const referenceShots = new PuppeteerReferenceScreenshotter();
  // Inlines the reference's real typefaces when their licence allows it.
  const webFonts = new HttpWebFontFetcher();
  // ── the clone engine ──
  // Renders a template site in a real browser and returns its DOM, its CSS, its
  // assets and its measurements — all describing the SAME page, which is what
  // the fetcher/screenshotter pair above could never promise.
  const templateCapturer = new PuppeteerTemplateCapturer();
  // Stores a cloned template's bytes and makes the page self-contained.
  const templateArtifacts = new SupabaseTemplateArtifactStore(storage, webFonts);
  // Fills a parameterised template. Replaces GeneratedPageAssembler on this path.
  const templateBinder = new TemplateBinder();
  // Proves nothing but the replaced content moved.
  const pageDiffer = new SharpPageDiffer();
  const sitePublisher = new NetlifyDeployer(env.NETLIFY_AUTH_TOKEN ?? '', env.NETLIFY_ACCOUNT_SLUG);
  const youtube = new YouTubeDataApiProvider(env.YOUTUBE_API_KEY);
  const transcripts = new YouTubeTranscriptProvider();
  const audio = new YtDlpAudioDownloader(storage);
  const stt = WhisperSpeechToText.fromApiKey(env.OPENAI_API_KEY ?? '', storage);
  const exporters: DocumentExporter[] = [new PuppeteerPdfExporter(), new DocxExporter()];

  // ── repositories ──
  const projects = new SupabaseProjectRepository(supabase);
  const videos = new SupabaseVideoRepository(supabase);
  const channels = new SupabaseChannelRepository(supabase);
  const books = new SupabaseBookRepository(supabase);
  const knowledge = new SupabaseKnowledgeRepository(supabase);
  const artifacts = new SupabaseExportArtifactRepository(supabase);
  const landingPages = new SupabaseLandingPageRepository(supabase);
  // Layouts are captured once per reference template and reused by every book
  // that follows it — see SupabaseLandingLayoutRepository.
  const landingLayouts = new SupabaseLandingLayoutRepository(supabase);
  // Cloned templates, scoped to the account that extracted them — unlike the
  // layouts above, a template row is a complete copy of a website.
  const landingTemplates = new SupabaseLandingTemplateRepository(supabase);
  const idempotency = new SupabaseIdempotencyStore(supabase);

  // ── orchestration ──
  // The admission controller is built first: the orchestrator hands it a freed
  // slot whenever a project completes.
  const startQueuedProjects = new StartQueuedProjectsUseCase(projects, queue, env.MAX_ACTIVE_PROJECTS_PER_USER);
  const orchestrator = new PipelineOrchestrator(projects, queue, clock, logger, startQueuedProjects);

  // ── use cases ──
  const useCases = {
    submitChannel: new SubmitChannelUseCase(projects, queue, ids, clock, env.MAX_ACTIVE_PROJECTS_PER_USER),
    startQueuedProjects,
    ingestChannel: new IngestChannelUseCase(projects, videos, channels, youtube, queue, ids, clock),
    fetchVideoData: new FetchVideoDataUseCase(videos, youtube, queue),
    fetchTranscript: new FetchTranscriptUseCase(videos, transcripts, audio, queue, hasher),
    transcribeAudio: new TranscribeAudioUseCase(videos, stt, storage, hasher, audio),
    summarizeVideo: new SummarizeVideoUseCase(videos, ai, hasher),
    analyzeComments: new AnalyzeCommentsUseCase(videos, knowledge, ai, hasher),
    buildKnowledgeBase: new BuildKnowledgeBaseUseCase(channels, knowledge, ai, hasher),
    generateBookStrategy: new GenerateBookStrategyUseCase(projects, knowledge, channels, ai, hasher),
    generateOutline: new GenerateOutlineUseCase(projects, books, knowledge, ai, queue, ids, clock, hasher),
    generateChapterResearch: new GenerateChapterResearchUseCase(books, videos, knowledge, ai),
    startChapterGeneration: new StartChapterGenerationUseCase(projects, books, queue, clock, hasher),
    generateChapter: new GenerateChapterUseCase(books, knowledge, ai, clock),
    startBookPolish: new StartBookPolishUseCase(projects, books, queue),
    polishChapter: new PolishChapterUseCase(books, knowledge, ai, clock),
    generateFrontBackMatter: new GenerateFrontBackMatterUseCase(books, ai, ids),
    generateCoverImage: new GenerateCoverImageUseCase(books, knowledge, images, storage),
    generateIllustrations: new GenerateIllustrationsUseCase(books, projects, illustrationImages, imageProcessor, storage, ids, logger.child({ useCase: 'illustrations' })),
    assembleEbook: new AssembleEbookUseCase(books, knowledge, clock, storage, projects),
    exportEbook: new ExportEbookUseCase(exporters, storage, artifacts),
    regenerateChapter: new RegenerateChapterUseCase(books, queue, hasher),
    editChapter: new EditChapterUseCase(books),
    editBookSection: new EditBookSectionUseCase(books),
    addSection: new AddSectionUseCase(books, ai, ids),
    addExtraContent: new AddExtraContentUseCase(books, ai, queue, ids),
    generateExtraContent: new GenerateExtraContentUseCase(books, ai),
    generateLandingPage: new GenerateLandingPageUseCase(
      projects,
      books,
      knowledge,
      channels,
      artifacts,
      landingPages,
      landingLayouts,
      ai,
      landingRenderer,
      landingAssembler,
      referencePages,
      referenceShots,
      webFonts,
      colorSampler,
      imageFetcher,
      imageProcessor,
      storage,
      ids,
      clock,
      hasher,
    ),
    /**
     * The clone engine. Runs instead of `generateLandingPage` whenever the
     * project has a template selected; the older path stays for projects that
     * have none, which is still the default for single-book pages.
     */
    generateClonedLandingPage: new GenerateClonedLandingPageUseCase(
      projects,
      books,
      knowledge,
      channels,
      artifacts,
      landingPages,
      landingTemplates,
      templateArtifacts,
      templateBinder,
      templateCapturer,
      pageDiffer,
      ai,
      colorSampler,
      imageFetcher,
      imageProcessor,
      storage,
      ids,
      clock,
      hasher,
    ),
    extractTemplate: new ExtractTemplateUseCase(
      landingTemplates,
      templateCapturer,
      templateArtifacts,
      pageDiffer,
      ai,
      ids,
      clock,
    ),
    publishLandingPage: new PublishLandingPageUseCase(
      projects,
      books,
      landingPages,
      sitePublisher,
      clock,
      landingTemplates,
      templateArtifacts,
      storage,
    ),
  };

  return {
    env,
    clock,
    ids,
    hasher,
    logger,
    telemetry,
    storage,
    queue,
    idempotency,
    orchestrator,
    sitePublisher,
    repositories: {
      projects,
      videos,
      channels,
      books,
      knowledge,
      artifacts,
      landingPages,
      landingLayouts,
      landingTemplates,
    },
    useCases,
  };
}

export type Container = ReturnType<typeof buildContainer>;

let singleton: Container | null = null;
export function getContainer(): Container {
  if (!singleton) singleton = buildContainer();
  return singleton;
}
