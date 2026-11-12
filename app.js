(() => {
  'use strict';

  // ---------- setup ----------

  const LS = { entries: 'dsd.entries', dirty: 'dsd.dirty', config: 'dsd.config' };
  const DAY_STARTS_AT_HOUR = 4; // before 4am still counts as the previous day
  const MOODS = ['', 'Rough', 'Low', 'Okay', 'Good', 'Great'];

  const $app = document.getElementById('app');
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const READONLY = hashParams.has('view');

  const state = {
    entries: {},
    dirty: new Set(),
    tab: READONLY ? 'latest' : 'today',
    historyDay: null,
    search: '',
    checkin: null,
    editingClose: false,
    focus: null,
    notice: '',
    renderedDay: null,
    cloud: { client: null, user: null, status: 'local', error: '', share: undefined, message: '' },
  };

  // ---------- small helpers ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const pad = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

  function todayKey() {
    return toKey(new Date(Date.now() - DAY_STARTS_AT_HOUR * 3600 * 1000));
  }

  function shiftKey(key, days) {
    const d = fromKey(key); d.setDate(d.getDate() + days); return toKey(d);
  }

  function fmtDate(key, opts) {
    return fromKey(key).toLocaleDateString(undefined,
      opts || { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function relDay(key) {
    const t = todayKey();
    if (key === t) return 'today';
    if (key === shiftKey(t, -1)) return 'yesterday';
    return fmtDate(key, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function blankEntry(date) {
    return {
      date, tasks: [], checkedInAt: null,
      done: '', blockers: '', notes: '', mood: null, nextTasks: [],
      closedAt: null, updatedAt: 0,
    };
  }

  const sortedKeys = () => Object.keys(state.entries).sort();

  function previousEntry(key) {
    const keys = sortedKeys().filter((k) => k < key);
    return keys.length ? state.entries[keys[keys.length - 1]] : null;
  }

  // ---------- local storage ----------

  function loadLocal() {
    try { state.entries = JSON.parse(localStorage.getItem(LS.entries)) || {}; } catch { state.entries = {}; }
    try { state.dirty = new Set(JSON.parse(localStorage.getItem(LS.dirty)) || []); } catch { state.dirty = new Set(); }
  }

  function persistLocal() {
    if (READONLY) return;
    try {
      localStorage.setItem(LS.entries, JSON.stringify(state.entries));
      localStorage.setItem(LS.dirty, JSON.stringify([...state.dirty]));
    } catch (e) {
      state.notice = 'Could not save on this device (storage is full or blocked).';
    }
  }

  function saveEntry(entry) {
    if (READONLY) return;
    entry.updatedAt = Date.now();
    state.entries[entry.date] = entry;
    state.dirty.add(entry.date);
    persistLocal();
    scheduleFlush();
  }

  // ---------- cloud (Supabase) ----------

  function getConfig() {
    const file = window.DSD_CONFIG || {};
    if (file.supabaseUrl && file.supabaseAnonKey) return { url: file.supabaseUrl, key: file.supabaseAnonKey, source: 'file' };
    if (hashParams.get('u') && hashParams.get('k')) return { url: hashParams.get('u'), key: hashParams.get('k'), source: 'link' };
    try {
      const saved = JSON.parse(localStorage.getItem(LS.config));
      if (saved && saved.url && saved.key) return { ...saved, source: 'saved' };
    } catch { /* ignore */ }
    return null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the sync library.'));
      document.head.append(s);
    });
  }

  async function connect() {
    const cfg = getConfig();
    if (!cfg) return null;
    if (!window.supabase) await loadScript('vendor/supabase.js');
    state.cloud.client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: READONLY ? { persistSession: false, autoRefreshToken: false } : {},
    });
    return state.cloud.client;
  }

  function setStatus(status, error) {
    state.cloud.status = status;
    state.cloud.error = error || '';
    const chip = document.getElementById('sync-chip');
    if (chip) chip.outerHTML = syncChipHtml();
  }

  async function initCloud() {
    try {
      const client = await connect();
      if (!client) return;
      if (READONLY) { await loadShared(); return; }
      const { data } = await client.auth.getSession();
      state.cloud.user = data.session ? data.session.user : null;
      if (state.cloud.user) await pullAll();
      render();
    } catch (e) {
      setStatus('error', e.message);
      render();
    }
  }

  async function pullAll() {
    const { client } = state.cloud;
    setStatus('syncing');
    const { data, error } = await client.from('entries').select('day,data').order('day').limit(10000);
    if (error) { setStatus('error', error.message); return; }
    const remoteDays = new Set();
    for (const row of data) {
      remoteDays.add(row.day);
      const local = state.entries[row.day];
      if (!local || (row.data.updatedAt || 0) >= (local.updatedAt || 0)) {
        state.entries[row.day] = { ...blankEntry(row.day), ...row.data, date: row.day };
        state.dirty.delete(row.day);
      } else {
        state.dirty.add(row.day);
      }
    }
    for (const key of Object.keys(state.entries)) if (!remoteDays.has(key)) state.dirty.add(key);
    persistLocal();
    await flush();
    loadShare();
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (!state.cloud.user) return;
    setStatus('syncing');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 900);
  }

  let flushing = false;
  async function flush() {
    const { client, user } = state.cloud;
    if (!client || !user) return;
    if (flushing) { scheduleFlush(); return; }
    if (!state.dirty.size) { setStatus('synced'); return; }
    flushing = true;
    const days = [...state.dirty].filter((d) => state.entries[d]);
    const sentAt = Object.fromEntries(days.map((d) => [d, state.entries[d].updatedAt]));
    const rows = days.map((d) => ({
      owner: user.id, day: d, data: state.entries[d], updated_at: new Date().toISOString(),
    }));
    try {
      const { error } = await client.from('entries').upsert(rows, { onConflict: 'owner,day' });
      if (error) throw error;
      for (const d of days) if (state.entries[d].updatedAt === sentAt[d]) state.dirty.delete(d);
      persistLocal();
      flushing = false;
      if (state.dirty.size) scheduleFlush(); else setStatus('synced');
    } catch (e) {
      flushing = false;
      setStatus(navigator.onLine === false ? 'offline' : 'error', e.message);
    }
  }

  async function loadShared() {
    setStatus('syncing');
    const { data, error } = await state.cloud.client.rpc('shared_entries', { share_code: hashParams.get('view') });
    if (error) { setStatus('error', error.message); render(); return; }
    state.entries = {};
    for (const row of data || []) state.entries[row.day] = { ...blankEntry(row.day), ...row.data, date: row.day };
    setStatus('synced');
    render();
  }

  async function loadShare() {
    const { client } = state.cloud;
    const { data, error } = await client.from('share_links').select('code').maybeSingle();
    state.cloud.share = error ? null : (data ? data.code : null);
    if (state.tab === 'settings') render();
  }

  function shareUrl() {
    const cfg = getConfig();
    const p = new URLSearchParams({ view: state.cloud.share });
    if (cfg.source !== 'file') { p.set('u', cfg.url); p.set('k', cfg.key); }
    return `${location.origin}${location.pathname}#${p.toString()}`;
  }

  function newShareCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // ---------- views ----------

  function syncChipHtml() {
    const c = state.cloud;
    let label = 'Saved on this device'; let cls = 'local';
    if (READONLY) {
      label = c.status === 'syncing' ? 'Loading…' : c.status === 'error' ? 'Could not load' : 'Read-only';
      cls = c.status === 'error' ? 'error' : 'readonly';
    } else if (c.status === 'error') { label = 'Sync problem'; cls = 'error'; }
    else if (c.status === 'offline') { label = 'Offline — will sync later'; cls = 'error'; }
    else if (c.user && c.status === 'syncing') { label = 'Syncing…'; cls = 'syncing'; }
    else if (c.user) { label = 'Synced'; cls = 'synced'; }
    return `<span id="sync-chip" class="chip ${cls}" title="${esc(c.error)}">${label}</span>`;
  }

  function headerHtml() {
    const tabs = READONLY
      ? [['latest', 'Latest'], ['history', 'History']]
      : [['today', 'Today'], ['history', 'History'], ['settings', 'Settings']];
    return `
      <header class="top">
        <div class="brand">
          <img src="icon.svg" alt="" width="32" height="32">
          <h1>Daily Stand-Down</h1>
          ${syncChipHtml()}
        </div>
        <nav class="tabs" aria-label="Sections">
          ${tabs.map(([id, label]) => `
            <button class="tab ${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}"
              ${state.tab === id ? 'aria-current="page"' : ''}>${label}</button>`).join('')}
        </nav>
      </header>`;
  }

  function textBlock(title, text, cls) {
    if (!text || !text.trim()) return '';
    return `<div class="block ${cls || ''}"><h4>${title}</h4><p class="pre">${esc(text.trim())}</p></div>`;
  }

  function moodHtml(mood) {
    if (!mood) return '';
    return `<span class="mood-pill m${mood}">${mood}/5 · ${MOODS[mood]}</span>`;
  }

  function taskStats(entry) {
    const total = entry.tasks.length;
    const done = entry.tasks.filter((t) => t.done).length;
    return { total, done };
  }

  function staticTasksHtml(tasks) {
    if (!tasks.length) return '<p class="muted">No tasks were set.</p>';
    return `<ul class="tasks static">${tasks.map((t) => `
      <li class="${t.done ? 'done' : ''}">
        <span class="box" aria-hidden="true">${t.done ? '✓' : ''}</span>
        <span class="txt">${esc(t.text)}</span>
        ${t.carried ? '<span class="tag">carried over</span>' : ''}
        <span class="sr">${t.done ? '(done)' : '(not done)'}</span>
      </li>`).join('')}</ul>`;
  }

  // Full read-only picture of one day, used by History and the shared view.
  function dayHtml(entry) {
    const { total, done } = taskStats(entry);
    return `
      <div class="day-meta">
        ${total ? `<span class="stat">${done} of ${total} tasks done</span>` : ''}
        ${moodHtml(entry.mood)}
        ${entry.closedAt ? '' : '<span class="stat open">Day not closed out</span>'}
      </div>
      <section class="card">
        <h3>Tasks for the day</h3>
        ${staticTasksHtml(entry.tasks)}
      </section>
      ${(entry.done || entry.blockers || entry.notes) ? `
      <section class="card">
        <h3>End-of-day stand-down</h3>
        ${textBlock('What got done', entry.done)}
        ${textBlock('Blockers / problems', entry.blockers)}
        ${textBlock('Notes to tomorrow-me', entry.notes, 'handover')}
      </section>` : ''}
      ${entry.nextTasks.length ? `
      <section class="card">
        <h3>Tasks set for the next day</h3>
        <ul class="plain">${entry.nextTasks.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul>
      </section>` : ''}`;
  }

  function recapHtml(prev) {
    const { total, done } = taskStats(prev);
    const missed = prev.tasks.filter((t) => !t.done);
    const empty = !prev.done && !prev.blockers && !prev.notes && !total;
    return `
      <div class="day-meta">
        ${total ? `<span class="stat">${done} of ${total} tasks done</span>` : ''}
        ${moodHtml(prev.mood)}
      </div>
      ${empty ? '<p class="muted">Nothing was written down that day.</p>' : ''}
      ${textBlock('Notes from past-you', prev.notes, 'handover')}
      ${textBlock('What got done', prev.done)}
      ${textBlock('Blockers / problems', prev.blockers)}
      ${missed.length ? `<div class="block"><h4>Left unfinished</h4>
        <ul class="plain">${missed.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul></div>` : ''}`;
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function buildCheckin(today, prev) {
    return {
      date: today,
      planned: prev ? prev.nextTasks.map((t) => ({ text: t.text })) : [],
      carry: prev ? prev.tasks.filter((t) => !t.done).map((t) => ({ text: t.text, on: true })) : [],
    };
  }

  function checkinHtml(today, prev) {
    if (!state.checkin || state.checkin.date !== today) state.checkin = buildCheckin(today, prev);
    const c = state.checkin;
    return `
      <div class="hero">
        <p class="eyebrow">${esc(fmtDate(today))}</p>
        <h2>${greeting()}. Here's your handover.</h2>
      </div>
      ${prev ? `
      <section class="card">
        <h3>Recap of ${esc(relDay(prev.date))}</h3>
        ${recapHtml(prev)}
      </section>` : `
      <section class="card">
        <h3>Welcome</h3>
        <p>This is your first day, so there's nothing to recap yet. Add what you want to get done today,
        then come back this evening to stand down and leave notes for tomorrow.</p>
      </section>`}
      <section class="card">
        <h3>Your tasks for today</h3>
        ${c.planned.length ? `<ul class="tasks">${c.planned.map((t, i) => `
          <li><span class="txt">${esc(t.text)}</span>
            <button class="icon" data-action="checkin-remove" data-i="${i}" aria-label="Remove task: ${esc(t.text)}">×</button>
          </li>`).join('')}</ul>`
          : `<p class="muted">${prev ? 'You didn\'t set any tasks for today.' : 'No tasks yet.'}</p>`}
        <div class="add-row">
          <input type="text" data-focus="checkin-add" data-enter="checkin-add" placeholder="Add a task for today" aria-label="Add a task for today" maxlength="300">
          <button class="btn" data-action="checkin-add">Add</button>
        </div>
      </section>
      ${c.carry.length ? `
      <section class="card">
        <h3>Unfinished from ${esc(relDay(prev.date))}</h3>
        <p class="muted">Tick the ones to bring into today. Unticked ones stay behind in that day's record.</p>
        <ul class="tasks">${c.carry.map((t, i) => `
          <li><label class="check"><input type="checkbox" data-action="checkin-carry" data-i="${i}" ${t.on ? 'checked' : ''}>
            <span class="txt">${esc(t.text)}</span></label></li>`).join('')}</ul>
      </section>` : ''}
      <button class="btn primary big" data-action="checkin-start">Start my day</button>`;
  }

  function todayTasksHtml(entry) {
    const { total, done } = taskStats(entry);
    return `
      <section class="card">
        <div class="card-head">
          <h3>Today's tasks</h3>
          ${total ? `<span class="stat">${done} of ${total} done</span>` : ''}
        </div>
        ${total ? `<ul class="tasks">${entry.tasks.map((t) => `
          <li class="${t.done ? 'done' : ''}">
            <label class="check"><input type="checkbox" data-action="task-toggle" data-id="${t.id}" ${t.done ? 'checked' : ''}>
              <span class="txt">${esc(t.text)}</span></label>
            ${t.carried ? '<span class="tag">carried over</span>' : ''}
            <button class="icon" data-action="task-remove" data-id="${t.id}" aria-label="Remove task: ${esc(t.text)}">×</button>
          </li>`).join('')}</ul>` : '<p class="muted">No tasks for today yet.</p>'}
        <div class="add-row">
          <input type="text" data-focus="task-add" data-enter="task-add" placeholder="Add a task" aria-label="Add a task" maxlength="300">
          <button class="btn" data-action="task-add">Add</button>
        </div>
      </section>`;
  }

  function standdownFormHtml(entry) {
    return `
      <section class="card">
        <h3>Evening stand-down</h3>
        <p class="muted">Fill this in whenever you like during the day. It saves as you type.</p>
        <label class="field"><span>What I got done</span>
          <textarea data-field="done" rows="4" placeholder="Progress, wins, things finished">${esc(entry.done)}</textarea></label>
        <label class="field"><span>Blockers / problems</span>
          <textarea data-field="blockers" rows="3" placeholder="What got in the way or still needs solving">${esc(entry.blockers)}</textarea></label>
        <label class="field"><span>Notes to tomorrow-me</span>
          <textarea data-field="notes" rows="4" placeholder="Where you left off, reminders, context you'll want in the morning">${esc(entry.notes)}</textarea></label>
        <div class="field"><span id="mood-label">Mood / energy</span>
          <div class="moods" role="group" aria-labelledby="mood-label">
            ${[1, 2, 3, 4, 5].map((n) => `
              <button class="mood m${n} ${entry.mood === n ? 'on' : ''}" data-action="mood" data-n="${n}"
                aria-pressed="${entry.mood === n}"><b>${n}</b><small>${MOODS[n]}</small></button>`).join('')}
          </div>
        </div>
        <div class="field"><span>Tasks for tomorrow</span>
          ${entry.nextTasks.length ? `<ul class="tasks">${entry.nextTasks.map((t) => `
            <li><span class="txt">${esc(t.text)}</span>
              <button class="icon" data-action="next-remove" data-id="${t.id}" aria-label="Remove task: ${esc(t.text)}">×</button>
            </li>`).join('')}</ul>` : ''}
          <div class="add-row">
            <input type="text" data-focus="next-add" data-enter="next-add" placeholder="Add a task for tomorrow" aria-label="Add a task for tomorrow" maxlength="300">
            <button class="btn" data-action="next-add">Add</button>
          </div>
        </div>
        <button class="btn primary big" data-action="close-day">${entry.closedAt ? 'Save changes' : 'Stand down for the day'}</button>
      </section>`;
  }

  function closedHtml(entry) {
    return `
      <section class="card closed">
        <div class="card-head">
          <h3>You've stood down for today</h3>
          ${moodHtml(entry.mood)}
        </div>
        ${textBlock('What got done', entry.done)}
        ${textBlock('Blockers / problems', entry.blockers)}
        ${textBlock('Notes to tomorrow-me', entry.notes, 'handover')}
        <div class="block"><h4>Tasks for tomorrow</h4>
          ${entry.nextTasks.length
            ? `<ul class="plain">${entry.nextTasks.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul>`
            : '<p class="muted">None set.</p>'}
        </div>
        <button class="btn" data-action="edit-close">Edit stand-down</button>
      </section>`;
  }

  function todayHtml() {
    const today = todayKey();
    const entry = state.entries[today];
    const prev = previousEntry(today);
    if (!entry || !entry.checkedInAt) return checkinHtml(today, prev);
    return `
      <div class="hero">
        <p class="eyebrow">${esc(fmtDate(today))}</p>
        <h2>Today</h2>
      </div>
      ${todayTasksHtml(entry)}
      ${prev ? `<details class="card"><summary>Recap of ${esc(relDay(prev.date))}</summary>${recapHtml(prev)}</details>` : ''}
      ${entry.closedAt && !state.editingClose ? closedHtml(entry) : standdownFormHtml(entry)}`;
  }

  function matchesSearch(entry, q) {
    if (!q) return true;
    const hay = [entry.done, entry.blockers, entry.notes, fmtDate(entry.date),
      ...entry.tasks.map((t) => t.text), ...entry.nextTasks.map((t) => t.text)].join('\n').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function historyListHtml() {
    const keys = sortedKeys().reverse().filter((k) => matchesSearch(state.entries[k], state.search.trim()));
    if (!keys.length) {
      return `<p class="muted pad">${sortedKeys().length ? 'No days match that search.' : 'No days recorded yet.'}</p>`;
    }
    return `<ul class="days">${keys.map((k) => {
      const e = state.entries[k];
      const { total, done } = taskStats(e);
      const snippet = (e.done || e.notes || e.blockers || e.tasks.map((t) => t.text).join(', ')).trim();
      return `<li><button class="day-row" data-action="open-day" data-day="${k}">
        <span class="day-date"><b>${esc(fmtDate(k, { weekday: 'short', month: 'short', day: 'numeric' }))}</b>
          <small>${fromKey(k).getFullYear()}</small></span>
        <span class="day-snip">${esc(snippet.slice(0, 140)) || '<i>No notes</i>'}</span>
        <span class="day-side">${total ? `<span class="stat">${done}/${total}</span>` : ''}
          ${e.mood ? `<span class="mood-dot m${e.mood}" title="Mood ${e.mood}/5">${e.mood}</span>` : ''}</span>
      </button></li>`;
    }).join('')}</ul>`;
  }

  function historyHtml() {
    if (state.historyDay && state.entries[state.historyDay]) {
      const keys = sortedKeys();
      const i = keys.indexOf(state.historyDay);
      const older = keys[i - 1]; const newer = keys[i + 1];
      return `
        <div class="day-nav">
          <button class="btn" data-action="open-day" data-day="">← All days</button>
          <span class="spacer"></span>
          <button class="btn" data-action="open-day" data-day="${older || ''}" ${older ? '' : 'disabled'} aria-label="Older day">‹ Older</button>
          <button class="btn" data-action="open-day" data-day="${newer || ''}" ${newer ? '' : 'disabled'} aria-label="Newer day">Newer ›</button>
        </div>
        <div class="hero"><h2>${esc(fmtDate(state.historyDay))}</h2></div>
        ${dayHtml(state.entries[state.historyDay])}`;
    }
    return `
      <div class="hero"><h2>History</h2></div>
      <input type="search" class="search" data-search placeholder="Search past days" aria-label="Search past days" value="${esc(state.search)}">
      <div id="history-list">${historyListHtml()}</div>`;
  }

  function latestHtml() {
    const c = state.cloud;
    if (!getConfig()) return '<section class="card"><h3>This link is incomplete</h3><p>Ask the owner to send the read-only link again.</p></section>';
    if (c.status === 'error') return `<section class="card"><h3>Could not load the entries</h3><p>${esc(c.error)}</p><button class="btn" data-action="reload">Try again</button></section>`;
    if (c.status !== 'synced') return '<p class="muted pad">Loading…</p>';
    const keys = sortedKeys();
    if (!keys.length) {
      return '<section class="card"><h3>Nothing to show</h3><p>There are no entries yet, or this read-only link has been turned off by its owner.</p></section>';
    }
    const k = keys[keys.length - 1];
    return `
      <div class="hero">
        <p class="eyebrow">Latest entry</p>
        <h2>${esc(fmtDate(k))}</h2>
      </div>
      ${dayHtml(state.entries[k])}
      <button class="btn" data-action="reload">Refresh</button>`;
  }

  function settingsHtml() {
    const cfg = getConfig();
    const c = state.cloud;
    let sync;
    if (!cfg) {
      sync = `
        <p>Right now your entries are saved only in this browser. Connect a free Supabase project to back them up
        and to create a read-only link for other devices and people. The step-by-step guide is in <code>README.md</code>.</p>
        <label class="field"><span>Supabase project URL</span>
          <input type="url" id="cfg-url" placeholder="https://xxxx.supabase.co" autocomplete="off"></label>
        <label class="field"><span>Supabase publishable (anon) key</span>
          <input type="text" id="cfg-key" autocomplete="off" spellcheck="false"></label>
        <button class="btn primary" data-action="cfg-save">Connect</button>`;
    } else if (!c.user) {
      sync = `
        <p>Connected to <code>${esc(cfg.url)}</code>. Sign in on the device you write from.</p>
        <label class="field"><span>Email</span><input type="email" id="auth-email" autocomplete="username"></label>
        <label class="field"><span>Password</span><input type="password" id="auth-pass" autocomplete="current-password" data-enter="sign-in"></label>
        <div class="row">
          <button class="btn primary" data-action="sign-in">Sign in</button>
          <button class="btn" data-action="sign-up">Create account</button>
          ${cfg.source === 'saved' ? '<button class="btn link" data-action="cfg-clear">Disconnect project</button>' : ''}
        </div>`;
    } else {
      const share = c.share === undefined ? '<p class="muted">Checking…</p>'
        : c.share ? `
          <p>Anyone with this link can read every entry but cannot change anything.</p>
          <div class="add-row"><input type="text" id="share-url" readonly value="${esc(shareUrl())}" aria-label="Read-only link">
            <button class="btn primary" data-action="share-copy">Copy</button></div>
          <div class="row">
            <button class="btn" data-action="share-new">Replace with a new link</button>
            <button class="btn danger" data-action="share-off">Turn off sharing</button>
          </div>`
          : `<p>Create a link that lets other devices and people read your entries without being able to change them.</p>
          <button class="btn primary" data-action="share-new">Create read-only link</button>`;
      sync = `
        <p>Signed in as <b>${esc(c.user.email)}</b>. Entries sync automatically.</p>
        <div class="row"><button class="btn" data-action="sign-out">Sign out</button></div>
        <h4 class="sub">Read-only link</h4>
        ${share}`;
    }
    return `
      <div class="hero"><h2>Settings</h2></div>
      <section class="card">
        <h3>Sync and sharing</h3>
        ${c.message ? `<p class="msg" role="status">${esc(c.message)}</p>` : ''}
        ${c.status === 'error' && c.error ? `<p class="msg err" role="alert">${esc(c.error)}</p>` : ''}
        ${sync}
      </section>
      <section class="card">
        <h3>Backup</h3>
        <p>Download every entry as a file, or load entries from a backup file.</p>
        <div class="row">
          <button class="btn" data-action="export">Download backup</button>
          <label class="btn">Load backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </section>`;
  }

  function render() {
    state.renderedDay = todayKey();
    const body = state.tab === 'today' ? todayHtml()
      : state.tab === 'latest' ? latestHtml()
      : state.tab === 'history' ? historyHtml()
      : settingsHtml();
    $app.innerHTML = `
      ${headerHtml()}
      ${READONLY ? '<p class="banner">You are viewing a read-only copy. Nothing here can be changed.</p>' : ''}
      ${state.notice ? `<p class="banner warn" role="alert">${esc(state.notice)}</p>` : ''}
      <main>${body}</main>`;
    if (state.focus) {
      const el = $app.querySelector(`[data-focus="${state.focus}"]`);
      if (el) el.focus();
      state.focus = null;
    }
  }

  // ---------- actions ----------

  function todayEntry() {
    const k = todayKey();
    return state.entries[k] || blankEntry(k);
  }

  function takeInput(name) {
    const el = $app.querySelector(`[data-focus="${name}"]`);
    const text = el ? el.value.trim() : '';
    state.focus = name;
    return text;
  }

  function setMessage(msg) { state.cloud.message = msg; render(); }

  async function auth(mode) {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-pass').value;
    if (!email || !password) return setMessage('Enter your email and password.');
    if (!state.cloud.client) {
      try { await connect(); } catch (e) { return setMessage(e.message); }
    }
    const { client } = state.cloud;
    const res = mode === 'up'
      ? await client.auth.signUp({ email, password })
      : await client.auth.signInWithPassword({ email, password });
    if (res.error) return setMessage(res.error.message);
    if (!res.data.session) return setMessage('Account created. Open the confirmation email, then come back and sign in.');
    state.cloud.user = res.data.session.user;
    state.cloud.message = '';
    await pullAll();
    render();
  }

  async function shareAction(kind) {
    const { client, user } = state.cloud;
    if (kind === 'off') {
      if (!confirm('Turn off the read-only link? Anyone using it will lose access.')) return;
      const { error } = await client.from('share_links').delete().eq('owner', user.id);
      if (error) return setMessage(error.message);
      state.cloud.share = null;
      return setMessage('Sharing is off.');
    }
    if (state.cloud.share && !confirm('Replace the link? The current link will stop working.')) return;
    const code = newShareCode();
    const { error } = await client.from('share_links').upsert({ owner: user.id, code });
    if (error) return setMessage(error.message);
    state.cloud.share = code;
    setMessage('Read-only link is ready.');
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ app: 'daily-stand-down', version: 1, entries: state.entries }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stand-down-backup-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importBackup(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed.entries || parsed;
      const keys = Object.keys(incoming).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
      if (!keys.length) throw new Error('No entries found in that file.');
      const clash = keys.filter((k) => state.entries[k]).length;
      if (clash && !confirm(`${clash} day(s) in the backup already exist here and will be replaced. Continue?`)) return;
      for (const k of keys) {
        state.entries[k] = { ...blankEntry(k), ...incoming[k], date: k, updatedAt: Date.now() };
        state.dirty.add(k);
      }
      persistLocal();
      scheduleFlush();
      setMessage(`Loaded ${keys.length} day(s) from the backup.`);
    } catch (e) {
      setMessage(`Could not load that file: ${e.message}`);
    }
  }

  const actions = {
    tab(el) { state.tab = el.dataset.tab; state.historyDay = null; state.cloud.message = ''; render(); },
    'open-day'(el) { state.historyDay = el.dataset.day || null; render(); window.scrollTo(0, 0); },
    reload() { loadShared(); render(); },

    'checkin-add'() {
      const text = takeInput('checkin-add');
      if (text) state.checkin.planned.push({ text });
      render();
    },
    'checkin-remove'(el) { state.checkin.planned.splice(Number(el.dataset.i), 1); render(); },
    'checkin-carry'(el) { state.checkin.carry[Number(el.dataset.i)].on = el.checked; },
    'checkin-start'() {
      const pending = takeInput('checkin-add');
      state.focus = null;
      if (pending) state.checkin.planned.push({ text: pending });
      const entry = todayEntry();
      const c = state.checkin;
      entry.tasks = [
        ...entry.tasks,
        ...c.planned.map((t) => ({ id: uid(), text: t.text, done: false, carried: false })),
        ...c.carry.filter((t) => t.on).map((t) => ({ id: uid(), text: t.text, done: false, carried: true })),
      ];
      entry.checkedInAt = Date.now();
      state.checkin = null;
      saveEntry(entry);
      render();
      window.scrollTo(0, 0);
    },

    'task-add'() {
      const text = takeInput('task-add');
      if (text) { const e = todayEntry(); e.tasks.push({ id: uid(), text, done: false, carried: false }); saveEntry(e); }
      render();
    },
    'task-toggle'(el) {
      const e = todayEntry();
      const t = e.tasks.find((x) => x.id === el.dataset.id);
      if (t) { t.done = el.checked; saveEntry(e); }
      render();
    },
    'task-remove'(el) {
      const e = todayEntry();
      e.tasks = e.tasks.filter((x) => x.id !== el.dataset.id);
      saveEntry(e); render();
    },
    'next-add'() {
      const text = takeInput('next-add');
      if (text) { const e = todayEntry(); e.nextTasks.push({ id: uid(), text }); saveEntry(e); }
      render();
    },
    'next-remove'(el) {
      const e = todayEntry();
      e.nextTasks = e.nextTasks.filter((x) => x.id !== el.dataset.id);
      saveEntry(e); render();
    },
    mood(el) {
      const e = todayEntry();
      const n = Number(el.dataset.n);
      e.mood = e.mood === n ? null : n;
      saveEntry(e); render();
    },
    'close-day'() {
      const pending = takeInput('next-add');
      state.focus = null;
      const e = todayEntry();
      if (pending) e.nextTasks.push({ id: uid(), text: pending });
      e.closedAt = e.closedAt || Date.now();
      state.editingClose = false;
      saveEntry(e); render();
    },
    'edit-close'() { state.editingClose = true; render(); },

    'cfg-save'() {
      const url = document.getElementById('cfg-url').value.trim().replace(/\/+$/, '');
      const key = document.getElementById('cfg-key').value.trim();
      if (!/^https:\/\/.+/.test(url) || !key) return setMessage('Enter both the project URL (starting with https://) and the key.');
      localStorage.setItem(LS.config, JSON.stringify({ url, key }));
      state.cloud.message = '';
      initCloud().then(render);
    },
    'cfg-clear'() {
      localStorage.removeItem(LS.config);
      state.cloud.client = null;
      setStatus('local');
      setMessage('Project disconnected. Your entries are still on this device.');
    },
    'sign-in'() { auth('in'); },
    'sign-up'() { auth('up'); },
    async 'sign-out'() {
      await state.cloud.client.auth.signOut();
      state.cloud.user = null; state.cloud.share = undefined;
      setStatus('local');
      setMessage('Signed out. Your entries are still on this device.');
    },
    'share-new'() { shareAction('new'); },
    'share-off'() { shareAction('off'); },
    async 'share-copy'() {
      const input = document.getElementById('share-url');
      try { await navigator.clipboard.writeText(input.value); setMessage('Link copied.'); }
      catch { input.select(); setMessage('Press Ctrl/Cmd+C to copy the selected link.'); }
    },
    export: exportBackup,
  };

  // ---------- events ----------

  $app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || el.type === 'checkbox') return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  });

  $app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.type === 'checkbox' && el.dataset.action && actions[el.dataset.action]) actions[el.dataset.action](el);
    if (el.id === 'import-file' && el.files[0]) importBackup(el.files[0]);
  });

  $app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.field) {
      const e = todayEntry();
      e[el.dataset.field] = el.value;
      saveEntry(e);
    } else if ('search' in el.dataset) {
      state.search = el.value;
      document.getElementById('history-list').innerHTML = historyListHtml();
    }
  });

  $app.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || !ev.target.dataset || !ev.target.dataset.enter) return;
    ev.preventDefault();
    const fn = actions[ev.target.dataset.enter];
    if (fn) fn(ev.target);
  });

  // If the app is left open overnight, switch to the new day's check-in.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.renderedDay !== todayKey()) { state.editingClose = false; render(); }
    if (READONLY && state.cloud.client) loadShared();
    else if (state.dirty.size) scheduleFlush();
  });
  window.addEventListener('online', () => { if (state.dirty.size) scheduleFlush(); });
  window.addEventListener('hashchange', () => location.reload());

  // ---------- start ----------

  if (!READONLY) loadLocal();
  render();
  initCloud();
})();
