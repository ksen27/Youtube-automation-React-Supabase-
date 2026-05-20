import { getEnv } from "@/lib/env";

// Pull a Google Doc's structured contents via the Docs API.
// Docs: https://developers.google.com/docs/api/reference/rest/v1/documents/get
//
// We use the raw REST API instead of the googleapis SDK to keep the
// dependency footprint small — this is a single GET.
//
// The doc MUST be shared "anyone with the link can view" because we
// authenticate with an API key (no user OAuth flow). Private docs return 403.

export interface GoogleDocsTextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  foregroundColor?: {
    color?: { rgbColor?: { red?: number; green?: number; blue?: number } };
  };
  link?: { url?: string };
}

export interface GoogleDocsTextRun {
  content?: string;
  textStyle?: GoogleDocsTextStyle;
}

export interface GoogleDocsParagraphElement {
  textRun?: GoogleDocsTextRun;
}

export interface GoogleDocsParagraph {
  elements?: GoogleDocsParagraphElement[];
}

export interface GoogleDocsStructuralElement {
  paragraph?: GoogleDocsParagraph;
}

export interface GoogleDocsDocument {
  documentId: string;
  title?: string;
  body?: { content?: GoogleDocsStructuralElement[] };
}

// Accepts any of:
//   https://docs.google.com/document/d/<id>/edit
//   https://docs.google.com/document/d/<id>/
//   https://docs.google.com/document/d/<id>
//   <id>  (raw 25+ char ID)
export function extractDocumentId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/\/document\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export class GoogleDocsFetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchGoogleDoc(documentId: string): Promise<GoogleDocsDocument> {
  const env = getEnv();
  if (!env.GOOGLE_DOCS_API_KEY) {
    throw new GoogleDocsFetchError("GOOGLE_DOCS_API_KEY not configured", 503);
  }
  // includeTabsContent is implicit-default false; we want the canonical body
  // only. Restricting fields keeps the response under a few hundred KB for
  // typical scripts, which is well within Next's response-size limits.
  const url =
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}` +
    `?key=${encodeURIComponent(env.GOOGLE_DOCS_API_KEY)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 403 from the Docs API typically means "doc is private" rather than
    // "key is invalid" — surface a friendlier message for the common case
    // so users know to fix the doc-sharing setting.
    if (res.status === 403) {
      throw new GoogleDocsFetchError(
        "Google rejected the request — make sure the doc is shared as 'Anyone with the link can view'.",
        403,
      );
    }
    if (res.status === 404) {
      throw new GoogleDocsFetchError("Google Doc not found — check the URL.", 404);
    }
    throw new GoogleDocsFetchError(
      `Google Docs API ${res.status}: ${text.slice(0, 300) || res.statusText}`,
      res.status,
    );
  }
  return (await res.json()) as GoogleDocsDocument;
}
