import { createHmac, timingSafeEqual } from "crypto";

export type TgUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export function verifyInitData(initData: string, botToken: string): { ok: boolean; user?: TgUser; reason?: string } {
  if (!initData) return { ok: false, reason: "missing initData" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => [k, v] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad hash" };

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return { ok: false, reason: "stale" };

  try {
    const user = JSON.parse(params.get("user") ?? "{}") as TgUser;
    if (!user.id) return { ok: false, reason: "no user" };
    return { ok: true, user };
  } catch {
    return { ok: false, reason: "bad user json" };
  }
}
