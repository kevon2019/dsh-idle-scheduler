# Changelog

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
