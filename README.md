# Facilitador

Baixa vídeos/áudios de links (YouTube, TikTok, Instagram...) e converte arquivos (MP4, MP3, M4A, WAV, OGG, WEBM, GIF). Usa yt-dlp + ffmpeg.

## Rodar localmente

```bash
npm install
npm run setup   # baixa o yt-dlp para ./bin
npm start       # http://localhost:3000
```

`npm run update` atualiza o yt-dlp (faça isso se algum site parar de funcionar).

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` em hospedagem (o Dockerfile já define) |
| `APP_PASSWORD` | vazio | Se definida, exige senha (HTTP Basic, usuário livre). **Defina ao publicar.** |
| `MAX_UPLOAD_MB` | `500` | Tamanho máximo para converter |

## Hospedagem

Precisa de um servidor que rode processos longos, então **não funciona na Vercel** (serverless). Use Docker em Railway, Render ou Fly.io:

1. Suba este repositório no GitHub.
2. Crie um serviço a partir do repositório (ele detecta o `Dockerfile`).
3. Defina `APP_PASSWORD` nas variáveis de ambiente.

Observações:
- Sites como o YouTube podem bloquear IPs de datacenter; se o download falhar na hospedagem mas funcionar local, é isso.
- O disco é temporário: os arquivos somem após 30 min e a cada deploy.
- Use apenas com conteúdo seu ou que você tem permissão para baixar.
