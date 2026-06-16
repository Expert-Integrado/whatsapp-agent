import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID     = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

Deno.serve(async (_req) => {
  const { data: accounts } = await supabase.from("oauth_tokens").select("*").eq("provider", "google");
  const results: any[] = [];
  for (const account of (accounts ?? [])) {
    try {
      const token = await refreshIfNeeded(account);
      const count = await syncContacts(token, account.account_email);
      results.push({ account: account.account_email, synced: count });
    } catch (e) {
      results.push({ account: account.account_email, error: String(e) });
    }
  }
  return new Response(JSON.stringify({ ok: true, results }), { headers: { "Content-Type": "application/json" } });
});

async function refreshIfNeeded(account: any): Promise<string> {
  const now = Date.now();
  const exp = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (exp - now < 5 * 60 * 1000) {
    if (!account.refresh_token) throw new Error("sem refresh_token");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: account.refresh_token, grant_type: "refresh_token" }),
    });
    if (!r.ok) throw new Error(`refresh failed: ${await r.text()}`);
    const d = await r.json();
    await supabase.from("oauth_tokens").update({ access_token: d.access_token, expires_at: new Date(now + d.expires_in * 1000).toISOString() }).eq("id", account.id);
    return d.access_token;
  }
  return account.access_token;
}

async function syncContacts(token: string, email: string): Promise<number> {
  let total = 0, nextPage: string | undefined;
  do {
    const url = new URL("https://people.googleapis.com/v1/people/me/connections");
    url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,organizations,photos");
    url.searchParams.set("pageSize", "1000");
    if (nextPage) url.searchParams.set("pageToken", nextPage);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`People API ${r.status}`);
    const d = await r.json();
    for (const p of (d.connections ?? [])) { await upsertContact(p, email); total++; }
    nextPage = d.nextPageToken;
  } while (nextPage);
  return total;
}

async function upsertContact(p: any, email: string) {
  const names = p.names ?? [], phones = p.phoneNumbers ?? [], photos = p.photos ?? [];
  const rawPhones = phones.map((ph: any) => ({ phone: ph.value.replace(/\D/g, ""), type: ph.type ?? null })).filter((ph: any) => ph.phone.length >= 8);
  await supabase.from("contacts").upsert({
    source: "google", source_account: email,
    google_resource_name: p.resourceName,
    display_name: names[0]?.displayName ?? null,
    given_name: names[0]?.givenName ?? null,
    family_name: names[0]?.familyName ?? null,
    primary_phone: rawPhones[0]?.phone ?? null,
    phones: rawPhones,
    emails: (p.emailAddresses ?? []).map((e: any) => ({ email: e.value })),
    organizations: (p.organizations ?? []).map((o: any) => ({ name: o.name, title: o.title ?? null })),
    photo_url: photos.find((ph: any) => !ph.default)?.url ?? null,
    last_synced_at: new Date().toISOString(),
  }, { onConflict: "source_account,google_resource_name" });
}
