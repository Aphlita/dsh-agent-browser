/**
 * 极简 RFC6455 WebSocket 服务端（只实现本插件需要的子集）
 *
 * 为什么不用 ws：插件的 host 半要求"运行时零第三方依赖"（见架构文档 §9 T6 / ADR-2），
 * 插件被 pnpm link 到 profile 时不一定能解析到别的包的 node_modules。
 *
 * 支持：握手（含 subprotocol 回显）、文本帧、二进制帧、ping/pong、close、
 * 分片重组、掩码校验、每帧 4MB 上限。不支持：permessage-deflate、扩展协商。
 */
import { createHash, randomUUID } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME = 4 * 1024 * 1024;

const OPCODE = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKeyOf(secWebSocketKey) {
  return createHash("sha1").update(secWebSocketKey + GUID).digest("base64");
}

class WsError extends Error {
  constructor(message, code = 1002) { super(message); this.wsCode = code; }
}

export class WsSocket {
  constructor(socket, head, req) {
    this.id = randomUUID();
    this.socket = socket;
    this.req = req;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.listeners = { message: new Set(), close: new Set(), error: new Set() };
    this.alive = true;

    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => { try { this._feed(chunk); } catch (e) { this._fail(e); } });
    socket.on("close", () => this._finish("socket-closed"));
    socket.on("error", (e) => this._finish("socket-error", e));
    socket.on("end", () => this._finish("socket-end"));
    if (head && head.length > 0) {
      try { this._feed(head); } catch (e) { this._fail(e); }
    }
  }

  on(event, fn) {
    const set = this.listeners[event];
    if (!set) throw new Error(`未知事件 ${event}`);
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, ...args) { for (const fn of this.listeners[event]) { try { fn(...args); } catch {} } }

  _finish(reason, error) {
    if (this.closed) return;
    this.closed = true;
    this.listeners.message.clear();
    if (error) this._emit("error", error);
    this._emit("close", reason);
    this.listeners.close.clear();
    this.listeners.error.clear();
  }

  _fail(error) {
    try { this._sendFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xea])); } catch {}
    try { this.socket.destroy(); } catch {}
    this._finish("protocol-error", error);
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** 从缓冲区读一帧；不完整返回 null。 */
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) throw new WsError("帧过大", 1009);
      length = Number(big);
      offset = 10;
    }
    if (!masked) throw new WsError("客户端帧必须带掩码", 1002);
    if (length > MAX_FRAME) throw new WsError("帧过大", 1009);
    if (buf.length < offset + 4 + length) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OPCODE.PING) { this._sendFrame(OPCODE.PONG, payload); return; }
    if (opcode === OPCODE.PONG) { this.alive = true; return; }
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      try { this._sendFrame(OPCODE.CLOSE, payload.subarray(0, 2)); } catch {}
      this.socket.end();
      this._finish(`close:${code}`);
      return;
    }
    if (opcode === OPCODE.CONT) {
      if (this.fragmentOpcode === 0) throw new WsError("无起始帧的分片", 1002);
      this.fragments.push(payload);
      if (this.fragments.reduce((n, b) => n + b.length, 0) > MAX_FRAME) throw new WsError("分片过大", 1009);
      if (fin) {
        const data = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._deliver(op, data);
      }
      return;
    }
    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (fin) { this._deliver(opcode, payload); return; }
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    throw new WsError(`不支持的 opcode ${opcode}`, 1003);
  }

  _deliver(opcode, data) {
    const isText = opcode === OPCODE.TEXT;
    this._emit("message", isText ? data.toString("utf8") : data, isText ? "text" : "binary");
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(data) {
    if (typeof data === "string") this._sendFrame(OPCODE.TEXT, Buffer.from(data, "utf8"));
    else this._sendFrame(OPCODE.BINARY, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try { this._sendFrame(OPCODE.CLOSE, payload); } catch {}
    try { this.socket.end(); } catch {}
    this._finish(`closed:${code}`);
  }
}

/**
 * 无 server 的 WS 服务端：把 registerUpgrade 拿到的原始 socket 交给它。
 * 用法：
 *   const server = new WsServer();
 *   ctx.webServer.registerUpgrade({ path, handler: (req, socket, head) => server.handleUpgrade(req, socket, head) });
 *   server.on("connection", (ws) => {...});
 */
export class WsServer {
  constructor(options = {}) {
    this.clients = new Set();
    this.listeners = new Set();
    this.path = options.path ?? "/";
  }

  onConnection(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  handleUpgrade(req, socket, head) {
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
    if (upgrade !== "websocket" || typeof key !== "string" || key === "" || req.headers["sec-websocket-version"] !== "13") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return null;
    }
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKeyOf(key)}`,
    ];
    const protocol = req.headers["sec-websocket-protocol"];
    if (typeof protocol === "string" && protocol !== "") {
      headers.push(`Sec-WebSocket-Protocol: ${protocol.split(",")[0].trim()}`);
    }
    socket.write(headers.join("\r\n") + "\r\n\r\n");

    const ws = new WsSocket(socket, head, req);
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    for (const fn of this.listeners) { try { fn(ws, req); } catch {} }
    return ws;
  }

  broadcast(data) {
    for (const ws of this.clients) {
      try { ws.send(data); } catch {}
    }
  }

  get size() { return this.clients.size; }

  closeAll() {
    for (const ws of this.clients) { try { ws.close(1001); } catch {} }
    this.clients.clear();
  }
}