/* dsh-idle-scheduler client half — 设置页 + 对话输入框工具栏。
 *
 * [2026-09-18 v1.2.0] 定时时间选择重写：不再使用原生 <input type="datetime-local">。
 * 实测（dsh 0.1.6-alpha.1 / Chromium）：在这种窄输入框里用键盘录入时/分时，
 * 数字会落进「年」段且 value 保持为空（validity.badInput=true），继续输入会得到
 * 荒谬值（如 93300-01-09T14:20）→ 旧代码 new Date(x).toISOString() 抛 RangeError，
 * 点击「入队」完全没反应（既不入队也无提示）。这正是用户报的「不能选择输入时分」。
 * 现在改为「日期选择 + 时/分下拉」+ 快捷时间（＋5 分钟 / ＋30 分钟 / ＋1 小时 / 明天 09:00），
 * 纯原生控件、可键盘操作、任何浏览器/语言下都能确定地选到时分；并在提交前做
 * 本地时间解析校验（不完整/无效/已过期 → 页面直接给出原因，不再静默失败）。
 */
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

    /* ---------- 时间工具（纯函数，可单测）----------
     * 统一用「本地无时区字符串」作为中间表示：YYYY-MM-DDTHH:MM。
     * 提交时才转成 ISO（UTC），避免把字符串直接塞给 new Date() 后抛异常。 */
    function pad2(n) { return String(n).padStart(2, "0"); }
    function toLocalValue(d) {
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
        + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    function splitLocal(v) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ""));
      if (m === null) return null;
      return { date: m[1] + "-" + m[2] + "-" + m[3], hh: m[4], mm: m[5] };
    }
    function composeLocal(date, hh, mm) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
      if (!/^\d{2}$/.test(String(hh || "")) || !/^\d{2}$/.test(String(mm || ""))) return "";
      return date + "T" + hh + ":" + mm;
    }
    /* 返回 {ok:true, iso, at} 或 {ok:false, reason}——永不抛异常。 */
    function parseLocalToIso(local, nowMs) {
      const s = String(local || "").trim();
      if (s === "") return { ok: false, reason: "请选择日期与时分" };
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return { ok: false, reason: "日期或时分不完整（应为 YYYY-MM-DDTHH:MM）" };
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return { ok: false, reason: "时间无法识别，请重新选择" };
      if (d.getFullYear() < 2000 || d.getFullYear() > 2100) return { ok: false, reason: "日期需在 2000–2100 之间" };
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (d.getTime() <= now) return { ok: false, reason: "时间需晚于当前时间" };
      return { ok: true, iso: d.toISOString(), at: d.getTime() };
    }
    /* 快捷时间：以当前（或给定）时刻为基准平移 minutes 分钟。 */
    function shiftLocal(minutes, baseLocal, nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      let base = new Date(now);
      if (baseLocal) {
        const d = new Date(String(baseLocal));
        if (!Number.isNaN(d.getTime())) base = d;
      }
      return toLocalValue(new Date(base.getTime() + Number(minutes) * 60000));
    }
    /* 「明天 09:00」这类固定时刻（保留未来最近的一次）。 */
    function nextDayAt(hour, minute, nowMs) {
      const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hour), Number(minute), 0, 0);
      d.setDate(d.getDate() + 1);
      return toLocalValue(d);
    }

    const HOURS = Array.from({ length: 24 }, (_, i) => pad2(i));
    const MINUTES = Array.from({ length: 60 }, (_, i) => pad2(i));

    function TimePicker(props) {
      const value = String(props.value || "");
      const nowMs = props.nowMs;
      const parts = splitLocal(value) || splitLocal(shiftLocal(30, null, nowMs));
      const parsed = parseLocalToIso(value, nowMs);
      const emit = (date, hh, mm) => { if (typeof props.onChange === "function") props.onChange(composeLocal(date, hh, mm)); };
      const smallBtn = { padding: "3px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2,#333)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 11 };
      const selStyle = { ...inputStyle, width: 74, flex: "none", fontSize: 12, padding: "4px 4px" };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2,#333)", background: "var(--dsw-alias-bg-2, transparent)" } },
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          React.createElement("input", { type: "date", "aria-label": "执行日期", value: parts.date, onChange: (e) => emit(e.target.value, parts.hh, parts.mm), style: { ...inputStyle, width: 148, flex: "none", fontSize: 12, padding: "4px 6px" } }),
          React.createElement("select", { "aria-label": "时", title: "时 (00-23)", value: parts.hh, onChange: (e) => emit(parts.date, e.target.value, parts.mm), style: selStyle }, HOURS.map((h) => React.createElement("option", { key: h, value: h }, h + " 时"))),
          React.createElement("select", { "aria-label": "分", title: "分 (00-59)", value: parts.mm, onChange: (e) => emit(parts.date, parts.hh, e.target.value), style: selStyle }, MINUTES.map((m) => React.createElement("option", { key: m, value: m }, m + " 分")))),
        React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          React.createElement("span", { style: { fontSize: 11, opacity: 0.7 } }, "快捷："),
          React.createElement("button", { type: "button", style: smallBtn, title: "5 分钟后", onClick: () => props.onChange(shiftLocal(5, value, nowMs)) }, "＋5 分钟"),
          React.createElement("button", { type: "button", style: smallBtn, title: "30 分钟后", onClick: () => props.onChange(shiftLocal(30, value, nowMs)) }, "＋30 分钟"),
          React.createElement("button", { type: "button", style: smallBtn, title: "1 小时后", onClick: () => props.onChange(shiftLocal(60, value, nowMs)) }, "＋1 小时"),
          React.createElement("button", { type: "button", style: smallBtn, title: "明天 09:00", onClick: () => props.onChange(nextDayAt(9, 0, nowMs)) }, "明天 09:00")),
        React.createElement("div", { style: { fontSize: 11, lineHeight: 1.6, opacity: parsed.ok ? 0.75 : 0.95 } },
          parsed.ok ? ("将于 " + value.replace("T", " ") + " 执行") : ("⚠ " + parsed.reason)));
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
      /* [2026-09-18 v1.2.0] 默认给一个「30 分钟后」的合法时间：用户点开即可直接入队，
       * 不必先跟原生时间控件搏斗。 */
      const [schedAt, setSchedAt] = React.useState(() => shiftLocal(30));
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
        if (!prompt.trim()) { setMsg("请输入任务描述"); return; }
        setBusy(true); setMsg("");
        const body = { prompt, model, mode };
        if (mode === "scheduled") {
          const parsed = parseLocalToIso(runAt);
          if (!parsed.ok) { setMsg("时间不可用：" + parsed.reason); setBusy(false); return; }
          body.runAt = parsed.iso;
        }
        fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg("入队失败（HTTP " + r.status + "）—— 见上方诊断"); refresh(); return; }
            setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || "")));
            setPrompt(""); setOpenSched(false); refresh();
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
            React.createElement("button", { type: "button", onClick: () => setOpenSched(!openSched), style: btnStyle, title: "定时执行" }, openSched ? "收起定时" : "定时")),
          openSched ? React.createElement(TimePicker, { value: schedAt, onChange: setSchedAt }) : null,
          openSched ? React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            React.createElement("button", { type: "button", onClick: () => submit("scheduled", schedAt), disabled: busy, style: btnStyle, title: "按选定时间加入定时队列" }, busy ? "提交中…" : "按此时间入队")) : null,
          msg ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-text-secondary,#7f8a99)" } }, msg) : null)),
        card("队列", tasks.length ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, tasks.slice().reverse().slice(0, 30).map((t) =>
          React.createElement("div", { key: t.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#222)", background: "var(--dsw-alias-bg-2,#1a1a1a)", fontSize: 12 } },
            React.createElement("span", { style: { color: statusColor[t.status] || "#888", fontWeight: 600, flex: "none" } }, t.status),
            React.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.prompt),
            t.mode === "scheduled" && t.runAt ? React.createElement("span", { style: { flex: "none", color: "#888" } }, String(t.runAt).replace("T", " ").slice(0, 16)) : null,
            t.model ? React.createElement("span", { style: { flex: "none", color: "#888" } }, t.model) : null,
            t.status === "queued" ? React.createElement("button", { type: "button", onClick: () => cancel(t.id), style: { ...btnStyle, padding: "3px 8px", fontSize: 11 } }, "取消") : null)))
          : (apiErr ? React.createElement("div", { style: { fontSize: 12, color: "#7f8a99" } }, "队列不可用（见上方诊断）")
            : React.createElement("div", { style: { fontSize: 12, color: "#7f8a99" } }, "队列为空"))));
    }

    /* [2026-09-10 dsh 0.1.5 / 2026-09-18 复核 0.1.6] conversation.input.left 的 props 契约：
     *  0.1.5 起传 hooks（useInput / inputActions / sessionId …）→ 草稿读 useInput(s => s).draft，
     *        清空用 inputActions.setDraft("")。0.1.6-alpha.1 实测：useInput / inputActions
     *        以标准 props 直接传入（非 hooks.X 包装），两条路都已在面板上跑通。
     *  ≤0.1.1 传的是普通对象 { input:{draft}, inputActions }。
     * 三条路全支持：在入口组件里按 props 形状分流（各自组件内无条件调用 hook，避免违反 hooks 规则）。 */
    function clearComposerDraft(props) {
      const a = props && props.inputActions;
      try { if (a && typeof a.setDraft === "function") { a.setDraft(""); return true; } } catch (e) { /* ignore */ }
      const ha = props && props.hooks && props.hooks.inputActions;
      try { if (ha && typeof ha.setDraft === "function") { ha.setDraft(""); return true; } } catch (e) { /* ignore */ }
      const kb = props && props.keyboard;
      try { if (kb && kb.actions && typeof kb.actions.setDraft === "function") { kb.actions.setDraft(""); return true; } } catch (e) { /* ignore */ }
      return false;
    }

    function IdleComposerButton(props, draftText) {
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [openSchedule, setOpenSchedule] = React.useState(false);
      /* 默认「30 分钟后」：点开定时即是一个合法时间，直接入队即可。 */
      const [runAt, setRunAt] = React.useState(() => shiftLocal(30));
      const submit = (mode) => {
        const prompt = String(draftText || "").trim();
        if (!prompt) { setMsg("输入框为空"); setTimeout(() => setMsg(""), 2500); return; }
        const body = { prompt, mode };
        if (mode === "scheduled") {
          const parsed = parseLocalToIso(runAt);
          if (!parsed.ok) { setMsg("时间不可用：" + parsed.reason); setTimeout(() => setMsg(""), 4000); return; }
          body.runAt = parsed.iso;
        }
        setBusy(true); setMsg("");
        fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .then(async (r) => {
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg("入队失败（HTTP " + r.status + "）；诊断见 设置→闲时/定时任务"); return; }
            setMsg(d.ok ? (mode === "scheduled" ? "已加入定时队列" : "已加入闲时队列") : ("失败：" + (d.error || "")));
            if (d.ok) { clearComposerDraft(props); setOpenSchedule(false); }
          })
          .catch((e) => setMsg("请求失败：" + e + "；诊断见 设置→闲时/定时任务"))
          .finally(() => setBusy(false));
      };
      const style = { ...btnStyle, padding: "4px 8px", fontSize: 12, flex: "none" };
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, flex: "none" } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, flex: "none" } },
          React.createElement("button", { type: "button", onClick: () => submit("idle"), disabled: busy, style, title: "把当前输入加入闲时队列，闲时窗口自动执行" }, busy ? "…" : "闲时"),
          React.createElement("button", { type: "button", onClick: () => setOpenSchedule(!openSchedule), style, title: "把当前输入定时执行" }, "定时"),
          msg ? React.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-text-secondary,#7f8a99)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, msg) : null),
        openSchedule ? React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          React.createElement(TimePicker, { value: runAt, onChange: setRunAt }),
          React.createElement("button", { type: "button", onClick: () => submit("scheduled"), disabled: busy, style, title: "按选定时间加入定时队列" }, busy ? "…" : "入队")) : null);
    }

    /* 0.1.5/0.1.6：props 里 useInput 是「标准 props」；兼容 hooks.X 包装与旧核心对象。 */
    function IdleComposerFiber(props) {
      const st = props.useInput((s) => s);
      return IdleComposerButton(props, st && st.draft);
    }
    function IdleComposerHooked(props) {
      const st = props.hooks.useInput((s) => s);
      return IdleComposerButton(props, st && st.draft);
    }
    function IdleComposerLegacy(props) {
      return IdleComposerButton(props, props && props.input && props.input.draft);
    }
    function IdleComposerEntry(props) {
      if (typeof (props && props.useInput) === "function") return React.createElement(IdleComposerFiber, props);
      if (props && props.hooks && typeof props.hooks.useInput === "function") return React.createElement(IdleComposerHooked, props);
      return React.createElement(IdleComposerLegacy, props);
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
    apply.__time = { pad2, toLocalValue, splitLocal, composeLocal, parseLocalToIso, shiftLocal, nextDayAt, HOURS, MINUTES };
    module.exports = { apply, inject };
    return module.exports;
  },
});
