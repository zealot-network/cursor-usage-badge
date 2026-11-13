# Privacy Policy — Cursor Usage Tracker & Badge

**Last updated:** November 13, 2026

Cursor Usage Tracker & Badge (“the extension”, formerly Cursor Usage Badge) is an unofficial, open-source Chrome extension. It is not affiliated with, endorsed by, or sponsored by Anysphere / Cursor, Grok, X, or SpaceXSI.

## What the extension does

The extension shows your Cursor usage in the Chrome toolbar and popup. On The X Subscription: the weekly included pool (shared across Cursor, Bugbot, Grok Bot and Grok), its split by product, additional-usage spend against your monthly limit, and reset timing. On legacy Cursor plans: monthly Cursor Models and Other Models pools, on-demand spend vs. limit, plan tier, and billing-cycle reset timing.

## Data the extension accesses

To fulfill that single purpose, the extension:

1. **Reads your Cursor session cookie** (`WorkosCursorSessionToken` on `cursor.com`) so it can call Cursor’s dashboard usage APIs while you are signed in. The extension does not ask you to paste a token and does not modify or store the cookie value separately.
2. **Requests usage summary data from `cursor.com`** (the same unofficial dashboard APIs used by Cursor’s spending/usage pages).
3. **Requests usage data from `grok.com`** with one read-only request (`GET /dashboard/api/dashboard/v2/usage-status`, the unofficial dashboard endpoint behind grok.com/dashboard/usage, where The X Subscription reports Cursor usage) using your existing signed-in grok.com session. The extension does not read, copy, or store grok.com cookies.
4. **Stores a local cache** of usage state in Chrome’s `chrome.storage` on your device so the badge and popup can update without re-fetching every click. The cache holds: usage percentages (including the split by product), plan tier, reset times, last error, last refresh time, and money amounts shown on your usage dashboard — additional-usage or on-demand spend, your spending limit, and the amount remaining. The extension does not read or store your prepaid credit balance, name, email address, username, account ID, payment card, or billing details.

## What we do not do

- We do not operate a backend server for this extension.
- We do not send your usage data, cookies, or browsing activity to the extension author or any third party.
- We do not include analytics, advertising, or tracking SDKs.
- We do not sell or transfer user data.
- We do not use remote code; all JavaScript ships inside the extension package.

Network requests go only to `https://cursor.com/*` and `https://grok.com/*` so the extension can read your usage while you are logged in. The privacy practices of Cursor and SpaceXSI apply to data they process on their servers.

## Limited Use

The extension’s use of information received from the `cursor.com` and `grok.com` dashboards complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements:

- **Allowed use.** The data is used only to provide the extension’s single purpose: showing your Cursor usage in the Chrome toolbar and popup.
- **Allowed transfer.** The data is not transferred to anyone. It stays in Chrome’s local storage on your device.
- **No advertising.** The data is never used or transferred for personalized advertising, retargeting, or any other advertising purpose.
- **No human reading.** No person, including the extension’s author, can read your data. It never leaves your device.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Cache usage state locally for the badge and popup |
| `cookies` | Detect a signed-in Cursor session (`WorkosCursorSessionToken`) |
| `alarms` | Refresh usage on a timer (~every 3 minutes) |
| Host: `https://cursor.com/*` | Call Cursor dashboard usage APIs (legacy plans) |
| Host: `https://grok.com/*` | Call the Grok dashboard usage APIs (The X Subscription) |

## Contact

Questions or privacy requests: open an issue at  
https://github.com/zealot-network/cursor-usage-badge/issues

Source code:  
https://github.com/zealot-network/cursor-usage-badge
