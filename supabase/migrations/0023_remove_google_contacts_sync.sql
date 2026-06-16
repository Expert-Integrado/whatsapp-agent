-- 0023_remove_google_contacts_sync.sql
-- Remove feature de sync com Google Contacts (nunca foi ativada).
--
-- Justificativa: feature criada em 0003 mas OAuth bootstrap nunca foi executado.
-- Tabelas contacts e oauth_tokens estao vazias ha 36+ dias. WhatsApp ja entrega
-- chat_name e sender_name via webhook, suficiente pro uso atual.
--
-- Se um dia precisar enriquecer contatos (empresa, cargo, anotacoes), reintroduzir
-- com escopo mais focado (provavelmente integrar com Pipedrive ao inves de Google).
--
-- Esta migration NAO remove a edge function sync-google-contacts em si — ela fica
-- orfa no projeto Supabase mas inativa (sem cron). Pode ser deletada manualmente
-- via dashboard ou supabase CLI quando conveniente.

BEGIN;

-- 1) Remover cron job
SELECT cron.unschedule('sync-google-contacts');

-- 2) Drop tabelas
DROP TABLE IF EXISTS public.contacts CASCADE;
DROP TABLE IF EXISTS public.oauth_tokens CASCADE;

COMMIT;
