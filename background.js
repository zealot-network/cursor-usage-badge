// background.js — MV3 service worker
// Single source of truth for Cursor usage state; drives the badge.
//
// Polls Cursor's unofficial dashboard endpoint GET /api/usage-summary
// (same data the web dashboard uses). Auth is the WorkosCursorSessionToken
// cookie — chrome.cookies + host_permissions let the service worker call
// with credentials: "include".

const DEBUG = false;
const dbg = (...args) => { if (DEBUG) console.log("[Cursor Usage Badge]", ...args); };

const DEFAULT_STATE = {
  pools: {
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
  },
  subscriptionTier: null,
  billingCycleStart: null,
  billingCycleEnd: null, // epoch ms — shared reset for both pools
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

const COLOR_GREEN = "#15803D";
const COLOR_AMBER = "#B45309";
const COLOR_RED = "#B91C1C";
const COLOR_GREY = "#52525B";
const BADGE_TEXT = "#FFFFFF";

function computeBadge(state) {
  const cursorPct = state.pools?.cursorModels?.utilization ?? null;
  const otherPct = state.pools?.otherModels?.utilization ?? null;
  const onDemand = state.onDemand || {};

  const candidates = [cursorPct, otherPct].filter((v) => v != null);
  if (candidates.length === 0) {
    if (state.lastError) {
      return {
        text: "!",
        color: COLOR_GREY,
        title: `Cursor Usage Badge — ${state.lastError}`,
      };
    }
    return { text: "", color: COLOR_GREY, title: "Cursor Usage Badge — no data yet" };
  }

  const worst = Math.max(...candidates);
  const pct = Math.min(999, Math.round(worst));
  const text = `${pct}%`;

  let color;
  if (onDemand.inUse || onDemand.overLimit) color = COLOR_RED;
  else if (worst >= 90) color = COLOR_RED;
  else if (worst >= 70) color = COLOR_AMBER;
  else color = COLOR_GREEN;

  const parts = [];
  if (cursorPct != null) parts.push(`Cursor Models: ${Math.round(cursorPct)}%`);
  if (otherPct != null) parts.push(`Other Models: ${Math.round(otherPct)}%`);
  if (onDemand.status === "on") {
    const label = onDemand.overLimit
      ? "On-demand: OVER LIMIT"
      : onDemand.inUse
        ? "On-demand: IN USE"
        : "On-demand: ON";
    parts.push(label);
    if (onDemand.usedUsd != null && onDemand.limitUsd != null) {
      const upct =
        onDemand.utilization != null ? ` (${Math.round(onDemand.utilization)}%)` : "";
      parts.push(
        `$${onDemand.usedUsd.toFixed(2)} / $${onDemand.limitUsd.toFixed(2)}${upct}`
      );
    } else if (onDemand.usedUsd != null) {
      parts.push(`~$${onDemand.usedUsd.toFixed(2)} on-demand`);
    }
  } else if (onDemand.status === "off") {
    parts.push("On-demand: OFF");
  }
  if (state.billingCycleEnd) {
    const mins = Math.max(0, Math.round((state.billingCycleEnd - Date.now()) / 60000));
    if (mins > 0) {
      const hrs = Math.floor(mins / 60);
      if (hrs < 48) {
        const rm = mins % 60;
        parts.push(rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`);
      } else {
        const days = Math.floor(hrs / 24);
        const rh = hrs % 24;
        parts.push(rh > 0 ? `Resets in ${days}d ${rh}h` : `Resets in ${days}d`);
      }
    }
  }
  if (state.lastError) {
    parts.push(`Last refresh failed: ${state.lastError}`);
  }

  return { text, color, title: parts.join(" · ") };
}

async function refreshBadge() {
  const { usageState } = await chrome.storage.local.get("usageState");
  const state = usageState || DEFAULT_STATE;
  const { text, color, title } = computeBadge(state);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    // Older Chrome — auto text color is the graceful fallback.
  }
  await chrome.action.setTitle({ title });
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
    pools: {
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

  try {
    const signedIn = await hasSessionCookie();
    if (!signedIn) {
      await mergeState({
        lastError: "Not signed in to Cursor.",
        errorCode: "no_session",
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
