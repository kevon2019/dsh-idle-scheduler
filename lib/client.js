/* dsh-idle-scheduler client half — 设置页 + 对话输入框工具栏。 */
window.__ModuleLoader__.load({
  id: "dsh-idle-scheduler",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const NS = "idle-scheduler";
    const MODELS = ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash-vision-exp"];
    const statusColor = { queued: "#e6b800", running: "#4aa3ff", done: "#4caf50", failed: "#ff5a5a" };
    const inputStyle = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #333)", background: "transparent", color: "inherit", fontSize: 13 };
    const btnStyle = { padding: "7px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#333)", background: "var(--dsw-alias-bg-2,#222)", color: "#fff", cursor: "pointer", fontSize: 13 };

    function card(label, children, style) {
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, margin: "8px 0", ...(style || {}) } },
        label ? React.createElement("div", { style: { fontWeight: 600, fontSize: 13 } }, label) : null, children);
    }

    /* ---------- 自诊断兜底（v1.1.2）----------
     * 队列接口失败时**不再静默显示「队列为空」**（那会把「接口挂了」误导成「没有任务」）。
     * 统一 8 秒超时 + 状态码分类 + 可操作修复方向 + 一键复制诊断信息；纯函数便于单测。 */
    const API = "/api/idle-scheduler/tasks";
    const API_TIMEOUT_MS = 8000;

    function diagHintFor(status, reason, bodyText) {
      const t = String(bodyText || "");
      if (status === 0) {
        return { title: "无法连接面板接口（" + (reason || "网络错误") + "）",
          cause: "浏览器到面板的请求没有完成：面板进程可能正在重启，或网络中断。",
          fix: "确认面板服务在运行（systemctl status <你的 dsh 服务>），稍后点「重试」。" };
      }
      if (/loopback-only|loopback requests only/i.test(t)) {
        return { title: "接口被「仅本机」守卫拒绝（HTTP " + status + "）",
          cause: "反向代理没有把请求头 Host 改写成 127.0.0.1:3080，插件路由判定请求不是本机来源。",
          fix: "在面板 nginx 的 location / 中加 proxy_set_header Host 127.0.0.1:3080; 然后 reload nginx。" };
      }
      if (status === 401 || status === 403) {
        return { title: "请求被部署层鉴权拦截（HTTP " + status + "）",
          cause: "面板 nginx 的 auth_request 覆盖了该接口路径且未豁免。",
          fix: "为该路径加豁免（location /api/idle-scheduler/ { auth_request off; proxy_pass <面板后端>; }）后 reload nginx。" };
      }
      if (status === 404) {
        return { title: "插件接口不存在（HTTP 404）",
          cause: "本插件未加载，或它的 webServer 路由未注册（安装后未重启 / 版本不匹配）。",
          fix: "确认插件在已安装列表里（dsh plugin --profile web ls），然后重启面板服务。" };
      }
      if (status >= 500) {
        return { title: "面板服务端出错（HTTP " + status + "）",
          cause: "nginx 后面的 dsh 进程异常或正在重启。",
          fix: "查看面板服务日志；确认服务 active 后点「重试」。" };
      }
      return { title: "队列接口返回异常（HTTP " + status + "）",
        cause: "服务端返回了非预期的响应。",
        fix: "点「重试」；若持续失败，请带上「复制诊断信息」的内容排查。" };
    }

    function ApiDiagnostics(props) {
      const e = props.err || {};
      const [copied, setCopied] = React.useState(false);
      const hint = diagHintFor(e.status, e.reason, e.body);
      /* [2026-09-10] 颜色一律 inherit / opacity，不写死主题色：
       * 面板可能是浅色或深色主题，写死浅灰兜底色会在浅色主题下看起来像「被禁用」。 */
      const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11,
        padding: "1px 5px", borderRadius: 4, background: "var(--dsw-alias-fill-l2, rgba(127,127,127,.16))" };
      const dim = { opacity: 0.7, fontSize: 12 };
      const small = { padding: "5px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#333)",
        background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: 12,
          border: "1px dashed var(--dsw-alias-border-l2,#333)", borderRadius: 10, fontSize: 13, lineHeight: 1.7 } },
        React.createElement("div", { style: { fontWeight: 600, fontSize: 14 } }, hint.title),
        React.createElement("div", { style: dim }, "接口：", React.createElement("span", { style: mono }, e.url || API),
          "　状态：", React.createElement("span", { style: mono }, String(e.reason || e.status))),
        React.createElement("div", null, React.createElement("b", null, "可能原因："), hint.cause),
        React.createElement("div", null, React.createElement("b", null, "修复方向："), hint.fix),
        e.body ? React.createElement("div", { style: { ...dim, maxHeight: 72, overflow: "auto", whiteSpace: "pre-wrap" } },
          "服务端返回：" + String(e.body).slice(0, 300)) : null,
        React.createElement("div", { style: dim }, "后台执行器（cron）不受此影响；这里只影响面板读取/写入队列。"),
        React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
          React.createElement("button", { type: "button", style: small, onClick: props.onRetry }, "重试"),
          React.createElement("button", { type: "button", style: small, onClick: () => {
            const text = "dsh-idle-scheduler 队列接口诊断\n地址: " + (typeof location !== "undefined" && location ? location.origin : "?")
              + "\n接口: " + (e.url || API) + "\n状态: " + String(e.reason || e.status)
              + "\n原因: " + hint.cause + "\n服务端返回: " + String(e.body || "").slice(0, 200);
            try { void navigator.clipboard.writeText(text); setCopied(true); } catch (x) { /* clipboard 不可用 */ }
          } }, copied ? "已复制 ✓" : "复制诊断信息")));
    }

    function IdleSchedulerSection() {
      const [prompt, setPrompt] = React.useState("");
      const [model, setModel] = React.useState(MODELS[0]);
      const [tasks, setTasks] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [openSched, setOpenSched] = React.useState(false);
      const [schedAt, setSchedAt] = React.useState("");
      /* [2026-09-10 v1.1.2] 接口失败不再静默：记录失败原因并在页面上给出诊断 + 重试 */
      const [apiErr, setApiErr] = React.useState(null);
      const [retryTick, setRetryTick] = React.useState(0);
      const refresh = React.useCallback(() => {
        const ctl = (typeof AbortController === "function") ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, API_TIMEOUT_MS) : null;
        fetch(API, ctl ? { signal: ctl.signal } : undefined)
          .then(async (r) => {
            const text = await r.text();
            let data = null; try { data = JSON.parse(text); } catch (e) { data = null; }
            if (!r.ok) { setApiErr({ status: r.status, reason: "HTTP " + r.status, url: API, body: text.slice(0, 400) }); return; }
            if (data && Array.isArray(data.tasks)) { setTasks(data.tasks); setApiErr(null); return; }
            setApiErr({ status: r.status, reason: "响应缺少 tasks 字段", url: API, body: text.slice(0, 400) });
          })
          .catch((e) => {
            const msg = String((e && e.message) || e);
            const aborted = (e && e.name === "AbortError") || /abort/i.test(msg);
            setApiErr({ status: 0, reason: aborted ? "请求超时（" + Math.round(API_TIMEOUT_MS / 1000) + " 秒）" : ("网络错误：" + msg),
              url: API, body: "" });
          })
          .finally(() => { if (timer) clearTimeout(timer); });
      }, []);
      React.useEffect(() => { refresh(); const iv = setInterval(refresh, 15000); return () => clearInterval(iv); }, [refresh, retryTick]);
      const submit = (mode, runAt) => {
        if (!prompt.trim()) return;
        if (mode === "scheduled" && !runAt) { setMsg("请选择定时时间"); return; }
        setBusy(true); setMsg("");
        const body = { prompt, model, mode };
        if (mode === "scheduled") body.runAt = new Date(runAt).toISOString();
        fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg("入队失败（HTTP " + r.status + "）—— 见上方诊断"); refresh(); return; }
            setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || "")));
            setPrompt(""); setOpenSched(false); setSchedAt(""); refresh();
          })
          .catch((e) => { setMsg("请求失败：" + e + " —— 见上方诊断"); refresh(); })
          .finally(() => setBusy(false));
      };
      const cancel = (id) => { fetch(API, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => r.json()).then(() => refresh()).catch(() => { refresh(); }); };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        apiErr ? React.createElement(ApiDiagnostics, { err: apiErr, onRetry: () => setRetryTick((t) => t + 1) }) : null,
        card("加入闲时/定时任务", React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          React.createElement("textarea", { placeholder: "输入任务描述/prompt", value: prompt, rows: 3, style: inputStyle, onChange: (e) => setPrompt(e.target.value) }),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            React.createElement("select", { title: "模型", value: model, style: { ...inputStyle, width: "auto", flex: "none" }, onChange: (e) => setModel(e.target.value) }, MODELS.map((m) => React.createElement("option", { key: m, value: m }, m))),
            React.createElement("button", { type: "button", onClick: () => submit("idle", null), disabled: busy, style: btnStyle, title: "加入闲时队列，闲时窗口自动执行" }, busy ? "提交中…" : "加入闲时队列"),
            React.createElement("button", { type: "button", onClick: () => setOpenSched(!openSched), style: btnStyle, title: "定时执行" }, "定时"),
            openSched ? React.createElement("input", { type: "datetime-local", value: schedAt, onChange: (e) => setSchedAt(e.target.value), style: { ...inputStyle, width: "200px", fontSize: 12, padding: "4px 6px" } }) : null,
            openSched ? React.createElement("button", { type: "button", onClick: () => submit("scheduled", schedAt), disabled: busy, style: btnStyle, title: "按选定时间加入定时队列" }, busy ? "提交中…" : "入队") : null),
          msg ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-text-secondary,#7f8a99)" } }, msg) : null)),
        card("队列", tasks.length ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, tasks.slice().reverse().slice(0, 30).map((t) =>
          React.createElement("div", { key: t.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#222)", background: "var(--dsw-alias-bg-2,#1a1a1a)", fontSize: 12 } },
            React.createElement("span", { style: { color: statusColor[t.status] || "#888", fontWeight: 600, flex: "none" } }, t.status),
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.prompt),
            t.model ? React.createElement("span", { style: { flex: "none", color: "#888" } }, t.model) : null,
            t.status === "queued" ? React.createElement("button", { type: "button", onClick: () => cancel(t.id), style: { ...btnStyle, padding: "3px 8px", fontSize: 11 } }, "取消") : null)))
          : (apiErr ? React.createElement("div", { style: { fontSize: 12, color: "#7f8a99" } }, "队列不可用（见上方诊断）")
            : React.createElement("div", { style: { fontSize: 12, color: "#7f8a99" } }, "队列为空"))));
    }

    /* [2026-09-10 dsh 0.1.5] conversation.input.left 的 props 契约变了：
     *  0.1.5 传的是 hooks（useInput / inputActions / sessionId …）→ 草稿读 useInput(s => s).draft，
     *        清空用 inputActions.setDraft("")。
     *  ≤0.1.1 传的是普通对象 { input:{draft}, inputActions }。
     *  两条路都支持：在入口组件里按 props 形状分流（各自组件内无条件调用 hook，避免违反 hooks 规则）。 */
    function clearComposerDraft(props) {
      const a = props && props.inputActions;
      try { if (a && typeof a.setDraft === "function") { a.setDraft(""); return; } } catch (e) { /* ignore */ }
      const kb = props && props.keyboard;
      try { if (kb && kb.actions && typeof kb.actions.setDraft === "function") kb.actions.setDraft(""); } catch (e) { /* ignore */ }
    }

    function IdleComposerButton(props, draftText) {
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [openSchedule, setOpenSchedule] = React.useState(false);
      const [runAt, setRunAt] = React.useState("");
      const submit = (mode) => {
        const prompt = String(draftText || "").trim();
        if (!prompt) { setMsg("输入框为空"); setTimeout(() => setMsg(""), 2500); return; }
        setBusy(true); setMsg("");
        const body = { prompt, mode };
        if (mode === "scheduled") {
          if (!runAt) { setMsg("请选择定时时间"); setBusy(false); return; }
          body.runAt = new Date(runAt).toISOString();
        }
        fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg("入队失败（HTTP " + r.status + "）；诊断见 设置→闲时/定时任务"); return; }
            setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || "")));
            if (d.ok) clearComposerDraft(props);
          })
          .catch((e) => setMsg("请求失败：" + e + "；诊断见 设置→闲时/定时任务"))
          .finally(() => setBusy(false));
      };
      const style = { ...btnStyle, padding: "4px 8px", fontSize: 12, flex: "none" };
      return React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, flex: "none" } },
        React.createElement("button", { type: "button", onClick: () => submit("idle"), disabled: busy, style, title: "把当前输入加入闲时队列，闲时窗口自动执行" }, busy ? "…" : "闲时"),
        React.createElement("button", { type: "button", onClick: () => setOpenSchedule(!openSchedule), style, title: "把当前输入定时执行" }, "定时"),
        openSchedule ? React.createElement("input", { type: "datetime-local", value: runAt, onChange: (e) => setRunAt(e.target.value), style: { ...inputStyle, width: "180px", fontSize: 12, padding: "4px 6px" } }) : null,
        openSchedule ? React.createElement("button", { type: "button", onClick: () => submit("scheduled"), disabled: busy, style }, "入队") : null,
        msg ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-text-secondary,#7f8a99)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, msg) : null);
    }

    /* 0.1.5：props 是 hooks，必须无条件调用；旧核心：props 是对象。分流在组件层做。 */
    function IdleComposerFiber(props) {
      const st = props.useInput((s) => s);
      return IdleComposerButton(props, st && st.draft);
    }
    function IdleComposerLegacy(props) {
      return IdleComposerButton(props, props && props.input && props.input.draft);
    }
    function IdleComposerEntry(props) {
      return typeof (props && props.useInput) === "function"
        ? React.createElement(IdleComposerFiber, props)
        : React.createElement(IdleComposerLegacy, props);
    }

    function apply(ctx) {
      if (ctx !== null && typeof ctx.slots?.inject === "function" && typeof ctx.slots.register === "function") {
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: NS, order: 780, label: () => "闲时/定时任务" }, IdleSchedulerSection));
        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: NS, order: 10 }, IdleComposerEntry));
      }
    }

    const inject = ["slots"];
    /* 纯函数挂在 apply 上，便于独立单测（不改 exports 契约） */
    apply.__diagHintFor = diagHintFor;
    module.exports = { apply, inject };
    return module.exports;
  },
});
