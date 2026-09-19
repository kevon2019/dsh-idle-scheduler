import fs from 'node:fs';
import path from 'node:path';

const NAME = 'idle-scheduler';
/* 队列 / 队列开关文件路径：调用时解析，允许用环境变量覆盖 —— 单测必须把落盘隔离到临时文件，
 * 否则跑一次测试就会把线上队列/开关覆盖掉（channel-bot 那边真踩过这个坑）。 */
const QFILE = process.env.IDLE_TASKS_FILE || '/root/.dsh/idle-tasks.json';                // 队列（面板与 cron 执行器共用）
const CFILE = process.env.IDLE_CONTROL_FILE || '/root/.dsh/idle-scheduler-control.json';  // 队列开关（暂停/恢复/终止）

/* 插件自身版本（单一事实来源：package.json），随 GET 一起返回，便于面板/命令行核对。 */
function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '');
  } catch { return ''; }
}
const VERSION = pluginVersion();

/* ---------------- 落盘：原子写（临时文件 + rename） ----------------
 * [v1.4.0] 面板与 cron 执行器会「同时」读写同一个队列文件，旧版直接 writeFileSync 覆盖：
 * 两边一旦交叠，读者可能读到半截 JSON（解析失败 = 队列看起来突然空了，下一次保存还会把它坐实）。
 * 现在统一「写临时文件 + rename」——同一文件系统内 rename 是原子的，读者只会看到完整的旧文件
 * 或完整的新文件；再加上调用方只做「读→改→写」的短事务，面板与执行器就不会互相写坏。 */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function loadQ() {
  try {
    const q = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
    return Array.isArray(q) ? q : [];
  } catch { return []; }
}
function saveQ(q) { writeJsonAtomic(QFILE, q); }

/* ---------------- 队列开关（暂停/恢复/终止） ----------------
 * 存独立文件而不是塞进 idle-tasks.json：后者是数组，执行器与历史版本都按数组解析，
 * 改结构会直接打断 cron；独立文件对旧版执行器完全无感（不认识就忽略）。 */
function loadCtl() {
  try {
    const c = JSON.parse(fs.readFileSync(CFILE, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}
function saveCtl(c) { writeJsonAtomic(CFILE, c); }
function queueView() {
  const c = loadCtl();
  return {
    paused: c.paused === true,
    pausedAt: c.pausedAt || null,
    reason: typeof c.reason === 'string' ? c.reason : '',
    updatedAt: c.updatedAt || null,
  };
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
 * 无法解析的时间一律 400 拒绝——否则任务会永远排在那里不执行。
 * [v1.4.0] 额外返回 past：过去时间不算错误（等价「下一次调度立刻执行」），但要如实告知面板。 */
function normalizeRunAt(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'runAt required for scheduled mode' };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'runAt 无法解析（需要 ISO 或 YYYY-MM-DDTHH:MM）' };
  return { ok: true, iso: d.toISOString(), past: d.getTime() <= Date.now() };
}

/* ---------------- 执行进程：识别 / 终止 ----------------
 * [v1.4.0] 「终止执行中的任务」必须真的杀掉 cron 执行器拉起的 `dsh --profile headless` 子进程。
 * 执行器把 child.pid 写回任务（pid/pidStartedAt），面板据此 kill；但 pid 会被系统复用，
 * 所以杀之前必须核对身份：cmdline 里要有 dsh，且 /proc/<pid> 的存在时间不能早于记录的启动时间。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function pidCmdline(pid) {
  try { return fs.readFileSync('/proc/' + Number(pid) + '/cmdline', 'utf8').replace(/\0/g, ' ').trim(); }
  catch { return ''; }
}
function pidStartMs(pid) {
  try { return fs.statSync('/proc/' + Number(pid)).ctimeMs; } catch { return NaN; }
}
/** 只终止「确实是本队列跑起来的 dsh 子进程」；返回 {ok,pid,error}，永不抛。 */
function killTaskProcess(t) {
  const pid = Number(t && t.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, pid: null, error: '该任务没有记录执行进程 PID（可能是旧版执行器跑起来的，或进程已结束）' };
  }
  if (!pidAlive(pid)) return { ok: false, pid, error: '执行进程 ' + pid + ' 已不存在（可能刚刚结束）' };
  const cmd = pidCmdline(pid);
  if (!/dsh/i.test(cmd)) {
    return { ok: false, pid, error: 'PID ' + pid + ' 不是 dsh 进程，已放弃终止以免误杀：' + cmd.slice(0, 120) };
  }
  const started = pidStartMs(pid);
  const declared = t && t.pidStartedAt ? Date.parse(t.pidStartedAt) : NaN;
  if (Number.isFinite(started) && Number.isFinite(declared) && started < declared - 5000) {
    return { ok: false, pid, error: 'PID ' + pid + ' 的启动时间早于本任务开始时间（疑似 pid 复用），已放弃终止以免误杀' };
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) { return { ok: false, pid, error: '发送终止信号失败：' + (e && e.message ? e.message : String(e)) }; }
  /* 宽限期后仍然活着 → 升级为 SIGKILL（后台执行，不阻塞本次请求） */
  try {
    const timer = setTimeout(() => {
      if (!pidAlive(pid)) return;
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }, 3000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  } catch { /* ignore */ }
  return { ok: true, pid, error: null };
}
/** [v1.4.0] 执行状态自愈：执行器进程被杀/服务器重启后，任务会永远停在 running。
 *  这里把「running 但进程已不存在（且已过 60s 落地窗口）」的任务标成 failed，避免面板一直骗人。 */
function sweepStale(q) {
  const now = Date.now();
  let n = 0;
  for (const t of (Array.isArray(q) ? q : [])) {
    if (!t || t.status !== 'running') continue;
    const started = t.pidStartedAt || t.startedAt || t.createdAt;
    const ms = started ? Date.parse(started) : NaN;
    if (Number.isFinite(ms) && now - ms < 60000) continue;   // 刚启动：给执行器写 pid 的窗口
    if (t.pid && pidAlive(t.pid)) continue;
    t.status = 'failed';
    t.error = '执行进程已不存在（执行器中断或任务被系统结束）；可「重试」或重新入队';
    t.finishedAt = new Date().toISOString();
    t.pid = null;
    t.terminateRequested = false;
    t.sweptAt = new Date().toISOString();
    n += 1;
  }
  return n;
}

/* [2026-09-18 v1.3.0] 队列状态汇总（与前端 summarize() 同口径，服务端为准）
 * [v1.4.0] 新增 terminated（已终止）与 paused（被暂停的待执行任务数）。 */
function summarize(q) {
  const out = { total: 0, active: 0, archived: 0, queued: 0, running: 0, done: 0, failed: 0, terminated: 0, paused: 0 };
  for (const t of (Array.isArray(q) ? q : [])) {
    out.total += 1;
    if (t && t.archived === true) { out.archived += 1; continue; }
    out.active += 1;
    if (t && typeof t.status === 'string' && Object.hasOwn(out, t.status)) out[t.status] += 1;
    if (t && t.status === 'queued' && t.paused === true) out.paused += 1;
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
    /* [v1.4.0] 暂停 / 终止 / 执行进程 相关字段（面板据此渲染按钮） */
    paused: t.paused === true,
    pausedAt: t.pausedAt || null,
    startedAt: t.startedAt || null,
    pid: Number.isInteger(Number(t.pid)) && Number(t.pid) > 0 ? Number(t.pid) : null,
    terminateRequested: t.terminateRequested === true,
    updatedAt: t.updatedAt || null,
    timeAdjustedAt: t.timeAdjustedAt || null,
    retryOf: t.retryOf || null,
  };
}
/** 新建任务的字段形状（面板与 CLI 写出来的必须一致，否则 UI 上按钮会时有时无）。 */
function newTask(fields) {
  return Object.assign({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    prompt: '', model: '', mode: 'idle', runAt: null,
    status: 'queued', createdAt: new Date().toISOString(), finishedAt: null,
    result: null, error: null, archived: false,
    paused: false, pausedAt: null, startedAt: null, pid: null, pidStartedAt: null,
    terminateRequested: false,
  }, fields || {});
}

export async function apply(ctx) {
  const handler = async (req, res) => {
    const method = String(req.method || (req.headers && req.headers['x-http-method']) || 'GET').toUpperCase();
    if (method === 'GET') {
      const q = loadQ();
      const swept = sweepStale(q);          // 执行器中断留下的「假执行中」任务在这里自愈
      if (swept > 0) saveQ(q);
      sendJson(res, 200, {
        ok: true,
        tasks: q.map(taskView),
        stats: summarize(q),
        queue: queueView(),
        swept,
        plugin: { name: 'dsh-idle-scheduler', version: VERSION },
      });
      return;
    }
    if (method === 'POST') {
      const b = await body(req);
      const action = String(b.action || '').trim();

      /* ---------- v1.4.0 队列级操作：暂停 / 恢复 / 终止整条队列 ---------- */
      if (action === 'pause-queue' || action === 'resume-queue' || action === 'terminate-queue') {
        const ctl = loadCtl();
        if (action === 'resume-queue') {
          ctl.paused = false; ctl.pausedAt = null; ctl.reason = '';
          ctl.updatedAt = new Date().toISOString();
          saveCtl(ctl);
          sendJson(res, 200, { ok: true, queue: queueView(), affected: 0, details: [] });
          return;
        }
        /* 先落暂停开关，再动执行中的任务：这样执行器不会在终止过程中又拉起新任务 */
        ctl.paused = true;
        ctl.pausedAt = ctl.pausedAt || new Date().toISOString();
        ctl.reason = String(b.reason || (action === 'terminate-queue' ? '队列终止' : '用户暂停')).slice(0, 200);
        ctl.updatedAt = new Date().toISOString();
        saveCtl(ctl);
        let terminated = 0;
        const details = [];
        if (action === 'terminate-queue') {
          const q = loadQ();
          for (const t of q) {
            if (!t || t.status !== 'running') continue;
            const kill = killTaskProcess(t);
            t.terminateRequested = true;
            t.status = 'terminated';
            t.finishedAt = new Date().toISOString();
            t.error = kill.ok ? '已终止（队列终止）' : ('已终止：' + kill.error);
            t.pid = null;
            terminated += 1;
            details.push({ id: t.id, pid: kill.pid, ok: kill.ok, error: kill.error });
          }
          if (terminated > 0) saveQ(q);
        }
        sendJson(res, 200, { ok: true, queue: queueView(), affected: terminated, details });
        return;
      }

      /* ---------- v1.3.0 / v1.4.0 任务级操作 ---------- */
      if (action) {
        const q = loadQ();
        if (action === 'archive-done') {
          let n = 0;
          for (const t of q) {
            if (t.status === 'done' || t.status === 'failed' || t.status === 'terminated') { t.archived = true; t.archivedAt = new Date().toISOString(); n += 1; }
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
        const t = q.find((x) => x && x.id === id);
        if (!t) { sendJson(res, 404, { ok: false, error: 'no such task: ' + id }); return; }
        if (action === 'archive') {
          if (t.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能归档（等它结束）' }); return; }
          t.archived = true; t.archivedAt = new Date().toISOString();
        } else if (action === 'unarchive') {
          delete t.archived; t.archivedAt = null;
        } else if (action === 'retry') {
          /* 复制成一条新的待执行任务；定时任务保留「相对现在 +30 分钟」而不是原样照抄 runAt
           * —— 原时间早就过期了，照抄会立刻触发，用户会以为「重试=马上跑」。 */
          const copy = newTask({
            id: Date.now() + Math.random().toString(36).slice(2, 6),
            prompt: t.prompt, model: t.model || '',
            mode: t.mode === 'scheduled' ? 'scheduled' : 'idle',
            runAt: t.mode === 'scheduled' && t.runAt ? new Date(Date.now() + 30 * 60000).toISOString() : null,
            retryOf: t.id,
          });
          q.push(copy); saveQ(q);
          sendJson(res, 200, { ok: true, id: copy.id, runAt: copy.runAt, retryOf: t.id });
          return;
        } else if (action === 'cancel') {
          if (t.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能取消（请用「终止」）' }); return; }
          const keep = q.filter((x) => x.id !== id);
          saveQ(keep);
          sendJson(res, 200, { ok: true, removed: 1 });
          return;
        } else if (action === 'pause') {
          /* 任务暂停：只对「待执行」有意义 —— 暂停后执行器跳过它，恢复后照原样参与闲时/定时 */
          if (t.archived === true) { sendJson(res, 409, { ok: false, error: '已归档任务不能暂停（先取消归档）' }); return; }
          if (t.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能暂停（请用「终止」）' }); return; }
          if (t.status !== 'queued') { sendJson(res, 409, { ok: false, error: '只有「待执行」的任务可以暂停（当前状态：' + t.status + '）' }); return; }
          t.paused = true;
          t.pausedAt = new Date().toISOString();
          t.updatedAt = t.pausedAt;
          saveQ(q);
          sendJson(res, 200, { ok: true, id, paused: true, pausedAt: t.pausedAt });
          return;
        } else if (action === 'resume') {
          if (t.archived === true) { sendJson(res, 409, { ok: false, error: '已归档任务不能恢复（先取消归档）' }); return; }
          if (t.status !== 'queued') { sendJson(res, 409, { ok: false, error: '只有「待执行」的任务可以恢复（当前状态：' + t.status + '）' }); return; }
          t.paused = false;
          t.pausedAt = null;
          t.updatedAt = new Date().toISOString();
          saveQ(q);
          sendJson(res, 200, { ok: true, id, paused: false, runAt: t.runAt || null });
          return;
        } else if (action === 'terminate') {
          /* 任务终止：
           *  · 执行中 → 杀掉执行器拉起的 dsh 子进程，并标记「已终止」（保留记录，区别于「取消」= 直接删除）；
           *  · 待执行 → 直接标记「已终止」，执行器下一次调度会跳过它。 */
          if (t.archived === true) { sendJson(res, 409, { ok: false, error: '已归档任务不能终止（先取消归档）' }); return; }
          if (t.status !== 'running' && t.status !== 'queued') {
            sendJson(res, 409, { ok: false, error: '只有「待执行 / 执行中」的任务可以终止（当前状态：' + t.status + '）' });
            return;
          }
          const wasRunning = t.status === 'running';
          const kill = wasRunning ? killTaskProcess(t) : { ok: true, pid: null, error: null };
          t.terminateRequested = true;
          t.status = 'terminated';
          t.finishedAt = new Date().toISOString();
          t.updatedAt = t.finishedAt;
          t.error = wasRunning
            ? (kill.ok ? '已终止（手动终止执行进程）' : ('已终止：' + kill.error))
            : '已终止（未执行）';
          t.pid = null;
          delete t.pidStartedAt;
          saveQ(q);
          sendJson(res, 200, {
            ok: true, id, status: 'terminated', wasRunning,
            pid: kill.pid, killed: kill.ok === true && wasRunning,
            warning: kill.ok || !wasRunning ? null : kill.error,
          });
          return;
        } else if (action === 'set-time') {
          /* 调整执行时间：把待执行任务改成「定时 <runAt>」，或改回「闲时」。
           * 暂停状态不在这里自动解除 —— 面板会提示「仍处于暂停」，避免「改了时间却一直不跑」。 */
          if (t.archived === true) { sendJson(res, 409, { ok: false, error: '已归档任务不能调整执行时间（先取消归档）' }); return; }
          if (t.status !== 'queued') {
            sendJson(res, 409, { ok: false, error: '只有「待执行」的任务可以调整执行时间（当前状态：' + t.status + '；执行中的请先终止）' });
            return;
          }
          const wantMode = b.mode === 'idle' ? 'idle' : 'scheduled';
          let iso = null;
          let past = false;
          if (wantMode === 'scheduled') {
            const norm = normalizeRunAt(b.runAt != null ? b.runAt : t.runAt);
            if (!norm.ok) { sendJson(res, 400, { ok: false, error: norm.error }); return; }
            iso = norm.iso;
            past = norm.past === true;
          }
          t.mode = wantMode;
          t.runAt = iso;
          t.timeAdjustedAt = new Date().toISOString();
          t.updatedAt = t.timeAdjustedAt;
          saveQ(q);
          sendJson(res, 200, {
            ok: true, id, mode: t.mode, runAt: t.runAt, past, paused: t.paused === true,
            note: t.paused === true ? '该任务仍处于暂停，点「恢复」后才会执行' : null,
          });
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
      const t = newTask({ prompt, model, mode, runAt, paused: b.paused === true });
      if (t.paused === true) t.pausedAt = new Date().toISOString();
      q.push(t); saveQ(q);
      sendJson(res, 200, { ok: true, id: t.id, runAt, paused: t.paused === true });
      return;
    }
    if (method === 'DELETE') {
      const b = await body(req);
      const id = String((b && b.id) || '');
      let q = loadQ();
      const target = q.find((t) => t.id === id);
      if (target && target.status === 'running') { sendJson(res, 409, { ok: false, error: '执行中的任务不能删除（请先「终止」）' }); return; }
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
