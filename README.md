# Hymn Sheet

One live page per job that the whole crew works from: kit (who asked, who supplies it, confirmed, packed at prep), everyone's tasks, crew, shot list, flags and a log of every change. So nothing gets lost in WhatsApp.

- **Page:** this repo on GitHub Pages (`index.html`, `app.js`, `app.css`, `config.js`). No build step.
- **Data:** a private Google Sheet in Elliot's Drive ("Hymn Sheet data (private)"), tabs `jobs`, `crew`, `items`, `tasks`, `shots`, `flags`, `log`, `seen`. Nothing about a job lives in this repo.
- **Backend:** `backend/Code.gs`, an Apps Script web app bound to that Sheet. Every call needs a personal link key.

## Links

Each person gets their own link: `https://elh0.github.io/hymn-sheet/?k=<key>`. Keys live in the `crew` tab; Elliot's link uses the job's `admin_key`. Elliot can copy anyone's link (or a ready WhatsApp/email invite) from the Crew tab. To cut someone off, change their key in the Sheet.

Crew can: add kit, tick packed, change supplier/qty/notes (that un-confirms the item), tick their own tasks, say "I've added all my kit", flag a problem, email the crew.
Only Elliot can: confirm kit, rename/remove confirmed kit, give tasks, add crew, clear flags, edit the job.

## Setup (once)

1. Open the Sheet > Extensions > Apps Script. Replace everything with `backend/Code.gs`. Save.
2. Deploy > New deployment > Web app. Execute as **Me**, who has access **Anyone**. Deploy, allow access.
3. Put the Web app URL (ends `/exec`) in `config.js`.

After changing `Code.gs`: Deploy > Manage deployments > edit > Version: New version (keeps the same URL).

## Tests

`node tests/suite.js` runs the real `Code.gs` against an in-memory Sheet and drives the page in Chromium (iPhone + desktop): permissions, presence, offline ticks, no sideways scroll.
