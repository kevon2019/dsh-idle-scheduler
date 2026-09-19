#!/usr/bin/env node
// dsh 闲时调度器 —— 任务队列 + 闲时批量执行 + 定时执行
//
// [v1.4.0] 与面板「队列与执行状态」联动：
//   · 队列开关（暂停/恢复/终止）读 ~/.dsh/idle-scheduler-control.json —— 与面板共用、
//     独立于队列文件（队列文件是数组，塞开关会打断老版本解析）；
//   · 待执行任务可被面板标记 paused / terminateRequested，执行器一律跳过；
//   · 每条任务在执行时把 child.pid 写回队列，面板据此真的终止执行中的 dsh 子进程；
//   · 落盘统一「临时文件 + rename」原子写，避免与面板同时读写把 idle-tasks.json 写坏。
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const DIR = path.dirname(__filename);
const { isIdleNow } = require(path.join(DIR, 'idle-logic.js'));
const QFILE = process.env.IDLE_TASKS_FILE || '/root/.dsh/idle-tasks.json';
const CFILE = process.env.IDLE_CONTROL_FILE || '/root/.dsh/idle-scheduler-control.json';
const DSH = process.env.DSH || '/usr/local/bin/dsh';
const PROFILE = 'headless';
const RUN_TIMEOUT_MS = 600000;
const MAX_CAPTURE = 50 * 1024 * 1024;

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
function loadCtl() {
  try {
    const c = JSON.parse(fs.readFileSync(CFILE, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}
function saveCtl(c) { writeJsonAtomic(CFILE, c); }
function newTask(fields) {
  return Object.assign({
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    prompt: '', model: '', mode: 'idle', runAt: null,
    status: 'queued', createdAt: new Date().toISOString(), finishedAt: null,
    result: null, tokens: null, error: null, archived: false,
    paused: false, pausedAt: null, startedAt: null, pid: null, pidStartedAt: null,
    terminateRequested: false,
  }, fields || {});
}
function add(prompt, model, mode, runAt) {
  const q = loadQ();
  const t = newTask({ prompt, model: model || '', mode: mode === 'scheduled' ? 'scheduled' : 'idle', runAt: runAt || null });
  q.push(t); saveQ(q);
  console.log('已加入任务队列:', t.id, '|', t.mode, '|', String(prompt || '').slice(0, 60));
  return t.id;
}
function list() {
  const q = loadQ();
  if (!q.length) { console.log('队列为空'); return; }
  console.log('队列任务:', q.length, '| 队列开关:', loadCtl().paused === true ? '已暂停' : '运行中');
  q.forEach(t => console.log(`  [${t.status}${t.paused === true ? '/暂停' : ''}] ${t.id} ${t.mode || 'idle'} ${t.runAt || ''} ${String(t.prompt || '').slice(0, 50)} ${t.model ? '(' + t.model + ')' : ''}`));
}
function cancel(id) {
  const q = loadQ(); const i = q.findIndex(t => t.id === id);
  if (i < 0) { console.log('无此任务'); return; }
  const t = q[i];
  if (t.status === 'running') { console.log('运行中不可取消(请用 terminate 终止)'); return; }
  q.splice(i, 1); saveQ(q); console.log('已取消:', id);
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
/* 终止一条任务（CLI 用；面板走 lib/index.js 的同一套逻辑） */
function terminateTask(id) {
  const q = loadQ();
  const t = q.find(x => x && x.id === id);
  if (!t) { console.log('无此任务:', id); return; }
  if (t.status !== 'running' && t.status !== 'queued') { console.log('只有待执行/执行中的任务可终止(当前:', t.status + ')'); return; }
  const wasRunning = t.status === 'running';
  let killed = false;
  if (wasRunning && pidAlive(t.pid)) {
    try { process.kill(Number(t.pid), 'SIGTERM'); killed = true; } catch (e) { console.log('终止信号发送失败:', e.message); }
  }
  t.terminateRequested = true;
  t.status = 'terminated';
  t.finishedAt = new Date().toISOString();
  t.error = wasRunning ? (killed ? '已终止（CLI terminate）' : '已终止（未找到执行进程）') : '已终止（未执行）';
  t.pid = null;
  delete t.pidStartedAt;
  saveQ(q);
  console.log('已终止:', id, wasRunning ? (killed ? '(已杀进程)' : '(进程不存在)') : '(未执行)');
}
function pauseQueue(reason) {
  const c = loadCtl();
  c.paused = true;
  c.pausedAt = c.pausedAt || new Date().toISOString();
  c.reason = String(reason || 'CLI 暂停').slice(0, 200);
  c.updatedAt = new Date().toISOString();
  saveCtl(c);
  console.log('队列已暂停（cron 下次调度起不再执行任务；run --force 可强制跑一轮）');
}
function resumeQueue() {
  const c = loadCtl();
  c.paused = false; c.pausedAt = null; c.reason = '';
  c.updatedAt = new Date().toISOString();
  saveCtl(c);
  console.log('队列已恢复');
}
function status() {
  const q = loadQ();
  const c = loadCtl();
  const s = { total: q.length, queued: 0, running: 0, done: 0, failed: 0, terminated: 0, paused: 0, archived: 0 };
  for (const t of q) {
    if (!t) continue;
    if (t.archived === true) { s.archived += 1; continue; }
    if (Object.prototype.hasOwnProperty.call(s, t.status)) s[t.status] += 1;
    if (t.status === 'queued' && t.paused === true) s.paused += 1;
  }
  console.log('队列开关:', c.paused === true ? ('已暂停' + (c.pausedAt ? '（自 ' + c.pausedAt + '）' : '') + (c.reason ? ' 原因：' + c.reason : '')) : '运行中');
  console.log('任务统计:', JSON.stringify(s));
  for (const t of q) {
    if (!t || t.status !== 'running') continue;
    console.log('  执行中:', t.id, 'pid=' + (t.pid || '?'), 'pidAlive=' + (pidAlive(t.pid) ? 'yes' : 'no'), '|', String(t.prompt || '').slice(0, 50));
  }
}
/* [v1.4.0] spawn（不是 spawnSync）：必须拿到 child.pid 写回队列，面板才能真的终止执行中的任务。
 * 其余语义与旧版一致：10 分钟超时、kejilion.env 注入凭据、PATH 补 node（cron 精简 PATH 坑）。 */
function runHeadless(prompt, model, onSpawn) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { HOME: '/root', DSH_HOME: '/root/.dsh', DSH_TELEMETRY_DISABLED: '1' });
    /* dsh 的 shebang 是 #!/usr/bin/env node。cron 精简 PATH (常为 /usr/bin:/bin) 里没有 node，
     * 直接 spawn dsh 会报 "env: 'node': No such file or directory"，任务全部失败。补上 node 所在目录。 */
    env.PATH = '/usr/local/bin:/root/.hermes/node/bin:' + (env.PATH || '/usr/bin:/bin');
    try {
      const l = fs.readFileSync('/root/.dsh/kejilion.env', 'utf8');
      l.split('\n').forEach(x => { const m = x.match(/^([A-Z_]+)=(.*)$/); if (m && !env[m[1]]) env[m[1]] = m[2].trim(); });
    } catch (e) {}
    const args = ['--profile', PROFILE];
    let patch = null;
    if (model) {
      patch = path.join(DIR, '.patch-' + Date.now() + Math.random().toString(36).slice(2, 6) + '.yml');
      fs.writeFileSync(patch, `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${model}\n`);
      args.push('--patch', patch);
    }
    args.push(prompt);
    let child;
    try {
      child = spawn(DSH, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (patch) { try { fs.unlinkSync(patch); } catch (x) {} }
      resolve({ ok: false, out: '', err: String((e && e.message) || e), killed: false, signal: null, code: null });
      return;
    }
    if (typeof onSpawn === 'function') { try { onSpawn(child.pid); } catch (e) {} }
    let out = '', err = '', settled = false, timedOut = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (patch) { try { fs.unlinkSync(patch); } catch (e) {} }
      resolve(res);
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) {} }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_CAPTURE) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_CAPTURE) err += d; });
    child.on('error', (e) => finish({ ok: false, out: out.trim(), err: (err + String((e && e.message) || e)).trim(), killed: false, signal: null, code: null }));
    child.on('close', (code, signal) => finish({ ok: code === 0 && !timedOut, out: out.trim(), err: err.trim(), killed: timedOut, code, signal: signal || null }));
  });
}
async function run(force) {
  const now = new Date();
  const ctl = loadCtl();
  if (ctl.paused === true && !force) {
    console.log('队列已暂停' + (ctl.pausedAt ? '（自 ' + ctl.pausedAt + '）' : '') + (ctl.reason ? ' 原因：' + ctl.reason : '') + '，本轮不执行（run --force 可强制跑一轮）');
    return;
  }
  let q = loadQ();
  const due = q.filter(t => {
    if (!t || t.status !== 'queued') return false;
    if (t.paused === true) return false;
    if (t.terminateRequested === true) return false;
    if (t.mode === 'scheduled') return t.runAt && new Date(t.runAt).getTime() <= now.getTime();
    return force || isIdleNow(now);
  });
  if (!force && !isIdleNow(now) && !due.some(t => t.mode === 'scheduled')) { console.log('当前非闲时,无到期定时任务,不执行(force 可跳过)'); return; }
  /* 被面板暂停 / 标记终止的待执行任务不会进 due —— 但那不能是「静默」的：
   * 每个整点 5 分钟一轮，这里只汇总一行，既不刷屏又能解释「为什么任务没跑」。 */
  const pausedN = q.filter(t => t && t.status === 'queued' && t.paused === true).length;
  const termN = q.filter(t => t && t.status === 'queued' && t.terminateRequested === true).length;
  if (pausedN > 0 || termN > 0) {
    console.log('跳过：被面板暂停 ' + pausedN + ' 条' + (termN ? '，待终止 ' + termN + ' 条' : '') + '（在面板「队列与执行状态」里恢复）');
  }
  if (!due.length) { console.log('无待执行任务'); return; }
  for (const item of due) {
    q = loadQ();   // 每轮重读：面板可能刚把它暂停/终止/改了执行时间
    const t = q.find(x => x && x.id === item.id);
    if (!t) { console.log('跳过（任务已被面板移除）:', item.id); continue; }
    if (t.status !== 'queued' || t.paused === true || t.terminateRequested === true) {
      console.log('跳过（已被面板暂停/终止）:', item.id, 'status=' + t.status, 'paused=' + (t.paused === true));
      continue;
    }
    t.status = 'running';
    t.startedAt = new Date().toISOString();
    t.pid = null;
    t.pidStartedAt = null;
    t.terminateRequested = false;
    saveQ(q);
    console.log('执行:', t.id, '模式=' + (t.mode || 'idle'), '模型=' + (t.model || '(默认)'), '提示:', String(t.prompt || '').slice(0, 60));
    const r = await runHeadless(t.prompt, t.model, (pid) => {
      const q2 = loadQ();
      const t2 = q2.find(x => x && x.id === t.id);
      if (t2 && t2.status === 'running') {
        t2.pid = pid;
        t2.pidStartedAt = new Date().toISOString();
        saveQ(q2);
        console.log('  pid=' + pid + ' 已登记（可在面板「终止」该任务）');
      }
    });
    const q3 = loadQ();
    const t3 = q3.find(x => x && x.id === t.id);
    if (!t3) { console.log('任务已被面板移除，结果丢弃:', t.id); continue; }
    if (t3.terminateRequested === true) { t3.status = 'terminated'; t3.error = '已终止（面板手动终止）'; }
    else if (r.killed) { t3.status = 'failed'; t3.error = '执行超时（>' + Math.round(RUN_TIMEOUT_MS / 60000) + ' 分钟）被终止'; }
    else if (r.signal) { t3.status = 'terminated'; t3.error = '执行进程被外部信号终止（' + r.signal + '）'; }
    else if (r.ok) { t3.status = 'done'; t3.result = r.out.slice(0, 2000); t3.tokens = null; t3.error = null; }
    else { t3.status = 'failed'; t3.error = (r.err || r.out || '').slice(0, 500); }
    t3.finishedAt = new Date().toISOString();
    t3.pid = null;
    delete t3.pidStartedAt;
    console.log('  ->', t3.status, t3.error ? ('ERR:' + String(t3.error).slice(0, 120)) : ('结果:' + String(t3.result || '').slice(0, 80)));
    saveQ(q3);
  }
  console.log('批量执行完毕');
}
const cmd = process.argv[2];
if (cmd === 'add') add(process.argv[3], (process.argv[4] === '--model' ? process.argv[5] : ''), (process.argv[6] === '--mode' ? process.argv[7] : ''), (process.argv[8] === '--at' ? process.argv[9] : ''));
else if (cmd === 'list') list();
else if (cmd === 'cancel') cancel(process.argv[3]);
else if (cmd === 'terminate') terminateTask(process.argv[3]);
else if (cmd === 'pause') pauseQueue(process.argv.slice(3).join(' '));
else if (cmd === 'resume') resumeQueue();
else if (cmd === 'status') status();
else if (cmd === 'run') run(process.argv[3] === '--force').catch((e) => { console.error('执行器异常:', (e && e.stack) || e); process.exitCode = 1; });
else console.log('用法: add "<prompt>" [--model X] [--mode idle|scheduled] [--at ISO] | list | cancel <id> | terminate <id> | pause [原因] | resume | status | run [--force]');
