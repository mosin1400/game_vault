const assert = require('node:assert/strict');
const http = require('node:http');
const { createStudioProxy, resolveDashboardPort } = require('../backend/http/studio-proxy');
(async () => {
  assert.equal(resolveDashboardPort({ 'x-gv-api-port': '8080' }), 8080, 'Studio must use the dashboard port passed in its launch URL');
  assert.equal(resolveDashboardPort({ 'x-gv-api-port': 'not-a-port' }), 8080, 'an invalid caller-controlled port must fall back safely');
  assert.equal(resolveDashboardPort({ 'x-gv-api-port': '8081' }), 8081, 'an explicit Studio launch port must be preserved');
  const upstream = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks).toString(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, path: req.url, token: req.headers['x-gv-studio-token'], body: body ? JSON.parse(body) : null })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.2', resolve));
  const handle = createStudioProxy({ port: upstream.address().port });
  const proxy = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); if (chunks.length) req.body = JSON.parse(Buffer.concat(chunks)); handle(req, res); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const data = await (await fetch(base + '/api/version', { signal: AbortSignal.timeout(3000), method: 'DELETE', body: JSON.stringify({ game: 'demo', version: 'v2' }), headers: { 'content-type': 'application/json', 'x-gv-studio-token': 'fixture' } })).json();
    assert.deepEqual(data, { method: 'DELETE', path: '/api/version', token: 'fixture', body: { game: 'demo', version: 'v2' } });
    assert.equal((await fetch(base + '/server.js')).status, 404);
    await new Promise(resolve => upstream.close(resolve));
    const unavailable = await fetch(base + '/api/version', { method: 'DELETE' });
    assert.equal(unavailable.status, 502); assert.match((await unavailable.json()).error, /unavailable/);
    console.log('Studio same-origin DELETE proxy and friendly connection errors passed');
  } finally {
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => proxy.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
