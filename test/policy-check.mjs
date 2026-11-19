#!/usr/bin/env node
/**
 * lib/policy.js 的离线单测（零依赖、不需要 DSH / 浏览器）。
 *
 *   node test/policy-check.mjs
 *
 * 全部通过时最后一行打印 `PASS <n>`；任一断言失败打印 `FAIL` 明细并以 exit code 1 退出。
 */
import { isDeepStrictEqual } from "node:util";
import { createPolicy } from "../lib/policy.js";

const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${String(detail).slice(0, 160)}` : ""}`);
}

function eq(name, actual, expected) {
  const ok = isDeepStrictEqual(actual, expected);
  check(name, ok, ok ? "" : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

function section(title) {
  console.log(`\n# ${title}`);
}

/* ------------------------------------------------------------------ *
 * 0. 各种配置下构造出来的策略
 * ------------------------------------------------------------------ */

const base = createPolicy();
const blockedWildcard = createPolicy({ blockedHosts: ["*.example.com"] });
const blockedExact = createPolicy({ blockedHosts: ["example.com"] });
const priority = createPolicy({ allowedHosts: ["example.com"], blockedHosts: ["example.com"] });
const strict = createPolicy({ allowedHosts: ["example.com", "*.trusted.test", "localhost", "127.0.0.1"] });
const portBlocked = createPolicy({ blockedHosts: ["127.0.0.1:43129"] });
const portAllowed = createPolicy({ allowedHosts: ["example.com:8443"] });
const emptyAllow = createPolicy({ allowedHosts: [] });

check("createPolicy() 返回完整 API", ["checkNavigation", "requiresApproval", "redact", "isSensitiveField"].every((k) => typeof base[k] === "function"));
check("createPolicy(null) 不抛错并回退默认配置", createPolicy(null).checkNavigation("https://ok.test/").allowed === true);

/* ------------------------------------------------------------------ *
 * 1. checkNavigation —— 正常地址
 * ------------------------------------------------------------------ */

section("checkNavigation：允许的地址");

eq("https 绝对地址允许，host 统一小写，URL 规范化", base.checkNavigation("https://Example.COM/Path"), {
  allowed: true,
  url: "https://example.com/Path",
  host: "example.com",
});
eq("http loopback 允许", base.checkNavigation("http://127.0.0.1:3000/a"), {
  allowed: true,
  url: "http://127.0.0.1:3000/a",
  host: "127.0.0.1",
});
eq("相对地址按 baseUrl 解析", base.checkNavigation("/docs", "https://example.com/app/"), {
  allowed: true,
  url: "https://example.com/docs",
  host: "example.com",
});
eq("query / fragment 原样保留", base.checkNavigation("https://example.com/a?b=1#c"), {
  allowed: true,
  url: "https://example.com/a?b=1#c",
  host: "example.com",
});
eq("URL 对象作为入参", base.checkNavigation(new URL("https://example.com/x")), {
  allowed: true,
  url: "https://example.com/x",
  host: "example.com",
});
eq("about:blank 特例允许（无 host）", base.checkNavigation("about:blank"), { allowed: true, url: "about:blank", host: "" });
eq("ABOUT:BLANK 大小写不敏感", base.checkNavigation("ABOUT:BLANK"), { allowed: true, url: "about:blank", host: "" });
eq("白名单非空时 about:blank 仍允许", strict.checkNavigation("about:blank"), { allowed: true, url: "about:blank", host: "" });

/* ------------------------------------------------------------------ *
 * 2. checkNavigation —— 非法 URL
 * ------------------------------------------------------------------ */

section("checkNavigation：非法 URL → invalid-url");

eq("空字符串", base.checkNavigation(""), { allowed: false, reason: "invalid-url", url: "" });
eq("纯空白", base.checkNavigation("   "), { allowed: false, reason: "invalid-url", url: "" });
eq("缺少 host 的 http://", base.checkNavigation("http://"), { allowed: false, reason: "invalid-url", url: "http://" });
eq("裸域名（无 baseUrl）", base.checkNavigation("example.com"), { allowed: false, reason: "invalid-url", url: "example.com" });
eq("非法 baseUrl", base.checkNavigation("https://ok.test/", "not a url"), { allowed: false, reason: "invalid-url", url: "https://ok.test/" });
eq("非字符串入参", base.checkNavigation(123), { allowed: false, reason: "invalid-url", url: "" });
eq("null 入参", base.checkNavigation(null), { allowed: false, reason: "invalid-url", url: "" });
eq("内嵌凭据 URL 拒绝（README 安全边界）", base.checkNavigation("https://user:secret@example.com/"), {
  allowed: false,
  reason: "invalid-url",
  url: "https://user:secret@example.com/",
  host: "example.com",
});

/* ------------------------------------------------------------------ *
 * 3. checkNavigation —— 协议白名单
 * ------------------------------------------------------------------ */

section("checkNavigation：非 http(s) 协议 → unsupported-scheme");

for (const [label, raw, expectedUrl] of [
  ["javascript:", "javascript:alert(1)", "javascript:alert(1)"],
  ["data:", "data:text/html,x", "data:text/html,x"],
  ["file:", "file:///C:/Windows/win.ini", "file:///C:/Windows/win.ini"],
  ["blob:", "blob:https://example.com/123", "blob:https://example.com/123"],
  ["about: 非 blank", "about:config", "about:config"],
]) {
  eq(`${label} 拒绝`, base.checkNavigation(raw), { allowed: false, reason: "unsupported-scheme", url: expectedUrl });
}

eq("协议检查先于域名白名单", strict.checkNavigation("file:///x"), { allowed: false, reason: "unsupported-scheme", url: "file:///x" });

/* ------------------------------------------------------------------ *
 * 4. checkNavigation —— blockedHosts
 * ------------------------------------------------------------------ */

section("checkNavigation：blockedHosts");

eq("精确域命中", blockedExact.checkNavigation("https://example.com/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://example.com/",
  host: "example.com",
});
eq("精确域不拦子域", blockedExact.checkNavigation("https://sub.example.com/"), {
  allowed: true,
  url: "https://sub.example.com/",
  host: "sub.example.com",
});
eq("黑名单压过白名单", priority.checkNavigation("https://example.com/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://example.com/",
  host: "example.com",
});
eq("*. 拦一级子域", blockedWildcard.checkNavigation("https://a.example.com/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://a.example.com/",
  host: "a.example.com",
});
eq("*. 拦多级子域", blockedWildcard.checkNavigation("https://a.b.example.com/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://a.b.example.com/",
  host: "a.b.example.com",
});
check("*. 不拦 apex 域", blockedWildcard.checkNavigation("https://example.com/").allowed === true);
check("*. 不误伤 notexample.com", blockedWildcard.checkNavigation("https://notexample.com/").allowed === true);
check("*. 不误伤 example.com.evil.test", blockedWildcard.checkNavigation("https://example.com.evil.test/").allowed === true);
eq("黑名单配置大小写不敏感", createPolicy({ blockedHosts: ["BadHost.TEST"] }).checkNavigation("https://badhost.test/x"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://badhost.test/x",
  host: "badhost.test",
});
eq("黑名单支持 host:port（只拦该端口）", portBlocked.checkNavigation("http://127.0.0.1:43129/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "http://127.0.0.1:43129/",
  host: "127.0.0.1",
});
check("黑名单 host:port 不影响同 host 其他端口", portBlocked.checkNavigation("http://127.0.0.1:3000/").allowed === true);
check("黑名单支持 IPv6 + 端口", createPolicy({ blockedHosts: ["[::1]:8080"] }).checkNavigation("http://[::1]:8080/x").allowed === false);
check("blockedHosts 接受单个字符串", createPolicy({ blockedHosts: "blocked.test" }).checkNavigation("https://blocked.test/").allowed === false);

/* ------------------------------------------------------------------ *
 * 5. checkNavigation —— allowedHosts
 * ------------------------------------------------------------------ */

section("checkNavigation：allowedHosts");

eq("白名单精确域命中", strict.checkNavigation("https://example.com/"), {
  allowed: true,
  url: "https://example.com/",
  host: "example.com",
});
eq("白名单 *. 命中子域", strict.checkNavigation("https://a.trusted.test/"), {
  allowed: true,
  url: "https://a.trusted.test/",
  host: "a.trusted.test",
});
eq("白名单 *. 不匹配 apex", strict.checkNavigation("https://trusted.test/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://trusted.test/",
  host: "trusted.test",
});
eq("白名单未命中 → blocked-domain", strict.checkNavigation("https://other.test/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://other.test/",
  host: "other.test",
});
eq("白名单不误伤前缀域名", strict.checkNavigation("https://example.com.evil.test/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://example.com.evil.test/",
  host: "example.com.evil.test",
});
check("白名单 localhost 放行任意端口", strict.checkNavigation("https://localhost:3000/").allowed === true);
check("白名单 127.0.0.1 放行任意端口", strict.checkNavigation("http://127.0.0.1:8080/").allowed === true);
check("allowedHosts=[] 表示不限制域名", emptyAllow.checkNavigation("https://anything.test/").allowed === true);
check("allowedHosts 非空时仍放行 about:blank", strict.checkNavigation("about:blank").allowed === true);
eq("allowedHosts 支持 host:port", portAllowed.checkNavigation("https://example.com:8443/"), {
  allowed: true,
  url: "https://example.com:8443/",
  host: "example.com",
});
eq("allowedHosts host:port 拦默认端口", portAllowed.checkNavigation("https://example.com/"), {
  allowed: false,
  reason: "blocked-domain",
  url: "https://example.com/",
  host: "example.com",
});

/* ------------------------------------------------------------------ *
 * 6. requiresApproval
 * ------------------------------------------------------------------ */

section("requiresApproval");

check("默认：upload 需要审批", base.requiresApproval({ type: "upload" }) === true);
check("默认：eval 需要审批", base.requiresApproval({ type: "eval" }) === true);
check("默认：dialog 需要审批", base.requiresApproval({ type: "dialog" }) === true);
check("默认：普通 navigate 不需要审批", base.requiresApproval({ type: "navigate", url: "https://example.com/" }) === false);
check("默认：跨域 navigate 需要审批", base.requiresApproval({ type: "navigate", url: "https://other.test/", crossOrigin: true }) === true);
check("默认：severity=high 的 navigate 需要审批", base.requiresApproval({ type: "navigate", severity: "high" }) === true);
check("默认：severity=low 的 navigate 不需要审批", base.requiresApproval({ type: "navigate", severity: "low" }) === false);
check("默认：click 不需要审批（由工具护栏负责）", base.requiresApproval({ type: "click" }) === false);
check("未知 type 不需要审批", base.requiresApproval({ type: "whatever" }) === false);
check("action=null 不需要审批", base.requiresApproval(null) === false);
check("type 大小写不敏感（Upload）", base.requiresApproval({ type: "Upload" }) === true);
check("severity 大小写不敏感（HIGH）", base.requiresApproval({ type: "navigate", severity: "HIGH" }) === true);

const preApprovedUploads = createPolicy({ approveUploads: true });
check("approveUploads=true：upload 免审批", preApprovedUploads.requiresApproval({ type: "upload" }) === false);
check("approveUploads=true 不影响 eval", preApprovedUploads.requiresApproval({ type: "eval" }) === true);

const preApprovedNav = createPolicy({ approveDangerousNavigate: true });
check("approveDangerousNavigate=true：跨域导航免审批", preApprovedNav.requiresApproval({ type: "navigate", crossOrigin: true }) === false);
check("approveDangerousNavigate=true：severity=high 免审批", preApprovedNav.requiresApproval({ type: "navigate", severity: "high" }) === false);
check("approveDangerousNavigate=true 不影响 upload", preApprovedNav.requiresApproval({ type: "upload" }) === true);

const evalEnabled = createPolicy({ allowEval: true });
check("allowEval=true 仍要求 eval 逐次审批", evalEnabled.requiresApproval({ type: "eval" }) === true);
check("allowEval 不影响 dialog（保持独立）", evalEnabled.requiresApproval({ type: "dialog" }) === true);

/* ------------------------------------------------------------------ *
 * 7. redact —— 各类敏感信息
 * ------------------------------------------------------------------ */

section("redact：内置规则");

eq("sk- 密钥", base.redact("token sk-abcdefghijklmnop1234567890 end"), {
  text: "token [REDACTED:sk-key] end",
  hits: [{ kind: "sk-key", count: 1 }],
});
eq("ghp_ GitHub token", base.redact(`ghp_${"a".repeat(36)}`), {
  text: "[REDACTED:github-token]",
  hits: [{ kind: "github-token", count: 1 }],
});
eq("xoxb- Slack token", base.redact("xoxb-123456789012-abcdefghij"), {
  text: "[REDACTED:slack-token]",
  hits: [{ kind: "slack-token", count: 1 }],
});
eq("AKIA AWS Access Key", base.redact("AKIAIOSFODNN7EXAMPLE"), {
  text: "[REDACTED:aws-access-key]",
  hits: [{ kind: "aws-access-key", count: 1 }],
});
eq("ASIA AWS 临时 Access Key", base.redact("ASIAIOSFODNN7EXAMPLE"), {
  text: "[REDACTED:aws-access-key]",
  hits: [{ kind: "aws-access-key", count: 1 }],
});
eq("Bearer token（整段替换）", base.redact("Authorization: Bearer abc.def.ghi12345"), {
  text: "Authorization: [REDACTED:bearer-token]",
  hits: [{ kind: "bearer-token", count: 1 }],
});
check("过短的 Bearer 值不算 token", base.redact("Bearer short").hits.length === 0);
eq("邮箱", base.redact("mail alice@example.com now"), {
  text: "mail [REDACTED:email] now",
  hits: [{ kind: "email", count: 1 }],
});
eq("16 位卡号（连续 + 4-4-4-4 聚合计数）", base.redact("card 4111111111111111 and 4111-1111-1111-1111"), {
  text: "card [REDACTED:card-number] and [REDACTED:card-number]",
  hits: [{ kind: "card-number", count: 2 }],
});
eq("password= 形式（只抹值）", base.redact("password=hunter2&user=bob"), {
  text: "password=[REDACTED:password]&user=bob",
  hits: [{ kind: "password", count: 1 }],
});
eq('"password":"..." JSON 形式（保留键名）', base.redact('{"user":"bob","password":"hunter2"}'), {
  text: '{"user":"bob","password":"[REDACTED:password]"}',
  hits: [{ kind: "password", count: 1 }],
});
eq("JSON 键值与冒号周围空白保留", base.redact('{"password" : "hunter2"}'), {
  text: '{"password" : "[REDACTED:password]"}',
  hits: [{ kind: "password", count: 1 }],
});
eq("单引号值的 password 形式", base.redact("{'password':'hunter2'}"), {
  text: "{'password':'[REDACTED:password]'}",
  hits: [{ kind: "password", count: 1 }],
});
eq("多个邮箱按同一 kind 聚合", base.redact("two alice@example.com bob@example.com"), {
  text: "two [REDACTED:email] [REDACTED:email]",
  hits: [{ kind: "email", count: 2 }],
});

section("redact：组合与边界");

eq("多类命中时 hits 按规则顺序排列", base.redact("sk-abcdefghijklmnop1234567890 alice@example.com 4111111111111111 Bearer tok123456789"), {
  text: "[REDACTED:sk-key] [REDACTED:email] [REDACTED:card-number] [REDACTED:bearer-token]",
  hits: [
    { kind: "bearer-token", count: 1 },
    { kind: "sk-key", count: 1 },
    { kind: "email", count: 1 },
    { kind: "card-number", count: 1 },
  ],
});
eq("普通文本不变", base.redact("hello world"), { text: "hello world", hits: [] });
eq("短 sk- 前缀不误伤（sk-learn）", base.redact("hello world sk-learn task-123"), {
  text: "hello world sk-learn task-123",
  hits: [],
});
eq("15 位数字不算卡号", base.redact("order 123456789012345"), { text: "order 123456789012345", hits: [] });
eq("null 输入回退空串", base.redact(null), { text: "", hits: [] });
eq("非字符串输入转字符串", base.redact(42), { text: "42", hits: [] });
check("重复调用结果稳定（无 regex lastIndex 状态）", isDeepStrictEqual(base.redact("sk-abcdefghijklmnop1234567890"), base.redact("sk-abcdefghijklmnop1234567890")));

section("redact：redactPatterns 自定义");

const custom = createPolicy({ redactPatterns: ["\\b\\d{3}-\\d{2}-\\d{4}\\b"] });
eq("自定义正则生效，kind=custom-1", custom.redact("ssn 123-45-6789"), {
  text: "ssn [REDACTED:custom-1]",
  hits: [{ kind: "custom-1", count: 1 }],
});
eq("内置规则与自定义规则叠加", custom.redact("sk-abcdefghijklmnop1234567890 ssn 123-45-6789"), {
  text: "[REDACTED:sk-key] ssn [REDACTED:custom-1]",
  hits: [
    { kind: "sk-key", count: 1 },
    { kind: "custom-1", count: 1 },
  ],
});
const invalidCustom = createPolicy({ redactPatterns: ["([unclosed"] });
check("非法自定义正则被忽略且不抛错", invalidCustom.redact("sk-abcdefghijklmnop1234567890").text === "[REDACTED:sk-key]");
const mixedCustom = createPolicy({ redactPatterns: ["([bad", "\\b\\d{3}-\\d{2}-\\d{4}\\b"] });
eq("非法项跳过后 kind 仍按配置下标命名", mixedCustom.redact("ssn 123-45-6789"), {
  text: "ssn [REDACTED:custom-2]",
  hits: [{ kind: "custom-2", count: 1 }],
});

/* ------------------------------------------------------------------ *
 * 8. isSensitiveField
 * ------------------------------------------------------------------ */

section("isSensitiveField");

check("type=password", base.isSensitiveField({ type: "password" }) === true);
check("type=PASSWORD 大小写不敏感", base.isSensitiveField({ type: "PASSWORD" }) === true);
check("autocomplete=current-password", base.isSensitiveField({ autocomplete: "current-password" }) === true);
check("autocomplete=new-password", base.isSensitiveField({ autocomplete: "new-password" }) === true);
check("autocomplete=one-time-code", base.isSensitiveField({ autocomplete: "one-time-code" }) === true);
check("autocomplete 多 token 串", base.isSensitiveField({ autocomplete: "section-login current-password webauthn" }) === true);
check("autocomplete 大小写不敏感", base.isSensitiveField({ autocomplete: "Current-Password" }) === true);
check("name 含 password", base.isSensitiveField({ name: "user_password" }) === true);
check("name 含 pwd", base.isSensitiveField({ name: "pwd" }) === true);
check("name 含 secret", base.isSensitiveField({ name: "api_secret" }) === true);
check("name 含 token", base.isSensitiveField({ name: "csrf_token" }) === true);
check("name 含 otp", base.isSensitiveField({ name: "otp_code" }) === true);
check("placeholder 含验证码", base.isSensitiveField({ placeholder: "请输入验证码" }) === true);
check("普通文本框不敏感", base.isSensitiveField({ type: "text", name: "email", placeholder: "Email address" }) === false);
check("type=email 不敏感", base.isSensitiveField({ type: "email" }) === false);
check("autocomplete=off 不敏感", base.isSensitiveField({ autocomplete: "off" }) === false);
check("role=textbox 不敏感", base.isSensitiveField({ role: "textbox" }) === false);
check("null 字段不敏感", base.isSensitiveField(null) === false);
check("空对象不敏感", base.isSensitiveField({}) === false);

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\nPASS ${pass}`);
if (fail > 0) {
  console.log(`FAIL ${fail}/${results.length}`);
  process.exitCode = 1;
}