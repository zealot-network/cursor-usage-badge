// background.js — MV3 service worker
// Single source of truth for Cursor usage state; drives the badge.
//
// Two account shapes are supported:
//
//  • Unified ("The X Subscription", Oct 2026+): one weekly included pool
//    shared across Cursor, Bugbot, Grok Bot and Grok, plus prepaid
//    "additional usage". Read from the grok.com dashboard API
//    (GET /dashboard/api/dashboard/v2/usage-status?scope=user). Plan name
//    and prepaid credit are not readable from an extension (see grokGet).
//  • Legacy Cursor plans (Pro / Pro+ / Ultra / Teams): two monthly pools
//    plus on-demand. Read from cursor.com GET /api/usage-summary; auth is
//    the WorkosCursorSessionToken cookie.
//
// Both are unofficial dashboard endpoints called with the user's existing
// browser session (host_permissions + credentials: "include").

const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log("[Cursor Usage Badge]", ...args); };

const DEFAULT_STATE = {
  mode: null,           // "unified" | "legacy" | null
  pools: {
    weekly: null,       // unified only: { utilization, label, products: [{ label, pct }] }
    cursorModels: null, // { utilization, label }
    otherModels: null,  // { utilization, label }
  },
  planDetail: {
    used: null,
    limit: null,
    remaining: null,
    included: null,
    bonus: null,
  },
  onDemand: {
    enabled: null,      // null = unknown, false = off, true = on
    status: null,       // "on" | "off" | null
    usedUsd: null,
    limitUsd: null,
    remainingUsd: null,
    utilization: null,  // uncapped % when limit is set
    overLimit: null,
    inUse: null,        // on + a pool exhausted
    resetsAt: null,     // unified: monthly additional-usage reset (epoch ms)
    creditBalanceUsd: null, // reserved: not readable from an extension today
  },
  subscriptionTier: null,
  billingCycleStart: null,
  billingCycleEnd: null, // epoch ms — pool reset (weekly on unified, monthly on legacy)
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null,      // 'no_session' | 'auth' | 'network' | 'unknown'
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function toEpoch(v) {
  if (!v) return null;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// On-demand fields from /usage-summary are integer cents.
function centsToUsd(v) {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return null;
  return v / 100;
}

function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "ultra" || s.includes("ultra")) return "ultra";
  if (s === "pro_plus" || s === "proplus" || s.includes("pro_plus") || s.includes("proplus")) {
    return "pro_plus";
  }
  if (s === "plus") return "plus";
  if (s === "premium" || s.includes("premium")) return "premium";
  if (s === "super" || s.startsWith("super")) return "super";
  if (s === "enterprise" || s.includes("enterprise")) return "enterprise";
  if (s === "team" || s.includes("team") || s.includes("business")) return "team";
  if (s === "pro" || s === "hobby" || s.includes("pro")) return "pro";
  if (s === "free" || s.includes("free")) return "free";
  return s;
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─── Badge rendering ────────────────────────────────────────────────────────

// Toolbar badge: deeper tones of the Grok code-syntax palette so white
// badge text stays readable at ~9px on light and dark Chrome toolbars.
// Live % badge overlay — same traffic-light bands as Claude Usage Badge.
const COLOR_GREEN = "#15803D";
const COLOR_AMBER = "#B45309";
const COLOR_RED = "#B91C1C";
const COLOR_GREY = "#3F3F46";
const BADGE_TEXT = "#FFFFFF";

// Icon brand accents (xAI orange ring + SpaceX starlight hex).
const ICON_ORANGE = "#FF6308";
const ICON_HEX = "#F0F0FA";
const ICON_BG = "#0A0A0A";
const ICON_TRACK = "#2A2A2A";

// Match cursor.com/dashboard/spending display rounding.
function displayPct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return 0;
  const rounded = Math.round(pct);
  return rounded === 0 ? 1 : Math.min(999, rounded);
}

function computeBadge(state) {
  const unified = state.mode === "unified";
  const weeklyPct = unified ? state.pools?.weekly?.utilization ?? null : null;
  const cursorPct = unified ? null : state.pools?.cursorModels?.utilization ?? null;
  const otherPct = unified ? null : state.pools?.otherModels?.utilization ?? null;
  const onDemand = state.onDemand || {};
  const odName = unified ? "Additional usage" : "On-demand";

  const candidates = [weeklyPct, cursorPct, otherPct].filter((v) => v != null);
  if (candidates.length === 0) {
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `Cursor Usage Tracker — ${state.lastError}`,
        fillPct: 0,
      };
    }
    return {
      text: "",
      color: COLOR_GREY,
      title: "Cursor Usage Tracker — no data yet",
      fillPct: 0,
    };
  }

  const worst = Math.max(...candidates);
  const pct = displayPct(worst);
  const text = `${pct}%`;

  let color;
  if (onDemand.inUse || onDemand.overLimit) color = COLOR_RED;
  else if (worst >= 90) color = COLOR_RED;
  else if (worst >= 70) color = COLOR_AMBER;
  else color = COLOR_GREEN;

  const parts = [];
  if (weeklyPct != null) parts.push(`Weekly pool: ${displayPct(weeklyPct)}%`);
  if (cursorPct != null) parts.push(`Cursor Models: ${displayPct(cursorPct)}%`);
  if (otherPct != null) parts.push(`Other Models: ${displayPct(otherPct)}%`);
  if (onDemand.status === "on") {
    const label = onDemand.overLimit
      ? `${odName}: OVER LIMIT`
      : onDemand.inUse
        ? `${odName}: IN USE`
        : `${odName}: ON`;
    parts.push(label);
    if (onDemand.usedUsd != null && onDemand.limitUsd != null) {
      const upct =
        onDemand.utilization != null ? ` (${displayPct(onDemand.utilization)}%)` : "";
      parts.push(
        `$${onDemand.usedUsd.toFixed(2)} / $${onDemand.limitUsd.toFixed(2)}${upct}`
      );
    } else if (onDemand.usedUsd != null) {
      parts.push(
        unified
          ? `$${onDemand.usedUsd.toFixed(2)} this month`
          : `~$${onDemand.usedUsd.toFixed(2)} on-demand`
      );
    }
  } else if (onDemand.status === "off") {
    parts.push(`${odName}: OFF`);
  }
  if (state.billingCycleEnd) {
    const diff = state.billingCycleEnd - Date.now();
    if (diff > 0) {
      const days = Math.ceil(diff / 86400000);
      if (days >= 2) parts.push(`Resets in ${days}d`);
      else {
        const mins = Math.max(0, Math.round(diff / 60000));
        const hrs = Math.floor(mins / 60);
        const rm = mins % 60;
        parts.push(rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`);
      }
    }
  }
  if (state.lastError) {
    parts.push(`Last refresh failed: ${state.lastError}`);
  }

  return {
    text,
    color,
    title: parts.join(" · "),
    fillPct: Math.max(0, Math.min(100, worst)),
  };
}

// ─── Dynamic toolbar icon (filled rounded hex + progress ring) ──────────────

function hexPoints(cx, cy, r) {
  // Pointy-top hexagon (Cursor cube silhouette).
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function roundedHexPath(ctx, cx, cy, r, cornerR) {
  const pts = hexPoints(cx, cy, r);
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const dPrev = Math.hypot(prev[0] - curr[0], prev[1] - curr[1]) || 1;
    const dNext = Math.hypot(next[0] - curr[0], next[1] - curr[1]) || 1;
    const rr = Math.min(cornerR, dPrev * 0.18, dNext * 0.18);
    const fromPrev = [
      curr[0] + ((prev[0] - curr[0]) / dPrev) * rr,
      curr[1] + ((prev[1] - curr[1]) / dPrev) * rr,
    ];
    const toNext = [
      curr[0] + ((next[0] - curr[0]) / dNext) * rr,
      curr[1] + ((next[1] - curr[1]) / dNext) * rr,
    ];
    if (i === 0) ctx.moveTo(fromPrev[0], fromPrev[1]);
    else ctx.lineTo(fromPrev[0], fromPrev[1]);
    ctx.quadraticCurveTo(curr[0], curr[1], toNext[0], toNext[1]);
  }
  ctx.closePath();
}

function paintIcon(ctx, size, fillPct, ringColor) {
  const cx = size / 2;
  const cy = size / 2;
  ctx.clearRect(0, 0, size, size);

  // Soft near-black disc so the mark reads on light & dark toolbars.
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fillStyle = ICON_BG;
  ctx.fill();

  const ringR = size * 0.38;
  const ringW = Math.max(2, size * 0.1);

  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = ICON_TRACK;
  ctx.lineWidth = ringW;
  ctx.lineCap = "round";
  ctx.stroke();

  const pct = Math.max(0, Math.min(100, fillPct || 0));
  if (pct > 0) {
    const start = -Math.PI / 2;
    // Minimum visible sweep so sub-1% usage still shows a tick.
    const sweep = Math.max((pct / 100) * Math.PI * 2, 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, start, start + sweep);
    // Ring always uses xAI orange; severity is the % badge overlay color.
    ctx.strokeStyle = ICON_ORANGE;
    ctx.lineWidth = ringW;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // Solid filled hexagon with rounded corners — SpaceX starlight, not pure white.
  const hexR = size * 0.2;
  const cornerR = Math.max(1.2, size * 0.045);
  roundedHexPath(ctx, cx, cy, hexR, cornerR);
  ctx.fillStyle = ICON_HEX;
  ctx.fill();
}

function drawIconBitmap(size, fillPct, ringColor) {
  // 4× supersample then downscale — kills the cheap aliased hex edges.
  const scale = 4;
  const big = size * scale;
  const hi = new OffscreenCanvas(big, big);
  const hctx = hi.getContext("2d");
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = "high";
  paintIcon(hctx, big, fillPct, ringColor);

  const lo = new OffscreenCanvas(size, size);
  const lctx = lo.getContext("2d");
  lctx.imageSmoothingEnabled = true;
  lctx.imageSmoothingQuality = "high";
  lctx.clearRect(0, 0, size, size);
  lctx.drawImage(hi, 0, 0, big, big, 0, 0, size, size);
  return lctx.getImageData(0, 0, size, size);
}

async function setProgressIcon(fillPct, ringColor) {
  try {
    const images = {
      16: drawIconBitmap(16, fillPct, ringColor),
      32: drawIconBitmap(32, fillPct, ringColor),
    };
    await chrome.action.setIcon({ imageData: images });
  } catch (e) {
    dbg("setProgressIcon failed:", e);
  }
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title, fillPct } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Older Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
  await setProgressIcon(fillPct ?? 0, color);
}

// ─── State writes (serialized) ──────────────────────────────────────────────

let writeQueue = Promise.resolve();

function mergeState(partial) {
  writeQueue = writeQueue
    .then(async () => {
      const { usageState } = await chrome.storage.local.get("usageState");
      const prev = usageState || DEFAULT_STATE;
      const next = {
        ...prev,
        ...partial,
        pools: { ...DEFAULT_STATE.pools, ...(prev.pools || {}), ...(partial.pools || {}) },
        planDetail: {
          ...DEFAULT_STATE.planDetail,
          ...(prev.planDetail || {}),
          ...(partial.planDetail || {}),
        },
        onDemand: {
          ...DEFAULT_STATE.onDemand,
          ...(prev.onDemand || {}),
          ...(partial.onDemand || {}),
        },
      };
      await chrome.storage.local.set({ usageState: next });
      await refreshBadge();
    })
    .catch((e) => dbg("mergeState error:", e));
  return writeQueue;
}

// ─── Auth / API ─────────────────────────────────────────────────────────────

async function hasSessionCookie() {
  try {
    const cookie = await chrome.cookies.get({
      name: "WorkosCursorSessionToken",
      url: "https://cursor.com",
    });
    return !!(cookie && cookie.value);
  } catch {
    return false;
  }
}

class ApiError extends Error {
  constructor(status, endpoint) {
    super(`API ${status}: ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function apiGet(endpoint) {
  const resp = await fetch(`https://cursor.com/api${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  try {
    return await resp.json();
  } catch {
    throw new ApiError(0, endpoint);
  }
}

async function apiPost(endpoint, body = {}) {
  const resp = await fetch(`https://cursor.com/api${endpoint}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://cursor.com",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  try {
    return await resp.json();
  } catch {
    throw new ApiError(0, endpoint);
  }
}

// Dashboard calls are abandoned after this long so a hanging host cannot
// stall the refresh cycle. grok.com has been measured at ~9s on a cold call.
const FETCH_TIMEOUT_MS = 20_000;

// grok.com dashboard API (unified accounts). Only GET is usable from an
// extension: grok.com rejects POSTs whose Origin is chrome-extension://
// ("Invalid origin for state-changing request"), so plan name and prepaid
// credit balance are not available. Signed-out responses are a 401 or a
// cross-origin redirect to the sign-in host — both surface as a throw.
async function grokGet(endpoint) {
  const resp = await fetch(`https://grok.com/dashboard/api/dashboard${endpoint}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new ApiError(resp.status, endpoint);
  try {
    return await resp.json();
  } catch {
    throw new ApiError(0, endpoint);
  }
}

// ─── Throttle ───────────────────────────────────────────────────────────────

async function getThrottle() {
  try {
    const { throttle } = await chrome.storage.session.get("throttle");
    return throttle || {};
  } catch {
    return {};
  }
}

async function patchThrottle(partial) {
  try {
    const prev = await getThrottle();
    await chrome.storage.session.set({ throttle: { ...prev, ...partial } });
  } catch {
    // best-effort
  }
}

// ─── Parse usage-summary (+ optional period-usage fallback) ─────────────────

function pickPercent(...candidates) {
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function parseUsageSummary(summary, period = null) {
  const plan = summary?.individualUsage?.plan || {};
  const onDemandRaw =
    summary?.individualUsage?.onDemand ||
    summary?.teamUsage?.onDemand ||
    {};

  // Prefer summary fields; fill gaps from get-current-period-usage if present.
  const autoPct = pickPercent(
    plan.autoPercentUsed,
    period?.autoPercentUsed,
    period?.planUsage?.autoPercentUsed
  );
  const apiPct = pickPercent(
    plan.apiPercentUsed,
    period?.apiPercentUsed,
    period?.planUsage?.apiPercentUsed
  );

  const used = numOrNull(plan.used ?? period?.planUsage?.used);
  const limit = numOrNull(plan.limit ?? period?.planUsage?.limit);
  const remaining = numOrNull(plan.remaining ?? period?.planUsage?.remaining);
  const breakdown = plan.breakdown || period?.planUsage?.breakdown || {};

  const odEnabled =
    typeof onDemandRaw.enabled === "boolean"
      ? onDemandRaw.enabled
      : typeof period?.onDemand?.enabled === "boolean"
        ? period.onDemand.enabled
        : null;

  const odUsedRaw = numOrNull(
    onDemandRaw.used ?? period?.onDemand?.used ?? period?.onDemandSpend
  );
  const odLimitRaw = numOrNull(
    onDemandRaw.limit ?? period?.onDemand?.limit ?? period?.onDemandLimit
  );
  const odRemainingRaw = numOrNull(
    onDemandRaw.remaining ?? period?.onDemand?.remaining
  );

  const usedUsd = centsToUsd(odUsedRaw);
  const limitUsd = centsToUsd(odLimitRaw);
  const remainingUsd = centsToUsd(odRemainingRaw);

  const utilization =
    usedUsd != null && limitUsd != null && limitUsd > 0
      ? (usedUsd / limitUsd) * 100
      : null;
  const overLimit =
    usedUsd != null && limitUsd != null && limitUsd > 0 && usedUsd > limitUsd;

  const poolExhausted =
    (autoPct != null && autoPct >= 100) || (apiPct != null && apiPct >= 100);
  const inUse = odEnabled === true && poolExhausted;

  let status = null;
  if (odEnabled === true) status = "on";
  else if (odEnabled === false) status = "off";

  return {
    mode: "legacy",
    pools: {
      weekly: null,
      cursorModels:
        autoPct != null
          ? { utilization: autoPct, label: "Cursor Models" }
          : null,
      otherModels:
        apiPct != null
          ? { utilization: apiPct, label: "Other Models" }
          : null,
    },
    planDetail: {
      used,
      limit,
      remaining,
      included: numOrNull(breakdown.included),
      bonus: numOrNull(breakdown.bonus),
    },
    onDemand: {
      enabled: odEnabled,
      status,
      usedUsd,
      limitUsd,
      remainingUsd,
      utilization,
      overLimit,
      inUse,
      resetsAt: null,
      creditBalanceUsd: null,
    },
    subscriptionTier: normalizeTier(
      summary?.membershipType || period?.membershipType || null
    ),
    billingCycleStart: toEpoch(
      summary?.billingCycleStart || period?.billingCycleStart
    ),
    billingCycleEnd: toEpoch(
      summary?.billingCycleEnd || period?.billingCycleEnd
    ),
  };
}

// ─── Parse grok.com usage-status (unified accounts) ─────────────────────────

const PRODUCT_LABELS = {
  cursor: "Cursor",
  bugbot: "Bugbot",
  "grok-bot": "Grok Bot",
  "grok-chat": "Grok",
  api: "API",
};

function productLabel(id) {
  if (PRODUCT_LABELS[id]) return PRODUCT_LABELS[id];
  return String(id || "Other")
    .split(/[-_\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Whole-number product shares that sum to the displayed total (largest
// remainder), matching the grok.com usage page (e.g. 27 + 3 + 2 = 32%).
function splitProducts(byProduct, budgetCents, totalDisplay) {
  const rows = (Array.isArray(byProduct) ? byProduct : [])
    .map((p) => ({ id: p?.product, cents: numOrNull(Number(p?.cents)) }))
    .filter((p) => p.id && p.cents != null && p.cents > 0)
    .map((p) => {
      const raw = (p.cents / budgetCents) * 100;
      return { label: productLabel(p.id), raw, pct: Math.floor(raw) };
    });
  let left = Math.max(0, (totalDisplay ?? 0) - rows.reduce((a, r) => a + r.pct, 0));
  const byFrac = [...rows].sort((a, b) => (b.raw - b.pct) - (a.raw - a.pct));
  for (const r of byFrac) {
    if (left <= 0) break;
    r.pct += 1;
    left -= 1;
  }
  return rows
    .filter((r) => r.pct > 0)
    .sort((a, b) => b.raw - a.raw)
    .map(({ label, pct }) => ({ label, pct }));
}

// status: GET /v2/usage-status?scope=user. Returns null when the account
// has no metered weekly pool.
function parseUnified(status) {
  const w = status?.weeklyIncludedUsage || {};
  const used = numOrNull(Number(w.usedCents));
  const budget = numOrNull(Number(w.budgetCents));
  if (used == null || budget == null || budget <= 0) return null;
  const weeklyPct = (used / budget) * 100;

  const m = status?.monthlyUsage || {};
  const usedUsd = centsToUsd(numOrNull(Number(m.usedCents ?? NaN)));
  const limitRaw = m.limitCents == null ? null : numOrNull(Number(m.limitCents));
  const limitUsd = centsToUsd(limitRaw);
  const enabled =
    typeof m.additionalUsageOff === "boolean" ? !m.additionalUsageOff : null;
  const utilization =
    usedUsd != null && limitUsd != null && limitUsd > 0
      ? (usedUsd / limitUsd) * 100
      : null;
  const overLimit =
    usedUsd != null && limitUsd != null && limitUsd > 0 && usedUsd > limitUsd;

  return {
    mode: "unified",
    pools: {
      weekly: {
        utilization: weeklyPct,
        label: "Weekly included",
        products: splitProducts(
          status?.weeklyIncludedUsageByProduct,
          budget,
          displayPct(weeklyPct)
        ),
      },
      cursorModels: null,
      otherModels: null,
    },
    planDetail: { ...DEFAULT_STATE.planDetail },
    onDemand: {
      enabled,
      status: enabled === true ? "on" : enabled === false ? "off" : null,
      usedUsd,
      limitUsd,
      remainingUsd:
        usedUsd != null && limitUsd != null ? Math.max(0, limitUsd - usedUsd) : null,
      utilization,
      overLimit,
      inUse: enabled === true && weeklyPct >= 100,
      resetsAt: toEpoch(m.resetsAt),
      creditBalanceUsd: null,
    },
    subscriptionTier: null,
    billingCycleStart: toEpoch(w.periodStart),
    billingCycleEnd: toEpoch(w.resetsAt),
  };
}

const CURSOR_PRODUCTS = new Set(["cursor", "bugbot"]);

// Returns { parsed, hasCursorUsage }, { failed: "auth" | "network" }, or null
// when grok.com answered but the account has no metered weekly pool.
async function fetchUnified() {
  let status;
  try {
    status = await grokGet("/v2/usage-status?scope=user");
  } catch (e) {
    dbg("grok usage-status unavailable:", e);
    const auth = e instanceof ApiError && (e.status === 401 || e.status === 403);
    // A redirect to the sign-in host surfaces as a TypeError: treat as signed out.
    const signedOut = auth || (e instanceof TypeError && e.name !== "TimeoutError");
    return { failed: signedOut ? "auth" : "network" };
  }
  dbg("grok usage-status:", status);
  if (status?.weeklyIncludedStatus?.status !== "metered") return null;
  const parsed = parseUnified(status);
  if (!parsed) return null;
  const hasCursorUsage = (status.weeklyIncludedUsageByProduct || []).some(
    (p) => CURSOR_PRODUCTS.has(p?.product) && Number(p?.cents) > 0
  );
  return { parsed, hasCursorUsage };
}

function summaryHasPoolData(parsed) {
  return !!(
    parsed.pools?.cursorModels?.utilization != null ||
    parsed.pools?.otherModels?.utilization != null
  );
}

// ─── Main fetch cycle ───────────────────────────────────────────────────────

let inFlight = null;

function fetchUsageAndUpdate(force = false) {
  if (inFlight) return inFlight;
  inFlight = doFetchUsage(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFetchUsage(force = false) {
  if (!force) {
    const { backoffUntil = 0 } = await getThrottle();
    if (Date.now() < backoffUntil) return;
  }

  const commit = async (parsed) => {
    await patchThrottle({ backoffUntil: 0 });
    await mergeState({
      ...parsed,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  };

  // Unified (X Subscription) accounts live on grok.com; try that first and
  // keep the result as a fallback if the legacy cursor.com path fails.
  // grok.com cannot say whether an account is unified, so: a weekly pool that
  // Cursor or Bugbot has drawn from is unified; otherwise a signed-in legacy
  // cursor.com session wins, and the weekly pool is the fallback.
  let unified = null;

  try {
    const grok = await fetchUnified();
    unified = grok?.parsed ? grok : null;
    const signedIn = await hasSessionCookie();
    if (unified && (unified.hasCursorUsage || !signedIn)) {
      await commit(unified.parsed);
      return;
    }

    if (!signedIn) {
      const unreachable = grok?.failed === "network";
      await mergeState({
        lastError: unreachable
          ? "Couldn't reach grok.com — will retry."
          : "Not signed in to Cursor or Grok.",
        errorCode: unreachable ? "network" : "no_session",
        lastErrorAt: Date.now(),
      });
      return;
    }

    let summary;
    try {
      summary = await apiGet("/usage-summary");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      // Try period-usage as a hard fallback if summary itself fails.
      dbg("usage-summary failed, trying get-current-period-usage", err);
      const period = await apiPost("/dashboard/get-current-period-usage", {});
      const parsed = parseUsageSummary({}, period);
      if (!summaryHasPoolData(parsed)) throw err;
      await patchThrottle({ backoffUntil: 0 });
      await mergeState({
        ...parsed,
        lastUpdated: Date.now(),
        lastError: null,
        errorCode: null,
      });
      return;
    }

    dbg("usage-summary:", summary);

    let period = null;
    let parsed = parseUsageSummary(summary, null);
    if (!summaryHasPoolData(parsed)) {
      try {
        period = await apiPost("/dashboard/get-current-period-usage", {});
        dbg("get-current-period-usage:", period);
        parsed = parseUsageSummary(summary, period);
      } catch (e) {
        dbg("period-usage fallback failed:", e);
      }
    }

    if (!summaryHasPoolData(parsed)) {
      if (unified) {
        await commit(unified.parsed);
        return;
      }
      await mergeState({
        ...parsed,
        lastError: "Usage summary had no pool percentages.",
        errorCode: "unknown",
        lastErrorAt: Date.now(),
      });
      return;
    }

    await patchThrottle({ backoffUntil: 0 });
    await mergeState({
      ...parsed,
      lastUpdated: Date.now(),
      lastError: null,
      errorCode: null,
    });
  } catch (err) {
    if (unified) {
      await commit(unified.parsed);
      return;
    }
    console.error("[Cursor Usage Badge] fetch error:", err);
    let errorCode = "unknown";
    let lastError = err.message || "Failed to fetch usage";
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        errorCode = "auth";
        lastError = "Cursor session expired or unauthorized.";
      } else if (err.status === 404) {
        errorCode = "unknown";
        lastError = "Cursor usage API not found — the API may have changed.";
      } else if (err.status === 429) {
        errorCode = "network";
        lastError = "Rate limited by cursor.com — backing off.";
        await patchThrottle({ backoffUntil: Date.now() + 5 * 60_000 });
      } else if (err.status === 0) {
        errorCode = "network";
        lastError = "Unexpected non-JSON response from cursor.com.";
      } else {
        errorCode = "network";
      }
    } else if (err?.name === "TimeoutError") {
      errorCode = "network";
      lastError = "cursor.com took too long to respond — will retry.";
    } else if (err instanceof TypeError) {
      errorCode = "network";
      lastError = "Network error reaching cursor.com.";
    }
    await mergeState({ lastError, errorCode, lastErrorAt: Date.now() });
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ usageState: DEFAULT_STATE });
  } else {
    const { usageState } = await chrome.storage.local.get("usageState");
    await chrome.storage.local.set({
      usageState: {
        ...DEFAULT_STATE,
        ...(usageState || {}),
        pools: { ...DEFAULT_STATE.pools, ...((usageState && usageState.pools) || {}) },
        planDetail: {
          ...DEFAULT_STATE.planDetail,
          ...((usageState && usageState.planDetail) || {}),
        },
        onDemand: {
          ...DEFAULT_STATE.onDemand,
          ...((usageState && usageState.onDemand) || {}),
        },
      },
    });
  }
  await refreshBadge();
  fetchUsageAndUpdate();
});

refreshBadge().catch(() => {});

chrome.alarms.get("refreshUsage").then((existing) => {
  if (!existing) chrome.alarms.create("refreshUsage", { periodInMinutes: 3 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refreshUsage") fetchUsageAndUpdate();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_USAGE_STATE") {
    chrome.storage.local
      .get("usageState")
      .then(({ usageState }) => sendResponse(usageState || DEFAULT_STATE))
      .catch(() => sendResponse(DEFAULT_STATE));
    return true;
  }
  if (msg?.type === "FORCE_REFRESH" || msg?.type === "CURSOR_USAGE_UPDATE") {
    fetchUsageAndUpdate(true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
