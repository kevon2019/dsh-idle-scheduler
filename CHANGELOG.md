# Changelog

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
