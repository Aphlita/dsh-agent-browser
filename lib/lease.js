/**
 * 单写者租约：谁在操作浏览器（agent 或人）。
 *
 * 规则（对应架构文档 §6）：
 *  - 同一时刻最多一个 writer；其他人拿到的是「只读观察者」。
 *  - 人类随时可抢占（immediate takeover），agent 的租约立即失效并收到原因。
 *  - 租约带 TTL：agent 默认 30s，人类默认 120s；每次操作/心跳续期。
 *  - 到期自动释放，回到 free。
 *  - 抢占/过期都发事件，host 半把它转成 client 提示与审计日志。
 */

export const LEASE_EVENT = Object.freeze({
  ACQUIRED: "acquired",
  RENEWED: "renewed",
  RELEASED: "released",
  PREEMPTED: "preempted",
  EXPIRED: "expired",
});

export class LeaseManager {
  /**
   * @param {object} [options]
   * @param {number} [options.agentTtlMs]
   * @param {number} [options.humanTtlMs]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.agentTtlMs = options.agentTtlMs ?? 30_000;
    this.humanTtlMs = options.humanTtlMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
    this.lease = null; // { id, ownerId, kind, label, acquiredAt, expiresAt, ttlMs }
    this.seq = 0;
    this.listeners = new Set();
    this.timer = setInterval(() => this._sweep(), 1_000);
    this.timer.unref?.();
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit(type, extra = {}) {
    const event = { type, at: this.now(), lease: this.lease ? { ...this.lease } : null, ...extra };
    for (const fn of this.listeners) { try { fn(event); } catch {} }
  }

  ttlFor(kind) { return kind === "human" ? this.humanTtlMs : this.agentTtlMs; }

  status() {
    if (!this.lease) return { holder: null, free: true };
    return {
      free: false,
      holder: { ...this.lease },
      remainingMs: Math.max(0, this.lease.expiresAt - this.now()),
    };
  }

  isHolder(ownerId) { return Boolean(this.lease && this.lease.ownerId === ownerId); }

  /**
   * 申请/续期。同一 owner 再次 acquire 视为续期（便于每次工具调用顺手续期）。
   * @param {{ownerId:string, kind:'agent'|'human', label?:string, force?:boolean}} req
   * @returns {{ok:true, lease:object} | {ok:false, reason:string, holder:object|null}}
   */
  acquire({ ownerId, kind = "agent", label, force = false }) {
    const at = this.now();
    if (this.lease && this.lease.ownerId === ownerId) {
      this.lease.expiresAt = at + this.ttlFor(this.lease.kind);
      this._emit(LEASE_EVENT.RENEWED);
      return { ok: true, lease: { ...this.lease } };
    }
    if (this.lease && !force) {
      const humanPreempt = kind === "human"; // 人类永远可以抢占
      if (!humanPreempt) {
        return { ok: false, reason: "busy", holder: { ...this.lease } };
      }
      const preempted = { ...this.lease };
      this.lease = null;
      this._emit(LEASE_EVENT.PREEMPTED, { preempted, by: { ownerId, kind } });
    }
    this.lease = {
      id: `lease-${++this.seq}`,
      ownerId,
      kind,
      label: label ?? (kind === "human" ? "用户" : "agent"),
      acquiredAt: at,
      expiresAt: at + this.ttlFor(kind),
      ttlMs: this.ttlFor(kind),
    };
    this._emit(LEASE_EVENT.ACQUIRED);
    return { ok: true, lease: { ...this.lease } };
  }

  renew(ownerId) {
    if (!this.isHolder(ownerId)) return { ok: false, reason: "not-holder", holder: this.status().holder };
    this.lease.expiresAt = this.now() + this.ttlFor(this.lease.kind);
    this._emit(LEASE_EVENT.RENEWED);
    return { ok: true, lease: { ...this.lease } };
  }

  release(ownerId, reason = "released") {
    if (!this.lease || this.lease.ownerId !== ownerId) return { ok: false, reason: "not-holder" };
    const released = { ...this.lease };
    this.lease = null;
    this._emit(LEASE_EVENT.RELEASED, { released, reason });
    return { ok: true };
  }

  /** 人类点「接管」按钮：无论当前是谁，立即换成人类租约。 */
  takeOver(human) {
    return this.acquire({ kind: "human", ownerId: human.ownerId ?? "human", label: human.label ?? "用户", force: true });
  }

  _sweep() {
    if (!this.lease) return;
    if (this.now() >= this.lease.expiresAt) {
      const expired = { ...this.lease };
      this.lease = null;
      this._emit(LEASE_EVENT.EXPIRED, { expired });
    }
  }

  dispose() { clearInterval(this.timer); this.listeners.clear(); this.lease = null; }
}