// Development-only static server. No backend, accounts, uploads or inference.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !mime[extname(path)]) { response.writeHead(404).end(); return; }
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store' }).end(content);
  } catch { response.writeHead(404).end('Not found'); }
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error('A porta 5173 já está em uso. O servidor pode já estar aberto em http://127.0.0.1:5173.');
  } else {
    console.error(`Não foi possível iniciar o servidor: ${error.message}`);
  }
  process.exitCode = 1;
});
server.listen(5173, '127.0.0.1', () => console.log('Primeiros Sinais: http://127.0.0.1:5173'));
