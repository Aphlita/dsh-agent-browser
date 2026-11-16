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
      viewport: { flex: "1 1 auto", minHeight: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0b0b" },
      image: { display: "block", maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain", cursor: "crosshair" },
      imageHidden: { display: "none" },
      hint: { margin: 0, padding: 20, color: "#8a8a8a", font: "12px/1.6 ui-monospace, Consolas, monospace", wordBreak: "break-all" },
      err: { margin: 0, padding: 12, color: "#ff8787", font: "12px/1.5 ui-monospace, Consolas, monospace", wordBreak: "break-all" },
      overlay: { position: "absolute", inset: 0, background: "rgba(0,0,0,0.66)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 20 },
      card: { width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 10, border: "1px solid #3a3a3a", background: "#161616", boxShadow: "0 12px 32px rgba(0,0,0,0.5)" },
      cardTitle: { margin: 0, font: "600 13px/1.4 system-ui, sans-serif", color: "#f1f1f1" },
      code: { margin: 0, maxHeight: 180, overflow: "auto", padding: 8, borderRadius: 6, background: "#0b0b0b", border: "1px solid #2a2a2a", color: "#d6d6d6", font: "11px/1.5 ui-monospace, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      cardActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      allowButton: { flex: "none", height: 28, padding: "0 12px", border: "1px solid #2f6f4f", borderRadius: 6, background: "#1d3a2b", color: "#b2f2c9", font: "12px/1 system-ui, sans-serif", cursor: "pointer" },
    };

    const LEASE_LABEL = { agent: "agent 操作中", human: "你在操作", null: "空闲" };

    /* -------------------------------- 页面组件 ------------------------------- */
    function AgentBrowserPane() {
      const [status, setStatus] = useState("connecting");
      const [hasFrame, setHasFrame] = useState(false);
      const [address, setAddress] = useState("");
      const [addressInput, setAddressInput] = useState("");
      const [title, setTitle] = useState("");
      const [viewport, setViewport] = useState({ width: 420, height: 860 });
      const [leaseHolder, setLeaseHolder] = useState(null);
      const [tabs, setTabs] = useState([]);
      const [approval, setApproval] = useState(null);
      const [error, setError] = useState(null);
      const [reconnectToken, setReconnectToken] = useState(0);

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

      viewportRef.current = viewport;

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
          if (msg.type === "hello") {
            if (msg.viewport) setViewport({ width: msg.viewport.width, height: msg.viewport.height });
            if (msg.lease) setLeaseHolder(msg.lease.holder);
            if (Array.isArray(msg.tabs)) setTabs(msg.tabs);
            return;
          }
          if (msg.type === "state") {
            addressRef.current = msg.url ?? "";
            pendingNavRef.current = false;
            setAddress(msg.url ?? "");
            if (!editingRef.current) setAddressInput(msg.url ?? "");
            setTitle(msg.title ?? "");
            if (msg.lease) setLeaseHolder(msg.lease.holder);
            if (Array.isArray(msg.tabs)) setTabs(msg.tabs);
            return;
          }
          if (msg.type === "approval") { setApproval({ id: msg.id, title: msg.title, detail: msg.detail }); return; }
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
          setStatus("connecting");
          const next = new WebSocket(wsUrl(WS_PATH));
          next.binaryType = "arraybuffer";
          next.onopen = () => { if (disposed) return; attempt = 0; setStatus("live"); setError(null); };
          next.onmessage = (event) => {
            if (disposed) return;
            if (typeof event.data === "string") handleText(event.data);
            else publishFrame(event.data);
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
      const statusLabel = status === "live" ? "实时" : status === "connecting" ? "连接中" : "已断开";
      const statusColor = status === "live" ? "#2f9e44" : status === "connecting" ? "#d9a400" : "#c92a2a";

      return jsxs("div", {
        "data-agent-browser-pane": true,
        style: S.root,
        children: [
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
              jsx("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "11px/1.4 ui-monospace, Consolas, monospace", color: statusColor }, title: title, children: statusLabel }),
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
            : jsx("div", {
              style: S.viewport,
              children: [
                jsx("img", {
                  ref: imgRef,
                  alt: "browser",
                  decoding: "async",
                  draggable: false,
                  style: hasFrame ? S.image : S.imageHidden,
                  onClick: onClickImage,
                  onWheel: onWheelImage,
                }),
                hasFrame ? null : jsx("p", { style: S.hint, children: `等待首帧：${wsUrl(WS_PATH)}` }),
              ],
            }),
          approval !== null
            ? jsxs("div", {
              style: S.overlay,
              children: jsxs("div", {
                style: S.card,
                children: [
                  jsx("p", { style: S.cardTitle, children: approval.title || "agent 请求在页面执行脚本" }),
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
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs"];
    exports.name = PLUGIN_ID;
    return module.exports;
  },
});