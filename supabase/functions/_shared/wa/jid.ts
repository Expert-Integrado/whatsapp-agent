// supabase/functions/_shared/wa/jid.ts

/** Extrai só os dígitos antes do "@" de um JID; aceita JID ou número puro. */
export function digitsFromJid(jid: string): string {
  const left = (jid ?? "").split("@")[0];
  return left.replace(/\D/g, "");
}

export function isGroupJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

export function isLidJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.endsWith("@lid");
}
