// A stand-in for `streamlit run`: honours --server.port / --server.baseUrlPath, answers the health check, renders a
// page that proves the app's environment (URL, workspace, a read-only token that can query but not mutate), echoes
// POST bodies and bridges a WebSocket — everything the proxy must get right.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const arg = (name) => process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
// Streamlit gets flags; Dash (PORT, DASH_URL_BASE_PATHNAME) and Gradio (GRADIO_SERVER_PORT, served at the root) get env.
const framework = arg('--server.port') ? 'streamlit' : process.env.DASH_URL_BASE_PATHNAME ? 'dash' : process.env.GRADIO_SERVER_PORT ? 'gradio' : 'streamlit';
const port = Number(arg('--server.port') ?? process.env.PORT ?? process.env.GRADIO_SERVER_PORT);
const base = arg('--server.baseUrlPath') ?? (process.env.DASH_URL_BASE_PATHNAME ?? '').replace(/\/$/, '');
const entry = process.argv.find((a) => a.endsWith('.py'));
const fs = await import('node:fs');
const source = entry && fs.existsSync(entry) ? fs.readFileSync(entry, 'utf8') : '';
if (process.env.FAKE_STREAMLIT_CRASH === '1' || source.includes('CRASH_ON_START')) {
  console.error('Traceback: boom');
  process.exit(3);
}
const delay = Number(process.env.FAKE_STREAMLIT_DELAY_MS ?? 0);

const api = async (path, body) => {
  const res = await fetch(`${process.env.DUCKVIEW_URL}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${process.env.DUCKVIEW_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === `${base}/_stcore/health`) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === `${base}/echo`) { let b = Buffer.alloc(0); req.on('data', (c) => (b = Buffer.concat([b, c]))); req.on('end', () => { res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/octet-stream', 'x-echo-length': String(b.length) }); res.end(b); }); return; }
  if (url.pathname === `${base}/` || url.pathname === base) {
    const ws = process.env.DUCKVIEW_WORKSPACE;
    const q = await api(`/api/workspaces/${ws}/query`, { sql: 'SELECT 1 AS one' }).catch((e) => ({ status: 0, json: { error: String(e) } }));
    const m = await api(`/api/workspaces/${ws}/query`, { sql: 'CREATE TABLE app_should_not_write AS SELECT 1' }).catch((e) => ({ status: 0, json: {} }));
    const other = process.env.OTHER_WORKSPACE ? await api(`/api/workspaces/${process.env.OTHER_WORKSPACE}/query`, { sql: 'SELECT 1' }).catch(() => ({ status: 0 })) : null;
    const info = { url: process.env.DUCKVIEW_URL, workspace: ws, hasToken: !!process.env.DUCKVIEW_TOKEN, tokenPrefix: (process.env.DUCKVIEW_TOKEN ?? '').slice(0, 3), secretLeak: Object.keys(process.env).filter((k) => /JWT|ENCRYPTION|PASSWORD/i.test(k)), viewer: req.headers['x-duckview-email'] ?? null, framework, path: url.pathname, forwardedHost: req.headers['x-forwarded-host'] ?? null, rootPath: process.env.GRADIO_ROOT_PATH ?? null, role: req.headers['x-duckview-role'] ?? null, queryRows: q.json.rowCount ?? null, queryStatus: q.status, mutateStatus: m.status, otherWorkspaceStatus: other?.status ?? null, source: source.slice(0, 60) };
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><body><h1>fake streamlit</h1><script id="info" type="application/json">${JSON.stringify(info)}</script></body></html>`);
  }
  res.writeHead(404); res.end('not found');
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== `${base}/_stcore/stream`) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ hello: true, protocol: ws.protocol, user: req.headers['x-duckview-user'] ?? null, protocols: req.headers['sec-websocket-protocol'] ?? null }));
    ws.on('message', (data, isBinary) => ws.send(isBinary ? data : `echo:${data}`, { binary: isBinary }));
  });
});
setTimeout(() => server.listen(port, '127.0.0.1', () => console.log(`fake streamlit on ${port}${base}`)), delay);
process.on('SIGTERM', () => { server.close(); process.exit(0); });
