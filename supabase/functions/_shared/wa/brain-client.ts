// Mini-cliente MCP (Streamable HTTP) pro Expert Brain — server-to-server com PAT.
// O Brain nao tem REST pra PAT: o unico caminho e JSON-RPC MCP em POST /mcp
// (handshake initialize -> header Mcp-Session-Id -> notificacao initialized ->
// tools/call). Edge e stateless: cada chamada faz o handshake completo (3 fetches).
// Falha aqui NUNCA derruba o fluxo principal — quem chama trata null.

const BRAIN_MCP_URL = Deno.env.get("EXPERT_BRAIN_URL") ?? "https://expert-brain.contato-d9a.workers.dev/mcp";

type Json = Record<string, unknown>;

async function rpc(pat: string, body: Json, sessionId?: string): Promise<{ json: Json | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${pat}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(BRAIN_MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("Mcp-Session-Id");
  const text = await res.text();
  if (!res.ok) throw new Error(`brain mcp ${res.status}: ${text.slice(0, 300)}`);
  if (!text.trim()) return { json: null, sessionId: sid };
  // Streamable HTTP pode responder JSON puro ou SSE (linhas "data: {...}").
  if (text.trimStart().startsWith("{")) return { json: JSON.parse(text), sessionId: sid };
  let last: Json | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^data:\s*(\{.*\})\s*$/);
    if (m) { try { last = JSON.parse(m[1]); } catch (_) { /* linha nao-JSON */ } }
  }
  return { json: last, sessionId: sid };
}

// Executa uma tool do Brain (handshake completo por chamada). Retorna o objeto
// do toolSuccess (JSON parseado do content[0].text) ou lanca em erro de protocolo.
export async function brainToolCall(pat: string, name: string, args: Json): Promise<Json> {
  const init = await rpc(pat, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "whatsapp-agent-server", version: "1.0" } },
  });
  const sid = init.sessionId ?? undefined;
  await rpc(pat, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const call = await rpc(pat, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid);
  const j = call.json as Json | null;
  if (!j) throw new Error("brain mcp: resposta vazia no tools/call");
  const err = (j as any).error;
  if (err) throw new Error(`brain mcp error: ${err.message ?? JSON.stringify(err)}`);
  const result = (j as any).result ?? {};
  if (result.isError) throw new Error(`brain tool error: ${JSON.stringify(result.content?.[0]?.text ?? result).slice(0, 300)}`);
  const textItem = (result.content ?? []).find((c: any) => c?.type === "text")?.text;
  if (typeof textItem === "string") { try { return JSON.parse(textItem); } catch (_) { return { text: textItem }; } }
  return result as Json;
}

// Cria uma task no board do dono (feedback de calibracao do voice guide, 0058).
// dedupe_key impede spam: mesmo problema no mesmo dia = 1 card so. Best-effort:
// retorna o id ou null, nunca lanca — falha no Brain jamais afeta o envio.
export async function brainSaveTask(pat: string, input: {
  title: string; details: string; dedupeKey?: string; tags?: string[]; priority?: number;
}): Promise<string | null> {
  try {
    const r = await brainToolCall(pat, "save_task", {
      title: input.title,
      details: input.details,
      priority: input.priority ?? 2,
      project: "WhatsApp Agent",
      domains: ["operations"],
      tags: input.tags ?? [],
      ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
    });
    return (r as any).id ?? null;
  } catch (e) {
    console.error("[brain-client] save_task falhou:", (e as Error).message);
    return null;
  }
}
