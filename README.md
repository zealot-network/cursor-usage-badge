# Cursor Usage Badge

A Chrome extension that puts your Cursor usage in your browser toolbar.

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anysphere / Cursor. "Cursor" is a trademark of Anysphere, Inc., used here only to describe what the extension does.

The badge shows the worst of your two monthly pools (Cursor Models vs Other Models) at a glance. Click it for the full breakdown — plan tier, billing-cycle reset countdown, both pool percentages, and on-demand spend vs limit.

## Features

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
- If your Cursor session has expired or you aren't signed in, the popup guides you to cursor.com/dashboard/usage and back with a one-click Refresh

## Install

### From source (developer mode)

1. Clone this repo
2. Visit `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select this folder
5. Sign in at [cursor.com/dashboard/usage](https://cursor.com/dashboard/usage). The badge populates within a few seconds.

## How it works

The extension reads Cursor's own dashboard usage API — the same data the web dashboard uses — to show your real utilization numbers.

- `background.js` — service worker, single source of truth. Polls `GET /api/usage-summary` every 3 minutes plus on-demand. Falls back to `POST /api/dashboard/get-current-period-usage` if the summary is thin.
- `popup.html` / `popup.js` — the UI. Renders pool bars, on-demand card, plan pill, and reset countdown.

Auth uses your existing `WorkosCursorSessionToken` cookie on `cursor.com`. No token pasting required — just stay signed in to the dashboard in Chrome.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — detects whether a Cursor session cookie is present
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://cursor.com/*"]` — required to call Cursor's API on your behalf

**No data leaves your browser.** No third-party servers. No analytics. No tracking.

## Development

There's no build step. Edit the files in place and reload the extension at `chrome://extensions` (↻ icon on the extension card).

To package for the Chrome Web Store:

```bash
zip -r ../cursor-usage-badge.zip . -x "*.DS_Store" -x "__MACOSX/*" -x ".git/*"
```

## Smoke test

1. Load unpacked as above
2. Open [cursor.com/dashboard/usage](https://cursor.com/dashboard/usage) and confirm you're signed in
3. Click the extension icon → **Refresh**
4. Confirm the badge shows a percentage and the popup shows:
   - Plan pill
   - Reset date + countdown
   - Cursor Models % and Other Models %
   - On-demand status (and spend bar if enabled/capped)

## License

MIT — see [LICENSE](LICENSE).

Framework adapted from [claude-usage-badge](https://github.com/zealot-network/claude-usage-badge).
