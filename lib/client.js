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

    function IdleSchedulerSection() {
      const [prompt, setPrompt] = React.useState("");
      const [model, setModel] = React.useState(MODELS[0]);
      const [tasks, setTasks] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const refresh = React.useCallback(() => {
        fetch("/api/idle-scheduler/tasks").then((r) => r.json()).then((d) => { if (d && Array.isArray(d.tasks)) setTasks(d.tasks); }).catch(() => {});
      }, []);
      React.useEffect(() => { refresh(); const iv = setInterval(refresh, 15000); return () => clearInterval(iv); }, [refresh]);
      const submit = (mode, runAt) => {
        if (!prompt.trim()) return;
        setBusy(true); setMsg("");
        fetch("/api/idle-scheduler/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, model, mode, runAt }) })
          .then((r) => r.json())
          .then((d) => { setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || ""))); setPrompt(""); refresh(); })
          .catch((e) => setMsg("请求失败：" + e))
          .finally(() => setBusy(false));
      };
      const cancel = (id) => { fetch("/api/idle-scheduler/tasks", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then((r) => r.json()).then(() => refresh()).catch(() => {}); };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
        card("加入闲时/定时任务", React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
          React.createElement("textarea", { placeholder: "输入任务描述/prompt", value: prompt, rows: 3, style: inputStyle, onChange: (e) => setPrompt(e.target.value) }),
          React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            React.createElement("select", { title: "模型", value: model, style: { ...inputStyle, width: "auto", flex: "none" }, onChange: (e) => setModel(e.target.value) }, MODELS.map((m) => React.createElement("option", { key: m, value: m }, m))),
            React.createElement("button", { type: "button", onClick: () => submit("idle", null), disabled: busy, style: btnStyle }, busy ? "提交中…" : "加入闲时队列")),
          msg ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-text-secondary,#7f8a99)" } }, msg) : null)),
        card("队列", tasks.length ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, tasks.slice().reverse().slice(0, 30).map((t) =>
          React.createElement("div", { key: t.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#222)", background: "var(--dsw-alias-bg-2,#1a1a1a)", fontSize: 12 } },
            React.createElement("span", { style: { color: statusColor[t.status] || "#888", fontWeight: 600, flex: "none" } }, t.status),
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.prompt),
            t.model ? React.createElement("span", { style: { flex: "none", color: "#888" } }, t.model) : null,
            t.status === "queued" ? React.createElement("button", { type: "button", onClick: () => cancel(t.id), style: { ...btnStyle, padding: "3px 8px", fontSize: 11 } }, "取消") : null)))
          : React.createElement("div", { style: { fontSize: 12, color: "#7f8a99" } }, "队列为空")));
    }

    function IdleComposerButton({ input, inputActions }) {
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [openSchedule, setOpenSchedule] = React.useState(false);
      const [runAt, setRunAt] = React.useState("");
      const submit = (mode) => {
        const prompt = (input && input.draft || "").trim();
        if (!prompt) return;
        setBusy(true); setMsg("");
        const body = { prompt, mode };
        if (mode === "scheduled") {
          if (!runAt) { setMsg("请选择定时时间"); setBusy(false); return; }
          body.runAt = new Date(runAt).toISOString();
        }
        fetch("/api/idle-scheduler/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then((r) => r.json())
          .then((d) => { setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || ""))); if (d.ok && inputActions && typeof inputActions.setDraft === "function") inputActions.setDraft(""); })
          .catch((e) => setMsg("请求失败：" + e))
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

    function apply(ctx) {
      if (ctx !== null && typeof ctx.slots?.inject === "function" && typeof ctx.slots.register === "function") {
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: NS, order: 780, label: () => "闲时任务" }, IdleSchedulerSection));
        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: NS, order: 10 }, IdleComposerButton));
      }
    }

    const inject = ["slots"];
    module.exports = { apply, inject };
    return module.exports;
  },
});
