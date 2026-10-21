// Baixa (ou atualiza) o yt-dlp para ./bin e garante o binario do ffmpeg-static
const https = require('https');
const fs = require('fs');
const path = require('path');

const win = process.platform === 'win32';
const name = win ? 'yt-dlp.exe' : 'yt-dlp';
// no Linux usa o binario standalone (nao precisa de Python)
const asset = win ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
const dest = path.join(__dirname, 'bin', name);
fs.mkdirSync(path.dirname(dest), { recursive: true });

function get(u, redirects = 0) {
  https.get(u, { headers: { 'User-Agent': 'facilitador' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
      res.resume();
      return get(res.headers.location, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.error('Falha ao baixar yt-dlp: HTTP ' + res.statusCode);
      process.exit(1);
    }
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    out.on('finish', () => {
      out.close(() => {
        fs.renameSync(tmp, dest);
        if (!win) fs.chmodSync(dest, 0o755);
        console.log('yt-dlp instalado em ' + dest);
        ensureFfmpeg();
      });
    });
  }).on('error', (e) => {
    console.error('Erro de rede: ' + e.message);
    process.exit(1);
  });
}

console.log('Baixando ' + url);
get(url);

// O npm recente nao roda o postinstall do ffmpeg-static sem aprovacao; baixa na mao se faltar.
function ensureFfmpeg() {
  let p;
  try { p = require('ffmpeg-static'); } catch { return; }
  if (p && fs.existsSync(p)) return console.log('ffmpeg ok: ' + p);
  console.log('Baixando ffmpeg...');
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'node_modules', 'ffmpeg-static', 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(p)) { console.error('Falha ao baixar o ffmpeg'); process.exit(1); }
}
