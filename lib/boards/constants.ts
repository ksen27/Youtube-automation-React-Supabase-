// Constants shared by the browser client and the route handlers.
//
// Kept in their own module because lib/boards/http.ts imports the Supabase
// service-role client (through ./access) — importing that from a "use client"
// file would drag server-only code into the browser bundle.

/**
 * Header carrying the acting board member's id. A claim about identity, not a
 * credential: see lib/boards/access.ts for how the server validates it.
 */
export const ACTOR_HEADER = "x-board-actor";
