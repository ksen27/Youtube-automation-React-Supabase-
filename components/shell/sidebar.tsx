"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, FolderClosed, Settings, Sparkles, Bot, Image as ImageIcon, Megaphone, BookOpen, KanbanSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// Top-level products in this one app:
//   Celebrity Videos — the sourced engine (edit real YouTube footage) at /dashboard
//   AI Avatar        — the synthetic engine (AI-generated avatar videos) at /avatar
//   Sales Pitch      — standalone tool: generate a sales-pitch video (avatar +
//                      website scroll-recording) at /sales-pitch, then upload it
//                      to an AI Avatar project. Kept SEPARATE from AI Avatar so
//                      the two aren't confused (client 2026-07-21).
//   Thumbnails       — YouTube thumbnail generation (Pikzels) at /thumbnails
//   Boards           — Trello-style project management for the team at
//                      /boards. Independent of the render pipeline; a board can
//                      optionally reference a video project.
//   Ebooks           — the ebook engine (YouTube channel → ~100-page book,
//                      PDF + DOCX) at /books. Its own pipeline and Postgres
//                      schema; shares only Redis and the 69labs account.
const NAV = [
  { href: "/dashboard", label: "Celebrity Videos", icon: FolderClosed },
  { href: "/avatar", label: "AI Avatar", icon: Bot },
  { href: "/books", label: "Ebooks", icon: BookOpen },
  { href: "/sales-pitch", label: "Sales Pitch", icon: Megaphone },
  { href: "/thumbnails", label: "Thumbnails", icon: ImageIcon },
  { href: "/boards", label: "Boards", icon: KanbanSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "hidden md:flex md:flex-col shrink-0 border-r border-border bg-bg-elevated transition-[width] duration-200",
        collapsed ? "md:w-16" : "md:w-60",
      )}
    >
      <div className="flex h-14 items-center gap-2 px-4 border-b border-border">
        <div className="grid place-items-center h-7 w-7 rounded-md gradient-brand shadow-sm shrink-0">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        {!collapsed && (
          <span className="font-semibold tracking-tight text-fg">Reel</span>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                "group flex items-center gap-3 rounded-md px-3 h-9 text-sm font-medium transition-colors",
                active
                  ? "bg-surface-hover text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                collapsed && "justify-center px-0",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
              {active && !collapsed && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-500 shadow-[0_0_8px_var(--color-brand-500)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="px-2 py-2 border-t border-border">
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-full items-center justify-center rounded-md text-fg-subtle hover:bg-surface-hover hover:text-fg transition-colors"
        >
          <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
        </button>
      </div>
    </aside>
  );
}
