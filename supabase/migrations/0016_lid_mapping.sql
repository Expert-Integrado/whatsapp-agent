-- Mapping de LID (Linked Identifier do WhatsApp Multi-Device) pro phone real.
--
-- Z-API entrega webhook com phone="<lid>@lid" quando fromMe=true em mensagem
-- enviada de dispositivo linked (WhatsApp Web/Business no celular). Sem essa
-- tabela, process-webhook usava o LID direto como chat_id e criava chat duplicado
-- pra cada contato. Ver issue #1 no repositorio original.
--
-- Populada por:
--   - process-webhook (resolved_via='cache','chat_name','zapi') quando recebe
--     payload @lid e resolve em tempo real
--   - scripts/merge_lid_pairs.py (resolved_via='manual') ao mesclar pares
--     historicos identificados via Z-API contacts API
--
-- MCP whatsapp-agent.read agrega mensagens via lid_mapping para cobrir LIDs
-- orfaos que escaparem do merge.

CREATE TABLE IF NOT EXISTS lid_mapping (
  lid          TEXT PRIMARY KEY,
  phone        TEXT NOT NULL,
  chat_name    TEXT,
  resolved_via TEXT NOT NULL CHECK (resolved_via IN ('cache','chat_name','zapi','manual')),
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lid_mapping_phone     ON lid_mapping(phone);
CREATE INDEX IF NOT EXISTS idx_lid_mapping_chat_name ON lid_mapping(chat_name);

COMMENT ON TABLE lid_mapping IS
  'Mapeamento LID @lid -> phone numerico do WhatsApp Multi-Device. Ver issue #1.';
