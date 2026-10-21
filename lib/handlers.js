// Handlers HTTP (req/res do Node) usados pelo server.js e pelas funcoes em /api (Vercel)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bin = require('./bin');
const media = require('./media');

const APP_PASSWORD = process.env.APP_PASSWORD || '';

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body); // Vercel ja faz o parse
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

// true = liberado. Caso contrario ja respondeu 401.
function auth(req, res) {
  if (!APP_PASSWORD) return true;
  const given = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
  const a = Buffer.from(given.slice(given.indexOf(':') + 1)), b = Buffer.from(APP_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Facilitador"' });
  res.end('Autenticacao necessaria');
  return false;
}

const serverless = !!process.env.VERCEL;

function status(req, res) {
  json(res, 200, {
    ytdlp: !bin.ytdlpMissing(), ffmpeg: !bin.ffmpegMissing(),
    // na Vercel nao ha upload grande: a conversao de arquivos roda no navegador
    serverConvert: !serverless,
    maxUploadMB: (parseInt(process.env.MAX_UPLOAD_MB) || 500),
  });
}

async function info(req, res) {
  if (bin.ytdlpMissing()) return json(res, 500, { error: 'yt-dlp nao instalado. Rode: npm run setup' });
  const { url } = await readBody(req);
  if (!validUrl(url)) return json(res, 400, { error: 'Link invalido' });
  try { json(res, 200, await media.getInfo(url)); }
  catch (e) { json(res, 422, { error: e.message }); }
}

// Resposta em fluxo unico (funciona sem estado entre requisicoes):
//   P:<pct>:<etapa>\n ...   progresso
//   E:<mensagem>\n          erro (fim)
//   D:<tamanho>:<nome>\n    seguido dos bytes do arquivo
async function download(req, res) {
  if (bin.ytdlpMissing()) return json(res, 500, { error: 'yt-dlp nao instalado. Rode: npm run setup' });
  if (bin.ffmpegMissing()) return json(res, 500, { error: 'ffmpeg nao encontrado. Rode: npm run setup' });
  const { url, format, quality } = await readBody(req);
  if (!validUrl(url)) return json(res, 400, { error: 'Link invalido' });

  const dir = path.join(os.tmpdir(), 'facilitador', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});

  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let closed = false, last = -1;
  const send = (s) => { if (!closed) res.write(s); };

  const { child, done } = media.download(url, format, quality, dir, (pct, stage) => {
    if (pct !== last) { last = pct; send(`P:${pct}:${stage}\n`); }
  });
  res.on('close', () => { closed = true; child.kill(); setTimeout(cleanup, 1000); });
  send('P:0:Preparando...\n');

  try {
    const f = await done;
    if (closed) return cleanup();
    send(`D:${f.size}:${encodeURIComponent(f.name)}\n`);
    const rs = fs.createReadStream(f.file);
    rs.on('error', () => res.destroy());
    rs.pipe(res);
    res.on('finish', cleanup);
  } catch (e) {
    send('E:' + String(e.message).replace(/\s*\n\s*/g, ' | ') + '\n');
    if (!closed) res.end();
    cleanup();
  }
}

// envolve um handler com auth + tratamento de erro
const wrap = (fn, method = 'POST') => async (req, res) => {
  try {
    if (!auth(req, res)) return;
    if (req.method !== method) { res.setHeader('Allow', method); return json(res, 405, { error: 'Metodo nao permitido' }); }
    await fn(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
};

module.exports = { json, readBody, validUrl, auth, wrap, status, info, download };
