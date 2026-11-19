/**
 * dsh-agent-browser —— 安全策略（零依赖 ESM）
 *
 * 把四件互相独立的事收在一个纯函数模块里，供 host 半（lib/index.js）调用：
 *
 *  1. checkNavigation(rawUrl, baseUrl?)   协议白名单 + 域名黑名单/白名单
 *  2. requiresApproval(action)            哪些动作必须让用户在右栏点「允许」
 *  3. redact(text)                        把密钥/令牌/邮箱/卡号/密码值从外发文本里抹掉
 *  4. isSensitiveField(field)             判断页面表单字段是否敏感（密码/验证码/令牌）
 *
 * 设计约定：
 *  - 纯函数：不启动浏览器、不写日志、不读文件、不碰全局状态；
 *  - 每次 createPolicy() 编译一次配置（host 规则、自定义脱敏正则），之后只做匹配；
 *  - 默认值即安全默认：默认要审批、默认拒绝非 http(s)、默认脱敏常见密钥。
 */

/** 允许导航的协议（URL.protocol 形式）。 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 唯一允许的 about: URL —— 空白页（新标签页初始态）。 */
const ABOUT_BLANK = "about:blank";

/* ------------------------------------------------------------------ *
 * 脱敏规则
 *
 * 规则按数组顺序依次应用；后面的规则看到的是前面替换后的文本，
 * 所以「整段值」的规则（password、Bearer）放在「密钥形状」规则前面，
 * 避免同一个令牌被归到两种 kind、或残留半截。
 * ------------------------------------------------------------------ */

const marker = (kind) => `[REDACTED:${kind}]`;

/**
 * 内置脱敏规则。kind 会出现在 [REDACTED:<kind>] 与 redact().hits 里，
 * 调整名字等于改对外契约，慎动。
 */
const BUILTIN_REDACT_RULES = [
  {
    // JSON 形式：{"password":"..."} / {"passwd":"..."} / {"pwd":"..."}
    // 只替换值，保留键名与引号风格，便于人读懂被抹掉的是什么。
    kind: "password",
    regex: /((["'])(?:password|passwd|pwd)\2\s*:\s*)"((?:[^"\\]|\\.)*)"/gi,
    replacer: (match, lead) => `${lead}"${marker("password")}"`,
  },
  {
    // JSON 形式（单引号值）：{'password':'...'}
    kind: "password",
    regex: /((["'])(?:password|passwd|pwd)\2\s*:\s*)'((?:[^'\\]|\\.)*)'/gi,
    replacer: (match, lead) => `${lead}'${marker("password")}'`,
  },
  {
    // query / 表单形式：password=...（值到空白或分隔符为止）
    kind: "password",
    regex: /(\bpassword\s*=\s*)[^\s&"'<>,;]+/gi,
    replacer: (match, lead) => `${lead}${marker("password")}`,
  },
  {
    // HTTP 头：Authorization: Bearer <token>
    kind: "bearer-token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacer: () => marker("bearer-token"),
  },
  {
    // OpenAI / Anthropic 风格：sk-...（sk-proj-...、sk-ant-... 都覆盖）
    kind: "sk-key",
    regex: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacer: () => marker("sk-key"),
  },
  {
    // GitHub token：ghp_ / gho_ / ghu_ / ghs_ / ghr_
    kind: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replacer: () => marker("github-token"),
  },
  {
    // Slack token：xoxb- / xoxp- / xoxa- / xoxr- / xoxs-
    kind: "slack-token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacer: () => marker("slack-token"),
  },
  {
    // AWS Access Key ID：AKIA... / ASIA...
    kind: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacer: () => marker("aws-access-key"),
  },
  {
    // 邮箱
    kind: "email",
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacer: () => marker("email"),
  },
  {
    // 16 位卡号：连续 16 位，或 4-4-4-4（空格/短横分隔）
    kind: "card-number",
    regex: /\b\d{4}(?:[ -]?\d{4}){3}\b/g,
    replacer: () => marker("card-number"),
  },
];

/** 敏感字段 autocomplete token（大小写不敏感，允许出现在多 token 串里）。 */
const SENSITIVE_AUTOCOMPLETE_TOKENS = ["current-password", "new-password", "one-time-code"];

/** 敏感字段 name / placeholder / role 关键字（大小写不敏感）。 */
const SENSITIVE_NAME_RE = /pass|pwd|secret|token|otp|验证码/i;

/* ------------------------------------------------------------------ *
 * 配置解析
 * ------------------------------------------------------------------ */

/** 配置里的列表既接受数组也接受单个字符串；非法项忽略。 */
function toList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

/**
 * 把配置里的 host 规则解析成 { host, port, wildcard }。
 *
 * 支持：
 *  - `example.com`                 精确域（不含子域）
 *  - `*.example.com` / `.example.com`  子域匹配（不含 example.com 本身）
 *  - `example.com:8080`            精确域 + 端口
 *  - `[::1]:8080`                  IPv6 + 端口
 *  - `https://example.com`         带协议的写法（容忍）
 *  - 中文/IDN 域名                  尽量转 punycode 后比较
 *
 * 解析失败的条目返回 null（静默忽略，避免一个笔误让整条策略失效）。
 */
function parseHostRule(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim().toLowerCase();
  if (!text) return null;

  let wildcard = false;
  if (text.startsWith("*.") || text.startsWith(".")) {
    wildcard = true;
    text = text.replace(/^\*?\./, "");
  }

  // 容忍误写成完整 URL 的条目；解析失败就退回当普通 host 文本处理。
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      const url = new URL(text);
      text = url.hostname.toLowerCase() + (url.port ? `:${url.port}` : "");
    } catch {
      text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    }
  }

  const cut = text.search(/[/?#]/);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.trim();
  if (!text) return null;

  let host = text;
  let port = null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return null;
    const after = host.slice(end + 1);
    host = host.slice(0, end + 1);
    if (/^:\d+$/.test(after)) port = after.slice(1);
    else if (after !== "") return null;
  } else {
    const colon = host.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  if (!host) return null;

  // IDN → punycode，保证与 URL.hostname 的表示一致。
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}${port ? `:${port}` : ""}`).hostname.toLowerCase();
    } catch {}
  }

  return { host, port, wildcard };
}

/** host 规则是否命中（hostname 不含端口；port 为 URL.port，默认端口为空串）。 */
function matchesHostRule(rule, hostname, port) {
  const host = hostname.toLowerCase();
  const sameHost = rule.wildcard
    ? host !== rule.host && host.endsWith(`.${rule.host}`)
    : host === rule.host;
  if (!sameHost) return false;
  if (rule.port !== null && rule.port !== port) return false;
  return true;
}

function matchesAny(rules, hostname, port) {
  return rules.some((rule) => matchesHostRule(rule, hostname, port));
}

/** 编译 config.redactPatterns（字符串正则，忽略非法项；kind = custom-<配置下标+1>）。 */
function compileCustomRules(patterns) {
  const rules = [];
  const list = Array.isArray(patterns) ? patterns : [];
  list.forEach((pattern, index) => {
    if (typeof pattern !== "string" || pattern.trim() === "") return;
    let regex;
    try {
      regex = new RegExp(pattern, "gi");
    } catch {
      return; // 非法正则忽略：脱敏是兜底能力，不能因为一条配置笔误就抛错。
    }
    rules.push({ kind: `custom-${index + 1}`, regex, replacer: () => marker(`custom-${index + 1}`) });
  });
  return rules;
}

/* ------------------------------------------------------------------ *
 * 对外工厂
 * ------------------------------------------------------------------ */

/**
 * 创建一份策略实例。
 *
 * @param {object} [config]
 * @param {string[]} [config.allowedHosts]  非空时白名单：未命中的 http(s) 导航 → blocked-domain
 * @param {string[]} [config.blockedHosts]  黑名单，优先于白名单
 * @param {boolean} [config.allowEval]      是否允许 browser_eval（index.js 侧开关；policy 不据此放松审批）
 * @param {boolean} [config.approveUploads] 已预批准上传：true → 上传不再需要审批（默认 false = 需要审批）
 * @param {boolean} [config.approveDangerousNavigate] 已预批准危险导航：true → 危险导航不再需要审批（默认 false）
 * @param {string[]} [config.redactPatterns] 额外脱敏正则（字符串；非法项忽略）
 */
export function createPolicy(config = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const blockedRules = toList(cfg.blockedHosts).map(parseHostRule).filter(Boolean);
  const allowedRules = toList(cfg.allowedHosts).map(parseHostRule).filter(Boolean);
  const redactRules = [...BUILTIN_REDACT_RULES, ...compileCustomRules(cfg.redactPatterns)];
  const approveUploads = cfg.approveUploads === true;
  const approveDangerousNavigate = cfg.approveDangerousNavigate === true;

  function deny(reason, url, host) {
    const result = { allowed: false, reason, url };
    if (host) result.host = host;
    return result;
  }

  /**
   * 像地址栏一样校验一次导航。
   *
   * @param {string|URL} rawUrl 目标地址（可以是相对地址，配合 baseUrl 解析）
   * @param {string|URL} [baseUrl] 相对地址的基准（通常是当前页 URL）
   * @returns {{allowed:true,url:string,host:string}|{allowed:false,reason:"invalid-url"|"unsupported-scheme"|"blocked-domain",url:string,host?:string}}
   */
  function checkNavigation(rawUrl, baseUrl) {
    const raw = rawUrl instanceof URL ? rawUrl.href : typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!raw) return { allowed: false, reason: "invalid-url", url: raw };

    let url;
    try {
      url = baseUrl == null ? new URL(raw) : new URL(raw, baseUrl instanceof URL ? baseUrl.href : String(baseUrl));
    } catch {
      return { allowed: false, reason: "invalid-url", url: raw };
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol === "about:") {
      // 唯一特例：about:blank（新标签页/清空页面），没有 host，也不受域名白名单限制。
      if (url.href.toLowerCase() === ABOUT_BLANK) return { allowed: true, url: ABOUT_BLANK, host: "" };
      return deny("unsupported-scheme", url.href);
    }
    if (!ALLOWED_PROTOCOLS.has(protocol)) return deny("unsupported-scheme", url.href, url.hostname || undefined);

    // 内嵌凭据 URL（https://user:pass@host）按 README「安全边界」拒绝，避免凭据随 URL 进入模型上下文/审计。
    if (url.username || url.password) {
      return deny("invalid-url", url.href, url.hostname || undefined);
    }

    const hostname = url.hostname.toLowerCase();
    const port = url.port;

    // 黑名单优先：即使同时出现在白名单里也拒绝。
    if (matchesAny(blockedRules, hostname, port)) return deny("blocked-domain", url.href, hostname);

    // 白名单非空时，未命中即拒绝；空数组 = 不限制域名（只有协议限制）。
    if (allowedRules.length > 0 && !matchesAny(allowedRules, hostname, port)) {
      return deny("blocked-domain", url.href, hostname);
    }

    return { allowed: true, url: url.href, host: hostname };
  }

  /**
   * 该动作是否需要用户在右栏点「允许」。
   *
   * @param {{type?:string,url?:string,crossOrigin?:boolean,severity?:"low"|"high"}} [action]
   * @returns {boolean}
   */
  function requiresApproval(action) {
    if (!action || typeof action !== "object") return false;
    const type = String(action.type ?? "").trim().toLowerCase();
    switch (type) {
      case "upload":
        // 默认必须审批；approveUploads=true 表示用户在配置里预批准了上传。
        return !approveUploads;
      case "eval":
        // browser_eval 每次都审批：allowEval 只是「允许出现这个工具」，不是「免审批」。
        return true;
      case "dialog":
        // 页面弹窗（alert/confirm/prompt/beforeunload）一律审批；与 allowEval/eval 完全独立。
        return true;
      case "navigate": {
        if (approveDangerousNavigate) return false;
        const severity = String(action.severity ?? "").trim().toLowerCase();
        return action.crossOrigin === true || severity === "high";
      }
      default:
        // click 等其余动作由 index.js 的工具护栏处理，policy 不额外拦截。
        return false;
    }
  }

  /**
   * 抹掉文本里的敏感信息。
   *
   * @param {string} text
   * @returns {{text:string, hits:Array<{kind:string, count:number}>}} hits 按首次命中的规则顺序排列
   */
  function redact(text) {
    let out = typeof text === "string" ? text : text == null ? "" : String(text);
    const counts = new Map();
    for (const rule of redactRules) {
      out = out.replace(rule.regex, (...args) => {
        const hit = rule.replacer(...args);
        counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
        return hit;
      });
    }
    return { text: out, hits: [...counts].map(([kind, count]) => ({ kind, count })) };
  }

  /**
   * 表单字段是否敏感（快照里不把值回传给模型、type 前先脱敏等场景用）。
   *
   * @param {{type?:string,name?:string,autocomplete?:string,placeholder?:string,role?:string}} [field]
   * @returns {boolean}
   */
  function isSensitiveField(field) {
    if (!field || typeof field !== "object") return false;

    const type = typeof field.type === "string" ? field.type.trim().toLowerCase() : "";
    if (type === "password") return true;

    const autocomplete = typeof field.autocomplete === "string" ? field.autocomplete.toLowerCase() : "";
    if (autocomplete && SENSITIVE_AUTOCOMPLETE_TOKENS.some((token) => autocomplete.includes(token))) return true;

    for (const key of ["name", "placeholder", "role"]) {
      const value = field[key];
      if (typeof value === "string" && value && SENSITIVE_NAME_RE.test(value)) return true;
    }
    return false;
  }

  return { checkNavigation, requiresApproval, redact, isSensitiveField };
}