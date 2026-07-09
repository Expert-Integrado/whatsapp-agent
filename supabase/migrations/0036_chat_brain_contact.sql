-- ════════════════════════════════════════════════════════════════
-- 0036 — chats.brain_contact_id: vínculo nativo com o Expert Brain
--
-- Id da pessoa no vault de contatos do Expert Brain (expert-contacts).
-- Quando o dono da instância usa o Expert Brain, cada chat privado pode
-- apontar pro contato correspondente no vault — aí agentes cruzam a
-- conversa do WhatsApp com a timeline/perfil do contato sem re-resolver
-- telefone a cada uso. Quem não usa o Brain simplesmente ignora (NULL).
--
-- Escrito via annotate (valor escalar, set direto) ou por sweep de
-- vinculação; devolvido pelo read junto de observations/voice_profile.
--
-- Aditiva e clean-apply. Sem FK: o id referencia sistema externo.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS brain_contact_id TEXT;

COMMENT ON COLUMN public.chats.brain_contact_id IS
  'Id do contato no vault Expert Brain (expert-contacts). NULL = sem vínculo '
  '(dono não usa o Brain ou pessoa ainda não vinculada). Set via annotate; retorna no read.';

NOTIFY pgrst, 'reload schema';
