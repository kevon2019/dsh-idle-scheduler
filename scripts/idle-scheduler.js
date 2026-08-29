#!/usr/bin/env node
// dsh 闲时调度器 —— 任务队列 + 闲时批量执行 + 定时执行
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const DIR = path.dirname(__filename);
const { isIdleNow } = require(path.join(DIR, 'idle-logic.js'));
const QFILE = '/root/.dsh/idle-tasks.json';
const DSH = process.env.DSH || '/usr/local/bin/dsh';
const PROFILE = 'headless';

function loadQ() { try { return JSON.parse(fs.readFileSync(QFILE, 'utf8')); } catch { return []; } }
function saveQ(q) { fs.writeFileSync(QFILE, JSON.stringify(q, null, 2)); }
function add(prompt, model, mode, runAt) {
  const q = loadQ();
  const t = { id: Date.now() + Math.random().toString(36).slice(2, 6), prompt, model: model || '', mode: mode === 'scheduled' ? 'scheduled' : 'idle', runAt: runAt || null, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, tokens: null, error: null };
  q.push(t); saveQ(q);
  console.log('已加入任务队列:', t.id, '|', t.mode, '|', prompt.slice(0, 60));
  return t.id;
}
function list() {
  const q = loadQ();
  if (!q.length) { console.log('队列为空'); return; }
  console.log('队列任务:', q.length);
  q.forEach(t => console.log(`  [${t.status}] ${t.id} ${t.mode || 'idle'} ${t.runAt || ''} ${(t.prompt || '').slice(0, 50)} ${t.model ? '(' + t.model + ')' : ''}`));
}
function cancel(id) {
  const q = loadQ(); const i = q.findIndex(t => t.id === id);
  if (i < 0) { console.log('无此任务'); return; }
  const t = q[i];
  if (t.status === 'running') { console.log('运行中不可取消(请等完成或 kill)'); return; }
  q.splice(i, 1); saveQ(q); console.log('已取消:', id);
}
function runHeadless(prompt, model) {
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
  const r = spawnSync(DSH, args, { env, encoding: 'utf8', timeout: 600000, maxBuffer: 50 * 1024 * 1024 });
  if (patch) try { fs.unlinkSync(patch); } catch (e) {}
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function run(force) {
  const now = new Date();
  const q = loadQ();
  const due = q.filter(t => {
    if (t.status !== 'queued') return false;
    if (t.mode === 'scheduled') return t.runAt && new Date(t.runAt).getTime() <= now.getTime();
    return force || isIdleNow(now);
  });
  if (!force && !isIdleNow(now) && !due.some(t => t.mode === 'scheduled')) { console.log('当前非闲时,无到期定时任务,不执行(force 可跳过)'); return; }
  if (!due.length) { console.log('无待执行任务'); return; }
  for (const t of due) {
    t.status = 'running'; t.runAt = new Date().toISOString(); saveQ(q);
    console.log('执行:', t.id, '模式=' + (t.mode || 'idle'), '模型=' + (t.model || '(默认)'), '提示:', t.prompt.slice(0, 60));
    const r = runHeadless(t.prompt, t.model);
    if (r.ok) { t.status = 'done'; t.result = r.out.slice(0, 2000); t.tokens = null; }
    else { t.status = 'failed'; t.error = (r.err || r.out || '').slice(0, 500); }
    t.finishedAt = new Date().toISOString();
    console.log('  ->', t.status, t.error ? ('ERR:' + t.error.slice(0, 120)) : ('结果:' + (t.result || '').slice(0, 80)));
    saveQ(q);
  }
  console.log('批量执行完毕');
}
const cmd = process.argv[2];
if (cmd === 'add') add(process.argv[3], (process.argv[4] === '--model' ? process.argv[5] : ''), (process.argv[6] === '--mode' ? process.argv[7] : ''), (process.argv[8] === '--at' ? process.argv[9] : ''));
else if (cmd === 'list') list();
else if (cmd === 'cancel') cancel(process.argv[3]);
else if (cmd === 'run') run(process.argv[3] === '--force');
else console.log('用法: add "<prompt>" [--model X] [--mode idle|scheduled] [--at ISO] | list | cancel <id> | run [--force]');
