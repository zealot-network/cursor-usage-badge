// popup.js — Reads UsageState from storage and renders the popup UI.

const DEFAULT_STATE = {
  pools: {
    cursorModels: null,
    otherModels: null,
  },
  planDetail: {
    used: null,
    limit: null,
    remaining: null,
    included: null,
    bonus: null,
  },
  onDemand: {
    enabled: null,
    status: null,
    usedUsd: null,
    limitUsd: null,
    remainingUsd: null,
    utilization: null,
    overLimit: null,
    inUse: null,
  },
  subscriptionTier: null,
  billingCycleStart: null,
  billingCycleEnd: null,
  lastUpdated: null,
  lastErrorAt: null,
  lastError: null,
  errorCode: null,
};

const USAGE_URL = "https://cursor.com/dashboard/usage";

const ERROR_COPY = {
  no_session: {
    title: "Sign in to Cursor",
    body:
      "We couldn't find a Cursor session. To load your usage data:<ol>" +
      "<li>Open <strong>cursor.com/dashboard/usage</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  auth: {
    title: "Cursor session expired",
    body:
      "Your Cursor session has expired or isn't authorized. To reconnect:<ol>" +
      "<li>Open <strong>cursor.com/dashboard/usage</strong> and sign in if prompted</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  network: {
    title: "Can't reach cursor.com",
    body:
      "We hit a network error fetching your usage. To retry:<ol>" +
      "<li>Open <strong>cursor.com/dashboard/usage</strong> to confirm you're online</li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
  unknown: {
    title: "Couldn't load usage",
    body:
      "Something went wrong reading your usage. To retry:<ol>" +
      "<li>Open <strong>cursor.com/dashboard/usage</strong></li>" +
      "<li>Come back and click <strong>Refresh</strong></li></ol>",
  },
};

function barColor(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--amber)";
  return "var(--green)";
}

function formatPct(pct) {
  if (pct == null) return "—";
  return `${Math.round(pct)}%`;
}

function formatResetTime(ts) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "Resets soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `Resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) {
    const rm = mins % 60;
    return rm > 0 ? `Resets in ${hrs}h ${rm}m` : `Resets in ${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `Resets in ${days}d ${rh}h` : `Resets in ${days}d`;
}

function formatCycleDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function formatLastUpdated(ts) {
  if (!ts) return "No data yet";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins <= 0) return "Updated just now";
  if (mins === 1) return "Updated 1m ago";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `Updated ${hrs}h ago`;
}

function formatTier(tier) {
  if (!tier) return "—";
  const map = {
    free: "Free",
    pro: "Pro",
    pro_plus: "Pro+",
    ultra: "Ultra",
    team: "Team",
    enterprise: "Enterprise",
  };
  return map[tier] || tier;
}

function buildBarSection({ label, valueText, pct, resetsAt, overLimit }) {
  const fillPct = pct != null ? Math.min(100, pct) : 0;

  const section = document.createElement("div");
  section.className = "section";
  section.innerHTML = `
    <div class="label-row">
      <span class="label"></span>
      <span class="value"></span>
    </div>
    <div class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
      <div class="bar-fill"></div>
    </div>
    <div class="reset-time"></div>
  `;
  section.querySelector(".label").textContent = label;
  const valueEl = section.querySelector(".value");
  valueEl.textContent = valueText;
  if (overLimit) valueEl.style.color = "var(--red)";

  const track = section.querySelector(".bar-track");
  track.setAttribute("aria-label", label);
  if (pct != null) {
    track.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
    if (overLimit) track.setAttribute("aria-valuetext", valueText + " — over limit");
  } else {
    track.setAttribute("aria-valuetext", "No data");
  }

  const fill = section.querySelector(".bar-fill");
  fill.style.width = `${fillPct}%`;
  fill.style.backgroundColor = pct != null ? barColor(pct) : "var(--surface)";
  section.querySelector(".reset-time").textContent = formatResetTime(resetsAt);

  return section;
}

function hasPoolData(state) {
  return !!(
    state.pools?.cursorModels?.utilization != null ||
    state.pools?.otherModels?.utilization != null
  );
}

function render(state) {
  const $ = (id) => document.getElementById(id);

  const hasErrorCode = !!state.errorCode;
  const showPrompt = hasErrorCode && !hasPoolData(state);

  const promptEl = $("error-prompt");
  if (showPrompt) {
    const copy = ERROR_COPY[state.errorCode] || ERROR_COPY.unknown;
    $("error-prompt-title").textContent = copy.title;
    $("error-prompt-body").innerHTML = copy.body;
    promptEl.style.display = "";
  } else {
    promptEl.style.display = "none";
  }

  const errorEl = $("error-label");
  if (state.lastError && !showPrompt) {
    errorEl.textContent = `Last refresh failed: ${state.lastError}`;
    errorEl.style.display = "block";
  } else {
    errorEl.style.display = "none";
  }

  const tierEl = $("tier-pill");
  tierEl.textContent = formatTier(state.subscriptionTier);
  tierEl.title = state.subscriptionTier
    ? "Detected Cursor plan"
    : "Plan not detected yet — open cursor.com/dashboard/usage and refresh";

  // Billing cycle countdown banner
  const cycleEl = $("cycle-banner");
  if (state.billingCycleEnd && !showPrompt) {
    const dateStr = formatCycleDate(state.billingCycleEnd);
    const countdown = formatResetTime(state.billingCycleEnd);
    cycleEl.innerHTML = dateStr
      ? `Limits reset <strong>${dateStr}</strong> · ${countdown}`
      : countdown;
    cycleEl.style.display = "";
  } else {
    cycleEl.style.display = "none";
  }

  // Monthly pools
  const poolsHeading = $("pools-heading");
  const poolsSlot = $("pools-slot");
  poolsSlot.innerHTML = "";

  const resetsAt = state.billingCycleEnd;
  const pools = [];
  if (state.pools?.cursorModels) {
    pools.push({
      label: state.pools.cursorModels.label || "Cursor Models",
      utilization: state.pools.cursorModels.utilization,
    });
  }
  if (state.pools?.otherModels) {
    pools.push({
      label: state.pools.otherModels.label || "Other Models",
      utilization: state.pools.otherModels.utilization,
    });
  }

  if (pools.length > 0) {
    poolsHeading.style.display = "";
    for (const p of pools) {
      const pct = p.utilization;
      poolsSlot.appendChild(
        buildBarSection({
          label: p.label,
          valueText: formatPct(pct),
          pct,
          resetsAt,
          overLimit: pct != null && pct > 100,
        })
      );
    }
  } else if (!showPrompt) {
    poolsHeading.style.display = "none";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No pool data yet";
    poolsSlot.appendChild(empty);
  } else {
    poolsHeading.style.display = "none";
  }

  // On-demand card
  const od = state.onDemand || {};
  let status = od.status;
  if (status == null) {
    if (od.enabled === true) status = "on";
    else if (od.enabled === false) status = "off";
  }
  const known = status != null;
  const active = status === "on";
  const inUse = !!od.inUse;
  const overLimit = od.overLimit === true;

  const section = $("ondemand-section");
  section.classList.toggle("over-limit", overLimit);

  const enabledPill = $("ondemand-enabled-pill");
  enabledPill.classList.remove("pill-on", "pill-off", "pill-neutral", "pill-paused");
  if (!known) {
    enabledPill.textContent = "—";
    enabledPill.classList.add("pill-neutral");
  } else if (status === "on") {
    if (overLimit) {
      enabledPill.textContent = "OVER LIMIT";
      enabledPill.classList.add("pill-paused");
    } else {
      enabledPill.textContent = "ON";
      enabledPill.classList.add("pill-on");
    }
  } else {
    enabledPill.textContent = "OFF";
    enabledPill.classList.add("pill-off");
  }

  $("ondemand-active-pill").style.display = active && inUse && !overLimit ? "inline" : "none";

  const detailEl = $("ondemand-detail");
  const barWrap = $("ondemand-bar-wrap");
  const odBar = $("ondemand-bar");
  const odBarTrack = $("ondemand-bar-track");
  const odResetEl = $("ondemand-reset");

  if (!known) {
    detailEl.textContent = "Waiting for data…";
    barWrap.style.display = "none";
  } else if (!active) {
    detailEl.textContent = "Off — enable on-demand to continue past included usage";
    barWrap.style.display = "none";
  } else {
    const uPct = typeof od.utilization === "number" ? Math.round(od.utilization) : null;
    const parts = [];
    if (od.usedUsd != null && od.limitUsd != null && od.limitUsd > 0) {
      const pctTag =
        uPct != null
          ? ` · <span class="${overLimit ? "over" : ""}">${uPct}%</span>`
          : "";
      parts.push(
        `<strong>$${od.usedUsd.toFixed(2)}</strong> of $${od.limitUsd.toFixed(2)}${pctTag}`
      );
    } else if (od.usedUsd != null) {
      parts.push(`<strong>$${od.usedUsd.toFixed(2)}</strong> spent (no monthly cap)`);
    }

    let html = parts.join(" · ") || "Enabled — no spend data yet";
    if (od.remainingUsd != null && od.limitUsd != null) {
      html += `<div class="extra-sub">$${od.remainingUsd.toFixed(2)} remaining</div>`;
    }
    if (overLimit) {
      html += `<div class="extra-note">Over your on-demand monthly limit</div>`;
    }
    detailEl.innerHTML = html;

    let pct = null;
    if (typeof od.utilization === "number") pct = od.utilization;
    else if (od.limitUsd != null && od.limitUsd > 0 && od.usedUsd != null) {
      pct = (od.usedUsd / od.limitUsd) * 100;
    }
    if (pct != null) {
      odBar.style.width = `${Math.min(100, pct)}%`;
      odBar.style.backgroundColor = barColor(pct);
      if (odBarTrack) {
        odBarTrack.setAttribute("aria-valuenow", String(Math.round(Math.min(100, pct))));
        if (overLimit) {
          odBarTrack.setAttribute("aria-valuetext", `${Math.round(pct)}% — over limit`);
        }
      }
      odResetEl.textContent = formatResetTime(state.billingCycleEnd);
      barWrap.style.display = "";
    } else {
      barWrap.style.display = "none";
    }
  }

  $("meta-label").textContent = formatLastUpdated(state.lastUpdated);
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...(state || {}),
    pools: { ...DEFAULT_STATE.pools, ...((state && state.pools) || {}) },
    planDetail: { ...DEFAULT_STATE.planDetail, ...((state && state.planDetail) || {}) },
    onDemand: { ...DEFAULT_STATE.onDemand, ...((state && state.onDemand) || {}) },
  };
}

async function loadAndRender() {
  try {
    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_USAGE_STATE" }, (resp) => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.get("usageState", ({ usageState }) => {
            resolve(usageState || DEFAULT_STATE);
          });
        } else {
          resolve(resp || DEFAULT_STATE);
        }
      });
    });
    render(normalizeState(state));
  } catch {
    document.getElementById("error-label").textContent = "Failed to load state.";
    document.getElementById("error-label").style.display = "block";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.usageState) {
      render(normalizeState(changes.usageState.newValue));
    }
  });
  setInterval(loadAndRender, 30_000);

  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", () => {
    btn.textContent = "…";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      loadAndRender();
      btn.textContent = "Refresh";
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    };
    const safety = setTimeout(done, 10_000);
    chrome.runtime.sendMessage({ type: "FORCE_REFRESH" }, () => {
      void chrome.runtime.lastError;
      clearTimeout(safety);
      done();
    });
  });

  document.getElementById("open-usage-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: USAGE_URL });
  });
});
