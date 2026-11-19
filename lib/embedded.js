/**
 * EmbeddedSession —— 把「侧栏 <webview> 里的浏览器」包装成和 BrowserSession 一样的接口。
 *
 * embedded 模式（见 README「嵌入模式」）：浏览器不是插件自己拉起的 Chrome，而是宿主页面里
 * 一个真的 <webview>（Electron 原生渲染，人直接看到的就是这个页面，零帧流、零延迟）。
 * 插件 host 半仍然负责租约、审计、审批、快照格式化；真正的浏览器操作通过侧栏的 WebSocket
 * RPC 转发给渲染进程，由渲染进程调用 webview 的 executeJavaScript / sendInputEvent /
 * capturePage / insertText 完成。
 *
 * 这样 12 个工具、HTTP API、租约与审计逻辑都不需要改：它们只依赖下面这组方法。
 */

const DEFAULT_TIMEOUT = 25_000;

export class EmbeddedSession {
  /**
   * @param {object} options
   * @param {(method: string, params?: object, timeoutMs?: number) => Promise<any>} options.call
   */
  constructor({ call }) {
    /** @type {(method: string, params?: object, timeoutMs?: number) => Promise<any>} */
    this.call = call;
    this.state = "starting";
    this.browserVersion = "embedded-webview";
    this.options = { viewport: { width: 0, height: 0, dpr: 1 } };
    this._screencastOn = false;
    this._tabs = [];
    this.navListeners = new Set();
    this.humanInputListeners = new Set();
  }

  async start() {
    const info = await this.call("start", {}, DEFAULT_TIMEOUT);
    if (info?.viewport) this.options.viewport = { ...info.viewport };
    this._setTabs(info?.tabs);
    this.state = "ready";
    return this;
  }

  /** 渲染进程的标签用 id，host 的工具与格式化用 targetId：统一成 targetId。 */
  _setTabs(list) {
    if (!Array.isArray(list)) return this._tabs;
    this._tabs = list.map((tab) => ({
      targetId: String(tab?.targetId ?? tab?.id ?? ""),
      url: String(tab?.url ?? ""),
      title: String(tab?.title ?? ""),
      active: Boolean(tab?.active),
    }));
    return this._tabs;
  }

  /* ---- 与 BrowserSession 对齐的订阅接口（嵌入模式没有帧流） ---- */

  onFrame() { return () => {}; }
  onNavigated(fn) { this.navListeners.add(fn); return () => this.navListeners.delete(fn); }
  onHumanInput(fn) { this.humanInputListeners.add(fn); return () => this.humanInputListeners.delete(fn); }

  /** host 收到渲染进程的「有人在操作」通知时调用。 */
  emitHumanInput(kind = "pointer") {
    for (const fn of this.humanInputListeners) {
      try { fn(kind); } catch {}
    }
  }

  async startScreencast() { return false; }
  async stopScreencast() { this._screencastOn = false; }
  async captureHdFrame() { return null; }
  async setViewport(next) { if (next) this.options.viewport = { ...next }; }

  /* ---- 页面操作 ---- */

  async getState() {
    const state = await this.call("state", {}, DEFAULT_TIMEOUT);
    if (state?.viewport) this.options.viewport = { ...state.viewport };
    return state;
  }

  async snapshot() { return this.call("snapshot", {}, DEFAULT_TIMEOUT); }

  async navigate(url) {
    const state = await this.call("navigate", { url }, DEFAULT_TIMEOUT);
    this._emitNavigated(state?.url);
    return state;
  }

  async navigateHistory(delta = -1) {
    const state = await this.call("history", { delta: Number(delta) < 0 ? -1 : 1 }, DEFAULT_TIMEOUT);
    this._emitNavigated(state?.url);
    return state;
  }

  async clickRef(ref) { return this.call("click", { ref: String(ref) }, DEFAULT_TIMEOUT); }
  async clickAt(x, y) { return this.call("click", { x: Number(x), y: Number(y) }, DEFAULT_TIMEOUT); }
  async typeRef(ref, text, options = {}) {
    return this.call("type", { ref: String(ref), text: String(text ?? ""), clear: Boolean(options.clear) }, DEFAULT_TIMEOUT);
  }
  async typeText(text) { return this.call("type", { text: String(text ?? "") }, DEFAULT_TIMEOUT); }
  async press(key) { return this.call("press", { key: String(key) }, DEFAULT_TIMEOUT); }
  async scroll(options = {}) { return this.call("scroll", { deltaY: Number(options.deltaY ?? 600) }, DEFAULT_TIMEOUT); }
  async focusWindow() { await this.call("focus", {}, 5_000).catch(() => null); return true; }

  async screenshot(options = {}) {
    const result = await this.call("screenshot", { quality: options.quality ?? 80, fullPage: Boolean(options.fullPage) }, 60_000);
    const base64 = String(result?.data ?? "").replace(/^data:[^,]*,/, "");
    if (!base64) throw new Error("嵌入模式截图失败：没有拿到图像数据");
    return { data: Buffer.from(base64, "base64"), format: result?.format === "png" ? "png" : "jpeg" };
  }

  async evaluate(expression) { return this.call("eval", { expression: String(expression) }, 60_000); }

  /* ---- 标签页 ---- */

  /** 同步返回最近一次已知的标签列表（host 的 state 广播需要同步值）。 */
  listTabs() { return this._tabs; }

  async newTab(url = "about:blank") {
    const tabs = await this.call("tabs", { action: "new", url }, DEFAULT_TIMEOUT);
    return this._setTabs(tabs);
  }

  async selectTab(targetId) {
    const tabs = await this.call("tabs", { action: "select", tabId: String(targetId) }, DEFAULT_TIMEOUT);
    return this._setTabs(tabs);
  }

  async closeTab(targetId) {
    const tabs = await this.call("tabs", { action: "close", tabId: String(targetId) }, DEFAULT_TIMEOUT);
    return this._setTabs(tabs);
  }

  async refreshTabs() {
    const tabs = await this.call("tabs", { action: "list" }, DEFAULT_TIMEOUT).catch(() => null);
    return this._setTabs(tabs);
  }

  async close() {
    this.state = "dead";
    await this.call("close", {}, 5_000).catch(() => {});
  }

  _emitNavigated(url) {
    for (const fn of this.navListeners) {
      try { fn(url); } catch {}
    }
  }
}