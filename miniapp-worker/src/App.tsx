import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  Loader2,
  CheckCircle2,
  Send,
  Images,
  Image as ImageIcon,
  Video,
  Mic,
  Music,
  FileText,
  Sticker,
  Film,
  TrendingUp,
  Users,
  Flame,
  CalendarClock,
} from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

export default function App() {
  return <MiniApp />;
}

type ContentItem = {
  type: "text" | "photo" | "video" | "audio" | "voice" | "document" | "animation" | "sticker" | "copy";
  text?: string;
  file_id?: string;
  caption?: string;
  media_group_id?: string;
  from_chat_id?: number;
  message_id?: number;
  forward?: boolean;
};
type Reply = {
  keyword: string;
  content: ContentItem[];
  delete_after_seconds: number | null;
  updated_at: string;
  position?: number;
  row_index?: number;
};

type ContentBlock =
  | { kind: "album"; items: ContentItem[]; startIndex: number }
  | { kind: "single"; item: ContentItem; index: number };

/**
 * Groups content items by media_group_id so an album (multiple photos/videos
 * sent together in Telegram) is treated as a single block — mirroring what
 * the bot sends via copyMessages.
 */
function groupContent(items: ContentItem[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const albumByKey = new Map<string, ContentBlock & { kind: "album" }>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const gid = it?.media_group_id;
    if (gid && it.type === "copy" && !it.forward) {
      const key = `${it.from_chat_id ?? "?"}::${gid}`;
      const existing = albumByKey.get(key);
      if (existing && existing.items.length < 10) {
        existing.items.push(it);
        continue;
      }
      const g: ContentBlock & { kind: "album" } = { kind: "album", items: [it], startIndex: i };
      albumByKey.set(key, g);
      blocks.push(g);
    } else {
      blocks.push({ kind: "single", item: it, index: i });
    }
  }
  // Sort album items by message_id so the preview matches the bot's send order.
  for (const b of blocks) {
    if (b.kind === "album") {
      b.items.sort((a, c) => (a.message_id ?? 0) - (c.message_id ?? 0));
    }
  }
  return blocks;
}

function itemTypeIcon(type: ContentItem["type"]) {
  switch (type) {
    case "photo": return <ImageIcon className="h-5 w-5" />;
    case "video": return <Video className="h-5 w-5" />;
    case "animation": return <Film className="h-5 w-5" />;
    case "audio": return <Music className="h-5 w-5" />;
    case "voice": return <Mic className="h-5 w-5" />;
    case "document": return <FileText className="h-5 w-5" />;
    case "sticker": return <Sticker className="h-5 w-5" />;
    default: return <ImageIcon className="h-5 w-5" />;
  }
}

/**
 * Renders content items as a preview, grouping album items (same media_group_id)
 * into a SINGLE gallery block — mirroring how Telegram displays albums in the bot.
 */
function MediaPreview({ items }: { items: ContentItem[] }) {
  const blocks = groupContent(items);
  if (blocks.length === 0) return null;
  return (
    <div className="tg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Images className="h-4 w-4 tg-hint" />
        <Label className="tg-hint text-xs">ការមើលជាមុន (ដូចក្នុង Telegram)</Label>
      </div>
      <div className="space-y-2">
        {blocks.map((b, bi) => {
          if (b.kind === "album") {
            const cols = b.items.length >= 4 ? 3 : b.items.length >= 2 ? 2 : 1;
            return (
              <div
                key={`a-${bi}`}
                className="rounded-2xl overflow-hidden border border-[var(--tg-btn)]/30 bg-[var(--tg-section-2)]"
              >
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--tg-btn)]/10">
                  <span className="text-xs font-semibold flex items-center gap-1.5">
                    <Images className="h-3.5 w-3.5" /> Album
                  </span>
                  <span className="tg-hint text-xs">{b.items.length} media</span>
                </div>
                <div
                  className="grid gap-0.5 p-0.5"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {b.items.map((it, ii) => (
                    <div
                      key={ii}
                      className="aspect-square bg-[var(--tg-bg)]/60 grid place-items-center text-[var(--tg-btn)]"
                    >
                      {itemTypeIcon(it.type === "copy" ? "photo" : it.type)}
                    </div>
                  ))}
                </div>
                {b.items.some((it) => it.caption) && (
                  <p className="px-3 py-2 text-sm border-t border-[var(--tg-btn)]/10 line-clamp-2">
                    {b.items.find((it) => it.caption)?.caption}
                  </p>
                )}
              </div>
            );
          }
          const it = b.item;
          if (it.type === "text") {
            return (
              <div
                key={`s-${bi}`}
                className="rounded-2xl bg-[var(--tg-section-2)] px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {it.text || <span className="tg-hint">(ទទេ)</span>}
              </div>
            );
          }
          return (
            <div
              key={`s-${bi}`}
              className="rounded-2xl bg-[var(--tg-section-2)] px-3 py-2 flex items-center gap-2 text-sm"
            >
              <span className="h-8 w-8 rounded-lg bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center">
                {itemTypeIcon(it.type)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {it.caption || <span className="tg-hint capitalize">{it.type}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

function getInitData(): string {
  try { return (window as any).Telegram?.WebApp?.initData ?? ""; } catch { return ""; }
}
function getAdminTokenFromUrl(): string {
  try {
    const u = new URL(window.location.href);
    return u.searchParams.get("token") ?? u.searchParams.get("admin_token") ?? "";
  } catch { return ""; }
}

async function callApi<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const initData = getInitData();
  if (initData) headers["x-init-data"] = initData;
  const adminToken = getAdminTokenFromUrl();
  if (adminToken) headers["x-admin-token"] = adminToken;

  const res = await fetch("/api/miniapp", {
    method: "POST",
    headers,
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

type Tab = "stats" | "analytics" | "keywords" | "schedule" | "timer" | "pending" | "admins";

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
        try { tg.setHeaderColor("#f4f6f8"); } catch {}
        try { tg.setBackgroundColor("#f4f6f8"); } catch {}
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
      <div className="min-h-screen grid place-items-center" style={{ background: "#f4f6f8", color: "#0f172a" }}>
        <style>{tgStyles}</style>
        <p style={{ color: "#64748b" }}>កំពុងផ្ទុក...</p>
      </div>
    );
  }

  // Auth: server verifies Telegram initData (or ?token= admin bypass). Panels surface 401s.

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
          {tab === "analytics" && <AnalyticsPanel />}
          {tab === "keywords" && <KeywordsPanel />}
          {tab === "schedule" && <SchedulePanel />}
          {tab === "timer" && <TimerPanel />}
          {tab === "pending" && <PendingPanel />}
          {tab === "admins" && <AdminsPanel />}
        </div>
      </main>

      {/* Bottom tab bar — large clear buttons */}
      <nav className="tg-anim-nav fixed bottom-0 inset-x-0 bg-[var(--tg-section)] border-t border-white/5 pb-safe backdrop-blur-md">
        <div className="grid grid-cols-7 gap-0.5 px-1 py-2">
          <TabBtn icon={<BarChart3 />} label="ស្ថិតិ" active={tab === "stats"} onClick={() => { hapticImpact(); setTab("stats"); }} />
          <TabBtn icon={<TrendingUp />} label="វិភាគ" active={tab === "analytics"} onClick={() => { hapticImpact(); setTab("analytics"); }} />
          <TabBtn icon={<MessageSquareText />} label="ពាក្យ" active={tab === "keywords"} onClick={() => { hapticImpact(); setTab("keywords"); }} />
          <TabBtn icon={<CalendarClock />} label="កំណត់ពេល" active={tab === "schedule"} onClick={() => { hapticImpact(); setTab("schedule"); }} />
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

function AnalyticsPanel() {
  const [range, setRange] = useState<7 | 14 | 30>(14);

  const overviewQ = useQuery({
    queryKey: ["analytics_overview"],
    queryFn: () => callApi<{ overview: {
      total_hits?: number; hits_today?: number; hits_7d?: number; hits_30d?: number;
      total_keywords?: number; total_groups?: number; active_groups_7d?: number;
    } }>("analytics_overview"),
  });
  const topQ = useQuery({
    queryKey: ["analytics_top_keywords", range],
    queryFn: () => callApi<{ keywords: { keyword: string; hits: number; last_used: string }[] }>(
      "analytics_top_keywords", { days: range, limit: 10 },
    ),
  });
  const dailyQ = useQuery({
    queryKey: ["analytics_daily", range],
    queryFn: () => callApi<{ daily: { day: string; hits: number }[] }>(
      "analytics_daily", { days: range },
    ),
  });
  const groupsQ = useQuery({
    queryKey: ["analytics_groups", range],
    queryFn: () => callApi<{ groups: { chat_id: number; chat_title: string; hits: number; last_used: string }[] }>(
      "analytics_groups", { days: range, limit: 10 },
    ),
  });

  const o = overviewQ.data?.overview ?? {};
  const daily = dailyQ.data?.daily ?? [];
  const maxDaily = Math.max(1, ...daily.map((d) => Number(d.hits) || 0));
  const topKw = topQ.data?.keywords ?? [];
  const maxKw = Math.max(1, ...topKw.map((k) => Number(k.hits) || 0));
  const groups = groupsQ.data?.groups ?? [];

  return (
    <div className="space-y-3 pt-2">
      <SectionTitle>ស្ថិតិទូទៅ</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <MiniStat icon={<Flame />} label="ថ្ងៃនេះ" value={o.hits_today ?? 0} />
        <MiniStat icon={<TrendingUp />} label="៧ថ្ងៃចុងក្រោយ" value={o.hits_7d ?? 0} />
        <MiniStat icon={<BarChart3 />} label="៣០ថ្ងៃ" value={o.hits_30d ?? 0} />
        <MiniStat icon={<Users />} label="Group សកម្ម" value={o.active_groups_7d ?? 0} />
      </div>

      <div className="flex items-center justify-between px-1 pt-2">
        <SectionTitle>ក្រាហ្វការប្រើប្រាស់</SectionTitle>
        <div className="flex gap-1 pr-2">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => { hapticImpact("light"); setRange(d as 7 | 14 | 30); }}
              className={`px-2 py-1 rounded-lg text-xs font-medium ${
                range === d ? "bg-[var(--tg-btn)] text-white" : "bg-[var(--tg-section)] text-[var(--tg-hint)]"
              }`}
            >
              {d}ថ្ងៃ
            </button>
          ))}
        </div>
      </div>

      <div className="tg-card p-3">
        {dailyQ.isLoading ? (
          <div className="h-32 grid place-items-center tg-hint text-sm">កំពុងផ្ទុក…</div>
        ) : daily.length === 0 ? (
          <div className="h-32 grid place-items-center tg-hint text-sm">មិនទាន់មានទិន្នន័យ</div>
        ) : (
          <div className="h-32 flex items-end gap-1">
            {daily.map((d) => {
              const h = Math.round((Number(d.hits) / maxDaily) * 100);
              return (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t-md bg-[var(--tg-btn)] transition-all"
                    style={{ height: `${Math.max(4, h)}%` }}
                    title={`${d.day}: ${d.hits}`}
                  />
                </div>
              );
            })}
          </div>
        )}
        <div className="flex justify-between mt-2 text-[10px] tg-hint px-1">
          <span>{daily[0]?.day?.slice(5) ?? ""}</span>
          <span>{daily[daily.length - 1]?.day?.slice(5) ?? ""}</span>
        </div>
      </div>

      <SectionTitle>ពាក្យបញ្ជាពេញនិយម 🔥</SectionTitle>
      <div className="tg-card p-2 divide-y divide-white/5">
        {topQ.isLoading ? (
          <div className="p-3 tg-hint text-sm text-center">កំពុងផ្ទុក…</div>
        ) : topKw.length === 0 ? (
          <div className="p-3 tg-hint text-sm text-center">មិនទាន់មានទិន្នន័យ</div>
        ) : (
          topKw.map((k, i) => (
            <div key={k.keyword} className="py-2 px-2">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="font-medium truncate">
                  <span className="tg-hint mr-2">#{i + 1}</span>{k.keyword}
                </span>
                <span className="text-[var(--tg-btn)] font-semibold ml-2">{k.hits}</span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--tg-section)] overflow-hidden">
                <div
                  className="h-full bg-[var(--tg-btn)] rounded-full"
                  style={{ width: `${(Number(k.hits) / maxKw) * 100}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>

      <SectionTitle>Group សកម្មបំផុត 👥</SectionTitle>
      <div className="tg-card p-2 divide-y divide-white/5">
        {groupsQ.isLoading ? (
          <div className="p-3 tg-hint text-sm text-center">កំពុងផ្ទុក…</div>
        ) : groups.length === 0 ? (
          <div className="p-3 tg-hint text-sm text-center">មិនទាន់មានទិន្នន័យ</div>
        ) : (
          groups.map((g, i) => (
            <div key={g.chat_id} className="py-2 px-2 flex items-center gap-2">
              <span className="tg-hint text-xs w-6">#{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{g.chat_title || `Group ${g.chat_id}`}</p>
                <p className="tg-hint text-[11px] truncate">ID: {g.chat_id}</p>
              </div>
              <span className="text-[var(--tg-btn)] font-semibold">{g.hits}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="tg-card p-3">
      <div className="flex items-center gap-2 tg-hint text-xs mb-1">
        <span className="[&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        {label}
      </div>
      <p className="text-2xl font-bold">{value}</p>
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
          <ArrowUpDown className="h-5 w-5" /> ប្តូរលេខរៀង /1 /2 /3…
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
              /{i + 1}
            </div>
            <button onClick={() => setEditing(r)} className="min-w-0 flex-1 text-left active:opacity-70">
              <p className="font-semibold truncate">{r.keyword}</p>
              <p className="tg-hint text-xs flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3" /> {fmtDelay(r.delete_after_seconds)} · {(() => {
                  const items = Array.isArray(r.content) ? r.content : [];
                  const blocks = groupContent(items);
                  const albums = blocks.filter((b) => b.kind === "album").length;
                  const singles = blocks.filter((b) => b.kind === "single").length;
                  if (albums > 0 && singles > 0) return `${albums} album · ${singles} សារ`;
                  if (albums > 0) return `${albums} album (${items.length} media)`;
                  return `${items.length} សារ`;
                })()}
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

const MAX_PER_ROW = 4;

const REORDER_COLORS = {
  bg: "#f4f6f8",
  surface: "#ffffff",
  elevated: "#eef2f6",
  text: "#0f172a",
  hint: "#64748b",
  button: "#2ea6ff",
  buttonText: "#ffffff",
};

const reorderThemeStyle = {
  "--tg-bg": REORDER_COLORS.bg,
  "--tg-section": REORDER_COLORS.surface,
  "--tg-section-2": REORDER_COLORS.elevated,
  "--tg-text": REORDER_COLORS.text,
  "--tg-hint": REORDER_COLORS.hint,
  "--tg-btn": REORDER_COLORS.button,
  "--tg-btn-text": REORDER_COLORS.buttonText,
  backgroundColor: REORDER_COLORS.bg,
  color: REORDER_COLORS.text,
} as React.CSSProperties;

const reorderSurfaceStyle = {
  backgroundColor: REORDER_COLORS.surface,
  color: REORDER_COLORS.text,
} as React.CSSProperties;

const reorderElevatedStyle = {
  backgroundColor: REORDER_COLORS.elevated,
  color: REORDER_COLORS.text,
} as React.CSSProperties;

const reorderHintStyle = {
  color: REORDER_COLORS.hint,
} as React.CSSProperties;

const reorderAccentStyle = {
  color: REORDER_COLORS.button,
} as React.CSSProperties;

function ReorderPanel({ replies, onClose }: { replies: Reply[]; onClose: () => void }) {
  const qc = useQueryClient();

  // Sort by current row_index + position (preserving whatever order the DB has now),
  // then flatten into a single linear list — slash commands are strictly /1, /2, /3…
  const buildOrder = (rs: Reply[]): string[] =>
    [...rs]
      .sort((a, b) => {
        const ra = a.row_index ?? 0, rb = b.row_index ?? 0;
        if (ra !== rb) return ra - rb;
        return (a.position ?? 0) - (b.position ?? 0);
      })
      .map((r) => r.keyword);

  const [order, setOrder] = useState<string[]>(() => buildOrder(replies));

  const [justSynced, setJustSynced] = useState(false);
  const syncedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useMutation({
    mutationFn: (keywords: string[]) => callApi("reorder_replies", { keywords }),
    onSuccess: () => {
      hapticNotify("success");
      qc.invalidateQueries({ queryKey: ["replies"] });
      setJustSynced(true);
      if (syncedTimer.current) clearTimeout(syncedTimer.current);
      syncedTimer.current = setTimeout(() => setJustSynced(false), 2200);
      toast.success("✅ បានផ្លាស់ប្តូរលេខរៀង /1 /2 /3…");
    },
    onError: (e: Error) => { hapticNotify("error"); toast.error("❌ Sync បរាជ័យ: " + e.message); },
  });

  const commit = (next: string[]) => {
    setOrder(next);
    save.mutate(next);
  };

  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = order.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    hapticImpact("light");
    commit(next);
  };

  const moveUp = (i: number) => move(i, i - 1);
  const moveDown = (i: number) => move(i, i + 1);
  const moveTop = (i: number) => move(i, 0);
  const moveBottom = (i: number) => move(i, order.length - 1);

  const content = (
    <div
      className="tg-app fixed inset-0 z-[9999] flex flex-col w-screen h-screen"
      style={{
        ...reorderThemeStyle,
        height: "100dvh",
        minHeight: "100vh",
        WebkitTransform: "translateZ(0)",
      }}
    >
      <div className="flex-1 overflow-y-auto px-3 pt-2 pb-6 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="flex items-center gap-1 tg-hint text-sm px-2 py-2 active:opacity-70"
            style={reorderHintStyle}
          >
            <ChevronLeft className="h-4 w-4" /> រួចរាល់
          </button>
          <div className="flex-1" />
          <div
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full transition-all ${
              save.isPending
                ? "bg-[var(--tg-btn)]/15 text-[var(--tg-btn)]"
                : justSynced
                ? "bg-green-500/15 text-green-500"
                : "tg-hint opacity-70"
            }`}
            style={!save.isPending && !justSynced ? reorderHintStyle : undefined}
          >
            {save.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>កំពុង Sync…</span>
              </>
            ) : justSynced ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>បាន Sync ✓</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span>Auto-sync</span>
              </>
            )}
          </div>
        </div>

        {/* Instruction card */}
        <div className="tg-card p-3 flex items-center gap-2" style={reorderSurfaceStyle}>
          <div className="h-9 w-9 rounded-lg bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center" style={reorderAccentStyle}>
            <ArrowUpDown className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">ប្តូរលេខរៀង /1 /2 /3…</p>
            <p className="tg-hint text-xs" style={reorderHintStyle}>ចុច ⬆️ ⬇️ ដើម្បីផ្លាស់ទី · ⏫ ⏬ ដើម្បីទៅដើម/ចុង</p>
          </div>
        </div>

        {/* Linear list with explicit buttons */}
        <div className="space-y-2">
          {order.map((kw, i) => {
            const isFirst = i === 0;
            const isLast = i === order.length - 1;
            return (
              <div
                key={kw}
                className="tg-card p-3 flex items-center gap-2"
                style={reorderSurfaceStyle}
              >
                {/* Command number badge */}
                <div
                  className="h-12 w-14 shrink-0 rounded-xl bg-[var(--tg-btn)]/15 text-[var(--tg-btn)] grid place-items-center font-bold"
                  style={reorderAccentStyle}
                >
                  /{i + 1}
                </div>

                {/* Keyword name */}
                <p className="text-sm font-semibold truncate flex-1 min-w-0">{kw}</p>

                {/* Action buttons — clear, tappable */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => moveTop(i)}
                    disabled={isFirst || save.isPending}
                    className="h-10 w-10 rounded-xl bg-[var(--tg-section-2)] grid place-items-center active:scale-95 disabled:opacity-30"
                    style={reorderElevatedStyle}
                    aria-label="Move to top"
                  >
                    <ChevronsUp className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => moveUp(i)}
                    disabled={isFirst || save.isPending}
                    className="h-10 w-10 rounded-xl bg-[var(--tg-section-2)] grid place-items-center active:scale-95 disabled:opacity-30"
                    style={reorderElevatedStyle}
                    aria-label="Move up"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => moveDown(i)}
                    disabled={isLast || save.isPending}
                    className="h-10 w-10 rounded-xl bg-[var(--tg-section-2)] grid place-items-center active:scale-95 disabled:opacity-30"
                    style={reorderElevatedStyle}
                    aria-label="Move down"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => moveBottom(i)}
                    disabled={isLast || save.isPending}
                    className="h-10 w-10 rounded-xl bg-[var(--tg-section-2)] grid place-items-center active:scale-95 disabled:opacity-30"
                    style={reorderElevatedStyle}
                    aria-label="Move to bottom"
                  >
                    <ChevronsDown className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}








function DeleteBtn({ keyword }: { keyword: string }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => callApi("delete_reply", { keyword }),
    onSuccess: () => { hapticNotify("success"); toast.success("✅ លុបរួច — Telegram keyboard បាន Sync"); qc.invalidateQueries({ queryKey: ["replies"] }); qc.invalidateQueries({ queryKey: ["stats"] }); },
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
    onSuccess: () => { hapticNotify("success"); toast.success("✅ រក្សាទុករួច — Telegram keyboard បាន Sync"); onSaved(); },
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

      {initial && Array.isArray(initial.content) && initial.content.length > 0 && (
        <MediaPreview items={initial.content} />
      )}

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
  --tg-bg: #f4f6f8;
  --tg-section: #ffffff;
  --tg-section-2: #eef2f6;
  --tg-text: #0f172a;
  --tg-hint: #64748b;
  --tg-btn: #2ea6ff;
  --tg-btn-text: #ffffff;
  background: var(--tg-bg);
  color: var(--tg-text);
  font-family: "Kantumruy Pro", -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif;
}
.tg-card {
  background: var(--tg-section);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06);
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.tg-card:active { transform: scale(.985); }
.tg-hint { color: var(--tg-hint); }
.tg-input {
  background: var(--tg-section-2) !important;
  border: 1px solid rgba(15,23,42,0.08) !important;
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
/* Default visible; animation is a progressive enhancement only.
   Old Telegram WebViews may skip the keyframes — never leave content at opacity:0. */
.tg-stagger > * { animation: tgSlideUp .38s cubic-bezier(.2,.7,.2,1) both; }
.tg-stagger > *:nth-child(1) { animation-delay: .02s; }
.tg-stagger > *:nth-child(2) { animation-delay: .05s; }
.tg-stagger > *:nth-child(3) { animation-delay: .08s; }
.tg-stagger > *:nth-child(4) { animation-delay: .11s; }
.tg-stagger > *:nth-child(5) { animation-delay: .14s; }
.tg-stagger > *:nth-child(6) { animation-delay: .17s; }
.tg-stagger > *:nth-child(7) { animation-delay: .20s; }
.tg-stagger > *:nth-child(8) { animation-delay: .23s; }
.tg-stagger > *:nth-child(n+9) { animation-delay: .26s; }
@supports not (animation-fill-mode: both) {
  .tg-stagger > *, .tg-anim-page, .tg-anim-header, .tg-anim-nav { animation: none !important; opacity: 1 !important; }
}

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

