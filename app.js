// Хроника — личный дневник дел с отчётами за неделю и месяц.
// Работает без сервера (localStorage) и синхронизируется с Supabase, если он подключён.

const LS_DATA = 'chronicle.data.v1';
const LS_PREFS = 'chronicle.prefs.v1';

const DEFAULT_TAGS = [
  { name: 'Работа', emoji: '💼' },
  { name: 'Учёба', emoji: '📚' },
  { name: 'Проект', emoji: '🚀' },
  { name: 'Спорт', emoji: '💪' },
  { name: 'Здоровье', emoji: '🍏' },
  { name: 'Быт', emoji: '🏠' },
  { name: 'Отдых', emoji: '🎮' },
];

const MOOD = { 1: '😫', 2: '😕', 3: '😐', 4: '🙂', 5: '🤩' };

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + Math.random().toString(16).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayIso = () => iso(new Date());
const startOfWeek = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const fmt = (d, o) => new Intl.DateTimeFormat('ru-RU', o).format(d);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtHours = (min) => { if (!min) return '0ч'; const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}ч ${m}м` : `${h}ч`) : `${m}м`; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------------------------------------------------------------- state
const prefs = Object.assign({
  tags: DEFAULT_TAGS,
  autoReport: true,
  reminder: false,
  reminderTime: '21:00',
  light: false,
  supabaseUrl: '',
  supabaseKey: '',
  lastSeenReport: '',
  lastReminder: '',
}, JSON.parse(localStorage.getItem(LS_PREFS) || '{}'));
const savePrefs = () => localStorage.setItem(LS_PREFS, JSON.stringify(prefs));

let data = Object.assign({ entries: [], days: {} }, JSON.parse(localStorage.getItem(LS_DATA) || '{}'));
const saveLocal = () => localStorage.setItem(LS_DATA, JSON.stringify(data));

const ui = {
  date: todayIso(),
  tag: null,
  minutes: null,
  period: 'week',
  anchor: new Date(),
  historyLimit: 20,
  lastReport: null,
};

// ---------------------------------------------------------------- cloud (Supabase)
const cfg = window.CHRONICLE_CONFIG || {};
const cloud = { client: null, user: null };

function cloudCreds() {
  return {
    url: prefs.supabaseUrl || cfg.supabaseUrl || '',
    key: prefs.supabaseKey || cfg.supabaseAnonKey || '',
  };
}

async function initCloud() {
  const { url, key } = cloudCreds();
  if (!url || !key) { renderCloudBox(); setSync(); return; }
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    cloud.client = createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } });
    const { data: s } = await cloud.client.auth.getSession();
    cloud.user = s.session?.user || null;
    cloud.client.auth.onAuthStateChange((_e, session) => {
      const was = cloud.user?.id;
      cloud.user = session?.user || null;
      if (cloud.user && cloud.user.id !== was) pullCloud();
      renderCloudBox(); setSync();
    });
    if (cloud.user) await pullCloud();
  } catch (err) {
    console.error(err);
    toast('Не удалось подключиться к облаку');
  }
  renderCloudBox(); setSync();
}

const online = () => !!(cloud.client && cloud.user);

async function pullCloud() {
  if (!online()) return;
  setSync(true);
  const [e, d] = await Promise.all([
    cloud.client.from('entries').select('*').order('created_at'),
    cloud.client.from('days').select('*'),
  ]);
  setSync(false);
  if (e.error || d.error) { toast('Ошибка загрузки: ' + (e.error || d.error).message); return; }
  const localOnly = data.entries.filter((x) => !x.synced);
  data.entries = e.data.map((r) => ({ id: r.id, date: r.date, text: r.text, tag: r.tag, minutes: r.minutes, starred: r.starred, created_at: r.created_at, synced: true }));
  const days = {};
  d.data.forEach((r) => { days[r.date] = { mood: r.mood, note: r.note || '', synced: true }; });
  // локальные несинхронизированные дни тоже сохраняем
  Object.entries(data.days).forEach(([k, v]) => { if (!v.synced && !days[k]) days[k] = v; });
  data.days = days;
  saveLocal();
  renderAll();
  if (localOnly.length) {
    data.entries.push(...localOnly);
    saveLocal(); renderAll();
    toast(`Загружаю ${localOnly.length} локальных записей в облако…`);
    for (const x of localOnly) await pushEntry(x);
    for (const [k, v] of Object.entries(data.days)) if (!v.synced) await pushDay(k);
    toast('Всё синхронизировано ☁️');
  }
}

async function pushEntry(entry) {
  if (!online()) return;
  const row = { id: entry.id, user_id: cloud.user.id, date: entry.date, text: entry.text, tag: entry.tag, minutes: entry.minutes || 0, starred: !!entry.starred, created_at: entry.created_at };
  const { error } = await cloud.client.from('entries').upsert(row);
  if (error) { toast('Облако: ' + error.message); return; }
  entry.synced = true; saveLocal();
}
async function removeEntryCloud(id) {
  if (!online()) return;
  const { error } = await cloud.client.from('entries').delete().eq('id', id);
  if (error) toast('Облако: ' + error.message);
}
async function pushDay(date) {
  if (!online()) return;
  const v = data.days[date] || {};
  const { error } = await cloud.client.from('days').upsert({ user_id: cloud.user.id, date, mood: v.mood || null, note: v.note || '' }, { onConflict: 'user_id,date' });
  if (error) { toast('Облако: ' + error.message); return; }
  v.synced = true; saveLocal();
}

function setSync(busy = false) {
  const b = $('#syncBadge');
  b.classList.toggle('cloud', online());
  b.classList.toggle('busy', busy);
  $('.label', b).textContent = online() ? 'Облако' : 'Локально';
  b.title = online() ? `Синхронизация: ${cloud.user.email}` : 'Данные хранятся в этом браузере';
}

// ---------------------------------------------------------------- data ops
function tagList() {
  const list = [...prefs.tags];
  const names = new Set(list.map((t) => t.name));
  data.entries.forEach((e) => { if (e.tag && !names.has(e.tag)) { names.add(e.tag); list.push({ name: e.tag, emoji: '🏷' }); } });
  return list;
}
const tagEmoji = (name) => tagList().find((t) => t.name === name)?.emoji || '✅';
const entriesOn = (date) => data.entries.filter((e) => e.date === date).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
const entriesBetween = (from, to) => data.entries.filter((e) => e.date >= from && e.date <= to);

function addEntry({ date, text, tag, minutes, starred }) {
  const entry = { id: uid(), date, text: text.trim(), tag: tag || null, minutes: Number(minutes) || 0, starred: !!starred, created_at: new Date().toISOString(), synced: false };
  data.entries.push(entry);
  saveLocal();
  pushEntry(entry);
  return entry;
}
function updateEntry(id, patch) {
  const e = data.entries.find((x) => x.id === id);
  if (!e) return;
  Object.assign(e, patch, { synced: false });
  saveLocal();
  pushEntry(e);
}
function deleteEntry(id) {
  const idx = data.entries.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [removed] = data.entries.splice(idx, 1);
  saveLocal();
  removeEntryCloud(id);
  renderAll();
  toast('Запись удалена', 'Вернуть', () => {
    removed.synced = false;
    data.entries.push(removed); saveLocal(); pushEntry(removed); renderAll();
  });
}
function setDay(date, patch) {
  data.days[date] = Object.assign({ mood: null, note: '' }, data.days[date], patch, { synced: false });
  saveLocal();
  pushDayDebounced(date);
}
const pushDayDebounced = debounce(pushDay, 700);

function streak() {
  let n = 0;
  let d = new Date();
  const has = new Set(data.entries.map((e) => e.date));
  if (!has.has(iso(d))) d = addDays(d, -1); // сегодня ещё можно успеть
  while (has.has(iso(d))) { n++; d = addDays(d, -1); }
  return n;
}

// ---------------------------------------------------------------- UI: toast, confetti
let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (actionLabel ? ` <button class="btn ghost" style="margin-left:10px;padding:4px 10px">${esc(actionLabel)}</button>` : '');
  t.style.pointerEvents = actionLabel ? 'auto' : 'none';
  if (actionLabel) $('button', t).onclick = () => { action(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 5000 : 2600);
}
function confetti(n = 80) {
  const colors = ['#7c5cff', '#2ee6a6', '#ffb547', '#ff5c7a', '#5cc8ff'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 1.6 + Math.random() * 1.8 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

// ---------------------------------------------------------------- navigation
function show(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'history') renderHistory();
  if (view === 'reports') renderPeriodLabel();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', '#' + view);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));

// ---------------------------------------------------------------- TODAY
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

function renderTagPicker() {
  $('#tagPicker').innerHTML = tagList().map((t) => `<button type="button" class="chip ${ui.tag === t.name ? 'on' : ''}" data-tag="${esc(t.name)}">${esc(t.emoji)} ${esc(t.name)}</button>`).join('');
}
$('#tagPicker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  ui.tag = ui.tag === b.dataset.tag ? null : b.dataset.tag;
  renderTagPicker();
});

$$('.time-pick button').forEach((b) => b.addEventListener('click', () => {
  const v = Number(b.dataset.min);
  ui.minutes = ui.minutes === v ? null : v;
  $('#entryMinutes').value = ui.minutes ?? '';
  $$('.time-pick button').forEach((x) => x.classList.toggle('on', Number(x.dataset.min) === ui.minutes));
}));
$('#entryMinutes').addEventListener('input', (e) => {
  ui.minutes = Number(e.target.value) || null;
  $$('.time-pick button').forEach((x) => x.classList.toggle('on', Number(x.dataset.min) === ui.minutes));
});

$('#entryDate').addEventListener('change', (e) => { ui.date = e.target.value || todayIso(); renderToday(); });

$('#entryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#entryText').value.trim();
  if (!text) return;
  const before = streak();
  addEntry({ date: ui.date, text, tag: ui.tag, minutes: ui.minutes, starred: $('#entryStar').checked });
  $('#entryText').value = '';
  $('#entryStar').checked = false;
  ui.minutes = null; $('#entryMinutes').value = '';
  $$('.time-pick button').forEach((x) => x.classList.remove('on'));
  renderAll();
  const after = streak();
  if (after > before && [3, 7, 14, 30, 50, 100, 365].includes(after)) { confetti(120); toast(`🔥 ${after} ${plural(after, 'день', 'дня', 'дней')} подряд! Так держать!`); }
  else if (entriesOn(ui.date).length === 1) { confetti(40); toast('Первое дело за день — есть! ✨'); }
  else toast('Записано ✓');
  $('#entryText').focus();
});
$('#entryText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#entryForm').requestSubmit(); }
});

$('#moodPicker').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mood]');
  if (!b) return;
  const m = Number(b.dataset.mood);
  setDay(ui.date, { mood: data.days[ui.date]?.mood === m ? null : m });
  renderMood();
});
const saveNote = debounce(() => {
  setDay(ui.date, { note: $('#dayNote').value });
  $('#noteSaved').textContent = 'Сохранено ✓';
  setTimeout(() => ($('#noteSaved').textContent = ''), 1500);
}, 500);
$('#dayNote').addEventListener('input', saveNote);

function renderMood() {
  const m = data.days[ui.date]?.mood;
  $$('#moodPicker button').forEach((b) => b.classList.toggle('on', Number(b.dataset.mood) === m));
}

function entryHtml(e, highlight = '') {
  let text = esc(e.text);
  if (highlight) {
    const re = new RegExp('(' + highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    text = text.replace(re, '<mark>$1</mark>');
  }
  const time = e.created_at ? fmt(new Date(e.created_at), { hour: '2-digit', minute: '2-digit' }) : '';
  return `<li class="entry ${e.starred ? 'starred' : ''}" data-id="${e.id}">
    <span class="emo">${esc(e.tag ? tagEmoji(e.tag) : '✅')}</span>
    <div class="body">
      <div class="text">${text}</div>
      <div class="meta">${e.tag ? `<span>${esc(e.tag)}</span>` : ''}${e.minutes ? `<span>⏱ ${fmtHours(e.minutes)}</span>` : ''}${time ? `<span>${time}</span>` : ''}${e.synced === false && online() ? '<span>⏳</span>' : ''}</div>
    </div>
    <div class="actions">
      <button data-act="star" title="Победа">${e.starred ? '★' : '☆'}</button>
      <button data-act="edit" title="Изменить">✏️</button>
      <button data-act="del" title="Удалить">🗑</button>
    </div>
  </li>`;
}

function handleEntryAction(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const li = btn.closest('.entry');
  const id = li.dataset.id;
  const e = data.entries.find((x) => x.id === id);
  if (!e) return;
  if (btn.dataset.act === 'del') deleteEntry(id);
  if (btn.dataset.act === 'star') { updateEntry(id, { starred: !e.starred }); renderAll(); if (!e.starred) return; toast('⭐ Победа!'); }
  if (btn.dataset.act === 'edit') {
    const box = $('.text', li);
    box.innerHTML = `<textarea rows="2">${esc(e.text)}</textarea>
      <div class="row" style="margin-top:8px"><input type="number" min="0" step="5" value="${e.minutes || ''}" placeholder="минут" style="width:100px">
      <select>${['<option value="">Без категории</option>', ...tagList().map((t) => `<option ${t.name === e.tag ? 'selected' : ''}>${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn primary" data-save>Сохранить</button></div>`;
    const ta = $('textarea', box); ta.focus();
    const save = () => { const v = ta.value.trim(); if (v) updateEntry(id, { text: v, minutes: Number($('input', box).value) || 0, tag: $('select', box).value || null }); renderAll(); };
    $('[data-save]', box).onclick = save;
    ta.addEventListener('keydown', (k) => { if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) save(); if (k.key === 'Escape') renderAll(); });
  }
}
$('#dayEntries').addEventListener('click', handleEntryAction);
$('#historyList').addEventListener('click', handleEntryAction);

function renderToday() {
  const d = parse(ui.date);
  const isToday = ui.date === todayIso();
  $('#entryDate').value = ui.date;
  $('#todayLabel').textContent = fmt(new Date(), { weekday: 'long', day: 'numeric', month: 'long' });
  $('#greeting').textContent = isToday ? `${greeting()}! Что сделал сегодня?` : `Записи за ${fmt(d, { day: 'numeric', month: 'long' })}`;
  $('#dayListTitle').textContent = isToday ? 'Сделано сегодня' : `Сделано ${fmt(d, { day: 'numeric', month: 'long' })}`;
  const list = entriesOn(ui.date);
  const total = list.reduce((s, e) => s + (e.minutes || 0), 0);
  $('#dayTotal').textContent = list.length ? `${list.length} ${plural(list.length, 'дело', 'дела', 'дел')} · ${fmtHours(total)}` : '';
  $('#dayEntries').innerHTML = list.length ? list.map((e) => entryHtml(e)).join('') : `<div class="empty"><span class="big">🌱</span>Пока пусто. Запиши первое дело — даже маленькое считается.</div>`;
  $('#dayNote').value = data.days[ui.date]?.note || '';
  renderMood();

  const ws = iso(startOfWeek(new Date())), we = iso(addDays(startOfWeek(new Date()), 6));
  const week = entriesBetween(ws, we);
  $('#streakNum').textContent = streak();
  $('#weekNum').textContent = week.length;
  $('#weekHours').textContent = fmtHours(week.reduce((s, e) => s + (e.minutes || 0), 0)).replace(/ \d+м/, '');
}

function renderHeatmap() {
  const end = new Date();
  const start = startOfWeek(addDays(end, -364));
  const byDay = {};
  data.entries.forEach((e) => { byDay[e.date] = (byDay[e.date] || 0) + Math.max(e.minutes || 0, 20); });
  const vals = Object.values(byDay);
  const max = Math.max(60, ...vals);
  let cells = '';
  let active = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const k = iso(d);
    const v = byDay[k] || 0;
    if (v) active++;
    const lvl = !v ? 0 : v < max * 0.25 ? 1 : v < max * 0.5 ? 2 : v < max * 0.8 ? 3 : 4;
    const n = entriesOn(k).length;
    cells += `<i class="l${lvl}" data-date="${k}" title="${fmt(d, { day: 'numeric', month: 'long' })}: ${n} ${plural(n, 'дело', 'дела', 'дел')}"></i>`;
  }
  $('#heatmap').innerHTML = cells;
  $('#heatmapCaption').textContent = `${active} ${plural(active, 'активный день', 'активных дня', 'активных дней')} за год`;
}
$('#heatmap').addEventListener('click', (e) => {
  const c = e.target.closest('[data-date]');
  if (!c) return;
  ui.date = c.dataset.date;
  renderToday();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------------------------------------------------------------- HISTORY
function renderFilterTags() {
  const sel = $('#filterTag');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Все категории</option>' + tagList().map((t) => `<option value="${esc(t.name)}">${esc(t.emoji)} ${esc(t.name)}</option>`).join('');
  sel.value = cur;
}
function renderHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const tag = $('#filterTag').value;
  const star = $('#filterStar').checked;
  const filtered = data.entries.filter((e) => (!q || e.text.toLowerCase().includes(q)) && (!tag || e.tag === tag) && (!star || e.starred));
  const byDate = {};
  filtered.forEach((e) => (byDate[e.date] ||= []).push(e));
  // дни только с заметкой тоже показываем, если нет фильтров
  if (!q && !tag && !star) Object.keys(data.days).forEach((k) => { if (data.days[k].note || data.days[k].mood) byDate[k] ||= []; });
  const dates = Object.keys(byDate).sort().reverse();
  const shown = dates.slice(0, ui.historyLimit);
  $('#loadMore').classList.toggle('hidden', dates.length <= ui.historyLimit);
  if (!dates.length) { $('#historyList').innerHTML = `<div class="card empty"><span class="big">🔎</span>${data.entries.length ? 'Ничего не найдено' : 'История пока пустая'}</div>`; return; }
  $('#historyList').innerHTML = shown.map((k) => {
    const list = byDate[k].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const total = list.reduce((s, e) => s + (e.minutes || 0), 0);
    const day = data.days[k] || {};
    return `<div class="day-group card">
      <div class="day-head"><h3>${cap(fmt(parse(k), { weekday: 'long', day: 'numeric', month: 'long', year: parse(k).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }))}</h3>
        <div class="meta">${day.mood ? `<span title="Настроение">${MOOD[day.mood]}</span>` : ''}<span>${list.length} ${plural(list.length, 'дело', 'дела', 'дел')}</span>${total ? `<span>⏱ ${fmtHours(total)}</span>` : ''}<button class="btn ghost" style="padding:4px 10px" data-open="${k}">Открыть</button></div></div>
      <ul class="entries">${list.map((e) => entryHtml(e, q)).join('')}</ul>
      ${day.note ? `<p class="day-note">${esc(day.note)}</p>` : ''}
    </div>`;
  }).join('');
}
$('#historyList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  ui.date = b.dataset.open;
  renderToday();
  show('today');
});
$('#search').addEventListener('input', debounce(() => { ui.historyLimit = 20; renderHistory(); }, 200));
$('#filterTag').addEventListener('change', renderHistory);
$('#filterStar').addEventListener('change', renderHistory);
$('#loadMore').addEventListener('click', () => { ui.historyLimit += 20; renderHistory(); });

// ---------------------------------------------------------------- REPORTS
function periodRange(period, anchor) {
  if (period === 'week') {
    const s = startOfWeek(anchor);
    return { start: s, end: addDays(s, 6) };
  }
  const s = startOfMonth(anchor);
  return { start: s, end: new Date(s.getFullYear(), s.getMonth() + 1, 0) };
}
function periodTitle(period, { start, end }) {
  if (period === 'month') { const t = fmt(start, { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1).replace(' г.', ''); }
  const sameMonth = start.getMonth() === end.getMonth();
  return `${fmt(start, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'long' })}`;
}
function shiftAnchor(dir) {
  const a = new Date(ui.anchor);
  if (ui.period === 'week') a.setDate(a.getDate() + 7 * dir); else a.setMonth(a.getMonth() + dir, 1);
  ui.anchor = a;
}
function renderPeriodLabel() {
  const r = periodRange(ui.period, ui.anchor);
  $('#periodLabel').textContent = periodTitle(ui.period, r);
  $('#nextPeriod').disabled = r.end >= startOfWeek(new Date()) && iso(r.end) >= todayIso();
  $('#nextPeriod').style.opacity = $('#nextPeriod').disabled ? 0.35 : 1;
  if (!ui.lastReport || ui.lastReport.key !== reportKey()) {
    $('#report').className = 'report placeholder';
    $('#report').innerHTML = `<div><div style="font-size:40px">📊</div><p>Нажми «Получить отчёт» — соберу всё, что ты сделал за ${ui.period === 'week' ? 'эту неделю' : 'этот месяц'}.</p></div>`;
  }
}
const reportKey = () => ui.period + ':' + iso(periodRange(ui.period, ui.anchor).start);

$$('#periodSeg button').forEach((b) => b.addEventListener('click', () => {
  ui.period = b.dataset.period;
  $$('#periodSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderPeriodLabel();
  if (ui.lastReport) buildReport(false);
}));
$('#prevPeriod').addEventListener('click', () => { shiftAnchor(-1); renderPeriodLabel(); if (ui.lastReport) buildReport(false); });
$('#nextPeriod').addEventListener('click', () => { if ($('#nextPeriod').disabled) return; shiftAnchor(1); renderPeriodLabel(); if (ui.lastReport) buildReport(false); });
$('#getReport').addEventListener('click', () => buildReport(true));

function stats(start, end) {
  const s = iso(start), e = iso(end);
  const list = entriesBetween(s, e);
  const today = todayIso();
  const lastDay = e > today ? today : e;
  const totalDays = Math.max(1, Math.round((parse(lastDay) - start) / 864e5) + 1);
  const activeDates = new Set(list.map((x) => x.date));
  const minutes = list.reduce((a, x) => a + (x.minutes || 0), 0);
  const moods = [];
  for (let d = new Date(start); iso(d) <= e; d = addDays(d, 1)) { const m = data.days[iso(d)]?.mood; if (m) moods.push(m); }
  let best = 0, cur = 0;
  for (let d = new Date(start); iso(d) <= lastDay; d = addDays(d, 1)) { if (activeDates.has(iso(d))) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return {
    list, minutes, totalDays, active: activeDates.size, wins: list.filter((x) => x.starred),
    mood: moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null,
    bestStreak: best,
  };
}

function delta(cur, prev, unit = '') {
  if (prev == null || (prev === 0 && cur === 0)) return '<span class="delta flat">— без изменений</span>';
  if (prev === 0) return '<span class="delta up">▲ новое</span>';
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return '<span class="delta flat">= как в прошлый раз</span>';
  return `<span class="delta ${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% ${unit}</span>`;
}

function barChart(start, end) {
  const days = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const k = iso(d);
    const list = entriesOn(k);
    days.push({ k, d, n: list.length, min: list.reduce((a, x) => a + (x.minutes || 0), 0), mood: data.days[k]?.mood });
  }
  const useMin = days.some((x) => x.min);
  const val = (x) => (useMin ? x.min : x.n);
  const max = Math.max(1, ...days.map(val));
  const W = 760, H = 220, top = 28, bottom = 30, gap = days.length > 10 ? 4 : 14;
  const bw = (W - gap * (days.length - 1)) / days.length;
  const ch = H - top - bottom;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Активность по дням"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ee6a6"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs>`;
  [0.5, 1].forEach((f) => { const y = top + ch * (1 - f); svg += `<line class="grid" x1="0" x2="${W}" y1="${y}" y2="${y}" stroke-dasharray="3 4"/>`; });
  days.forEach((x, i) => {
    const h = val(x) ? Math.max(4, (val(x) / max) * ch) : 3;
    const xPos = i * (bw + gap);
    svg += `<rect class="${val(x) ? 'bar' : 'bar-empty'}" x="${xPos}" y="${top + ch - h}" width="${bw}" height="${h}" rx="${Math.min(6, bw / 3)}"><title>${fmt(x.d, { day: 'numeric', month: 'long' })}: ${x.n} ${plural(x.n, 'дело', 'дела', 'дел')}${x.min ? ', ' + fmtHours(x.min) : ''}</title></rect>`;
    if (x.mood && days.length <= 10) svg += `<text x="${xPos + bw / 2}" y="${top + ch - h - 8}" text-anchor="middle" style="font-size:16px">${MOOD[x.mood]}</text>`;
    const showLabel = days.length <= 10 || i % 3 === 0 || i === days.length - 1;
    if (showLabel) svg += `<text x="${xPos + bw / 2}" y="${H - 10}" text-anchor="middle">${days.length <= 10 ? fmt(x.d, { weekday: 'short' }) : x.d.getDate()}</text>`;
  });
  svg += '</svg>';
  return { svg, useMin, days };
}

function insights(st, prev, days, period) {
  const out = [];
  const word = period === 'week' ? 'неделе' : 'месяце';
  const prevWord = period === 'week' ? 'прошлой неделей' : 'прошлым месяцем';
  if (!st.list.length) return ['🌱 В этом периоде записей нет. Начни с одного дела в день — и через неделю тут будет красивый отчёт.'];
  const best = [...days].sort((a, b) => (b.min || b.n * 30) - (a.min || a.n * 30))[0];
  if (best && best.n) out.push(`🏆 Самый продуктивный день — <b>${fmt(best.d, { weekday: 'long', day: 'numeric', month: 'long' })}</b>: ${best.n} ${plural(best.n, 'дело', 'дела', 'дел')}${best.min ? ` и ${fmtHours(best.min)}` : ''}.`);
  const byTag = tagTotals(st.list);
  if (byTag[0]) out.push(`🎯 Больше всего внимания ушло на <b>${esc(byTag[0].name)}</b> — ${Math.round(byTag[0].share * 100)}% ${byTag[0].byMin ? 'времени' : 'дел'}.`);
  if (prev.list.length) {
    const diff = st.list.length - prev.list.length;
    out.push(diff >= 0 ? `📈 По сравнению с ${prevWord} сделано на <b>${diff}</b> ${plural(diff, 'дело', 'дела', 'дел')} больше. Прогресс!` : `📉 По сравнению с ${prevWord} на ${-diff} ${plural(-diff, 'дело', 'дела', 'дел')} меньше — бывает, главное не останавливаться.`);
  }
  const missed = st.totalDays - st.active;
  if (missed === 0) out.push(`🔥 Ни одного пропущенного дня в ${word}. Это уровень!`);
  else if (missed > 0) out.push(`🗓 Пропущено ${missed} ${plural(missed, 'день', 'дня', 'дней')}. Попробуй хотя бы одну запись в день — серия мотивирует.`);
  if (st.bestStreak >= 3) out.push(`⚡ Лучшая серия — ${st.bestStreak} ${plural(st.bestStreak, 'день', 'дня', 'дней')} подряд.`);
  const good = days.filter((x) => x.mood >= 4), bad = days.filter((x) => x.mood && x.mood <= 2);
  if (good.length && bad.length) {
    const avg = (a) => a.reduce((s, x) => s + x.n, 0) / a.length;
    if (avg(good) > avg(bad)) out.push(`💡 В дни с хорошим настроением ты делаешь в среднем ${avg(good).toFixed(1)} дел, а в плохие — ${avg(bad).toFixed(1)}. Настроение = топливо.`);
  }
  if (st.wins.length) out.push(`⭐ Отмечено ${st.wins.length} ${plural(st.wins.length, 'победа', 'победы', 'побед')} — не забывай себя хвалить.`);
  return out;
}

function tagTotals(list) {
  const byMin = list.some((x) => x.minutes);
  const m = {};
  list.forEach((x) => { const k = x.tag || 'Без категории'; m[k] = (m[k] || 0) + (byMin ? x.minutes || 0 : 1); });
  const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(m).map(([name, v]) => ({ name, v, share: v / total, byMin })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
}

function grade(st) {
  const r = st.active / st.totalDays;
  if (!st.list.length) return '—';
  return r >= 0.9 ? '🏆 Легендарный период' : r >= 0.7 ? '🔥 Мощно' : r >= 0.45 ? '👍 Неплохо' : '🌱 Есть куда расти';
}

function buildReport(celebrate) {
  const range = periodRange(ui.period, ui.anchor);
  const prevAnchor = new Date(range.start);
  if (ui.period === 'week') prevAnchor.setDate(prevAnchor.getDate() - 7); else prevAnchor.setMonth(prevAnchor.getMonth() - 1, 1);
  const prevRange = periodRange(ui.period, prevAnchor);
  const st = stats(range.start, range.end);
  const pv = stats(prevRange.start, prevRange.end);
  const chart = barChart(range.start, range.end);
  const tags = tagTotals(st.list);
  const title = periodTitle(ui.period, range);
  const ins = insights(st, pv, chart.days, ui.period);

  const daysHtml = chart.days.filter((x) => iso(x.d) <= todayIso()).map((x) => {
    const list = entriesOn(x.k);
    const note = data.days[x.k]?.note;
    return `<div class="rd"><h4><span>${cap(fmt(x.d, { weekday: "long", day: "numeric", month: "long" }))}</span><span>${x.mood ? MOOD[x.mood] : ''} ${x.min ? fmtHours(x.min) : ''}</span></h4>
      ${list.length ? `<ul>${list.map((e) => `<li>${e.starred ? '⭐ ' : ''}${esc(e.text)}${e.tag ? ` <span class="hint">· ${esc(e.tag)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="miss">— нет записей</div>'}
      ${note ? `<p class="day-note">${esc(note)}</p>` : ''}</div>`;
  }).reverse().join('');

  $('#report').className = 'report';
  $('#report').innerHTML = `
    <div class="report-title"><h2>${ui.period === 'week' ? 'Неделя' : 'Месяц'}: ${esc(title)}</h2><span class="grade">${grade(st)}</span></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Сделано дел</div><div class="value">${st.list.length}</div>${delta(st.list.length, pv.list.length)}</div>
      <div class="kpi"><div class="label">Время</div><div class="value">${fmtHours(st.minutes)}</div>${delta(st.minutes, pv.minutes)}</div>
      <div class="kpi"><div class="label">Активных дней</div><div class="value">${st.active}<span class="hint">/${st.totalDays}</span></div>${delta(st.active, pv.active)}</div>
      <div class="kpi"><div class="label">Настроение</div><div class="value">${st.mood ? MOOD[Math.round(st.mood)] + ' ' + st.mood.toFixed(1) : '—'}</div>${st.mood && pv.mood ? delta(st.mood, pv.mood) : '<span class="delta flat">из 5</span>'}</div>
      <div class="kpi"><div class="label">Победы</div><div class="value">⭐ ${st.wins.length}</div>${delta(st.wins.length, pv.wins.length)}</div>
      <div class="kpi"><div class="label">Лучшая серия</div><div class="value">🔥 ${st.bestStreak}</div><span class="delta flat">${plural(st.bestStreak, 'день', 'дня', 'дней')} подряд</span></div>
    </div>
    <div class="card"><div class="card-head"><h2>${chart.useMin ? 'Время по дням' : 'Дела по дням'}</h2></div>${chart.svg}</div>
    <div class="grid-2">
      <div class="card"><h2>💡 Выводы</h2><ul class="insights">${ins.map((x) => `<li>${x}</li>`).join('')}</ul></div>
      <div class="card"><h2>🏷 По категориям</h2>${tags.length ? `<div class="tagbars">${tags.map((t) => `<div class="tagbar"><span>${esc(t.name === 'Без категории' ? '✅' : tagEmoji(t.name))} ${esc(t.name)}</span><div class="track"><div class="fill" style="width:${Math.max(3, (t.v / tags[0].v) * 100)}%"></div></div><span class="v">${t.byMin ? fmtHours(t.v) : t.v}</span></div>`).join('')}</div>` : '<p class="hint">Нет данных</p>'}</div>
    </div>
    ${st.wins.length ? `<div class="card"><h2>⭐ Победы периода</h2><ul class="wins">${st.wins.map((w) => `<li>${esc(w.text)} <span class="hint">· ${fmt(parse(w.date), { day: 'numeric', month: 'short' })}</span></li>`).join('')}</ul></div>` : ''}
    <div class="card report-days"><h2>📅 По дням</h2>${daysHtml || '<p class="hint">Период ещё не начался</p>'}</div>`;

  ui.lastReport = { key: reportKey(), md: toMarkdown(title, st, pv, tags, ins, chart.days) };
  if (celebrate) {
    if (st.list.length) confetti(st.active / st.totalDays >= 0.7 ? 140 : 60);
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toMarkdown(title, st, pv, tags, ins, days) {
  const strip = (s) => s.replace(/<[^>]+>/g, '');
  let md = `# Отчёт: ${ui.period === 'week' ? 'неделя' : 'месяц'} ${title}\n\n`;
  md += `**Итог:** ${strip(grade(st))}\n\n`;
  md += `| Показатель | Значение | Прошлый период |\n|---|---|---|\n`;
  md += `| Сделано дел | ${st.list.length} | ${pv.list.length} |\n| Время | ${fmtHours(st.minutes)} | ${fmtHours(pv.minutes)} |\n`;
  md += `| Активных дней | ${st.active}/${st.totalDays} | ${pv.active}/${pv.totalDays} |\n| Настроение | ${st.mood ? st.mood.toFixed(1) : '—'} | ${pv.mood ? pv.mood.toFixed(1) : '—'} |\n| Победы | ${st.wins.length} | ${pv.wins.length} |\n\n`;
  md += `## Выводы\n${ins.map((x) => '- ' + strip(x)).join('\n')}\n\n`;
  if (tags.length) md += `## По категориям\n${tags.map((t) => `- ${t.name}: ${t.byMin ? fmtHours(t.v) : t.v} (${Math.round(t.share * 100)}%)`).join('\n')}\n\n`;
  if (st.wins.length) md += `## Победы\n${st.wins.map((w) => `- ⭐ ${w.text}`).join('\n')}\n\n`;
  md += `## По дням\n`;
  days.filter((x) => iso(x.d) <= todayIso()).forEach((x) => {
    const list = entriesOn(x.k);
    md += `\n### ${fmt(x.d, { weekday: 'long', day: 'numeric', month: 'long' })}${x.mood ? ' ' + MOOD[x.mood] : ''}\n`;
    md += list.length ? list.map((e) => `- ${e.starred ? '⭐ ' : ''}${e.text}${e.tag ? ` _(${e.tag}${e.minutes ? ', ' + fmtHours(e.minutes) : ''})_` : ''}`).join('\n') + '\n' : '- нет записей\n';
    if (data.days[x.k]?.note) md += `> ${data.days[x.k].note}\n`;
  });
  return md;
}

function ensureReport() { if (!ui.lastReport || ui.lastReport.key !== reportKey()) buildReport(false); return ui.lastReport.md; }
$('#copyReport').addEventListener('click', async () => {
  const md = ensureReport();
  try { await navigator.clipboard.writeText(md); toast('Отчёт скопирован 📋'); } catch { toast('Не удалось скопировать'); }
});
$('#downloadReport').addEventListener('click', () => {
  const md = ensureReport();
  download(`otchet-${reportKey().replace(':', '-')}.md`, md, 'text/markdown');
});
$('#printReport').addEventListener('click', () => { ensureReport(); setTimeout(() => window.print(), 100); });

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- AUTOMATION
function checkAutoReport() {
  if (!prefs.autoReport) return;
  const now = new Date();
  // последний завершённый период: прошлая неделя и прошлый месяц
  const lastWeek = addDays(startOfWeek(now), -7);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthKey = 'month:' + iso(lastMonth);
  const weekKey = 'week:' + iso(lastWeek);
  const seen = new Set((prefs.lastSeenReport || '').split(','));
  let target = null;
  if (!seen.has(monthKey) && now.getDate() <= 7 && entriesBetween(iso(lastMonth), iso(addDays(startOfMonth(now), -1))).length) target = { period: 'month', anchor: lastMonth, key: monthKey, text: `📅 Готов отчёт за ${fmt(lastMonth, { month: 'long' })}!` };
  else if (!seen.has(weekKey) && entriesBetween(iso(lastWeek), iso(addDays(lastWeek, 6))).length) target = { period: 'week', anchor: lastWeek, key: weekKey, text: '📊 Готов отчёт за прошлую неделю!' };
  if (!target) return;
  const b = $('#banner');
  b.innerHTML = `<span><b>${target.text}</b> Посмотри, как прошёл период.</span><span><button class="btn primary" id="openAuto">Открыть</button> <button class="btn ghost" id="closeAuto">✕</button></span>`;
  b.classList.remove('hidden');
  const markSeen = () => { seen.add(target.key); prefs.lastSeenReport = [...seen].filter(Boolean).slice(-20).join(','); savePrefs(); b.classList.add('hidden'); };
  $('#openAuto').onclick = () => {
    markSeen();
    ui.period = target.period; ui.anchor = target.anchor;
    $$('#periodSeg button').forEach((x) => x.classList.toggle('active', x.dataset.period === ui.period));
    show('reports'); renderPeriodLabel(); buildReport(true);
  };
  $('#closeAuto').onclick = markSeen;
  notify(target.text, 'Нажми, чтобы открыть отчёт');
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: 'icon.svg' }); } catch { /* мобильные браузеры требуют SW */ navigator.serviceWorker?.ready.then((r) => r.showNotification(title, { body, icon: 'icon.svg' })); }
}

function reminderTick() {
  if (!prefs.reminder) return;
  const now = new Date();
  const [h, m] = prefs.reminderTime.split(':').map(Number);
  const k = todayIso();
  if (prefs.lastReminder === k) return;
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  if (entriesOn(k).length) return;
  prefs.lastReminder = k; savePrefs();
  notify('Хроника: день ещё не записан ✍️', 'Пара строк о том, что сделал сегодня — и серия не прервётся.');
  toast('✍️ Не забудь записать, что сделал сегодня');
}

// ---------------------------------------------------------------- SETTINGS
function renderTagEditor() {
  $('#tagEditor').innerHTML = prefs.tags.map((t, i) => `<span class="chip">${esc(t.emoji)} ${esc(t.name)} <span class="x" data-del-tag="${i}" title="Удалить">✕</span></span>`).join('');
}
$('#tagEditor').addEventListener('click', (e) => {
  const x = e.target.closest('[data-del-tag]');
  if (!x) return;
  prefs.tags.splice(Number(x.dataset.delTag), 1);
  savePrefs(); renderTagEditor(); renderTagPicker(); renderFilterTags();
});
$('#tagForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#newTagName').value.trim();
  if (!name || prefs.tags.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
  prefs.tags.push({ name, emoji: $('#newTagEmoji').value.trim() || '🏷' });
  savePrefs();
  $('#newTagName').value = ''; $('#newTagEmoji').value = '';
  renderTagEditor(); renderTagPicker(); renderFilterTags();
  toast('Категория добавлена');
});

function bindPref(id, key, after) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!prefs[key]; else el.value = prefs[key];
  el.addEventListener('change', () => { prefs[key] = el.type === 'checkbox' ? el.checked : el.value; savePrefs(); after?.(); });
}
bindPref('#optAutoReport', 'autoReport', checkAutoReport);
bindPref('#optReminder', 'reminder', async () => {
  if (prefs.reminder && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  if (prefs.reminder) toast(`Напомню в ${prefs.reminderTime}, если день будет пустой`);
});
bindPref('#reminderTime', 'reminderTime');
bindPref('#optTheme', 'light', applyTheme);
function applyTheme() { document.documentElement.classList.toggle('light', !!prefs.light); }

function renderCloudBox() {
  const box = $('#cloudBox');
  const { url, key } = cloudCreds();
  if (!url || !key) {
    box.innerHTML = `
      <ol class="cloud-steps">
        <li>Зайди на <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com</a> и создай бесплатный проект.</li>
        <li>В <b>SQL Editor</b> выполни скрипт <a href="supabase/schema.sql" target="_blank">supabase/schema.sql</a>.</li>
        <li>В <b>Project Settings → API</b> скопируй <span class="mono">Project URL</span> и <span class="mono">anon public</span> ключ сюда.</li>
      </ol>
      <form id="cloudForm" class="stack">
        <input id="sbUrl" placeholder="https://xxxx.supabase.co" required>
        <input id="sbKey" placeholder="anon public key (eyJ… или sb_publishable_…)" required>
        <button class="btn primary" type="submit">Подключить облако</button>
      </form>`;
    $('#cloudForm').addEventListener('submit', (e) => {
      e.preventDefault();
      prefs.supabaseUrl = $('#sbUrl').value.trim().replace(/\/$/, '');
      prefs.supabaseKey = $('#sbKey').value.trim();
      savePrefs();
      toast('Подключаю…');
      initCloud();
    });
    return;
  }
  if (!cloud.user) {
    box.innerHTML = `
      <p>Облако подключено ✅ Войди по email — придёт ссылка для входа, пароль не нужен.</p>
      <form id="loginForm" class="stack">
        <input type="email" id="loginEmail" placeholder="твой@email.com" required>
        <button class="btn primary" type="submit">Получить ссылку для входа</button>
      </form>
      ${prefs.supabaseUrl ? '<p class="hint" style="margin-top:12px"><a href="#" id="resetCloud">Отключить облако</a></p>' : ''}`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!cloud.client) { toast('Облако не загрузилось, обнови страницу'); return; }
      const email = $('#loginEmail').value.trim();
      const { error } = await cloud.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      toast(error ? 'Ошибка: ' + error.message : '📬 Ссылка отправлена — проверь почту');
    });
    $('#resetCloud')?.addEventListener('click', (e) => { e.preventDefault(); prefs.supabaseUrl = ''; prefs.supabaseKey = ''; savePrefs(); location.reload(); });
    return;
  }
  box.innerHTML = `
    <p>☁️ Синхронизация включена: <b>${esc(cloud.user.email)}</b></p>
    <p class="hint">Записи сохраняются в облаке и доступны на всех устройствах.</p>
    <div class="row wrap"><button class="btn" id="syncNow">Синхронизировать сейчас</button><button class="btn ghost" id="logout">Выйти</button></div>`;
  $('#syncNow').onclick = async () => { await pullCloud(); toast('Готово ✓'); };
  $('#logout').onclick = async () => { await cloud.client.auth.signOut(); cloud.user = null; renderCloudBox(); setSync(); };
}

$('#exportJson').addEventListener('click', () => download(`chronicle-backup-${todayIso()}.json`, JSON.stringify({ ...data, tags: prefs.tags }, null, 2), 'application/json'));
$('#importJson').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const ids = new Set(data.entries.map((x) => x.id));
    const fresh = (j.entries || []).filter((x) => !ids.has(x.id)).map((x) => ({ ...x, synced: false }));
    data.entries.push(...fresh);
    Object.assign(data.days, Object.fromEntries(Object.entries(j.days || {}).map(([k, v]) => [k, { ...v, synced: false }])));
    if (j.tags) prefs.tags = j.tags;
    saveLocal(); savePrefs(); renderAll();
    fresh.forEach(pushEntry); Object.keys(j.days || {}).forEach(pushDay);
    toast(`Импортировано записей: ${fresh.length}`);
  } catch { toast('Файл не похож на бэкап Хроники'); }
  e.target.value = '';
});
$('#wipeData').addEventListener('click', async () => {
  if (!confirm('Удалить ВСЕ записи' + (online() ? ' (и в облаке тоже)' : '') + '? Это нельзя отменить.')) return;
  if (online()) {
    await cloud.client.from('entries').delete().eq('user_id', cloud.user.id);
    await cloud.client.from('days').delete().eq('user_id', cloud.user.id);
  }
  data = { entries: [], days: {} }; saveLocal(); renderAll(); toast('Всё удалено');
});
$('#demoData').addEventListener('click', () => {
  const samples = {
    'Работа': ['Закрыл 3 задачи в трекере', 'Созвон с командой', 'Разобрал почту и чаты', 'Подготовил презентацию', 'Код-ревью двух PR'],
    'Учёба': ['Прошёл урок по JavaScript', 'Прочитал главу книги', 'Решил 5 задач на алгоритмы', 'Посмотрел лекцию по дизайну'],
    'Проект': ['Сверстал главную страницу', 'Настроил базу данных', 'Пофиксил баг с авторизацией', 'Задеплоил новую версию'],
    'Спорт': ['Тренировка в зале', 'Пробежка 5 км', 'Растяжка 20 минут', 'Турник и отжимания'],
    'Здоровье': ['Лёг спать до 23:00', 'Выпил 2 литра воды', 'Приготовил нормальный ужин'],
    'Быт': ['Убрался в комнате', 'Закупился продуктами', 'Оплатил счета'],
    'Отдых': ['Погулял с друзьями', 'Посмотрел фильм', 'Поиграл вечером'],
  };
  const keys = Object.keys(samples);
  let n = 0;
  for (let i = 75; i >= 1; i--) {
    const d = iso(addDays(new Date(), -i));
    if (Math.random() < 0.15 || entriesOn(d).length) continue;
    const count = 1 + Math.floor(Math.random() * 4);
    for (let j = 0; j < count; j++) {
      const tag = keys[Math.floor(Math.random() * keys.length)];
      const arr = samples[tag];
      const e = { id: uid(), date: d, text: arr[Math.floor(Math.random() * arr.length)], tag, minutes: [15, 30, 45, 60, 90, 120][Math.floor(Math.random() * 6)], starred: Math.random() < 0.1, created_at: new Date(parse(d).getTime() + (9 + j * 3) * 36e5).toISOString(), synced: false };
      data.entries.push(e); n++;
    }
    data.days[d] = { mood: 2 + Math.floor(Math.random() * 4), note: Math.random() < 0.15 ? 'Хороший день, получилось сфокусироваться.' : '', synced: false };
  }
  saveLocal(); renderAll();
  if (online()) { data.entries.filter((x) => !x.synced).forEach(pushEntry); Object.keys(data.days).forEach(pushDay); }
  confetti(80);
  toast(`Добавлено ${n} демо-записей`);
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'т') { e.preventDefault(); show('today'); setTimeout(() => $('#entryText').focus(), 50); }
  if (e.key === 'r' || e.key === 'к') { e.preventDefault(); show('reports'); buildReport(true); }
});

// ---------------------------------------------------------------- boot
function renderAll() {
  renderTagPicker();
  renderToday();
  renderHeatmap();
  renderFilterTags();
  if ($('#view-history').classList.contains('active')) renderHistory();
  if (ui.lastReport && $('#view-reports').classList.contains('active')) buildReport(false);
}

applyTheme();
renderTagEditor();
renderAll();
renderPeriodLabel();
renderCloudBox();
setSync();
const startView = location.hash.slice(1);
if (['today', 'history', 'reports', 'settings'].includes(startView)) show(startView);
checkAutoReport();
setInterval(reminderTick, 60_000);
reminderTick();
initCloud();
// перерисовать «сегодня», если вкладка открыта через полночь
let lastDay = todayIso();
setInterval(() => { if (todayIso() !== lastDay) { if (ui.date === lastDay) ui.date = todayIso(); lastDay = todayIso(); renderAll(); checkAutoReport(); } }, 60_000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
