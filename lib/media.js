// Logica compartilhada de download (servidor local, Docker e funcoes da Vercel)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const bin = require('./bin');

const lastLines = (text, n = 4) => text.trim().split(/\r?\n/).slice(-n).join('\n');

// flags comuns: cache em pasta gravavel e Node como runtime JS do YouTube
function common() {
  return ['--no-warnings', '--cache-dir', path.join(os.tmpdir(), 'yt-dlp-cache'),
    '--js-runtimes', `node:${process.execPath}`];
}

function getInfo(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin.ytdlp(), ['--no-playlist', ...common(), '-J', url]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastLines(err) || 'Falha ao ler o link'));
      try {
        const j = JSON.parse(out);
        const heights = [...new Set((j.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))]
          .sort((a, b) => b - a);
        resolve({
          title: j.title, thumbnail: j.thumbnail, duration: j.duration,
          uploader: j.uploader || j.channel, site: j.extractor_key, heights,
        });
      } catch (e) { reject(e); }
    });
  });
}

// Baixa para `dir`. onProgress(pct, stage). Retorna { child, done: Promise<{file,name,size}> }
function download(url, format, quality, dir, onProgress) {
  const args = ['--no-playlist', '--newline', '--windows-filenames', ...common(),
    '--concurrent-fragments', '4', '--retries', '3', '--socket-timeout', '20',
    '--ffmpeg-location', bin.ffmpeg(),
    '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s')];

  if (['mp3', 'm4a', 'wav', 'opus'].includes(format)) {
    args.push('-x', '--audio-format', format);
    if (format === 'mp3' || format === 'm4a') args.push('--audio-quality', `${parseInt(quality) || 192}K`);
  } else {
    const h = parseInt(quality);
    const filt = h ? `[height<=${h}]` : '';
    args.push('-f', `bv*${filt}+ba/b${filt}/b`, '-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4');
  }
  args.push(url);

  const child = spawn(bin.ytdlp(), args);
  let err = '', pct = 0;
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          // video+audio separados: o yt-dlp baixa 2 vezes, entao nunca deixa a barra voltar
          pct = Math.max(pct, Math.min(90, Math.round(parseFloat(m[1]) * 0.9)));
          onProgress(pct, 'Baixando...');
        } else if (/\[(Merger|ExtractAudio|VideoConvertor)\]/.test(line)) {
          pct = 95;
          onProgress(pct, 'Convertendo...');
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastLines(err) || 'Falha no download'));
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('_in') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (!files.length) return reject(new Error('Nenhum arquivo foi gerado.'));
      const file = path.join(dir, files[0]);
      resolve({ file, name: files[0], size: fs.statSync(file).size });
    });
  });
  return { child, done };
}

module.exports = { getInfo, download, lastLines };
