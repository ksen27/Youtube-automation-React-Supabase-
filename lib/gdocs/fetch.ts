import { JWT } from "google-auth-library";
import { getEnv } from "@/lib/env";

// Pull a Google Doc's structured contents via the Docs API.
// Docs: https://developers.google.com/docs/api/reference/rest/v1/documents/get
//
// The Docs API rejects API keys with 401 UNAUTHENTICATED, so we authenticate
// with a service-account-minted OAuth2 access token instead. The service
// account either needs explicit share access to each doc, OR the doc must
// be set to "Anyone with the link can view" (which the service account
// counts as).
//
// The JWT client caches its own access token in-memory and only refreshes
// when the previous one is near expiry (Google's token TTL is 1 hour). So
// even a busy ingest stream pays the auth round-trip once per hour.

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

// readonly is sufficient — we never write to the user's doc.
const SCOPES = ["https://www.googleapis.com/auth/documents.readonly"];

// JWT auth client cached for the life of the worker process so we don't
// pay an OAuth round-trip for every doc fetch. The JWT itself handles
// access-token caching and refresh internally.
let cachedAuth: JWT | null = null;
let cachedAuthCredsHash: string | null = null;

interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
}

function parseServiceAccountJson(raw: string): ServiceAccountCreds {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GoogleDocsFetchError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the entire downloaded service-account key.",
      503,
    );
  }
  if (
    !json ||
    typeof json !== "object" ||
    !("client_email" in json) ||
    !("private_key" in json) ||
    typeof (json as Record<string, unknown>).client_email !== "string" ||
    typeof (json as Record<string, unknown>).private_key !== "string"
  ) {
    throw new GoogleDocsFetchError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key — re-download the JSON key.",
      503,
    );
  }
  const obj = json as Record<string, string>;
  // Vercel sometimes mangles the private_key newlines when pasted as a
  // plain env var (\n becomes a literal backslash-n). Normalize either form.
  const privateKey = obj.private_key.includes("\\n")
    ? obj.private_key.replace(/\\n/g, "\n")
    : obj.private_key;
  return { client_email: obj.client_email, private_key: privateKey };
}

function getAuthClient(): JWT {
  const env = getEnv();
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new GoogleDocsFetchError(
      "GOOGLE_SERVICE_ACCOUNT_JSON not configured. Create a service account in Google Cloud Console, " +
      "enable the Google Docs API, generate a JSON key, and paste it into this env var.",
      503,
    );
  }
  // Cheap fingerprint so a runtime env-var swap re-instantiates the client.
  // Slicing avoids logging or hashing the actual private key.
  const credsHash =
    env.GOOGLE_SERVICE_ACCOUNT_JSON.length.toString() +
    ":" +
    env.GOOGLE_SERVICE_ACCOUNT_JSON.slice(0, 20);
  if (cachedAuth && cachedAuthCredsHash === credsHash) return cachedAuth;

  const creds = parseServiceAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  cachedAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  cachedAuthCredsHash = credsHash;
  return cachedAuth;
}

export async function fetchGoogleDoc(documentId: string): Promise<GoogleDocsDocument> {
  const auth = getAuthClient();
  let accessToken: string | null | undefined;
  try {
    const tokenResp = await auth.getAccessToken();
    accessToken = tokenResp.token;
  } catch (e) {
    throw new GoogleDocsFetchError(
      `Failed to mint Google access token from service account: ${(e as Error).message}`,
      503,
    );
  }
  if (!accessToken) {
    throw new GoogleDocsFetchError(
      "Google returned an empty access token — service account JSON is likely malformed.",
      503,
    );
  }

  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new GoogleDocsFetchError(
        "Google rejected the request. Either share the doc with the service account's email " +
        "(check GOOGLE_SERVICE_ACCOUNT_JSON.client_email) or set the doc to 'Anyone with the link can view'.",
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
