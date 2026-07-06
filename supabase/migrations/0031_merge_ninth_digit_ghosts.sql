-- 0031_merge_ninth_digit_ghosts.sql
-- Merge de chats fantasmas do 9o digito (ClickUp 86ajby187).
--
-- Contas BR antigas sao registradas no WhatsApp SEM o 9o digito. Enviar pro
-- numero COM 9 quando a conta e sem-9 (via allow_new pre-v3.1.0, ou fontes
-- externas) criava um chat fantasma: a 1a msg chegava (remap do WhatsApp),
-- as seguintes morriam no orfao e a Z-API respondia 200.
--
-- Assinatura do par (mesma instancia, ambos 1-1 numericos):
--   real:     tem identidade — chat_name diferente do proprio numero,
--             e/ou mensagens recebidas (inbound)
--   fantasma: chat_name = proprio numero (ou nulo) e zero inbound
--
-- A funcao move mensagens/categorias/reacoes pro chat real, funde metadados,
-- redireciona lid_mapping e apaga o fantasma. Pares ambiguos (ambos com
-- identidade, ou nenhum) sao reportados como skipped — nao toca neles.
--
-- Reexecutavel a qualquer momento: exposta no MCP como tool merge_ghost_chats
-- (dry_run default true).

BEGIN;

CREATE OR REPLACE FUNCTION public.merge_ninth_digit_ghosts(p_dry_run boolean DEFAULT true)
RETURNS TABLE (
  instance_id       text,
  ghost_chat_id     text,
  canonical_chat_id text,
  moved_messages    integer,
  result            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pair    RECORD;
  v_moved integer;
BEGIN
  FOR pair IN
    WITH numeric_chats AS (
      SELECT c.instance_id AS inst, c.chat_id, c.chat_name, c.profile_thumbnail,
             c.last_message_at, c.last_received_at, c.last_sent_at,
             ((c.chat_name IS NOT NULL AND c.chat_name <> c.chat_id)
              OR EXISTS (SELECT 1 FROM public.messages m
                         WHERE m.instance_id = c.instance_id
                           AND m.chat_id = c.chat_id
                           AND m.from_me = false)) AS has_identity
      FROM public.chats c
      WHERE c.is_group = false
        AND c.chat_id ~ '^55[0-9]{10,11}$'
    )
    -- c13 = variante COM 9 (13 digitos), c12 = variante SEM 9 (12 digitos)
    SELECT c13.inst,
           c13.chat_id  AS with9,  c13.has_identity AS with9_identity,
           c12.chat_id  AS without9, c12.has_identity AS without9_identity
    FROM numeric_chats c13
    JOIN numeric_chats c12
      ON c12.inst = c13.inst
     AND length(c13.chat_id) = 13
     AND substr(c13.chat_id, 5, 1) = '9'
     AND c12.chat_id = substr(c13.chat_id, 1, 4) || substr(c13.chat_id, 6)
  LOOP
    instance_id := pair.inst;

    IF pair.with9_identity = pair.without9_identity THEN
      -- ambos com identidade (dois chats legitimos?) ou nenhum: nao decide sozinho
      ghost_chat_id     := NULL;
      canonical_chat_id := NULL;
      moved_messages    := 0;
      result            := format('skipped_ambiguous (%s <-> %s)', pair.with9, pair.without9);
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF pair.with9_identity THEN
      canonical_chat_id := pair.with9;
      ghost_chat_id     := pair.without9;
    ELSE
      canonical_chat_id := pair.without9;
      ghost_chat_id     := pair.with9;
    END IF;

    SELECT count(*)::integer INTO v_moved
    FROM public.messages m
    WHERE m.instance_id = pair.inst AND m.chat_id = ghost_chat_id;
    moved_messages := v_moved;

    IF p_dry_run THEN
      result := 'dry_run';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- mensagens (FK composta -> mover ANTES de apagar o fantasma)
    UPDATE public.messages m
       SET chat_id = canonical_chat_id
     WHERE m.instance_id = pair.inst AND m.chat_id = ghost_chat_id;

    -- categorias: move as que o canonico ainda nao tem; descarta duplicadas
    UPDATE public.chat_categories cc
       SET chat_id = canonical_chat_id
     WHERE cc.instance_id = pair.inst AND cc.chat_id = ghost_chat_id
       AND NOT EXISTS (SELECT 1 FROM public.chat_categories cc2
                       WHERE cc2.instance_id = pair.inst
                         AND cc2.chat_id = canonical_chat_id
                         AND cc2.category_id = cc.category_id);
    DELETE FROM public.chat_categories cc
     WHERE cc.instance_id = pair.inst AND cc.chat_id = ghost_chat_id;

    -- reacoes (sem FK, higiene)
    UPDATE public.message_reactions mr
       SET chat_id = canonical_chat_id
     WHERE mr.instance_id = pair.inst AND mr.chat_id = ghost_chat_id;

    -- lid_mapping: LIDs que apontavam pro fantasma passam a resolver pro real
    UPDATE public.lid_mapping lm
       SET phone = canonical_chat_id
     WHERE lm.instance_id = pair.inst AND lm.phone = ghost_chat_id;

    -- funde metadados no canonico
    UPDATE public.chats c
       SET last_message_at   = GREATEST(c.last_message_at,  g.last_message_at),
           last_received_at  = GREATEST(c.last_received_at, g.last_received_at),
           last_sent_at      = GREATEST(c.last_sent_at,     g.last_sent_at),
           profile_thumbnail = COALESCE(c.profile_thumbnail, g.profile_thumbnail)
      FROM public.chats g
     WHERE c.instance_id = pair.inst AND c.chat_id = canonical_chat_id
       AND g.instance_id = pair.inst AND g.chat_id = ghost_chat_id;

    DELETE FROM public.chats c
     WHERE c.instance_id = pair.inst AND c.chat_id = ghost_chat_id;

    result := 'merged';
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.merge_ninth_digit_ghosts(boolean) IS
  'Funde pares real+fantasma de chats 1-1 duplicados pelo 9o digito BR. dry_run=true so lista. Exposta no MCP como merge_ghost_chats.';

-- Trava: so service_role executa (mesmo modelo das demais operacoes do mcp-api)
REVOKE ALL ON FUNCTION public.merge_ninth_digit_ghosts(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_ninth_digit_ghosts(boolean) TO service_role;

COMMIT;
