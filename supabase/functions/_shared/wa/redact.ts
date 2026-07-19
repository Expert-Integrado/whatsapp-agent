// Redacao de secrets em mensagens de erro (mesma classe do incidente do
// Instagram Agent, fix dcdf6d9 la). O TypeError de falha de rede do Deno embute
// a URL COMPLETA na mensagem: "error sending request for url (https://...)".
// A Z-API exige o auth_token no PATH da URL (/instances/{id}/token/{token}/...),
// entao um String(e) cru desse erro grava o token em plaintext em coluna de log
// e devolve na resposta HTTP. Redigir na fonte (safeFetch) + em toda fronteira
// que grava/retorna erro fecha a classe.
//
// Modulo sem dependencias de proposito: importavel por qualquer edge sem puxar
// o registro de providers.

// Secret no PATH (Z-API). Host-agnostico: base_url alternativa/proxy compativel
// vazaria com regex ancorada em api.z-api.io; falso positivo custa um segmento
// de path numa mensagem de erro. /instances/{id} fica visivel (debug; o id
// sozinho nao autentica). Exclui ")" e "?" porque o Deno fecha a URL com "):".
const TOKEN_PATH_RE = /(\/token\/)[^/\s"'()?#&]+/gi;
// Secret em QUERY: signed URLs de midia (Backblaze usa Authorization=, Supabase
// Storage usa token=) + params classicos de OAuth/API. Nao cobre secret ecoado
// em corpo JSON ("token":"...") — a Z-API nao ecoa credencial em corpo de erro.
const SECRET_QUERY_RE =
  /([?&](?:access_token|client_secret|client[-_]token|fb_exchange_token|token|apikey|api[-_]key|authorization|code|signature|sig)=)[^&\s"'()]+/gi;
// Userinfo em URL (base_url configuravel do Evolution): https://user:pass@host
const USERINFO_RE = /(https?:\/\/)[^/\s@]*:[^/\s@]*@/gi;

export function redactSecrets(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .replace(TOKEN_PATH_RE, "$1REDACTED")
    .replace(SECRET_QUERY_RE, "$1REDACTED")
    .replace(USERINFO_RE, "$1REDACTED@");
}

// Wrapper de fetch pra URL que carrega secret: re-lanca o erro de rede com a
// mensagem redigida. Chama fetch(...) NO CORPO (resolucao dinamica de
// globalThis.fetch) — os testes existentes stubam o global e uma referencia
// capturada em module-level os quebraria.
export async function safeFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    const err = new Error(redactSecrets(String((e as Error)?.message ?? e)));
    // preserva TypeError/TimeoutError: o String(e) do boundary distingue rede vs timeout
    err.name = (e as Error)?.name ?? "Error";
    throw err;
  }
}
