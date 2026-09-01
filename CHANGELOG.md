# Changelog

## 1.1.0 (2026-09-02) — 确认 DSH alpha.3 兼容

- host 侧无 `@deepseek-ai` 核心 API 依赖（仅 `ctx.webServer.register`），client 侧使用保留的 `settings.section` slot —— 已确认兼容 alpha.3 核心。
- 目标核心：`@deepseek-ai/dsh >= 0.1.2-alpha.1`。

## 1.0.4 — 2026-08-29

- 闲时/定时任务编排：queued/scheduled 任务、runAt 定时、结果回传。
