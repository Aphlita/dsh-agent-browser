/**
 * DSH Agent Browser — CDP 引擎（零第三方依赖）
 *
 * 职责：拉起系统 Chrome/Edge，建立一个可被多个"标签页"共享的浏览器会话，
 * 暴露 screencast 帧流、导航、输入注入、快照与截图。
 * 不依赖 DSH：由 host 半插件（lib/index.js）实例化，也可被测试脚本直接使用。
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ------------------------------- CDP 传输层 ------------------------------- */

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    this.closeListeners = new Set();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(msg.error, p.method));
        else p.resolve(msg.result);
        return;
      }
      for (const h of this.handlers) {
        try { h(msg); } catch { /* 监听器错误不影响传输 */ }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP 连接已断开"));
      this.pending.clear();
      for (const fn of this.closeListeners) { try { fn(); } catch {} }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); }, { once: true });
    });
    return new CdpConnection(ws);
  }

  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  onClose(fn) { this.closeListeners.add(fn); return () => this.closeListeners.delete(fn); }

  send(method, params = {}, timeoutMs = 20_000) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已断开"));
    const id = this.nextId++;
    const conn = this;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (conn.pending.has(id)) { conn.pending.delete(id); reject(new Error(`CDP 调用超时：${method}`)); }
      }, timeoutMs);
      conn.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { conn.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { conn.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  close() { try { this.ws.close(); } catch {} }
}

class CdpError extends Error {
  constructor(err, method) {
    super(`${method}: ${err.message ?? "CDP error"}${err.data ? ` (${err.data})` : ""}`);
    this.code = err.code;
    this.cdpData = err.data;
  }
}

/* ------------------------------ 快照注入脚本 ------------------------------ */

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
};

/* --------------------------------- 会话 --------------------------------- */

export class BrowserSession {
  /**
   * @param {object} [options]
   * @param {string} [options.executablePath]
   * @param {string} [options.profileDir]
   * @param {boolean} [options.headless]
   * @param {{width:number,height:number,dpr?:number}} [options.viewport]
   * @param {string} [options.startUrl]
   */
  constructor(options = {}) {
    this.options = {
      profileDir: options.profileDir ?? defaultProfileDir(),
      headless: options.headless ?? true,
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      startUrl: options.startUrl ?? "about:blank",
      executablePath: options.executablePath,
    };
    this.proc = null;
    this.conn = null;
    this.sessionId = null;
    this.targetId = null;
    /** @type {Map<string, {targetId:string, sessionId:string, url:string, title:string, createdAt:number}>} */
    this.tabs = new Map();
    this.frameListeners = new Set();
    this.navListeners = new Set();
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
      // 上一次异常退出可能留下过期的 DevToolsActivePort，先清掉避免连到死端口
      await rm(path.join(userDataDir, "DevToolsActivePort"), { force: true }).catch(() => {});
      const args = [
        `--remote-debugging-port=0`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-features=Translate,MediaRouter",
        "--disable-popup-blocking",
        `--window-size=${this.options.viewport.width},${this.options.viewport.height}`,
      ];
      if (this.options.headless) args.unshift("--headless=new");
      args.push(this.options.startUrl);

      this.proc = spawn(executablePath, args, { stdio: "ignore", windowsHide: true });
      const wsUrl = await this._waitForDevToolsPort(userDataDir);
      this.conn = await CdpConnection.connect(wsUrl);
      this.conn.onClose(() => { if (this.state !== "idle") this._markDead("CDP 连接断开"); });

      const version = await this.conn.send("Browser.getVersion");
      this.browserVersion = version.product;

      this.targetId = await this._openPage(this.options.startUrl);
      await this.setViewport(this.options.viewport);
      this.state = "ready";
      this._attachPageListeners();
      return this;
    } catch (error) {
      this.state = "failed";
      this.lastError = error;
      await this.close();
      throw error;
    }
  }

  async _waitForDevToolsPort(userDataDir) {
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(portFile, "utf8");
        const lines = raw.trim().split(/\r?\n/);
        if (lines.length >= 2) return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      } catch (e) { last = String(e?.message ?? e); }
      if (this.proc?.exitCode !== null && this.proc?.exitCode !== undefined) {
        throw new Error(`浏览器进程退出（code=${this.proc.exitCode}）：${last}`);
      }
      await sleep(100);
    }
    throw new Error("等待浏览器 DevTools 端口超时（用户数据目录可能被占用）");
  }

  async _openPage(url) {
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const attached = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    this.tabs.set(targetId, { targetId, sessionId, url: "about:blank", title: "", createdAt: Date.now() });
    this.targetId = targetId;
    this.sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    if (url && url !== "about:blank") await this.navigate(url);
    return targetId;
  }

  _attachPageListeners() {
    this.conn.on((msg) => {
      const tab = [...this.tabs.values()].find((t) => t.sessionId === msg.sessionId);
      if (!tab) {
        if (msg.method === "Target.targetDestroyed") {
          this._dropTab(msg.params.targetId);
        } else if (msg.method === "Target.targetCrashed") {
          this._dropTab(msg.params.targetId);
        }
        return;
      }
      if (msg.method === "Page.frameNavigated" && msg.params?.frame?.parentId === undefined) {
        tab.url = msg.params.frame.url ?? tab.url;
        this._scheduleTitleRefresh(tab);
        if (msg.sessionId !== this.sessionId) return;
        for (const fn of this.navListeners) { try { fn(tab.url); } catch {} }
        return;
      }
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === "Page.screencastFrame") {
        this._frameCount++;
        const frame = {
          seq: this._frameCount,
          data: Buffer.from(msg.params.data, "base64"),
          timestamp: msg.params.metadata?.timestamp ?? 0,
          deviceWidth: msg.params.metadata?.deviceWidth ?? this.options.viewport.width,
          deviceHeight: msg.params.metadata?.deviceHeight ?? this.options.viewport.height,
        };
        this._sendSession("Page.screencastFrameAck", { sessionId: msg.params.sessionId }, 5000, msg.sessionId).catch(() => {});
        for (const fn of this.frameListeners) { try { fn(frame); } catch {} }
      }
    });
  }

  _dropTab(targetId) {
    const tab = this.tabs.get(targetId);
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
    const res = await this._sendSession("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false, userGesture: true }, 5000, sessionId);
    if (res?.exceptionDetails) return undefined;
    return res?.result?.value;
  }

  /* ---- 多标签 ---- */

  listTabs() {
    return [...this.tabs.values()].map((t) => ({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      active: t.targetId === this.targetId,
    }));
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
    await this.send("Page.enable");
    await this.send("Runtime.enable");
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
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch {}
      await sleep(150);
      try { if (this.proc.exitCode === null) this.proc.kill("SIGKILL"); } catch {}
    }
    this.proc = null;
    if (this.state !== "failed") this.state = "idle";
  }

  /* ---- 底层命令 ---- */

  send(method, params = {}, timeoutMs) {
    if (!this.conn) return Promise.reject(new Error("浏览器尚未启动"));
    // 页面级命令需要 sessionId；浏览器级命令（Target.*/Browser.*）不需要
    if (this.sessionId && !method.startsWith("Target.") && method !== "Browser.getVersion") {
      return this._sendSession(method, params, timeoutMs);
    }
    return this.conn.send(method, params, timeoutMs);
  }

  async _sendSession(method, params = {}, timeoutMs = 20_000, sessionId = this.sessionId) {
    const conn = this.conn;
    if (!conn) throw new Error("浏览器尚未启动");
    if (!sessionId) throw new Error("浏览器尚未启动");
    const id = conn.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (conn.pending.has(id)) { conn.pending.delete(id); reject(new Error(`CDP 调用超时：${method}`)); }
      }, timeoutMs);
      conn.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { conn.ws.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (e) { conn.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  async evaluate(expression, { returnByValue = true, awaitPromise = false } = {}) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue, awaitPromise, userGesture: true });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails;
      // CDP 的 text 往往只有 "Uncaught"，真正的信息在 exception.description（含 TypeError 文案与行号）
      const desc = detail.exception?.description ?? detail.exception?.value;
      const text = typeof desc === "string" && desc.trim() ? desc.split("\n")[0].trim() : (detail.text ?? "页面脚本异常");
      throw new Error(text);
    }
    return res.result?.value;
  }

  /* ---- 视口 / 导航 ---- */

  async setViewport({ width, height, dpr = 1 }) {
    this.options.viewport = { width, height, dpr };
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height,
    });
    // 帧流的分辨率上限是 startScreencast 时定下的，视口变了必须重开，否则画面被裁或模糊。
    if (this._screencastOn) {
      this._screencastOn = false;
      try { await this.send("Page.stopScreencast"); } catch {}
      await this.startScreencast({ quality: this._screencastQuality ?? 60 });
    }
  }

  async navigate(url, { timeoutMs = 30_000 } = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`只允许 http(s) 地址：${url}`);
    const loaded = new Promise((resolve) => {
      const off = this.conn.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === "Page.loadEventFired") { off(); resolve(); }
      });
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(120);
    const state = await this.getState();
    const tab = this.tabs.get(this.targetId);
    if (tab && state?.title) tab.title = state.title;
    return state;
  }

  /** 浏览器式前进/后退：delta=-1 后退，+1 前进。返回新状态与是否真的跳转。 */
  async navigateHistory(delta = -1) {
    if (!this.sessionId) throw new Error("没有可用的标签页");
    const history = await this._sendSession("Page.getNavigationHistory");
    const targetIndex = history.currentIndex + (delta < 0 ? -1 : 1);
    const entry = history.entries?.[targetIndex];
    if (!entry) {
      const state = await this.getState();
      return { ...state, changed: false };
    }
    await this._sendSession("Page.navigateToHistoryEntry", { entryId: entry.id });
    await sleep(250);
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
    // 高分屏（devicePixelRatio > 1）下按设备像素抓帧，否则浏览器把 1x 帧放大到物理像素，文字会糊。
    // 上限做个兜底，避免 4K 视口把帧撑到 8MP。
    const scale = Math.min(2.5, Math.max(1, Number(vp.dpr) || 1));
    await this.send("Page.startScreencast", {
      format: "jpeg", quality,
      maxWidth: maxWidth ?? Math.min(3840, Math.round(vp.width * scale)),
      maxHeight: maxHeight ?? Math.min(2160, Math.round(vp.height * scale)),
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

  /* ---- 快照 ---- */

  async snapshot() {
    return this.evaluate(SNAPSHOT_SCRIPT);
  }

  /* ---- 输入 ---- */

  async _centerOfRef(ref) {
    const res = await this.evaluate(REF_CENTER_SCRIPT(ref));
    if (!res?.ok) throw new Error(`引用 ${ref} 已失效（${res?.reason ?? "unknown"}），请重新 snapshot`);
    return res;
  }

  async clickRef(ref, { button = "left", clickCount = 1 } = {}) {
    const { x, y } = await this._centerOfRef(ref);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: 1, clickCount });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount });
    return { x, y };
  }

  async clickAt(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { x, y };
  }

  async focusRef(ref) {
    const { x, y } = await this._centerOfRef(ref);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    return { x, y };
  }

  /**
   * 向元素输入文本。默认走「聚焦 + Input.insertText」，对框架友好的
   * clear 通过页面内原生 setter + input 事件完成（避免 React 受控组件吞掉值）。
   */
  async typeRef(ref, text, { clear = false } = {}) {
    const { x, y } = await this.focusRef(ref);
    if (clear) await this.evaluate(CLEAR_SCRIPT(ref));
    await this.send("Input.insertText", { text });
    return { x, y, text };
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

  async scroll({ deltaY = 600, x, y } = {}) {
    const vp = this.options.viewport;
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: x ?? Math.round(vp.width / 2),
      y: y ?? Math.round(vp.height / 2),
      deltaX: 0, deltaY,
    });
    return { deltaY };
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

  /**
   * 高清静止帧：Page.captureScreenshot 尊重 deviceScaleFactor，能得到 dpr 倍分辨率的清晰帧
   * （Page.startScreencast 永远按 CSS 像素出帧，高分屏上文字会被系统放大 1.5 倍而发糊）。
   * 只在画面静止时调用，成本约 20–40ms/帧。
   */
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

const CLEAR_SCRIPT = (ref) => String.raw`
(() => {
  const el = window.__abByRef && window.__abByRef.get(${JSON.stringify(ref)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, ''); else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()
`;

export { sleep };