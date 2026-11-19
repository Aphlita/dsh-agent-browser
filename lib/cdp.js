// CDP 传输层：pipe（stdio fd3/fd4，默认）与 WebSocket（回退）。
// 零第三方依赖，Node 24+/Electron 43（内置 WebSocket、child_process.spawn）。
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export class CdpError extends Error {
  constructor(message, code = undefined, data = undefined) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.data = data;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 结束进程树（Windows 上 soffice 类子进程不会随父进程退出）。 */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  } catch {}
}

class BaseTransport {
  constructor() {
    this.closed = false;
    this.listeners = new Set();
    this.closeListeners = new Set();
  }
  onMessage(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onClose(fn) { this.closeListeners.add(fn); return () => this.closeListeners.delete(fn); }
  emitMessage(msg) { for (const fn of this.listeners) { try { fn(msg); } catch {} } }
  emitClose() { if (this.closed) return; this.closed = true; for (const fn of this.closeListeners) { try { fn(); } catch {} } }
  send(_obj) {}
  close() { this.emitClose(); }
}

/** --remote-debugging-pipe：写 fd3、读 fd4，消息以 NUL 分隔。不监听任何端口。 */
export class PipeTransport extends BaseTransport {
  constructor(child) {
    super();
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.exitCode = null;
    child.on("exit", (code) => { this.exitCode = code; this.emitClose(); });
    child.on("error", () => this.emitClose());
    this.in = child.stdio[4];
    this.out = child.stdio[3];
    if (!this.in || !this.out) throw new CdpError("pipe transport requires fd3/fd4 (stdio[3..4])");
    this.in.on("data", (chunk) => this._onData(chunk));
    this.in.on("error", () => this.emitClose());
  }
  static launch(executablePath, args, options = {}) {
    const child = spawn(executablePath, [...args, "--remote-debugging-pipe"], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: options.windowsHide !== false,
      cwd: options.cwd,
      env: options.env,
    });
    return new PipeTransport(child);
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const index = this.buf.indexOf(0);
      if (index < 0) break;
      const raw = this.buf.subarray(0, index).toString("utf8");
      this.buf = this.buf.subarray(index + 1);
      if (!raw.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      this.emitMessage(parsed);
    }
  }
  send(obj) {
    if (this.closed) return;
    try { this.out.write(JSON.stringify(obj) + "\0"); } catch { this.emitClose(); }
  }
  close() {
    const pid = this.child?.pid;
    try { this.out?.end?.(); } catch {}
    if (pid) killTree(pid);
    this.emitClose();
  }
}

/** 回退传输：--remote-debugging-port=0 + DevToolsActivePort。 */
export class WebSocketTransport extends BaseTransport {
  constructor(ws) {
    super();
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); } catch { return; }
      this.emitMessage(msg);
    });
    ws.addEventListener("close", () => this.emitClose());
    ws.addEventListener("error", () => this.emitClose());
  }
  static async connect(url, timeoutMs = 15000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
          ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
          ws.addEventListener("error", (event) => { clearTimeout(timer); reject(event?.error ?? new Error("websocket error")); }, { once: true });
        });
        return new WebSocketTransport(ws);
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    throw new CdpError(`cannot connect CDP websocket: ${lastError?.message ?? "unknown"}`);
  }
  send(obj) {
    if (this.closed) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { this.emitClose(); }
  }
  close() {
    try { this.ws.close(); } catch {}
    this.emitClose();
  }
}

/** 启动浏览器进程；defaultTransport 为 "pipe" 或 "ws"。 */
export async function launchBrowser({ executablePath, args = [], transport = "pipe", profileDir, env } = {}) {
  if (!executablePath) throw new CdpError("executablePath is required");
  if (transport === "pipe") {
    const pipe = PipeTransport.launch(executablePath, args, { env, windowsHide: true });
    return { transport: pipe, pid: pipe.child?.pid, mode: "pipe" };
  }
  const portFile = path.join(profileDir ?? path.dirname(executablePath), "DevToolsActivePort");
  await rm(portFile, { force: true }).catch(() => {});
  const child = spawn(executablePath, [...args, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  const deadline = Date.now() + 20000;
  let wsUrl = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const content = await readFile(portFile, "utf8");
      const [port, targetPath] = content.split("\n");
      if (port && targetPath) { wsUrl = `ws://127.0.0.1:${port.trim()}${targetPath.trim()}`; break; }
    } catch {}
    await sleep(100);
  }
  if (!wsUrl) {
    killTree(child.pid);
    throw new CdpError("browser did not expose DevToolsActivePort (CDP port mode)");
  }
  const transportImpl = await WebSocketTransport.connect(wsUrl);
  return { transport: transportImpl, pid: child.pid, mode: "ws", wsUrl };
}

/** CDP 客户端：请求/响应关联、事件分发、扁平化子会话（OOPIF）跟踪。 */
export class CdpClient {
  constructor(transport) {
    this.transport = transport;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closeHandlers = new Set();
    this.sessions = new Map(); // sessionId -> { sessionId, targetId, type }
    this.closed = false;
    transport.onMessage((msg) => this._dispatch(msg));
    transport.onClose(() => this._onClose());
  }

  _dispatch(msg) {
    if (msg == null) return;
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new CdpError(msg.error.message ?? "CDP error", msg.error.code, msg.error.data));
      else entry.resolve(msg.result);
      return;
    }
    const method = msg.method;
    if (!method) return;
    const sessionId = msg.sessionId;
    if (method === "Target.attachedToTarget" && msg.params?.sessionId) {
      this.sessions.set(msg.params.sessionId, {
        sessionId: msg.params.sessionId,
        targetId: msg.params.targetInfo?.targetId,
        type: msg.params.targetInfo?.type,
      });
    } else if (method === "Target.detachedFromTarget" && msg.params?.sessionId) {
      this.sessions.delete(msg.params.sessionId);
    }
    const list = this.handlers.get(method);
    if (list) for (const fn of [...list]) { try { fn(msg.params ?? {}, sessionId, msg); } catch {} }
    const any = this.handlers.get("*");
    if (any) for (const fn of [...any]) { try { fn(msg.params ?? {}, sessionId, msg); } catch {} }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new CdpError("CDP connection closed")); this.pending.delete(id); }
    for (const fn of this.closeHandlers) { try { fn(); } catch {} }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  onClose(fn) { this.closeHandlers.add(fn); return () => this.closeHandlers.delete(fn); }

  send(method, params = {}, sessionId = undefined, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new CdpError("CDP connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP timeout: ${method}`, "TIMEOUT"));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer, method });
      this.transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  waitFor(method, { predicate, sessionId, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const off = this.on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (predicate && !predicate(params, sid)) return;
        clearTimeout(timer);
        off();
        resolve({ params, sessionId: sid });
      });
      timer = setTimeout(() => { off(); reject(new CdpError(`CDP wait timeout: ${method}`, "TIMEOUT")); }, Math.max(1000, timeoutMs));
    });
  }

  iframeSessions() {
    return [...this.sessions.values()].filter((session) => session.type === "iframe");
  }

  close() {
    try { this.transport.close(); } catch {}
    this._onClose();
  }
}