import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardRoot = resolve(fileURLToPath(new URL('../dashboard/', import.meta.url)));
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const filePath = resolve(dashboardRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relPath = relative(dashboardRoot, filePath);
    if (relPath === '..' || relPath.startsWith(`..${sep}`) || resolve(filePath) === dashboardRoot) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const file = await stat(filePath);
    if (!file.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }

    const headers = {
      'Content-Type': mimeTypes.get(extname(filePath)) ?? 'application/octet-stream',
      'Content-Length': file.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': filePath.endsWith('config.js') ? 'no-store' : 'no-cache',
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    response.writeHead(missing ? 404 : 400).end(missing ? 'Not found' : 'Bad request');
  }
}).listen(8000, '127.0.0.1', () => {
  console.log('Companion dashboard listening at http://localhost:8000');
});
