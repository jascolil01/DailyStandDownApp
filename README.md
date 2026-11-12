# Daily Stand-Down

A small web app for handing your day over to tomorrow-you.

- **Morning check-in** — a recap of your last entry (notes to yourself, what got done, blockers, mood), the tasks you set for today, and a choice of which unfinished tasks to carry over.
- **During the day** — tick tasks off, add new ones.
- **Evening stand-down** — what you got done, blockers, notes to tomorrow-you, a mood/energy rating, and tomorrow's tasks.
- **History** — every day you filled in, searchable, with older/newer navigation.
- **Read-only link** — other devices and people can read your entries but cannot change them.

The day rolls over at 4am, so a stand-down written after midnight still belongs to the day you just had. If you skip days (a weekend, say), the morning recap shows your most recent entry.

## Try it

It is plain HTML, CSS and JavaScript with no build step. Serve the folder with any static server:

```bash
npx serve .
```

Without any setup, entries are saved in the browser you use. Settings → Backup downloads or restores everything as a file.

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
5. In the app, choose **Create account**, confirm the email Supabase sends, then **Sign in**. Entries already on the device are uploaded.
6. Choose **Create read-only link** and send the link to your other devices or to other people.

Recommended afterwards: in Supabase, **Authentication → Sign In / Providers**, turn off "Allow new users to sign up" so nobody else can create an account in your project. (Other accounts could never see your entries anyway.)

### How read-only works

- Only the signed-in owner can write; the database refuses every other write.
- The link carries a long random code. The database hands entries only to someone presenting that code, through a function that can read and nothing else.
- **Replace with a new link** or **Turn off sharing** in Settings makes the old link stop working immediately.
- Anyone who has the link can read all your entries, so share it like you would a password.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Optional Supabase project details |
| `supabase/schema.sql` | Database tables and access rules |
| `vendor/supabase.js` | Supabase client library (MIT), bundled so the app needs no CDN |
