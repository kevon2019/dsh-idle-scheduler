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

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler#v1.0.3`
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

## 避坑 / 故障排查

- **锁版本**：安装用 `#v1.0.3`（GitHub 依赖用 `#` 指定 tag，不是 npm 的 `@版本`）。
- **装后重启**：`systemctl restart deepseek-harness.service`。
- **别在 profile 里手动 `pnpm add/up`**：可能破坏 `node_modules/@changfenhuang/dsh-genui` 软链（dsh 面板把它软链到 `@omdsh-dev/dsh-genui`），导致面板 UI 起不来；装/改插件一律走 `dsh plugin`。若动过 pnpm，请检查该软链是否仍存在。
- **PROFILE 层补丁**：插件对面板的 cordis 补丁写在 PROFILE 的 `cordis.patch.yml`，勿改 node_modules 里的（重启会被还原）。
- **调度生效确认**：设置后，队列任务应在设定的闲时窗口内开始执行；若一直不跑，先检查「启用调度」开关与窗口时间（含节假日/工作日配置）是否正确。
- **私密信息**：token/密钥只填在面板设置里，勿写进源码或命令。

## 开发与源码

- 结构：`lib/index.js`（host 半）+ `lib/client.js`（client 半）+ `cordis.patch.yml`（bundle 挂载）
- 版本：`1.0.3`
- 许可：MIT
