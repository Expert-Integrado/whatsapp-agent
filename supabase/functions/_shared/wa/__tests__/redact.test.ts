import { assert, assertEquals } from "jsr:@std/assert@1";
import { redactSecrets, safeFetch } from "../redact.ts";

// Formato REAL capturado com deno eval em 19/07/2026 (fetch de host inexistente):
// o Deno embute a URL completa entre parenteses na mensagem do TypeError.
const REAL_DNS_ERROR =
  "TypeError: error sending request for url (https://api.z-api.io/instances/3C5D0F2E8A/token/A1b2C3d4E5f6G7h8/send-text?phone=5511): client error (Connect): dns error: Este host nao e conhecido. (os error 11001)";

Deno.test("redact: token no path Z-API redigido, resto preservado", () => {
  const out = redactSecrets(REAL_DNS_ERROR);
  assert(!out.includes("A1b2C3d4E5f6G7h8"), `token vazou: ${out}`);
  assert(out.includes("/instances/3C5D0F2E8A/token/REDACTED/send-text"), out);
  assert(out.includes("dns error"), "resto da mensagem deve sobreviver");
});

Deno.test("redact: token como ULTIMO segmento (fecha em ')' ou '?')", () => {
  const paren = "error for url (https://api.z-api.io/instances/I/token/SECRETX): timeout";
  assertEquals(
    redactSecrets(paren),
    "error for url (https://api.z-api.io/instances/I/token/REDACTED): timeout",
  );
  const query = "url https://host/token/SECRETY?phone=55 falhou";
  assertEquals(redactSecrets(query), "url https://host/token/REDACTED?phone=55 falhou");
});

Deno.test("redact: query params de signed URL (Backblaze/Supabase)", () => {
  const b2 =
    "error sending request for url (https://f004.backblazeb2.com/file/bucket/a.ogg?Authorization=4_00abc123def): connect error";
  const out = redactSecrets(b2);
  assert(!out.includes("4_00abc123def"), out);
  assert(out.includes("?Authorization=REDACTED"), out);

  const sb =
    "https://xyz.supabase.co/storage/v1/object/sign/media/a.ogg?token=eyJhbGciOiJIUzI1NiJ9.abc";
  const out2 = redactSecrets(sb);
  assert(!out2.includes("eyJhbGciOiJIUzI1NiJ9"), out2);
  assert(out2.includes("?token=REDACTED"), out2);
});

Deno.test("redact: multiplos secrets na mesma string", () => {
  const s = "a https://h/instances/I/token/TK1/x e https://m/f.ogg?apikey=KK2&other=1 e /token/TK3/y";
  const out = redactSecrets(s);
  assert(!out.includes("TK1") && !out.includes("KK2") && !out.includes("TK3"), out);
  assert(out.includes("other=1"), "param nao-sensivel preservado");
});

Deno.test("redact: texto limpo intocado", () => {
  for (
    const clean of [
      'zapi 400: {"error":"invalid phone"}',
      "token invalido para a instancia",
      "delayTyping=5 aplicado",
      "erro generico sem URL",
    ]
  ) assertEquals(redactSecrets(clean), clean);
});

Deno.test("redact: idempotente", () => {
  for (const s of [REAL_DNS_ERROR, "https://h/token/SEC/x", "u?token=abc", "limpo"]) {
    const once = redactSecrets(s);
    assertEquals(redactSecrets(once), once);
  }
});

Deno.test("redact: case-insensitive", () => {
  assert(!redactSecrets("https://h/Token/SEC123/x").includes("SEC123"));
  assert(!redactSecrets("https://h/a?TOKEN=SEC456").includes("SEC456"));
});

Deno.test("redact: userinfo em URL (base_url com user:pass)", () => {
  const s = "error for url (https://admin:s3cretpw@evo.example.com/message/send): refused";
  const out = redactSecrets(s);
  assert(!out.includes("s3cretpw"), out);
  assert(out.includes("https://REDACTED@evo.example.com"), out);
});

Deno.test("redact: nao-string vira string vazia", () => {
  assertEquals(redactSecrets(undefined as unknown as string), "");
});

Deno.test("safeFetch: erro de rede re-lancado sem o secret, name preservado", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new TypeError(
      "error sending request for url (https://api.z-api.io/instances/I/token/SECRETTOKEN/send-text): client error (Connect)",
    );
  };
  try {
    let caught: Error | null = null;
    try {
      await safeFetch("https://api.z-api.io/instances/I/token/SECRETTOKEN/send-text");
    } catch (e) {
      caught = e as Error;
    }
    assert(caught, "deveria lancar");
    assert(!String(caught).includes("SECRETTOKEN"), String(caught));
    assert(String(caught).includes("/token/REDACTED/"), String(caught));
    assertEquals(caught.name, "TypeError");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("safeFetch: happy path passa a Response intacta", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  try {
    const r = await safeFetch("https://api.z-api.io/instances/I/token/T/send-text");
    assertEquals(r.status, 200);
    assertEquals(await r.json(), { ok: true });
  } finally {
    globalThis.fetch = orig;
  }
});
