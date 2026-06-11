import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in — CelebForge",
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl gradient-brand shadow-glow">
            {/* Sparkles glyph kept inline so the login page has no client deps */}
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-white"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 2l1.9 4.6L18.5 8.5 13.9 10.4 12 15l-1.9-4.6L5.5 8.5l4.6-1.9L12 2zm6.5 9l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2zM5 14l.7 1.8L7.5 16.5l-1.8.7L5 19l-.7-1.8L2.5 16.5l1.8-.7L5 14z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">CelebForge</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Internal tool — authorized access only.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface/70 p-6 shadow-lg backdrop-blur">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Access is restricted to the CelebForge organization.
        </p>
      </div>
    </main>
  );
}
