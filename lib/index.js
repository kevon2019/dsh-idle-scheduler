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
/* [2026-09-18 v1.3.0] 队列状态汇总（与前端 summarize() 同口径，服务端为准） */
function summarize(q) {
  const out = { total: 0, queued: 0, running: 0, done: 0, failed: 0, archived: 0, active: 0 };
  for (const t of (Array.isArray(q) ? q : [])) {
    out.total += 1;
    if (t && t.archived === true) out.archived += 1;
    else { out.active += 1; if (t && typeof t.status === 'string' && Object.hasOwn(out, t.status)) out[t.status] += 1; }
  }
  return out;
}
function taskView(t) {
  const created = t.createdAt ? new Date(t.createdAt).getTime() : NaN;
  const finished = t.finishedAt ? new Date(t.finishedAt).getTime() : NaN;
  const durationMs = Number.isFinite(created) && Number.isFinite(finished) && finished >= created ? finished - created : null;
  return {
    id: t.id, prompt: t.prompt, model: t.model || '',
    mode: t.mode || 'idle', runAt: t.runAt || null,
    status: t.status, createdAt: t.createdAt, finishedAt: t.finishedAt,
    archived: t.archived === true, archivedAt: t.archivedAt || null,
    durationMs,
    error: t.error ? String(t.error).slice(0, 600) : null,
    result: t.result ? String(t.result).slice(0, 2000) : null,
  };
}

export async function apply(ctx) {
  const handler = async (req, res) => {
    const method = String(req.method || (req.headers && req.headers['x-http-method']) || 'GET').toUpperCase();
    if (method === 'GET') {
      const q = loadQ();
      sendJson(res, 200, {
        ok: true,
        tasks: q.map(taskView),
        stats: summarize(q),
        plugin: { name: 'dsh-idle-scheduler', version: VERSION },
      });
      return;
    }
    if (method === 'POST') {
      const b = await body(req);
      const action = String(b.action || '').trim();
      /* ---------- v1.3.0 队列操作（归档 / 取消归档 / 重试 / 取消 / 批量） ---------- */
      if (action) {
        const q = loadQ();
        if (action === 'archive-done') {
          let n = 0;
          for (const t of q) {
            if (t.status === 'done' || t.status === 'failed') { t.archived = true; t.archivedAt = new Date().toISOString(); n += 1; }
          }
          saveQ(q);
          sendJson(res, 200, { ok: true, affected: n });
          return;
        }
        if (action === 'clear-archived') {
          const keep = q.filter((t) => t.archived !== true || t.status === 'running');
          const n = q.length - keep.length;
          saveQ(keep);
          sendJson(res, 200, { ok: true, affected: n });
          return;
        }
        const id = String(b.id || '');
        const t = q.find((x) => x.id === id);
        if (!t) { sendJson(res, 404, { ok: false, error: 'no such task: ' + id }); return; }
        if (action === 'archive') {
          if (t.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能归档（等它结束）' }); return; }
          t.archived = true; t.archivedAt = new Date().toISOString();
        } else if (action === 'unarchive') {
          delete t.archived; t.archivedAt = null;
        } else if (action === 'retry') {
          /* 复制成一条新的待执行任务；若原是定时任务则保留同样的相对时间偏移没有意义，按闲时处理 */
          const copy = {
            id: Date.now() + Math.random().toString(36).slice(2, 6),
            prompt: t.prompt, model: t.model || '', mode: t.mode === 'scheduled' ? 'scheduled' : 'idle',
            runAt: t.mode === 'scheduled' && t.runAt ? new Date(Date.now() + 30 * 60000).toISOString() : null,
            status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
            archived: false, retryOf: t.id,
          };
          q.push(copy); saveQ(q);
          sendJson(res, 200, { ok: true, id: copy.id, runAt: copy.runAt, retryOf: t.id });
          return;
        } else if (action === 'cancel') {
          if (t.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能取消（等它结束）' }); return; }
          const keep = q.filter((x) => x.id !== id);
          saveQ(keep);
          sendJson(res, 200, { ok: true, removed: 1 });
          return;
        } else {
          sendJson(res, 400, { ok: false, error: 'unknown action: ' + action });
          return;
        }
        saveQ(q);
        sendJson(res, 200, { ok: true, id, archived: t.archived === true });
        return;
      }
      /* ---------- 新建任务 ---------- */
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
      const t = {
        id: Date.now() + Math.random().toString(36).slice(2, 6), prompt, model, mode, runAt,
        status: 'queued', createdAt: new Date().toISOString(), finishedAt: null,
        result: null, error: null, archived: false,
      };
      q.push(t); saveQ(q);
      sendJson(res, 200, { ok: true, id: t.id, runAt });
      return;
    }
    if (method === 'DELETE') {
      const b = await body(req);
      const id = String((b && b.id) || '');
      let q = loadQ();
      const target = q.find((t) => t.id === id);
      if (target && target.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能删除' }); return; }
      const before = q.length;
      q = q.filter((t) => t.id !== id);
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
