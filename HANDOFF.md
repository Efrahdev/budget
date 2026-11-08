# Budget Tracker: handoff for a new session

Read this first. It describes how the app is built, where everything lives, the owner's preferences, and how to work safely.

## What it is
A household budget PWA for **Arhaanbeta** (aarhaan22@gmail.com). One file app: `index.html` (+ `sw.js`, `manifest.webmanifest`, `icons/`), hosted on **GitHub Pages**: https://arhaanbeta.github.io/budget-tracker/. Data lives in a private Google Sheet, **"Budget Tracker data"** (owner aarhaan22@gmail.com), reached through a **Google Apps Script web app** (`apps-script/Code.gs`).

## Live pieces
- **Apps Script deployment the app uses** (`API_URL` in `index.html`): `https://script.google.com/macros/s/AKfycbzMb_87-nOMCRF10ieNSvUPlBLcIbu6PhpqQHw8riETufRlKF2ZEdBFttyMZc8Rwngg/exec`
  - The owner must update the script by **pasting Code.gs → Deploy → Manage deployments → pencil → New version**. Never "New deployment" (that changes the URL; it has happened three times).
  - The live script already has everything in `apps-script/Code.gs` (vault, email links, sessions). No script change is pending.
- **Sheet tabs:** Entries, Balances, CardFix, Config (JSON in "config part N" rows), Users (family allow-list; aarhaan22 is Owner), Vault (encrypted rows).
- **Sign-in:** emailed one-time link (MailApp) → permanent session in Script Properties. A legacy `APP_KEY` set-up key also works (Owner role). The owner can share it with a new session; it is not stored in this repo.
- **Cloud environment:** the session environment **"budget-tracker"** allows `script.google.com`, `script.googleusercontent.com`, `arhaanbeta.github.io`. Use it to test against the real script.
- **Pushing:** commit to `main` and push; Pages goes live in ~30–60 s. Bump `CACHE` in `sw.js` (`budget-tracker-vNN`, currently v33) on every release.

## App structure (index.html)
- **Sync:** optimistic outbox (`queue` → `flush`), full data returned by the script each time; 30 s polling; offline-safe. Ops: config, txn, deltxn, bal, delbal, fix, replace, adduser, deluser, vput, vdel, signout.
- **Overview:** KPI strip (Income, Spent, Saved, Savings rate), then one tile per category in Setup order (Cash in hand tile first if set). No group labels or commentary (owner's explicit wish).
- **Categories:** owner's canonical names; `misc` = "Miscellaneous", `disc` = "Discretionary" (`unplanned: true` → its budget equals what was spent), `schtr` = "School transport". Quick-pick buttons: `config.chips` = [groc, misc, schtr, car] pinned first; short labels `short` (groc → "Household", misc → "Misc"). Do NOT reintroduce Fixed/Variable/Sinking/Discretionary group labels anywhere visible.
- **Entry form:** Amount (calculator: + − × ÷, brackets, dictation words; `parseAmount` is a safe parser, never eval) with + − × ÷ = buttons → Category buttons (+ dictation box) → **Paid with: Cash (default) / Bank / Card** → Date: Today / Yesterday / 📅 → Note → collapsed "More" (for whom, tag, refund). The five text boxes are `contenteditable` divs (`makeTextBox`) so Chrome/SwiftKey autofill bars don't appear; they expose `.value`.
- **Payment data:** cash → `acct='cash'`; bank → `acct=<account id>`; card → `card=<card id>`; card bill payment → both (card being paid + bank). Old entries without payment stay unset unless edited.
- **Vault (Owner only, open mode):** no passphrase; rows AES-GCM with a built-in key (`vOpenKey`, SHA-256 of `budget-tracker/open-vault/v1`), meta `{v:2, mode:'open'}`. Local copy in localStorage for instant open; changes queue and sync in the background. Tables: Credit cards (CC, Name, CC number, Exp, CVV, Stmt, PW, Cust ID, Note), Savings accounts (Account, Name, Acc, Cust ID, PW, IFSC, Card no, Exp, CVV, Notes), Personal (Portal/item, ID/number, Password/note). Filters: All, Credit cards, Savings accounts, Personal, Aadhaar, Voter. Paste many rows (heading-matched), Delete all (type DELETE), per-cell copy.
- **Vault → payment lists:** `syncPayMethods()` copies **names only** (+ last 4 digits when names clash) and statement days into Setup data: `config.cards` (vault card ids, `src:'vault'`, `dueDay` kept by id, else due ≈ statement + 20 days) and `config.payBanks` (account ids in order: HDFC ARHAAN, AMMI HDFC, HDFC EFRAH, then the rest). Vault-only banks become `config.accounts` entries with `pay:true` (hidden from Wealth/Setup editor). Family phones get the buttons without vault access.
- **Wealth:** net worth = assets − debts − card bills − **this month's budget still to spend** (`budgetLeft`). Order: tiles, Assets, Debts, Still to spend, Not counted, then chart, Record today's balances, snapshots. **FD growth** view: FD accounts at latest balance, monthly compounding at 7% (editable, stored in prefs).
- **Setup:** cycle day (25), Cash in hand (`config.cashStart`), categories/budgets, accounts (net worth), account & sync, family access, backup. No card section (cards come from the vault).
- **Breakdowns ("how it is worked out"):** every figure on Overview (KPIs, category tiles, Cash in hand, card-bill rows), Wealth (KPIs, section headings, each account, Credit cards, Still to spend, snapshots, FD cards) and Card bills (KPIs, each card header) has `data-act="why" data-k="…"` (via `whyAttr`). Tapping opens `#whyScrim`; `whyBuild(k)` builds sections of signed lines that add up to each total, from the same functions the screens use (`wealthCalc`, `cardLedger`, `cashInHand`, `budgetLeft`). Lines can drill down (`why-go`, with Back) or open an entry for editing. The sheet refreshes after each sync.
- **Plain keyboard:** `plainKeyboard()` gives every other input an unrecognised autocomplete value.
- **Fixed bugs worth remembering:** never redraw screens with text boxes on `resize` (Android keyboard flapping); auto-focus only if focus isn't already in the form; vault screen redraws only when its state changes.

## Owner's preferences
- Simple UK English; crisp answers; no needless permission requests (full approval given, except bulk deletes).
- Very visual, low-touch UX; no commentary text on dashboards; keep their canonical names; don't invent categories or structure.
- Test thoroughly before pushing; never push half-done work.

## Testing approach (rebuild in the new session)
Previous tests lived in the session scratchpad and are gone. Method that worked: a Node mock server that loads `apps-script/Code.gs` in a `vm` context with fake `SpreadsheetApp`, `PropertiesService`, `LockService`, `ContentService`, `Utilities`, `MailApp`, `UrlFetchApp`, `HtmlService`, serving the app and routing `https://script.google.com/**` to it from Playwright (Pixel 7 profile). Chromium + Playwright are preinstalled. Read live data with the set-up key via `curl -sSL -H 'Content-Type: text/plain' --data '{"key":"…","vault":true,"ops":[]}' <API_URL>` (follow the redirect as GET; plain POST body).

## Open items / ideas
- Owner may later decide where to add protection back to the vault.
- Two ICICI EFRAH cards have no pay-by day (default ~20 days after the bill).
- Older entries have no payment method recorded.
