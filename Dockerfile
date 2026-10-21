FROM node:20-slim

# ffmpeg do sistema + yt-dlp standalone (sem Python)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
# ffmpeg-static nao e necessario aqui (ja temos o ffmpeg do sistema)
RUN npm install --omit=dev --ignore-scripts
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=3000 \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000
HEALTHCHECK CMD curl -fs http://localhost:3000/healthz || exit 1
USER node
CMD ["node", "server.js"]
