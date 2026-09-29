// Local pilot server: serves assets and writes approved training to the CSV.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTraining, writeTraining } from './training-csv.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const origin = 'http://127.0.0.1:5173';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
const json = (response, status, data) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
async function bodyJson(request) {
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('O treinamento excede 16 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/training') {
      if (request.method === 'GET') {
        const profile = new URL(request.url, origin).searchParams.get('profile');
        if (!profile) { json(response, 400, { error: 'Perfil obrigatório.' }); return; }
        json(response, 200, await readTraining(profile)); return;
      }
      if (request.method === 'PUT') {
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0] !== 'application/json') { json(response, 403, { error: 'Gravação permitida apenas pelo aplicativo local.' }); return; }
        const { profile, training } = await bodyJson(request);
        if (typeof profile !== 'string' || profile.length > 32) { json(response, 400, { error: 'Perfil inválido.' }); return; }
        json(response, 200, await writeTraining(profile, training)); return;
      }
      json(response, 405, { error: 'Método não suportado.' }); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !mime[extname(path)]) { response.writeHead(404).end(); return; }
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store' }).end(request.method === 'HEAD' ? undefined : content);
  } catch (error) { json(response, 400, { error: error.message || 'Erro ao acessar o treinamento.' }); }
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
