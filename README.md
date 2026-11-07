# Budget Tracker

A household budget app that you install on your phone (a PWA). Every entry from every phone goes into one Google Sheet.

- **The app** (this repository) is only code. It holds no money data. GitHub Pages serves it at `https://arhaanbeta.github.io/budget-tracker/`.
- **The data** lives in your Google Sheet, *Budget Tracker data*, with four tabs: `Entries`, `Balances`, `CardFix` and `Config`.
- **The bridge** is a small Google Apps Script (`apps-script/Code.gs`) inside that sheet. The app sends changes to it, and it sends back the full data.

## How sync works

1. When you save an entry, the app shows it at once and keeps it in an *outbox* on the phone.
2. The app sends the outbox to the sheet. The sheet writes the rows and replies with all the data.
3. Every 30 seconds, and whenever you open the app, it fetches the latest data, so entries from other phones appear.
4. With no internet, entries wait in the outbox ("1 change waiting to sync") and go out when the connection returns.

You can also type a row straight into the `Entries` tab: fill **Date**, **Category** (its exact name) and **Amount**. The script gives the row an ID the next time any phone syncs.

## Signing in

Type your Gmail address and tap **Email me a sign-in link**. Open the email on the same phone and tap **Sign in to Budget Tracker**. The phone then stays signed in for good.

- Only emails listed on the sheet's **Users** tab get a link. The owner adds or removes people in the app under **Setup → Family access** (or straight in the tab).
- Each link works once and expires after 30 minutes. At most 5 links per hour per person.
- Removing someone locks them out on their next sync, and their phone stops showing the data.
- Optional: **Continue with Google** appears too once a Google OAuth Client ID is set (see below). The script checks every Google sign-in with `oauth2.googleapis.com/tokeninfo`.

## Vault (owners only)

Card, bank and personal details live in three tables in the app's **Vault** tab: credit cards (10 columns), bank accounts (10 columns) and personal information (3 columns). Column names can be renamed.

- **Zero-knowledge:** each row is encrypted on the phone with **AES-256-GCM**. The key comes from your master passphrase through **PBKDF2-SHA256, 600,000 rounds**. The sheet's `Vault` tab and the Apps Script only ever see scrambled text, and the script rejects anything that isn't encrypted.
- The key is non-extractable and kept only in memory. Nothing readable is saved on the phone.
- Values stay masked until you tap **Show**. **Copy** clears the clipboard after 30 seconds.
- The vault locks after 5 minutes without a tap, when the page closes, and on sign-out.
- Only Owners can read or write the Vault, and the script enforces this too.
- Master passphrase: at least 6 characters.
- **There is no passphrase recovery.** Keep the passphrase on paper somewhere safe.

## One-time setup

1. *Optional* **Google sign-in client** (Google Cloud Console → Google Auth Platform): create a *Web application* OAuth client with the authorised JavaScript origin `https://arhaanbeta.github.io`. Put its Client ID in `GOOGLE_CLIENT_ID` in `index.html` and in the sheet's **Config** tab (`google client id`).
2. **Apps Script**: in the sheet, **Extensions → Apps Script**, paste [`apps-script/Code.gs`](apps-script/Code.gs), then **Deploy → Manage deployments → Edit → Version: New version → Deploy**, and allow the new permissions (send sign-in emails from your Gmail, and ask Google to check Google sign-ins).
3. Optional, after Google sign-in works: delete the `APP_KEY` script property to switch off the old set-up links.

**Updating the script later:** paste the new code, then **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.

## Install on a phone

Open `https://arhaanbeta.github.io/budget-tracker/` in Chrome → **⋮ → Install app** (or **Add to Home screen**). On iPhone, use Safari → **Share → Add to Home Screen**.
