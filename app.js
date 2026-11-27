(() => {
  'use strict';

  // ---------- setup ----------

  const LS = { entries: 'dsd.entries', dirty: 'dsd.dirty', config: 'dsd.config', user: 'dsd.user', shared: 'dsd.shared.' };
  const DAY_STARTS_AT_HOUR = 4; // before 4am still counts as the previous day
  const MOODS = ['', 'Rough', 'Low', 'Okay', 'Good', 'Great'];
  const STALE_AFTER = 3; // a task carried over this many days in a row gets flagged
  const READER_REFRESH_MS = 5 * 60 * 1000;

  const $app = document.getElementById('app');
  const $print = document.getElementById('print-root');
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const READONLY = hashParams.has('view');
  const SHARE_CODE = hashParams.get('view');

  const state = {
    entries: {},
    dirty: new Set(),
    tab: READONLY ? 'latest' : 'today',
    historyDay: null,
    histView: 'list',
    calMonth: null,
    calColor: 'mood',
    search: '',
    trendRange: 30,
    trendDays: [],
    checkin: null,
    editingClose: false,
    menu: null, // { list, id, mode: 'menu' | 'edit' | 'later' }
    staleLater: null,
    exportOpen: false,
    exportRange: null,
    focus: null,
    notice: '',
    renderedDay: null,
    cloud: {
      client: null, user: null, offline: false, ready: false, pulled: false,
      status: 'local', error: '', message: '',
      share: undefined, shareOpts: null, shareSchemaOld: false,
      readerLoaded: false, readerSig: '', readerUpdated: null,
    },
  };

  // ---------- small helpers ----------

  // Line icons (24x24, drawn with the current text colour).
  const ICONS = {
    star: '<path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1 6L12 17.05 6.65 19.85l1-6L3.3 9.6l6-.9z"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    grip: '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    'chev-left': '<path d="M15 18l-6-6 6-6"/>',
    'chev-right': '<path d="M9 18l6-6-6-6"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    today: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
    history: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    trends: '<path d="M4 20V11M10 20V5M16 20v-6M3 20.5h18"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    latest: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
    pin: '<path d="M9 3.5h6l-1 5.5 3.5 3.5v2h-11v-2L10 9z"/><path d="M12 14.5V21"/>',
  };
  const ic = (name, cls) => `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  const starIcon = (on) => ic('star', on ? 'filled' : '');

  // Wide screens get the desktop layout: sidebar, columns, master-detail.
  const DESKTOP_QUERY = window.matchMedia('(min-width: 1024px)');
  const isDesktop = () => DESKTOP_QUERY.matches;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const pad = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const isKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');
  const norm = (text) => String(text || '').trim().toLowerCase();

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

  const fmtShort = (key) => fmtDate(key, { month: 'short', day: 'numeric' });
  const fmtDay = (key) => fmtDate(key, { weekday: 'short', month: 'short', day: 'numeric' });

  function relDay(key) {
    const t = todayKey();
    if (key === t) return 'today';
    if (key === shiftKey(t, -1)) return 'yesterday';
    if (key === shiftKey(t, 1)) return 'tomorrow';
    return fmtDate(key, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // Weeks start on Monday.
  function weekStart(key) {
    return shiftKey(key, -((fromKey(key).getDay() + 6) % 7));
  }

  function timeAgo(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function blankEntry(date) {
    return {
      date, tasks: [], checkedInAt: null,
      done: '', blockers: '', notes: '', mood: null,
      nextTasks: [], skippedPlanned: [], scheduled: [], scheduledTaken: [],
      work: { start: '', end: '', breakMin: 0 },
      dayType: '', log: [], pinned: false,
      closedAt: null, updatedAt: 0,
    };
  }

  // ---------- work hours ----------
  // entry.work = { start: 'HH:MM', end: 'HH:MM', breakMin: minutes }.

  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  const isTime = (v) => /^\d{2}:\d{2}$/.test(v || '');
  const nowHHMM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function fmtTime(hhmm) {
    if (!isTime(hhmm)) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDur(min) {
    if (min === null || min === undefined) return '—';
    const h = Math.floor(min / 60); const m = Math.round(min % 60);
    return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  }

  // Minutes worked for a finished day, or null if start/finish aren't both set.
  // A finish earlier than the start is taken as past midnight.
  function minutesWorked(e) {
    const w = e && e.work;
    if (!w || !isTime(w.start) || !isTime(w.end)) return null;
    let d = toMin(w.end) - toMin(w.start);
    if (d < 0) d += 1440;
    return Math.max(0, d - (Number(w.breakMin) || 0));
  }

  // For today: worked so far if started but not finished.
  function minutesSoFar(e) {
    const done = minutesWorked(e);
    if (done !== null) return { min: done, live: false };
    const w = e && e.work;
    if (!w || !isTime(w.start) || e.date !== todayKey()) return null;
    let d = toMin(nowHHMM()) - toMin(w.start);
    if (d < 0) d += 1440;
    return { min: Math.max(0, d - (Number(w.breakMin) || 0)), live: true };
  }

  const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);

  // Hours expected on a day: the target on normal working days, none on
  // weekends (or other days you don't work) and on leave, sick or holidays.
  function expectedMin(e) {
    if (!e || isOff(e)) return 0;
    const st = getMeta().settings;
    return st.workdays.includes(fromKey(e.date).getDay()) ? Number(st.targetMin) || 0 : 0;
  }

  // Over (+) or under (-) target for a day with hours logged, else null.
  function overMin(e) {
    const w = minutesWorked(e);
    return w === null ? null : w - expectedMin(e);
  }

  const fmtSigned = (m) => (m === null || m === undefined ? '—' : m === 0 ? '±0m' : `${m < 0 ? '−' : '+'}${fmtDur(Math.abs(m))}`);

  // Overtime balance between two dates (days with hours logged only).
  function balance(from, to) {
    let sum = 0; let n = 0;
    for (const e of entriesBetween(from, to)) {
      const o = overMin(e);
      if (o !== null) { sum += o; n += 1; }
    }
    return n ? sum : null;
  }

  function hoursSummary(e) {
    const w = e && e.work;
    if (!w || !isTime(w.start)) return '';
    const span = `${fmtTime(w.start)} – ${isTime(w.end) ? fmtTime(w.end) : 'not finished'}`;
    const brk = Number(w.breakMin) ? `, ${fmtDur(Number(w.breakMin))} break` : '';
    return `${span}${brk}`;
  }

  const withDefaults = (e) => {
    const out = { ...blankEntry(e.date), ...e };
    out.work = { ...blankEntry(e.date).work, ...(e.work || {}) };
    return out;
  };

  // One extra synced row (dated 1900-01-01) holds settings, the inbox and the
  // waiting-on list. It is never treated as a day.
  const META = '1900-01-01';
  const sortedKeys = () => Object.keys(state.entries).filter((k) => k !== META).sort();
  const dayEntries = () => sortedKeys().map((k) => state.entries[k]);

  const DEFAULT_SETTINGS = { targetMin: 480, workdays: [1, 2, 3, 4, 5] };
  function getMeta() {
    const m = state.entries[META] || {};
    return {
      ...m, date: META,
      inbox: m.inbox || [], waiting: m.waiting || [],
      settings: { ...DEFAULT_SETTINGS, ...(m.settings || {}) },
    };
  }
  function saveMeta(m) { saveEntry(m); }

  // ---------- day types ----------
  const DAY_TYPES = [['', 'Working day'], ['office', 'Office'], ['remote', 'Remote'], ['leave', 'Leave'], ['sick', 'Sick'], ['holiday', 'Public holiday']];
  const OFF_TYPES = ['leave', 'sick', 'holiday'];
  const dayTypeLabel = (t) => (DAY_TYPES.find(([k]) => k === t) || ['', ''])[1];
  const isOff = (e) => !!e && OFF_TYPES.includes(e.dayType);
  // A day that was only marked as leave/sick/holiday, with nothing written.
  const isMarkerOnly = (e) => isOff(e) && !e.checkedInAt && !(e.tasks || []).length && !(e.nextTasks || []).length;

  function dayTypeSelectHtml(day, value) {
    return `<select data-daytype="${day}" aria-label="Day type">${DAY_TYPES.map(([k, label]) =>
      `<option value="${k}" ${k === (value || '') ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  }

  function previousEntry(key) {
    const keys = sortedKeys().filter((k) => k < key && !isMarkerOnly(state.entries[k]));
    return keys.length ? state.entries[keys[keys.length - 1]] : null;
  }

  function entriesBetween(from, to) {
    return sortedKeys().filter((k) => k >= from && k <= to).map((k) => state.entries[k]);
  }

  // Must-do tasks first, otherwise keep the order they were in.
  const prioFirst = (list) => [...list.filter((t) => t.priority), ...list.filter((t) => !t.priority)];

  function taskStats(entry) {
    const total = entry.tasks.length;
    const done = entry.tasks.filter((t) => t.done).length;
    return { total, done };
  }

  // ---------- tasks set for a later date ----------
  // Each lives on the entry of the day it was created (entry.scheduled). When a
  // check-in pulls it into a day, that day records its id in scheduledTaken.

  function laterTakenIds() {
    const ids = new Set();
    for (const e of dayEntries()) for (const id of e.scheduledTaken || []) ids.add(id);
    return ids;
  }

  function allLater() {
    const out = [];
    for (const e of dayEntries()) for (const s of e.scheduled || []) out.push({ ...s, from: e.date });
    return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  }

  function dueLater(day) {
    const taken = laterTakenIds();
    return allLater().filter((s) => s.due <= day && !taken.has(s.id));
  }

  function upcomingLater(day) {
    const taken = laterTakenIds();
    return allLater().filter((s) => s.due > day && !taken.has(s.id));
  }

  // Put a task on a future day: tomorrow goes on tomorrow's list, anything
  // after that is kept for that day's check-in. Returns an error message or ''.
  function scheduleTask(entry, task, due) {
    const today = todayKey();
    if (!isKey(due) || due <= today) return 'Pick a date after today.';
    const item = { id: uid(), text: task.text, priority: !!task.priority };
    if (task.carriedCount) item.carriedCount = task.carriedCount;
    if (due === shiftKey(today, 1)) entry.nextTasks.push(item);
    else entry.scheduled.push({ ...item, due });
    return '';
  }

  // ---------- local storage ----------

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.entries)) || {};
      state.entries = {};
      for (const [k, e] of Object.entries(raw)) if (isKey(k)) state.entries[k] = withDefaults({ ...e, date: k });
    } catch { state.entries = {}; }
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

  // Once the app is connected to a Supabase project, nothing can be read or
  // written on this device without signing in.
  function locked() {
    return !READONLY && !!getConfig() && !state.cloud.user;
  }

  // A day with nothing in it at all (used when clearing a leave marker).
  const isMarkerOnlyBlank = (e) => !e.checkedInAt && !e.tasks.length && !e.nextTasks.length && !e.done && !e.blockers
    && !(e.log || []).length && !(e.scheduled || []).length && !(e.work && e.work.start);

  async function removeEntry(day) {
    delete state.entries[day];
    state.dirty.delete(day);
    persistLocal();
    const { client, user } = state.cloud;
    if (client && user && !state.cloud.offline) {
      try { await client.from('entries').delete().eq('day', day); } catch { /* removed locally; cloud copy stays until next try */ }
    }
  }

  function saveEntry(entry) {
    if (READONLY || locked()) return;
    entry.updatedAt = Date.now();
    state.entries[entry.date] = entry;
    if (entry.date === todayKey()) setTimeout(updateTitle, 0);
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

  const looksOffline = (err) => navigator.onLine === false
    || !!(err && /fetch|network|load failed|offline/i.test(err.message || ''));

  function rememberUser(user) {
    try {
      if (user) localStorage.setItem(LS.user, JSON.stringify({ id: user.id, email: user.email }));
      else localStorage.removeItem(LS.user);
    } catch { /* ignore */ }
  }

  function cachedUser() {
    try { return JSON.parse(localStorage.getItem(LS.user)); } catch { return null; }
  }

  // Who is signed in. With no connection the sign-in can't be checked, so the
  // last signed-in account is used and changes wait on this device until the
  // connection is back.
  async function resolveUser() {
    let data = null; let error = null;
    try { ({ data, error } = await state.cloud.client.auth.getSession()); } catch (e) { error = e; }
    const user = data && data.session ? data.session.user : null;
    if (user) { rememberUser(user); state.cloud.offline = false; return user; }
    if (looksOffline(error) && cachedUser()) { state.cloud.offline = true; return cachedUser(); }
    state.cloud.offline = false;
    return null;
  }

  async function initCloud() {
    try {
      const client = await connect();
      if (!client) return;
      if (READONLY) { await loadShared(); return; }
      state.cloud.user = await resolveUser();
      state.cloud.ready = true;
      if (state.cloud.offline) setStatus('offline');
      render();
      if (state.cloud.user) await syncFromCloud();
    } catch (e) {
      state.cloud.ready = true;
      setStatus(looksOffline(e) ? 'offline' : 'error', e.message);
      render();
    }
  }

  async function pullAll() {
    const { client } = state.cloud;
    if (state.cloud.offline) throw new Error('offline');
    setStatus('syncing');
    const { data, error } = await client.from('entries').select('day,data').order('day').limit(10000);
    if (error) { setStatus(looksOffline(error) ? 'offline' : 'error', error.message); return false; }
    const remoteDays = new Set();
    let changed = false;
    for (const row of data) {
      remoteDays.add(row.day);
      const local = state.entries[row.day];
      const remoteAt = row.data.updatedAt || 0;
      const localAt = local ? local.updatedAt || 0 : 0;
      // Newer copy wins; on a tie, unsynced changes on this device win.
      const takeRemote = !local || remoteAt > localAt || (remoteAt === localAt && !state.dirty.has(row.day));
      if (!local || remoteAt > localAt) changed = true;
      if (takeRemote) {
        state.entries[row.day] = withDefaults({ ...row.data, date: row.day });
        state.dirty.delete(row.day);
      } else {
        state.dirty.add(row.day);
      }
    }
    for (const key of Object.keys(state.entries)) if (!remoteDays.has(key)) state.dirty.add(key);
    persistLocal();
    await flush();
    loadShare();
    return changed;
  }

  // Download the latest entries. Today's screen waits for this (up to 8
  // seconds) so the morning check-in is never built from out-of-date data.
  async function syncFromCloud() {
    const first = !state.cloud.pulled;
    const timer = setTimeout(() => {
      if (!state.cloud.pulled) { state.cloud.pulled = true; render(); }
    }, 8000);
    let changed = true;
    try {
      changed = await pullAll();
    } catch (e) {
      setStatus(looksOffline(e) ? 'offline' : 'error', state.cloud.offline ? '' : e.message);
    }
    clearTimeout(timer);
    const wasWaiting = !state.cloud.pulled;
    state.cloud.pulled = true;
    if (changed || first || wasWaiting) render();
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (!state.cloud.user) return;
    if (state.cloud.offline) { setStatus('offline'); return; }
    setStatus('syncing');
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 900);
  }

  // Upload straight away instead of waiting for typing to pause.
  function flushNow() {
    if (!state.cloud.user || !state.dirty.size || state.cloud.offline) return;
    clearTimeout(flushTimer);
    flush();
  }

  let flushing = false;
  async function flush() {
    const { client, user } = state.cloud;
    if (!client || !user || state.cloud.offline) return;
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
      setStatus(looksOffline(e) ? 'offline' : 'error', e.message);
    }
  }

  // ---------- read-only link (readers) ----------

  function applyShared(rows, fromCache) {
    const entries = {};
    let newest = 0;
    for (const row of rows || []) {
      entries[row.day] = withDefaults({ ...row.data, date: row.day });
      newest = Math.max(newest, Date.parse(row.updated_at) || 0);
    }
    const sig = JSON.stringify(rows || []);
    const changed = sig !== state.cloud.readerSig;
    state.entries = entries;
    state.cloud.readerSig = sig;
    state.cloud.readerUpdated = newest || null;
    state.cloud.readerLoaded = true;
    if (!fromCache) {
      try { localStorage.setItem(LS.shared + SHARE_CODE, sig); } catch { /* ignore */ }
    }
    return changed;
  }

  function loadSharedCache() {
    try {
      const raw = localStorage.getItem(LS.shared + SHARE_CODE);
      if (raw) applyShared(JSON.parse(raw), true);
    } catch { /* ignore */ }
  }

  async function loadShared() {
    if (!state.cloud.readerLoaded) setStatus('syncing');
    let res;
    try {
      res = await state.cloud.client.rpc('shared_entries', { share_code: SHARE_CODE });
    } catch (e) { res = { error: e }; }
    if (res.error) {
      setStatus(looksOffline(res.error) ? 'offline' : 'error', res.error.message);
      render();
      return;
    }
    const changed = applyShared(res.data);
    setStatus('synced');
    if (changed) render(); else updateFreshness();
  }

  function updateFreshness() {
    const el = document.getElementById('freshness');
    if (el && state.cloud.readerUpdated) el.textContent = `Updated ${timeAgo(state.cloud.readerUpdated)}`;
  }

  // ---------- read-only link (owner) ----------

  const HIDE_FIELDS = [['hide_mood', 'Mood / energy'], ['hide_blockers', 'Blockers / problems']];

  async function loadShare() {
    const { client } = state.cloud;
    let { data, error } = await client.from('share_links').select('code,hide_mood,hide_notes,hide_blockers').maybeSingle();
    state.cloud.shareSchemaOld = false;
    if (error && /hide_|column/i.test(error.message || '')) {
      state.cloud.shareSchemaOld = true;
      ({ data, error } = await client.from('share_links').select('code').maybeSingle());
    }
    state.cloud.share = error ? null : (data ? data.code : null);
    state.cloud.shareOpts = Object.fromEntries(HIDE_FIELDS.map(([f]) => [f, !!(data && data[f])]));
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

  // ---------- shared view pieces ----------

  function syncChipHtml() {
    const c = state.cloud;
    let label = 'Saved on this device'; let cls = 'local';
    if (READONLY) {
      label = c.status === 'syncing' ? 'Loading…' : c.status === 'offline' ? 'Offline' : c.status === 'error' ? 'Could not load' : 'Read-only';
      cls = c.status === 'error' || c.status === 'offline' ? 'error' : 'readonly';
    } else if (locked()) { label = 'Signed out'; }
    else if (c.offline || c.status === 'offline') { label = 'Offline — will sync later'; cls = 'error'; }
    else if (c.status === 'error') { label = 'Sync problem'; cls = 'error'; }
    else if (c.user && c.status === 'syncing') { label = 'Syncing…'; cls = 'syncing'; }
    else if (c.user) { label = 'Synced'; cls = 'synced'; }
    return `<span id="sync-chip" class="chip ${cls}" title="${esc(c.error)}">${label}</span>`;
  }

  function headerHtml() {
    const tabs = locked() ? []
      : READONLY ? [['latest', 'Latest'], ['history', 'History'], ['trends', 'Trends']]
      : [['today', 'Today'], ['history', 'History'], ['trends', 'Trends'], ['settings', 'Settings']];
    const who = !READONLY && state.cloud.user ? state.cloud.user.email : '';
    return `
      <header class="top">
        <div class="brand">
          <img src="icon.svg" alt="" width="28" height="28">
          <h1>Daily Stand-Down</h1>
        </div>
        <div class="top-status">
          ${syncChipHtml()}
          ${who ? `<span class="who" title="${esc(who)}">${esc(who)}</span>` : ''}
          ${tabs.length ? `<p class="kbd-hint"><kbd>1</kbd>–<kbd>${tabs.length}</kbd> sections${READONLY ? '' : ' · <kbd>N</kbd> task · <kbd>I</kbd> inbox · <kbd>L</kbd> log'}
            · <kbd>/</kbd> search · <kbd>←</kbd><kbd>→</kbd> days</p>` : ''}
        </div>
        <nav class="tabs" aria-label="Sections">
          ${tabs.map(([id, label]) => `
            <button class="tab ${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}"
              ${state.tab === id ? 'aria-current="page"' : ''}>${ic(id)}<span>${label}</span></button>`).join('')}
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

  function carriedTag(t) {
    const n = t.carriedCount || (t.carried ? 1 : 0);
    if (!n) return '';
    if (n >= STALE_AFTER) return `<span class="tag warn">carried over ${n} days</span>`;
    return `<span class="tag">carried over${n > 1 ? ` ${n} days` : ''}</span>`;
  }

  const starMark = (t) => (t.priority ? `<span class="star-mark" title="Must do"><span class="sr">Must do: </span>${starIcon(true)}</span>` : '');

  function staticTasksHtml(tasks) {
    if (!tasks.length) return '<p class="muted">No tasks were set.</p>';
    return `<ul class="tasks static">${tasks.map((t) => `
      <li class="${t.done ? 'done' : ''} ${t.priority ? 'prio' : ''}">
        <span class="box" aria-hidden="true">${t.done ? ic('check') : ''}</span>
        <span class="txt-wrap"><span class="txt">${starMark(t)}${esc(t.text)}</span>${carriedTag(t)}</span>
        <span class="sr">${t.done ? '(done)' : '(not done)'}</span>
      </li>`).join('')}</ul>`;
  }

  function plainListHtml(items, withDue) {
    return `<ul class="plain">${items.map((t) => `<li>${starMark(t)}${esc(t.text)}${withDue && t.due ? ` <span class="muted">— ${esc(fmtDay(t.due))}</span>` : ''}</li>`).join('')}</ul>`;
  }

  // Full read-only picture of one day, used by History, the shared view and print.
  function dayHtml(entry, split) {
    if (isMarkerOnly(entry)) {
      return `
      <div class="day-meta">
        <span class="stat off">${esc(dayTypeLabel(entry.dayType))}</span>
        ${entry.pinned ? `<span class="stat pin-stat">${ic('pin')} Pinned</span>` : ''}
      </div>
      <section class="card"><p class="muted">Marked as ${esc(dayTypeLabel(entry.dayType).toLowerCase())}. No hours are expected and nothing was written for this day.</p></section>`;
    }
    const { total, done } = taskStats(entry);
    const tasks = `
      <section class="card">
        <h3>Tasks for the day</h3>
        ${staticTasksHtml(entry.tasks)}
      </section>`;
    const side = dayDetailsHtml(entry);
    return `
      <div class="day-meta">
        ${total ? `<span class="stat">${done} of ${total} tasks done</span>` : ''}
        ${moodHtml(entry.mood)}
        ${entry.pinned ? `<span class="stat pin-stat">${ic('pin')} Pinned</span>` : ''}
        ${entry.dayType ? `<span class="stat ${isOff(entry) ? 'off' : ''}">${esc(dayTypeLabel(entry.dayType))}</span>` : ''}
        ${minutesWorked(entry) !== null ? `<span class="stat" title="${esc(hoursSummary(entry))}">${fmtDur(minutesWorked(entry))} worked</span>` : ''}
        ${overMin(entry) !== null && expectedMin(entry) ? `<span class="stat" title="Compared with your ${fmtDur(expectedMin(entry))} target">${fmtSigned(overMin(entry))}</span>` : ''}
        ${hoursSummary(entry) ? `<span class="stat subtle">${esc(hoursSummary(entry))}</span>` : ''}
        ${entry.closedAt ? '' : '<span class="stat open">Day not closed out</span>'}
      </div>
      ${split && side.trim() ? `<div class="cols"><div class="col-main">${tasks}</div><div class="col-side">${side}</div></div>` : tasks + side}`;
  }

  function dayDetailsHtml(entry) {
    return `
      ${(entry.log || []).length ? `
      <section class="card">
        <h3>Work log</h3>
        ${logListHtml(entry.log, false)}
      </section>` : ''}
      ${(entry.done || entry.blockers || entry.notes) ? `
      <section class="card">
        <h3>End-of-day stand-down</h3>
        ${textBlock('What got done', entry.done)}
        ${textBlock('Blockers / problems', entry.blockers)}
        ${textBlock('Notes to tomorrow-me', entry.notes)}
      </section>` : ''}
      ${entry.nextTasks.length ? `
      <section class="card">
        <h3>Tasks set for the next day</h3>
        ${plainListHtml(entry.nextTasks)}
      </section>` : ''}
      ${(entry.scheduled || []).length ? `
      <section class="card">
        <h3>Tasks set for a later date</h3>
        ${plainListHtml(entry.scheduled, true)}
      </section>` : ''}`;
  }

  function recapHtml(prev) {
    const { total, done } = taskStats(prev);
    const missed = prev.tasks.filter((t) => !t.done);
    const must = prev.tasks.filter((t) => t.priority);
    const empty = !prev.done && !prev.blockers && !total;
    return `
      <div class="day-meta">
        ${total ? `<span class="stat">${done} of ${total} tasks done</span>` : ''}
        ${moodHtml(prev.mood)}
      </div>
      ${empty ? '<p class="muted">Nothing was written down that day.</p>' : ''}
      ${must.length ? `<div class="block must"><h4>Must-do tasks</h4>${staticTasksHtml(must)}</div>` : ''}
      ${textBlock('What got done', prev.done)}
      ${textBlock('Blockers / problems', prev.blockers)}
      ${missed.length ? `<div class="block"><h4>Left unfinished</h4>${plainListHtml(missed)}</div>` : ''}`;
  }

  // ---------- weekly summary ----------

  function weekStats(start) {
    const end = shiftKey(start, 6);
    const days = entriesBetween(start, end);
    let set = 0; let done = 0; let moodSum = 0; let moodN = 0; let workMin = 0; let workDays = 0;
    const offDays = days.filter(isOff).length;
    const blockers = []; const stuck = new Map();
    for (const e of days) {
      const wm = minutesWorked(e);
      if (wm !== null) { workMin += wm; workDays += 1; }
      set += e.tasks.length;
      done += e.tasks.filter((t) => t.done).length;
      if (e.mood) { moodSum += e.mood; moodN += 1; }
      if (e.blockers && e.blockers.trim()) blockers.push({ date: e.date, text: e.blockers.trim() });
      for (const t of e.tasks) {
        const n = t.carriedCount || 0;
        if (n >= STALE_AFTER) {
          const k = norm(t.text);
          if (!stuck.has(k) || stuck.get(k).count < n) stuck.set(k, { text: t.text, count: n });
        }
      }
    }
    return {
      start, end, days: days.filter((e) => !isMarkerOnly(e)).length, set, done, mood: moodN ? moodSum / moodN : null,
      workMin, workDays, over: balance(start, end), offDays, blockers, stuck: [...stuck.values()],
    };
  }

  function weekCardHtml(w, title) {
    const pct = w.set ? Math.round((w.done / w.set) * 100) : null;
    return `
      <section class="card">
        <div class="card-head">
          <h3>${title}</h3>
          <span class="muted">${esc(fmtShort(w.start))} – ${esc(fmtShort(w.end))}</span>
        </div>
        <div class="tiles">
          <div class="tile"><span class="tile-v">${w.days}</span><span class="tile-l">day${w.days === 1 ? '' : 's'} recorded</span></div>
          <div class="tile"><span class="tile-v">${pct === null ? '—' : `${pct}%`}</span><span class="tile-l">${w.set ? `tasks done (${w.done} of ${w.set})` : 'no tasks set'}</span></div>
          <div class="tile"><span class="tile-v">${w.workDays ? fmtDur(w.workMin) : '—'}</span><span class="tile-l">${w.workDays ? `worked (avg ${fmtDur(Math.round(w.workMin / w.workDays))}/day)` : 'no hours logged'}</span></div>
          <div class="tile"><span class="tile-v">${fmtSigned(w.over)}</span><span class="tile-l">vs target${w.offDays ? ` · ${w.offDays} day${w.offDays === 1 ? '' : 's'} off` : ''}</span></div>
          <div class="tile"><span class="tile-v">${w.mood === null ? '—' : w.mood.toFixed(1)}</span><span class="tile-l">average mood</span></div>
        </div>
        ${w.blockers.length ? `<div class="block"><h4>Blockers</h4><ul class="plain">${w.blockers.slice(-5).map((b) => `
          <li><b>${esc(fmtDate(b.date, { weekday: 'short' }))}:</b> ${esc(b.text.length > 140 ? `${b.text.slice(0, 140)}…` : b.text)}</li>`).join('')}</ul></div>` : ''}
        ${w.stuck.length ? `<div class="block"><h4>Kept getting carried over</h4><ul class="plain">${w.stuck.map((s) => `
          <li>${esc(s.text)} <span class="muted">— ${s.count} days</span></li>`).join('')}</ul></div>` : ''}
      </section>`;
  }

  // ---------- task lists you can edit ----------

  function taskListHtml(list, items, checkable) {
    if (!items.length) return '';
    return `<ul class="tasks" data-list="${list}">${items.map((t, i) => taskRowHtml(list, t, i, items.length, checkable)).join('')}</ul>`;
  }

  function taskRowHtml(list, t, i, n, checkable) {
    const m = state.menu && state.menu.list === list && state.menu.id === t.id ? state.menu : null;
    const editing = m && m.mode === 'edit';
    const main = editing
      ? `<input type="text" class="edit-input" data-focus="edit" data-enter="edit-save" data-escape="menu-close" value="${esc(t.text)}" aria-label="Edit task" maxlength="300">`
      : checkable
        ? `<label class="check"><input type="checkbox" data-action="task-toggle" data-id="${t.id}" ${t.done ? 'checked' : ''}>
            <span class="txt-wrap"><span class="txt">${esc(t.text)}</span>${carriedTag(t)}</span></label>`
        : `<span class="txt-wrap"><span class="txt">${esc(t.text)}</span>${carriedTag(t)}</span>`;
    const ids = `data-list="${list}" data-id="${t.id}"`;
    return `
      <li data-id="${t.id}" class="${t.done ? 'done' : ''} ${t.priority ? 'prio' : ''} ${m ? 'open' : ''}">
        <span class="handle" aria-hidden="true" title="Drag to reorder">${ic('grip')}</span>
        ${main}
        <button class="icon star ${t.priority ? 'on' : ''}" data-action="star" ${ids} aria-pressed="${!!t.priority}"
          aria-label="Must do: ${esc(t.text)}" title="Must do">${starIcon(t.priority)}</button>
        <button class="icon" data-action="menu" ${ids} aria-expanded="${!!m}" aria-label="More options for: ${esc(t.text)}">${ic('more')}</button>
      </li>
      ${m ? `<li class="task-menu">${menuHtml(list, t, i, n, m)}</li>` : ''}`;
  }

  function menuHtml(list, t, i, n, m) {
    const ids = `data-list="${list}" data-id="${t.id}"`;
    if (m.mode === 'edit') {
      return `<button class="btn small primary" data-action="edit-save" ${ids}>Save</button>
        <button class="btn small" data-action="menu-close">Cancel</button>`;
    }
    if (m.mode === 'later') {
      return `<label class="inline-field">Move to
          <input type="date" id="later-date" data-focus="later-date" data-enter="later-save" min="${shiftKey(todayKey(), 1)}" value="${shiftKey(todayKey(), list === 'next' ? 2 : 1)}"></label>
        <button class="btn small primary" data-action="later-save" ${ids}>Move</button>
        <button class="btn small" data-action="menu-close">Cancel</button>
        ${m.error ? `<span class="msg err small">${esc(m.error)}</span>` : ''}`;
    }
    return `
      <button class="btn small" data-action="move" data-dir="-1" ${ids} ${i === 0 ? 'disabled' : ''}>Move up</button>
      <button class="btn small" data-action="move" data-dir="1" ${ids} ${i === n - 1 ? 'disabled' : ''}>Move down</button>
      <button class="btn small" data-action="edit" ${ids}>Edit</button>
      <button class="btn small" data-action="later" ${ids}>Move to a later date</button>
      <button class="btn small danger" data-action="delete" ${ids} aria-label="Delete task: ${esc(t.text)}">Delete</button>`;
  }

  // ---------- Today: morning check-in ----------

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  // The check-in only remembers what you changed (tasks added, removed,
  // starred or unticked). The lists themselves are rebuilt from the latest copy
  // of the previous day every time, so entries that arrive late still show up.
  function checkinLists(today, prev) {
    if (!state.checkin || state.checkin.date !== today) {
      state.checkin = { date: today, extra: [], removed: [], carryOff: [], prio: {} };
    }
    const c = state.checkin;
    const fromPlan = prev ? prev.nextTasks.map((t, i) => ({
      key: `p:${t.id || i}`, text: t.text, priority: !!t.priority, carriedCount: t.carriedCount || 0, src: 'plan',
    })) : [];
    const fromLater = dueLater(today).map((s) => ({
      key: `s:${s.id}`, text: s.text, priority: !!s.priority, carriedCount: s.carriedCount || 0, src: 'later', due: s.due, sid: s.id,
    }));
    const extras = c.extra.map((x, i) => ({ key: `x:${i}`, text: x.text, priority: false, src: 'extra' }));
    const planned = prioFirst([...fromPlan, ...fromLater, ...extras]
      .filter((t) => !c.removed.includes(t.key))
      .map((t) => (t.key in c.prio ? { ...t, priority: c.prio[t.key] } : t)));
    const plannedNorms = new Set([...fromPlan, ...fromLater, ...extras].map((t) => norm(t.text)));
    const carry = prev ? prev.tasks
      .filter((t) => !t.done && !plannedNorms.has(norm(t.text)))
      .map((t, i) => {
        const key = t.id || `c:${i}`;
        return {
          key, text: t.text, on: !c.carryOff.includes(key),
          priority: key in c.prio ? c.prio[key] : !!t.priority,
          carriedCount: (t.carriedCount || (t.carried ? 1 : 0)) + 1,
        };
      }) : [];
    const removedText = fromPlan.filter((t) => c.removed.includes(t.key)).map((t) => t.text);
    return { planned, carry, removedText, laterIds: fromLater.map((t) => t.sid) };
  }

  function checkinRowHtml(t, extraTag) {
    return `
      <li class="${t.priority ? 'prio' : ''}">
        <span class="txt-wrap"><span class="txt">${esc(t.text)}</span>${extraTag || ''}</span>
        <button class="icon star ${t.priority ? 'on' : ''}" data-action="checkin-star" data-key="${esc(t.key)}"
          aria-pressed="${!!t.priority}" aria-label="Must do: ${esc(t.text)}" title="Must do">${starIcon(t.priority)}</button>
        <button class="icon" data-action="checkin-remove" data-key="${esc(t.key)}" aria-label="Remove task: ${esc(t.text)}">${ic('x')}</button>
      </li>`;
  }

  function checkinHtml(today, prev) {
    const c = checkinLists(today, prev);
    const showWeek = prev && weekStart(prev.date) < weekStart(today);
    const lastWeek = showWeek ? weekStats(shiftKey(weekStart(today), -7)) : null;
    return `
      <div class="hero">
        <p class="eyebrow">${esc(fmtDate(today))}</p>
        <h2>${greeting()}. Here's your handover.</h2>
      </div>
      <div class="cols side-first">
      <div class="col-side">
      ${prev ? `
      <section class="card">
        <h3>Recap of ${esc(relDay(prev.date))}</h3>
        ${recapHtml(prev)}
      </section>` : `
      <section class="card">
        <h3>Welcome</h3>
        <p>This is your first day, so there's nothing to recap yet. Add what you want to get done today,
        then come back this evening to stand down and set tomorrow's tasks.</p>
      </section>`}
      ${lastWeek && lastWeek.days ? weekCardHtml(lastWeek, 'Last week at a glance') : ''}
      ${waitingHtml(false)}
      </div>
      <div class="col-main">
      <section class="card">
        <h3>Your tasks for today</h3>
        ${c.planned.length ? `<ul class="tasks">${c.planned.map((t) => checkinRowHtml(t,
          t.src === 'later' ? `<span class="tag">${t.due < today ? `was set for ${esc(fmtShort(t.due))}` : 'set for today'}</span>`
            : t.carriedCount ? carriedTag(t) : '')).join('')}</ul>`
          : `<p class="muted">${prev ? 'You didn\'t set any tasks for today.' : 'No tasks yet.'}</p>`}
        <p class="muted small">Star a task to mark it as must-do; must-do tasks go to the top.</p>
        <div class="add-row">
          <input type="text" data-focus="checkin-add" data-enter="checkin-add" placeholder="Add a task for today" aria-label="Add a task for today" maxlength="300">
          <button class="btn" data-action="checkin-add">Add</button>
        </div>
      </section>
      ${c.carry.length ? `
      <section class="card">
        <h3>Unfinished from ${esc(relDay(prev.date))}</h3>
        <p class="muted">Tick the ones to bring into today. Unticked ones stay behind in that day's record.</p>
        <ul class="tasks">${c.carry.map((t) => `
          <li><label class="check"><input type="checkbox" data-action="checkin-carry" data-key="${esc(t.key)}" ${t.on ? 'checked' : ''}>
            <span class="txt-wrap"><span class="txt">${esc(t.text)}</span>${t.carriedCount - 1 >= 1 ? carriedTag({ carriedCount: t.carriedCount - 1 }) : ''}</span></label>
          </li>`).join('')}</ul>
      </section>` : ''}
      ${getMeta().inbox.length ? `
      <section class="card">
        <h3>From your inbox</h3>
        <p class="muted">Tick any you want to do today. The rest stay in the inbox.</p>
        <ul class="tasks">${getMeta().inbox.map((t) => `
          <li><label class="check"><input type="checkbox" data-action="checkin-inbox" data-id="${t.id}" ${(state.checkin.inboxOn || []).includes(t.id) ? 'checked' : ''}>
            <span class="txt-wrap"><span class="txt">${esc(t.text)}</span></span></label></li>`).join('')}</ul>
      </section>` : ''}
      <button class="btn primary big" data-action="checkin-start">Start my day</button>
      <p class="muted small center">Your start time is set when you start your day; you can change it on Today.</p>
      </div>
      </div>`;
  }

  // ---------- Today: during the day ----------

  // Tasks set for today (last night, or earlier for a later date) that are not
  // on today's list and were not deliberately dropped. Shown with a one-tap fix.
  function missingPlanned(entry, prev) {
    const have = new Set(entry.tasks.map((t) => norm(t.text)));
    const skipped = new Set((entry.skippedPlanned || []).map(norm));
    const plan = (prev ? prev.nextTasks : [])
      .filter((t) => !have.has(norm(t.text)) && !skipped.has(norm(t.text)))
      .map((t) => ({ text: t.text, priority: !!t.priority, carriedCount: t.carriedCount || 0 }));
    const later = dueLater(entry.date)
      .filter((s) => !have.has(norm(s.text)))
      .map((s) => ({ text: s.text, priority: !!s.priority, carriedCount: s.carriedCount || 0, sid: s.id }));
    return [...plan, ...later];
  }

  function missingPlannedHtml(entry, prev) {
    const missing = missingPlanned(entry, prev);
    if (!missing.length) return '';
    return `
      <section class="card notice-card" role="status">
        <h3>${missing.length === 1 ? '1 task' : `${missing.length} tasks`} you set for today ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} on your list</h3>
        ${plainListHtml(missing)}
        <div class="row">
          <button class="btn primary" data-action="planned-add">Add ${missing.length === 1 ? 'it' : 'them'}</button>
          <button class="btn" data-action="planned-dismiss">Dismiss</button>
        </div>
      </section>`;
  }

  function staleTasks(entry) {
    return entry.tasks.filter((t) => !t.done && (t.carriedCount || 0) >= STALE_AFTER && !t.staleOk);
  }

  function staleHtml(entry) {
    const stale = staleTasks(entry);
    if (!stale.length) return '';
    return `
      <section class="card notice-card">
        <h3>${stale.length === 1 ? 'This task keeps' : 'These tasks keep'} getting carried over</h3>
        <ul class="stale">${stale.map((t) => `
          <li>
            <p><b>${esc(t.text)}</b> <span class="muted">— carried over ${t.carriedCount} days in a row</span></p>
            ${state.staleLater === t.id ? `
            <div class="row">
              <label class="inline-field">Move to
                <input type="date" id="stale-date" data-focus="stale-date" min="${shiftKey(todayKey(), 1)}" value="${shiftKey(todayKey(), 7)}"></label>
              <button class="btn small primary" data-action="stale-later-save" data-id="${t.id}">Move</button>
              <button class="btn small" data-action="stale-later-cancel">Cancel</button>
            </div>` : `
            <div class="row">
              <button class="btn small primary" data-action="stale-do" data-id="${t.id}">Do it today</button>
              <button class="btn small" data-action="stale-later" data-id="${t.id}">Move to later</button>
              <button class="btn small danger" data-action="stale-drop" data-id="${t.id}">Drop it</button>
            </div>`}
          </li>`).join('')}</ul>
      </section>`;
  }

  function todayTasksHtml(entry) {
    const { total, done } = taskStats(entry);
    return `
      <section class="card">
        <div class="card-head">
          <h3>Today's tasks</h3>
          ${total ? `<span class="stat">${done} of ${total} done</span>` : ''}
        </div>
        ${total ? taskListHtml('today', entry.tasks, true) : '<p class="muted">No tasks for today yet.</p>'}
        <div class="add-row">
          <input type="text" data-focus="task-add" data-enter="task-add" placeholder="Add a task" aria-label="Add a task" maxlength="300">
          <button class="btn" data-action="task-add">Add</button>
        </div>
      </section>`;
  }

  function comingUpHtml() {
    const today = todayKey();
    const items = upcomingLater(today);
    return `
      <details class="card" ${state.comingUpOpen ? 'open' : ''} data-details="comingUpOpen">
        <summary>Coming up${items.length ? ` <span class="stat">${items.length}</span>` : ''}</summary>
        <p class="muted">Tasks for a specific date. Each one appears in that day's morning check-in.</p>
        ${items.length ? `<ul class="tasks">${items.map((s) => `
          <li>
            <span class="txt-wrap"><span class="txt">${starMark(s)}${esc(s.text)}</span><span class="tag">${esc(fmtDay(s.due))}</span></span>
            <button class="icon" data-action="later-remove" data-from="${s.from}" data-id="${s.id}" aria-label="Delete task: ${esc(s.text)}">${ic('x')}</button>
          </li>`).join('')}</ul>` : ''}
        <div class="add-row wrap">
          <input type="text" data-focus="later-add" data-enter="later-add" placeholder="Task for a later date" aria-label="Task for a later date" maxlength="300">
          <input type="date" id="later-add-date" aria-label="Date for the task" min="${shiftKey(today, 1)}" value="${shiftKey(today, 7)}">
          <button class="btn" data-action="later-add">Add</button>
        </div>
      </details>`;
  }

  function standdownFormHtml(entry) {
    const ticked = entry.tasks.filter((t) => t.done && !norm(entry.done).includes(norm(t.text)));
    const nextNorms = new Set(entry.nextTasks.map((t) => norm(t.text)));
    const unfinished = entry.tasks.filter((t) => !t.done && !nextNorms.has(norm(t.text)));
    return `
      <section class="card">
        <h3>Evening stand-down</h3>
        <p class="muted">Fill this in whenever you like during the day. It saves as you type.</p>
        <div class="field">
          <div class="field-head"><label for="f-done">What I got done</label>
            ${ticked.length ? `<button class="btn small" data-action="fill-done">Add ticked tasks (${ticked.length})</button>` : ''}</div>
          <textarea id="f-done" data-field="done" rows="4" placeholder="Progress, wins, things finished">${esc(entry.done)}</textarea>
        </div>
        <label class="field"><span>Blockers / problems</span>
          <textarea data-field="blockers" rows="3" placeholder="What got in the way or still needs solving">${esc(entry.blockers)}</textarea></label>
        <div class="field"><span id="mood-label">Mood / energy</span>
          <div class="moods" role="group" aria-labelledby="mood-label">
            ${[1, 2, 3, 4, 5].map((n) => `
              <button class="mood m${n} ${entry.mood === n ? 'on' : ''}" data-action="mood" data-n="${n}"
                aria-pressed="${entry.mood === n}"><b>${n}</b><small>${MOODS[n]}</small></button>`).join('')}
          </div>
        </div>
        <div class="field">
          <div class="field-head"><span>Tasks for tomorrow</span>
            ${unfinished.length ? `<button class="btn small" data-action="carry-unfinished">Add today's unfinished (${unfinished.length})</button>` : ''}</div>
          ${taskListHtml('next', entry.nextTasks, false)}
          <div class="add-row">
            <input type="text" data-focus="next-add" data-enter="next-add" placeholder="Add a task for tomorrow" aria-label="Add a task for tomorrow" maxlength="300">
            <button class="btn" data-action="next-add">Add</button>
          </div>
        </div>
        <button class="btn primary big" data-action="close-day">${entry.closedAt ? 'Save changes' : 'Stand down for the day'}</button>
      </section>`;
  }

  function workCardHtml(entry) {
    const w = entry.work || {};
    const so = minutesSoFar(entry);
    return `
      <section class="card work-card" aria-labelledby="work-h">
        <div class="card-head">
          <h3 id="work-h">Work hours</h3>
          <span class="work-total" id="work-total">${workTotalText(entry, so)}</span>
        </div>
        <div class="work-grid">
          <label class="field"><span>Started</span>
            <span class="time-row"><input type="time" data-work="start" value="${esc(w.start || '')}">
            <button class="btn small" data-action="work-now" data-which="start">Now</button></span></label>
          <label class="field"><span>Finished</span>
            <span class="time-row"><input type="time" data-work="end" value="${esc(w.end || '')}">
            <button class="btn small" data-action="work-now" data-which="end">Now</button></span></label>
          <label class="field"><span>Break (minutes)</span>
            <input type="number" data-work="breakMin" min="0" max="600" step="5" inputmode="numeric" value="${Number(w.breakMin) || 0}"></label>
        </div>
        <div class="work-foot">
          <label class="inline-field">Day type ${dayTypeSelectHtml(entry.date, entry.dayType)}</label>
          <span class="muted small" id="work-target">${targetText(entry)}</span>
        </div>
      </section>`;
  }

  // "1h 25m to go of 8h" / "+35m vs 8h target" / week balance.
  function targetText(entry) {
    const parts = [];
    const exp = expectedMin(entry);
    const so = minutesSoFar(entry);
    if (isOff(entry)) parts.push(`${dayTypeLabel(entry.dayType)}: no hours expected`);
    else if (!exp) parts.push('Not a normal working day: all hours count as extra');
    else if (so && so.live && so.min < exp) parts.push(`${fmtDur(exp - so.min)} to go of ${fmtDur(exp)}`);
    else if (so) parts.push(`${fmtSigned(so.min - exp)} vs ${fmtDur(exp)} target`);
    else parts.push(`Target ${fmtDur(exp)}`);
    const wk = balance(weekStart(entry.date), entry.date);
    if (wk !== null) parts.push(`week ${fmtSigned(wk)}`);
    return esc(parts.join(' · '));
  }

  // ---------- inbox, waiting on, work log ----------

  function inboxHtml() {
    const items = getMeta().inbox;
    return `
      <section class="card" aria-labelledby="inbox-h">
        <div class="card-head"><h3 id="inbox-h">Inbox</h3>${items.length ? `<span class="stat">${items.length}</span>` : ''}</div>
        <p class="muted small">Jot tasks down without deciding when. Move them to today here, or pick them at tomorrow's check-in.</p>
        ${items.length ? `<ul class="tasks">${items.map((t) => `
          <li><span class="txt-wrap"><span class="txt">${esc(t.text)}</span></span>
            <button class="btn small" data-action="inbox-today" data-id="${t.id}">To today</button>
            <button class="icon" data-action="inbox-remove" data-id="${t.id}" aria-label="Delete from inbox: ${esc(t.text)}">${ic('x')}</button></li>`).join('')}</ul>` : ''}
        <div class="add-row">
          <input type="text" data-focus="inbox-add" data-enter="inbox-add" placeholder="Add to inbox" aria-label="Add to inbox" maxlength="300">
          <button class="btn" data-action="inbox-add">Add</button>
        </div>
      </section>`;
  }

  function waitingAge(since) {
    const d = daysBetween(since, todayKey());
    return d <= 0 ? 'since today' : `${d} day${d === 1 ? '' : 's'}`;
  }

  function waitingHtml(withAdd) {
    const items = getMeta().waiting.filter((w) => !w.done);
    if (!withAdd && !items.length) return '';
    return `
      <section class="card" aria-labelledby="waiting-h">
        <div class="card-head"><h3 id="waiting-h">${withAdd ? 'Waiting on' : 'Still waiting on'}</h3>${items.length ? `<span class="stat">${items.length}</span>` : ''}</div>
        ${items.length ? `<ul class="tasks">${items.map((w) => {
          const age = daysBetween(w.since, todayKey());
          return `
          <li><span class="txt-wrap"><span class="txt">${esc(w.what)}</span>
              ${w.who ? `<span class="tag">${esc(w.who)}</span>` : ''}
              <span class="tag ${age >= 5 ? 'warn' : ''}" title="Since ${esc(fmtDay(w.since))}">${waitingAge(w.since)}</span></span>
            <button class="btn small" data-action="waiting-done" data-id="${w.id}">Received</button>
            ${withAdd ? `<button class="icon" data-action="waiting-remove" data-id="${w.id}" aria-label="Delete: ${esc(w.what)}">${ic('x')}</button>` : ''}</li>`;
        }).join('')}</ul>` : '<p class="muted small">Nothing outstanding. Add things you are waiting for from other people.</p>'}
        ${withAdd ? `
        <div class="add-row wrap waiting-add">
          <input type="text" data-focus="waiting-what" data-enter="waiting-add" placeholder="What are you waiting for?" aria-label="What are you waiting for?" maxlength="300">
          <input type="text" data-focus="waiting-who" data-enter="waiting-add" placeholder="From (optional)" aria-label="From whom" maxlength="120">
          <button class="btn" data-action="waiting-add">Add</button>
        </div>` : ''}
      </section>`;
  }

  function logListHtml(log, editable) {
    if (!log || !log.length) return '';
    const sorted = log.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return `<ul class="log">${sorted.map((l) => `
      <li><span class="log-time">${esc(fmtTime(l.at))}</span><span class="txt">${esc(l.text)}</span>
        ${editable ? `<button class="icon" data-action="log-remove" data-id="${l.id}" aria-label="Delete log entry: ${esc(l.text)}">${ic('x')}</button>` : ''}</li>`).join('')}</ul>`;
  }

  function logCardHtml(entry) {
    return `
      <section class="card" aria-labelledby="log-h">
        <div class="card-head"><h3 id="log-h">Work log</h3>${(entry.log || []).length ? `<span class="stat">${entry.log.length}</span>` : ''}</div>
        ${logListHtml(entry.log, true) || '<p class="muted small">Quick notes as the day goes: calls, decisions, who said what. The time is added for you.</p>'}
        <div class="add-row">
          <input type="text" data-focus="log-add" data-enter="log-add" placeholder="What happened?" aria-label="Add to work log" maxlength="500">
          <button class="btn" data-action="log-add">Log</button>
        </div>
      </section>`;
  }

  function workTotalText(entry, so) {
    if (!so) return '<span class="muted">Not started</span>';
    return `<b>${fmtDur(so.min)}</b> ${so.live ? 'so far' : 'worked'}`;
  }

  function pinButtonHtml(entry) {
    if (READONLY) return '';
    return `<button class="btn small ${entry.pinned ? 'on' : ''}" data-action="pin-day" data-day="${entry.date}" aria-pressed="${!!entry.pinned}"
      title="Pin this day so it's easy to find in History">${ic('pin')} ${entry.pinned ? 'Pinned' : 'Pin day'}</button>`;
  }

  function closedHtml(entry) {
    return `
      <section class="card closed">
        <div class="card-head">
          <h3>You've stood down for today</h3>
          ${moodHtml(entry.mood)}
        </div>
        ${minutesWorked(entry) !== null ? `<p class="muted">${fmtDur(minutesWorked(entry))} worked · ${esc(hoursSummary(entry))}</p>` : ''}
        ${textBlock('What got done', entry.done)}
        ${textBlock('Blockers / problems', entry.blockers)}
        <div class="block"><h4>Tasks for tomorrow</h4>
          ${entry.nextTasks.length ? plainListHtml(prioFirst(entry.nextTasks)) : '<p class="muted">None set.</p>'}
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
        <div class="hero-row"><h2>Today</h2>${pinButtonHtml(entry)}</div>
      </div>
      <div class="cols">
        <div class="col-main">
          ${workCardHtml(entry)}
          ${missingPlannedHtml(entry, prev)}
          ${staleHtml(entry)}
          ${todayTasksHtml(entry)}
          ${comingUpHtml()}
          ${inboxHtml()}
        </div>
        <div class="col-side">
          ${prev ? `<details class="card" data-details="recapOpen" ${(state.recapOpen ?? isDesktop()) ? 'open' : ''}><summary>Recap of ${esc(relDay(prev.date))}</summary>${recapHtml(prev)}</details>` : ''}
          ${waitingHtml(true)}
          ${logCardHtml(entry)}
          ${entry.closedAt && !state.editingClose ? closedHtml(entry) : standdownFormHtml(entry)}
        </div>
      </div>`;
  }

  // ---------- History ----------

  function matchesSearch(entry, q) {
    if (!q) return true;
    const hay = [entry.done, entry.blockers, entry.notes, fmtDate(entry.date),
      ...entry.tasks.map((t) => t.text), ...entry.nextTasks.map((t) => t.text),
      ...(entry.scheduled || []).map((t) => t.text), ...(entry.log || []).map((l) => l.text), dayTypeLabel(entry.dayType)].join('\n').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function historyListHtml() {
    const keys = sortedKeys().reverse()
      .filter((k) => matchesSearch(state.entries[k], state.search.trim()))
      .filter((k) => state.histFilter !== 'pinned' || state.entries[k].pinned);
    if (!keys.length) {
      return `<p class="muted pad">${state.histFilter === 'pinned' && !state.search.trim() ? 'No pinned days yet. Use "Pin day" on Today or on any day here.'
        : sortedKeys().length ? 'No days match that search.' : 'No days recorded yet.'}</p>`;
    }
    return `<ul class="days">${keys.map((k) => {
      const e = state.entries[k];
      const { total, done } = taskStats(e);
      const snippet = (e.done || e.notes || e.blockers || e.tasks.map((t) => t.text).join(', ') || (isOff(e) ? dayTypeLabel(e.dayType) : '')).trim();
      return `<li><button class="day-row ${k === activeHistoryDay() ? 'active' : ''}" data-action="open-day" data-day="${k}" ${k === activeHistoryDay() ? 'aria-current="true"' : ''}>
        <span class="day-date"><b>${e.pinned ? `<span class="pin-mark" title="Pinned">${ic('pin')}</span>` : ''}${esc(fmtDay(k))}</b>
          <small>${fromKey(k).getFullYear()}</small></span>
        <span class="day-snip">${esc(snippet.slice(0, 140)) || '<i>No notes</i>'}</span>
        <span class="day-side">${e.dayType ? `<span class="stat ${isOff(e) ? 'off' : ''}">${esc(dayTypeLabel(e.dayType))}</span>` : ''}
          ${minutesWorked(e) !== null ? `<span class="stat" title="Hours worked">${fmtDur(minutesWorked(e))}</span>` : ''}
          ${total ? `<span class="stat">${done}/${total}</span>` : ''}
          ${e.mood ? `<span class="mood-dot m${e.mood}" title="Mood ${e.mood}/5">${e.mood}</span>` : ''}</span>
      </button></li>`;
    }).join('')}</ul>`;
  }

  // Colour level 1-5 for the calendar (0 = nothing to colour by).
  function calLevel(e, by) {
    if (!e) return 0;
    if (by === 'mood') return e.mood || 0;
    const { total, done } = taskStats(e);
    if (!total) return 0;
    return Math.min(5, Math.floor((done / total) * 5) + 1);
  }

  const hasMoods = () => dayEntries().some((e) => e.mood);

  function calendarHtml() {
    const month = state.calMonth || todayKey().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    const by = state.calColor === 'mood' && !hasMoods() ? 'tasks' : state.calColor;
    const today = todayKey();
    const prevMonth = toKey(new Date(y, m - 2, 1)).slice(0, 7);
    const nextMonth = toKey(new Date(y, m, 1)).slice(0, 7);
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="cal-day blank" aria-hidden="true"></span>';
    for (let d = 1; d <= days; d++) {
      const key = `${month}-${pad(d)}`;
      const e = state.entries[key];
      const lv = calLevel(e, by);
      const cls = `cal-day ${isOff(e) ? 'off' : lv ? `lv${lv}` : e ? 'has-entry' : 'empty'} ${key === today ? 'is-today' : ''} ${key === activeHistoryDay() ? 'is-selected' : ''} ${e && e.pinned ? 'pinned' : ''} ${key === state.calPick ? 'is-picking' : ''}`;
      if (e && isMarkerOnly(e)) {
        const label = `${fmtDate(key, { weekday: 'long', month: 'long', day: 'numeric' })}, ${dayTypeLabel(e.dayType)}`;
        cells += READONLY ? `<span class="${cls}" title="${esc(label)}" aria-label="${esc(label)}">${d}</span>`
          : `<button class="${cls}" data-action="cal-pick" data-day="${key}" aria-label="${esc(label)}" title="${esc(label)}">${d}</button>`;
      } else if (e) {
        const { total, done } = taskStats(e);
        const label = [fmtDate(key, { weekday: 'long', month: 'long', day: 'numeric' }),
          e.mood ? `mood ${e.mood} of 5 (${MOODS[e.mood]})` : '', total ? `${done} of ${total} tasks done` : ''].filter(Boolean).join(', ');
        cells += `<button class="${cls}" data-action="open-day" data-day="${key}" aria-label="${esc(label)}" title="${esc(label)}">${d}</button>`;
      } else if (!READONLY) {
        cells += `<button class="${cls}" data-action="cal-pick" data-day="${key}" aria-label="${esc(fmtDate(key, { weekday: 'long', month: 'long', day: 'numeric' }))}: no entry" title="No entry. Click to mark as leave, sick or holiday">${d}</button>`;
      } else {
        cells += `<span class="${cls}">${d}</span>`;
      }
    }
    const legend = by === 'mood'
      ? [1, 2, 3, 4, 5].map((n) => [n, `${n} ${MOODS[n]}`])
      : [[1, '0–19%'], [2, '20–39%'], [3, '40–59%'], [4, '60–79%'], [5, '80–100%']];
    return `
      <section class="card">
        <div class="cal-head">
          <button class="icon" data-action="cal-month" data-month="${prevMonth}" aria-label="Previous month">${ic('chev-left')}</button>
          <h3>${esc(first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h3>
          <button class="icon" data-action="cal-month" data-month="${nextMonth}" aria-label="Next month">${ic('chev-right')}</button>
        </div>
        <div class="seg" role="group" aria-label="Colour days by">
          <button class="seg-btn ${by === 'mood' ? 'on' : ''}" data-action="cal-color" data-by="mood" aria-pressed="${by === 'mood'}" ${hasMoods() ? '' : 'disabled'}>Mood</button>
          <button class="seg-btn ${by === 'tasks' ? 'on' : ''}" data-action="cal-color" data-by="tasks" aria-pressed="${by === 'tasks'}">Tasks done</button>
        </div>
        <div class="cal-grid" role="grid">
          ${weekdays.map((w) => `<span class="cal-wd" aria-hidden="true">${w}</span>`).join('')}
          ${cells}
        </div>
        <div class="legend">
          ${legend.map(([lv, label]) => `<span class="legend-item"><span class="swatch lv${lv}"></span>${esc(label)}</span>`).join('')}
          <span class="legend-item"><span class="swatch has-entry"></span>Recorded, no ${by === 'mood' ? 'mood' : 'tasks'}</span>
          <span class="legend-item"><span class="swatch off"></span>Leave, sick or holiday</span>
        </div>
        ${!READONLY && state.calPick ? (() => {
          const e = state.entries[state.calPick];
          return `
        <div class="cal-pick" role="group" aria-label="Mark ${esc(fmtDay(state.calPick))}">
          <p><b>${esc(fmtDate(state.calPick, { weekday: 'long', month: 'long', day: 'numeric' }))}</b>
            ${e ? `is marked as ${esc(dayTypeLabel(e.dayType))}.` : 'has no entry.'} Mark it as:</p>
          <div class="row">
            ${OFF_TYPES.map((t) => `<button class="btn small ${e && e.dayType === t ? 'on' : ''}" data-action="mark-day" data-type="${t}">${dayTypeLabel(t)}</button>`).join('')}
            ${e ? '<button class="btn small" data-action="mark-day" data-type="">Clear</button>' : ''}
            <button class="btn small link" data-action="cal-pick" data-day="${state.calPick}">Cancel</button>
          </div>
        </div>`;
        })() : ''}
      </section>`;
  }

  function exportPanelHtml() {
    if (!state.exportOpen) return '';
    const today = todayKey();
    const r = state.exportRange || { from: shiftKey(today, -6), to: today };
    const count = entriesBetween(r.from, r.to).length;
    const allKeys = sortedKeys();
    const presets = [
      ...(activeHistoryDay() ? [['This day', activeHistoryDay(), activeHistoryDay()]] : []),
      ['Last 7 days', shiftKey(today, -6), today],
      ['This month', `${today.slice(0, 7)}-01`, today],
      ...(allKeys.length ? [['Everything', allKeys[0], allKeys[allKeys.length - 1]]] : []),
    ];
    return `
      <section class="card" aria-labelledby="export-h">
        <div class="card-head">
          <h3 id="export-h">Export</h3>
          <button class="icon" data-action="export-close" aria-label="Close export">${ic('x')}</button>
        </div>
        <div class="row">${presets.map(([label, from, to]) => `
          <button class="btn small ${r.from === from && r.to === to ? 'on' : ''}" data-action="export-preset" data-from="${from}" data-to="${to}">${label}</button>`).join('')}
        </div>
        <div class="row dates">
          <label class="field"><span>From</span><input type="date" id="ex-from" value="${r.from}"></label>
          <label class="field"><span>To</span><input type="date" id="ex-to" value="${r.to}"></label>
        </div>
        <p class="muted">${count} day${count === 1 ? '' : 's'} with entries in this range.</p>
        <div class="row">
          <button class="btn primary" data-action="export-pdf" ${count ? '' : 'disabled'}>Print or save as PDF</button>
          <button class="btn" data-action="export-txt" ${count ? '' : 'disabled'}>${ic('download')} Download text file</button>
          <button class="btn" data-action="export-csv">${ic('download')} Timesheet (CSV)</button>
        </div>
      </section>`;
  }

  // Latest day with something in it (skips days only marked as leave etc.).
  function latestRealDay() {
    const keys = sortedKeys().filter((k) => !isMarkerOnly(state.entries[k]));
    return keys[keys.length - 1] || null;
  }

  // The day shown in History: the one picked, or on desktop the latest day.
  function activeHistoryDay() {
    if (state.historyDay && state.entries[state.historyDay]) return state.historyDay;
    if (!isDesktop()) return null;
    return latestRealDay();
  }

  function historyDayHtml(day, withBack) {
    const keys = sortedKeys();
    const i = keys.indexOf(day);
    const older = keys[i - 1]; const newer = keys[i + 1];
    return `
      <div class="day-nav">
        ${withBack ? `<button class="btn" data-action="open-day" data-day="">${ic('back')} All days</button>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-action="open-day" data-day="${older || ''}" ${older ? '' : 'disabled'} aria-label="Older day" title="Older day (←)">${ic('chev-left')} Older</button>
        <button class="btn" data-action="open-day" data-day="${newer || ''}" ${newer ? '' : 'disabled'} aria-label="Newer day" title="Newer day (→)">Newer ${ic('chev-right')}</button>
      </div>
      <div class="hero hero-row"><h2>${esc(fmtDate(day))}</h2>
        <div class="row">
          ${READONLY ? '' : `${pinButtonHtml(state.entries[day])}
          <label class="inline-field sr-label"><span class="sr">Day type</span>${dayTypeSelectHtml(day, state.entries[day].dayType)}</label>`}
          <button class="btn small" data-action="export-open" data-day="${day}">Export</button>
        </div></div>
      ${withBack ? exportPanelHtml() : ''}
      ${dayHtml(state.entries[day])}`;
  }

  function historyHtml() {
    const desk = isDesktop();
    if (!desk && state.historyDay && state.entries[state.historyDay]) return historyDayHtml(state.historyDay, true);
    const listPane = `
      <div class="hero hero-row"><h2>History</h2>
        <button class="btn small" data-action="export-open">Export</button></div>
      ${exportPanelHtml()}
      <div class="seg" role="group" aria-label="History view">
        <button class="seg-btn ${state.histView === 'list' ? 'on' : ''}" data-action="hist-view" data-view="list" aria-pressed="${state.histView === 'list'}">List</button>
        <button class="seg-btn ${state.histView === 'calendar' ? 'on' : ''}" data-action="hist-view" data-view="calendar" aria-pressed="${state.histView === 'calendar'}">Calendar</button>
      </div>
      ${state.histView === 'calendar' ? calendarHtml() : `
      <div class="search-row">
        <input type="search" class="search" data-search placeholder="Search past days" aria-label="Search past days" value="${esc(state.search)}">
        <div class="seg" role="group" aria-label="Show">
          <button class="seg-btn ${state.histFilter !== 'pinned' ? 'on' : ''}" data-action="hist-filter" data-filter="all" aria-pressed="${state.histFilter !== 'pinned'}">All</button>
          <button class="seg-btn ${state.histFilter === 'pinned' ? 'on' : ''}" data-action="hist-filter" data-filter="pinned" aria-pressed="${state.histFilter === 'pinned'}">${ic('pin')} Pinned</button>
        </div>
      </div>
      <div id="history-list">${historyListHtml()}</div>`}`;
    if (!desk) return listPane;
    const day = activeHistoryDay();
    return `
      <div class="cols history-cols">
        <div class="col-main history-list-pane">${listPane}</div>
        <div class="col-side history-day-pane">${day ? historyDayHtml(day, false)
          : '<section class="card"><p class="muted">No days recorded yet. Your stand-downs will appear here.</p></section>'}</div>
      </div>`;
  }

  // ---------- Trends ----------

  function niceMax(v) {
    if (v <= 4) return Math.max(1, v);
    for (const s of [1, 2, 5, 10, 20, 50]) if (v <= s * 5) return Math.ceil(v / s) * s;
    return v;
  }

  const tickStep = (max) => (max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10);

  function xAxisLabels(days, x, y) {
    const n = days.length;
    const idx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
    return idx.map((i, j) => `<text x="${x(i).toFixed(1)}" y="${y}" class="ax"
      text-anchor="${n <= 1 ? 'middle' : j === 0 ? 'start' : j === idx.length - 1 ? 'end' : 'middle'}">${esc(fmtShort(days[i].key))}</text>`).join('');
  }

  function hitColumns(days, m, step, ih) {
    return days.map((d, i) => `<rect class="hit" data-tip="${i}" x="${(m.l + step * i).toFixed(1)}" y="${m.t}" width="${step.toFixed(2)}" height="${ih}"/>`).join('');
  }

  function moodChart(days, W) {
    if (!days.some((d) => d.entry && d.entry.mood)) return '<p class="muted">No mood ratings in this period.</p>';
    const H = 180; const m = { l: 64, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b; const step = iw / days.length;
    const x = (i) => m.l + step * (i + 0.5);
    const y = (v) => m.t + ((5 - v) / 4) * ih;
    const has = (i) => !!(days[i] && days[i].entry && days[i].entry.mood);
    let grid = '';
    for (const v of [1, 2, 3, 4, 5]) grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    const yLabels = [5, 3, 1].map((v) => `<text class="ax" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v} ${MOODS[v]}</text>`).join('');
    let path = '';
    days.forEach((d, i) => {
      if (has(i)) path += `${has(i - 1) ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.entry.mood).toFixed(1)}`;
    });
    const dots = days.map((d, i) => (has(i) && (days.length <= 31 || (!has(i - 1) && !has(i + 1)))
      ? `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.entry.mood).toFixed(1)}" r="4"/>` : '')).join('');
    return `
      <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Line chart of mood and energy over the last ${days.length} days. The table below has the values.">
        ${grid}${yLabels}
        <line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
        <path class="line" d="${path}"/>
        ${dots}
        ${xAxisLabels(days, x, H - 6)}
        ${hitColumns(days, m, step, ih)}
      </svg>`;
  }

  function roundedTop(x, y, w, h, r) {
    if (h <= 0) return '';
    const rr = Math.min(r, h, w / 2);
    return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + rr).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + rr).toFixed(1)},${y.toFixed(1)}`
      + `H${(x + w - rr).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + rr).toFixed(1)}V${(y + h).toFixed(1)}Z`;
  }

  function hoursChart(days, W) {
    const vals = days.map((d) => (d.entry ? minutesWorked(d.entry) : null));
    const targetMin = Number(getMeta().settings.targetMin) || 0;
    const loggedMax = Math.max(0, ...vals.map((v) => v || 0));
    const maxMin = Math.max(loggedMax, targetMin);
    if (!loggedMax) return '<p class="muted">No work hours logged in this period. Fill in Started and Finished on Today.</p>';
    const H = 170; const m = { l: 40, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b; const step = iw / days.length;
    const top = niceMax(Math.ceil(maxMin / 60)); const st = tickStep(top);
    const x = (i) => m.l + step * (i + 0.5);
    const y = (h) => m.t + (1 - h / top) * ih;
    let grid = '';
    for (let v = 0; v <= top; v += st) {
      grid += `<line class="grid ${v === 0 ? 'base' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text class="ax" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}h</text>`;
    }
    const bw = Math.max(2, Math.min(18, step * 0.7));
    const bars = vals.map((v, i) => (v ? `<path class="bar-done" d="${roundedTop(x(i) - bw / 2, y(v / 60), bw, y(0) - y(v / 60), 4)}"/>` : '')).join('');
    const tY = y(targetMin / 60);
    const target = targetMin ? `<line class="target" x1="${m.l}" x2="${W - m.r}" y1="${tY}" y2="${tY}"/>
      <text class="ax target-label" x="${m.l + 6}" y="${tY - 5}">target ${fmtDur(targetMin)}</text>` : '';
    return `
      <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Bar chart of hours worked per day over the last ${days.length} days. The table below has the values.">
        ${grid}
        <line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
        ${bars}
        ${target}
        ${xAxisLabels(days, x, H - 6)}
        ${hitColumns(days, m, step, ih)}
      </svg>`;
  }

  function balanceCardHtml(today) {
    const y = today.slice(0, 4);
    const rows = [
      ['This week', balance(weekStart(today), today)],
      ['This month', balance(`${today.slice(0, 7)}-01`, today)],
      ['This year', balance(`${y}-01-01`, today)],
    ];
    const st = getMeta().settings;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const wd = [1, 2, 3, 4, 5, 6, 0].filter((d) => st.workdays.includes(d)).map((d) => names[d]).join(', ') || 'no days';
    return `
      <section class="card" aria-labelledby="bal-h">
        <div class="card-head"><h3 id="bal-h">Overtime balance</h3>
          <span class="muted small">Target ${fmtDur(st.targetMin)} on ${esc(wd)}${READONLY ? '' : ' · change in Settings'}</span></div>
        <div class="tiles">${rows.map(([label, v]) => `
          <div class="tile"><span class="tile-v ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${fmtSigned(v)}</span><span class="tile-l">${label}</span></div>`).join('')}
        </div>
      </section>`;
  }

  // Year at a glance: one square per day, Monday-first weeks.
  function heatLevel(e, by) {
    if (!e) return 0;
    if (by === 'tasks') return calLevel(e, 'tasks');
    const m = minutesWorked(e);
    if (m === null) return 0;
    return m < 240 ? 1 : m < 360 ? 2 : m < 480 ? 3 : m < 600 ? 4 : 5;
  }

  function heatmapHtml() {
    const year = state.heatYear || Number((READONLY ? (sortedKeys().slice(-1)[0] || todayKey()) : todayKey()).slice(0, 4));
    const by = state.heatBy || 'hours';
    const jan1 = new Date(year, 0, 1);
    const start = shiftKey(toKey(jan1), -((jan1.getDay() + 6) % 7));
    const cell = 12; const gap = 3; const left = 30; const top = 18; const stepPx = cell + gap;
    let rects = ''; let months = ''; let lastMonth = -1;
    for (let col = 0; col < 54; col++) {
      for (let row = 0; row < 7; row++) {
        const k = shiftKey(start, col * 7 + row);
        if (Number(k.slice(0, 4)) !== year) continue;
        const e = state.entries[k];
        const mo = Number(k.slice(5, 7)) - 1;
        if (row === 0 && mo !== lastMonth) {
          months += `<text class="ax" x="${left + col * stepPx}" y="11">${new Date(year, mo, 1).toLocaleDateString(undefined, { month: 'short' })}</text>`;
          lastMonth = mo;
        }
        const lv = heatLevel(e, by);
        const cls = isOff(e) ? 'off' : lv ? `lv${lv}` : e && !isMarkerOnly(e) ? 'has' : 'none';
        const wm = minutesWorked(e);
        const st = e ? taskStats(e) : null;
        const tip = [fmtDate(k, { weekday: 'short', month: 'short', day: 'numeric' }),
          isOff(e) ? dayTypeLabel(e.dayType) : '',
          wm !== null ? `${fmtDur(wm)} worked` : '', st && st.total ? `${st.done} of ${st.total} tasks` : '',
          e && e.pinned ? 'pinned' : ''].filter(Boolean).join(' · ');
        rects += `<rect class="${cls} ${k === todayKey() ? 'today' : ''}" x="${left + col * stepPx}" y="${top + row * stepPx}" width="${cell}" height="${cell}" rx="2.5"
          ${e && !isMarkerOnly(e) ? `data-action="open-heat" data-day="${k}"` : ''}><title>${esc(tip)}</title></rect>`;
      }
    }
    const dayLabels = [['Mon', 0], ['Wed', 2], ['Fri', 4]].map(([t, r]) => `<text class="ax" x="0" y="${top + r * stepPx + 10}">${t}</text>`).join('');
    const W = left + 54 * stepPx; const H = top + 7 * stepPx;
    const legend = by === 'tasks'
      ? [[1, '0–19%'], [3, '40–59%'], [5, '80–100%']]
      : [[1, '<4h'], [2, '4–6h'], [3, '6–8h'], [4, '8–10h'], [5, '10h+']];
    return `
      <section class="card" aria-labelledby="heat-h">
        <div class="card-head">
          <h3 id="heat-h">Year at a glance</h3>
          <div class="row">
            <div class="seg" role="group" aria-label="Colour by">
              <button class="seg-btn ${by === 'hours' ? 'on' : ''}" data-action="heat-by" data-by="hours" aria-pressed="${by === 'hours'}">Hours</button>
              <button class="seg-btn ${by === 'tasks' ? 'on' : ''}" data-action="heat-by" data-by="tasks" aria-pressed="${by === 'tasks'}">Tasks done</button>
            </div>
            <button class="icon" data-action="heat-year" data-year="${year - 1}" aria-label="Previous year">${ic('chev-left')}</button>
            <b class="tabnum">${year}</b>
            <button class="icon" data-action="heat-year" data-year="${year + 1}" aria-label="Next year">${ic('chev-right')}</button>
          </div>
        </div>
        <div class="heat-wrap"><svg class="heat" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
          aria-label="Calendar heatmap of ${year}, coloured by ${by === 'hours' ? 'hours worked' : 'share of tasks done'}. Hover a square for details.">
          ${months}${dayLabels}${rects}</svg></div>
        <div class="legend">
          ${legend.map(([lv, label]) => `<span class="legend-item"><span class="swatch lv${lv}"></span>${label}</span>`).join('')}
          <span class="legend-item"><span class="swatch off"></span>Leave, sick or holiday</span>
          <span class="legend-item"><span class="swatch none"></span>No entry</span>
        </div>
      </section>`;
  }

  function reportsCardHtml() {
    const month = state.reportMonth || todayKey().slice(0, 7);
    return `
      <section class="card" aria-labelledby="rep-h">
        <h3 id="rep-h">Reports</h3>
        <p class="muted">A monthly summary to print or save as PDF, or a timesheet to open in Excel.</p>
        <div class="row">
          <label class="inline-field">Month <input type="month" id="report-month" value="${month}"></label>
          <button class="btn primary" data-action="report-print">Monthly report</button>
          <button class="btn" data-action="report-csv">${ic('download')} Timesheet (CSV)</button>
        </div>
      </section>`;
  }

  function tasksChart(days, W) {
    const maxSet = Math.max(0, ...days.map((d) => (d.entry ? d.entry.tasks.length : 0)));
    if (!maxSet) return '<p class="muted">No tasks in this period.</p>';
    const H = 180; const m = { l: 34, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b; const step = iw / days.length;
    const top = niceMax(maxSet); const st = tickStep(top);
    const x = (i) => m.l + step * (i + 0.5);
    const y = (v) => m.t + (1 - v / top) * ih;
    let grid = '';
    for (let v = 0; v <= top; v += st) {
      grid += `<line class="grid ${v === 0 ? 'base' : ''}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text class="ax" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    const bw = Math.max(2, Math.min(14, step * 0.7));
    let bars = '';
    days.forEach((d, i) => {
      if (!d.entry || !d.entry.tasks.length) return;
      const { total, done } = taskStats(d.entry);
      const bx = x(i) - bw / 2;
      const rest = total - done;
      if (done) {
        const h = y(0) - y(done);
        bars += rest ? `<rect class="bar-done" x="${bx.toFixed(1)}" y="${y(done).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`
          : `<path class="bar-done" d="${roundedTop(bx, y(done), bw, h, 4)}"/>`;
      }
      if (rest) {
        const bottom = done ? y(done) - 2 : y(0);
        bars += `<path class="bar-rest" d="${roundedTop(bx, y(total), bw, bottom - y(total), 4)}"/>`;
      }
    });
    return `
      <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Bar chart of tasks done and not done per day over the last ${days.length} days. The table below has the values.">
        ${grid}
        <line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
        ${bars}
        ${xAxisLabels(days, x, H - 6)}
        ${hitColumns(days, m, step, ih)}
      </svg>`;
  }

  function trendsHtml() {
    const today = READONLY ? (sortedKeys().slice(-1)[0] || todayKey()) : todayKey();
    const n = state.trendRange;
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const key = shiftKey(today, -i);
      days.push({ key, entry: state.entries[key] || null });
    }
    state.trendDays = days;
    const recorded = days.filter((d) => d.entry && !isMarkerOnly(d.entry));
    let set = 0; let done = 0; let moodSum = 0; let moodN = 0; let workMin = 0; let workDays = 0;
    for (const d of recorded) {
      const wm = minutesWorked(d.entry);
      if (wm !== null) { workMin += wm; workDays += 1; }
      set += d.entry.tasks.length;
      done += d.entry.tasks.filter((t) => t.done).length;
      if (d.entry.mood) { moodSum += d.entry.mood; moodN += 1; }
    }
    const W = chartWidth(isDesktop() ? 2 : 1);
    const thisWeek = weekStats(weekStart(today));
    const lastWeek = weekStats(shiftKey(weekStart(today), -7));
    return `
      <div class="hero hero-row"><h2>Trends</h2>
        <div class="seg" role="group" aria-label="Time range">
          ${[30, 90].map((r) => `<button class="seg-btn ${n === r ? 'on' : ''}" data-action="trend-range" data-range="${r}" aria-pressed="${n === r}">${r} days</button>`).join('')}
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><span class="tile-v">${recorded.length}</span><span class="tile-l">days recorded of ${n}</span></div>
        <div class="tile"><span class="tile-v">${set ? `${Math.round((done / set) * 100)}%` : '—'}</span><span class="tile-l">${set ? `tasks done (${done} of ${set})` : 'no tasks set'}</span></div>
        <div class="tile"><span class="tile-v">${workDays ? fmtDur(workMin) : '—'}</span><span class="tile-l">${workDays ? `worked (avg ${fmtDur(Math.round(workMin / workDays))}/day)` : 'no hours logged'}</span></div>
        <div class="tile"><span class="tile-v">${moodN ? (moodSum / moodN).toFixed(1) : '—'}</span><span class="tile-l">average mood</span></div>
      </div>
      ${balanceCardHtml(today)}
      <section class="card chart-card">
        <h3>Hours worked per day</h3>
        <div class="chart-wrap">${hoursChart(days, chartWidth(1))}<div class="tip" hidden></div></div>
      </section>
      <div class="grid-2">
      <section class="card chart-card">
        <h3>Mood / energy</h3>
        <div class="chart-wrap">${moodChart(days, W)}<div class="tip" hidden></div></div>
      </section>
      <section class="card chart-card">
        <h3>Tasks per day</h3>
        <div class="legend">
          <span class="legend-item"><span class="swatch bar-done"></span>Done</span>
          <span class="legend-item"><span class="swatch bar-rest"></span>Not done</span>
        </div>
        <div class="chart-wrap">${tasksChart(days, W)}<div class="tip" hidden></div></div>
      </section>
      </div>
      <div class="grid-2">
      ${thisWeek.days ? weekCardHtml(thisWeek, READONLY ? 'Latest week' : 'This week so far') : ''}
      ${lastWeek.days ? weekCardHtml(lastWeek, READONLY ? 'Week before' : 'Last week') : ''}
      </div>
      ${heatmapHtml()}
      ${READONLY ? '' : reportsCardHtml()}
      <details class="card">
        <summary>Show as a table</summary>
        ${recorded.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th scope="col">Day</th><th scope="col">Type</th><th scope="col">Hours</th><th scope="col">vs target</th><th scope="col">Mood</th><th scope="col">Tasks done</th></tr></thead>
          <tbody>${recorded.slice().reverse().map((d) => {
            const s = taskStats(d.entry);
            const wm = minutesWorked(d.entry);
            return `<tr><td>${esc(fmtDay(d.key))}</td><td>${esc(dayTypeLabel(d.entry.dayType) || '—')}</td><td>${wm === null ? '—' : fmtDur(wm)}</td><td>${expectedMin(d.entry) || wm ? fmtSigned(overMin(d.entry)) : '—'}</td><td>${d.entry.mood ? `${d.entry.mood} ${MOODS[d.entry.mood]}` : '—'}</td><td>${s.total ? `${s.done} of ${s.total}` : '—'}</td></tr>`;
          }).join('')}</tbody>
        </table></div>` : '<p class="muted">No days recorded in this period.</p>'}
      </details>`;
  }

  // Width available to a chart inside a card, with `per` cards side by side.
  function chartWidth(per) {
    const main = $app.querySelector('main');
    let w = Math.min(720, window.innerWidth) - 32;
    if (main) {
      const cs = getComputedStyle(main);
      w = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    }
    const gap = 16; const cardInset = 42;
    return Math.max(260, Math.floor((w - gap * (per - 1)) / per - cardInset));
  }

  function showTip(i, hovered) {
    const d = state.trendDays[i];
    if (!d) return;
    for (const svg of $app.querySelectorAll('svg.chart')) {
      const hit = svg.querySelector(`[data-tip="${i}"]`);
      const line = svg.querySelector('.xhair');
      if (!hit || !line) continue;
      const cx = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
      line.setAttribute('x1', cx); line.setAttribute('x2', cx); line.setAttribute('visibility', 'visible');
    }
    for (const tip of $app.querySelectorAll('.tip')) tip.hidden = true;
    const wrap = hovered.closest('.chart-wrap');
    const tip = wrap && wrap.querySelector('.tip');
    if (!tip) return;
    const e = d.entry;
    const s = e ? taskStats(e) : null;
    tip.innerHTML = `<b>${esc(fmtDay(d.key))}</b>${e ? `
      <span>Hours: ${minutesWorked(e) === null ? '—' : fmtDur(minutesWorked(e))}</span>
      <span>Mood: ${e.mood ? `${e.mood} ${MOODS[e.mood]}` : '—'}</span>
      <span>Tasks: ${s.total ? `${s.done} of ${s.total} done` : 'none'}</span>` : '<span>No entry</span>'}`;
    tip.hidden = false;
    const cx = Number(hovered.getAttribute('x')) + Number(hovered.getAttribute('width')) / 2;
    const max = wrap.clientWidth - tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(max, cx - tip.offsetWidth / 2))}px`;
  }

  function hideTips() {
    for (const tip of $app.querySelectorAll('.tip')) tip.hidden = true;
    for (const line of $app.querySelectorAll('.xhair')) line.setAttribute('visibility', 'hidden');
  }

  // ---------- read-only Latest, sign-in, settings ----------

  function latestHtml() {
    const c = state.cloud;
    if (!getConfig()) return '<section class="card"><h3>This link is incomplete</h3><p>Ask the owner to send the read-only link again.</p></section>';
    if (!c.readerLoaded) {
      if (c.status === 'error' || c.status === 'offline') {
        return `<section class="card"><h3>Could not load the entries</h3><p>${esc(c.status === 'offline' ? 'You are offline.' : c.error)}</p><button class="btn" data-action="reload">Try again</button></section>`;
      }
      return '<p class="muted pad">Loading…</p>';
    }
    const keys = sortedKeys();
    if (!keys.length) {
      return '<section class="card"><h3>Nothing to show</h3><p>There are no entries yet, or this read-only link has been turned off by its owner.</p></section>';
    }
    const k = latestRealDay() || keys[keys.length - 1];
    return `
      <div class="hero">
        <p class="eyebrow">Latest entry</p>
        <h2>${esc(fmtDate(k))}</h2>
        <p class="muted freshness-row"><span id="freshness">${c.readerUpdated ? `Updated ${esc(timeAgo(c.readerUpdated))}` : ''}</span>
          · ${c.status === 'offline' ? 'offline, showing the last copy' : 'refreshes automatically'}
          <button class="btn small" data-action="reload">Refresh now</button></p>
      </div>
      ${dayHtml(state.entries[k], true)}`;
  }

  function gateHtml() {
    const cfg = getConfig();
    const c = state.cloud;
    if (!c.ready) return '<p class="muted pad">Loading…</p>';
    return `
      <div class="hero"><h2>Sign in to continue</h2></div>
      <section class="card">
        <p>Your stand-downs are tied to your account, so you need to sign in before you can read or write them here.</p>
        ${c.message ? `<p class="msg" role="status">${esc(c.message)}</p>` : ''}
        ${c.status === 'error' && c.error ? `<p class="msg err" role="alert">${esc(c.error)}</p>` : ''}
        ${c.status === 'offline' ? '<p class="msg err" role="alert">You are offline. Connect to sign in.</p>' : ''}
        <label class="field"><span>Email</span><input type="email" id="auth-email" autocomplete="username"></label>
        <label class="field"><span>Password</span><input type="password" id="auth-pass" autocomplete="current-password" data-enter="sign-in"></label>
        <div class="row">
          <button class="btn primary" data-action="sign-in">Sign in</button>
          ${cfg.source === 'saved' ? '<button class="btn link" data-action="cfg-clear">Disconnect project</button>' : ''}
        </div>
      </section>`;
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
    } else {
      const opts = c.shareOpts || {};
      const hide = c.shareSchemaOld
        ? '<p class="muted small">To hide fields from the link, run the updated <code>supabase/schema.sql</code> in the Supabase SQL Editor, then reload this page.</p>'
        : `<fieldset class="hide-opts"><legend>Hide from the read-only link</legend>
            ${HIDE_FIELDS.map(([f, label]) => `<label class="check"><input type="checkbox" data-action="share-hide" data-opt="${f}" ${opts[f] ? 'checked' : ''}> ${label}</label>`).join('')}
            <p class="muted small">Hidden fields are removed by the database before they are sent, so people with the link can't see them at all.</p>
          </fieldset>`;
      const share = c.offline ? '<p class="muted">Connect to the internet to manage the read-only link.</p>'
        : c.share === undefined ? '<p class="muted">Checking…</p>'
        : c.share ? `
          <p>Anyone with this link can read your entries but cannot change anything.</p>
          <div class="add-row"><input type="text" id="share-url" readonly value="${esc(shareUrl())}" aria-label="Read-only link">
            <button class="btn primary" data-action="share-copy">Copy</button></div>
          ${hide}
          <div class="row">
            <button class="btn" data-action="share-new">Replace with a new link</button>
            <button class="btn danger" data-action="share-off">Turn off sharing</button>
          </div>`
          : `<p>Create a link that lets other devices and people read your entries without being able to change them.</p>
          <button class="btn primary" data-action="share-new">Create read-only link</button>`;
      sync = `
        <p>Signed in as <b>${esc(c.user.email)}</b>. ${c.offline ? 'You are offline; changes are saved on this device and will sync when you reconnect.' : 'Entries sync automatically.'}</p>
        <div class="row"><button class="btn" data-action="sign-out" ${c.offline ? 'disabled' : ''}>Sign out</button></div>
        <h4 class="sub">Read-only link</h4>
        ${share}`;
    }
    return `
      <div class="hero"><h2>Settings</h2></div>
      <div class="cols">
      <div class="col-main">
      <section class="card">
        <h3>Sync and sharing</h3>
        ${c.message ? `<p class="msg" role="status">${esc(c.message)}</p>` : ''}
        ${c.status === 'error' && c.error ? `<p class="msg err" role="alert">${esc(c.error)}</p>` : ''}
        ${sync}
      </section>
      <section class="card">
        <h3>Backup</h3>
        <p>Download every entry as a file, or load entries from a backup file. To export readable pages, use Export in History.</p>
        <div class="row">
          <button class="btn" data-action="export">Download backup</button>
          <label class="btn">Load backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>
        </div>
      </section>
      </div>
      <div class="col-side">
      ${READONLY ? '' : (() => {
        const st = getMeta().settings;
        const names = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
        return `
      <section class="card" aria-labelledby="hours-h">
        <h3 id="hours-h">Working hours</h3>
        <p class="muted">Used for "to go" on Today and for overtime in Trends, reports and timesheets.</p>
        <label class="field"><span>Target hours per day</span>
          <input type="number" id="set-target" min="0" max="24" step="0.25" value="${(st.targetMin / 60).toString()}" style="max-width:140px"></label>
        <fieldset class="hide-opts"><legend>Days you normally work</legend>
          <div class="row">${names.map(([d, n]) => `<label class="check day-check"><input type="checkbox" data-workday="${d}" ${st.workdays.includes(d) ? 'checked' : ''}> ${n}</label>`).join('')}</div>
        </fieldset>
        <div><button class="btn primary" data-action="save-target">Save working hours</button></div>
      </section>`;
      })()}
      <section class="card">
        <h3>Keyboard shortcuts</h3>
        <table class="shortcuts"><tbody>
          <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>Today, History, Trends, Settings</td></tr>
          <tr><td><kbd>N</kbd></td><td>Add a task (on Today)</td></tr>
          <tr><td><kbd>I</kbd></td><td>Add to the inbox</td></tr>
          <tr><td><kbd>L</kbd></td><td>Add to the work log</td></tr>
          <tr><td><kbd>/</kbd></td><td>Search History</td></tr>
          <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Older / newer day in History</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>Add what you typed</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Cancel editing a task</td></tr>
        </tbody></table>
      </section>
      </div>
      </div>`;
  }

  // Browser tab shows tasks left and hours so far, e.g. "3 left · 4h 12m".
  function updateTitle() {
    let t = 'Daily Stand-Down';
    if (!READONLY && !locked()) {
      const e = state.entries[todayKey()];
      if (e && e.checkedInAt) {
        const left = e.tasks.filter((x) => !x.done).length;
        const so = minutesSoFar(e);
        t = `${left ? `${left} left` : 'All done'}${so ? ` · ${fmtDur(so.min)}` : ''} — Stand-Down`;
      }
    }
    if (document.title !== t) document.title = t;
  }

  function render() {
    state.renderedDay = todayKey();
    updateTitle();
    const waiting = !READONLY && state.cloud.user && !state.cloud.pulled && state.tab === 'today';
    const body = locked() ? gateHtml()
      : waiting ? '<p class="muted pad">Loading your latest entries…</p>'
      : state.tab === 'today' ? todayHtml()
      : state.tab === 'latest' ? latestHtml()
      : state.tab === 'history' ? historyHtml()
      : state.tab === 'trends' ? trendsHtml()
      : settingsHtml();
    $app.innerHTML = `
      ${headerHtml()}
      <main>
        ${READONLY ? '<p class="banner">You are viewing a read-only copy. Nothing here can be changed.</p>' : ''}
        ${state.notice ? `<p class="banner warn" role="alert">${esc(state.notice)}</p>` : ''}
        ${body}
      </main>`;
    if (state.focus) {
      const el = $app.querySelector(`[data-focus="${state.focus}"]`);
      if (el) { el.focus(); if (el.select && state.focus === 'edit') el.select(); }
      state.focus = null;
    }
  }

  // ---------- export ----------

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function entryText(e) {
    const L = [fmtDate(e.date).toUpperCase()];
    const { total, done } = taskStats(e);
    const meta = [];
    if (e.mood) meta.push(`Mood: ${e.mood}/5 (${MOODS[e.mood]})`);
    if (total) meta.push(`Tasks: ${done} of ${total} done`);
    if (meta.length) L.push(meta.join('    '));
    if (e.dayType) L.push(`Day type: ${dayTypeLabel(e.dayType)}${e.pinned ? '    (pinned)' : ''}`);
    else if (e.pinned) L.push('(pinned)');
    if (hoursSummary(e)) {
      const o = overMin(e);
      L.push(`Hours: ${hoursSummary(e)}${minutesWorked(e) !== null ? ` — ${fmtDur(minutesWorked(e))} worked` : ''}${o !== null && expectedMin(e) ? ` (${fmtSigned(o)} vs ${fmtDur(expectedMin(e))} target)` : ''}`);
    }
    if (total) {
      L.push('', 'Tasks');
      for (const t of e.tasks) L.push(`  [${t.done ? 'x' : ' '}] ${t.text}${t.priority ? ' (must do)' : ''}${t.carried ? ' (carried over)' : ''}`);
    }
    const block = (title, text) => {
      if (!text || !text.trim()) return;
      L.push('', title);
      for (const line of text.trim().split('\n')) L.push(`  ${line}`);
    };
    if ((e.log || []).length) {
      L.push('', 'Work log');
      for (const l of e.log.slice().sort((a, b) => (a.at < b.at ? -1 : 1))) L.push(`  ${fmtTime(l.at)}  ${l.text}`);
    }
    block('What got done', e.done);
    block('Blockers / problems', e.blockers);
    block('Notes to tomorrow-me', e.notes);
    if (e.nextTasks.length) {
      L.push('', 'Tasks set for the next day');
      for (const t of e.nextTasks) L.push(`  - ${t.text}${t.priority ? ' (must do)' : ''}`);
    }
    if ((e.scheduled || []).length) {
      L.push('', 'Tasks set for a later date');
      for (const s of e.scheduled) L.push(`  - ${s.text} (${fmtDay(s.due)})`);
    }
    return L.join('\n');
  }

  function rangeTitle(from, to) {
    return from === to ? fmtDate(from) : `${fmtDate(from, { month: 'short', day: 'numeric', year: 'numeric' })} to ${fmtDate(to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  function exportText() {
    const { from, to } = state.exportRange;
    const days = entriesBetween(from, to);
    const text = [`DAILY STAND-DOWN — ${rangeTitle(from, to)}`, '', ...days.map((e) => `${entryText(e)}\n\n${'-'.repeat(40)}\n`)].join('\n');
    downloadFile(`stand-down-${from}${from === to ? '' : `-to-${to}`}.txt`, text, 'text/plain');
  }

  const csvCell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const hrs = (m) => (m === null || m === undefined ? '' : (m / 60).toFixed(2));

  // One row per calendar day in the range, ready for Excel.
  function timesheetCsv(from, to) {
    const rows = [['Date', 'Weekday', 'Day type', 'Start', 'Finish', 'Break (min)', 'Hours', 'Target hours', 'Over/under (hours)', 'Tasks done', 'Tasks set']];
    for (let k = from; k <= to; k = shiftKey(k, 1)) {
      const e = state.entries[k];
      const probe = e || { date: k };
      const w = (e && e.work) || {};
      const m = minutesWorked(e);
      const st = e ? taskStats(e) : { total: 0, done: 0 };
      rows.push([k, fmtDate(k, { weekday: 'long' }), e ? dayTypeLabel(e.dayType) || '' : '', w.start || '', w.end || '',
        w.start ? Number(w.breakMin) || 0 : '', hrs(m), hrs(expectedMin(probe)), m === null ? '' : hrs(overMin(e)),
        e ? st.done : '', e ? st.total : '']);
    }
    const total = entriesBetween(from, to).reduce((a, e) => a + (minutesWorked(e) || 0), 0);
    rows.push([]);
    rows.push(['Total', '', '', '', '', '', hrs(total), '', hrs(balance(from, to) ?? 0)]);
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    downloadFile(`timesheet-${from}-to-${to}.csv`, csv, 'text/csv');
  }

  const currentReportMonth = () => {
    const el = document.getElementById('report-month');
    const v = el && /^\d{4}-\d{2}$/.test(el.value) ? el.value : (state.reportMonth || todayKey().slice(0, 7));
    state.reportMonth = v;
    return v;
  };

  function reportPrint(month) {
    const [y, mo] = month.split('-').map(Number);
    const from = `${month}-01`; const to = toKey(new Date(y, mo, 0));
    const days = entriesBetween(from, to);
    const worked = days.filter((e) => minutesWorked(e) !== null);
    const totalMin = worked.reduce((a, e) => a + minutesWorked(e), 0);
    const off = days.filter(isOff);
    let set = 0; let done = 0; let moodSum = 0; let moodN = 0;
    for (const e of days) { set += e.tasks.length; done += e.tasks.filter((t) => t.done).length; if (e.mood) { moodSum += e.mood; moodN += 1; } }
    const blockers = days.filter((e) => e.blockers && e.blockers.trim());
    const pinned = days.filter((e) => e.pinned);
    const title = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const tile = (v, l) => `<div class="tile"><span class="tile-v">${v}</span><span class="tile-l">${l}</span></div>`;
    $print.innerHTML = `
      <div class="report">
        <h1>Monthly report — ${esc(title)}</h1>
        <p class="muted">Daily Stand-Down · generated ${esc(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}</p>
        <div class="tiles">
          ${tile(worked.length, 'days worked')}
          ${tile(fmtDur(totalMin), 'hours worked')}
          ${tile(fmtSigned(balance(from, to)), 'vs target')}
          ${tile(off.length, 'days off (leave, sick, holiday)')}
          ${tile(set ? `${Math.round((done / set) * 100)}%` : '—', `tasks done (${done} of ${set})`)}
          ${tile(moodN ? (moodSum / moodN).toFixed(1) : '—', 'average mood')}
        </div>
        <h2>Hours</h2>
        <table><thead><tr><th>Date</th><th>Type</th><th>Start</th><th>Finish</th><th>Break</th><th>Hours</th><th>vs target</th><th>Tasks</th></tr></thead>
          <tbody>${days.map((e) => {
            const w = e.work || {}; const st = taskStats(e); const m = minutesWorked(e);
            return `<tr><td>${esc(fmtDay(e.date))}</td><td>${esc(dayTypeLabel(e.dayType) || '')}</td><td>${esc(fmtTime(w.start))}</td><td>${esc(fmtTime(w.end))}</td>
              <td>${w.start && Number(w.breakMin) ? fmtDur(Number(w.breakMin)) : ''}</td><td>${m === null ? '' : fmtDur(m)}</td>
              <td>${m !== null && (expectedMin(e) || m) ? fmtSigned(overMin(e)) : ''}</td><td>${st.total ? `${st.done}/${st.total}` : ''}</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th colspan="5">Total</th><th>${fmtDur(totalMin)}</th><th>${fmtSigned(balance(from, to))}</th><th>${done}/${set}</th></tr></tfoot></table>
        ${blockers.length ? `<h2>Blockers</h2><ul class="plain">${blockers.map((e) => `<li><b>${esc(fmtDay(e.date))}:</b> ${esc(e.blockers.trim())}</li>`).join('')}</ul>` : ''}
        ${pinned.length ? `<h2>Pinned days</h2><ul class="plain">${pinned.map((e) => `<li><b>${esc(fmtDay(e.date))}:</b> ${esc((e.done || '').trim().split('\n')[0] || 'No notes')}</li>`).join('')}</ul>` : ''}
        ${!days.length ? '<p>No entries in this month.</p>' : ''}
      </div>`;
    window.print();
  }

  function exportPrint() {
    const { from, to } = state.exportRange;
    const days = entriesBetween(from, to);
    $print.innerHTML = `
      <h1>Daily Stand-Down</h1>
      <p class="muted">${esc(rangeTitle(from, to))} · ${days.length} day${days.length === 1 ? '' : 's'}</p>
      ${days.map((e) => `<article class="print-day"><h2>${esc(fmtDate(e.date))}</h2>${dayHtml(e)}</article>`).join('')}`;
    window.print();
  }
  window.addEventListener('afterprint', () => { $print.innerHTML = ''; });

  // ---------- actions ----------

  function todayEntry() {
    const k = todayKey();
    return state.entries[k] || blankEntry(k);
  }

  function getList(list) {
    const e = todayEntry();
    return { e, arr: list === 'today' ? e.tasks : e.nextTasks };
  }

  function takeInput(name) {
    const el = $app.querySelector(`[data-focus="${name}"]`);
    const text = el ? el.value.trim() : '';
    state.focus = name;
    return text;
  }

  function setMessage(msg) { state.cloud.message = msg; render(); }

  async function auth() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-pass').value;
    if (!email || !password) return setMessage('Enter your email and password.');
    if (!state.cloud.client) {
      try { await connect(); } catch (e) { return setMessage(e.message); }
    }
    const { client } = state.cloud;
    let res;
    try { res = await client.auth.signInWithPassword({ email, password }); } catch (e) { res = { error: e }; }
    if (res.error) return setMessage(looksOffline(res.error) ? 'You are offline. Connect to sign in.' : res.error.message);
    state.cloud.user = res.data.session.user;
    state.cloud.offline = false;
    rememberUser(state.cloud.user);
    state.cloud.message = '';
    state.tab = 'today';
    state.cloud.pulled = false;
    render();
    await syncFromCloud();
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
    const row = { owner: user.id, code, ...(state.cloud.shareSchemaOld ? {} : state.cloud.shareOpts) };
    const { error } = await client.from('share_links').upsert(row);
    if (error) return setMessage(error.message);
    state.cloud.share = code;
    setMessage('Read-only link is ready.');
  }

  function exportBackup() {
    downloadFile(`stand-down-backup-${todayKey()}.json`,
      JSON.stringify({ app: 'daily-stand-down', version: 2, entries: state.entries }, null, 2), 'application/json');
  }

  async function importBackup(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed.entries || parsed;
      const keys = Object.keys(incoming).filter(isKey);
      if (!keys.length) throw new Error('No entries found in that file.');
      const clash = keys.filter((k) => state.entries[k]).length;
      if (clash && !confirm(`${clash} day(s) in the backup already exist here and will be replaced. Continue?`)) return;
      for (const k of keys) {
        state.entries[k] = withDefaults({ ...incoming[k], date: k, updatedAt: Date.now() });
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
    tab(el) {
      state.tab = el.dataset.tab; state.historyDay = null; state.menu = null;
      state.exportOpen = false; state.cloud.message = ''; render();
    },
    'open-day'(el) { state.historyDay = el.dataset.day || null; state.exportOpen = false; render(); window.scrollTo(0, 0); },
    reload() { loadShared(); },
    'hist-view'(el) { state.histView = el.dataset.view; render(); },
    'hist-filter'(el) { state.histFilter = el.dataset.filter; render(); },
    'cal-month'(el) { state.calMonth = el.dataset.month; render(); },
    'cal-color'(el) { state.calColor = el.dataset.by; render(); },
    'trend-range'(el) { state.trendRange = Number(el.dataset.range); render(); },
    'heat-by'(el) { state.heatBy = el.dataset.by; render(); },
    'heat-year'(el) { state.heatYear = Number(el.dataset.year); render(); },
    'open-heat'(el) { state.tab = 'history'; state.historyDay = el.dataset.day; render(); window.scrollTo(0, 0); },
    'report-print'() { reportPrint(currentReportMonth()); },
    'report-csv'() {
      const mo = currentReportMonth();
      const [y, m] = mo.split('-').map(Number);
      timesheetCsv(`${mo}-01`, toKey(new Date(y, m, 0)));
    },

    // export
    'export-open'(el) {
      const today = todayKey();
      state.exportOpen = true;
      state.exportRange = el.dataset.day ? { from: el.dataset.day, to: el.dataset.day } : { from: shiftKey(today, -6), to: today };
      render();
    },
    'export-close'() { state.exportOpen = false; render(); },
    'export-preset'(el) { state.exportRange = { from: el.dataset.from, to: el.dataset.to }; render(); },
    'export-txt'() { exportText(); },
    'export-csv'() { const r = state.exportRange; timesheetCsv(r.from, r.to); },
    'export-pdf'() { exportPrint(); },

    // morning check-in
    'checkin-add'() {
      const text = takeInput('checkin-add');
      if (text) state.checkin.extra.push({ text });
      render();
    },
    'checkin-remove'(el) {
      const key = el.dataset.key;
      if (key.startsWith('x:')) state.checkin.extra.splice(Number(key.slice(2)), 1);
      else state.checkin.removed.push(key);
      render();
    },
    'checkin-star'(el) {
      const today = todayKey();
      const c = checkinLists(today, previousEntry(today));
      const t = [...c.planned, ...c.carry].find((x) => x.key === el.dataset.key);
      if (t) state.checkin.prio[t.key] = !t.priority;
      render();
    },
    'checkin-inbox'(el) {
      const on = new Set(state.checkin.inboxOn || []);
      if (el.checked) on.add(el.dataset.id); else on.delete(el.dataset.id);
      state.checkin.inboxOn = [...on];
    },
    'checkin-carry'(el) {
      const off = state.checkin.carryOff;
      const key = el.dataset.key;
      if (el.checked) state.checkin.carryOff = off.filter((k) => k !== key);
      else if (!off.includes(key)) off.push(key);
    },
    'checkin-start'() {
      const today = todayKey();
      const pending = takeInput('checkin-add');
      state.focus = null;
      if (pending) state.checkin.extra.push({ text: pending });
      const entry = todayEntry();
      const c = checkinLists(today, previousEntry(today));
      entry.skippedPlanned = [...(entry.skippedPlanned || []), ...c.removedText];
      entry.scheduledTaken = [...(entry.scheduledTaken || []), ...c.laterIds];
      entry.tasks = prioFirst([
        ...entry.tasks,
        ...c.planned.map((t) => ({
          id: uid(), text: t.text, done: false, priority: !!t.priority,
          carried: t.carriedCount > 0, carriedCount: t.carriedCount || 0,
        })),
        ...c.carry.filter((t) => t.on).map((t) => ({
          id: uid(), text: t.text, done: false, priority: !!t.priority, carried: true, carriedCount: t.carriedCount,
        })),
      ]);
      const meta = getMeta();
      const pick = meta.inbox.filter((t) => (state.checkin.inboxOn || []).includes(t.id));
      if (pick.length) {
        entry.tasks = [...entry.tasks, ...pick.map((t) => ({ id: uid(), text: t.text, done: false, carried: false }))];
        meta.inbox = meta.inbox.filter((t) => !pick.includes(t));
        saveMeta(meta);
      }
      entry.checkedInAt = Date.now();
      entry.work = { ...blankEntry(today).work, ...(entry.work || {}) };
      if (!isTime(entry.work.start)) entry.work.start = nowHHMM();
      state.checkin = null;
      saveEntry(entry);
      flushNow();
      render();
      window.scrollTo(0, 0);
    },

    // today's tasks and tomorrow's tasks
    'task-add'() {
      const text = takeInput('task-add');
      if (text) { const e = todayEntry(); e.tasks.push({ id: uid(), text, done: false, carried: false }); saveEntry(e); }
      render();
    },
    'next-add'() {
      const text = takeInput('next-add');
      if (text) { const e = todayEntry(); e.nextTasks.push({ id: uid(), text }); saveEntry(e); }
      render();
    },
    'task-toggle'(el) {
      const e = todayEntry();
      const t = e.tasks.find((x) => x.id === el.dataset.id);
      if (t) { t.done = el.checked; saveEntry(e); }
      render();
    },
    star(el) {
      const { e, arr } = getList(el.dataset.list);
      const i = arr.findIndex((x) => x.id === el.dataset.id);
      if (i < 0) return;
      const t = arr[i];
      t.priority = !t.priority;
      if (t.priority) { // move to just after the other must-do tasks
        arr.splice(i, 1);
        const at = arr.findIndex((x) => !x.priority);
        arr.splice(at < 0 ? arr.length : at, 0, t);
      }
      saveEntry(e); render();
    },
    menu(el) {
      const same = state.menu && state.menu.id === el.dataset.id && state.menu.list === el.dataset.list;
      state.menu = same ? null : { list: el.dataset.list, id: el.dataset.id, mode: 'menu' };
      render();
    },
    'menu-close'() { state.menu = null; render(); },
    move(el) {
      const { e, arr } = getList(el.dataset.list);
      const i = arr.findIndex((x) => x.id === el.dataset.id);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      saveEntry(e); render();
      const btn = $app.querySelector(`.task-menu [data-action="move"][data-dir="${el.dataset.dir}"]`);
      if (btn && !btn.disabled) btn.focus();
    },
    edit(el) { state.menu = { list: el.dataset.list, id: el.dataset.id, mode: 'edit' }; state.focus = 'edit'; render(); },
    'edit-save'() {
      const m = state.menu;
      const input = $app.querySelector('.edit-input');
      const text = input ? input.value.trim() : '';
      if (!m || !text) return;
      const { e, arr } = getList(m.list);
      const t = arr.find((x) => x.id === m.id);
      if (t) {
        if (m.list === 'today' && norm(t.text) !== norm(text)) e.skippedPlanned = [...(e.skippedPlanned || []), t.text];
        t.text = text;
        saveEntry(e);
      }
      state.menu = null; render();
    },
    later(el) { state.menu = { list: el.dataset.list, id: el.dataset.id, mode: 'later' }; state.focus = 'later-date'; render(); },
    'later-save'() {
      const m = state.menu;
      if (!m) return;
      const due = (document.getElementById('later-date') || {}).value;
      const { e, arr } = getList(m.list);
      const t = arr.find((x) => x.id === m.id);
      if (!t) return;
      const err = scheduleTask(e, t, due);
      if (err) { state.menu = { ...m, error: err }; render(); return; }
      if (m.list === 'today') {
        e.tasks = e.tasks.filter((x) => x.id !== m.id);
        e.skippedPlanned = [...(e.skippedPlanned || []), t.text];
      } else {
        e.nextTasks = e.nextTasks.filter((x) => x.id !== m.id);
      }
      state.menu = null;
      saveEntry(e); render();
    },
    delete(el) {
      const { e } = getList(el.dataset.list);
      if (el.dataset.list === 'today') {
        const gone = e.tasks.find((x) => x.id === el.dataset.id);
        if (gone) e.skippedPlanned = [...(e.skippedPlanned || []), gone.text];
        e.tasks = e.tasks.filter((x) => x.id !== el.dataset.id);
      } else {
        e.nextTasks = e.nextTasks.filter((x) => x.id !== el.dataset.id);
      }
      state.menu = null;
      saveEntry(e); render();
    },

    // safety nets
    'planned-add'() {
      const e = todayEntry();
      const missing = missingPlanned(e, previousEntry(e.date));
      for (const t of missing) {
        e.tasks.push({ id: uid(), text: t.text, done: false, priority: t.priority, carried: t.carriedCount > 0, carriedCount: t.carriedCount });
      }
      e.scheduledTaken = [...(e.scheduledTaken || []), ...missing.filter((t) => t.sid).map((t) => t.sid)];
      e.tasks = prioFirst(e.tasks);
      saveEntry(e); flushNow(); render();
    },
    'planned-dismiss'() {
      const e = todayEntry();
      const missing = missingPlanned(e, previousEntry(e.date));
      e.skippedPlanned = [...(e.skippedPlanned || []), ...missing.filter((t) => !t.sid).map((t) => t.text)];
      e.scheduledTaken = [...(e.scheduledTaken || []), ...missing.filter((t) => t.sid).map((t) => t.sid)];
      saveEntry(e); render();
    },
    'stale-do'(el) {
      const e = todayEntry();
      const i = e.tasks.findIndex((x) => x.id === el.dataset.id);
      if (i < 0) return;
      const [t] = e.tasks.splice(i, 1);
      t.priority = true; t.staleOk = true;
      e.tasks.unshift(t);
      saveEntry(e); render();
    },
    'stale-later'(el) { state.staleLater = el.dataset.id; state.focus = 'stale-date'; render(); },
    'stale-later-cancel'() { state.staleLater = null; render(); },
    'stale-later-save'(el) {
      const e = todayEntry();
      const t = e.tasks.find((x) => x.id === el.dataset.id);
      if (!t) return;
      const err = scheduleTask(e, t, (document.getElementById('stale-date') || {}).value);
      if (err) { alert(err); return; }
      e.tasks = e.tasks.filter((x) => x.id !== t.id);
      e.skippedPlanned = [...(e.skippedPlanned || []), t.text];
      state.staleLater = null;
      saveEntry(e); render();
    },
    'stale-drop'(el) {
      const e = todayEntry();
      const t = e.tasks.find((x) => x.id === el.dataset.id);
      if (!t) return;
      e.tasks = e.tasks.filter((x) => x.id !== t.id);
      e.skippedPlanned = [...(e.skippedPlanned || []), t.text];
      saveEntry(e); render();
    },

    // coming up
    'later-add'() {
      const text = takeInput('later-add');
      const due = (document.getElementById('later-add-date') || {}).value;
      state.comingUpOpen = true;
      if (!text) { render(); return; }
      const e = todayEntry();
      const err = scheduleTask(e, { text }, due);
      if (err) { alert(err); return; }
      saveEntry(e); render();
    },
    'later-remove'(el) {
      const src = state.entries[el.dataset.from];
      if (!src) return;
      src.scheduled = (src.scheduled || []).filter((s) => s.id !== el.dataset.id);
      state.comingUpOpen = true;
      saveEntry(src); render();
    },

    // evening stand-down
    'fill-done'() {
      const e = todayEntry();
      const ticked = e.tasks.filter((t) => t.done && !norm(e.done).includes(norm(t.text)));
      const lines = ticked.map((t) => `- ${t.text}`).join('\n');
      e.done = e.done && e.done.trim() ? `${e.done.replace(/\s+$/, '')}\n${lines}` : lines;
      saveEntry(e); render();
    },
    'carry-unfinished'() {
      const e = todayEntry();
      const have = new Set(e.nextTasks.map((t) => norm(t.text)));
      for (const t of e.tasks) {
        if (!t.done && !have.has(norm(t.text))) {
          e.nextTasks.push({ id: uid(), text: t.text, priority: !!t.priority, carriedCount: (t.carriedCount || (t.carried ? 1 : 0)) + 1 });
        }
      }
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
      e.work = { ...blankEntry(e.date).work, ...(e.work || {}) };
      if (isTime(e.work.start) && !isTime(e.work.end)) e.work.end = nowHHMM();
      state.editingClose = false;
      state.menu = null;
      saveEntry(e); flushNow(); render();
    },
    'edit-close'() { state.editingClose = true; render(); },

    // inbox
    'inbox-add'() {
      const text = takeInput('inbox-add');
      if (text) { const m = getMeta(); m.inbox = [...m.inbox, { id: uid(), text, added: todayKey() }]; saveMeta(m); }
      render();
    },
    'inbox-today'(el) {
      const m = getMeta();
      const t = m.inbox.find((x) => x.id === el.dataset.id);
      if (!t) return;
      const e = todayEntry();
      e.tasks.push({ id: uid(), text: t.text, done: false, carried: false });
      m.inbox = m.inbox.filter((x) => x.id !== t.id);
      saveEntry(e); saveMeta(m); render();
    },
    'inbox-remove'(el) {
      const m = getMeta();
      m.inbox = m.inbox.filter((x) => x.id !== el.dataset.id);
      saveMeta(m); render();
    },

    // waiting on
    'waiting-add'() {
      const whatEl = $app.querySelector('[data-focus="waiting-what"]');
      const whoEl = $app.querySelector('[data-focus="waiting-who"]');
      const text = whatEl ? whatEl.value.trim() : '';
      const who = whoEl ? whoEl.value.trim() : '';
      state.focus = 'waiting-what';
      if (text) { const m = getMeta(); m.waiting = [...m.waiting, { id: uid(), what: text, who, since: todayKey(), done: false }]; saveMeta(m); }
      render();
    },
    'waiting-done'(el) {
      const m = getMeta();
      m.waiting = m.waiting.map((w) => (w.id === el.dataset.id ? { ...w, done: true, doneOn: todayKey() } : w));
      saveMeta(m); render();
    },
    'waiting-remove'(el) {
      const m = getMeta();
      m.waiting = m.waiting.filter((w) => w.id !== el.dataset.id);
      saveMeta(m); render();
    },

    // work log
    'log-add'() {
      const text = takeInput('log-add');
      if (text) { const e = todayEntry(); e.log = [...(e.log || []), { id: uid(), at: nowHHMM(), text }]; saveEntry(e); }
      render();
    },
    'log-remove'(el) {
      const e = todayEntry();
      e.log = (e.log || []).filter((l) => l.id !== el.dataset.id);
      saveEntry(e); render();
    },

    // pin a day
    'pin-day'(el) {
      const day = el.dataset.day;
      const e = day === todayKey() ? todayEntry() : state.entries[day];
      if (!e) return;
      e.pinned = !e.pinned;
      saveEntry(e); render();
    },

    // mark an empty calendar day as leave / sick / holiday
    'cal-pick'(el) { state.calPick = state.calPick === el.dataset.day ? null : el.dataset.day; render(); },
    'mark-day'(el) {
      const day = state.calPick;
      if (!day) return;
      const e = state.entries[day] || blankEntry(day);
      e.dayType = el.dataset.type;
      state.calPick = null;
      if (!e.dayType && isMarkerOnlyBlank(e)) { removeEntry(day); render(); return; }
      saveEntry(e); render();
    },

    // settings: working hours
    'save-target'() {
      const hrs = Number((document.getElementById('set-target') || {}).value);
      const days = [...$app.querySelectorAll('[data-workday]')].filter((c) => c.checked).map((c) => Number(c.dataset.workday));
      if (!(hrs >= 0 && hrs <= 24)) return setMessage('Enter target hours between 0 and 24.');
      const m = getMeta();
      m.settings = { ...m.settings, targetMin: Math.round(hrs * 60), workdays: days };
      saveMeta(m);
      setMessage('Working hours saved.');
    },
    'work-now'(el) {
      const e = todayEntry();
      e.work = { ...blankEntry(e.date).work, ...(e.work || {}), [el.dataset.which]: nowHHMM() };
      saveEntry(e); render();
    },

    // settings
    'cfg-save'() {
      const url = document.getElementById('cfg-url').value.trim().replace(/\/+$/, '');
      const key = document.getElementById('cfg-key').value.trim();
      if (!/^https:\/\/.+/.test(url) || !key) return setMessage('Enter both the project URL (starting with https://) and the key.');
      localStorage.setItem(LS.config, JSON.stringify({ url, key }));
      state.cloud.message = '';
      state.cloud.ready = false;
      render();
      initCloud();
    },
    'cfg-clear'() {
      localStorage.removeItem(LS.config);
      state.cloud.client = null; state.cloud.ready = false;
      setStatus('local');
      setMessage('Project disconnected. Your entries are still on this device.');
    },
    'sign-in'() { auth(); },
    async 'sign-out'() {
      if (state.dirty.size) await flush();
      if (state.dirty.size && !confirm('Some changes have not synced yet and will be lost if you sign out now. Sign out anyway?')) return;
      await state.cloud.client.auth.signOut();
      rememberUser(null);
      state.cloud.user = null; state.cloud.share = undefined; state.cloud.pulled = false;
      state.entries = {}; state.dirty = new Set(); state.checkin = null;
      persistLocal();
      setStatus('local');
      setMessage('Signed out.');
    },
    'share-new'() { shareAction('new'); },
    'share-off'() { shareAction('off'); },
    async 'share-hide'(el) {
      const f = el.dataset.opt;
      const { client, user } = state.cloud;
      const { error } = await client.from('share_links').update({ [f]: el.checked }).eq('owner', user.id);
      if (error) { el.checked = !el.checked; return setMessage(error.message); }
      state.cloud.shareOpts = { ...state.cloud.shareOpts, [f]: el.checked };
      setMessage(el.checked ? 'Hidden from the read-only link.' : 'Shown on the read-only link.');
    },
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
    if (!el || el.type === 'checkbox' || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  });

  $app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.type === 'checkbox' && el.dataset.action && actions[el.dataset.action]) actions[el.dataset.action](el);
    if (el.id === 'import-file' && el.files[0]) importBackup(el.files[0]);
    if (el.dataset && el.dataset.daytype && !READONLY) {
      const day = el.dataset.daytype;
      const e = day === todayKey() ? todayEntry() : (state.entries[day] || blankEntry(day));
      e.dayType = el.value;
      saveEntry(e); render();
    }
    if (el.id === 'report-month' && /^\d{4}-\d{2}$/.test(el.value)) { state.reportMonth = el.value; }
    if (el.id === 'ex-from' || el.id === 'ex-to') {
      const from = document.getElementById('ex-from').value;
      const to = document.getElementById('ex-to').value;
      if (isKey(from) && isKey(to)) state.exportRange = from <= to ? { from, to } : { from: to, to: from };
      render();
    }
  });

  $app.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.details) state[d.dataset.details] = d.open;
  }, true);

  $app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.field) {
      const e = todayEntry();
      e[el.dataset.field] = el.value;
      saveEntry(e);
    } else if (el.dataset.work) {
      const e = todayEntry();
      const k = el.dataset.work;
      const v = k === 'breakMin' ? Math.max(0, Math.min(600, Number(el.value) || 0)) : (isTime(el.value) ? el.value : '');
      e.work = { ...blankEntry(e.date).work, ...(e.work || {}), [k]: v };
      saveEntry(e);
      const t = document.getElementById('work-total');
      if (t) t.innerHTML = workTotalText(e, minutesSoFar(e));
      const tg = document.getElementById('work-target');
      if (tg) tg.innerHTML = targetText(e);
      updateTitle();
    } else if ('search' in el.dataset) {
      state.search = el.value;
      document.getElementById('history-list').innerHTML = historyListHtml();
    }
  });

  $app.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t.dataset) return;
    if (ev.key === 'Escape' && t.dataset.escape && actions[t.dataset.escape]) {
      ev.preventDefault(); actions[t.dataset.escape](t); return;
    }
    if (ev.key !== 'Enter' || !t.dataset.enter) return;
    ev.preventDefault();
    const fn = actions[t.dataset.enter];
    if (fn) fn(t);
  });

  // Chart hover / tap.
  $app.addEventListener('pointermove', (ev) => {
    const hit = ev.target.closest && ev.target.closest('[data-tip]');
    if (hit) showTip(Number(hit.dataset.tip), hit); else if (state.tab === 'trends') hideTips();
  });
  $app.addEventListener('pointerdown', (ev) => {
    const hit = ev.target.closest && ev.target.closest('[data-tip]');
    if (hit) showTip(Number(hit.dataset.tip), hit);
  });
  $app.addEventListener('pointerleave', hideTips);

  // Drag to reorder: grab the ⠿ handle and move the row up or down.
  let drag = null;
  $app.addEventListener('pointerdown', (ev) => {
    const handle = ev.target.closest && ev.target.closest('.handle');
    if (!handle) return;
    if (state.menu) { state.menu = null; render(); return; }
    const li = handle.closest('li[data-id]');
    const ul = li && li.closest('ul[data-list]');
    if (!ul) return;
    ev.preventDefault();
    drag = { li, ul, list: ul.dataset.list, moved: false };
    li.classList.add('dragging');
    try { handle.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
  });
  $app.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const rows = [...drag.ul.querySelectorAll(':scope > li[data-id]')].filter((r) => r !== drag.li);
    const before = rows.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    if ((before || null) !== drag.li.nextElementSibling) {
      drag.ul.insertBefore(drag.li, before || null);
      drag.moved = true;
    }
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.li.classList.remove('dragging');
    if (!d.moved) return;
    const order = [...d.ul.querySelectorAll(':scope > li[data-id]')].map((r) => r.dataset.id);
    const { e, arr } = getList(d.list);
    const sorted = order.map((id) => arr.find((x) => x.id === id)).filter(Boolean);
    if (d.list === 'today') e.tasks = sorted; else e.nextTasks = sorted;
    saveEntry(e); render();
  };
  $app.addEventListener('pointerup', endDrag);
  $app.addEventListener('pointercancel', endDrag);

  // Leaving the app: upload anything unsaved right away. Coming back: fetch
  // the latest entries, and if the app was left open overnight, wait for
  // them before showing the new day's check-in.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushNow(); return; }
    if (READONLY) { if (state.cloud.client) loadShared(); return; }
    const newDay = state.renderedDay !== todayKey();
    if (newDay) {
      state.editingClose = false;
      if (state.cloud.user && !state.cloud.offline) state.cloud.pulled = false;
      render();
    }
    if (state.cloud.user && !state.cloud.offline) syncFromCloud();
  });
  window.addEventListener('pagehide', flushNow);

  window.addEventListener('online', async () => {
    if (READONLY) { if (state.cloud.client) loadShared(); return; }
    if (!state.cloud.client || !state.cloud.user) return;
    if (state.cloud.offline) {
      const user = await resolveUser();
      state.cloud.user = user;
      if (!user) { render(); return; }
    }
    syncFromCloud();
  });
  window.addEventListener('offline', () => setStatus('offline'));
  window.addEventListener('hashchange', () => location.reload());

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.tab === 'trends') render(); }, 150);
  });
  DESKTOP_QUERY.addEventListener('change', () => { state.menu = null; render(); });

  // Keyboard shortcuts (ignored while typing).
  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (locked()) return;
    const tabs = READONLY ? ['latest', 'history', 'trends'] : ['today', 'history', 'trends', 'settings'];
    const go = (tab) => actions.tab({ dataset: { tab } });
    if (/^[1-9]$/.test(ev.key) && tabs[Number(ev.key) - 1]) {
      ev.preventDefault(); go(tabs[Number(ev.key) - 1]); return;
    }
    if ((ev.key === 'i' || ev.key === 'I' || ev.key === 'l' || ev.key === 'L') && !READONLY) {
      const today = state.entries[todayKey()];
      if (!today || !today.checkedInAt) return;
      ev.preventDefault();
      if (state.tab !== 'today') go('today');
      const input = $app.querySelector(`[data-focus="${ev.key.toLowerCase() === 'i' ? 'inbox-add' : 'log-add'}"]`);
      if (input) { input.focus(); input.scrollIntoView({ block: 'center' }); }
      return;
    }
    if ((ev.key === 'n' || ev.key === 'N') && !READONLY) {
      ev.preventDefault();
      if (state.tab !== 'today') go('today');
      const input = $app.querySelector('[data-focus="task-add"], [data-focus="checkin-add"]');
      if (input) input.focus();
      return;
    }
    if (ev.key === '/') {
      ev.preventDefault();
      if (state.tab !== 'history') go('history');
      if (state.histView !== 'list' || (state.historyDay && !isDesktop())) {
        state.histView = 'list'; if (!isDesktop()) state.historyDay = null; render();
      }
      const search = $app.querySelector('[data-search]');
      if (search) search.focus();
      return;
    }
    if (state.tab === 'history' && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      const day = activeHistoryDay();
      if (!day) return;
      const keys = sortedKeys();
      const next = keys[keys.indexOf(day) + (ev.key === 'ArrowLeft' ? -1 : 1)];
      if (next) { ev.preventDefault(); state.historyDay = next; render(); }
    }
  });

  setInterval(() => {
    const t = document.getElementById('work-total');
    if (t && state.tab === 'today') {
      const e = state.entries[todayKey()];
      if (e) {
        t.innerHTML = workTotalText(e, minutesSoFar(e));
        const tg = document.getElementById('work-target');
        if (tg) tg.innerHTML = targetText(e);
      }
    }
    updateTitle();
  }, 30 * 1000);

  if (READONLY) {
    setInterval(() => {
      if (document.visibilityState === 'visible' && state.cloud.client) loadShared();
    }, READER_REFRESH_MS);
    setInterval(updateFreshness, 60 * 1000);
  }

  // Works offline after the first visit.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }

  // ---------- start ----------

  if (READONLY) loadSharedCache(); else loadLocal();
  render();
  initCloud();
})();
