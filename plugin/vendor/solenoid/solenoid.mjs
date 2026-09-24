// src/amounts.ts
var ceilMicro = (v) => {
  const m = v * 1e6, r = Math.round(m);
  return (Math.abs(m - r) <= Number.EPSILON * 8 * Math.max(1, Math.abs(m)) ? r : Math.ceil(m)) / 1e6;
};
function cleanAmounts(a, allowZero = false) {
  const out = {};
  for (const [unit, v] of Object.entries(a)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new TypeError(`solenoid: invalid amount for ${unit}`);
    const c = ceilMicro(v);
    if (c > 0 || allowZero) out[unit] = c;
  }
  if (Object.keys(out).length === 0) throw new TypeError("solenoid: nothing to spend");
  return out;
}

// src/errors.ts
var SolenoidError = class extends Error {
  constructor(status, code, detail = {}) {
    super(`solenoid: ${code} (${status})`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
};
var LimitExceeded = class extends SolenoidError {
  get scope() {
    return this.detail.scope;
  }
  get unit() {
    return this.detail.unit;
  }
  get resets() {
    return this.detail.resets ?? null;
  }
};
var SolenoidUnavailable = class extends Error {
  constructor(scope, cause) {
    super(`solenoid is unreachable and the limits on "${scope}" fail closed`, { cause });
    this.scope = scope;
  }
};
var Outage = class extends Error {
};
function toError(status, data) {
  const { error, ...detail } = data;
  const code = typeof error === "string" ? error : "unknown";
  return status === 402 ? new LimitExceeded(status, code, detail) : new SolenoidError(status, code, detail);
}

// src/http.ts
var transient = (e) => e instanceof Outage || e instanceof TypeError || e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
async function call(t, method, path, body, idem) {
  const attempt = async () => {
    const res = await t.fetch(t.api + path, {
      method,
      headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json", ...idem ? { "idempotency-key": idem } : {} },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(t.timeoutMs)
    });
    const data = res.ok ? await res.json() : await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status >= 500) throw new Outage(`HTTP ${res.status}`);
    throw toError(res.status, data);
  };
  const retryable = method === "GET" || idem !== void 0;
  try {
    return await attempt();
  } catch (e) {
    if (!transient(e)) throw e;
    if (!retryable) throw new Outage("request failed and is not safe to retry", { cause: e });
  }
  try {
    return await attempt();
  } catch (e) {
    if (!transient(e)) throw e;
    throw new Outage("solenoid unreachable", { cause: e });
  }
}

// src/bytes.ts
var enc = new TextEncoder();
var hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
var HEX_PAIRS = /^(?:[0-9a-f]{2})*$/;
function fromHex(h) {
  if (!HEX_PAIRS.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// src/keys.ts
var b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function deriveSpendKey(adminKey, scope, epoch) {
  const [sk, kind, tenant, gen, secret] = adminKey.split(".");
  if (sk !== "sk" || kind !== "admin" || !secret) throw new TypeError("solenoid: deriving a key needs the admin key");
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sk.spend.${tenant}.${gen}.${epoch}.${b64url(scope)}.${hex(await crypto.subtle.sign("HMAC", k, enc.encode(`spend:${scope}:${epoch}`)))}`;
}

// src/llm.ts
function readUsage(res) {
  const u = res?.usage;
  if (!u) return null;
  if (typeof u.prompt_tokens === "number") return { input: u.prompt_tokens, output: u.completion_tokens ?? 0 };
  if (typeof u.input_tokens === "number") return { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
  return null;
}
function capOutput(left, inputTokens, price) {
  const byTokens = left.tokens === void 0 ? Infinity : left.tokens - inputTokens;
  const byUsd = left.usd === void 0 || !price ? Infinity : (left.usd - inputTokens * price.input) / price.output;
  return Math.floor(Math.min(byTokens, byUsd));
}
function estimateInput(req) {
  const { model: _m, max_tokens: _a, max_completion_tokens: _b, ...rest } = req;
  return Math.ceil(JSON.stringify(rest).length / 4 * 1.2);
}
function leftFrom(limits) {
  const out = {};
  for (const l of limits) if (l.left !== null && (!out[l.unit] || l.left < out[l.unit].left)) out[l.unit] = { scope: l.scope, left: l.left, resets: null };
  return out;
}
var costOf = (u, price) => ({ tokens: u.input + u.output, ...price ? { usd: u.input * price.input + u.output * price.output } : {} });
function planCall(scope, req, left, price) {
  if (left.usd && !price) throw new SolenoidError(0, "unknown_price", { model: req.model });
  const input = estimateInput(req);
  const cap = capOutput({ tokens: left.tokens?.left, usd: left.usd?.left }, input, price);
  if (cap === Infinity) return { req, hold: null };
  if (cap < 1) {
    const unit = left.tokens && capOutput({ tokens: left.tokens.left }, input, price) < 1 ? "tokens" : "usd";
    throw new LimitExceeded(402, "limit_exceeded", { scope: left[unit]?.scope ?? scope, unit, local: true });
  }
  const field = "max_completion_tokens" in req ? "max_completion_tokens" : "max_tokens";
  const requested = typeof req[field] === "number" ? req[field] : price?.max_output ?? 4096;
  const out = Math.min(requested, cap);
  return { req: { ...req, [field]: out }, hold: costOf({ input, output: out }, price) };
}

// src/prices.json
var prices_default = {
  _checked: "2026-09-24",
  "gpt-4.1": { input: 2e-6, output: 8e-6, max_output: 32768 },
  "gpt-4.1-mini": { input: 4e-7, output: 16e-7, max_output: 32768 },
  "claude-sonnet-5": { input: 2e-6, output: 1e-5, max_output: 128e3 },
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6, max_output: 64e3 }
};

// src/scope.ts
var SEG = /^[a-z0-9._-]{1,64}$/;
function checkScope(scope) {
  if (scope === "") return "";
  const segs = scope.split("/");
  if (segs.length > 8 || !segs.every((x) => SEG.test(x) && !/^\.+$/.test(x))) throw new TypeError(`solenoid: invalid scope "${scope}"`);
  return scope;
}
function nearestFirst(scope) {
  const segs = scope === "" ? [] : scope.split("/");
  return [...segs.map((_, i) => segs.slice(0, segs.length - i).join("/")), ""];
}

// src/verify.ts
var HEX64 = /^[0-9a-f]{64}$/;
function b64urlDecode(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function jcs(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v;
  return `{${Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}
async function entryHash(prev, r) {
  const body = enc.encode(jcs({ seq: r.seq, kind: r.kind, scope: r.scope, body: r.body, at: r.at, kid: r.kid }));
  const msg = new Uint8Array(32 + body.length);
  msg.set(fromHex(prev));
  msg.set(body, 32);
  return hex(await crypto.subtle.digest("SHA-256", msg));
}
async function verifyReceipt(r, jwk) {
  if (!HEX64.test(r.prev) || !HEX64.test(r.hash)) return false;
  if (await entryHash(r.prev, r) !== r.hash) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  try {
    return await crypto.subtle.verify("Ed25519", key, b64urlDecode(r.sig), fromHex(r.hash));
  } catch {
    return false;
  }
}
async function verifyChain(ascending, keys) {
  for (let i = 0; i < ascending.length; i++) {
    const r = ascending[i];
    if (i > 0 && (r.prev !== ascending[i - 1].hash || r.seq !== ascending[i - 1].seq + 1)) return false;
    const jwk = keys[r.kid];
    if (!jwk || !await verifyReceipt(r, jwk)) return false;
  }
  return true;
}

// src/index.ts
var DEFAULT_API = "https://api.solenoid.systems";
var envVar = (name) => globalThis.process?.env[name];
var { _checked, ...BUNDLED_PRICES } = prices_default;
function memoryStore() {
  const m = /* @__PURE__ */ new Map();
  return { get: (s) => m.get(s), set: (s, v) => void m.set(s, v) };
}
async function signup(api = envVar("SOLENOID_API") ?? DEFAULT_API) {
  const res = await fetch(`${api.replace(/\/$/, "")}/auth/signup`, { method: "POST" });
  const data = await res.json();
  if (res.status !== 201) throw toError(res.status, data);
  return data;
}
function solenoid(opts = {}) {
  const key = opts.key ?? envVar("SOLENOID_KEY");
  if (!key) throw new TypeError("solenoid: set SOLENOID_KEY or pass { key }");
  const t = { api: (opts.api ?? envVar("SOLENOID_API") ?? DEFAULT_API).replace(/\/$/, ""), key, timeoutMs: opts.timeoutMs ?? 2e3, fetch: opts.fetch ?? globalThis.fetch.bind(globalThis) };
  const store = opts.store ?? memoryStore();
  const remaining = /* @__PURE__ */ new Map();
  let wellKnown;
  const path = (scope) => `/v1/${checkScope(scope)}`;
  const wellKnownKeys = () => wellKnown ??= t.fetch(`${t.api}/.well-known/solenoid.json`, { signal: AbortSignal.timeout(t.timeoutMs) }).then(async (r) => {
    if (!r.ok) throw new Outage(`HTTP ${r.status}`);
    return (await r.json()).keys;
  }).catch((e) => {
    wellKnown = void 0;
    throw e;
  });
  async function modeFor(scope) {
    for (const s of nearestFirst(scope)) {
      const m = await store.get(s);
      if (m) return m;
    }
    return "closed";
  }
  async function post(scope, body, idem) {
    const p = path(scope);
    try {
      const r = await call(t, "POST", p, body, idem);
      remaining.set(scope, { ...remaining.get(scope), ...r.remaining });
      for (const s of /* @__PURE__ */ new Set([scope, ...Object.values(r.remaining).map((x) => x.scope)])) await store.set(s, r.on_outage);
      if (r.warnings?.length) opts.onWarn?.(r.warnings);
      return r;
    } catch (e) {
      if (!(e instanceof Outage)) throw e;
      if (await modeFor(scope) === "open") return null;
      throw new SolenoidUnavailable(scope, e);
    }
  }
  const spend = async (scope, amounts, o = {}) => (await post(scope, cleanAmounts(amounts), o.idempotencyKey ?? crypto.randomUUID()))?.receipt ?? null;
  const settle = async (scope, idem, actual) => (await post(scope, { settle: cleanAmounts(actual, true) }, idem))?.receipt ?? null;
  const limit = (scope, body) => call(t, "PUT", path(scope), body);
  const rotate = (scope) => call(t, "PUT", path(scope), { rotate_keys: true });
  const rotateAdmin = async () => (await call(t, "PUT", path(""), { rotate_admin: true })).admin_key;
  const get = (scope, o = {}) => call(t, "GET", path(scope) + (o.before === void 0 ? "" : `?before=${o.before}`));
  async function verify(receipt) {
    const jwk = (await wellKnownKeys())[receipt.kid];
    return jwk ? verifyReceipt(receipt, jwk) : false;
  }
  const deriveKey = async (scope, epoch) => deriveSpendKey(key, checkScope(scope), epoch ?? (await get(scope)).epoch);
  const priceTable = { ...BUNDLED_PRICES, ...opts.prices ?? {} };
  const runId = () => `run-${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("")}`;
  const quietly = (p) => p.catch((e) => {
    if (e instanceof SolenoidError || e instanceof SolenoidUnavailable) return null;
    throw e;
  });
  function at(scope) {
    checkScope(scope);
    return {
      scope,
      spend: (amounts) => spend(scope, amounts),
      async llm(callFn, req, o = {}) {
        const r = req;
        const price = o.price ?? priceTable[String(r.model ?? "")];
        let left;
        try {
          const cached = remaining.get(scope);
          left = cached && ("tokens" in cached || "usd" in cached) ? cached : leftFrom((await call(t, "GET", path(scope))).limits);
        } catch (e) {
          if (!(e instanceof Outage)) throw e;
          if (await modeFor(scope) !== "open") throw new SolenoidUnavailable(scope, e);
          return callFn(req);
        }
        const plan = planCall(scope, r, left, price);
        if (!plan.hold) {
          const res2 = await callFn(req);
          const usage2 = readUsage(res2);
          if (usage2) {
            await spend(scope, costOf(usage2, price)).catch((e) => {
              if (e instanceof LimitExceeded) {
                remaining.set(scope, { ...remaining.get(scope) ?? {}, [e.unit]: { scope: e.scope, left: 0, resets: e.resets } });
                return null;
              }
              if (e instanceof SolenoidUnavailable) return null;
              throw e;
            });
          }
          return res2;
        }
        const hold = plan.hold;
        const idem = crypto.randomUUID();
        const held = await spend(scope, hold, { idempotencyKey: idem });
        let res;
        try {
          res = await callFn(plan.req);
        } catch (e) {
          if (held) await quietly(settle(scope, idem, Object.fromEntries(Object.keys(hold).map((u) => [u, 0]))));
          throw e;
        }
        const usage = readUsage(res);
        const cost = usage ? costOf(usage, price) : hold;
        if (held) await quietly(settle(scope, idem, Object.fromEntries(Object.keys(hold).map((u) => [u, cost[u] ?? 0]))));
        return res;
      }
    };
  }
  const run = (scope, fn) => fn(at(scope ? `${checkScope(scope)}/${runId()}` : runId()));
  return {
    spend,
    limit,
    rotate,
    rotateAdmin,
    get,
    verify,
    verifyChain: async (entries) => verifyChain(entries, await wellKnownKeys()),
    deriveKey,
    at,
    run,
    _internal: { t, remaining, modeFor, settle, path }
  };
}
export {
  LimitExceeded,
  Outage,
  SolenoidError,
  SolenoidUnavailable,
  checkScope,
  signup,
  solenoid,
  toError,
  verifyChain,
  verifyReceipt
};
