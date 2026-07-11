// dispatch-scheduled — worker que dispara as sequencias de mensagens agendadas
// (tabela scheduled_sequences, tool `schedule` da mcp-api). Cron: a cada 1 min
// (0047). Envia item a item NA ORDEM reusando as edges de envio existentes
// (send-message / send-voice / wa-proxy), que ja resolvem provider, instancia,
// rate limit e gate confirmed.
//
// Regras (decisao de produto, plano 10/07/2026):
// - Item falhou (HTTP >= 400 ou throw) -> aborta os itens restantes, status='failed'.
// - Gate de "inbound recente sem resposta" nao se aplica: ele vive so no case
//   `send` da mcp-api; aqui chamamos send-message direto (agendamento ja foi
//   confirmado pelo usuario na criacao).
// - Pausa entre itens: delay_after do item, senao humanizado. A pausa dorme AQUI
//   no worker (nao so delayTyping provider-side) pra garantir a ordem — delays
//   assincronos do provider em sends consecutivos podem reordenar.
//
// Budget de 50s de wall-clock por invocacao (cron e 60s -> nunca 2 workers
// simultaneos; edge tem limite de execucao). Estourou no meio de uma sequencia:
// volta pra 'pending' preservando items_sent e o proximo cron RESUME de onde parou.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Copiado da mcp-api/index.ts (callEdge): JWT legado que passa no verify_jwt do gateway.
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_JWT = Deno.env.get("INTERNAL_EDGE_JWT") || SERVICE_KEY;
async function callEdge(name: string, body: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${INTERNAL_JWT}`, "apikey": INTERNAL_JWT, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any; const t = await r.text();
  try { data = JSON.parse(t); } catch { data = { raw: t }; }
  return { status: r.status, data };
}

// Copiado da mcp-api/index.ts (humanizedTypingSeconds).
function humanizedTypingSeconds(type: string, content: string): number {
  const len = (content || "").length;
  if (type === "text") return Math.min(15, Math.max(1, Math.ceil(len / 30)));
  if (type === "audio" || type === "ptt") return 3;
  if (type === "image" || type === "video") return 2;
  return 1; // document
}

const BUDGET_MS = 50_000;
const STALE_MIN = 15;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seq = {
  id: string; instance_id: string; chat_id: string;
  items: any[]; items_sent: number;
};

// Envia UM item da sequencia. Retorna erro (string) ou null em sucesso.
async function dispatchItem(seq: Seq, item: any, index: number): Promise<string | null> {
  const common = { confirmed: true, agent_name: "dispatch-scheduled", instance: seq.instance_id };
  let r: { status: number; data: any };
  if (item.type === "voice") {
    r = await callEdge("send-voice", {
      ...common, chat_id: seq.chat_id, text: item.content,
      // agent_request_id deterministico: idempotencia de 24h do send-voice cobre
      // duplicata se o worker crashar apos o envio e antes de persistir o cursor.
      agent_request_id: `${seq.id}:${index}`,
      ...(item.voice_id && { voice_id: item.voice_id }),
      ...(item.model_id && { model_id: item.model_id }),
      ...(item.stability !== undefined && { stability: item.stability }),
      ...(item.similarity_boost !== undefined && { similarity_boost: item.similarity_boost }),
      ...(item.style !== undefined && { style: item.style }),
      ...(item.speed !== undefined && { speed: item.speed }),
    });
  } else if (item.type === "poll") {
    // Shape canonico Z-API {phone, message, poll:[{name}], pollMaxOptions}:
    // passthrough no adapter Z-API e traduzido pelo adapter Evolution.
    r = await callEdge("wa-proxy", {
      ...common, action: "send-poll", agent_request_id: crypto.randomUUID(),
      params: {
        phone: String(seq.chat_id).replace(/@.*$/, ""),
        message: item.question,
        poll: (item.options ?? []).map((o: string) => ({ name: o })),
        ...(item.selectableCount !== undefined && { pollMaxOptions: item.selectableCount }),
      },
    });
  } else {
    r = await callEdge("send-message", {
      ...common, chat_id: seq.chat_id, content: item.content ?? "", message_type: item.type,
      delay_typing: humanizedTypingSeconds(item.type, item.content ?? ""),
      ...(item.media_url && { media_url: item.media_url }),
      ...(item.file_name && { file_name: item.file_name }),
      ...(item.link && { link: item.link }),
    });
  }
  if (r.status >= 400 || r.data?.error) {
    return r.data?.error ? String(r.data.error) : `HTTP ${r.status}`;
  }
  return null;
}

// Processa uma sequencia ja claimed. Retorna o status final ('sent'|'failed'|'pending').
async function processSequence(seq: Seq, deadline: number): Promise<string> {
  const items: any[] = Array.isArray(seq.items) ? seq.items : [];
  for (let i = seq.items_sent; i < items.length; i++) {
    if (Date.now() > deadline) {
      // Budget estourou: devolve pra fila preservando o cursor — proximo cron resume.
      await supabase.from("scheduled_sequences")
        .update({ status: "pending" }).eq("id", seq.id);
      return "pending";
    }
    const item = items[i];
    const errMsg = await dispatchItem(seq, item, i).catch((e) => String(e?.message ?? e));
    if (errMsg) {
      await supabase.from("scheduled_sequences")
        .update({ status: "failed", error: `item ${i} (${item?.type}): ${errMsg}`.slice(0, 500), finished_at: new Date().toISOString() })
        .eq("id", seq.id);
      return "failed";
    }
    await supabase.from("scheduled_sequences").update({ items_sent: i + 1 }).eq("id", seq.id);
    if (i + 1 < items.length) {
      // Pausa antes do proximo item: delay_after deste item, senao o tempo de
      // "digitacao" humanizado do PROXIMO + jitter. Soma o delayTyping que o
      // provider aplica async ao item recem-enviado, pra proxima msg nao passar
      // na frente.
      const providerDelay = item.type === "voice" || item.type === "poll"
        ? 0 : humanizedTypingSeconds(item.type, item.content ?? "");
      const next = items[i + 1];
      const gap = item.delay_after !== undefined
        ? Number(item.delay_after)
        : humanizedTypingSeconds(next?.type ?? "text", next?.content ?? "") + 1 + Math.random() * 2;
      await sleep((providerDelay + gap) * 1000);
    }
  }
  await supabase.from("scheduled_sequences")
    .update({ status: "sent", finished_at: new Date().toISOString() }).eq("id", seq.id);
  return "sent";
}

Deno.serve(async (_req) => {
  const deadline = Date.now() + BUDGET_MS;
  try {
    // Recovery: worker que crashou deixa 'processing' orfao — devolve pra fila.
    // ponytail: o item que estava em voo pode duplicar no resume (raro; voz e
    // idempotente via agent_request_id, texto aceita o risco).
    await supabase.from("scheduled_sequences")
      .update({ status: "pending" })
      .eq("status", "processing")
      .lt("started_at", new Date(Date.now() - STALE_MIN * 60_000).toISOString());

    const results: Record<string, string> = {};
    while (Date.now() < deadline) {
      const { data: due, error: selErr } = await supabase.from("scheduled_sequences")
        .select("id")
        .eq("status", "pending")
        .lte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(1);
      if (selErr) throw selErr;
      if (!due?.length) break;

      // Claim otimista: o row-lock do UPDATE serializa; 0 linhas = outro worker levou.
      const { data: claimed, error: clErr } = await supabase.from("scheduled_sequences")
        .update({ status: "processing", started_at: new Date().toISOString() })
        .eq("id", due[0].id).eq("status", "pending")
        .select("id, instance_id, chat_id, items, items_sent");
      if (clErr) throw clErr;
      if (!claimed?.length) continue;

      const seq = claimed[0] as Seq;
      results[seq.id] = await processSequence(seq, deadline);
    }
    return json({ ok: true, processed: Object.keys(results).length, results });
  } catch (e) {
    console.error("dispatch-scheduled error:", e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
