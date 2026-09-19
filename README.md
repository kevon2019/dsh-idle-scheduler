# dsh-idle-scheduler

deepseek-harness (dsh) 面板的**闲时任务调度**插件：把任务排队，在非高峰时段批量执行，并支持按任务选择模型。

- 任务队列：把待办任务排队，按配置的策略执行
- 闲时窗口：避开高峰（支持节假日/工作日等时间窗口）统一起跑
- 每任务模型选择：不同任务可指定不同模型
- 侧边栏提供「**闲时 / 定时**」按钮，一键投入队列

## 安装（DSH 一键命令）

在 dsh 面板所在的机器上，进入任意 dsh profile 后执行：

```bash
dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler
```

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler#v1.3.0`
> （GitHub 依赖用 `#` 指定 tag/分支，**不是** npm 的 `@版本`）
> 安装后重启面板服务即可生效：`systemctl restart deepseek-harness.service`

## 配置

打开 dsh 面板 → **设置 → 闲时任务**：

- 启用/停用任务调度
- 设定闲时时间窗口与批量执行策略
- 为任务指定默认模型

侧边栏的「闲时 / 定时」按钮用于把当前/后台任务快速投入调度队列。

## 执行器（cron）—— 真正的「跑起来」

本插件只负责**队列与设置界面**，任务的**实际执行**由随包附带的执行器脚本
`scripts/idle-scheduler.js` 完成（+ `scripts/idle-logic.js` 闲时判定 + `scripts/2026-holidays.json` 节假日配置）。
它与插件共用同一个队列文件（`/root/.dsh/idle-tasks.json`）。**必须**用 cron（或 systemd timer）定期调用它，
否则队列只会堆积、永远不会执行：

```bash
# 每隔 5 分钟跑一次（把 <CHECKPOINT> 换成你自己的执行器所在目录）
# 例如执行器放在 /root/.dsh/idle-scheduler/
crontab -l
*/5 * * * * cd /root/.dsh/idle-scheduler && /usr/local/bin/node idle-scheduler.js run >> /root/.dsh/idle-scheduler/run.log 2>&1
```

- `run`：只执行「到期」的任务（闲时窗口或已到 runAt 的定时任务）。
- `run --force`：忽略窗口判定，立即执行所有 queued 任务（调试用）。
- 手动增删查：`node idle-scheduler.js add "<prompt>" [--model X] [--mode idle|scheduled] [--at ISO] | list | cancel <id>`。
- **PATH 坑（务必）**：执行器用 `spawnSync('dsh', ...)` 拉起 dsh，而 dsh 的 shebang 是 `#!/usr/bin/env node`。
  cron 的精简 PATH 里常没有 node → 每个任务都会报
  `env: 'node': No such file or directory` 而全部失败。执行器已内置修正：
  `env.PATH = '/usr/local/bin:<node目录>:' + PATH`。若你的 node 在别处，请改
  `scripts/idle-scheduler.js` 里 `runHeadless` 的 PATH 拼接。
- 执行器用 `dsh --profile <PROFILE> <prompt>` 跑免交互 agent（默认 headless profile，环境变量
  DSH/DSH_HOME 与 kejilion.env 注入）。请确保对应 profile 已配置好模型与 API Key。

## 队列与执行状态（设置页「闲时/定时任务」）

设置页的第二张卡片就是队列面板，用来**看状态 + 管记录 + 暂停/终止**：

| 元素 | 作用 |
|---|---|
| 队列开关 | 顶部一栏：`▶ 队列运行中` / `⏸ 队列已暂停`（附暂停时间与原因）+ `暂停队列` / `恢复队列` / `终止队列` |
| `暂停队列` / `恢复队列` | 暂停后 **cron 执行器不再取新任务**（已经在跑的那条不受影响）；恢复后待执行任务重新参与闲时/定时调度 |
| `终止队列` | 「停下来」一键按钮：**暂停队列 + 杀掉所有执行中任务的执行进程**，需点两次确认（第一次变「确认终止队列？」） |
| 计数筛选 | `全部 / 待执行 / 执行中 / 已完成 / 失败 / 已终止 / 已归档`，点一下只看这一类，计数实时来自服务端 |
| 状态徽标 | 待执行（等闲时窗口/到点）、执行中、已完成、失败、已终止、已归档；被单独暂停的任务行有 `⏸ 已暂停` 徽标 |
| 每条任务 | 模式（闲时 / 定时 + 到点时间）、模型、**耗时**、执行中的 `pid`；成功结果与失败错误可「展开详情」查看 |
| `暂停` / `恢复` | 单条待执行任务暂停/恢复：暂停后执行器跳过它，恢复后照原样参与闲时/定时调度 |
| `调整时间` | 展开时间选择器改这条任务的执行时间：`保存并改为定时` 或 `改为闲时执行`（把定时任务改回闲时窗口） |
| `终止` | **执行中**任务专用：杀掉执行器拉起的 `dsh --profile headless` 子进程，任务标记「已终止」（保留记录，可「重试」） |
| `归档` / `取消归档` | 归档 = 移出列表但保留记录（在「已归档」筛选里能看到并恢复）；不会删除任何数据 |
| `删除` | 永久删除该条记录，**需要点两次**（第一次变「确认删除？」） |
| `重试` | 把已完成/失败/已终止的任务复制成一条新的待执行任务（原记录保留） |
| `取消` | 把待执行任务移出队列（不保留记录；想留痕用「终止」） |
| 批量 | `归档全部已结束`、`清空已归档`、`刷新` |

> **执行中的任务不可归档 / 删除 / 取消**：前端不显示这些按钮，服务端也会拒绝（HTTP 409 并返回原因），
> 避免误删正在运行的任务。要停它请用「终止」。
>
> **「终止」是真的杀进程**：执行器（`scripts/idle-scheduler.js`）用 `spawn` 起子进程并把 `child.pid` 写回队列，
> 面板据此发 SIGTERM（3 秒后仍存活则 SIGKILL）。杀之前会核对身份（`/proc/<pid>/cmdline` 必须是 dsh，
> 且进程启动时间不早于本任务），避免 pid 复用误杀无关进程；核对不过就只标记状态并如实回显原因。
>
> **「已终止」≠「失败」**：终止是用户主动行为，不计入失败统计；重试可重新入队。
>
> **执行器中断会自愈**：执行器进程被杀 / 服务器重启后，任务会停在「执行中」；面板读队列时会把
> 「running 但进程已不存在（且已过 60 秒）」的任务标成失败并写明原因，不会一直显示假的执行中。

### 队列 API（面板与脚本都可用）

```bash
# 读队列：附带 stats（total/active/queued/running/done/failed/terminated/paused/archived）、
#         每条 archived/durationMs/paused/pid/startedAt，以及队列开关 queue{paused,pausedAt,reason}
curl -s -H "Cookie: <面板 cookie>" http://127.0.0.1:3080/api/idle-scheduler/tasks

# 队列开关：暂停 / 恢复 / 终止整条队列（终止 = 暂停 + 杀掉所有执行中任务的进程）
curl -s -X POST -H 'content-type: application/json' -d '{"action":"pause-queue","reason":"维护"}' http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"resume-queue"}'                  http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"terminate-queue"}'               http://127.0.0.1:3080/api/idle-scheduler/tasks

# 单条任务：暂停 / 恢复 / 终止 / 调整执行时间（定时 ↔ 闲时）
curl -s -X POST -H 'content-type: application/json' -d '{"action":"pause","id":"<taskId>"}'     http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"resume","id":"<taskId>"}'    http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"terminate","id":"<taskId>"}' http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"set-time","id":"<taskId>","mode":"scheduled","runAt":"2026-09-20T01:30:00Z"}' http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"set-time","id":"<taskId>","mode":"idle"}'                                     http://127.0.0.1:3080/api/idle-scheduler/tasks

# 归档 / 取消归档 / 重试 / 取消（单条）
curl -s -X POST -H 'content-type: application/json' -d '{"action":"archive","id":"<taskId>"}' \
     http://127.0.0.1:3080/api/idle-scheduler/tasks
# 批量：归档全部已结束（含已终止）/ 清空已归档
curl -s -X POST -H 'content-type: application/json' -d '{"action":"archive-done"}'   http://127.0.0.1:3080/api/idle-scheduler/tasks
curl -s -X POST -H 'content-type: application/json' -d '{"action":"clear-archived"}' http://127.0.0.1:3080/api/idle-scheduler/tasks

# 永久删除（DELETE）
curl -s -X DELETE -H 'content-type: application/json' -d '{"id":"<taskId>"}' http://127.0.0.1:3080/api/idle-scheduler/tasks
```

状态码约定：`409` = 该状态不允许这个操作（例如「执行中的任务不能暂停」），响应体里有中文原因；
`400` = 参数问题（例如 `runAt` 无法解析）；`404` = 没有这个任务。

命令行等价物（执行器自带，便于 SSH 里管队列）：

```bash
cd ~/.dsh/idle-scheduler
node idle-scheduler.js status            # 队列开关 + 统计 + 执行中的任务（含 pid 存活）
node idle-scheduler.js pause "原因"       # 暂停队列（cron 不再取新任务）
node idle-scheduler.js resume            # 恢复队列
node idle-scheduler.js terminate <id>    # 终止某条任务（执行中会真杀进程）
```


## 兼容性

| dsh 核心 | 状态 |
|---|---|
| `0.1.6-alpha.1` | ✅ 已实测（2026-09-18）：面板启动、设置分区、输入框「闲时/定时」按钮、队列 API、cron 执行器全链路；`useInput` 草稿读写正常 |
| `0.1.5-rc.1` | ✅ 已实测（2026-09-10）：`conversation.input.left` 新契约（`useInput` / `inputActions`） |
| `>= 0.1.2-alpha.1` | ✅ 声明支持（host 侧只用 `ctx.webServer.register`） |
| `<= 0.1.1` | ⚠ 兼容保留（走旧的 `props.input.draft` 对象写法，未再回归测试） |

## 定时时间怎么选（v1.2.0 起）

点输入框工具栏的「定时」或设置页的「定时」，会展开时间选择器：

- **日期**：原生日期选择（点日历图标选，或按 `年/月/日` 逐段输入）；
- **时 / 分**：两个原生下拉（`00–23 时` / `00–59 分`）——纯下拉选择，不受浏览器/语言环境影响；
- **快捷**：`＋5 分钟` / `＋30 分钟` / `＋1 小时` / `明天 09:00`；打开时默认已填「30 分钟后」，直接点「入队」即可；
- 下面一行实时回显「将于 `YYYY-MM-DD HH:MM` 执行」；时间残缺 / 无效 / 已过期会直接写明原因。

> 为什么不用原生的 `datetime-local`：在面板的窄输入框里用键盘录入时/分时，数字会落进「年」段、
> `value` 保持为空（`validity.badInput=true`），继续输入会产出「年 = 93300」这类垃圾值，
> 随后 `new Date(x).toISOString()` 抛 `RangeError` → 点「入队」毫无反应。
> v1.2.0 用「下拉 + 校验」彻底绕开该原生控件的坑（详见 CHANGELOG）。

## 避坑 / 故障排查

- **锁版本**：安装用 `#v1.3.0`（GitHub 依赖用 `#` 指定 tag，不是 npm 的 `@版本`）。
- **装后重启**：`systemctl restart deepseek-harness.service`。
- **别在 profile 里手动 `pnpm add/up`**：可能破坏 `node_modules/@changfenhuang/dsh-genui` 软链（dsh 面板把它软链到 `@omdsh-dev/dsh-genui`），导致面板 UI 起不来；装/改插件一律走 `dsh plugin`。若动过 pnpm，请检查该软链是否仍存在。
- **PROFILE 层补丁**：插件对面板的 cordis 补丁写在 PROFILE 的 `cordis.patch.yml`，勿改 node_modules 里的（重启会被还原）。
- **调度生效确认**：设置后，队列任务应在设定的闲时窗口内开始执行；若一直不跑，先检查「启用调度」开关与窗口时间（含节假日/工作日配置）是否正确。
- **接口报错先看「自诊断」**（v1.1.2 ≥ 1.1.2）：设置页顶部会给出接口状态、可能原因与修复方向 ——
  403 且文案含 `loopback-only` = 反向代理没把 Host 改写成 `127.0.0.1:3080`（加 `proxy_set_header Host 127.0.0.1:3080;` 后 reload nginx）；
  401/403 = 面板 nginx 的 `auth_request` 未豁免该路径；404 = 插件未加载（重启面板）；5xx/超时 = 面板服务异常或正在重启。
  页面底部有「重试」与「复制诊断信息」，排查或提 issue 时直接贴。
- **私密信息**：token/密钥只填在面板设置里，勿写进源码或命令。

## 开发与源码

- 结构：`lib/index.js`（host 半）+ `lib/client.js`（client 半）+ `cordis.patch.yml`（bundle 挂载）
  + `scripts/idle-scheduler.js`（cron 执行器，真正执行任务的那份）
- 单测（三个套件，都不碰线上队列：用 `IDLE_TASKS_FILE` / `IDLE_CONTROL_FILE` 指到临时文件）：
  ```bash
  node scripts/unit.test.mjs      # 46 项：client 纯函数（时间/状态/权限矩阵/文案）
  node scripts/api.test.mjs       # 35 项：队列 API（暂停/恢复/终止/调整时间/僵尸自愈/原子写）
  node scripts/executor.test.mjs  # 15 项：cron 执行器端到端（假 dsh，含真杀进程）
  ```
- **改完记得同步 cron 执行器**：执行器在 `~/.dsh/idle-scheduler/`，与插件目录是两份，漏同步会出现
  「面板按钮更新了、执行器还是旧版」。用 `/root/work/deploy-self-plugins.sh` 一条命令同步两处并打印 md5 一致性。
- 版本：`1.4.0`
- 许可：MIT

