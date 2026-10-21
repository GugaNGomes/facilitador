// Localiza os binarios yt-dlp e ffmpeg (local, Docker ou Vercel)
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const win = process.platform === 'win32';

let YTDLP = process.env.YTDLP_PATH || path.join(ROOT, 'bin', win ? 'yt-dlp.exe' : 'yt-dlp');
let FFMPEG = process.env.FFMPEG_PATH;
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static'); } catch { FFMPEG = 'ffmpeg'; } }

// No Vercel o bundle e somente leitura e perde o bit de execucao: copia para /tmp.
function executable(p) {
  if (!process.env.VERCEL || !path.isAbsolute(p) || !fs.existsSync(p)) return p;
  const dest = path.join(os.tmpdir(), 'bin-' + path.basename(p));
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(p, dest + '.tmp');
    fs.chmodSync(dest + '.tmp', 0o755);
    fs.renameSync(dest + '.tmp', dest);
  }
  return dest;
}

const ytdlpMissing = () => !fs.existsSync(YTDLP);
// 'ffmpeg' puro (sem caminho) vem do PATH; caminho absoluto precisa existir
const ffmpegMissing = () => path.isAbsolute(FFMPEG) && !fs.existsSync(FFMPEG);

module.exports = {
  ytdlp: () => (YTDLP = executable(YTDLP)),
  ffmpeg: () => (FFMPEG = executable(FFMPEG)),
  ytdlpMissing, ffmpegMissing,
};
