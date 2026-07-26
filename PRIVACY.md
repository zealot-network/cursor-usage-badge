# Privacy Policy — Cursor Usage Badge

**Last updated:** July 26, 2026

Cursor Usage Badge (“the extension”) is an unofficial, open-source Chrome extension. It is not affiliated with, endorsed by, or sponsored by Anysphere / Cursor.

## What the extension does

The extension shows your Cursor usage in the Chrome toolbar and popup: monthly Cursor Models and Other Models pools, on-demand spend vs. limit, plan tier, and billing-cycle reset timing.

## Data the extension accesses

To fulfill that single purpose, the extension:

1. **Reads your Cursor session cookie** (`WorkosCursorSessionToken` on `cursor.com`) so it can call Cursor’s dashboard usage APIs while you are signed in. The extension does not ask you to paste a token and does not modify or store the cookie value separately.
2. **Requests usage summary data from `cursor.com`** (the same unofficial dashboard APIs used by Cursor’s spending/usage pages).
3. **Stores a local cache** of usage state (percentages, plan tier, reset times, last error, last refresh time) in Chrome’s `chrome.storage` on your device so the badge and popup can update without re-fetching every click.

## What we do not do

- We do not operate a backend server for this extension.
- We do not send your usage data, cookies, or browsing activity to the extension author or any third party.
- We do not include analytics, advertising, or tracking SDKs.
- We do not sell or transfer user data.
- We do not use remote code; all JavaScript ships inside the extension package.

Network requests go only to `https://cursor.com/*` so the extension can read your usage from Cursor while you are logged in. Cursor’s own privacy practices apply to data Cursor processes on their servers.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Cache usage state locally for the badge and popup |
| `cookies` | Detect a signed-in Cursor session (`WorkosCursorSessionToken`) |
| `alarms` | Refresh usage on a timer (~every 3 minutes) |
| Host: `https://cursor.com/*` | Call Cursor dashboard usage APIs |

## Contact

Questions or privacy requests: open an issue at  
https://github.com/zealot-network/cursor-usage-badge/issues

Source code:  
https://github.com/zealot-network/cursor-usage-badge
