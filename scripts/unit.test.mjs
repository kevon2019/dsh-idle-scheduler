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

console.log(failed === 0 ? '\n✓ ALL PASS' : `\n✗ ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
