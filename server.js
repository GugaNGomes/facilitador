const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
// local: 127.0.0.1 (so o seu PC). Em container/hospedagem defina HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
// senha opcional (HTTP Basic, qualquer usuario). Recomendado ao publicar.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;
const YTDLP = process.env.YTDLP_PATH || path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let FFMPEG = process.env.FFMPEG_PATH;
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static'); } catch { FFMPEG = 'ffmpeg'; } }

const TMP = path.join(os.tmpdir(), 'facilitador');
fs.mkdirSync(TMP, { recursive: true });

const jobs = new Map();
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.flac', '.wma'];
const JOB_TTL = 30 * 60 * 1000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// ---------- helpers ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function validUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

function newJob(label) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, dir, label, status: 'running', progress: 0, stage: 'Iniciando...', file: null, name: null, error: null };
  jobs.set(id, job);
  setTimeout(() => {
    jobs.delete(id);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }, JOB_TTL).unref();
  return job;
}

function fail(job, msg) { job.status = 'error'; job.error = msg; }

function finish(job) {
  const files = fs.readdirSync(job.dir).filter((f) => !f.startsWith('_in') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!files.length) return fail(job, 'Nenhum arquivo foi gerado.');
  job.file = path.join(job.dir, files[0]);
  job.name = files[0];
  job.size = fs.statSync(job.file).size;
  job.progress = 100;
  job.stage = 'Pronto';
  job.status = 'done';
}

function lastLines(text, n = 4) {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

// ---------- yt-dlp ----------
function ytdlpMissing() { return !fs.existsSync(YTDLP); }
// 'ffmpeg' puro (sem caminho) vem do PATH; caminho absoluto precisa existir
function ffmpegMissing() { return path.isAbsolute(FFMPEG) && !fs.existsSync(FFMPEG); }

function getInfo(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, ['--no-playlist', '--no-warnings', '-J', url]);
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

function startDownload(url, format, quality) {
  const job = newJob('download');
  if (ffmpegMissing()) { fail(job, 'ffmpeg nao encontrado. Rode: npm install (ou defina FFMPEG_PATH)'); return job; }
  const args = ['--no-playlist', '--newline', '--windows-filenames', '--no-warnings',
    '--concurrent-fragments', '4', '--retries', '3', '--socket-timeout', '20',
    '--ffmpeg-location', FFMPEG,
    '-o', path.join(job.dir, '%(title).120B [%(id)s].%(ext)s')];

  if (['mp3', 'm4a', 'wav', 'opus'].includes(format)) {
    args.push('-x', '--audio-format', format);
    if (format === 'mp3' || format === 'm4a') args.push('--audio-quality', `${parseInt(quality) || 192}K`);
  } else {
    const h = parseInt(quality);
    const filt = h ? `[height<=${h}]` : '';
    args.push('-f', `bv*${filt}+ba/b${filt}/b`, '-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4');
  }
  args.push(url);

  const p = spawn(YTDLP, args);
  let err = '';
  p.stdout.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        // video+audio separados: o yt-dlp baixa 2 vezes, entao nunca deixa a barra voltar
        job.progress = Math.max(job.progress, Math.min(90, Math.round(parseFloat(m[1]) * 0.9)));
        job.stage = 'Baixando...';
      } else if (/\[(Merger|ExtractAudio|VideoConvertor)\]/.test(line)) {
        job.progress = 95;
        job.stage = 'Convertendo...';
      }
    }
  });
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => fail(job, e.message));
  p.on('close', (code) => {
    if (job.status === 'error') return;
    if (code !== 0) return fail(job, lastLines(err) || 'Falha no download');
    finish(job);
  });
  return job;
}

// ---------- ffmpeg ----------
function ffmpegArgs(input, output, ext, opts) {
  const { target, res, bitrate } = opts;
  const audioIn = AUDIO_EXTS.includes(ext);
  const br = `${parseInt(bitrate) || 192}k`;
  const h = parseInt(res);
  const vf = h ? ['-vf', `scale=-2:${h}`] : [];
  const base = ['-y', '-hide_banner'];

  switch (target) {
    case 'mp3': return [...base, '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', br, output];
    case 'm4a': return [...base, '-i', input, '-vn', '-c:a', 'aac', '-b:a', br, output];
    case 'ogg': return [...base, '-i', input, '-vn', '-c:a', 'libvorbis', '-b:a', br, output];
    case 'wav': return [...base, '-i', input, '-vn', '-c:a', 'pcm_s16le', output];
    case 'mp4':
      if (audioIn) // audio -> mp4: tela preta
        return [...base, '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=10', '-i', input, '-shortest',
          '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', br, '-movflags', '+faststart', output];
      return [...base, '-i', input, ...vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', br, '-movflags', '+faststart', output];
    case 'webm':
      return [...base, '-i', input, ...vf, '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '5',
        '-c:a', 'libopus', '-b:a', br, output];
    case 'gif':
      return [...base, '-i', input, '-an', '-vf', `fps=12,scale=${h ? `-2:${h}` : '480:-1'}:flags=lanczos`, output];
    default: return null;
  }
}

function startConvert(req, filename, opts) {
  const job = newJob('convert');
  const ext = path.extname(filename).toLowerCase();
  const input = path.join(job.dir, '_in' + ext);
  const baseName = path.basename(filename, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'arquivo';
  const output = path.join(job.dir, `${baseName}.${opts.target}`);
  const args = ffmpegArgs(input, output, ext, opts);
  if (ffmpegMissing()) { fail(job, 'ffmpeg nao encontrado. Rode: npm install (ou defina FFMPEG_PATH)'); req.resume(); return job; }
  if (!args) { fail(job, 'Formato de saida invalido'); return job; }

  job.stage = 'Enviando arquivo...';
  const ws = fs.createWriteStream(input);
  const total = parseInt(req.headers['content-length']) || 0;
  let got = 0;
  req.on('data', (c) => { got += c.length; if (total) job.progress = Math.round((got / total) * 20); });
  req.pipe(ws);
  ws.on('error', (e) => fail(job, e.message));
  ws.on('finish', () => {
    job.stage = 'Convertendo...';
    const p = spawn(FFMPEG, args);
    let err = '', dur = 0;
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      const dm = s.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (dm && !dur) dur = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
      const tm = [...s.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
      if (tm && dur) {
        const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
        job.progress = 20 + Math.min(78, Math.round((t / dur) * 78));
      }
    });
    p.on('error', (e) => fail(job, 'ffmpeg nao encontrado: ' + e.message));
    p.on('close', (code) => {
      fs.rm(input, { force: true }, () => {});
      if (code !== 0) return fail(job, lastLines(err) || 'Falha na conversao');
      finish(job);
    });
  });
  return job;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

    if (APP_PASSWORD) {
      const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      const pass = given.slice(given.indexOf(':') + 1);
      const a = Buffer.from(pass), b = Buffer.from(APP_PASSWORD);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Facilitador"' });
        return res.end('Autenticacao necessaria');
      }
    }

    if (req.method === 'GET' && u.pathname === '/api/status') {
      return json(res, 200, { ytdlp: !ytdlpMissing(), ffmpeg: !ffmpegMissing(), maxUploadMB: MAX_UPLOAD / 1024 / 1024 });
    }

    if (req.method === 'POST' && u.pathname === '/api/info') {
      if (ytdlpMissing()) return json(res, 500, { error: 'yt-dlp nao instalado. Rode: npm run setup' });
      const { url } = await readBody(req);
      if (!validUrl(url)) return json(res, 400, { error: 'Link invalido' });
      try { return json(res, 200, await getInfo(url)); }
      catch (e) { return json(res, 422, { error: e.message }); }
    }

    if (req.method === 'POST' && u.pathname === '/api/download') {
      if (ytdlpMissing()) return json(res, 500, { error: 'yt-dlp nao instalado. Rode: npm run setup' });
      const { url, format, quality } = await readBody(req);
      if (!validUrl(url)) return json(res, 400, { error: 'Link invalido' });
      const job = startDownload(url, format, quality);
      return json(res, 200, { id: job.id });
    }

    if (req.method === 'POST' && u.pathname === '/api/convert') {
      if (parseInt(req.headers['content-length']) > MAX_UPLOAD)
        return json(res, 413, { error: `Arquivo maior que ${MAX_UPLOAD / 1024 / 1024} MB` });
      const filename = decodeURIComponent(req.headers['x-filename'] || 'arquivo.bin');
      const job = startConvert(req, filename, {
        target: u.searchParams.get('target'), res: u.searchParams.get('res'), bitrate: u.searchParams.get('bitrate'),
      });
      return json(res, 200, { id: job.id });
    }

    const jm = u.pathname.match(/^\/api\/jobs\/([a-f0-9]+)(\/file)?$/);
    if (req.method === 'GET' && jm) {
      const job = jobs.get(jm[1]);
      if (!job) return json(res, 404, { error: 'Tarefa expirada' });
      if (!jm[2]) return json(res, 200, { status: job.status, progress: job.progress, stage: job.stage, error: job.error, name: job.name, size: job.size });
      if (job.status !== 'done') return json(res, 409, { error: 'Ainda nao terminou' });
      const stat = fs.statSync(job.file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(job.name)}`,
      });
      return fs.createReadStream(job.file).pipe(res);
    }

    // arquivos estaticos
    if (req.method === 'GET') {
      const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      const file = path.join(__dirname, 'public', path.normalize(rel));
      if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Facilitador rodando em http://${HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && !APP_PASSWORD) console.log('AVISO: exposto sem APP_PASSWORD. Defina uma senha.');
  if (ytdlpMissing()) console.log('AVISO: yt-dlp nao encontrado. Rode: npm run setup');
});
