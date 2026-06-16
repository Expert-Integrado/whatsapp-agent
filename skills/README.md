# Skills do WhatsApp Agent

Skills Claude Code especificas desse projeto. Ficam versionadas aqui pra sincronizar entre PCs.

## Como instalar num PC novo

Windows (PowerShell ou Git Bash):

```bash
# Com o repo ja clonado em C:\repos\whatsapp-agent
cp -r C:/repos/whatsapp-agent/skills/* "C:/Users/$USER/.claude/skills/"
```

Ou no PowerShell:

```powershell
Copy-Item -Recurse "C:\repos\whatsapp-agent\skills\*" "$env:USERPROFILE\.claude\skills\"
```

## Skills disponiveis

### transcrever-conversa

Baixa audios do bucket Supabase `whatsapp-audio`, transcreve via Whisper local (pt-BR) e devolve conversa cronologica pronta pra resumir.

**Dependencias:**
- Python 3.14+ em `C:\Users\<usuario>\AppData\Local\Python\bin\python.exe`
- `pip install openai-whisper` (pega ffmpeg do winget tambem)
- ffmpeg instalado via `winget install Gyan.FFmpeg`

**Uso:**
```
/transcrever-conversa "Jorge Pretel"
/transcrever-conversa Camila --dias 60
/transcrever-conversa 5511999999999 --openai  # fallback OpenAI API
```

## Sincronizacao entre PCs

Quando editar skill em um PC, fluxo:
1. Edita em `~/.claude/skills/<skill>/` (pra testar local)
2. Copia pra `C:\repos\whatsapp-agent\skills\<skill>/`
3. `git add` + commit + push
4. Outros PCs: `git pull` + copiar de volta pro `~/.claude/skills/`
