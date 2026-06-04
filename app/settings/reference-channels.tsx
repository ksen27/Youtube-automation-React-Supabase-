"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// Reference channels the subject-centric search pipeline queries FIRST (scoped
// to each channelId, ordered by priority) before falling back to open YouTube.
// This card lets the user add channels by URL/@handle/id, reorder by priority,
// toggle them on/off, and remove them.

export interface ReferenceChannel {
  id: string;
  channel_id: string | null;
  channel_title: string | null;
  enabled: boolean;
  priority: number;
}

export function ReferenceChannels({ initial }: { initial: ReferenceChannel[] }) {
  const [channels, setChannels] = useState<ReferenceChannel[]>(initial);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function sortByPriority(list: ReferenceChannel[]): ReferenceChannel[] {
    return [...list].sort((a, b) => a.priority - b.priority);
  }

  async function add() {
    const value = ref.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: value }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `add failed (${res.status})`);
      setChannels((prev) => sortByPriority([...prev, json.channel]));
      setRef("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, patch: { enabled?: boolean; priority?: number }) {
    setError(null);
    // Optimistic update; revert on failure.
    const prev = channels;
    setChannels((cur) => sortByPriority(cur.map((c) => (c.id === id ? { ...c, ...patch } : c))));
    try {
      const res = await fetch("/api/settings/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `update failed (${res.status})`);
      }
    } catch (e) {
      setChannels(prev);
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    setError(null);
    const prev = channels;
    setChannels((cur) => cur.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/settings/channels?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `delete failed (${res.status})`);
      }
    } catch (e) {
      setChannels(prev);
      setError((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reference channels</CardTitle>
        <CardDescription>
          Searched first for the primary subject. Lower priority runs earlier; open YouTube is used only to fill the shortfall.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Channel URL, @handle, or channel id"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            disabled={busy}
          />
          <Button onClick={add} disabled={busy || !ref.trim()}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}

        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reference channels yet. Add a channel to prioritize its footage.
          </p>
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-md border border-border p-2">
                <div className="flex items-center gap-1">
                  <label className="text-xs text-muted-foreground">Priority</label>
                  <Input
                    type="number"
                    className="h-8 w-16"
                    value={c.priority}
                    min={1}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (Number.isFinite(v)) patch(c.id, { priority: v });
                    }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.channel_title ?? "—"}</div>
                  <code className="block truncate text-xs text-muted-foreground">{c.channel_id ?? ""}</code>
                </div>
                <Button
                  variant={c.enabled ? "soft" : "outline"}
                  size="sm"
                  onClick={() => patch(c.id, { enabled: !c.enabled })}
                >
                  {c.enabled ? <Badge variant="success">enabled</Badge> : "disabled"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => remove(c.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
