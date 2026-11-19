/**
 * DSH Agent Browser — CDP 引擎（零第三方依赖）
 *
 * 传输：默认 --remote-debugging-pipe（stdio fd3/fd4，不监听任何端口），可回退 WebSocket。
 * 快照：Accessibility 树（角色/名称/状态）+ DOMSnapshot（几何/属性），支持 OOPIF iframe。
 * 引用：`f<frame>e<backendNodeId>`；失效时 STALE_REF 自愈（重拍 + 按语义匹配重试一次）。
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { CdpClient, CdpError, launchBrowser, sleep } from "./cdp.js";
import { collectSnapshot, findRefBySignature } from "./snapshot.js";

const DEFAULT_VIEWPORT = { width: 1280, height: 800, dpr: 1 };

const CHROME_CANDIDATES = {
  win32: [
    ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "chrome"],
    ["C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "chrome"],
    ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "msedge"],
    ["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "msedge"],
  ],
  darwin: [
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome"],
    ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "msedge"],
  ],
  linux: [
    ["/usr/bin/google-chrome", "chrome"],
    ["/usr/bin/google-chrome-stable", "chrome"],
    ["/usr/bin/chromium", "chromium"],
    ["/usr/bin/microsoft-edge", "msedge"],
  ],
};

export function defaultProfileDir() {
  const home = homedir();
  if (platform() === "win32") return path.join(home, "AppData", "Local", "dsh-agent-browser", "profile");
  if (platform() === "darwin") return path.join(home, "Library", "Application Support", "dsh-agent-browser", "profile");
  return path.join(home, ".cache", "dsh-agent-browser", "profile");
}

export function findBrowser(executablePath) {
  if (executablePath) {
    if (!existsSync(executablePath)) throw new Error(`executablePath 不存在：${executablePath}`);
    return { executablePath, channel: "custom" };
  }
  const list = CHROME_CANDIDATES[platform()] ?? CHROME_CANDIDATES.linux;
  for (const [p, channel] of list) if (existsSync(p)) return { executablePath: p, channel };
  throw new Error("没有找到 Chrome 或 Edge；请安装其中之一，或在配置里指定 executablePath");
}

// 页面内探测「真人操作」：原生窗口模式下，人在浏览器窗口里点/敲时自动把租约判给人类。
const HUMAN_INPUT_SCRIPT = String.raw`
(() => {
  if (window.__abHumanHooked) return;
  window.__abHumanHooked = true;
  let last = 0;
  const ping = (kind) => {
    const now = Date.now();
    if (now - last < 400) return;
    last = now;
    try { window.__abHumanInput && window.__abHumanInput(kind); } catch (e) {}
  };
  window.addEventListener('pointerdown', () => ping('pointer'), true);
  window.addEventListener('keydown', () => ping('key'), true);
  window.addEventListener('wheel', () => ping('wheel'), { capture: true, passive: true });
})()
`;

const KEY_CODES = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

// 在元素所属会话里执行：滚动到视口中间并返回视口坐标。
const CENTER_FUNCTION = `function () {
  const el = this;
  if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, reason: 'invisible' };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}`;

const FOCUS_CLEAR_FUNCTION = `function () {
  const el = this;
  if (!el || !el.isConnected) return false;
  try { el.focus(); } catch (e) {}
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
  if (proto) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
  } else if (el.isContentEditable) { el.textContent = ''; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

const FOCUS_FUNCTION = `function () { try { this.focus(); return true; } catch (e) { return false; } }`;

function staleError(message) {
  return new CdpError(message, "STALE_REF");
}

/* --------------------------------- 会话 --------------------------------- */

export class BrowserSession {
  /**
   * @param {object} [options]
   * @param {string} [options.executablePath]
   * @param {string} [options.profileDir]
   * @param {boolean} [options.headless]
   * @param {boolean} [options.emulate] 是否用 Emulation 固定视口（原生窗口模式应为 false）
   * @param {{width:number,height:number,dpr?:number}} [options.viewport]
   * @param {"pipe"|"ws"} [options.transport] 默认 pipe
   * @param {{x:number,y:number}} [options.windowPosition]
   * @param {{width:number,height:number}} [options.windowSize]
   * @param {string} [options.startUrl]
   * @param {(input:{url:string,frameId?:string,programmatic:boolean}) => Promise<{allow:boolean,reason?:string}>|{allow:boolean,reason?:string}} [options.navigationGuard]
   */
  constructor(options = {}) {
    this.options = {
      profileDir: options.profileDir ?? defaultProfileDir(),
      headless: options.headless ?? true,
      emulate: options.emulate ?? (options.headless !== false),
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      transport: options.transport === "ws" ? "ws" : "pipe",
      navigationGuard: typeof options.navigationGuard === "function" ? options.navigationGuard : null,
      windowPosition: options.windowPosition ?? null,
      windowSize: options.windowSize ?? null,
      startUrl: options.startUrl ?? "about:blank",
      executablePath: options.executablePath,
    };
    this.pid = null;
    this.conn = null;
    this.sessionId = null;
    this.targetId = null;
    this.tabs = new Map();
    this.frameListeners = new Set();
    this.navListeners = new Set();
    this.humanInputListeners = new Set();
    this.dialogListeners = new Set();
    this._humanHookInstalled = new Set();
    this._sessionParents = new Map(); // 子会话 -> 父会话（auto-attach 的 OOPIF）
    this._dialogs = [];
    this._fileChooserListeners = new Set();
    this._navigationBlockedListeners = new Set();
    this.pendingFileChooser = null;
    this.lastBlockedNavigation = null;
    this.committedUrl = "about:blank";
    this._programmaticNav = 0;
    this.lastSnapshot = null;
    this.state = "idle"; // idle | starting | ready | dead
    this.lastError = null;
    this._screencastOn = false;
    this._frameCount = 0;
  }

  /* ---- 生命周期 ---- */

  async start() {
    if (this.state === "ready") return this;
    this.state = "starting";
    try {
      const { executablePath, channel } = findBrowser(this.options.executablePath);
      this.browserChannel = channel;
      const userDataDir = this.options.profileDir;
      await mkdir(userDataDir, { recursive: true });
      await rm(path.join(userDataDir, "DevToolsActivePort"), { force: true }).catch(() => {});
      const args = [
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-features=Translate,MediaRouter",
        "--disable-popup-blocking",
      ];
      if (this.options.headless) {
        args.unshift("--headless=new");
        args.push(`--window-size=${this.options.viewport.width},${this.options.viewport.height}`);
      } else {
        const size = this.options.windowSize ?? {
          width: Math.max(720, this.options.viewport.width),
          height: Math.max(600, this.options.viewport.height),
        };
        args.push(`--window-size=${Math.round(size.width)},${Math.round(size.height)}`);
        if (this.options.windowPosition) args.push(`--window-position=${Math.round(this.options.windowPosition.x)},${Math.round(this.options.windowPosition.y)}`);
      }
      args.push(this.options.startUrl);

      const launched = await launchBrowser({ executablePath, args, transport: this.options.transport, profileDir: userDataDir });
      this.pid = launched.pid;
      this.transportMode = launched.mode;
      this.wsUrl = launched.wsUrl ?? null;
      this.conn = new CdpClient(launched.transport);
      this.conn.onClose(() => { if (this.state !== "idle") this._markDead("CDP 连接断开"); });
      this._attachPageListeners();

      const version = await this.conn.send("Browser.getVersion");
      this.browserVersion = version.product;
      await this.conn.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: false }).catch(() => {});

      await this._openPage(this.options.startUrl);
      await this.setViewport(this.options.viewport);
      this.state = "ready";
      return this;
    } catch (error) {
      this.state = "failed";
      this.lastError = error;
      await this.close();
      throw error;
    }
  }

  async _openPage(url) {
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const attached = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    this.tabs.set(targetId, { targetId, sessionId, url: "about:blank", title: "", createdAt: Date.now() });
    this.targetId = targetId;
    this.sessionId = sessionId;
    await this._preparePageSession(sessionId, { main: true });
    if (url && url !== "about:blank") await this.navigate(url);
    return targetId;
  }

  async _preparePageSession(sessionId, { main = false } = {}) {
    await this.conn.send("Page.enable", {}, sessionId).catch(() => {});
    await this.conn.send("Runtime.enable", {}, sessionId).catch(() => {});
    await this.conn.send("DOM.enable", {}, sessionId).catch(() => {});
    await this.conn.send("Accessibility.enable", {}, sessionId).catch(() => {});
    await this.conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
    if (main) {
      // 主帧文档请求先过策略闸门（链接点击、JS 跳转、重定向都会走到这里）。
      if (this.options.navigationGuard) {
        await this.conn.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, sessionId).catch(() => {});
      }
      // 页面自身弹出文件选择框时拦下来：不会出现系统对话框，交给右栏显示待上传状态。
      await this.conn.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId).catch(() => {});
    }
    await this._installHumanInputHook(sessionId).catch(() => {});
  }

  _attachPageListeners() {
    this.conn.on("Page.frameNavigated", (params, sessionId) => {
      const tab = [...this.tabs.values()].find((entry) => entry.sessionId === sessionId);
      if (!tab) return;
      if (params?.frame?.parentId !== undefined) return; // iframe 内导航不算主帧
      tab.url = params.frame.url ?? tab.url;
      this._scheduleTitleRefresh(tab);
      if (sessionId !== this.sessionId) return;
      this.committedUrl = tab.url;
      this.lastSnapshot = null; // 导航后旧 ref 全部失效
      for (const fn of this.navListeners) { try { fn(tab.url); } catch {} }
    });

    this.conn.on("Target.attachedToTarget", (params, parentSessionId) => {
      const child = params?.sessionId;
      const type = params?.targetInfo?.type;
      if (!child || type !== "iframe") return;
      this._sessionParents.set(child, parentSessionId ?? null);
      void (async () => {
        const conn = this.conn;
        if (!conn) return; // 会话已关闭：自动附着的迟到事件直接丢弃
        try {
          await conn.send("Page.enable", {}, child).catch(() => {});
          await conn.send("Runtime.enable", {}, child).catch(() => {});
          await conn.send("DOM.enable", {}, child).catch(() => {});
          await conn.send("Accessibility.enable", {}, child).catch(() => {});
          await this._installHumanInputHook(child).catch(() => {});
        } catch {}
      })();
    });

    this.conn.on("Target.detachedFromTarget", (params) => {
      if (params?.sessionId) {
        this._sessionParents.delete(params.sessionId);
        this._humanHookInstalled.delete(params.sessionId);
      }
    });

    this.conn.on("Runtime.bindingCalled", (params, sessionId) => {
      if (params?.name !== "__abHumanInput") return;
      for (const fn of this.humanInputListeners) { try { fn({ kind: params.payload ?? "pointer", sessionId }); } catch {} }
    });

    this.conn.on("Page.javascriptDialogOpening", (params, sessionId) => {
      const dialog = { id: `${Date.now()}-${this._dialogs.length}`, type: params?.type, message: params?.message, defaultPrompt: params?.defaultPrompt, hasBrowserHandler: params?.hasBrowserHandler, sessionId };
      this._dialogs.push(dialog);
      for (const fn of this.dialogListeners) { try { fn(dialog); } catch {} }
    });

    this.conn.on("Page.javascriptDialogClosed", (_params, sessionId) => {
      this._dialogs = this._dialogs.filter((dialog) => dialog.sessionId !== sessionId);
    });

    this.conn.on("Page.screencastFrame", (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      this._frameCount += 1;
      const frame = {
        seq: this._frameCount,
        data: Buffer.from(params.data, "base64"),
        timestamp: params.metadata?.timestamp ?? 0,
        deviceWidth: params.metadata?.deviceWidth ?? this.options.viewport.width,
        deviceHeight: params.metadata?.deviceHeight ?? this.options.viewport.height,
      };
      this.conn.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId, 5000).catch(() => {});
      for (const fn of this.frameListeners) { try { fn(frame); } catch {} }
    });

    this.conn.on("Target.targetDestroyed", (params) => this._dropTab(params?.targetId));
    this.conn.on("Target.targetCrashed", (params) => this._dropTab(params?.targetId));

    this.conn.on("Fetch.requestPaused", (params, sessionId) => { void this._handlePausedRequest(params, sessionId); });

    this.conn.on("Page.fileChooserOpened", (params, sessionId) => {
      if (this.tabs.get(this.targetId)?.sessionId !== sessionId) return;
      this.pendingFileChooser = {
        backendNodeId: params?.backendNodeId,
        mode: params?.mode ?? "selectSingle",
        sessionId,
        at: Date.now(),
      };
      for (const fn of this._fileChooserListeners) { try { fn(this.pendingFileChooser); } catch {} }
    });
  }

  async _handlePausedRequest(params, sessionId) {
    const requestId = params?.requestId;
    if (!requestId) return;
    try {
      if (params.resourceType !== "Document" || !this.options.navigationGuard) {
        await this.conn.send("Fetch.continueRequest", { requestId }, sessionId);
        return;
      }
      const url = params.request?.url ?? "";
      const decision = await this._guardNavigation({ url, frameId: params.frameId, programmatic: this._programmaticNav > 0 });
      if (decision.allow) { await this.conn.send("Fetch.continueRequest", { requestId }, sessionId); return; }
      this.lastBlockedNavigation = { url, reason: decision.reason ?? "blocked", at: Date.now() };
      for (const fn of this._navigationBlockedListeners) { try { fn(this.lastBlockedNavigation); } catch {} }
      await this.conn.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
    } catch {
      try { await this.conn.send("Fetch.continueRequest", { requestId }, sessionId); } catch {}
    }
  }

  async _guardNavigation(input) {
    try {
      const decision = await Promise.race([
        Promise.resolve().then(() => this.options.navigationGuard(input)),
        sleep(60_000).then(() => ({ allow: false, reason: "guard-timeout" })),
      ]);
      return decision && typeof decision === "object" ? decision : { allow: Boolean(decision) };
    } catch (error) {
      return { allow: false, reason: `guard-error: ${error?.message ?? error}` };
    }
  }

  _dropTab(targetId) {
    const tab = targetId ? this.tabs.get(targetId) : undefined;
    if (!tab) return;
    this.tabs.delete(targetId);
    if (this.targetId !== targetId) return;
    const next = [...this.tabs.values()][0];
    if (!next) {
      this.targetId = null;
      this.sessionId = null;
      this._screencastOn = false;
      return;
    }
    this.targetId = next.targetId;
    this.sessionId = next.sessionId;
    this.setViewport(this.options.viewport).catch(() => {});
    if (this._screencastOn) {
      this._screencastOn = false;
      this.startScreencast({ quality: 60 }).catch(() => {});
    }
  }

  _scheduleTitleRefresh(tab) {
    if (tab._titleTimer) return;
    tab._titleTimer = setTimeout(async () => {
      tab._titleTimer = null;
      try {
        const title = await this._evaluateIn(tab.sessionId, "document.title");
        if (typeof title === "string") tab.title = title;
      } catch {}
    }, 150);
  }

  async _evaluateIn(sessionId, expression) {
    const res = await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false, userGesture: true }, sessionId, 8000).catch(() => null);
    if (!res || res.exceptionDetails) return undefined;
    return res.result?.value;
  }

  /* ---- 多标签 ---- */

  listTabs() {
    return [...this.tabs.values()].map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, active: t.targetId === this.targetId }));
  }

  async newTab(url = "about:blank") {
    if (url && url !== "about:blank" && !/^https?:\/\//i.test(url)) throw new Error(`只允许 http(s) 地址：${url}`);
    const wasStreaming = this._screencastOn;
    if (wasStreaming) await this.stopScreencast();
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const attached = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = { targetId, sessionId: attached.sessionId, url: "about:blank", title: "", createdAt: Date.now() };
    this.tabs.set(targetId, tab);
    this.targetId = targetId;
    this.sessionId = tab.sessionId;
    await this._preparePageSession(tab.sessionId, { main: true });
    await this.send("Page.bringToFront").catch(() => {});
    await this.conn.send("Target.activateTarget", { targetId }).catch(() => {});
    await this.setViewport(this.options.viewport);
    if (wasStreaming) await this.startScreencast({ quality: 60 });
    if (url && url !== "about:blank") await this.navigate(url);
    return this.listTabs();
  }

  async selectTab(targetId) {
    const tab = this.tabs.get(targetId) ?? [...this.tabs.values()].find((t) => t.targetId.startsWith(targetId));
    if (!tab) throw new Error(`没有这个标签：${targetId}`);
    if (tab.targetId === this.targetId) return this.listTabs();
    const wasStreaming = this._screencastOn;
    if (wasStreaming) await this.stopScreencast();
    this.targetId = tab.targetId;
    this.sessionId = tab.sessionId;
    this.lastSnapshot = null;
    await this.send("Page.bringToFront").catch(() => {});
    await this.conn.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
    await this.setViewport(this.options.viewport);
    if (wasStreaming) await this.startScreencast({ quality: 60 });
    return this.listTabs();
  }

  async closeTab(targetId) {
    const tab = this.tabs.get(targetId) ?? [...this.tabs.values()].find((t) => t.targetId.startsWith(targetId));
    if (!tab) throw new Error(`没有这个标签：${targetId}`);
    if (this.tabs.size === 1) throw new Error("不能关闭最后一个标签（可以让浏览器空闲后自动关闭）");
    await this.conn.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
    this._dropTab(tab.targetId);
    return this.listTabs();
  }

  _markDead(reason) {
    if (this.state === "dead") return;
    this.state = "dead";
    this.lastError = new Error(reason);
    for (const fn of this.navListeners) { try { fn({ error: reason }); } catch {} }
  }

  async close() {
    this._screencastOn = false;
    try { this.conn?.close(); } catch {}
    this.conn = null;
    this.pid = null;
    if (this.state !== "failed") this.state = "idle";
  }

  /* ---- 底层命令 ---- */

  send(method, params = {}, timeoutMs) {
    if (!this.conn) return Promise.reject(new Error("浏览器尚未启动"));
    if (method.startsWith("Target.") || method.startsWith("Browser.")) return this.conn.send(method, params, undefined, timeoutMs);
    if (!this.sessionId) return Promise.reject(new Error("浏览器尚未启动"));
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  async _sendSession(method, params = {}, timeoutMs = 20_000, sessionId = this.sessionId) {
    return this.conn.send(method, params, sessionId, timeoutMs);
  }

  async evaluate(expression, { returnByValue = true, awaitPromise = false, sessionId = this.sessionId } = {}) {
    const res = await this.conn.send("Runtime.evaluate", { expression, returnByValue, awaitPromise, userGesture: true }, sessionId);
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails;
      const desc = detail.exception?.description ?? detail.exception?.value;
      const text = typeof desc === "string" && desc.trim() ? desc.split("\n")[0].trim() : (detail.text ?? "页面脚本异常");
      throw new Error(text);
    }
    return res?.result?.value;
  }

  /* ---- 视口 / 导航 ---- */

  async setViewport({ width, height, dpr = 1 }) {
    this.options.viewport = { width, height, dpr };
    if (this.options.emulate) {
      await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height });
    } else {
      const actual = await this._measureViewport();
      if (actual) this.options.viewport = { ...actual, dpr: this.options.viewport.dpr ?? 1 };
    }
    if (this._screencastOn) {
      this._screencastOn = false;
      try { await this.send("Page.stopScreencast"); } catch {}
      await this.startScreencast({ quality: this._screencastQuality ?? 60, maxWidth: this.options.viewport.width, maxHeight: this.options.viewport.height });
    }
  }

  async _measureViewport() {
    try {
      const state = await this.getState();
      const vp = state?.viewport;
      if (!vp || !vp.w || !vp.h) return null;
      return { width: Math.round(vp.w), height: Math.round(vp.h) };
    } catch { return null; }
  }

  async focusWindow() {
    try {
      const win = await this.conn.send("Browser.getWindowForTarget", { targetId: this.targetId });
      if (win?.windowId) await this.conn.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "normal" } });
    } catch {}
    await this.send("Page.bringToFront").catch(() => {});
    return true;
  }

  async navigate(url, { timeoutMs = 30_000 } = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`只允许 http(s) 地址：${url}`);
    this.lastSnapshot = null;
    const sessionId = this.sessionId;
    const loaded = this.conn.waitFor("Page.loadEventFired", { sessionId, timeoutMs }).catch(() => null);
    // 标记这次导航是「agent/宿主主动发起」的：Fetch 闸门看到 programmatic=true 就不再重复审批
    // （审批已经在 index.js 的 prepareAgentNavigation 里做过了）。页面自己发起的跳转不会置位。
    this._programmaticNav += 1;
    try {
      await this.send("Page.navigate", { url });
      await loaded;
    } finally {
      this._programmaticNav = Math.max(0, this._programmaticNav - 1);
    }
    await sleep(120);
    const state = await this.getState();
    const tab = this.tabs.get(this.targetId);
    if (tab && state?.title) tab.title = state.title;
    return state;
  }

  async navigateHistory(delta = -1) {
    if (!this.sessionId) throw new Error("没有可用的标签页");
    this.lastSnapshot = null;
    const history = await this.send("Page.getNavigationHistory");
    const targetIndex = history.currentIndex + (delta < 0 ? -1 : 1);
    const entry = history.entries?.[targetIndex];
    if (!entry) {
      const state = await this.getState();
      return { ...state, changed: false };
    }
    const loaded = this.conn.waitFor("Page.loadEventFired", { sessionId: this.sessionId, timeoutMs: 20_000 }).catch(() => null);
    this._programmaticNav += 1;
    try {
      await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await loaded;
    } finally {
      this._programmaticNav = Math.max(0, this._programmaticNav - 1);
    }
    await sleep(200);
    const state = await this.getState();
    const tab = this.tabs.get(this.targetId);
    if (tab && state?.title) tab.title = state.title;
    return { ...state, changed: true };
  }

  async getState() {
    return this.evaluate(`({
      url: location.href, title: document.title,
      readyState: document.readyState,
      viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), scrollH: Math.round(document.documentElement.scrollHeight) }
    })`);
  }

  /* ---- 像素流 ---- */

  async startScreencast({ quality = 60, maxWidth, maxHeight, everyNthFrame = 1 } = {}) {
    if (this._screencastOn) return;
    this._screencastQuality = quality;
    const vp = this.options.viewport;
    await this.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      maxWidth: Math.min(3840, Math.max(1, Math.round(maxWidth ?? vp.width))),
      maxHeight: Math.min(2160, Math.max(1, Math.round(maxHeight ?? vp.height))),
      everyNthFrame,
    });
    this._screencastOn = true;
  }

  async stopScreencast() {
    if (!this._screencastOn) return;
    this._screencastOn = false;
    try { await this.send("Page.stopScreencast"); } catch {}
  }

  onFrame(fn) { this.frameListeners.add(fn); return () => this.frameListeners.delete(fn); }
  onNavigated(fn) { this.navListeners.add(fn); return () => this.navListeners.delete(fn); }
  onHumanInput(fn) { this.humanInputListeners.add(fn); return () => this.humanInputListeners.delete(fn); }
  onDialog(fn) { this.dialogListeners.add(fn); return () => this.dialogListeners.delete(fn); }

  async _installHumanInputHook(sessionId = this.sessionId) {
    if (!sessionId || this._humanHookInstalled.has(sessionId)) return;
    this._humanHookInstalled.add(sessionId);
    try {
      await this.conn.send("Runtime.addBinding", { name: "__abHumanInput" }, sessionId, 5000);
      await this.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: HUMAN_INPUT_SCRIPT }, sessionId, 5000);
      await this.conn.send("Runtime.evaluate", { expression: HUMAN_INPUT_SCRIPT }, sessionId, 5000);
    } catch (error) {
      this._humanHookInstalled.delete(sessionId);
      throw error;
    }
  }

  /* ---- 快照 / 引用 ---- */

  /** 当前页面的 OOPIF 子会话（用于快照与按 ref 派发输入）。 */
  activeIframeSessions() {
    const root = this.sessionId;
    const children = [];
    const collect = (parent) => {
      for (const [child, owner] of this._sessionParents) if (owner === parent) { children.push(child); collect(child); }
    };
    collect(root);
    return children;
  }

  async snapshot(options = {}) {
    const snapshot = await collectSnapshot(this.conn, this.sessionId, {
      maxElements: options.maxElements ?? 300,
      textLimit: options.textLimit ?? 4000,
      redact: options.redact ?? null,
      isSensitiveField: options.isSensitiveField ?? null,
      iframeSessions: this.activeIframeSessions(),
    });
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  _targetOf(ref) {
    return this.lastSnapshot?.refs?.get(ref) ?? null;
  }

  /** 取 ref 对应元素在「所属会话」中的视口中心点；必要时自愈。 */
  async _center(target) {
    let node;
    try {
      node = await this.conn.send("DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
    } catch {
      throw staleError(`引用 ${target.ref} 已失效（节点不存在），请重新 snapshot`);
    }
    const objectId = node?.object?.objectId;
    if (!objectId) throw staleError(`引用 ${target.ref} 已失效（节点不存在），请重新 snapshot`);
    let result;
    try {
      result = await this.conn.send("Runtime.callFunctionOn", { objectId, functionDeclaration: CENTER_FUNCTION, returnByValue: true }, target.sessionId);
    } catch {
      throw staleError(`引用 ${target.ref} 已失效（节点不可访问），请重新 snapshot`);
    }
    const value = result?.result?.value;
    if (!value?.ok) throw staleError(`引用 ${target.ref} 不可点击（${value?.reason ?? "unknown"}），请重新 snapshot`);
    let x = value.x;
    let y = value.y;
    // quads 与 dispatch 使用同一会话坐标系：OOPIF 为子帧局部坐标，同进程 iframe 已被 DevTools 换算成主视口坐标。
    try {
      const quads = await this.conn.send("DOM.getContentQuads", { backendNodeId: target.backendNodeId }, target.sessionId);
      const quad = quads?.quads?.[0];
      if (Array.isArray(quad) && quad.length >= 8) {
        x = (quad[0] + quad[4]) / 2;
        y = (quad[1] + quad[5]) / 2;
      }
    } catch {}
    return { x: Math.round(x), y: Math.round(y), objectId, sessionId: target.sessionId };
  }

  /** STALE_REF 自愈：重拍快照，按 (role,name,frameIndex) 找回同一元素，重试一次。 */
  async _withRefHeal(ref, action) {
    let target = this._targetOf(ref);
    let healed = false;
    if (!target) {
      target = await this._healRef(ref);
      healed = Boolean(target);
    }
    if (!target) {
      const snapshot = await this.snapshot();
      const error = staleError(`STALE_REF：引用 ${ref} 不存在或已过期，已重新快照，请用新 ref 重试`);
      error.snapshot = snapshot;
      throw error;
    }
    try {
      return await action(target);
    } catch (error) {
      if (error?.code !== "STALE_REF") throw error;
      const replacement = await this._healRef(ref).catch(() => null);
      if (!replacement) {
        const snapshot = await this.snapshot();
        const failure = staleError(`STALE_REF：${error.message}`);
        failure.snapshot = snapshot;
        throw failure;
      }
      return action(replacement, true);
    }
  }

  async _healRef(ref) {
    const previous = this.lastSnapshot?.refs?.get(ref);
    if (!previous) return null;
    let snapshot;
    try { snapshot = await this.snapshot(); } catch { return null; }
    const found = findRefBySignature(snapshot, { role: previous.role, name: previous.name, frameIndex: previous.frameIndex });
    return found ? snapshot.refs.get(found.ref) ?? null : null;
  }

  /* ---- 输入 ---- */

  async clickRef(ref, { button = "left", clickCount = 1 } = {}) {
    return this._withRefHeal(ref, async (target) => {
      const { x, y, sessionId } = await this._center(target);
      await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
      await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: 1, clickCount }, sessionId);
      await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount }, sessionId);
      return { ref, x, y, frame: target.frameIndex };
    });
  }

  async clickAt(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { x, y };
  }

  async focusRef(ref) {
    return this._withRefHeal(ref, async (target) => {
      const { x, y, sessionId, objectId } = await this._center(target);
      await this.conn.send("Runtime.callFunctionOn", { objectId, functionDeclaration: FOCUS_FUNCTION, returnByValue: true }, sessionId).catch(() => {});
      return { ref, x, y, frame: target.frameIndex };
    });
  }

  async typeRef(ref, text, { clear = false } = {}) {
    return this._withRefHeal(ref, async (target) => {
      const { x, y, sessionId, objectId } = await this._center(target);
      const fn = clear ? FOCUS_CLEAR_FUNCTION : FOCUS_FUNCTION;
      await this.conn.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true }, sessionId);
      await this.conn.send("Input.insertText", { text }, sessionId);
      return { ref, x, y, text, frame: target.frameIndex };
    });
  }

  async typeText(text) {
    await this.send("Input.insertText", { text });
    return { text };
  }

  async press(key) {
    const spec = KEY_CODES[key];
    if (!spec) throw new Error(`不支持的按键：${key}`);
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return { key };
  }

  async scroll({ deltaY = 600, deltaX = 0, x, y, ref } = {}) {
    let target = null;
    if (ref) target = this._targetOf(ref) ?? await this._healRef(ref);
    if (target) {
      const center = await this._center(target);
      await this.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: center.x, y: center.y, deltaX, deltaY }, center.sessionId);
      return { deltaY, ref, at: { x: center.x, y: center.y } };
    }
    const vp = this.options.viewport;
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: x ?? Math.round(vp.width / 2), y: y ?? Math.round(vp.height / 2), deltaX, deltaY });
    return { deltaY };
  }

  /** 文件上传：对 input[type=file] 直接 setFileInputFiles（不弹系统对话框）。 */
  async uploadFiles(ref, files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("files 不能为空");
    return this._withRefHeal(ref, async (target) => {
      const node = await this.conn.send("DOM.resolveNode", { backendNodeId: target.backendNodeId }, target.sessionId);
      const objectId = node?.object?.objectId;
      if (!objectId) throw staleError(`引用 ${ref} 已失效，请重新 snapshot`);
      await this.conn.send("DOM.setFileInputFiles", { files, objectId }, target.sessionId);
      return { ref, files: files.length };
    });
  }

  /* ---- 对话框 ---- */

  listDialogs() {
    return this._dialogs.map((dialog) => ({ id: dialog.id, type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt }));
  }

  async handleDialog({ accept = true, promptText } = {}) {
    const dialog = this._dialogs[this._dialogs.length - 1];
    if (!dialog) throw new Error("当前没有打开的页面对话框");
    await this.conn.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }, dialog.sessionId);
    this._dialogs = this._dialogs.filter((entry) => entry.id !== dialog.id);
    return { type: dialog.type, message: dialog.message, accept };
  }

  /* ---- 截图 ---- */

  async screenshot({ format = "jpeg", quality = 70, fullPage = false } = {}) {
    let clip;
    if (fullPage) {
      const m = await this.send("Page.getLayoutMetrics");
      const size = m.cssContentSize ?? m.contentSize;
      clip = { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 8000), scale: 1 };
    }
    const res = await this.send("Page.captureScreenshot", { format, quality: format === "jpeg" ? quality : undefined, ...(clip ? { clip } : {}) });
    return { data: Buffer.from(res.data, "base64"), format };
  }

  async captureHdFrame({ quality = 80 } = {}) {
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false });
    return Buffer.from(res.data, "base64");
  }

  /* ---- 等待 ---- */

  async waitFor({ expression, timeoutMs = 10_000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await this.evaluate(expression)) return { ok: true }; } catch {}
      await sleep(intervalMs);
    }
    return { ok: false, reason: "timeout" };
  }
}

export { sleep };