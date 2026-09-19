/* dsh-idle-scheduler 队列 API 单测（v1.4.0）：暂停 / 恢复 / 终止 / 调整执行时间
 *
 * 用法：node scripts/api.test.mjs
 *
 * 做法：把 IDLE_TASKS_FILE / IDLE_CONTROL_FILE 指到临时目录（绝不碰线上 ~/.dsh/idle-tasks.json），
 * 用假的 ctx.webServer 拿到路由 handler，再用假的 req/res 直接打接口。
 * 「终止执行中的任务」会真的 spawn 一个同名假 dsh 进程（脚本名就叫 dsh，cmdline 里含 dsh），
 * 断言它被 SIGTERM 杀掉；另用 `sleep` 进程验证「不是 dsh 就不杀」的保护分支。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-api-'));
process.env.IDLE_TASKS_FILE = path.join(tmp, 'idle-tasks.json');
process.env.IDLE_CONTROL_FILE = path.join(tmp, 'control.json');

const QFILE = process.env.IDLE_TASKS_FILE;
const CFILE = process.env.IDLE_CONTROL_FILE;

let failed = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  << ' + extra}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 加载 host 半，截获路由 handler ---------- */
const mod = await import('../lib/index.js');
let handler = null;
const ctx = { webServer: { register: (route) => { handler = route.handler; return () => {}; } } };
await mod.apply(ctx);
check('导出 apply/inject/name 且注册了路由 handler', typeof mod.apply === 'function' && mod.name === 'idle-scheduler' && typeof handler === 'function');

function call(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const req = new EventEmitter();
    req.method = method;
    req.url = '/api/idle-scheduler/tasks';
    req.headers = {};
    const res = {
      _status: 0, _text: '',
      writeHead(code) { this._status = code; },
      end(text) { this._text = String(text || ''); let body = {}; try { body = JSON.parse(this._text); } catch (e) { body = { __raw: this._text }; } resolve({ status: this._status, body }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
    setImmediate(() => {
      if (payload) req.emit('data', Buffer.from(payload));
      req.emit('end');
    });
  });
}
const readQ = () => JSON.parse(fs.readFileSync(QFILE, 'utf8'));
const writeQ = (q) => fs.writeFileSync(QFILE, JSON.stringify(q, null, 2));
const readC = () => JSON.parse(fs.readFileSync(CFILE, 'utf8'));
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

/* 假 dsh：脚本文件名就叫 dsh → cmdline 含 dsh，能通过终止前的身份校验 */
const fakeDsh = path.join(tmp, 'dsh');
fs.writeFileSync(fakeDsh, '#!/bin/sh\nsleep 45\n');
fs.chmodSync(fakeDsh, 0o755);
const spawnFake = () => spawn(fakeDsh, ['--profile', 'headless', 'fake-task'], { stdio: 'ignore' });

/* ---------- 1. 新建 + GET ---------- */
const created = await call('POST', { prompt: '测试任务 A', model: 'deepseek-v4-flash', mode: 'idle' });
check('新建闲时任务返回 ok+id', created.status === 200 && created.body.ok === true && !!created.body.id, JSON.stringify(created.body));
const id = created.body.id;
let got = await call('GET');
check('GET 返回 tasks/stats/queue（v1.4.0 契约）',
  got.status === 200 && Array.isArray(got.body.tasks) && got.body.tasks.length === 1
  && got.body.stats.queued === 1 && got.body.queue && got.body.queue.paused === false, JSON.stringify(got.body));
check('新任务默认 paused=false / 无 pid / 无 terminateRequested',
  got.body.tasks[0].paused === false && got.body.tasks[0].pid === null && got.body.tasks[0].terminateRequested === false, JSON.stringify(got.body.tasks[0]));

/* ---------- 2. 调整执行时间（定时 / 闲时互转）---------- */
const soon = new Date(Date.now() + 3600000).toISOString();
const setT = await call('POST', { action: 'set-time', id, mode: 'scheduled', runAt: soon });
check('调整执行时间 → 定时', setT.status === 200 && setT.body.ok === true && setT.body.mode === 'scheduled' && setT.body.runAt === soon && setT.body.past === false, JSON.stringify(setT.body));
check('调整后的执行时间已落盘', readQ()[0].mode === 'scheduled' && readQ()[0].runAt === soon && !!readQ()[0].timeAdjustedAt);
const setI = await call('POST', { action: 'set-time', id, mode: 'idle' });
check('调整执行时间 → 改回闲时（runAt 清空）', setI.status === 200 && setI.body.ok === true && setI.body.mode === 'idle' && setI.body.runAt === null, JSON.stringify(setI.body));
const badT = await call('POST', { action: 'set-time', id, mode: 'scheduled', runAt: '不是时间' });
check('调整执行时间：无法解析的时间 → 400', badT.status === 400 && badT.body.ok === false, JSON.stringify(badT.body));
const pastT = await call('POST', { action: 'set-time', id, mode: 'scheduled', runAt: '2020-01-01T00:00' });
check('调整执行时间：过去时间被接受但标记 past=true（= 下次调度立即执行）', pastT.status === 200 && pastT.body.past === true, JSON.stringify(pastT.body));

/* ---------- 3. 任务暂停 / 恢复 ---------- */
const p1 = await call('POST', { action: 'pause', id });
check('暂停待执行任务 → paused=true', p1.status === 200 && p1.body.ok === true && p1.body.paused === true, JSON.stringify(p1.body));
got = await call('GET');
check('暂停后 stats.paused=1 且任务带 pausedAt', got.body.stats.paused === 1 && !!got.body.tasks[0].pausedAt, JSON.stringify(got.body.stats));
const p2 = await call('POST', { action: 'pause', id });
check('重复暂停 → 幂等 200（仍为 paused=true）', p2.status === 200 && p2.body.paused === true, JSON.stringify(p2.body));
const r1 = await call('POST', { action: 'resume', id });
check('恢复任务 → paused=false', r1.status === 200 && r1.body.paused === false, JSON.stringify(r1.body));
const r2 = await call('POST', { action: 'resume', id });
check('重复恢复 → 幂等 200（仍为 paused=false）', r2.status === 200 && r2.body.paused === false, JSON.stringify(r2.body));

/* ---------- 4. 队列暂停 / 恢复 ---------- */
const pq = await call('POST', { action: 'pause-queue', reason: '测试暂停' });
check('暂停队列 → 开关文件 paused=true + 原因', pq.status === 200 && pq.body.queue.paused === true && readC().paused === true && readC().reason === '测试暂停', JSON.stringify(pq.body));
got = await call('GET');
check('GET 反映队列已暂停（执行器据此跳过）', got.body.queue.paused === true && !!got.body.queue.pausedAt, JSON.stringify(got.body.queue));
const rq = await call('POST', { action: 'resume-queue' });
check('恢复队列 → paused=false 且清空 pausedAt', rq.status === 200 && rq.body.queue.paused === false && readC().paused === false && readC().pausedAt === null, JSON.stringify(rq.body));

/* ---------- 5. 终止「执行中」任务（真杀进程）---------- */
const childA = spawnFake();
await sleep(250);
check('假 dsh 进程已启动（夹具自检）', childA.pid > 0 && pidAlive(childA.pid), 'pid=' + childA.pid);
writeQ([{ id: 'run-fake', prompt: '长任务 A', model: '', mode: 'idle', runAt: null, status: 'running',
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: childA.pid,
  pidStartedAt: new Date().toISOString(), terminateRequested: false, archived: false, paused: false }]);
const termA = await call('POST', { action: 'terminate', id: 'run-fake' });
check('终止执行中任务 → killed=true + status=terminated', termA.status === 200 && termA.body.killed === true && termA.body.status === 'terminated' && termA.body.wasRunning === true, JSON.stringify(termA.body));
await sleep(400);
check('执行进程确实已被杀掉', pidAlive(childA.pid) === false, 'pid=' + childA.pid);
check('终止结果落盘为 terminated 且 pid 已清空', readQ()[0].status === 'terminated' && readQ()[0].pid === null && !!readQ()[0].finishedAt, JSON.stringify(readQ()[0]));

/* ---------- 6. 保护分支：pid 不是 dsh 就不杀 ---------- */
const childS = spawn('sleep', ['45'], { stdio: 'ignore' });
await sleep(250);
writeQ([{ id: 'run-notdsh', prompt: '非 dsh 进程', mode: 'idle', status: 'running', createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(), pid: childS.pid, pidStartedAt: new Date().toISOString(), archived: false }]);
const termS = await call('POST', { action: 'terminate', id: 'run-notdsh' });
check('pid 不是 dsh → 拒绝终止并给出原因', termS.status === 200 && termS.body.killed === false && /不是 dsh/.test(String(termS.body.warning || '')), JSON.stringify(termS.body));
check('无关进程没有被误杀', pidAlive(childS.pid) === true, 'pid=' + childS.pid);
try { childS.kill('SIGKILL'); } catch (e) { /* 已退出 */ }

/* ---------- 7. 终止整条队列（暂停 + 杀掉所有执行中任务）---------- */
const childB = spawnFake();
await sleep(250);
writeQ([
  { id: 'q-run-1', prompt: '队列任务1', mode: 'idle', status: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: childB.pid, pidStartedAt: new Date().toISOString(), archived: false },
  { id: 'q-run-2', prompt: '队列任务2（无 pid）', mode: 'idle', status: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), pid: null, archived: false },
  { id: 'q-queued', prompt: '排队中，不该被终止', mode: 'idle', status: 'queued', createdAt: new Date().toISOString(), archived: false, paused: false },
]);
const tq = await call('POST', { action: 'terminate-queue' });
check('终止队列 → 暂停 + 影响 2 条执行中任务', tq.status === 200 && tq.body.queue.paused === true && tq.body.affected === 2 && readC().paused === true, JSON.stringify(tq.body));
await sleep(400);
check('队列终止真的有杀掉进程', pidAlive(childB.pid) === false, 'pid=' + childB.pid);
const qAfter = readQ();
check('两条执行中任务标记已终止（含无 pid 的给出原因）',
  qAfter.find((t) => t.id === 'q-run-1').status === 'terminated'
  && qAfter.find((t) => t.id === 'q-run-2').status === 'terminated'
  && /没有记录执行进程 PID/.test(String(qAfter.find((t) => t.id === 'q-run-2').error || '')), JSON.stringify(qAfter.map((t) => [t.id, t.status])));
check('排队中的任务不受「终止队列」影响', qAfter.find((t) => t.id === 'q-queued').status === 'queued');

/* ---------- 8. 执行状态自愈：running 但进程已不在 ---------- */
writeQ([{ id: 'stale', prompt: '假执行中', mode: 'idle', status: 'running', createdAt: new Date(Date.now() - 1200000).toISOString(),
  startedAt: new Date(Date.now() - 1200000).toISOString(), pid: 999999, pidStartedAt: new Date(Date.now() - 1200000).toISOString(), archived: false }]);
got = await call('GET');
check('GET 把「进程已消失的执行中任务」自愈为 failed', got.body.swept === 1 && got.body.tasks[0].status === 'failed' && /执行进程已不存在/.test(String(got.body.tasks[0].error || '')), JSON.stringify(got.body.tasks[0]));

/* ---------- 9. 非法状态下的操作一律 409，不静默放行 ---------- */
writeQ([{ id: 'done-1', prompt: '已完成', mode: 'idle', status: 'done', createdAt: new Date().toISOString(), archived: false }]);
check('已完成任务：暂停 → 409', (await call('POST', { action: 'pause', id: 'done-1' })).status === 409);
check('已完成任务：调整时间 → 409', (await call('POST', { action: 'set-time', id: 'done-1', mode: 'idle' })).status === 409);
check('已完成任务：终止 → 409', (await call('POST', { action: 'terminate', id: 'done-1' })).status === 409);
check('未知 action → 400', (await call('POST', { action: 'nonsense', id: 'done-1' })).status === 400);
check('未知 id → 404', (await call('POST', { action: 'pause', id: 'no-such' })).status === 404);

/* ---------- 10. 落盘卫生：原子写不留临时文件 ---------- */
const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
check('原子写没有留下 .tmp 残留文件', leftovers.length === 0, leftovers.join(','));
check('队列文件仍是合法 JSON 数组', Array.isArray(readQ()));

console.log(failed === 0 ? '\n✓ ALL PASS' : `\n✗ ${failed} FAILED`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
