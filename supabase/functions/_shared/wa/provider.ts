import type {
  ProviderId, InstanceCreds, InboundEvent, OutboundMessage, SendResult,
  MediaRef, MediaPayload, BuiltRequest, NeutralGroup, WaAction,
} from "./types.ts";

export interface WaProvider {
  readonly id: ProviderId;

  // entrada
  matchesWebhook(raw: any): boolean;
  webhookInstanceKey(raw: any): string | null;
  verifyWebhookAuth(raw: any, headers: Headers, creds: InstanceCreds | null): boolean;
  normalizeInbound(raw: any, creds: InstanceCreds): Promise<InboundEvent[]>;
  fetchMedia(creds: InstanceCreds, ref: MediaRef): Promise<MediaPayload>;

  // saída
  buildSend(creds: InstanceCreds, msg: OutboundMessage): Promise<BuiltRequest>;
  parseSendResult(json: any): SendResult;

  // ações / consultas
  buildAction(creds: InstanceCreds, action: WaAction, params: any): BuiltRequest | null;
  parseConnection(json: any): { connected: boolean; phone?: string };
  fetchGroups(creds: InstanceCreds): Promise<NeutralGroup[]>;

  // OPCIONAL — enriquecimento de chatId que exige I/O (só Z-API: resolução @lid em 3 camadas).
  // process-webhook chama `provider.resolveChatIds?.(events, creds, { supabase }) ?? events`
  // DEPOIS de normalizeInbound (que permanece PURO). Evolution não implementa (usa remoteJidAlt).
  resolveChatIds?(events: InboundEvent[], creds: InstanceCreds, deps: { supabase: any }): Promise<InboundEvent[]>;
}

const registry = new Map<ProviderId, WaProvider>();

export function registerProvider(p: WaProvider): void {
  registry.set(p.id, p);
}

export function getProvider(id: ProviderId): WaProvider {
  const p = registry.get(id);
  if (!p) throw new Error(`provider não registrado: ${id}`);
  return p;
}
