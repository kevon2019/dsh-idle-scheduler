/* dsh-idle-scheduler 执行器（cron 侧）端到端单测 v1.4.0
 *
 * 用法：node scripts/executor.test.mjs
 *
 * 为什么单独测执行器：它是**独立于插件的 cron 进程**，队列开关（暂停队列 / 暂停任务 / 终止）
 * 真正生效点在它身上 —— 面板只写文件。这里用一个「假 dsh」脚本冒充 `dsh --profile headless`，
 * 在临时目录里真跑 run / terminate，断言：
 *   1. 队列开关 paused=true → run 不执行任何任务；
 *   2. 任务 paused=true → run 跳过它；
 *   3. 正常执行 → done + 结果落盘，执行期间 pid 被登记、结束后清空；
 *   4. 执行中 terminate → 真杀掉子进程，任务落 terminated（不是 done/failed）；
 *   5. 执行中暂停队列 → 不影响已经在跑的那条（它照常跑完）。
 * 全程使用临时 IDLE_TASKS_FILE / IDLE_CONTROL_FILE，绝不碰线上队列。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-exec-'));
for (const f of ['idle-scheduler.js', 'idle-logic.js', '2026-holidays.json']) {
  fs.copyFileSync(path.join(here, f), path.join(tmp, f));
}
/* 临时目录里没有 package.json → node 按 CommonJS 执行 idle-scheduler.js（线上 /root/.dsh/idle-scheduler 也是这种环境） */
const runner = path.join(tmp, 'idle-scheduler.js');
const QFILE = path.join(tmp, 'idle-tasks.json');
const CFILE = path.join(tmp, 'control.json');

const fakeDsh = path.join(tmp, 'dsh');
const writeFakeDsh = (body) => { fs.writeFileSync(fakeDsh, '#!/bin/sh\n' + body + '\n'); fs.chmodSync(fakeDsh, 0o755); };
writeFakeDsh('echo FAKE-DSH-RESULT; exit 0');

let failed = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  << ' + extra}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readQ = () => JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const writeQ = (q) => fs.writeFileSync(QFILE, JSON.stringify(q, null, 2));
const readC = () => { try { return JSON.parse(fs.readFileSync(CFILE, 'utf8')); } catch { return {}; } };
const writeC = (c) => fs.writeFileSync(CFILE, JSON.stringify(c, null, 2));
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const env = () => ({ ...process.env, IDLE_TASKS_FILE: QFILE, IDLE_CONTROL_FILE: CFILE, DSH: fakeDsh });
const runSync = (args) => spawnSync('node', [runner, ...args], { env: env(), encoding: 'utf8' });
const task = (id, extra) => Object.assign({
  id, prompt: '任务 ' + id, model: '', mode: 'idle', runAt: null, status: 'queued',
  createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null, archived: false,
  paused: false, pausedAt: null, startedAt: null, pid: null, pidStartedAt: null, terminateRequested: false,
}, extra || {});
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80); }
  return false;
}

/* ---------- 1. 队列暂停：run 不执行 ---------- */
writeQ([task('a')]);
writeC({ paused: true, pausedAt: new Date().toISOString(), reason: '单测暂停' });
let r = runSync(['run']);
check('队列 paused=true → run 直接跳过且说明原因',
  /队列已暂停/.test(r.stdout) && /单测暂停/.test(r.stdout) && readQ()[0].status === 'queued', JSON.stringify(r.stdout.slice(0, 200)));
check('暂停期间任务保持待执行（不误标失败）', readQ()[0].status === 'queued');

/* ---------- 2. 单条任务暂停：run 跳过它 ---------- */
writeQ([task('b', { paused: true, pausedAt: new Date().toISOString() }), task('c')]);
writeC({ paused: false });
r = runSync(['run', '--force']);
check('任务 paused=true → 被跳过并留汇总日志', /跳过：被面板暂停 1 条/.test(r.stdout), JSON.stringify(r.stdout.slice(0, 300)));
check('跳过的任务仍是待执行，另一条已执行完', readQ().find((t) => t.id === 'b').status === 'queued' && readQ().find((t) => t.id === 'c').status === 'done', JSON.stringify(readQ().map((t) => [t.id, t.status])));

/* ---------- 3. 正常执行：done + 结果 + pid 登记/清理 ---------- */
writeQ([task('d')]);
writeC({ paused: false });
r = runSync(['run', '--force']);
const td = readQ().find((t) => t.id === 'd');
check('正常执行 → done 且结果落盘', td.status === 'done' && /FAKE-DSH-RESULT/.test(String(td.result)), JSON.stringify([td.status, td.result]));
check('执行结束后 pid / pidStartedAt 已清空、finishedAt 已写', td.pid === null && !td.pidStartedAt && !!td.finishedAt, JSON.stringify(td));

/* ---------- 4. 执行中终止：真杀进程 + 落 terminated ---------- */
writeFakeDsh('sleep 30\necho SLOW-DONE');
writeQ([task('e')]);
writeC({ paused: false });
const bg = spawn('node', [runner, 'run', '--force'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
let bgOut = '';
bg.stdout.on('data', (d) => { bgOut += d; });
const bgDone = new Promise((resolve) => bg.on('close', (code) => resolve(code)));
const gotPid = await waitFor(() => { const t = readQ().find((x) => x.id === 'e'); return !!(t && t.pid); }, 8000);
const runningPid = gotPid ? readQ().find((x) => x.id === 'e').pid : null;
check('执行中的任务把 child.pid 写回队列（面板才能终止）', gotPid && pidAlive(runningPid), 'pid=' + runningPid);
const t1 = runSync(['terminate', 'e']);
check('CLI terminate → 报告已终止', /已终止/.test(t1.stdout), JSON.stringify(t1.stdout.slice(0, 200)));
await waitFor(() => !pidAlive(runningPid), 5000);
check('执行子进程被真的杀掉', pidAlive(runningPid) === false, 'pid=' + runningPid);
await bgDone;
const te = readQ().find((x) => x.id === 'e');
check('执行器收尾把任务落成 terminated（不是 done/failed）',
  te.status === 'terminated' && !/SLOW-DONE/.test(String(te.result || '')), JSON.stringify([te.status, te.error]));
check('执行器日志记录了 pid 登记', /已登记/.test(bgOut), bgOut.slice(-300));

/* ---------- 5. 执行中暂停队列：不影响已经在跑的任务 ---------- */
writeFakeDsh('sleep 3\necho PAUSEMID-DONE');
writeQ([task('f')]);
writeC({ paused: false });
const bg2 = spawn('node', [runner, 'run', '--force'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
const bg2Done = new Promise((resolve) => bg2.on('close', (code) => resolve(code)));
await waitFor(() => { const t = readQ().find((x) => x.id === 'f'); return !!(t && t.pid); }, 8000);
writeC({ paused: true, pausedAt: new Date().toISOString(), reason: '执行中暂停' });
await bg2Done;
const tf = readQ().find((x) => x.id === 'f');
check('执行中暂停队列 → 已在跑的任务照常跑完（done）', tf.status === 'done' && /PAUSEMID-DONE/.test(String(tf.result)), JSON.stringify([tf.status, tf.result]));

/* ---------- 6. 队列开关 CLI（pause / resume / status）---------- */
fs.unlinkSync(CFILE);
r = runSync(['pause', '单测']);
check('CLI pause 写开关文件', /已暂停/.test(r.stdout) && readC().paused === true && readC().reason === '单测', JSON.stringify(readC()));
r = runSync(['resume']);
check('CLI resume 清开关', /已恢复/.test(r.stdout) && readC().paused === false, JSON.stringify(readC()));
writeC({ paused: true });
r = runSync(['status']);
check('CLI status 显示队列开关与统计', /队列开关: 已暂停/.test(r.stdout) && /任务统计/.test(r.stdout), JSON.stringify(r.stdout.slice(0, 200)));

console.log(failed === 0 ? '\n✓ ALL PASS' : `\n✗ ${failed} FAILED`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
