// stockpile-read
// The only read path to `stockpile_mitra` (no anon access on the table). Body is either
// { password } from the dashboard gate or { token } from an earlier call. The password is
// checked here, not in the browser: sending the hash would make the hash in the public
// source a working credential. Tokens are stateless, HMAC-signed with the service key and
// the gate hash, so changing the password revokes them. Only a password issues a token:
// a token cannot renew itself, which keeps 12 hours an absolute limit.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Must equal GATE_HASH in index.html.
const GATE_HASH = "87f8b970c387e44a359ff70f89f1cb09d1b8e3ab47583be1b8fb167a68660b90";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(`stockpile-read:${GATE_HASH}:${SERVICE_KEY}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, utf8(payload)));
}
async function issueToken(): Promise<string> {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${await sign(exp)}`;
}
async function tokenValid(token: string): Promise<boolean> {
  const [exp, sig] = token.split(".");
  return !!sig && Number(exp) > Date.now() && sig === await sign(exp);
}
async function passwordValid(password: string): Promise<boolean> {
  return hex(await crypto.subtle.digest("SHA-256", utf8(password))) === GATE_HASH;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  try {
    const body = await req.json().catch(() => ({}));
    const byPassword = typeof body?.password === "string" && await passwordValid(body.password);
    const ok = byPassword || (typeof body?.token === "string" && await tokenValid(body.token));
    if (!ok) return reply(401, { ok: false });

    const res = await fetch(`${SUPABASE_URL}/rest/v1/stockpile_mitra?id=eq.1&select=data,issues,n_titik,last_ok_at`, {
      headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) return reply(500, { ok: false, error: `HTTP ${res.status}` });
    const row = (await res.json())?.[0] || {};
    return reply(200, {
      ok: true, token: byPassword ? await issueToken() : undefined, data: row.data || {}, issues: row.issues || [],
      n_titik: row.n_titik ?? 0, last_ok_at: row.last_ok_at ?? null,
    });
  } catch (e) {
    return reply(500, { ok: false, error: (e as Error)?.message || String(e) });
  }
});
