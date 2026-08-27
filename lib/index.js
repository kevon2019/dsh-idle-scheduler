import fs from 'node:fs';
import path from 'node:path';

const NAME = 'idle-scheduler';
const QFILE = '/root/.dsh/idle-tasks.json';

function loadQ() {
  try { return JSON.parse(fs.readFileSync(QFILE, 'utf8')); } catch { return []; }
}
function saveQ(q) {
  fs.mkdirSync(path.dirname(QFILE), { recursive: true });
  fs.writeFileSync(QFILE, JSON.stringify(q, null, 2));
}
function sendJson(res, code, obj) {
  try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch {}
}
function body(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export async function apply(ctx) {
  const handler = async (req, res) => {
    const method = String(req.method || (req.headers && req.headers['x-http-method']) || 'GET').toUpperCase();
    if (method === 'GET') {
      const q = loadQ().map((t) => ({
        id: t.id, prompt: t.prompt, model: t.model || '',
        mode: t.mode || 'idle', runAt: t.runAt || null,
        status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt,
        error: t.error || null, result: (t.result || '').slice(0, 300),
      }));
      sendJson(res, 200, { ok: true, tasks: q });
      return;
    }
    if (method === 'POST') {
      const b = await body(req);
      const prompt = String(b.prompt || '').trim();
      const model = String(b.model || '').trim();
      const mode = b.mode === 'scheduled' ? 'scheduled' : 'idle';
      const runAt = b.runAt ? String(b.runAt).trim() : null;
      if (!prompt) { sendJson(res, 400, { ok: false, error: 'prompt required' }); return; }
      if (mode === 'scheduled' && !runAt) { sendJson(res, 400, { ok: false, error: 'runAt required for scheduled mode' }); return; }
      const q = loadQ();
      const t = { id: Date.now() + Math.random().toString(36).slice(2, 6), prompt, model, mode, runAt, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
      q.push(t); saveQ(q);
      sendJson(res, 200, { ok: true, id: t.id });
      return;
    }
    if (method === 'DELETE') {
      const b = await body(req);
      const id = String((b && b.id) || '');
      let q = loadQ();
      const before = q.length;
      q = q.filter((t) => t.id !== id || t.status === 'running');
      saveQ(q);
      sendJson(res, 200, { ok: q.length < before, removed: before - q.length });
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
  };
  const disposers = [ctx.webServer.register({ path: '/api/idle-scheduler/tasks', handler })];
  return () => { for (const d of disposers) d(); };
}

export const inject = ['webServer'];
export const name = NAME;
