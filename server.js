const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// senha opcional (HTTP Basic, qualquer usuario). Recomendado ao publicar.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PORT = process.env.PORT || 3000;
// local: 127.0.0.1 (so o seu PC). Em container/hospedagem defina HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;
const bin = require('./lib/bin');
const h = require('./lib/handlers');

const TMP = path.join(os.tmpdir(), 'facilitador');
fs.mkdirSync(TMP, { recursive: true });

const jobs = new Map();
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.flac', '.wma'];
const JOB_TTL = 30 * 60 * 1000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

// ---------- helpers ----------
const { json } = h;
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

const { lastLines } = require('./lib/media');

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
  if (bin.ffmpegMissing()) { fail(job, 'ffmpeg nao encontrado. Rode: npm install (ou defina FFMPEG_PATH)'); req.resume(); return job; }
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
    const p = spawn(bin.ffmpeg(), args);
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

    if (!h.auth(req, res)) return;

    if (req.method === 'GET' && u.pathname === '/api/status') return h.status(req, res);
    if (req.method === 'POST' && u.pathname === '/api/info') return await h.info(req, res);
    if (req.method === 'POST' && u.pathname === '/api/download') return await h.download(req, res);

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
  if (bin.ytdlpMissing()) console.log('AVISO: yt-dlp nao encontrado. Rode: npm run setup');
});
