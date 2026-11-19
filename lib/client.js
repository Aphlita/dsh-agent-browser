/**
 * dsh-agent-browser —— client 半插件（手写 ModuleLoader bundle，不依赖打包器）
 *
 * 右栏 tab：实时画面（同源 WebSocket 的 JPEG 帧）+ 地址/租约状态 + 直接操作。
 * 人类在这里点击/滚动，与 agent 的 browser_* 工具操作的是同一个浏览器会话。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-browser",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useEffect, useRef, useState } = React;

    const PLUGIN_ID = "dsh-agent-browser";
    const TAB_KIND = "agent-browser";
    const TAB_ANCHOR = "sidebar.right.pane.tab";
    const WS_PATH = "agent-browser/ws";
    const API_PATH = "agent-browser/api";

    /* ------------------------- 宿主地址解析（桌面壳关键） -------------------------
     * 桌面壳页面是 dsh-app://app/，其 host 是字面量 "app"：
     *  - HTTP 必须走页面自身 base（壳把非静态路径转发给 Host，同源、带 cookie）
     *  - WebSocket 必须走 __DSH_TRANSPORT__.streamBaseUrl（自定义 scheme 跑不了 ws:）
     * 这一段与 dsh-better-sidebar 的 host-route-url.ts 同构。
     */
    const PLACEHOLDER_ORIGIN = "http://dsh.internal/";

    function transportBase() {
      const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
      if (typeof base === "string" && base !== "") return base;
      return typeof location !== "undefined" && location.origin ? location.origin : "";
    }

    function pageBase() {
      if (typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI !== "") return document.baseURI;
      return transportBase();
    }

    function directoryBase(baseUrl) {
      const url = new URL(baseUrl === "" ? PLACEHOLDER_ORIGIN : baseUrl, PLACEHOLDER_ORIGIN);
      url.search = "";
      url.hash = "";
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return url.href;
    }

    function httpUrl(path) {
      return new URL(String(path).replace(/^\/+/, ""), directoryBase(pageBase())).href;
    }

    function wsUrl(path) {
      const url = new URL(String(path).replace(/^\/+/, ""), directoryBase(transportBase()));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.href;
    }

    /* --------------------------------- 样式 --------------------------------- */
    const S = {
      root: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#0b0b0b", color: "#d0d0d0" },
      toolbar: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid #262626", background: "#141414", flex: "none" },
      navButton: { flex: "none", width: 26, height: 24, padding: 0, border: "1px solid #383838", borderRadius: 6, background: "#222", color: "#e6e6e6", font: "13px/1 system-ui, sans-serif", cursor: "pointer" },
      addressInput: { flex: "1 1 auto", minWidth: 0, height: 24, padding: "0 8px", border: "1px solid #383838", borderRadius: 6, background: "#0f0f0f", color: "#e6e6e6", font: "12px/1 ui-monospace, Consolas, monospace", outline: "none" },
      statusBar: { display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid #262626", background: "#121212", flex: "none" },
      address: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "12px/1.4 ui-monospace, Consolas, monospace", color: "#c9c9c9" },
      badge: { flex: "none", font: "11px/1 system-ui, sans-serif", padding: "3px 6px", borderRadius: 5, border: "1px solid #333", color: "#bbb", background: "#1c1c1c" },
      button: { flex: "none", height: 24, padding: "0 8px", border: "1px solid #383838", borderRadius: 6, background: "#222", color: "#e6e6e6", font: "12px/1 system-ui, sans-serif", cursor: "pointer" },
      tabStrip: { display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", overflowX: "auto", borderBottom: "1px solid #262626", background: "#101010", flex: "none" },
      tabItem: { display: "flex", alignItems: "center", gap: 4, flex: "none", maxWidth: 180, padding: "3px 6px", borderRadius: 5, border: "1px solid #333", background: "#1a1a1a", color: "#c9c9c9", font: "11px/1.3 system-ui, sans-serif", cursor: "pointer" },
      tabItemActive: { display: "flex", alignItems: "center", gap: 4, flex: "none", maxWidth: 180, padding: "3px 6px", borderRadius: 5, border: "1px solid #4c6ef5", background: "#1d2440", color: "#e7ecff", font: "11px/1.3 system-ui, sans-serif", cursor: "pointer" },
      tabLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
      tabClose: { flex: "none", border: "none", background: "transparent", color: "#8a8a8a", cursor: "pointer", font: "12px/1 system-ui, sans-serif", padding: "0 2px" },
      viewport: { flex: "1 1 auto", minHeight: 0, overflow: "hidden", display: "flex", alignItems: "stretch", justifyContent: "stretch", background: "#0b0b0b" },
      embedWrap: { flex: "1 1 auto", minHeight: 0, position: "relative", overflow: "hidden", background: "#ffffff" },
      embedRoot: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
      image: { display: "block", width: "100%", height: "100%", objectFit: "contain", cursor: "default" },
      imageHidden: { display: "none" },
      hint: { margin: 0, padding: 20, color: "#8a8a8a", font: "12px/1.6 ui-monospace, Consolas, monospace", wordBreak: "break-all" },
      err: { margin: 0, padding: 12, color: "#ff8787", font: "12px/1.5 ui-monospace, Consolas, monospace", wordBreak: "break-all" },
      overlay: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.66)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 20 },
      card: { width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 10, border: "1px solid #3a3a3a", background: "#161616", boxShadow: "0 12px 32px rgba(0,0,0,0.5)" },
      cardTitle: { margin: 0, font: "600 13px/1.4 system-ui, sans-serif", color: "#f1f1f1" },
      code: { margin: 0, maxHeight: 180, overflow: "auto", padding: 8, borderRadius: 6, background: "#0b0b0b", border: "1px solid #2a2a2a", color: "#d6d6d6", font: "11px/1.5 ui-monospace, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      cardActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      allowButton: { flex: "none", height: 28, padding: "0 12px", border: "1px solid #2f6f4f", borderRadius: 6, background: "#1d3a2b", color: "#b2f2c9", font: "12px/1 system-ui, sans-serif", cursor: "pointer" },
      // 审批卡：kind 中文副标题与目标（detail 升级成对象后新增的展示位）
      cardSubtitle: { margin: 0, color: "var(--dsw-alias-state-warn-label, #e3b341)", font: "12px/1.4 system-ui, sans-serif" },
      cardTarget: { margin: 0, color: "var(--dsw-alias-label-secondary, #a8a8a8)", font: "11px/1.5 ui-monospace, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      // 内嵌浏览器能力与宿主不一致时的顶部提示条（黄色，不阻塞其余 UI）
      capabilityBar: {
        margin: 0,
        padding: "6px 10px",
        background: "var(--dsw-alias-state-warn-tertiary, rgba(217, 164, 0, 0.12))",
        borderBottom: "1px solid var(--dsw-alias-state-warn-primary, #d9a400)",
        color: "var(--dsw-alias-state-warn-label, #e3b341)",
        font: "12px/1.5 system-ui, sans-serif",
        wordBreak: "break-all",
      },
    };

    const LEASE_LABEL = { agent: "agent 操作中", human: "你在操作", null: "空闲" };

    /* ---------------------- 工具卡：browser_* 调用的一行摘要 --------------------- */
    // DSH 的 tool.call.toolview 槽位按「工具名」分发卡片：注册后 browser_* 调用
    // 在对话流里渲染成紧凑一行（⬡ 动作名 目标 状态点）。
    // props 的字段名是宿主内部契约（toolCall / call / block 几种叫法都出现过），所以
    // 这里每一步都做防御式读取：字段缺失、getter 抛错、参数视图是函数或 JSON 串，
    // 都只降级展示，绝不抛错（工具卡抛错会连累整条对话渲染）。
    const TOOL_NAMES = [
      "browser_open",
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_screenshot",
      "browser_release",
      "browser_tabs",
      "browser_wait_for",
      "browser_eval",
      "browser_upload",
      "browser_dialog",
    ];

    const TOOL_ACTION_LABEL = {
      browser_open: "打开页面",
      browser_snapshot: "快照",
      browser_navigate: "跳转",
      browser_click: "点击",
      browser_type: "输入",
      browser_press: "按键",
      browser_scroll: "滚动",
      browser_screenshot: "截图",
      browser_release: "释放标签",
      browser_tabs: "标签页",
      browser_wait_for: "等待",
      browser_eval: "执行脚本",
      browser_upload: "上传",
      browser_dialog: "对话框",
    };

    const TOOL_STATE_COLOR = {
      running: "var(--dsw-alias-state-warn-primary, #d9a400)",
      success: "var(--dsw-alias-state-success-primary, #2f9e44)",
      error: "var(--dsw-alias-state-error-primary, #c92a2a)",
      unknown: "var(--dsw-alias-label-quaternary, #6b6b6b)",
    };
    const TOOL_STATE_LABEL = { running: "执行中", success: "完成", error: "失败", unknown: "状态未知" };

    const TOOL_CARD_STYLE = {
      row: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        width: "100%",
        padding: "3px 2px",
        color: "var(--dsw-text-primary, #e6e6e6)",
        fontSize: "var(--dsw-font-xs-13, 13px)",
        lineHeight: 1.5,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      },
      icon: { flex: "none", width: 14, textAlign: "center", color: "var(--dsw-alias-state-business-primary, #4c6ef5)", fontSize: 13, lineHeight: 1.2 },
      label: { flex: "none", whiteSpace: "nowrap", fontWeight: 500, color: "var(--dsw-alias-label-primary, var(--dsw-text-primary, #e6e6e6))" },
      target: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, var(--dsw-text-secondary, #8a8a8a))", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "var(--dsw-font-xxs-12, 12px)" },
      dot: { flex: "none", width: 6, height: 6, borderRadius: "50%" },
    };

    function toolCardSources(props) {
      const sources = [];
      const push = (value) => {
        if (value !== null && value !== undefined && typeof value === "object") sources.push(value);
      };
      try {
        push(props?.toolCall);
        push(props?.call);
        push(props?.block);
        push(props?.toolCall?.call);
        push(props?.call?.call);
        push(props?.block?.call);
        push(props);
      } catch {
        // props 是 Proxy / getter 抛错时，退化为只用 props 本身
        try { push(props); } catch {}
      }
      return sources;
    }

    function toolCardField(sources, keys) {
      for (const source of sources) {
        for (const key of keys) {
          try {
            const value = source[key];
            if (value !== undefined && value !== null && value !== "") return value;
          } catch {}
        }
      }
      return undefined;
    }

    function toolCardJson(raw) {
      if (typeof raw !== "string" || raw === "") return undefined;
      try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }

    function toolCardArgs(sources) {
      // 1) 原始 JSON 串（preparing 的懒参数、result 的 call.argsRaw 最可靠）
      for (const source of sources) {
        for (const key of ["argsRaw", "argumentsRaw", "rawArguments", "argsJson"]) {
          try {
            const parsed = toolCardJson(source[key]);
            if (parsed !== undefined) return parsed;
          } catch {}
        }
      }
      // 2) 已是对象 / 函数 / JSON 串的参数
      for (const source of sources) {
        for (const key of ["arguments", "input", "args", "params", "parameters"]) {
          try {
            let candidate = source[key];
            if (candidate === undefined || candidate === null) continue;
            if (typeof candidate === "function") {
              try { candidate = candidate(); } catch { continue; }
            }
            if (candidate !== null && candidate !== undefined && typeof candidate === "object") return candidate;
            const parsed = toolCardJson(candidate);
            if (parsed !== undefined) return parsed;
          } catch {}
        }
      }
      return null;
    }

    function toolCardArgValue(view, key) {
      if (view === null || view === undefined) return undefined;
      try {
        // DSH 的参数视图通常提供 text(key) 取值（也是唯一不会读取到方法本体的方式）
        if (typeof view.text === "function") {
          try {
            const text = view.text(key);
            if (text !== undefined && text !== null && text !== "") return text;
          } catch {}
        }
        if (typeof view.get === "function") {
          try {
            const got = view.get(key);
            if (got !== undefined && got !== null && got !== "") return got;
          } catch {}
        }
        const direct = view[key];
        if (typeof direct !== "function" && direct !== undefined && direct !== null && direct !== "") return direct;
      } catch {}
      return undefined;
    }

    function toolCardText(value) {
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (Array.isArray(value)) return value.map((item) => toolCardText(item)).filter((item) => item !== "").join(", ");
      if (typeof value === "object") {
        try { return JSON.stringify(value); } catch { return ""; }
      }
      return "";
    }

    // 每个工具挑一个最有辨识度的参数做「目标」，统一截断到 60 字。
    function toolCardTarget(name, view) {
      if (view === null || view === undefined) return "";
      const pick = (...keys) => {
        for (const key of keys) {
          const value = toolCardArgValue(view, key);
          if (value !== undefined && value !== null && value !== "") return value;
        }
        return undefined;
      };
      let value;
      try {
        if (name === "browser_open" || name === "browser_navigate") {
          value = pick("url");
        } else if (name === "browser_click") {
          const ref = pick("ref");
          value = ref !== undefined ? `ref ${toolCardText(ref)}` : pick("text");
          if (value === undefined) {
            const x = pick("x");
            const y = pick("y");
            if (x !== undefined && y !== undefined) value = `${toolCardText(x)}, ${toolCardText(y)}`;
          }
        } else if (name === "browser_type") {
          value = pick("text");
        } else if (name === "browser_press") {
          value = pick("key");
        } else if (name === "browser_scroll") {
          const ref = pick("ref");
          if (ref !== undefined) {
            value = `ref ${toolCardText(ref)}`;
          } else {
            const deltaY = pick("deltaY");
            const direction = pick("direction");
            if (deltaY !== undefined) value = `Δy ${toolCardText(deltaY)}`;
            else if (direction !== undefined) value = toolCardText(direction);
          }
        } else if (name === "browser_screenshot") {
          value = pick("path");
          if (value === undefined && pick("fullPage") === true) value = "整页";
        } else if (name === "browser_release") {
          const tabId = pick("tabId");
          value = tabId !== undefined ? `tab ${toolCardText(tabId)}` : "全部标签";
        } else if (name === "browser_tabs") {
          const parts = [pick("action"), pick("tabId"), pick("url")].map((item) => toolCardText(item)).filter((item) => item !== "");
          if (parts.length > 0) value = parts.join(" · ");
        } else if (name === "browser_wait_for") {
          value = pick("text", "selector", "url", "time", "timeoutMs", "state");
        } else if (name === "browser_eval") {
          value = pick("expression");
        } else if (name === "browser_upload") {
          value = pick("path", "filePath", "files", "ref");
        } else if (name === "browser_dialog") {
          const accept = pick("accept");
          const action = pick("action");
          const promptText = pick("promptText");
          if (accept === true) value = "接受";
          else if (accept === false) value = "拒绝";
          else if (promptText !== undefined) value = toolCardText(promptText);
          else if (action !== undefined) value = toolCardText(action);
        } else {
          value = pick("url", "ref", "text", "path");
        }
      } catch {
        return "";
      }
      const text = toolCardText(value).replace(/\s+/g, " ").trim();
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }

    function toolCardFailed(sources, block) {
      if (toolCardField(sources, ["isError", "is_error"]) === true) return true;
      const error = toolCardField(sources, ["error"]);
      if (error !== undefined && error !== null && error !== false) return true;
      try {
        const output = block === null || block === undefined ? undefined : block.output;
        if (output !== null && typeof output === "object") {
          if (output.isError === true) return true;
          if (output.error !== undefined && output.error !== null) return true;
        }
      } catch {}
      return false;
    }

    // status/state/phase 三种叫法都兼容；phase 是官方契约里的判别字段。
    function toolCardStatus(sources, block) {
      const failed = toolCardFailed(sources, block);
      const raw = toolCardField(sources, ["status", "state", "phase"]);
      const phase = raw === undefined || raw === null ? "" : String(raw).toLowerCase();
      if (["error", "failed", "failure", "interrupted", "aborted", "cancelled", "canceled", "denied"].includes(phase)) return "error";
      if (phase === "result") return failed ? "error" : "success";
      if (["start", "started", "running", "preparing", "pending", "queued", "streaming", "progress"].includes(phase)) return "running";
      if (["success", "succeeded", "completed", "complete", "done", "ok", "finished"].includes(phase)) return "success";
      if (failed) return "error";
      if (toolCardField(sources, ["result", "output"]) !== undefined) return "success";
      return "unknown";
    }

    function toolCardModel(props) {
      const sources = toolCardSources(props);
      const name = toolCardText(toolCardField(sources, ["toolName", "name"])).trim();
      const label = TOOL_ACTION_LABEL[name] ?? (name === "" ? "浏览器操作" : name);
      const view = toolCardArgs(sources);
      const target = toolCardTarget(name, view);
      const status = toolCardStatus(sources, props?.block);
      return { name, label, target, status };
    }

    /**
     * browser_* 工具卡：⬡ 动作名 目标 状态色点。
     * 整个渲染包在 try/catch 里：任何宿主 props 变化都只会退化成一行「浏览器操作」。
     */
    function ToolCard(props) {
      let model = null;
      try { model = toolCardModel(props); } catch {}
      if (model === null) {
        return jsx("div", {
          style: TOOL_CARD_STYLE.row,
          children: jsx("span", { style: TOOL_CARD_STYLE.label, children: "浏览器操作" }),
        });
      }
      const state = TOOL_STATE_COLOR[model.status] === undefined ? "unknown" : model.status;
      return jsxs("div", {
        "data-agent-browser-tool": model.name === "" ? "browser" : model.name,
        style: TOOL_CARD_STYLE.row,
        title: `${model.label}${model.target === "" ? "" : ` · ${model.target}`}（${TOOL_STATE_LABEL[state]}）`,
        children: [
          jsx("span", { style: TOOL_CARD_STYLE.icon, "aria-hidden": "true", children: "⬡" }),
          jsx("span", { style: TOOL_CARD_STYLE.label, children: model.label }),
          model.target === "" ? null : jsx("span", { style: TOOL_CARD_STYLE.target, children: model.target }),
          jsx("span", {
            style: { ...TOOL_CARD_STYLE.dot, background: TOOL_STATE_COLOR[state] },
            title: TOOL_STATE_LABEL[state],
            "aria-label": TOOL_STATE_LABEL[state],
          }),
        ],
      });
    }

    /* ------------------------- 审批卡：kind 副标题 / 目标 ------------------------- */
    // 宿主的 approval 消息历史上是 { id, title, detail:string }；现在 detail 可能升级成
    // { kind, target, ... }（upload/dialog/navigate/eval）。统一归一化后再渲染，
    // 绝不把对象直接当 React 文本子节点（那会抛 "Objects are not valid as a React child"）。
    const APPROVAL_KIND_LABEL = {
      upload: "上传文件",
      dialog: "页面对话框",
      navigate: "跳转确认",
      eval: "执行脚本",
    };

    function approvalKindOf(value) {
      if (value === null || value === undefined || typeof value !== "object") return "";
      try {
        const kind = value.kind;
        return typeof kind === "string" ? kind.trim().toLowerCase() : "";
      } catch {
        return "";
      }
    }

    function approvalKind(msg) {
      const fromDetail = approvalKindOf(msg?.detail);
      if (fromDetail !== "") return fromDetail;
      return approvalKindOf(msg);
    }

    function approvalTarget(msg) {
      const detail = msg?.detail;
      if (detail !== null && detail !== undefined && typeof detail === "object") {
        try {
          if (typeof detail.target === "string" && detail.target !== "") return detail.target;
          if (typeof detail.url === "string" && detail.url !== "") return detail.url;
        } catch {}
      }
      try {
        return typeof msg?.target === "string" ? msg.target : "";
      } catch {
        return "";
      }
    }

    function approvalDetailText(detail) {
      if (detail === null || detail === undefined) return "";
      if (typeof detail === "string") return detail;
      try {
        return JSON.stringify(detail, null, 2) ?? "";
      } catch {
        return "";
      }
    }

    /* -------------------------------- 页面组件 ------------------------------- */
    // 侧栏面板标题栏自带「全屏 / 还原」按钮；tab body 的注入 props 里没有 toggleFullscreen，
    // 所以统一通过「点宿主自己的全屏控件」来切换，行为与用户点面板按钮完全一致。
    function panelChromeFullscreenButton() {
      const panel = document.querySelector("[data-sidebar-right-panel]");
      if (panel === null) return null;
      const buttons = [...panel.querySelectorAll("button")];
      return buttons.find((b) => b.closest("[data-agent-browser-pane]") === null && /全屏|还原/.test(b.getAttribute("aria-label") || b.getAttribute("title") || "")) ?? null;
    }
    function panelIsFullscreen() {
      const panel = document.querySelector("[data-sidebar-right-panel]");
      return panel !== null && panel.getAttribute("data-sidebar-right-panel") === "fullscreen";
    }

    /* --------------------- 嵌入模式：侧栏里的真 <webview> --------------------- */
    // 宿主打过 webviewTag 补丁后，渲染进程可以创建 <webview>：页面由 Electron 原生渲染，
    // 不经过 JPEG 帧流，人看到的就是真实浏览器画面（零延迟）。
    // agent 的工具调用从 host 经 WS 的 rpc 消息转到这里，直接调用 webview 的 API。

    const WEBVIEW_SUPPORTED = (() => {
      try {
        const el = document.createElement("webview");
        return typeof el.loadURL === "function" || typeof el.getWebContentsId === "function";
      } catch { return false; }
    })();

    // 能力探测：只有宿主打过 webviewTag 补丁，Electron 才会把 <webview> 注册成带
    // getURL / canGoBack 的自定义元素。像素流回退不需要它；探测结果通过 WS 的
    // capability 消息上报给宿主，宿主据此决定走内嵌模式还是像素流模式。
    function webviewCapable() {
      try {
        const el = document.createElement("webview");
        return typeof el.getURL === "function" && typeof el.canGoBack === "function";
      } catch {
        return false;
      }
    }

    // 与 lib/engine.js 里的注入脚本保持同一份语义（快照 eN 引用、ref 居中、清空输入）。
    const SNAPSHOT_SCRIPT = String.raw`
(() => {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true]';
  if (!window.__abRefs || window.__abSeq === undefined) {
    window.__abRefs = new WeakMap();
    window.__abByRef = new Map();
    window.__abSeq = 0;
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const textOf = (el) => {
    const raw = el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      return ty === 'checkbox' || ty === 'radio' ? ty : 'textbox';
    }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'select';
    return t === 'summary' ? 'button' : 'element';
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const label = textOf(el);
    const role = roleOf(el);
    if (!label && role !== 'textbox') continue;
    let ref = window.__abRefs.get(el);
    if (!ref) {
      ref = 'e' + (++window.__abSeq);
      window.__abRefs.set(el, ref);
      window.__abByRef.set(ref, el);
    }
    out.push({
      ref, role,
      label: label || (el.getAttribute('type') ? '[' + el.getAttribute('type') + ']' : ''),
      value: el.value !== undefined && el.value !== null ? String(el.value).slice(0, 200) : undefined,
      href: el.tagName === 'A' && el.href ? String(el.href).slice(0, 300) : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
    if (out.length >= 300) break;
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), scrollH: Math.round(document.documentElement.scrollHeight) },
    text: String(document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 4000),
    elements: out,
  };
})()
`;

    const STATE_SCRIPT = String.raw`
(() => ({
  url: location.href,
  title: document.title,
  viewport: {
    w: innerWidth,
    h: innerHeight,
    scrollY: Math.round(scrollY),
    scrollH: Math.round(document.documentElement.scrollHeight),
  },
}))()
`;

    const REF_CENTER_SCRIPT = (ref) => String.raw`
(() => {
  const el = window.__abByRef && window.__abByRef.get(${JSON.stringify(ref)});
  if (!el) return { ok: false, reason: 'stale-ref' };
  if (!el.isConnected) return { ok: false, reason: 'detached' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, reason: 'invisible' };
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName.toLowerCase() };
})()
`;

    const FOCUS_SCRIPT = (ref, clear) => String.raw`
(() => {
  const el = window.__abByRef && window.__abByRef.get(${JSON.stringify(ref)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  try { el.focus(); } catch (e) {}
  if (${clear ? "true" : "false"}) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, ''); else if ('value' in el) el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()
`;

    // 页面内探测「真人操作」：<webview> 里没有 CDP binding，用 console.log 把消息带到嵌入页。
    const HUMAN_INPUT_SCRIPT = String.raw`
(() => {
  if (window.__abHumanHooked) return;
  window.__abHumanHooked = true;
  let last = 0;
  const ping = (kind) => {
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    try { console.log('__AB_HUMAN__|' + kind); } catch (e) {}
  };
  window.addEventListener('pointerdown', () => ping('pointer'), true);
  window.addEventListener('keydown', () => ping('key'), true);
  window.addEventListener('wheel', () => ping('wheel'), { capture: true, passive: true });
})()
`;

    const KEY_CODES = {
      Enter: "Enter",
      Tab: "Tab",
      Escape: "Escape",
      Backspace: "Backspace",
      Delete: "Delete",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      PageDown: "PageDown",
      PageUp: "PageUp",
      Home: "Home",
      End: "End",
    };

    /**
     * 一个极简的「webview 管理器」：负责创建/切换/销毁标签页，并把 host 的 rpc 方法
     * 翻译成 webview 的 executeJavaScript / sendInputEvent / insertText / capturePage。
     */
    function createEmbeddedBrowser({ send, onNavigate }) {
      /** @type {HTMLElement | null} */
      let root = null;
      let seq = 0;
      /** @type {Array<{id:string, wv:any, url:string, title:string, viewport:any}>} */
      const tabs = [];
      let activeId = null;
      let humanAt = 0;

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const active = () => tabs.find((tab) => tab.id === activeId) ?? null;
      const list = () => tabs.map((tab) => ({ targetId: tab.id, url: tab.url, title: tab.title, active: tab.id === activeId }));
      const viewportOf = () => (active()?.viewport ?? null);

      function emitState() {
        const tab = active();
        try {
          send({
            type: "browser-state",
            url: tab?.url ?? "about:blank",
            title: tab?.title ?? "",
            tabs: list(),
            viewport: tab?.viewport ?? null,
          });
        } catch {}
      }

      function waitEvent(wv, names, timeoutMs) {
        return new Promise((resolve, reject) => {
          let done = false;
          const finish = (ok, error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const name of names) wv.removeEventListener(name, onEvent);
            if (ok) resolve();
            else reject(error ?? new Error("页面加载超时"));
          };
          const onEvent = () => finish(true);
          for (const name of names) wv.addEventListener(name, onEvent);
          const timer = setTimeout(() => finish(false), timeoutMs);
        });
      }

      async function refresh(tab) {
        if (!tab || !tab.wv.isConnected) return;
        try {
          const info = await tab.wv.executeJavaScript(STATE_SCRIPT, false);
          if (info && typeof info === "object") {
            tab.url = String(info.url ?? tab.url);
            tab.title = String(info.title ?? "");
            if (info.viewport) tab.viewport = { width: info.viewport.w, height: info.viewport.h, dpr: Math.round((window.devicePixelRatio || 1) * 10) / 10 };
          }
        } catch {}
      }

      function wire(tab) {
        const wv = tab.wv;
        wv.addEventListener("dom-ready", () => {
          wv.executeJavaScript(HUMAN_INPUT_SCRIPT, false).catch(() => {});
          void refresh(tab).then(() => emitState());
        });
        const afterNav = () => { void refresh(tab).then(() => { emitState(); onNavigate?.(tab.url); }); };
        wv.addEventListener("did-navigate", afterNav);
        wv.addEventListener("did-navigate-in-page", afterNav);
        wv.addEventListener("page-title-updated", (event) => { tab.title = String(event?.title ?? tab.title); emitState(); });
        wv.addEventListener("console-message", (event) => {
          const message = String(event?.message ?? "");
          if (!message.startsWith("__AB_HUMAN__|")) return;
          const now = Date.now();
          if (now - humanAt < 500) return;
          humanAt = now;
          try { send({ type: "human-input", kind: message.slice("__AB_HUMAN__|".length) }); } catch {}
        });
      }

      function setActive(id) {
        activeId = id;
        for (const tab of tabs) {
          const show = tab.id === id;
          tab.wv.style.display = show ? "block" : "none";
        }
        emitState();
      }

      function createTab(url) {
        const id = `t${++seq}`;
        const wv = document.createElement("webview");
        wv.setAttribute("src", url || "about:blank");
        wv.setAttribute("allowpopups", "");
        wv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:block;";
        const tab = { id, wv, url: url || "about:blank", title: "", viewport: null };
        tabs.push(tab);
        root?.appendChild(wv);
        wire(tab);
        setActive(id);
        return tab;
      }

      function destroyTab(tab) {
        try { tab.wv.remove(); } catch {}
        const index = tabs.indexOf(tab);
        if (index >= 0) tabs.splice(index, 1);
      }

      async function state() {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        await refresh(tab);
        return { url: tab.url, title: tab.title, viewport: tab.viewport ? { w: tab.viewport.width, h: tab.viewport.height, scrollY: 0, scrollH: 0 } : { w: 0, h: 0, scrollY: 0, scrollH: 0 } };
      }

      async function snapshot() {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        const snap = await tab.wv.executeJavaScript(SNAPSHOT_SCRIPT, false);
        if (snap && typeof snap === "object") {
          tab.url = String(snap.url ?? tab.url);
          tab.title = String(snap.title ?? tab.title);
        }
        return snap;
      }

      async function navigate(url) {
        const tab = active() ?? createTab(url);
        const target = String(url || "about:blank");
        if (tab.wv.getURL && tab.wv.getURL() === target) {
          try { tab.wv.reload(); } catch {}
        } else {
          await tab.wv.loadURL(target).catch(() => {});
        }
        await waitEvent(tab.wv, ["did-stop-loading"], 20_000).catch(() => {});
        await sleep(60);
        await refresh(tab);
        emitState();
        return { url: tab.url, title: tab.title };
      }

      async function history(delta) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        if (delta < 0) {
          if (!tab.wv.canGoBack()) throw new Error("已经到最前面了");
          tab.wv.goBack();
        } else {
          if (!tab.wv.canGoForward()) throw new Error("已经到最后面了");
          tab.wv.goForward();
        }
        await waitEvent(tab.wv, ["did-stop-loading"], 20_000).catch(() => {});
        await sleep(60);
        await refresh(tab);
        emitState();
        return { url: tab.url, title: tab.title };
      }

      async function click(params) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        let x = Number(params?.x);
        let y = Number(params?.y);
        if (params?.ref) {
          const center = await tab.wv.executeJavaScript(REF_CENTER_SCRIPT(String(params.ref)), false);
          if (!center?.ok) throw new Error(`引用 ${params.ref} 已失效（${center?.reason ?? "未知原因"}），请重新 snapshot`);
          x = center.x;
          y = center.y;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click 需要 ref 或 x/y");
        tab.wv.sendInputEvent({ type: "mouseMove", x, y });
        tab.wv.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        tab.wv.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        return { x, y };
      }

      async function type(params) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        if (params?.ref) await tab.wv.executeJavaScript(FOCUS_SCRIPT(String(params.ref), Boolean(params.clear)), false);
        tab.wv.insertText(String(params?.text ?? ""));
        return true;
      }

      async function press(params) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        const name = String(params?.key ?? "");
        const keyCode = KEY_CODES[name];
        if (!keyCode) throw new Error(`不支持的按键：${name}`);
        tab.wv.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode === "Enter") tab.wv.sendInputEvent({ type: "char", keyCode: "\r" });
        tab.wv.sendInputEvent({ type: "keyUp", keyCode });
        return true;
      }

      async function scroll(params) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        const deltaY = Number(params?.deltaY ?? 600);
        const result = await tab.wv.executeJavaScript(`(() => { window.scrollBy(0, ${deltaY}); return { x: Math.round(scrollX), y: Math.round(scrollY) }; })()`, false);
        return result ?? { x: 0, y: 0 };
      }

      async function screenshot() {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        const image = await tab.wv.capturePage();
        const data = image?.toDataURL ? image.toDataURL() : null;
        if (!data) throw new Error("截图失败：没有拿到图像");
        return { data, format: "png" };
      }

      async function evaluate(expression) {
        const tab = active();
        if (!tab) throw new Error("嵌入浏览器还没有打开标签页");
        return tab.wv.executeJavaScript(String(expression), true);
      }

      async function tabsAction(params) {
        const action = String(params?.action ?? "list");
        if (action === "list") return list();
        if (action === "new") {
          const tab = createTab(params?.url ? String(params.url) : "about:blank");
          await waitEvent(tab.wv, ["dom-ready"], 15_000).catch(() => {});
          await refresh(tab);
          emitState();
          return list();
        }
        const wanted = String(params?.tabId ?? "");
        const tab = tabs.find((candidate) => candidate.id === wanted) ?? tabs.find((candidate) => candidate.id.startsWith(wanted));
        if (!tab) throw new Error(`没有找到标签页：${wanted}`);
        if (action === "select") { setActive(tab.id); return list(); }
        if (action === "close") {
          if (tabs.length <= 1) throw new Error("不能关闭最后一个标签（关闭面板时浏览器会自动结束）");
          destroyTab(tab);
          if (activeId === tab.id || !tabs.some((candidate) => candidate.id === activeId)) setActive(tabs[0].id);
          emitState();
          return list();
        }
        throw new Error(`未知 action：${action}`);
      }

      const api = {
        async start() {
          if (tabs.length === 0) {
            const tab = createTab("about:blank");
            await waitEvent(tab.wv, ["dom-ready"], 15_000).catch(() => {});
            await refresh(tab);
          }
          emitState();
          return { viewport: viewportOf(), tabs: list() };
        },
        state,
        snapshot,
        navigate: (params) => navigate(String(params?.url ?? "about:blank")),
        history: (params) => history(Number(params?.delta ?? -1)),
        click,
        type,
        press,
        scroll,
        screenshot,
        eval: (params) => evaluate(params?.expression),
        tabs: tabsAction,
        focus: async () => true,
        async close() {
          for (const tab of [...tabs]) destroyTab(tab);
          activeId = null;
        },
        attach(el) { root = el; },
        dispatch(method, params) {
          const fn = api[method];
          if (typeof fn !== "function") throw new Error(`嵌入浏览器不支持的方法：${method}`);
          return fn(params ?? {});
        },
        poke() { emitState(); },
        listTabs: list,
      };
      return api;
    }

    function AgentBrowserPane(props) {
      const toggleFullscreen = () => {
        const button = panelChromeFullscreenButton();
        if (button === null) return false;
        button.click();
        return true;
      };
      const canToggleFullscreen = typeof document !== "undefined";
      const [status, setStatus] = useState("connecting");
      const [hasFrame, setHasFrame] = useState(false);
      const [address, setAddress] = useState("");
      const [addressInput, setAddressInput] = useState("");
      const [title, setTitle] = useState("");
      const [viewport, setViewport] = useState({ width: 1280, height: 800 });
      const [leaseHolder, setLeaseHolder] = useState(null);
      const [tabs, setTabs] = useState([]);
      const [approval, setApproval] = useState(null);
      const [error, setError] = useState(null);
      const [reconnectToken, setReconnectToken] = useState(0);
      // 原生窗口模式：浏览器在独立原生窗口里跑（人直接操作 = 零流式延迟），侧栏是控制台 + 可选镜像。
      const [nativeWindow, setNativeWindow] = useState(false);
      const [mirrorOn, setMirrorOn] = useState(false);
      // 嵌入模式：浏览器就是本面板里的一个 <webview>（宿主打过 webviewTag 补丁）。
      const [embeddedOn, setEmbeddedOn] = useState(false);
      // 宿主说 embedded=true，但本渲染进程其实没有可用的 <webview>（桌面端没打补丁）：
      // 顶部显示一条黄色提示，其余 UI 照常回退到像素流/原生窗口，不阻塞操作。
      const [capabilityFallback, setCapabilityFallback] = useState(false);
      const embeddedRef = useRef(false);
      const browserRef = useRef(null);
      const embedRootRef = useRef(null);

      const frameSrcRef = useRef(null);
      const imgRef = useRef(null);
      const pendingFrameRef = useRef(null);
      const rafRef = useRef(null);
      const hasFrameRef = useRef(false);
      const editingRef = useRef(false);
      const pendingNavRef = useRef(false);
      const addressRef = useRef("");
      const viewportRef = useRef(viewport);
      const socketRef = useRef(null);
      const wheelRef = useRef({ at: 0, acc: 0 });
      const containerRef = useRef(null);
      const sentViewportRef = useRef({ width: 0, height: 0 });
      const autoExpandRef = useRef(false);
      const resizeTimerRef = useRef(null);
      const nativeRef = useRef(false);
      const mirrorRef = useRef(false);

      viewportRef.current = viewport;

      // 统一处理 hello/state 里的 embedded 字段：同步嵌入模式，并记录「宿主开了内嵌、
      // 本端却没有 webview 能力」的降级状态（只在真正探测失败时置位）。
      const syncEmbedded = (value) => {
        const next = Boolean(value);
        embeddedRef.current = next;
        setEmbeddedOn(next);
        setCapabilityFallback(next && !webviewCapable());
      };

      /** 把右栏实际可见尺寸告诉宿主：浏览器视口 = 你看到的这块区域（全屏时就是桌面浏览器尺寸）。 */
      const sendViewport = (force = false) => {
        if (nativeRef.current) return; // 原生窗口模式：视口由真实窗口决定
        if (embeddedRef.current) return; // 嵌入模式：<webview> 自己就是真实尺寸，不需要同步视口
        const el = containerRef.current;
        if (el === null) return;
        const rect = el.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (width < 240 || height < 200) return;
        const last = sentViewportRef.current;
        if (!force && Math.abs(width - last.width) < 6 && Math.abs(height - last.height) < 6) return;
        sentViewportRef.current = { width, height };
        const dpr = Math.min(2, Math.max(1, Math.round((globalThis.devicePixelRatio || 1) * 10) / 10));
        try { socketRef.current?.send?.(JSON.stringify({ type: "viewport", width, height, dpr })); } catch {}
      };

      // 尺寸跟踪：窗口/侧栏拖动/全屏切换都会触发
      useEffect(() => {
        const el = containerRef.current;
        if (el === null) return;
        const schedule = () => {
          if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => { resizeTimerRef.current = null; sendViewport(); }, 120);
        };
        schedule();
        if (typeof ResizeObserver !== "function") return () => {};
        const observer = new ResizeObserver(schedule);
        observer.observe(el);
        return () => {
          if (resizeTimerRef.current !== null) { clearTimeout(resizeTimerRef.current); resizeTimerRef.current = null; }
          observer.disconnect();
        };
      }, []);

      useEffect(() => { if (status === "live") sendViewport(true); }, [status]);

      // 第一次打开时，如果右栏还在窄模式，自动展开一次（浏览器需要桌面宽度；同一个标签页内不反复展开）。
      useEffect(() => {
        if (autoExpandRef.current || !canToggleFullscreen) return;
        autoExpandRef.current = true;
        let alreadyExpanded = false;
        try { alreadyExpanded = sessionStorage.getItem("dsh-agent-browser:autoFullscreen") === "1"; } catch {}
        if (panelIsFullscreen() || alreadyExpanded) return;
        try { sessionStorage.setItem("dsh-agent-browser:autoFullscreen", "1"); } catch {}
        const timer = setTimeout(() => {
          if (nativeRef.current) return; // 原生窗口模式不需要全屏侧栏
          try { toggleFullscreen(); } catch {}
        }, 900);
        return () => clearTimeout(timer);
      }, []);

      useEffect(() => () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        pendingFrameRef.current = null;
        if (frameSrcRef.current !== null) URL.revokeObjectURL(frameSrcRef.current);
        frameSrcRef.current = null;
      }, []);

      useEffect(() => {
        let disposed = false;
        let socket = null;
        let retryTimer = null;
        let attempt = 0;
        // 静止高清帧的「防闪烁」状态：收到 HD 帧后进入高清模式，之后的零星流式帧
        // （光标闪烁、局部重绘）直接丢掉；只有连续 2 帧（<400ms 内）才判定为真实运动，切回流式。
        let hdMode = false;
        let expectHd = false;
        let liveTimes = [];

        // 帧在 rAF 里合并：只画最新一帧，避免每帧触发 React 重渲染。
        const flushFrame = () => {
          rafRef.current = null;
          const payload = pendingFrameRef.current;
          pendingFrameRef.current = null;
          if (disposed || payload === null) return;
          const img = imgRef.current;
          if (img === null) return;
          const blob = payload instanceof Blob ? payload : new Blob([payload], { type: "image/jpeg" });
          const next = URL.createObjectURL(blob);
          const previous = frameSrcRef.current;
          frameSrcRef.current = next;
          img.src = next;
          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }
          if (previous !== null) {
            if (typeof img.decode === "function") {
              img.decode().catch(() => {}).finally(() => URL.revokeObjectURL(previous));
            } else {
              setTimeout(() => URL.revokeObjectURL(previous), 1500);
            }
          }
        };

        const publishFrame = (payload) => {
          pendingFrameRef.current = payload;
          if (rafRef.current !== null) return;
          rafRef.current = requestAnimationFrame(flushFrame);
        };

        const handleText = (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg.type === "rpc") {
            // host → 渲染进程：agent 的工具调用（嵌入模式下浏览器就在这个面板里）。
            const reply = (ok, value, error) => {
              try { socketRef.current?.send?.(JSON.stringify({ type: "rpc-result", id: msg.id, ok, value, error })); } catch {}
            };
            const browser = browserRef.current;
            if (browser === null) { reply(false, undefined, "嵌入浏览器还没准备好（面板还在加载）"); return; }
            Promise.resolve()
              .then(() => browser.dispatch(String(msg.method), msg.params ?? {}))
              .then((value) => reply(true, value))
              .catch((error) => reply(false, undefined, String(error?.message ?? error)));
            return;
          }
          if (msg.type === "hello") {
            if (msg.viewport) setViewport({ width: msg.viewport.width, height: msg.viewport.height });
            if (msg.lease) setLeaseHolder(msg.lease.holder);
            if (Array.isArray(msg.tabs)) setTabs(msg.tabs);
            if (msg.nativeWindow !== undefined) { nativeRef.current = Boolean(msg.nativeWindow); setNativeWindow(Boolean(msg.nativeWindow)); }
            if (msg.mirror !== undefined) { mirrorRef.current = Boolean(msg.mirror); setMirrorOn(Boolean(msg.mirror)); }
            if (msg.embedded !== undefined) syncEmbedded(msg.embedded);
            return;
          }
          if (msg.type === "state") {
            addressRef.current = msg.url ?? "";
            pendingNavRef.current = false;
            setAddress(msg.url ?? "");
            if (!editingRef.current) setAddressInput(msg.url ?? "");
            setTitle(msg.title ?? "");
            if (msg.viewport) setViewport({ width: msg.viewport.width, height: msg.viewport.height });
            if (msg.lease) setLeaseHolder(msg.lease.holder);
            if (Array.isArray(msg.tabs)) setTabs(msg.tabs);
            if (msg.nativeWindow !== undefined) { nativeRef.current = Boolean(msg.nativeWindow); setNativeWindow(Boolean(msg.nativeWindow)); }
            if (msg.mirror !== undefined) { mirrorRef.current = Boolean(msg.mirror); setMirrorOn(Boolean(msg.mirror)); }
            if (msg.embedded !== undefined) syncEmbedded(msg.embedded);
            return;
          }
          if (msg.type === "approval") {
            // detail 兼容字符串（旧格式）与 { kind, target, ... }（新格式）：
            // 统一归一化成纯文本 + 中文副标题 + 目标，渲染侧不再直接消费 detail。
            const kind = approvalKind(msg);
            setApproval({
              id: msg.id,
              title: typeof msg.title === "string" ? msg.title : "",
              kind,
              kindLabel: APPROVAL_KIND_LABEL[kind] ?? "",
              target: approvalTarget(msg),
              detail: approvalDetailText(msg.detail),
            });
            return;
          }
          if (msg.type === "frame" && msg.mode === "hd") { expectHd = true; return; }
          if (msg.type === "lease") { setLeaseHolder(msg.lease ? msg.lease : null); return; }
          if (msg.type === "error") { setError(String(msg.message ?? "未知错误")); return; }
        };

        const scheduleRetry = () => {
          const delay = Math.min(500 * Math.pow(2, attempt), 10000);
          attempt += 1;
          retryTimer = setTimeout(connect, delay);
        };

        const connect = () => {
          if (disposed) return;
          retryTimer = null;
          hdMode = false;
          expectHd = false;
          liveTimes = [];
          setStatus("connecting");
          const next = new WebSocket(wsUrl(WS_PATH));
          next.binaryType = "arraybuffer";
          next.onopen = () => {
            if (disposed) return;
            attempt = 0;
            setStatus("live");
            setError(null);
            // 能力上报：告诉宿主本渲染进程是否真的能创建 <webview>（决定宿主走内嵌还是像素流）。
            // 与 viewport 消息并列发送；宿主端对未知类型是静默忽略的，旧版本也不会报错。
            try { next.send(JSON.stringify({ type: "capability", webview: webviewCapable() })); } catch {}
          };
          next.onmessage = (event) => {
            if (disposed) return;
            if (typeof event.data === "string") { handleText(event.data); return; }
            if (expectHd) { expectHd = false; hdMode = true; liveTimes = []; publishFrame(event.data); return; }
            if (hdMode) {
              const now = Date.now();
              liveTimes = liveTimes.filter((t) => now - t < 500);
              liveTimes.push(now);
              // 只有连续的流式帧才算「画面在动」：光标闪烁、局部重绘只会来一两帧，
              // 不能让它们把高清画面顶掉，否则观感就是「一会清楚一会糊」。
              if (liveTimes.length < 3) return;
              hdMode = false;
              liveTimes = [];
            }
            publishFrame(event.data);
          };
          next.onerror = () => {};
          next.onclose = () => { if (disposed) return; setStatus("closed"); scheduleRetry(); };
          socket = next;
          socketRef.current = next;
        };

        connect();
        return () => {
          disposed = true;
          if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
          pendingFrameRef.current = null;
          if (retryTimer !== null) clearTimeout(retryTimer);
          if (socket !== null) {
            socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
            socket.close();
          }
          socketRef.current = null;
        };
      }, [reconnectToken]);

      // 嵌入模式：挂载一个真正的 <webview>（Electron 原生渲染），并把它注册给 host 作为 RPC 执行端。
      useEffect(() => {
        if (!embeddedOn || !WEBVIEW_SUPPORTED) return;
        const el = embedRootRef.current;
        if (el === null) return;
        if (browserRef.current === null) {
          const browser = createEmbeddedBrowser({
            send: (payload) => { try { socketRef.current?.send?.(JSON.stringify(payload)); } catch {} },
          });
          browser.attach(el);
          browserRef.current = browser;
          browser.start().catch((error) => setError(String(error?.message ?? error)));
        }
        if (status === "live") {
          try { socketRef.current?.send?.(JSON.stringify({ type: "embedded-hello" })); } catch {}
          try { browserRef.current?.poke?.(); } catch {}
        }
      }, [embeddedOn, status]);

      useEffect(() => () => {
        const browser = browserRef.current;
        browserRef.current = null;
        void browser?.close?.();
      }, []);

      /* 人在这里点一下 = 真实鼠标点击（坐标映射回 420x860 视口） */
      const onClickImage = async (event) => {
        const img = event.currentTarget;
        const rect = img.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const vp = viewportRef.current;
        const x = Math.round(((event.clientX - rect.left) / rect.width) * vp.width);
        const y = Math.round(((event.clientY - rect.top) / rect.height) * vp.height);
        try {
          const res = await fetch(httpUrl(`${API_PATH}/command`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "click", x, y }),
          });
          const data = await res.json().catch(() => ({}));
          if (data.ok === false) setError(String(data.error ?? "点击失败"));
          else setError(null);
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      };

      const onWheelImage = (event) => {
        const vp = viewportRef.current;
        const img = event.currentTarget;
        const rect = img.getBoundingClientRect();
        if (rect.height <= 0) return;
        const dy = Math.round((event.deltaY / rect.height) * vp.height);
        const slot = wheelRef.current;
        slot.acc += dy;
        const now = Date.now();
        if (now - slot.at < 120) return;
        const deltaY = slot.acc;
        slot.acc = 0;
        slot.at = now;
        fetch(httpUrl(`${API_PATH}/command`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "scroll", deltaY }),
        }).catch(() => {});
      };

      const leaseAction = (action) => {
        fetch(httpUrl(`${API_PATH}/lease`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }).then((r) => r.json()).then((data) => {
          if (data?.lease) setLeaseHolder(data.lease.holder);
        }).catch(() => {});
      };

      const tabAction = (type, payload) => {
        fetch(httpUrl(`${API_PATH}/command`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type, ...payload }),
        }).then((r) => r.json()).then((data) => {
          if (data?.ok === false) setError(String(data.error ?? "标签页操作失败"));
          else setError(null);
        }).catch((e) => setError(String(e?.message ?? e)));
      };

      const answerApproval = (approved) => {
        const id = approval?.id;
        setApproval(null);
        if (id === undefined) return;
        try { socketRef.current?.send?.(JSON.stringify({ type: "approval-response", id, approved })); } catch {}
      };

      /* ---------------------------- 地址栏（像真实浏览器） --------------------------- */
      const normalizeAddress = (raw) => {
        const text = String(raw ?? "").trim();
        if (!text) return "";
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
        if (text.startsWith("//")) return `https:${text}`;
        if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
        if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
        return `https://${text}`;
      };

      const goTo = (raw) => {
        const url = normalizeAddress(raw);
        if (!url) return;
        editingRef.current = false;
        pendingNavRef.current = true;
        setAddressInput(url);
        tabAction("navigate", { url });
      };

      const holderKind = leaseHolder ? leaseHolder.kind : null;
      const statusLabel = embeddedOn ? "嵌入" : nativeWindow ? (mirrorOn ? "镜像" : "原生窗口") : status === "live" ? "实时" : status === "connecting" ? "连接中" : "已断开";
      const statusColor = embeddedOn ? (status === "live" ? "#2f9e44" : "#d9a400") : status === "live" ? (nativeWindow ? "#4c6ef5" : "#2f9e44") : status === "connecting" ? "#d9a400" : "#c92a2a";
      const sizeLabel = `${viewport.width}×${viewport.height}`;

      const focusNative = () => {
        try { socketRef.current?.send?.(JSON.stringify({ type: "focus" })); } catch {}
      };
      const setMirror = (enabled) => {
        mirrorRef.current = enabled;
        setMirrorOn(enabled);
        try { socketRef.current?.send?.(JSON.stringify({ type: "mirror", enabled })); } catch {}
        if (!enabled) {
          hasFrameRef.current = false;
          setHasFrame(false);
        }
      };

      return jsxs("div", {
        "data-agent-browser-pane": true,
        style: S.root,
        children: [
          capabilityFallback
            ? jsx("p", {
              style: S.capabilityBar,
              role: "status",
              children: "桌面端未启用内嵌浏览器补丁，已回退像素流",
            })
            : null,
          jsxs("div", {
            style: S.toolbar,
            children: [
              jsx("button", {
                type: "button", title: "后退", style: S.navButton,
                onClick: () => { pendingNavRef.current = true; tabAction("back"); },
                children: "‹",
              }),
              jsx("button", {
                type: "button", title: "前进", style: S.navButton,
                onClick: () => { pendingNavRef.current = true; tabAction("forward"); },
                children: "›",
              }),
              jsx("button", {
                type: "button", title: "刷新", style: S.navButton,
                onClick: () => { tabAction("reload"); },
                children: "⟳",
              }),
              canToggleFullscreen
                ? jsx("button", {
                  type: "button",
                  title: "全屏 / 还原（全屏后浏览器按真实桌面宽度渲染）",
                  style: S.navButton,
                  onClick: () => { try { toggleFullscreen(); } catch {} },
                  children: "⛶",
                })
                : null,
              jsx("input", {
                style: S.addressInput,
                value: addressInput,
                spellCheck: false,
                placeholder: "输入网址，回车打开",
                title: title || address,
                onChange: (event) => { editingRef.current = true; setAddressInput(event.target.value); },
                onFocus: (event) => { editingRef.current = true; try { event.target.select(); } catch {} },
                onBlur: () => {
                  editingRef.current = false;
                  if (!pendingNavRef.current) setAddressInput(address);
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") { event.preventDefault(); goTo(addressInput); }
                  else if (event.key === "Escape") { event.preventDefault(); setAddressInput(address); event.target.blur(); }
                },
              }),
            ],
          }),
          jsxs("div", {
            style: S.statusBar,
            children: [
              jsx("span", { style: S.badge, children: LEASE_LABEL[holderKind] ?? "空闲" }),
              jsx("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "11px/1.4 ui-monospace, Consolas, monospace", color: statusColor }, title: nativeWindow ? "浏览器在独立原生窗口里运行，人直接操作没有像素流延迟" : title, children: embeddedOn ? `嵌入浏览器 · ${sizeLabel}（原生渲染，零延迟）` : nativeWindow ? (mirrorOn ? `镜像 ${sizeLabel}（操作请在原生窗口）` : `原生窗口 · ${sizeLabel}`) : `${statusLabel} · ${sizeLabel}` }),
              nativeWindow && !embeddedOn
                ? jsx("button", { type: "button", style: S.button, onClick: () => setMirror(!mirrorOn), children: mirrorOn ? "关镜像" : "看镜像" })
                : null,
              holderKind === "agent"
                ? jsx("button", { type: "button", style: S.button, onClick: () => leaseAction("takeover"), children: "接管" })
                : jsx("button", { type: "button", style: S.button, onClick: () => leaseAction("release"), children: "释放" }),
              jsx("button", { type: "button", style: S.button, onClick: () => setReconnectToken((v) => v + 1), children: "重连" }),
            ],
          }),
          tabs.length > 1
            ? jsx("div", {
              style: S.tabStrip,
              children: tabs.map((tab) => jsxs("div", {
                style: tab.active ? S.tabItemActive : S.tabItem,
                title: `${tab.title || "(无标题)"}\n${tab.url}`,
                onClick: () => { if (!tab.active) tabAction("tab/select", { tabId: tab.targetId }); },
                children: [
                  jsx("span", { style: S.tabLabel, children: tab.title || tab.url || tab.targetId.slice(0, 8) }),
                  jsx("button", {
                    type: "button",
                    style: S.tabClose,
                    title: "关闭标签页",
                    onClick: (event) => { event.stopPropagation(); tabAction("tab/close", { tabId: tab.targetId }); },
                    children: "×",
                  }),
                ],
              }, tab.targetId)),
            })
            : null,
          error !== null
            ? jsx("p", { style: S.err, children: error })
            : embeddedOn
              ? jsxs("div", {
                style: S.embedWrap,
                children: [
                  jsx("div", { ref: embedRootRef, style: S.embedRoot }),
                  WEBVIEW_SUPPORTED
                    ? null
                    : jsx("p", { style: S.hint, children: "当前桌面端没有启用 <webview>（需要 webviewTag 补丁，见 README「嵌入模式」）。" }),
                ],
              })
              : nativeWindow && !mirrorOn
              ? jsxs("div", {
                style: S.nativeCard,
                children: [
                  jsx("div", { style: S.nativeTitle, children: "浏览器在原生窗口运行" }),
                  jsx("p", {
                    style: S.nativeText,
                    children: "直接在那个 Chrome/Edge 窗口里操作 —— 没有 JPEG 编码、没有帧流传输，和本地浏览器一样快。侧栏保留地址栏、标签页、租约与审计；agent 仍通过 CDP 操作同一个已登录会话。",
                  }),
                  jsxs("div", {
                    style: S.nativeActions,
                    children: [
                      jsx("button", { type: "button", style: S.primaryButton, onClick: focusNative, children: "回到浏览器窗口" }),
                      jsx("button", { type: "button", style: S.button, onClick: () => setMirror(true), children: "打开实时镜像" }),
                    ],
                  }),
                  jsx("p", { style: S.nativeHint, children: `窗口视口 ${sizeLabel} · 镜像关闭时浏览器不产生编码开销` }),
                ],
              })
              : jsxs("div", {
                ref: containerRef,
                style: S.viewport,
                children: [
                  jsx("img", {
                    ref: imgRef,
                    alt: "browser",
                    decoding: "async",
                    draggable: false,
                    title: nativeWindow ? "镜像画面：操作请回到原生窗口（点这里会切过去）" : undefined,
                    style: hasFrame ? S.image : S.imageHidden,
                    onClick: nativeWindow ? focusNative : onClickImage,
                    onWheel: nativeWindow ? undefined : onWheelImage,
                  }),
                  hasFrame
                    ? null
                    : jsx("p", { style: S.hint, children: nativeWindow ? "正在打开实时镜像…" : `等待首帧：${wsUrl(WS_PATH)}` }),
                ],
              }),
          approval !== null
            ? jsxs("div", {
              style: S.overlay,
              children: jsxs("div", {
                style: S.card,
                children: [
                  jsx("p", {
                    style: S.cardTitle,
                    children: approval.title !== "" ? approval.title : approval.kindLabel !== "" ? approval.kindLabel : "agent 请求在页面执行脚本",
                  }),
                  approval.title !== "" && approval.kindLabel !== "" ? jsx("p", { style: S.cardSubtitle, children: approval.kindLabel }) : null,
                  approval.target !== "" ? jsx("p", { style: S.cardTarget, children: `目标：${approval.target}` }) : null,
                  jsx("pre", { style: S.code, children: approval.detail || "" }),
                  jsxs("div", {
                    style: S.cardActions,
                    children: [
                      jsx("button", { type: "button", style: S.button, onClick: () => answerApproval(false), children: "拒绝" }),
                      jsx("button", { type: "button", style: S.allowButton, onClick: () => answerApproval(true), children: "允许执行" }),
                    ],
                  }),
                ],
              }),
            })
            : null,
        ],
      });
    }

    /* ------------------------------- 插件入口 ------------------------------- */
    function apply(ctx) {
      const tabs = ctx.sidebarRightTabs;
      if (tabs === undefined) throw new Error("dsh-agent-browser: 缺少 sidebarRightTabs 服务");

      ctx.effect(() => tabs.register({
        id: PLUGIN_ID,
        kind: TAB_KIND,
        multiple: false,
        priority: "extension",
        keepMounted: true,
        title: () => "Agent 浏览器",
        guide: [{ id: "new", order: 20, title: () => "Agent 浏览器", description: () => "与 agent 共用的浏览器：实时画面，可直接点击" }],
      }), "dsh-agent-browser: tab type");

      ctx.effect(() => ctx.slots.inject(TAB_ANCHOR, () => ctx.slots.register({
        name: TAB_ANCHOR,
        key: PLUGIN_ID,
      }, AgentBrowserPane)), "dsh-agent-browser: pane body");

      // 工具卡：browser_* 工具在对话流里渲染为一行紧凑摘要（⬡ 动作名 目标 状态点）。
      // tool.call.toolview 按 key（工具名）分发；未注册的工具继续走宿主通用卡片。
      ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => {
        for (const name of TOOL_NAMES) {
          ctx.slots.register({ name: "tool.call.toolview", key: name }, ToolCard);
        }
      }), "dsh-agent-browser: tool cards");
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs"];
    exports.name = PLUGIN_ID;
    return module.exports;
  },
});