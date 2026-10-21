# Facilitador

Baixa vídeos/áudios de links (YouTube, TikTok, Instagram...) e converte arquivos (MP4, MP3, M4A, WAV, OGG, WEBM, GIF). Usa yt-dlp + ffmpeg.

## Rodar localmente

```bash
npm install
npm run setup   # baixa o yt-dlp (./bin), o ffmpeg e copia o ffmpeg.wasm
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

### Vercel

O projeto roda na Vercel em modo serverless:

- **Baixar de links:** funções em `api/` rodam o yt-dlp + ffmpeg (baixados no build por `setup.js`) e devolvem o arquivo num fluxo só, com progresso.
- **Converter arquivos:** acontece **no navegador** (ffmpeg.wasm, copiado para `public/vendor` no build), porque a Vercel limita o corpo das requisições a ~4,5 MB. Limite prático: 200 MB; vídeo é lento.

Passos: importe o repositório na Vercel (o `vercel.json` já define build, pasta e funções) e defina `APP_PASSWORD`.

Limites:
- `maxDuration: 300` (5 min) exige *Fluid Compute* (padrão em projetos novos). Sem ele o plano Hobby só aceita 60 s: reduza o valor no `vercel.json`.
- Vídeos longos podem estourar o tempo; o disco da função (`/tmp`) tem ~500 MB.
- O YouTube costuma bloquear IPs de datacenter (erro "confirme que você não é um robô"). Se falhar na Vercel e funcionar local, é isso; os demais sites costumam funcionar.
- `APP_PASSWORD` protege só a API (o navegador pede a senha no primeiro uso); a página em si é estática.

### Docker (Railway, Render, Fly.io)

Servidor completo (upload e conversão no servidor, sem limite de tempo):

1. Suba este repositório no GitHub.
2. Crie um serviço a partir do repositório (ele detecta o `Dockerfile`).
3. Defina `APP_PASSWORD` nas variáveis de ambiente.

Observações:
- O disco é temporário: os arquivos somem após 30 min e a cada deploy.
- Use apenas com conteúdo seu ou que você tem permissão para baixar.
