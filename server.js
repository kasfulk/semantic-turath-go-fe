'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 20051);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = (process.env.API_BASE || 'http://192.168.1.11:20052').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPSTREAM_TIMEOUT_MS = 30000; // submit/poll pendek; tidak ada lagi koneksi panjang
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function pipeUpstream(ur, res) {
  const chunks = [];
  ur.on('data', (c) => chunks.push(c));
  ur.on('end', () => {
    const body = Buffer.concat(chunks);
    if (ur.statusCode >= 200 && ur.statusCode < 300) {
      res.writeHead(ur.statusCode, {
        'Content-Type': ur.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } else {
      sendJSON(res, 502, {
        error: `API pencarian merespons ${ur.statusCode}`,
        detail: body.toString('utf8').slice(0, 500),
      });
    }
  });
}

function guardUpstream(upstream, res) {
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('timeout upstream 30 detik')));
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: 'API pencarian tidak dapat dihubungi.', detail: err.message });
    else res.destroy();
  });
  // klien memutus → hentikan permintaan upstream
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
}

function forwardGET(target, res) {
  const upstream = http.get(target, (ur) => pipeUpstream(ur, res));
  guardUpstream(upstream, res);
}

function clampLimit(raw) {
  let limit = parseInt(raw, 10);
  if (!Number.isFinite(limit)) limit = 10;
  return Math.min(50, Math.max(1, limit));
}

function getAsk(u, res) {
  const q = (u.searchParams.get('q') || '').trim();
  if (!q) return sendJSON(res, 400, { error: 'Parameter q wajib diisi.' });
  forwardGET(`${API_BASE}/ask?q=${encodeURIComponent(q)}&limit=${clampLimit(u.searchParams.get('limit'))}`, res);
}

function getRequest(u, res) {
  const id = (u.searchParams.get('id') || '').trim();
  if (!id) return sendJSON(res, 400, { error: 'Parameter id wajib diisi.' });
  forwardGET(`${API_BASE}/request?id=${encodeURIComponent(id)}`, res);
}

function getRequests(u, res) {
  forwardGET(`${API_BASE}/requests?limit=${clampLimit(u.searchParams.get('limit'))}`, res);
}

function postAsk(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      if (!res.headersSent) sendJSON(res, 413, { error: 'Body terlalu besar.' });
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent || res.writableEnded) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return sendJSON(res, 400, { error: 'Body JSON tidak valid.' });
    }
    const q = String(body.q ?? '').trim();
    if (!q) return sendJSON(res, 400, { error: 'Parameter q wajib diisi.' });
    const payload = JSON.stringify({ q, limit: clampLimit(body.limit) });
    const upstream = http.request(`${API_BASE}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    }, (ur) => pipeUpstream(ur, res));
    guardUpstream(upstream, res);
    upstream.end(payload);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJSON(res, 403, { error: 'Terlarang' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'Berkas tidak ditemukan' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJSON(res, 400, { error: 'URL tidak valid' });
  }
  if (u.pathname.startsWith('/api/')) {
    if (u.pathname === '/api/ask') {
      if (req.method === 'POST') return postAsk(req, res);
      if (req.method === 'GET') return getAsk(u, res);
      return sendJSON(res, 405, { error: 'Method tidak diizinkan' });
    }
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method tidak diizinkan' });
    if (u.pathname === '/api/request') return getRequest(u, res);
    if (u.pathname === '/api/requests') return getRequests(u, res);
    return sendJSON(res, 404, { error: 'Endpoint API tidak ditemukan' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method tidak diizinkan' });
  serveStatic(u.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`semantic-turath-fe listening on http://${HOST}:${PORT} (API: ${API_BASE})`);
});
