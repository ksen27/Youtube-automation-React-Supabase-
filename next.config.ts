import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Parsers for uploaded reference books. Left to Next, these get bundled into
   * the serverless output of every route that touches the ebook DI container —
   * and `pdf-parse` ships worker files it loads at runtime, which bundling does
   * not carry across. The module then fails to load on the server before any
   * handler runs: a 500 that no try/catch inside the page can absorb, and which
   * never reproduces locally because dev and `next start` resolve from
   * node_modules.
   *
   * Listing them here keeps them as plain node_modules requires. They are also
   * imported lazily (see FileTextExtractor) so the web app never loads them at
   * all — only the worker, which is where files are actually parsed.
   */
  serverExternalPackages: ["pdf-parse", "mammoth"],
};

export default nextConfig;
