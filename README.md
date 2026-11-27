# Daily Stand-Down

A small web app for handing your day over to tomorrow-you.

- **Morning check-in**: a recap of your last entry, the tasks you set for today (must-do tasks first), any tasks you'd set for this date, and a choice of which unfinished tasks to carry over. The first check-in of each week adds a look back at last week.
- **During the day**: tick tasks off; star must-do tasks; edit, reorder (drag the ⠿ handle or use the ⋯ menu), delete, or move a task to a later date. Tasks that keep getting carried over (3+ days) are flagged with "Do it today", "Move to later" or "Drop it".
- **Work hours**: log when you started and finished and how long your breaks were (Start my day fills in the start time and standing down fills in the finish time; both can be changed). Today shows hours worked so far; History, exports, Trends and the weekly summaries show hours per day and per week.
- **Coming up**: tasks set for a specific date, which appear in that day's check-in.
- **Evening stand-down**: what you got done (one tap copies in your ticked tasks), blockers, a mood/energy rating, and tomorrow's tasks (one tap brings today's unfinished ones along).
- **History**: every day as a searchable list or a month calendar coloured by mood or tasks done. Export any day or date range as a text file or a printable page (save as PDF from the print dialog).
- **Trends**: mood and tasks over 30 or 90 days, with this week and last week summarised.
- **Read-only link**: other devices and people can read your entries but cannot change them, and you can hide mood or blockers from it.
- **Works offline** after the first visit; changes sync when you're back online.
- **Desktop layout** on wide screens: a sidebar, side-by-side columns (tasks next to the stand-down), History as a list with the selected day alongside, and keyboard shortcuts: `1`–`4` switch sections, `N` adds a task, `/` searches History, `←`/`→` step between days. Phones and narrow windows get the single-column layout.

The day rolls over at 4am, so a stand-down written after midnight still belongs to the day you just had. If you skip days (a weekend, say), the morning recap shows your most recent entry.

## Try it

It is plain HTML, CSS and JavaScript with no build step. Serve the folder with any static server:

```bash
npx serve .
```

Without a Supabase project configured, entries are saved in the browser you use. Once `config.js` points at a project, the app asks you to sign in before anything can be read or written. Settings → Backup downloads or restores everything as a file.

## Put it online (GitHub Pages)

1. Merge this code into the repository's `main` branch.
2. In the repository on GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, then save.
3. After a minute the app is at `https://<your-username>.github.io/<repository-name>/`. On a phone, use the browser's "Add to Home Screen" to install it like an app.

GitHub Pages on a free account needs the repository to be public. That publishes only the app's code; your entries are never stored in the repository.

## Turn on sync and sharing (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. From the project's **Connect** / API settings, copy the **Project URL** and the **publishable (anon) key**.
4. Either paste them into the app under **Settings → Sync and sharing**, or put them in [`config.js`](config.js) and commit it so every device is connected automatically. Both values are designed to be public; the rules in `schema.sql` are what protect your data.
5. In Supabase, go to **Authentication → Users → Add user → Create new user**, enter your email and a password, and tick **Auto Confirm User**. The app has no sign-up button, so this is the only way to make an account.
6. In the app, **Sign in** with that email and password. Entries already on the device are uploaded.
7. Choose **Create read-only link** and send the link to your other devices or to other people.

### Updating the database

When a new version of the app changes `supabase/schema.sql`, open the Supabase **SQL Editor**, paste the whole file again and run it. It is safe to run more than once and keeps your entries.

### How read-only works

- Only the signed-in owner can write; the database refuses every other write.
- The link carries a long random code. The database hands entries only to someone presenting that code, through a function that can read and nothing else.
- In Settings you can hide mood or blockers from the link. The database removes hidden fields before sending anything, so people with the link can't see them at all.
- **Replace with a new link** or **Turn off sharing** in Settings makes the old link stop working immediately.
- Anyone who has the link can read all your entries, so share it like you would a password.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Optional Supabase project details |
| `supabase/schema.sql` | Database tables and access rules |
| `sw.js` | Saves the app's files so it opens offline |
| `vendor/supabase.js` | Supabase client library (MIT), bundled so the app needs no CDN |
