import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Trash2, Pencil, Save, RefreshCw, Clock } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

export const Route = createFileRoute("/miniapp")({
  head: () => ({
    meta: [
      { title: "Bot Admin Dashboard" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
    ],
    scripts: [{ src: "https://telegram.org/js/telegram-web-app.js" }],
  }),
  component: MiniApp,
});

type ContentItem = {
  type: "text" | "photo" | "video" | "audio" | "voice" | "document" | "animation" | "sticker";
  text?: string;
  file_id?: string;
  caption?: string;
};
type Reply = {
  keyword: string;
  content: ContentItem[];
  delete_after_seconds: number | null;
  updated_at: string;
};
type PendingRow = {
  id: number;
  chat_id: number;
  message_id: number;
  delete_at: string;
  created_at: string;
};

function getInitData(): string {
  if (typeof window === "undefined") return "";
  const tg = (window as any).Telegram?.WebApp;
  return tg?.initData ?? "";
}

async function callApi<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/public/miniapp/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": getInitData(),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmtDelay(s: number | null | undefined): string {
  if (s == null) return "ប្រើ Timer សកល";
  if (s === 0) return "បិទ (មិនលុប)";
  if (s < 60) return `${s} វិនាទី`;
  if (s % 60 === 0) return `${s / 60} នាទី`;
  return `${s} វិនាទី`;
}

function MiniApp() {
  const [ready, setReady] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor("secondary_bg_color"); } catch {}
    }
    setReady(true);
  }, []);

  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => callApi<{ user: { id: number; first_name?: string; username?: string } }>("me"),
    enabled: ready,
    retry: false,
  });

  useEffect(() => {
    if (meQ.error) setAuthErr((meQ.error as Error).message);
  }, [meQ.error]);

  if (!ready) return <div className="p-6 text-center text-muted-foreground">កំពុងផ្ទុក...</div>;

  if (authErr) {
    return (
      <div className="p-6 max-w-md mx-auto">
        <Card>
          <CardHeader><CardTitle>មិនមានសិទ្ធិចូល</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Mini App នេះត្រូវបើកពី Telegram ដោយគណនី Admin តែប៉ុណ្ណោះ។
            </p>
            <pre className="text-xs bg-muted p-2 rounded overflow-auto">{authErr}</pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-safe">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Bot Dashboard</h1>
          {meQ.data?.user && (
            <p className="text-xs text-muted-foreground">
              {meQ.data.user.first_name} {meQ.data.user.username ? `@${meQ.data.user.username}` : ""}
            </p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => qc.invalidateQueries()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      <Tabs defaultValue="stats" className="px-3 pt-3">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="stats">ស្ថិតិ</TabsTrigger>
          <TabsTrigger value="keywords">ពាក្យ</TabsTrigger>
          <TabsTrigger value="timer">Timer</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
        </TabsList>

        <TabsContent value="stats" className="mt-3"><StatsPanel /></TabsContent>
        <TabsContent value="keywords" className="mt-3"><KeywordsPanel /></TabsContent>
        <TabsContent value="timer" className="mt-3"><TimerPanel /></TabsContent>
        <TabsContent value="pending" className="mt-3"><PendingPanel /></TabsContent>
      </Tabs>
      <Toaster />
    </div>
  );
}

function StatsPanel() {
  const q = useQuery({
    queryKey: ["stats"],
    queryFn: () => callApi<{ replies_count: number; pending_count: number; global_timer: number }>("stats"),
  });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">កំពុងផ្ទុក...</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  const d = q.data!;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">ពាក្យគន្លឹះ</p><p className="text-2xl font-bold">{d.replies_count}</p></CardContent></Card>
      <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">សារនឹងលុប</p><p className="text-2xl font-bold">{d.pending_count}</p></CardContent></Card>
      <Card className="col-span-2"><CardContent className="p-4"><p className="text-xs text-muted-foreground">Timer សកល</p><p className="text-xl font-semibold">{fmtDelay(d.global_timer)}</p></CardContent></Card>
    </div>
  );
}

function KeywordsPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["replies"],
    queryFn: () => callApi<{ replies: Reply[] }>("list_replies"),
  });
  const [editing, setEditing] = useState<Reply | null>(null);
  const [creating, setCreating] = useState(false);

  if (q.isLoading) return <p className="text-sm text-muted-foreground">កំពុងផ្ទុក...</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  const replies = q.data?.replies ?? [];

  if (editing || creating) {
    return (
      <ReplyEditor
        initial={editing}
        onClose={() => { setEditing(null); setCreating(false); }}
        onSaved={() => { setEditing(null); setCreating(false); qc.invalidateQueries({ queryKey: ["replies"] }); qc.invalidateQueries({ queryKey: ["stats"] }); }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <Button className="w-full" onClick={() => setCreating(true)}>+ បន្ថែមពាក្យថ្មី</Button>
      {replies.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">មិនទាន់មានពាក្យគន្លឹះ</p>}
      {replies.map((r) => (
        <Card key={r.keyword}>
          <CardContent className="p-3 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{r.keyword}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" /> {fmtDelay(r.delete_after_seconds)} · {Array.isArray(r.content) ? r.content.length : 1} សារ
              </p>
            </div>
            <Button size="icon" variant="ghost" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
            <DeleteBtn keyword={r.keyword} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function DeleteBtn({ keyword }: { keyword: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => callApi("delete_reply", { keyword }),
    onSuccess: () => { toast.success("លុបរួចរាល់"); qc.invalidateQueries({ queryKey: ["replies"] }); qc.invalidateQueries({ queryKey: ["stats"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button size="icon" variant="ghost" onClick={() => { if (confirm(`លុបពាក្យ "${keyword}"?`)) m.mutate(); }} disabled={m.isPending}>
      <Trash2 className="h-4 w-4 text-destructive" />
    </Button>
  );
}

function ReplyEditor({ initial, onClose, onSaved }: { initial: Reply | null; onClose: () => void; onSaved: () => void }) {
  const [keyword, setKeyword] = useState(initial?.keyword ?? "");
  const initialText = useMemo(() => {
    if (!initial) return "";
    const items = Array.isArray(initial.content) ? initial.content : [];
    return items
      .map((it) => (it.type === "text" ? it.text ?? "" : `[${it.type}${it.caption ? `: ${it.caption}` : ""}]`))
      .join("\n---\n");
  }, [initial]);
  const [text, setText] = useState(initialText);
  const [timer, setTimer] = useState<string>(initial?.delete_after_seconds == null ? "" : String(initial.delete_after_seconds));
  const hasMedia = (initial?.content ?? []).some((c) => c.type !== "text");

  const m = useMutation({
    mutationFn: async () => {
      const kw = keyword.trim();
      if (!kw) throw new Error("ត្រូវការពាក្យគន្លឹះ");
      let content: ContentItem[];
      if (hasMedia && initial) {
        // preserve media items; only allow editing text items
        const blocks = text.split(/\n---\n/);
        const original = initial.content;
        content = original.map((c, i) =>
          c.type === "text" ? { type: "text", text: blocks[i] ?? c.text ?? "" } : c,
        );
      } else {
        const blocks = text.split(/\n---\n/).map((t) => t.trim()).filter(Boolean);
        if (blocks.length === 0) throw new Error("ត្រូវការអត្ថបទ");
        content = blocks.map((t) => ({ type: "text" as const, text: t }));
      }
      const delete_after_seconds = timer === "" ? null : Number(timer);
      if (timer !== "" && (!Number.isFinite(delete_after_seconds) || delete_after_seconds! < 0)) {
        throw new Error("Timer មិនត្រឹមត្រូវ");
      }
      return callApi("upsert_reply", { keyword: kw, content, delete_after_seconds });
    },
    onSuccess: () => { toast.success("រក្សាទុករួចរាល់"); onSaved(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{initial ? "កែប្រែ" : "ពាក្យថ្មី"}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>ពាក្យគន្លឹះ</Label>
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} disabled={!!initial} placeholder="@username ឬ ពាក្យ" />
        </div>
        <div>
          <Label>មាតិកា (បំបែកដោយ <code>---</code> សម្រាប់សារច្រើន)</Label>
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"សួស្តី!\n---\nសារទី២"} />
          {hasMedia && <p className="text-xs text-muted-foreground mt-1">សារនេះមាន media — អាចកែតែអត្ថបទប៉ុណ្ណោះ។ បើចង់ប្តូរ media សូមផ្ញើតាម bot។</p>}
        </div>
        <div>
          <Label>Timer លុបសារ (វិនាទី) — ទុកទទេបើប្រើ Timer សកល</Label>
          <Input type="number" min={0} value={timer} onChange={(e) => setTimer(e.target.value)} placeholder="ឧ. 30" />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="flex-1"><Save className="h-4 w-4" /> រក្សាទុក</Button>
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>បោះបង់</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TimerPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["config"],
    queryFn: () => callApi<{ config: { delete_after_seconds: number } }>("get_config"),
  });
  const [val, setVal] = useState<string>("");
  useEffect(() => { if (q.data) setVal(String(q.data.config.delete_after_seconds)); }, [q.data]);

  const m = useMutation({
    mutationFn: () => callApi("set_global_timer", { delete_after_seconds: Number(val) }),
    onSuccess: () => { toast.success("រក្សាទុករួចរាល់"); qc.invalidateQueries(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const presets = [0, 10, 30, 60, 120, 300, 600];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Timer សកល</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Label>រយៈពេល (វិនាទី) — <Badge variant="secondary">{fmtDelay(Number(val) || 0)}</Badge></Label>
        <Input type="number" min={0} value={val} onChange={(e) => setVal(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button key={p} size="sm" variant="outline" onClick={() => setVal(String(p))}>{fmtDelay(p)}</Button>
          ))}
        </div>
        <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">រក្សាទុក</Button>
        <p className="text-xs text-muted-foreground">សារដែលគ្មាន per-keyword timer នឹងប្រើតម្លៃនេះ។ 0 = មិនលុប។</p>
      </CardContent>
    </Card>
  );
}

function PendingPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["pending"],
    queryFn: () => callApi<{ pending: PendingRow[] }>("list_pending"),
    refetchInterval: 10000,
  });
  const m = useMutation({
    mutationFn: () => callApi("clear_pending"),
    onSuccess: () => { toast.success("លុបបញ្ជីរួចរាល់"); qc.invalidateQueries(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">កំពុងផ្ទុក...</p>;
  const rows = q.data?.pending ?? [];
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">{rows.length} សារកំពុងរង់ចាំលុប</p>
        <Button size="sm" variant="destructive" onClick={() => { if (confirm("លុបបញ្ជីទាំងអស់?")) m.mutate(); }} disabled={m.isPending || rows.length === 0}>សម្អាត</Button>
      </div>
      {rows.map((r) => {
        const ms = new Date(r.delete_at).getTime() - Date.now();
        return (
          <Card key={r.id}><CardContent className="p-3 text-sm">
            <div className="flex justify-between">
              <span>Chat #{r.chat_id}</span>
              <span className={ms < 0 ? "text-destructive" : "text-muted-foreground"}>
                {ms < 0 ? "ហួសម៉ោង" : `នៅសល់ ${Math.round(ms / 1000)}វិ`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">msg {r.message_id} · {new Date(r.delete_at).toLocaleString()}</p>
          </CardContent></Card>
        );
      })}
    </div>
  );
}
