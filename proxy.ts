import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Access gate. In Next 16 the old `middleware.ts` convention is renamed to
// `proxy.ts` (the `proxy` export below) — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// Everything is locked behind the shared CelebForge password EXCEPT the login
// page and the login/logout API (otherwise you could never get in). Static
// assets and image-optimizer routes are excluded via the matcher so the login
// page can actually render its CSS/fonts.

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
]);

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authed = await verifySessionToken(token);
  if (authed) return NextResponse.next();

  // Unauthenticated. API callers get a clean 401 (no HTML redirect to confuse
  // fetch); page navigations get bounced to /login with a `next` param so we
  // can send them back where they were headed after a successful login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname && pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on every route EXCEPT Next internals and static files. API routes are
  // intentionally included so the tool's backend is locked too. `favicon.ico`
  // and the like are skipped so they render on the public login page.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
