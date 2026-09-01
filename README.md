# dsh-idle-scheduler

DeepSeek Harness 面板「闲时 / 定时任务」插件：在面板闲置时或有定时触发时编排 agent 任务。

## 功能

- **闲时任务**：面板空闲时自动排队执行任务。
- **定时任务**（scheduled）：按 `runAt` 指定时间触发。
- 任务状态队列（queued / running / finished / error）、结果回传。

## 安装

通过 dsh 面板插件市场或 `dsh plugin --profile web add dsh-idle-scheduler` 安装。面板 Settings → 插件卡片（`闲时/定时任务`）配置。

## 兼容性

- **目标核心**：`@deepseek-ai/dsh >= 0.1.2-alpha.1`（alpha.3）。
- host 侧仅依赖 `ctx.webServer.register`，client 侧使用 `settings.section` slot，均已在 alpha.3 确认兼容。

## 数据

任务队列存储在 `/root/.dsh/idle-tasks.json`。

## License

MIT
