# Changelog

## 1.4.0 (2026-09-19) — 队列/任务「暂停 · 终止」+ 调整执行时间（含真杀执行进程）

- **队列开关（新增）**：设置页「队列与执行状态」顶部一栏显示 `▶ 队列运行中` / `⏸ 队列已暂停`（带暂停时间与原因），
  三个按钮：
  - `暂停队列` → 写 `~/.dsh/idle-scheduler-control.json`，**cron 执行器不再取新任务**（已经在跑的那条不受影响）；
  - `恢复队列` → 待执行任务重新参与闲时/定时调度；
  - `终止队列` → 一键「停下来」：暂停队列 **+ 杀掉所有执行中任务的执行进程**（二次确认，与「删除」同一套防误触）。
- **单条任务暂停/恢复**：`暂停` 后执行器跳过它（行上出现 `⏸ 已暂停` 徽标），`恢复` 后照原样参与闲时/定时调度。
- **单条任务终止（真的杀进程）**：执行器从 `spawnSync` 改为 `spawn`，把 `child.pid` / `pidStartedAt` 写回队列；
  面板「终止」据此发 SIGTERM（3 秒后仍存活再 SIGKILL），任务落 `terminated`（保留记录，可「重试」）。
  杀之前核对身份：`/proc/<pid>/cmdline` 必须含 `dsh`，且进程启动时间不得早于本任务 —— 核对不过只标记状态
  并如实回显原因（实测用 `sleep` 冒充时正确拒杀，无关进程存活）。
- **调整执行时间**：待执行任务可 `保存并改为定时`（写入新的 `runAt`）或 `改为闲时执行`（清空 `runAt`）；
  过去时间被接受并标记 `past=true`（等价「下一次调度立即执行」）。
- **执行状态自愈**：`GET` 时把「running 但进程已不存在（且已过 60 秒落地窗口）」的任务标成 failed 并写明原因，
  执行器被杀/服务器重启后不会留下永远显示「执行中」的僵尸任务。
- **执行器（cron 侧）**：
  - 读队列开关（暂停就整轮跳过，日志写明原因；`run --force` 可强制跑一轮）；
  - 跳过 `paused` / `terminateRequested` 的任务并打印一行汇总（不刷屏、也不静默）；
  - 每执行一条前**从磁盘重读队列**，避免与面板写入打架；
  - 落盘改**原子写**（临时文件 + `rename`），与面板同时读写也不会写出半截 JSON（面板侧同步改造）；
  - 新增 CLI：`status` / `pause [原因]` / `resume` / `terminate <id>`。
- **服务端 API（仅新增，向后兼容）**：
  `POST {action:"pause-queue"|"resume-queue"|"terminate-queue"}`；
  `POST {action:"pause"|"resume"|"terminate"|"set-time", id, ...}`；
  `GET` 新增 `queue{paused,pausedAt,reason}`、`stats.terminated`、`stats.paused`、每条
  `paused/pausedAt/startedAt/pid/terminateRequested/updatedAt/timeAdjustedAt`、`swept`。
- **实测证据（2026-09-19，dsh 0.1.6-alpha.1 / 8765 面板 + 真实 Chromium 点击）**：
  - 单测：`node scripts/unit.test.mjs` 46 项全绿（新增暂停/终止/调整时间权限矩阵、队列文案、`terminated` 状态、
    `summarize` 的 `terminated/paused` 口径）；`node scripts/api.test.mjs` 35 项全绿（真 spawn 假 `dsh`
    进程验证 terminate 杀进程 + `sleep` 反例拒杀 + 终止队列 + 僵尸自愈 + 原子写无残留）；
    `node scripts/executor.test.mjs` 15 项全绿（队列暂停跳过、任务暂停跳过、正常执行落 done、
    执行中 terminate 真杀子进程并落 terminated、执行中暂停队列不影响在跑任务、CLI pause/resume/status）。
  - 真实浏览器（CDP 真鼠标点击）：27/27 通过、控制台 0 报错 —— 队列开关三按钮、任务行「暂停/调整时间」、
    时间选择器展开、保存为定时、改为闲时、终止队列二次确认 全部走通且服务端状态一致。
- 兼容性不变：dsh `0.1.6-alpha.1` 实测（面板设置分区渲染、队列 API、cron 执行器全链路）。

## 1.3.0 (2026-09-18) — 队列「归档 / 删除」按钮 + 执行状态展示

- **设置页新增「队列与执行状态」卡片**（原「队列」卡片重做）：
  - **状态徽标**：待执行（黄）/ 执行中（蓝）/ 已完成（绿）/ 失败（红）/ 已归档（灰），并给出状态含义说明；
  - **计数筛选**：`全部 / 待执行 / 执行中 / 已完成 / 失败 / 已归档` 一键切换，计数由服务端 `stats` 给出；
  - **每条任务显示**：模式（闲时 / 定时 + 到点时间）、模型、**耗时**、状态提示；成功的结果与失败的
    错误可「展开详情」查看（错误/结果全文，默认折叠）；
  - **归档 / 删除按钮**：`归档`（移出列表保留记录）、`取消归档`、`删除`（**二次确认**，第一次点变成
    「确认删除？」）、`重试`（把已完成/失败任务复制成一条新的待执行任务）、`取消`（待执行任务移出队列）；
  - **批量**：`归档全部已结束`、`清空已归档`、`刷新`。
- **安全边界**：执行中（running）的任务**不可归档/删除/取消**——前端不显示对应按钮，服务端同样拒绝
  并返回原因（`409 执行中的任务不能归档/删除`），避免误删正在跑的任务。
- **服务端 API（向后兼容，仅新增）**：
  - `GET /api/idle-scheduler/tasks` 现在附带 `stats`（total/active/queued/running/done/failed/archived）
    与每条任务的 `archived` / `archivedAt` / `durationMs`；
  - `POST` 支持 `{action:"archive"|"unarchive"|"retry"|"cancel", id}` 与批量
    `{action:"archive-done"}`、`{action:"clear-archived"}`（无 `action` 时仍是原来的新建任务语义）；
  - `DELETE` 拒绝删除执行中的任务（409）。
- **单测 21 → 33 项**：`summarize` 统计口径、`filterTasks` 各视图（含归档视图）、`durationText` 秒/分/小时、
  各状态下 `canArchive/canDelete/canRetry/canCancel/canUnarchive` 权限矩阵、状态文案兜底。
- 兼容性不变：dsh `0.1.6-alpha.1` 实测（面板设置分区渲染、队列 API、cron 执行器全链路）。

## 1.2.0 (2026-09-18) — 修复「定时不能选时分」+ 适配 dsh 0.1.6-alpha.1

- **修复「不能选择/输入时分」（用户报障，已在真实浏览器中复现定位）**：
  旧版用原生 `<input type="datetime-local">`。在面板的窄输入框里用键盘录入时/分时，数字会落进
  「年」段且 `value` 始终为空（`validity.badInput = true`），继续输入会得到荒谬值
  （实测产出 `93300-01-09T14:20`）；随后旧代码 `new Date(runAt).toISOString()` 抛
  `RangeError: Invalid time value` → **点「入队」完全没反应**（不入队、无提示、无报错）。
  实测证据（Chromium + CDP 真实鼠标/键盘事件）：在输入框 9 个横向位置分别点击后输入 `1230`，
  value 全部保持为空；输入完整 12 位数字后 value 变成「年 = 93300」的垃圾值；
  用该值点「入队」→ 队列数 2 → 2、页面无任何文案。
- **改为「日期 + 时/分下拉」选择器**（设置页与输入框工具栏共用同一组件）：
  - 时 `00–23`、分 `00–59` 两个原生下拉，纯鼠标/键盘可选，任何浏览器与语言环境下都确定可用；
  - 快捷时间：**＋5 分钟 / ＋30 分钟 / ＋1 小时 / 明天 09:00**；
  - 点开「定时」即预置「30 分钟后」的合法时间，直接点入队即可；
  - 实时回显「将于 YYYY-MM-DD HH:MM 执行」；时间残缺/无效/已过期时直接显示原因。
- **提交前校验，绝不静默失败**：新增纯函数 `parseLocalToIso()`（残缺 / 无法解析 / 年份越界 /
  已过期 → 返回原因文案，永不抛异常），面板与服务端 `POST` 双侧校验 `runAt`
  （服务端无法解析直接 `400`）；入队成功与失败都给出可见文案。
- **适配并实测 dsh 0.1.6-alpha.1**：`conversation.input.left` 的草稿读取
  （`useInput(s => s).draft`）与清空（`inputActions.setDraft("")`）实测可用；额外兼容
  `hooks.useInput` 包装写法与 ≤0.1.1 的 `input.draft` 对象写法，三种契约都不再静默失效。
  `GET /api/idle-scheduler/tasks` 现在附带 `plugin.version`，便于核对实际加载版本。
- 单测从 10 项扩到 **21 项**（新增时间纯函数与「原生控件垃圾值」回归护栏）：
  `node scripts/unit.test.mjs`。

## 1.1.2 (2026-09-10) — 队列接口失败不再静默：自诊断兜底

- **修复「接口挂了却显示『队列为空』」的误导**：此前 `refresh()` 把所有错误 `.catch(() => {})` 吞掉，
  接口 401/403/404/5xx/网络错误时页面只显示「队列为空」，用户无从判断是「没有任务」还是「接口坏了」。
- 现在 **8 秒超时**（AbortController）+ 状态码分类 → 页面上直接给出**诊断块**：
  接口地址 / 状态 / 可能原因 / 修复方向 / 「重试」/「复制诊断信息」；队列卡片改为「队列不可用（见上方诊断）」。
  分类覆盖：`loopback-only` 403（反代未改写 Host → `proxy_set_header Host 127.0.0.1:3080`）、
  401/403（部署层 `auth_request` 未豁免该路径）、404（插件未加载 → 重启面板）、5xx（面板服务异常）、
  超时/网络错误（面板进程重启中）。
- 输入框工具栏的「闲时 / 定时」按钮失败时也会显示 HTTP 状态并指向该诊断（不再只报 `TypeError`）。
- **新增 `scripts/unit.test.mjs`**（10 项断言，`node scripts/unit.test.mjs`）：用假的 `__ModuleLoader__`
  把 client 半加载进来，逐类断言诊断文案（超时/loopback-only/401/403/404/5xx/未知），并检查无真实域名泄漏。
- **配色改为 `inherit` / `opacity`**（不写死主题色）：浅色或深色主题下面板都保持正文级对比度，
  不会出现"提示看起来像被禁用"。
- 实测：域名下正常路径**无回归**（表单与队列 200 渲染、0 个 4xx/5xx）；把接口指向不存在路径模拟 404 时，
  诊断块按预期出现（404 提示 + 重试 + 复制诊断信息），队列卡片显示「队列不可用」。

## 1.1.1 (2026-09-10) — 适配 dsh 0.1.5-rc.1 的输入框 slot 新契约

- **修复「闲时 / 定时」按钮静默失效**：0.1.5 的 `conversation.input.left` slot 改为向组件传 hooks（`useInput` / `inputActions` / `sessionId` …），不再传 `{ input, inputActions }` 对象。插件仍在读 `input.draft` → 点击按钮无任何反应。
- 现按 props 形状在入口组件分流：新核心走 `useInput(s => s).draft` 读草稿、`inputActions.setDraft("")` 清空；旧核心继续走 `input.draft`（保持向后兼容，且各自组件内无条件调用 hook，符合 hooks 规则）。
- 输入框为空时按钮给出「输入框为空」提示（此前静默 return，用户无从判断）。
- **实测（0.1.5-rc.1）**：面板「闲时」「定时」按钮入队 → 队列 API（GET/POST/DELETE）→ cron 执行器 `dsh --profile headless` 真跑出结果（idle: done「好的」；scheduled 到点: done「定时OK」）。

## 1.1.0 (2026-09-02) — 确认 DSH alpha.3 兼容

- host 侧无 `@deepseek-ai` 核心 API 依赖（仅 `ctx.webServer.register`），client 侧使用保留的 `settings.section` slot —— 已确认兼容 alpha.3 核心。
- 目标核心：`@deepseek-ai/dsh >= 0.1.2-alpha.1`。

## 1.0.4 — 2026-08-29

- 闲时/定时任务编排：queued/scheduled 任务、runAt 定时、结果回传。
