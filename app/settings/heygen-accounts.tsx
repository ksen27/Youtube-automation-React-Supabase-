"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2, Power } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface Account {
  id: string;
  email: string;
  status: "active" | "cooldown" | "disabled";
  fail_count: number;
  cooldown_until: string | null;
  last_used_at: string | null;
  created_at: string;
  has_cookies: boolean;
}

// HeyGen account-pool management for the synthetic engine's avatar automation.
// Secrets are encrypted server-side; this panel only ever sees status fields.
export function HeygenAccounts() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [proxy, setProxy] = useState("");
  const [error, setError] = useState<string | null>(null);

  const q = useQuery<{ accounts: Account[]; error?: string }>({
    queryKey: ["heygen-accounts"],
    queryFn: () => fetch("/api/settings/heygen-accounts").then((r) => r.json()),
  });

  const add = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/settings/heygen-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, proxy: proxy.trim() || undefined }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `add failed (${r.status})`);
    },
    onSuccess: () => { setEmail(""); setPassword(""); setProxy(""); setError(null); qc.invalidateQueries({ queryKey: ["heygen-accounts"] }); },
    onError: (e) => setError((e as Error).message),
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Account["status"] }) => {
      await fetch("/api/settings/heygen-accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heygen-accounts"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => { await fetch(`/api/settings/heygen-accounts?id=${id}`, { method: "DELETE" }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heygen-accounts"] }),
  });

  const accounts = q.data?.accounts ?? [];
  const variant = (s: Account["status"]) => (s === "active" ? "success" : s === "cooldown" ? "warning" : "destructive");

  return (
    <Card>
      <CardHeader>
        <CardTitle>HeyGen accounts</CardTitle>
        <CardDescription>
          Account pool for avatar generation. Credentials are encrypted at rest. The worker rotates accounts on failure and cools down rate-limited ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.data?.error && <p className="text-xs text-danger">{q.data.error}</p>}

        {/* Add form */}
        <div className="flex flex-wrap items-end gap-2">
          <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-56" />
          <Input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" />
          <Input placeholder="proxy (optional — defaults to shared pool)" value={proxy} onChange={(e) => setProxy(e.target.value)} className="w-64" title="Leave blank to reuse the CelebForge proxy pool (YTDLP_PROXIES). Only set this to pin a specific exit IP to this account." />
          <Button type="button" variant="soft" size="sm" disabled={!email.trim() || !password || add.isPending} onClick={() => add.mutate()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}

        {/* List */}
        {accounts.length === 0 ? (
          <p className="text-sm text-fg-subtle">No accounts yet.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-[8px] border border-border bg-surface px-3 py-2 text-sm">
                <span className="truncate flex-1">{a.email}</span>
                <Badge variant={variant(a.status)}>{a.status}</Badge>
                {a.fail_count > 0 && <span className="text-[11px] text-fg-subtle tabular-nums">{a.fail_count} fail</span>}
                {a.has_cookies && <span className="text-[11px] text-emerald-400">session</span>}
                <span className="text-[11px] text-fg-subtle">{a.last_used_at ? new Date(a.last_used_at).toLocaleDateString() : "unused"}</span>
                <Button type="button" variant="ghost" size="xs" title={a.status === "disabled" ? "Enable" : "Disable"}
                  onClick={() => setStatus.mutate({ id: a.id, status: a.status === "disabled" ? "active" : "disabled" })}>
                  <Power className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={() => remove.mutate(a.id)}>
                  <Trash2 className="h-3.5 w-3.5 text-danger" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
