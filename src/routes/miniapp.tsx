import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Trash2,
  Pencil,
  Save,
  RefreshCw,
  Clock,
  MessageSquareText,
  Timer,
  BarChart3,
  ListChecks,
  Plus,
  ChevronLeft,
  ChevronRight,
  Hash,
  ArrowUp,
  ArrowDown,
  ChevronsUp,
  ChevronsDown,
  ArrowUpDown,
  Check,
  Shield,
  UserPlus,
  GripVertical,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

export const Route = createFileRoute("/miniapp")({
  head: () => ({
    meta: [
      { title: "Bot Admin Dashboard" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#17212b" },
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
  position?: number;
};
type PendingRow = {
  id: number;
  chat_id: number;
  message_id: number;
  delete_at: string;
  created_at: string;
};

const TELEGRAM_SCRIPT_SRC = "https://telegram.org/js/telegram-web-app.js";

async function ensureTelegramScriptLoaded(): Promise<void> {
  if (typeof window === "undefined") return;
  if ((window as any).Telegram?.WebApp) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = window.setTimeout(finish, 1200);
    let script = document.querySelector<HTMLScriptElement>(`script[src="${TELEGRAM_SCRIPT_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = TELEGRAM_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    const done = () => { window.clearTimeout(timer); finish(); };
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", done, { once: true });
  });
}

function hapticImpact(style: "light" | "medium" | "heavy" = "light") {
  try { (window as any).Telegram?.WebApp?.HapticFeedback?.impactOccurred(style); } catch {}
}
function hapticNotify(type: "success" | "warning" | "error") {
  try { (window as any).Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type); } catch {}
}

async function callApi<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/public/miniapp/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

type Tab = "stats" | "keywords" | "timer" | "pending" | "admins";

function MiniApp() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("stats");
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      await ensureTelegramScriptLoaded();
      const tg = (window as any).Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        try { tg.setHeaderColor("bg_color"); } catch {}
        try { tg.setBackgroundColor("#17212b"); } catch {}
      }
      if (!cancelled) setReady(true);
    }
    boot();
    return () => { cancelled = true; };
  }, []);

  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => callApi<{ user: { id: number; first_name?: string; username?: string } }>("me"),
    enabled: ready,
    retry: false,
  });

  if (!ready) {
    return (
      <div className="tg-app min-h-screen grid place-items-center">
        <p className="tg-hint">កំពុងផ្ទុក...</p>
      </div>
    );
  }

  // Open access — no auth gate. Any error is surfaced by individual panels.

  return (
    <div className="tg-app min-h-screen flex flex-col">
      <style>{tgStyles}</style>

      {/* Header */}
      <header className="tg-anim-header px-4 pt-4 pb-3 flex items-center gap-3">
        <div className="h-11 w-11 shrink-0 rounded-full bg-[var(--tg-btn)] grid place-items-center text-white font-bold text-lg shadow-lg shadow-[var(--tg-btn)]/30">
          {meQ.data?.user?.first_name?.[0]?.toUpperCase() ?? "A"}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold truncate">Bot Dashboard</h1>
          {meQ.data?.user && (
            <p className="tg-hint text-xs truncate">
              {meQ.data.user.first_name}
              {meQ.data.user.username ? ` · @${meQ.data.user.username}` : ""}
            </p>
          )}
        </div>
        <button
          aria-label="Refresh"
          onClick={() => { hapticImpact("light"); qc.invalidateQueries(); }}
          className="tg-press tg-spin-hover h-10 w-10 rounded-full grid place-items-center bg-[var(--tg-section)]"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      </header>

      {/* Content */}
      <main className="flex-1 px-3 pb-28 overflow-y-auto">
        <div key={tab} className="tg-anim-page tg-stagger">
          {tab === "stats" && <StatsPanel onGo={setTab} />}
          {tab === "keywords" && <KeywordsPanel />}
          {tab === "timer" && <TimerPanel />}
          {tab === "pending" && <PendingPanel />}
          {tab === "admins" && <AdminsPanel />}
        </div>
      </main>

      {/* Bottom tab bar — large clear buttons */}
      <nav className="tg-anim-nav fixed bottom-0 inset-x-0 bg-[var(--tg-section)] border-t border-white/5 pb-safe backdrop-blur-md">
        <div className="grid grid-cols-5 gap-1 px-2 py-2">
          <TabBtn icon={<BarChart3 />} label="ស្ថិតិ" active={tab === "stats"} onClick={() => { hapticImpact(); setTab("stats"); }} />
          <TabBtn icon={<MessageSquareText />} label="ពាក្យ" active={tab === "keywords"} onClick={() => { hapticImpact(); setTab("keywords"); }} />
          <TabBtn icon={<Timer />} label="Timer" active={tab === "timer"} onClick={() => { hapticImpact(); setTab("timer"); }} />
          <TabBtn icon={<ListChecks />} label="Pending" active={tab === "pending"} onClick={() => { hapticImpact(); setTab("pending"); }} />
          <TabBtn icon={<Shield />} label="Admin" active={tab === "admins"} onClick={() => { hapticImpact(); setTab("admins"); }} />
        </div>
      </nav>

      <Toaster position="top-center" />
    </div>
  );
}

function TabBtn({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`tg-press flex flex-col items-center justify-center gap-1 py-2 rounded-xl ${
        active ? "tg-tab-active bg-[var(--tg-btn)] text-white" : "text-[var(--tg-hint)]"
      }`}
    >
      <span className="[&_svg]:h-6 [&_svg]:w-6">{icon}</span>
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="tg-hint text-xs font-semibold uppercase tracking-wider px-2 mt-2 mb-2">{children}</h2>;
}

function StatsPanel({ onGo }: { onGo: (t: Tab) => void }) {
  const q = useQuery({
    queryKey: ["stats"],
    queryFn: () => callApi<{ replies_count: number; pending_count: number; global_timer: number }>("stats"),
  });

  return (
    <div className="space-y-3 pt-2">
      <SectionTitle>ទិដ្ឋភាពទូទៅ</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<MessageSquareText />}
          label="ពាក្យគន្លឹះ"
          value={q.isLoading ? "…" : String(q.data?.replies_count ?? 0)}
          onClick={() => onGo("keywords")}
        />
        <StatCard
          icon={<ListChecks />}
          label="សារនឹងលុប"
          value={q.isLoading ? "…" : String(q.data?.pending_count ?? 0)}
          onClick={() => onGo("pending")}
        />
      </div>
      <button
        onClick={() => onGo("timer")}
        className="tg-card w-full p-4 flex items-center gap-3 active:scale-[0.99] transition"
      >
        <div className="h-12 w-12 rounded-2xl bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center">
          <Timer className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1 text-left">
          <p className="tg-hint text-xs">Timer សកល</p>
          <p className="text-lg font-semibold truncate">{fmtDelay(q.data?.global_timer ?? 0)}</p>
        </div>
        <ChevronRight className="h-5 w-5 tg-hint" />
      </button>

      <SectionTitle>សកម្មភាពរហ័ស</SectionTitle>
      <div className="grid grid-cols-1 gap-2">
        <BigAction icon={<Plus />} label="បន្ថែមពាក្យគន្លឹះថ្មី" onClick={() => onGo("keywords")} />
        <BigAction icon={<Timer />} label="កែ Timer សកល" onClick={() => onGo("timer")} />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="tg-card p-4 text-left active:scale-[0.98] transition">
      <div className="flex items-center gap-2 tg-hint text-xs mb-2">
        <span className="[&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        {label}
      </div>
      <p className="text-3xl font-bold">{value}</p>
    </button>
  );
}

function BigAction({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={() => { hapticImpact("medium"); onClick(); }}
      className="w-full h-14 rounded-2xl bg-[var(--tg-btn)] text-white font-semibold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition shadow-lg shadow-black/20"
    >
      <span className="[&_svg]:h-5 [&_svg]:w-5">{icon}</span>
      {label}
    </button>
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
  const [reordering, setReordering] = useState(false);

  if (editing || creating) {
    return (
      <div className="pt-2">
        <button
          onClick={() => { setEditing(null); setCreating(false); }}
          className="flex items-center gap-1 tg-hint text-sm mb-3 px-2 py-2 active:opacity-70"
        >
          <ChevronLeft className="h-4 w-4" /> ត្រឡប់
        </button>
        <ReplyEditor
          initial={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); qc.invalidateQueries({ queryKey: ["replies"] }); qc.invalidateQueries({ queryKey: ["stats"] }); }}
        />
      </div>
    );
  }

  const replies = q.data?.replies ?? [];

  if (reordering) {
    return (
      <ReorderPanel
        replies={replies}
        onClose={() => { setReordering(false); qc.invalidateQueries({ queryKey: ["replies"] }); }}
      />
    );
  }

  return (
    <div className="space-y-3 pt-2">
      <BigAction icon={<Plus />} label="បន្ថែមពាក្យថ្មី" onClick={() => setCreating(true)} />
      {replies.length > 1 && (
        <button
          onClick={() => { hapticImpact("medium"); setReordering(true); }}
          className="w-full h-12 rounded-2xl bg-[var(--tg-section-2)] font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98]"
        >
          <ArrowUpDown className="h-5 w-5" /> ↕️ តម្រៀបទីតាំង
        </button>
      )}
      {q.isLoading && <p className="tg-hint text-sm text-center py-6">កំពុងផ្ទុក...</p>}
      {!q.isLoading && replies.length === 0 && (
        <div className="tg-card p-8 text-center">
          <Hash className="h-10 w-10 mx-auto mb-2 tg-hint" />
          <p className="tg-hint text-sm">មិនទាន់មានពាក្យគន្លឹះ</p>
        </div>
      )}
      <div className="space-y-2">
        {replies.map((r, i) => (
          <div key={r.keyword} className="tg-card p-3 flex items-center gap-3">
            <div className="h-11 w-11 shrink-0 rounded-xl bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center font-bold text-sm">
              {i + 1}
            </div>
            <button onClick={() => setEditing(r)} className="min-w-0 flex-1 text-left active:opacity-70">
              <p className="font-semibold truncate">{r.keyword}</p>
              <p className="tg-hint text-xs flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3" /> {fmtDelay(r.delete_after_seconds)} · {Array.isArray(r.content) ? r.content.length : 1} សារ
              </p>
            </button>
            <button
              onClick={() => setEditing(r)}
              className="h-10 w-10 rounded-xl bg-[var(--tg-section-2)] grid place-items-center active:scale-95"
              aria-label="Edit"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <DeleteBtn keyword={r.keyword} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ReorderPanel({ replies, onClose }: { replies: Reply[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [order, setOrder] = useState<string[]>(replies.map((r) => r.keyword));
  const [jumpFor, setJumpFor] = useState<string | null>(null);
  const [jumpVal, setJumpVal] = useState("");

  const save = useMutation({
    mutationFn: (keywords: string[]) => callApi("reorder_replies", { keywords }),
    onSuccess: () => { hapticNotify("success"); qc.invalidateQueries({ queryKey: ["replies"] }); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });

  const commit = (next: string[]) => {
    setOrder(next);
    save.mutate(next);
  };

  const move = (idx: number, target: number) => {
    if (target < 0 || target >= order.length || target === idx) return;
    hapticImpact("light");
    const next = order.slice();
    const [k] = next.splice(idx, 1);
    next.splice(target, 0, k);
    commit(next);
  };

  const jump = (idx: number) => {
    const n = parseInt(jumpVal, 10);
    if (!Number.isFinite(n) || n < 1 || n > order.length) {
      toast.error(`លេខត្រូវនៅចន្លោះ 1 ដល់ ${order.length}`);
      return;
    }
    move(idx, n - 1);
    setJumpFor(null);
    setJumpVal("");
  };

  return (
    <div className="pt-2 space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          className="flex items-center gap-1 tg-hint text-sm px-2 py-2 active:opacity-70"
        >
          <ChevronLeft className="h-4 w-4" /> រួចរាល់
        </button>
        <p className="tg-hint text-xs flex-1 text-right">
          {save.isPending ? "កំពុងរក្សាទុក..." : "រក្សាទុកដោយស្វ័យប្រវត្តិ"}
        </p>
      </div>

      <div className="tg-card p-3">
        <p className="tg-hint text-xs mb-1">↕️ តម្រៀបទីតាំងពាក្យបញ្ជា</p>
        <p className="text-xs">ចុច 🔼 🔽 ដើម្បីប្តូរ ឬចុចលេខ # ដើម្បីលោតទៅទីតាំងណាមួយ</p>
      </div>

      <div className="space-y-2">
        {order.map((kw, i) => (
          <div key={kw} className="tg-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => { hapticImpact(); setJumpFor(jumpFor === kw ? null : kw); setJumpVal(String(i + 1)); }}
                className="h-11 w-11 shrink-0 rounded-xl bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center font-bold text-sm active:scale-95"
                aria-label="Jump"
              >
                #{i + 1}
              </button>
              <p className="font-semibold truncate flex-1">{kw}</p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <ReorderBtn icon={<ChevronsUp className="h-5 w-5" />} label="ដើម" disabled={i === 0} onClick={() => move(i, 0)} />
              <ReorderBtn icon={<ArrowUp className="h-5 w-5" />} label="ឡើង" disabled={i === 0} onClick={() => move(i, i - 1)} />
              <ReorderBtn icon={<ArrowDown className="h-5 w-5" />} label="ចុះ" disabled={i === order.length - 1} onClick={() => move(i, i + 1)} />
              <ReorderBtn icon={<ChevronsDown className="h-5 w-5" />} label="ចុង" disabled={i === order.length - 1} onClick={() => move(i, order.length - 1)} />
            </div>
            {jumpFor === kw && (
              <div className="mt-3 flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={order.length}
                  value={jumpVal}
                  onChange={(e) => setJumpVal(e.target.value)}
                  placeholder={`1 - ${order.length}`}
                  className="tg-input h-12 text-base"
                />
                <button
                  onClick={() => jump(i)}
                  className="h-12 px-4 rounded-xl bg-[var(--tg-btn)] text-white font-semibold flex items-center gap-1 active:scale-95"
                >
                  <Check className="h-4 w-4" /> លោត
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReorderBtn({ icon, label, disabled, onClick }: { icon: React.ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-12 rounded-xl bg-[var(--tg-section-2)] flex flex-col items-center justify-center gap-0.5 active:scale-95 disabled:opacity-30 disabled:active:scale-100"
    >
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}



function DeleteBtn({ keyword }: { keyword: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => callApi("delete_reply", { keyword }),
    onSuccess: () => { hapticNotify("success"); toast.success("លុបរួចរាល់"); qc.invalidateQueries({ queryKey: ["replies"] }); qc.invalidateQueries({ queryKey: ["stats"] }); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });
  return (
    <button
      onClick={() => { if (confirm(`លុបពាក្យ "${keyword}"?`)) m.mutate(); }}
      disabled={m.isPending}
      className="h-10 w-10 rounded-xl bg-red-500/15 text-red-400 grid place-items-center active:scale-95 disabled:opacity-50"
      aria-label="Delete"
    >
      <Trash2 className="h-4 w-4" />
    </button>
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
    onSuccess: () => { hapticNotify("success"); toast.success("រក្សាទុករួចរាល់"); onSaved(); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });

  const presets = [0, 10, 30, 60, 300];

  return (
    <div className="space-y-4">
      <div className="tg-card p-4 space-y-3">
        <div>
          <Label className="tg-hint text-xs">ពាក្យគន្លឹះ</Label>
          <Input
            className="tg-input h-12 mt-1 text-base"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={!!initial}
            placeholder="@username ឬ ពាក្យ"
          />
        </div>
        <div>
          <Label className="tg-hint text-xs">មាតិកា (បំបែកដោយ <code>---</code>)</Label>
          <Textarea
            className="tg-input mt-1 text-base min-h-[140px]"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"សួស្តី!\n---\nសារទី២"}
          />
          {hasMedia && <p className="tg-hint text-xs mt-1">មាន media — អាចកែតែអត្ថបទ។</p>}
        </div>
      </div>

      <div className="tg-card p-4 space-y-3">
        <Label className="tg-hint text-xs">Timer លុបសារ (វិនាទី)</Label>
        <Input
          type="number"
          min={0}
          className="tg-input h-12 text-base"
          value={timer}
          onChange={(e) => setTimer(e.target.value)}
          placeholder="ទុកទទេបើប្រើ Timer សកល"
        />
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => setTimer(String(p))}
              className={`h-9 px-3 rounded-full text-sm font-medium ${timer === String(p) ? "bg-[var(--tg-btn)] text-white" : "bg-[var(--tg-section-2)] tg-hint"}`}
            >
              {fmtDelay(p)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onClose} disabled={m.isPending} className="h-14 text-base rounded-2xl">
          បោះបង់
        </Button>
        <button
          onClick={() => m.mutate()}
          disabled={m.isPending}
          className="h-14 rounded-2xl bg-[var(--tg-btn)] text-white font-semibold text-base flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
        >
          <Save className="h-5 w-5" /> រក្សាទុក
        </button>
      </div>
    </div>
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
    onSuccess: () => { hapticNotify("success"); toast.success("រក្សាទុករួចរាល់"); qc.invalidateQueries(); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });

  const presets = [0, 10, 30, 60, 120, 300, 600];

  return (
    <div className="space-y-3 pt-2">
      <div className="tg-card p-6 text-center">
        <p className="tg-hint text-xs mb-1">Timer សកលបច្ចុប្បន្ន</p>
        <p className="text-4xl font-bold">{fmtDelay(Number(val) || 0)}</p>
      </div>

      <div className="tg-card p-4 space-y-3">
        <Label className="tg-hint text-xs">បញ្ចូលរយៈពេល (វិនាទី)</Label>
        <Input
          type="number"
          min={0}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="tg-input h-14 text-xl text-center font-semibold"
        />
        <div className="grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => { hapticImpact(); setVal(String(p)); }}
              className={`h-12 rounded-xl text-sm font-semibold ${val === String(p) ? "bg-[var(--tg-btn)] text-white" : "bg-[var(--tg-section-2)]"}`}
            >
              {fmtDelay(p)}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="w-full h-14 rounded-2xl bg-[var(--tg-btn)] text-white font-semibold text-base active:scale-[0.98] disabled:opacity-60 shadow-lg shadow-black/20"
      >
        រក្សាទុក
      </button>
      <p className="tg-hint text-xs text-center px-4">សារដែលគ្មាន per-keyword timer នឹងប្រើតម្លៃនេះ។ 0 = មិនលុប។</p>
    </div>
  );
}

function PendingPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["pending"],
    queryFn: () => callApi<{ pending: PendingRow[] }>("list_pending"),
    refetchInterval: 5000,
  });
  const m = useMutation({
    mutationFn: () => callApi("clear_pending"),
    onSuccess: () => { hapticNotify("success"); toast.success("លុបបញ្ជីរួចរាល់"); qc.invalidateQueries(); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });

  const rows = q.data?.pending ?? [];

  return (
    <div className="space-y-3 pt-2">
      <div className="tg-card p-4 flex items-center justify-between gap-3">
        <div>
          <p className="tg-hint text-xs">សារកំពុងរង់ចាំ</p>
          <p className="text-3xl font-bold">{rows.length}</p>
        </div>
        <button
          onClick={() => { if (confirm("លុបបញ្ជីទាំងអស់?")) m.mutate(); }}
          disabled={m.isPending || rows.length === 0}
          className="h-12 px-5 rounded-2xl bg-red-500 text-white font-semibold active:scale-95 disabled:opacity-40"
        >
          សម្អាត
        </button>
      </div>

      {q.isLoading && <p className="tg-hint text-sm text-center py-6">កំពុងផ្ទុក...</p>}
      {!q.isLoading && rows.length === 0 && (
        <div className="tg-card p-8 text-center">
          <ListChecks className="h-10 w-10 mx-auto mb-2 tg-hint" />
          <p className="tg-hint text-sm">គ្មានសារកំពុងរង់ចាំ</p>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((r) => {
          const ms = new Date(r.delete_at).getTime() - Date.now();
          const overdue = ms < 0;
          return (
            <div key={r.id} className="tg-card p-3 flex items-center gap-3">
              <div className={`h-11 w-11 shrink-0 rounded-xl grid place-items-center ${overdue ? "bg-red-500/15 text-red-400" : "bg-[var(--tg-btn)]/15 text-[var(--tg-btn)]"}`}>
                <Clock className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm truncate">Chat #{r.chat_id} · msg {r.message_id}</p>
                <p className="tg-hint text-xs">{new Date(r.delete_at).toLocaleString()}</p>
              </div>
              <span className={`text-xs font-semibold shrink-0 ${overdue ? "text-red-400" : "tg-hint"}`}>
                {overdue ? "ហួស" : `${Math.round(ms / 1000)}វិ`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const tgStyles = `
.tg-app {
  --tg-bg: var(--tg-theme-bg-color, #17212b);
  --tg-section: var(--tg-theme-secondary-bg-color, #232e3c);
  --tg-section-2: rgba(255,255,255,0.06);
  --tg-text: var(--tg-theme-text-color, #ffffff);
  --tg-hint: var(--tg-theme-hint-color, #7d8e9a);
  --tg-btn: var(--tg-theme-button-color, #2ea6ff);
  --tg-btn-text: var(--tg-theme-button-text-color, #ffffff);
  background: var(--tg-bg);
  color: var(--tg-text);
  font-family: "Kantumruy Pro", -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif;
}
.tg-card {
  background: var(--tg-section);
  border-radius: 16px;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.tg-card:active { transform: scale(.985); }
.tg-hint { color: var(--tg-hint); }
.tg-input {
  background: var(--tg-section-2) !important;
  border: 1px solid rgba(255,255,255,0.08) !important;
  color: var(--tg-text) !important;
  border-radius: 12px !important;
  transition: border-color .2s ease, box-shadow .2s ease;
}
.tg-input:focus { border-color: var(--tg-btn) !important; box-shadow: 0 0 0 3px color-mix(in oklab, var(--tg-btn) 25%, transparent) !important; }
.tg-input::placeholder { color: var(--tg-hint); }
.pb-safe { padding-bottom: max(env(safe-area-inset-bottom), 8px); }

/* ===== Animations ===== */
@keyframes tgFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes tgSlideDown { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
@keyframes tgSlideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes tgPop { 0% { transform: scale(.9); opacity: 0; } 60% { transform: scale(1.04); opacity: 1; } 100% { transform: scale(1); } }
@keyframes tgShimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes tgSpin { to { transform: rotate(360deg); } }
@keyframes tgPulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--tg-btn) 55%, transparent); } 50% { box-shadow: 0 0 0 8px color-mix(in oklab, var(--tg-btn) 0%, transparent); } }
@keyframes tgFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

.tg-anim-page { animation: tgFadeIn .32s cubic-bezier(.2,.7,.2,1) both; }
.tg-anim-header { animation: tgSlideDown .45s cubic-bezier(.2,.7,.2,1) both; }
.tg-anim-nav { animation: tgSlideUp .5s cubic-bezier(.2,.7,.2,1) both; }
.tg-stagger > * { animation: tgSlideUp .38s cubic-bezier(.2,.7,.2,1) both; opacity: 0; }
.tg-stagger > *:nth-child(1) { animation-delay: .04s; }
.tg-stagger > *:nth-child(2) { animation-delay: .09s; }
.tg-stagger > *:nth-child(3) { animation-delay: .14s; }
.tg-stagger > *:nth-child(4) { animation-delay: .19s; }
.tg-stagger > *:nth-child(5) { animation-delay: .24s; }
.tg-stagger > *:nth-child(6) { animation-delay: .29s; }
.tg-stagger > *:nth-child(7) { animation-delay: .34s; }
.tg-stagger > *:nth-child(8) { animation-delay: .39s; }
.tg-stagger > *:nth-child(n+9) { animation-delay: .44s; }

.tg-press { transition: transform .12s ease, background .18s ease, color .18s ease; }
.tg-press:active { transform: scale(.94); }
.tg-tab-active { animation: tgPop .35s cubic-bezier(.2,.7,.2,1) both, tgPulse 2.4s ease-in-out .4s infinite; }
.tg-tab-active svg { animation: tgFloat 2.4s ease-in-out infinite; }

.tg-spin-hover:active svg { animation: tgSpin .6s linear; }

.tg-shimmer {
  background: linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--tg-btn) 18%, transparent) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: tgShimmer 1.4s linear infinite;
  border-radius: 8px;
}

@media (prefers-reduced-motion: reduce) {
  .tg-anim-page, .tg-anim-header, .tg-anim-nav,
  .tg-stagger > *, .tg-tab-active, .tg-tab-active svg,
  .tg-shimmer { animation: none !important; opacity: 1 !important; }
}
`;

type AdminIdRow = { id: number; from_env: boolean };

function AdminsPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admins"],
    queryFn: () => callApi<{ admin_ids: AdminIdRow[] }>("list_admins"),
  });

  const [newId, setNewId] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admins"] });

  const addId = useMutation({
    mutationFn: (id: number) => callApi("add_admin_id", { admin_id: id }),
    onSuccess: () => { hapticNotify("success"); toast.success("បន្ថែម Admin ID រួចរាល់"); setNewId(""); invalidate(); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });
  const removeId = useMutation({
    mutationFn: (id: number) => callApi("remove_admin_id", { admin_id: id }),
    onSuccess: () => { hapticNotify("success"); toast.success("លុប Admin រួចរាល់"); invalidate(); },
    onError: (e: Error) => { hapticNotify("error"); toast.error(e.message); },
  });

  return (
    <div className="space-y-4 pt-2">
      <SectionTitle>👥 Admin IDs</SectionTitle>
      <div className="tg-card p-4 space-y-3">
        <p className="tg-hint text-xs">
          Telegram user ID ដែលអាចប្រើប្រាស់ bot ក្នុង private chat។ ID ពី secret <code>ADMIN_CHAT_ID</code> ត្រូវបានចាក់សោ (មិនអាចលុប)។
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(newId.trim());
            if (!Number.isFinite(n) || n <= 0) { toast.error("ID មិនត្រឹមត្រូវ"); return; }
            addId.mutate(n);
          }}
          className="flex gap-2"
        >
          <Input
            className="tg-input flex-1"
            placeholder="Telegram User ID (ឧ. 123456789)"
            inputMode="numeric"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <Button type="submit" disabled={addId.isPending} className="shrink-0">
            <UserPlus className="h-4 w-4 mr-1" /> បន្ថែម
          </Button>
        </form>

        <div className="space-y-2">
          {q.isLoading && <p className="tg-hint text-sm">កំពុងផ្ទុក...</p>}
          {q.data?.admin_ids.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 p-3 rounded-xl bg-[var(--tg-section-2)]">
              <div className="min-w-0">
                <div className="font-mono text-sm truncate">{r.id}</div>
                {r.from_env && <Badge variant="secondary" className="mt-1">Secret (locked)</Badge>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={r.from_env || removeId.isPending}
                onClick={() => {
                  if (confirm(`លុប Admin ${r.id}?`)) removeId.mutate(r.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {q.data && q.data.admin_ids.length === 0 && (
            <p className="tg-hint text-sm">មិនទាន់មាន Admin</p>
          )}
        </div>
      </div>
    </div>
  );
}

