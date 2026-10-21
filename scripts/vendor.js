// Copia o ffmpeg.wasm (conversao no navegador) para public/vendor
const fs = require('fs');
const path = require('path');
const nm = path.join(__dirname, '..', 'node_modules', '@ffmpeg');
const out = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
for (const [from, files] of [['ffmpeg/dist/umd', ['ffmpeg.js', '814.ffmpeg.js']], ['core/dist/umd', ['ffmpeg-core.js', 'ffmpeg-core.wasm']]]) {
  for (const f of files) {
    fs.copyFileSync(path.join(nm, from, f), path.join(out, f));
  }
}
console.log('ffmpeg.wasm copiado para public/vendor');
