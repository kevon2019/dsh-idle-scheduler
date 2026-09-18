import fs from 'node:fs';
import path from 'node:path';

const NAME = 'idle-scheduler';
const QFILE = '/root/.dsh/idle-tasks.json';

/* 插件自身版本（单一事实来源：package.json），随 GET 一起返回，便于面板/命令行核对。 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '');
  } catch { return ''; }
}
const VERSION = pluginVersion();

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
/* [2026-09-18 v1.2.0] runAt 校验：客户端传 ISO 或「本地无时区」两种写法都接受，
 * 统一存成 ISO（执行器 scripts/idle-scheduler.js 用 new Date(runAt) 判定到期）。
 * 无法解析的时间一律 400 拒绝——否则任务会永远排在那里不执行。 */
function normalizeRunAt(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'runAt required for scheduled mode' };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'runAt 无法解析（需要 ISO 或 YYYY-MM-DDTHH:MM）' };
  return { ok: true, iso: d.toISOString() };
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
      sendJson(res, 200, { ok: true, tasks: q, plugin: { name: 'dsh-idle-scheduler', version: VERSION } });
      return;
    }
    if (method === 'POST') {
      const b = await body(req);
      const prompt = String(b.prompt || '').trim();
      const model = String(b.model || '').trim();
      const mode = b.mode === 'scheduled' ? 'scheduled' : 'idle';
      if (!prompt) { sendJson(res, 400, { ok: false, error: 'prompt required' }); return; }
      let runAt = null;
      if (mode === 'scheduled') {
        const norm = normalizeRunAt(b.runAt);
        if (!norm.ok) { sendJson(res, 400, { ok: false, error: norm.error }); return; }
        runAt = norm.iso;
      }
      const q = loadQ();
      const t = { id: Date.now() + Math.random().toString(36).slice(2, 6), prompt, model, mode, runAt, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
      q.push(t); saveQ(q);
      sendJson(res, 200, { ok: true, id: t.id, runAt });
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
