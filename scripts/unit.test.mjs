/* dsh-idle-scheduler 单测：自诊断提示映射（纯函数）
 * 用法：node scripts/unit.test.mjs
 * 不依赖浏览器/dsh：用假的 __ModuleLoader__ + 假 react 把 client.js 加载进来，
 * 取 apply.__diagHintFor 逐类断言。 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const file = path.join(dir, '..', 'lib', 'client.js');
const code = fs.readFileSync(file, 'utf8');

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useCallback: (f) => f,
  useEffect: () => {},
  useSyncExternalStore: () => null,
};
let mod = null;
const fakeWindow = { __ModuleLoader__: { load: (m) => { mod = m.factory((n) => (n === 'react' ? fakeReact : null)); } } };
globalThis.window = fakeWindow;
/* Node ≥21 自带只读的 globalThis.navigator → 用 defineProperty 覆盖 */
try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true }); } catch (e) { /* 已有可写实现 */ }
try { globalThis.location = { origin: 'https://example.test' }; } catch (e) { /* 只读则忽略 */ }

new Function('window', code)(fakeWindow);   // 执行客户端半，触发 __ModuleLoader__.load

let failed = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : '  << ' + extra}`);
}

check('模块被加载且导出 apply/inject', mod && typeof mod.apply === 'function' && Array.isArray(mod.inject));
const hint = mod.apply.__diagHintFor;
check('导出自诊断纯函数', typeof hint === 'function');
if (typeof hint === 'function') {
  const c0 = hint(0, '请求超时（8 秒）', '');
  check('超时/网络错误 → 无法连接 + 建议检查服务', /无法连接/.test(c0.title) && /超时/.test(c0.title) && /systemctl/.test(c0.fix), JSON.stringify(c0));

  const cLb = hint(403, 'HTTP 403', '{"error":"forbidden: loopback-only"}');
  check('loopback-only 403 → 仅本机守卫 + Host 改写修复', /仅本机/.test(cLb.title) && /Host 127\.0\.0\.1:3080/.test(cLb.fix), JSON.stringify(cLb));

  const c401 = hint(401, 'HTTP 401', '');
  check('401 → 部署层鉴权 + auth_request 豁免', /鉴权/.test(c401.title) && /auth_request off/.test(c401.fix), JSON.stringify(c401));

  const c403 = hint(403, 'HTTP 403', '');
  check('403（非 loopback 文案）→ 仍归入鉴权拦截', /鉴权/.test(c403.title), JSON.stringify(c403));

  const c404 = hint(404, 'HTTP 404', '');
  check('404 → 插件未加载 + 重启面板', /404/.test(c404.title) && /重启面板/.test(c404.fix), JSON.stringify(c404));

  const c502 = hint(502, 'HTTP 502', '');
  check('502 → 服务端出错', /服务端出错/.test(c502.title), JSON.stringify(c502));

  const cWeird = hint(418, 'HTTP 418', '');
  check('未知状态 → 兜底文案仍含状态码', /418/.test(cWeird.title) && !!cWeird.cause && !!cWeird.fix, JSON.stringify(cWeird));

  const all = [c0, cLb, c401, c403, c404, c502, cWeird];
  check('每条提示都含 title/cause/fix 且无真实域名泄漏', all.every((h) => h.title && h.cause && h.fix && !/kevonchen|dsh\./.test(JSON.stringify(h))));
}

/* ---------- v1.2.0：定时时间纯函数（原生 datetime-local 换掉后的回归护栏）---------- */
const T = mod.apply.__time;
check('导出时间纯函数 __time', T && typeof T.parseLocalToIso === 'function' && typeof T.shiftLocal === 'function');
if (T) {
  check('composeLocal/splitLocal 往返一致',
    T.composeLocal('2026-09-18', '14', '05') === '2026-09-18T14:05'
    && JSON.stringify(T.splitLocal('2026-09-18T14:05')) === JSON.stringify({ date: '2026-09-18', hh: '14', mm: '05' }));
  check('composeLocal 拒绝残缺输入', T.composeLocal('', '14', '05') === '' && T.composeLocal('2026-09-18', '4', '05') === '');

  const NOW = new Date('2026-09-18T05:00:00Z').getTime();   // 固定「现在」，避免时区/时间漂移
  const ok = T.parseLocalToIso(T.shiftLocal(30, null, NOW), NOW);
  check('合法未来时间 → ok + ISO', ok.ok === true && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ok.iso), JSON.stringify(ok));
  check('空值 → 不可用（带原因）', T.parseLocalToIso('', NOW).ok === false && /选择/.test(T.parseLocalToIso('', NOW).reason));
  check('残缺值 → 不可用', T.parseLocalToIso('2026-09-18T14', NOW).ok === false);
  /* 旧版原生控件实际产出的垃圾值：必须被拦下（此前 new Date(x).toISOString() 抛 RangeError → 点击无反应） */
  const junk = T.parseLocalToIso('93300-01-09T14:20', NOW);
  check('原生控件垃圾值 93300-01-09T14:20 → 不可用且不抛异常', junk.ok === false && !!junk.reason, JSON.stringify(junk));
  const past = T.parseLocalToIso('2020-01-01T00:00', NOW);
  check('已过期时间 → 不可用（需晚于当前时间）', past.ok === false && /晚于/.test(past.reason), JSON.stringify(past));
  check('＋5/＋30/＋60 分钟平移正确',
    T.shiftLocal(5, '2026-09-18T23:58', NOW) === '2026-09-19T00:03'
    && T.shiftLocal(30, '2026-09-18T10:00', NOW) === '2026-09-18T10:30'
    && T.shiftLocal(60, '2026-09-18T23:30', NOW) === '2026-09-19T00:30');
  check('明天 09:00 一定是未来的一天',
    T.nextDayAt(9, 0, NOW) === '2026-09-19T09:00', T.nextDayAt(9, 0, NOW));
  check('时/分候选表齐全（24 / 60）', T.HOURS.length === 24 && T.MINUTES.length === 60 && T.HOURS[23] === '23' && T.MINUTES[59] === '59');
}

/* ---------- v1.3.0：队列状态/归档/删除纯函数 ---------- */
const QH = mod.apply.__queue;
check('导出队列纯函数 __queue', QH && typeof QH.summarize === 'function' && typeof QH.filterTasks === 'function');
if (QH) {
  const T = (id, status, extra) => Object.assign({ id, status, prompt: 'p' + id, mode: 'idle' }, extra || {});
  const list = [
    T('a', 'queued'), T('b', 'running'), T('c', 'done', { createdAt: '2026-09-18T01:00:00Z', finishedAt: '2026-09-18T01:00:45Z' }),
    T('d', 'failed', { error: 'boom' }), T('e', 'done', { archived: true }), T('f', 'failed', { archived: true }),
  ];
  const s = QH.summarize(list);
  check('summarize 统计齐备（active/archived 分离）',
    s.total === 6 && s.queued === 1 && s.running === 1 && s.done === 1 && s.failed === 1 && s.archived === 2 && s.active === 4, JSON.stringify(s));
  check('filterTasks: 默认/all 只给未归档', QH.filterTasks(list, 'all').length === 4 && QH.filterTasks(list).length === 4);
  check('filterTasks: 按状态筛选', QH.filterTasks(list, 'done').length === 1 && QH.filterTasks(list, 'failed').length === 1 && QH.filterTasks(list, 'queued').length === 1);
  check('filterTasks: archived 视图只给归档项', QH.filterTasks(list, 'archived').map((t) => t.id).join(',') === 'e,f');
  check('filterTasks: 空/异常输入不崩', QH.filterTasks(null, 'all').length === 0 && QH.filterTasks([undefined], 'done').length === 0);

  check('durationText: 秒/分/小时与缺值',
    QH.durationText({ createdAt: '2026-09-18T01:00:00Z', finishedAt: '2026-09-18T01:00:45Z' }) === '45 秒'
    && QH.durationText({ createdAt: '2026-09-18T01:00:00Z', finishedAt: '2026-09-18T01:05:30Z' }) === '5 分 30 秒'
    && QH.durationText({ createdAt: '2026-09-18T01:00:00Z', finishedAt: '2026-09-18T02:05:00Z' }) === '1 小时 5 分'
    && QH.durationText({ createdAt: '2026-09-18T01:00:00Z' }) === ''
    && QH.durationText(null) === '');

  const running = T('r', 'running'), queued = T('q', 'queued'), done = T('d', 'done'), failed = T('f', 'failed'), arch = T('x', 'done', { archived: true });
  check('执行中的任务：不可归档/删除/取消',
    QH.canArchive(running) === false && QH.canDelete(running) === false && QH.canCancel(running) === false, 'running');
  check('已完成/失败：可归档、可删除、可重试',
    QH.canArchive(done) && QH.canDelete(done) && QH.canRetry(done) && QH.canArchive(failed) && QH.canRetry(failed), 'done/failed');
  check('待执行：可取消、可归档、可删除、不可重试',
    QH.canCancel(queued) && QH.canArchive(queued) && QH.canDelete(queued) && QH.canRetry(queued) === false, 'queued');
  check('已归档项：可取消归档、不可重复归档、不可取消执行',
    QH.canUnarchive(arch) && QH.canArchive(arch) === false && QH.canCancel(arch) === false, 'archived');

  check('STATUS_META 五种状态都有 label/color/hint',
    ['queued', 'running', 'done', 'failed', 'canceled'].every((k) => QH.STATUS_META[k] && QH.STATUS_META[k].label && QH.STATUS_META[k].color && QH.STATUS_META[k].hint)
    && QH.statusMeta('done').label === '已完成' && QH.statusMeta('weird').label === 'weird');
  check('clip 截断加省略号且折叠空白', QH.clip('a  b\n\nc', 20) === 'a b c' && QH.clip('0123456789', 5).length === 5 && QH.clip('0123456789', 5).endsWith('…'));
  check('taskTimeText 优先定时时间、其次完成时间', QH.taskTimeText({ mode: 'scheduled', runAt: '2026-09-18T06:30:00.000Z', finishedAt: '2026-09-18T08:00:00Z' }) === '2026-09-18 06:30'
    && QH.taskTimeText({ mode: 'idle', createdAt: '2026-09-18T06:30:00Z', finishedAt: '2026-09-18T07:00:00Z' }) === '2026-09-18 07:00');
}

/* ---------- v1.4.0：队列开关 / 任务暂停·终止·调整执行时间 纯函数 ---------- */
if (QH) {
  const T = (id, status, extra) => Object.assign({ id, status, prompt: 'p' + id, mode: 'idle' }, extra || {});
  const paused = T('p', 'queued', { paused: true });
  const queued = T('q', 'queued');
  const running = T('r', 'running', { pid: 4242 });
  const terminated = T('t', 'terminated');
  const archQueued = T('aq', 'queued', { archived: true });

  check('STATUS_META 含「已终止」且可重试',
    !!(QH.STATUS_META.terminated && QH.STATUS_META.terminated.label === '已终止' && QH.STATUS_META.terminated.color)
    && QH.canRetry(terminated) === true && QH.canRetry(queued) === false, JSON.stringify(QH.STATUS_META.terminated));

  check('summarize 统计 terminated 与 paused',
    (() => { const s2 = QH.summarize([paused, queued, running, terminated]); return s2.terminated === 1 && s2.paused === 1 && s2.queued === 2 && s2.running === 1 && s2.active === 4; })());

  check('暂停/恢复权限：只有未归档的待执行任务',
    QH.canPauseTask(queued) && QH.canPauseTask(paused) === false && QH.canPauseTask(running) === false
    && QH.canPauseTask(archQueued) === false
    && QH.canResumeTask(paused) && QH.canResumeTask(queued) === false && QH.canResumeTask(archQueued) === false);

  check('调整执行时间权限：只有未归档的待执行任务',
    QH.canSetTime(queued) && QH.canSetTime(paused) && QH.canSetTime(running) === false && QH.canSetTime(archQueued) === false && QH.canSetTime(terminated) === false);

  check('终止权限：执行中才有「终止」按钮',
    QH.canTerminateTask(running) && QH.canTerminateTask(queued) === false && QH.canTerminateTask(archQueued) === false && QH.canTerminateTask(null) === false);

  check('filterTasks 支持 terminated 视图', QH.filterTasks([paused, terminated], 'terminated').map((t) => t.id).join(',') === 't');

  const st = QH.shortTime('2026-09-18T06:30:00.000Z');
  check('shortTime 输出「YYYY-MM-DD HH:MM」', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(st), st);
  check('shortTime 容错空值/垃圾值', QH.shortTime(null) === '—' && QH.shortTime('nope') === '—');

  const t1 = QH.queueSummaryText({ paused: false, pausedAt: null, reason: '' }, { paused: 2 });
  check('队列运行中文案带「被单独暂停」计数', /闲时窗口/.test(t1) && /2 个待执行任务被单独暂停/.test(t1), t1);
  const t2 = QH.queueSummaryText({ paused: true, pausedAt: '2026-09-18T06:30:00.000Z', reason: '维护' }, { paused: 0 });
  check('队列暂停文案含时间与原因', /不会被调度/.test(t2) && /维护/.test(t2) && /2026-09-18/.test(t2), t2);
  check('queueSummaryText 容错 null', typeof QH.queueSummaryText(null, null) === 'string' && QH.queueSummaryText(null, null).length > 0);
}

console.log(failed === 0 ? '\n✓ ALL PASS' : `\n✗ ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
