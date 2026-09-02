/**
 * The recording origin.
 *
 * A production PWA build has `apiBaseUrl: ''` — **same origin** — which is the shape staging and
 * production have (Caddy serves the bundle and proxies `/api` on one hostname). So the demo is
 * recorded against exactly that: one origin, no CORS preflight, no baked-in address. This server
 * is the local stand-in for Caddy — static files out of the build, everything the API owns
 * proxied to it, and an SPA fallback so a deep link like `/set-password?token=…` reaches Angular.
 *
 * Run standalone with `npm run serve`; `record.mjs` imports `startServer` instead.
 */
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { config } from './config.mjs';

const root = resolve(config.distDir, 'browser');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Everything the API owns. Anything else is the bundle. */
const PROXIED = ['/api/', '/auth/', '/health', '/hangfire'];

function proxy(clientRequest, clientResponse) {
  const target = new URL(config.apiOrigin);
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: { ...clientRequest.headers, host: target.host },
    },
    (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstream.on('error', (error) => {
    clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    clientResponse.end(`Teren API unreachable at ${config.apiOrigin}: ${error.message}`);
  });

  clientRequest.pipe(upstream);
}

async function sendFile(response, filePath, status = 200) {
  const info = await stat(filePath);
  response.writeHead(status, {
    'content-type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // Nothing is cached: a scene must never open a bundle from a previous run.
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

export function startServer() {
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/';

    if (PROXIED.some((prefix) => url === prefix || url.startsWith(prefix))) {
      proxy(request, response);
      return;
    }

    const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
    const candidate = join(root, normalize(pathname).replace(/^[/\\]+/, ''));

    if (candidate.startsWith(root)) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          await sendFile(response, candidate);
          return;
        }
      } catch {
        /* falls through to the SPA index */
      }
    }

    // SPA fallback. Angular's router owns every path that is not a file on disk.
    try {
      await sendFile(response, join(root, 'index.html'));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`No build at ${root}. Run \`npm run prepare-demo\` first.`);
    }
  });

  return new Promise((resolvePromise) => {
    server.listen(config.port, '127.0.0.1', () =>
      resolvePromise({
        origin: `http://localhost:${config.port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { origin } = await startServer();
  console.log(`Teren demo build on ${origin} (API proxied to ${config.apiOrigin}). Ctrl+C to stop.`);
}
