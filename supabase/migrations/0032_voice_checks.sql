-- 0032_voice_checks.sql
-- Calibracao PESSOAL do voice check migra pro banco (coluna checks na voice_guide).
-- O motor (score + soft signals estruturais) vive na edge mcp-api e e generico;
-- o que e do dono — regras hard extras (regex), assinaturas fortes, thresholds e
-- mensagens calibradas com estatisticas do corpus pessoal — vem daqui. Assim o
-- repo publico nao carrega fingerprint comportamental de ninguem.
--
-- Formato do JSONB:
-- {
--   "hard_rules": [ { "id": "...", "pattern": "<regex source>", "flags": "iu",
--                     "severity": "high|medium|low", "message": "..." } ],
--   "soft": {
--     "signatures":      ["frase 1", "frase 2"],   -- assinaturas fortes (max 1 por msg)
--     "max_prose_chars":  250,   -- prosa (sem URLs) acima disso = msg-longa
--     "multiline_lines":    3,   -- bolha com N+ linhas E multiline_chars+ = bolha-multilinha
--     "multiline_chars":  200,
--     "ellipsis_min_runs":  3,   -- N+ runs de reticencias todas iguais = uniformidade
--     "arrows_min":         2,   -- N+ setas X > Y = cadeia-setas
--     "lowercase_min_units": 3,  -- N+ linhas/msgs todas iniciando minusculas = caixa-uniforme
--     "burst_max":          4,   -- burst com mais que N msgs = inflado
--     "messages": { "<signal_id>": "mensagem custom com stats do corpus do dono" }
--   }
-- }

ALTER TABLE public.voice_guide ADD COLUMN IF NOT EXISTS checks JSONB;

COMMENT ON COLUMN public.voice_guide.checks IS
  'Calibracao pessoal do voice check: regras hard extras (regex), assinaturas, thresholds e mensagens dos soft signals. NULL = so regras universais da edge com defaults neutros.';
