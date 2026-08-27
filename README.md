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

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler#v1.0.2`
> （GitHub 依赖用 `#` 指定 tag/分支，**不是** npm 的 `@版本`）
> 安装后重启面板服务即可生效：`systemctl restart deepseek-harness.service`

## 配置

打开 dsh 面板 → **设置 → 闲时任务**：

- 启用/停用任务调度
- 设定闲时时间窗口与批量执行策略
- 为任务指定默认模型

侧边栏的「闲时 / 定时」按钮用于把当前/后台任务快速投入调度队列。

## 避坑 / 故障排查

- **锁版本**：安装用 `#v1.0.2`（GitHub 依赖用 `#` 指定 tag，不是 npm 的 `@版本`）。
- **装后重启**：`systemctl restart deepseek-harness.service`。
- **别在 profile 里手动 `pnpm add/up`**：可能破坏 `node_modules/@changfenhuang/dsh-genui` 软链（dsh 面板把它软链到 `@omdsh-dev/dsh-genui`），导致面板 UI 起不来；装/改插件一律走 `dsh plugin`。若动过 pnpm，请检查该软链是否仍存在。
- **PROFILE 层补丁**：插件对面板的 cordis 补丁写在 PROFILE 的 `cordis.patch.yml`，勿改 node_modules 里的（重启会被还原）。
- **调度生效确认**：设置后，队列任务应在设定的闲时窗口内开始执行；若一直不跑，先检查「启用调度」开关与窗口时间（含节假日/工作日配置）是否正确。
- **私密信息**：token/密钥只填在面板设置里，勿写进源码或命令。

## 开发与源码

- 结构：`lib/index.js`（host 半）+ `lib/client.js`（client 半）+ `cordis.patch.yml`（bundle 挂载）
- 版本：`1.0.2`
- 许可：MIT
