# Cursor Usage Tracker & Badge

A Chrome extension that tracks your Cursor usage in your browser toolbar. Works with The X Subscription (Cursor + Grok + X) and with legacy Cursor plans.

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anysphere / Cursor, Grok, X, or SpaceXSI. "Cursor" is a trademark of Anysphere, Inc., used here only to describe what the extension does.

On The X Subscription the badge shows your weekly included pool; on a legacy plan it shows the worst of your two monthly pools (Cursor Models vs Other Models). The plan type is detected automatically. Click the badge for the full breakdown.

## Features

**The X Subscription (weekly pool)**
- Weekly included pool percentage, shared across Cursor, Bugbot, Grok Bot and Grok
- Split by product, matching the grok.com usage page
- Weekly reset date with a live countdown
- Additional usage: spend this month vs monthly limit, prepaid credit balance, over-limit flag
- Plan pill: Free, Plus, Premium, Super, Ultra

The sections below apply to legacy Cursor plans.

**Monthly pools**
- Cursor Models pool percentage (Auto / first-party models)
- Other Models pool percentage (third-party API models)
- Shared billing-cycle reset date with a live countdown (`3d 4h left`)
- Badge color escalates on the worse of the two pools

**On-demand usage**
- ON / OFF status, with IN USE and over-limit indicators
- Monthly spend vs limit with progress bar — shows true % even when over 100
- Over-limit state is flagged loudly (red card)

**Subscription tier**
- Plan pill: Free, Pro, Pro+, Ultra, Team, Enterprise

**Error handling**
- If your session has expired or you aren't signed in, the popup guides you to grok.com/dashboard/usage (The X Subscription) or cursor.com/dashboard/usage (legacy) and back with a one-click Refresh

## Install

### From source (developer mode)

1. Clone this repo
2. Visit `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select this folder
5. Sign in at [grok.com/dashboard/usage](https://grok.com/dashboard/usage) (The X Subscription) or [cursor.com/dashboard/usage](https://cursor.com/dashboard/usage) (legacy plans). The badge populates within a few seconds.

## How it works

The extension reads the same unofficial dashboard APIs the web dashboards use, so the numbers match what you see there.

- `background.js` — service worker, single source of truth. Every 3 minutes it first asks grok.com (`GET /dashboard/api/dashboard/v2/usage-status?scope=user`, plus `POST …/get-sand-usage-status` for plan name and credit). If the account is unified, that is the answer. Otherwise it polls cursor.com `GET /api/usage-summary`, falling back to `POST /api/dashboard/get-current-period-usage` if the summary is thin.
- `popup.html` / `popup.js` — the UI. Renders pool bars, on-demand card, plan pill, and reset countdown.

Auth uses your existing browser sessions on `grok.com` and `cursor.com`. No token pasting required — just stay signed in to the dashboard in Chrome.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — detects whether a Cursor session cookie is present
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://cursor.com/*", "https://grok.com/*"]` — required to call the two usage dashboards on your behalf

**No data leaves your browser.** No third-party servers. No analytics. No tracking.

## Design

Popup UI follows [xAI](https://x.ai) / SpaceX brand standards from the All Brand Standards DB:

| Token | Hex | Use |
|---|---|---|
| Background | `#0A0A0A` / `#0C0C0B` | Page / cards |
| Hex fill | `#F0F0FA` | Toolbar icon hexagon (SpaceX starlight) |
| Accent | `#FF6308` | Icon ring, titles, CTAs (xAI orange) |
| Cobalt | `#01579B` | Store graphics structural accent (SpaceX) |
| Severity | `#15803D` / `#B45309` / `#B91C1C` | Live `%` badge overlay (Claude Usage Badge scheme) |

Typography: Inter + JetBrains Mono. Store listing assets live in `../store-assets/`.

## Development

There's no build step. Edit the files in place and reload the extension at `chrome://extensions` (↻ icon on the extension card).

To package for the Chrome Web Store:

```bash
zip -r ../cursor-usage-badge-v0.2.0.zip . -x "*.DS_Store" -x "__MACOSX/*" -x ".git/*"
```

## Smoke test

1. Load unpacked as above
2. Open [grok.com/dashboard/usage](https://grok.com/dashboard/usage) (or cursor.com/dashboard/usage on a legacy plan) and confirm you're signed in
3. Click the extension icon → **Refresh**
4. Confirm the badge shows a percentage and the popup shows:
   - Plan pill
   - Reset date + countdown
   - Weekly pool % with product split (unified), or Cursor Models % and Other Models % (legacy)
   - Additional usage / on-demand status (and spend bar if a limit is set)

## License

MIT — see [LICENSE](LICENSE).

Framework adapted from [claude-usage-badge](https://github.com/zealot-network/claude-usage-badge).
