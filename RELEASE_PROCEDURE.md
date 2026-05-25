# POS UPI Terminal — Release Checklist Procedure

To prevent version desynchronization and ensure service worker cache-busting operates correctly across client devices, **every code release iteration must follow this procedure**:

---

## 1. Version Locations Checklist

Verify and bump the version string in the following **four** locations:

1. 📂 **index.html** (About the Creator version block):
   * *Location*: Around line 420-430, inside the `ℹ️ About the Creator` settings card.
   * *Format*: `<div style="color: var(--color-emerald); font-weight: 600; font-size: 11px; margin-bottom: 12px; letter-spacing: 0.5px;">Version X.Y.Z</div>`

2. 📂 **sw.js** (Service Worker Cache name):
   * *Location*: First line of the file.
   * *Format*: `const CACHE_NAME = 'upi-pos-v<NUMBER>';` (Increment the cache number sequentially, e.g. `v21` to `v22`).

3. 📂 **js/app.js** (Service Worker Registration registration query):
   * *Location*: Near the top, around line 9.
   * *Format*: `navigator.serviceWorker.register('./sw.js?v=<NUMBER>')` (Ensure this query version matches the number in `sw.js` exactly).

4. 📂 **task.md** & **walkthrough.md** (Checklists & Logs):
   * Update task headings and walkthrough files to match the new version number.

---

## 2. Release Execution Step

Once the files are modified:
1. Run `git status` to verify modified states.
2. Stage all changes: `git add .`.
3. Commit with a message mentioning the new version: `git commit -m "Release version X.Y.Z - <Details>"`.
4. Push to origin: `git push origin main`.
