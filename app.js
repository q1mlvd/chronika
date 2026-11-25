// Хроника — личный дневник дел с отчётами за неделю и месяц.
// Работает без сервера (localStorage) и синхронизируется с Supabase, если он подключён.

const LS_DATA = 'chronicle.data.v1';
const LS_PREFS = 'chronicle.prefs.v1';

const DEFAULT_TAGS = [
  { name: 'Робота', emoji: '💼' },
  { name: 'Навчання', emoji: '📚' },
  { name: 'Проєкт', emoji: '🚀' },
  { name: 'Спорт', emoji: '💪' },
  { name: "Здоров'я", emoji: '🍏' },
  { name: 'Побут', emoji: '🏠' },
  { name: 'Відпочинок', emoji: '🎮' },
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
const fmt = (d, o) => new Intl.DateTimeFormat('uk-UA', o).format(d);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtHours = (min) => { if (!min) return '0 год'; const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h} год ${m} хв` : `${h} год`) : `${m} хв`; };
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
  currency: '₴',
},JSON.parse(localStorage.getItem(LS_PREFS) || '{}'));
const savePrefs = () => localStorage.setItem(LS_PREFS, JSON.stringify(prefs));

let data = Object.assign({ entries: [], days: {}, money: [] },JSON.parse(localStorage.getItem(LS_DATA) || '{}'));
const saveLocal = () => localStorage.setItem(LS_DATA, JSON.stringify(data));

// Міграція зі старої російської версії: назви категорій і валюта
(function migrateToUk() {
  if (prefs.ukMigrated) return;
  const map = { 'Работа': 'Робота', 'Учёба': 'Навчання', 'Проект': 'Проєкт', 'Здоровье': "Здоров'я", 'Быт': 'Побут', 'Отдых': 'Відпочинок',
    'Еда': 'Їжа', 'Жильё': 'Житло', 'Подписки': 'Підписки', 'Развлечения': 'Розваги', 'Другое': 'Інше', 'Подработка': 'Підробіток', 'Подарок': 'Подарунок', 'Продажа': 'Продаж' };
  prefs.tags = prefs.tags.map((t) => ({ ...t, name: map[t.name] || t.name }));
  data.entries.forEach((e) => { if (map[e.tag]) { e.tag = map[e.tag]; e.synced = false; } });
  data.money.forEach((x) => { if (map[x.category]) { x.category = map[x.category]; x.synced = false; } });
  if (prefs.currency === '₽') prefs.currency = '₴';
  prefs.ukMigrated = true;
  savePrefs(); saveLocal();
})();

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
    toast('Не вдалося підключитися до хмари');
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
  if (e.error || d.error) { toast('Помилка завантаження: ' + (e.error || d.error).message); return; }
  const localOnly = data.entries.filter((x) => !x.synced);
  const localIds = new Set(localOnly.map((x) => x.id));
  data.entries = e.data.filter((r) => !localIds.has(r.id)).map((r) => ({ id: r.id, date: r.date, text: r.text, tag: r.tag, minutes: r.minutes, starred: r.starred, created_at: r.created_at, synced: true }));
  const days = {};
  d.data.forEach((r) => { days[r.date] = { mood: r.mood, note: r.note || '', synced: true }; });
  // локальные несинхронизированные дни тоже сохраняем
  Object.entries(data.days).forEach(([k, v]) => { if (!v.synced && !days[k]) days[k] = v; });
  data.days = days;
  // деньги: отдельная таблица (если её ещё нет в базе — работаем локально)
  const m = await cloud.client.from('money').select('*').order('created_at');
  const moneyLocal = data.money.filter((x) => !x.synced);
  if (!m.error) {
    const mLocalIds = new Set(moneyLocal.map((x) => x.id));
    data.money = m.data.filter((r) => !mLocalIds.has(r.id)).map((r) => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount), category: r.category, note: r.note || '', created_at: r.created_at, synced: true }));
    data.money.push(...moneyLocal);
    for (const x of moneyLocal) pushMoney(x);
  } else console.warn('money table:', m.error.message);
  saveLocal();
  renderAll();
  if (localOnly.length) {
    data.entries.push(...localOnly);
    saveLocal(); renderAll();
    toast(`Завантажую ${localOnly.length} локальних записів у хмару…`);
    for (const x of localOnly) await pushEntry(x);
    for (const [k, v] of Object.entries(data.days)) if (!v.synced) await pushDay(k);
    toast('Усе синхронізовано ☁️');
  }
}

async function pushMoney(tx) {
  if (!online()) return;
  const { error } = await cloud.client.from('money').upsert({ id: tx.id, user_id: cloud.user.id, date: tx.date, type: tx.type, amount: tx.amount, category: tx.category, note: tx.note || '', created_at: tx.created_at });
  if (error) { toast('Хмара: ' + error.message); return; }
  tx.synced = true; saveLocal();
}
async function removeMoneyCloud(id) {
  if (!online()) return;
  const { error } = await cloud.client.from('money').delete().eq('id', id);
  if (error) toast('Хмара: ' + error.message);
}

async function pushEntry(entry) {
  if (!online()) return;
  const row = { id: entry.id, user_id: cloud.user.id, date: entry.date, text: entry.text, tag: entry.tag, minutes: entry.minutes || 0, starred: !!entry.starred, created_at: entry.created_at };
  const { error } = await cloud.client.from('entries').upsert(row);
  if (error) { toast('Хмара: ' + error.message); return; }
  entry.synced = true; saveLocal();
}
async function removeEntryCloud(id) {
  if (!online()) return;
  const { error } = await cloud.client.from('entries').delete().eq('id', id);
  if (error) toast('Хмара: ' + error.message);
}
async function pushDay(date) {
  if (!online()) return;
  const v = data.days[date] || {};
  const { error } = await cloud.client.from('days').upsert({ user_id: cloud.user.id, date, mood: v.mood || null, note: v.note || '' }, { onConflict: 'user_id,date' });
  if (error) { toast('Хмара: ' + error.message); return; }
  v.synced = true; saveLocal();
}

function setSync(busy = false) {
  const b = $('#syncBadge');
  b.classList.toggle('cloud', online());
  b.classList.toggle('busy', busy);
  $('.label', b).textContent = online() ? 'Хмара' : 'Локально';
  b.title = online() ? `Синхронізація: ${cloud.user.email}` : 'Дані зберігаються в цьому браузері';
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
  toast('Запис видалено', 'Повернути', () => {
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
  if (view === 'money') renderMoney();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', '#' + view);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));

// ---------------------------------------------------------------- TODAY
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Доброї ночі' : h < 12 ? 'Доброго ранку' : h < 18 ? 'Доброго дня' : 'Доброго вечора';
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
  if (after > before && [3, 7, 14, 30, 50, 100, 365].includes(after)) { confetti(120); toast(`🔥 ${after} ${plural(after, 'день', 'дні', 'днів')} поспіль! Так тримати!`); }
  else if (entriesOn(ui.date).length === 1) { confetti(40); toast('Перша справа за день — є! ✨'); }
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
  $('#noteSaved').textContent = 'Збережено ✓';
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
      <button data-act="star" title="Перемога">${e.starred ? '★' : '☆'}</button>
      <button data-act="edit" title="Змінити">✏️</button>
      <button data-act="del" title="Видалити">🗑</button>
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
  if (btn.dataset.act === 'star') { updateEntry(id, { starred: !e.starred }); renderAll(); if (!e.starred) return; toast('⭐ Перемога!'); }
  if (btn.dataset.act === 'edit') {
    const box = $('.text', li);
    box.innerHTML = `<textarea rows="2">${esc(e.text)}</textarea>
      <div class="row" style="margin-top:8px"><input type="number" min="0" step="5" value="${e.minutes || ''}" placeholder="хвилин" style="width:100px">
      <select>${['<option value="">Без категорії</option>', ...tagList().map((t) => `<option ${t.name === e.tag ? 'selected' : ''}>${esc(t.name)}</option>`)].join('')}</select>
      <button class="btn primary" data-save>Зберегти</button></div>`;
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
  $('#greeting').textContent = isToday ? `${greeting()}! Що зробив сьогодні?` : `Записи за ${fmt(d, { day: 'numeric', month: 'long' })}`;
  $('#dayListTitle').textContent = isToday ? 'Зроблено сьогодні' : `Зроблено ${fmt(d, { day: 'numeric', month: 'long' })}`;
  const list = entriesOn(ui.date);
  const total = list.reduce((s, e) => s + (e.minutes || 0), 0);
  $('#dayTotal').textContent = list.length ? `${list.length} ${plural(list.length, 'справа', 'справи', 'справ')} · ${fmtHours(total)}` : '';
  $('#dayEntries').innerHTML = list.length ? list.map((e) => entryHtml(e)).join('') : `<div class="empty"><span class="big">🌱</span>Поки порожньо. Запиши першу справу — навіть маленька рахується.</div>`;
  $('#dayNote').value = data.days[ui.date]?.note || '';
  renderMood();

  const ws = iso(startOfWeek(new Date())), we = iso(addDays(startOfWeek(new Date()), 6));
  const week = entriesBetween(ws, we);
  $('#streakNum').textContent = streak();
  $('#weekNum').textContent = week.length;
  $('#weekHours').textContent = fmtHours(week.reduce((s, e) => s + (e.minutes || 0), 0)).replace(/ \d+ хв/, '');
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
    cells += `<i class="l${lvl}" data-date="${k}" title="${fmt(d, { day: 'numeric', month: 'long' })}: ${n} ${plural(n, 'справа', 'справи', 'справ')}"></i>`;
  }
  $('#heatmap').innerHTML = cells;
  $('#heatmapCaption').textContent = `${active} ${plural(active, 'активний день', 'активні дні', 'активних днів')} за рік`;
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
  sel.innerHTML = '<option value="">Усі категорії</option>' + tagList().map((t) => `<option value="${esc(t.name)}">${esc(t.emoji)} ${esc(t.name)}</option>`).join('');
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
  if (!dates.length) { $('#historyList').innerHTML = `<div class="card empty"><span class="big">🔎</span>${data.entries.length ? 'Нічого не знайдено' : 'Історія поки порожня'}</div>`; return; }
  $('#historyList').innerHTML = shown.map((k) => {
    const list = byDate[k].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const total = list.reduce((s, e) => s + (e.minutes || 0), 0);
    const day = data.days[k] || {};
    return `<div class="day-group card">
      <div class="day-head"><h3>${cap(fmt(parse(k), { weekday: 'long', day: 'numeric', month: 'long', year: parse(k).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }))}</h3>
        <div class="meta">${day.mood ? `<span title="Настрій">${MOOD[day.mood]}</span>` : ''}<span>${list.length} ${plural(list.length, 'справа', 'справи', 'справ')}</span>${total ? `<span>⏱ ${fmtHours(total)}</span>` : ''}<button class="btn ghost" style="padding:4px 10px" data-open="${k}">Відкрити</button></div></div>
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

// ---------------------------------------------------------------- MONEY
const MONEY_CATS = {
  expense: [['Їжа', '🛒'], ['Кафе', '☕'], ['Транспорт', '🚕'], ['Житло', '🏠'], ['Підписки', '📱'], ['Покупки', '🛍'], ['Розваги', '🎉'], ["Здоров'я", '💊'], ['Навчання', '📚'], ['Інше', '📦']],
  income: [['Зарплата', '💼'], ['Підробіток', '💻'], ['Подарунок', '🎁'], ['Продаж', '🏷'], ['Інше', '💰']],
};
const moneyEmoji = (type, cat) => (MONEY_CATS[type].find((c) => c[0] === cat) || [])[1] || (type === 'income' ? '💰' : '📦');
const fmtMoney = (n, sign = '') => sign + new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(Math.round(n * 100) / 100) + ' ' + prefs.currency;
const moneyBetween = (from, to) => data.money.filter((x) => x.date >= from && x.date <= to);
function moneyStats(from, to) {
  const list = moneyBetween(from, to);
  const income = list.filter((x) => x.type === 'income').reduce((a, x) => a + x.amount, 0);
  const expense = list.filter((x) => x.type === 'expense').reduce((a, x) => a + x.amount, 0);
  return { list, income, expense, balance: income - expense };
}
function moneyCatTotals(list, type) {
  const m = {};
  list.filter((x) => x.type === type).forEach((x) => { m[x.category || 'Інше'] = (m[x.category || 'Інше'] || 0) + x.amount; });
  const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(m).map(([name, v]) => ({ name, v, share: v / total })).sort((a, b) => b.v - a.v);
}
function catBarsHtml(totals, type) {
  if (!totals.length) return `<p class="hint">${type === 'expense' ? 'Витрат поки немає' : 'Доходів поки немає'}</p>`;
  const max = totals[0].v;
  return `<div class="tagbars">${totals.map((t) => `<div class="tagbar"><span>${moneyEmoji(type, t.name)} ${esc(t.name)}</span><div class="track"><div class="fill ${type}" style="width:${Math.max(3, (t.v / max) * 100)}%"></div></div><span class="v">${fmtMoney(t.v)}</span></div>`).join('')}</div>`;
}

Object.assign(ui, { moneyType: 'expense', moneyCat: null, moneyMonth: startOfMonth(new Date()), moneyDate: todayIso() });

function setDelta(id, html) { $(id).innerHTML = html; }

function renderMoney() {
  const s = ui.moneyMonth;
  const e = new Date(s.getFullYear(), s.getMonth() + 1, 0);
  const ps = new Date(s.getFullYear(), s.getMonth() - 1, 1);
  const pe = new Date(s.getFullYear(), s.getMonth(), 0);
  const isCur = iso(s) === iso(startOfMonth(new Date()));
  $('#moneyMonth').textContent = cap(fmt(s, { month: 'long', year: 'numeric' }).replace(/ (р\.|г\.)/, ''));
  $('#moneyNext').disabled = isCur;
  $('#moneyNext').style.opacity = isCur ? 0.35 : 1;

  const st = moneyStats(iso(s), iso(e));
  const pv = moneyStats(iso(ps), iso(pe));
  $('#mIncome').textContent = fmtMoney(st.income);
  $('#mExpense').textContent = fmtMoney(st.expense);
  $('#mBalance').textContent = fmtMoney(st.balance, st.balance > 0 ? '+' : '');
  $('#mBalance').style.color = st.balance < 0 ? 'var(--danger)' : '';
  setDelta('#mIncomeD', delta(st.income, pv.income));
  setDelta('#mExpenseD', delta(st.expense, pv.expense, '', true));
  setDelta('#mBalanceD', st.income > 0 ? (st.balance >= 0 ? `зберіг ${Math.round((st.balance / st.income) * 100)}% доходу` : 'витрачаєш більше, ніж заробляєш') : '');
  const daysPassed = isCur ? new Date().getDate() : e.getDate();
  $('#mDaily').textContent = fmtMoney(Math.round(st.expense / daysPassed));

  $('#view-money').classList.toggle('is-income', ui.moneyType === 'income');
  $$('#moneyType button').forEach((b) => b.classList.toggle('active', b.dataset.type === ui.moneyType));
  $('#moneySubmit').textContent = ui.moneyType === 'income' ? 'Додати дохід' : 'Додати витрату';
  $('#moneyCur').textContent = prefs.currency;
  $('#moneyDate').value = ui.moneyDate;
  $('#moneyCats').innerHTML = MONEY_CATS[ui.moneyType].map(([n, em]) => `<button type="button" class="chip ${ui.moneyCat === n ? 'on' : ''}" data-cat="${esc(n)}">${em} ${esc(n)}</button>`).join('');

  $('#moneyCatBars').innerHTML = catBarsHtml(moneyCatTotals(st.list, 'expense'), 'expense');

  $('#moneyCount').textContent = st.list.length ? `${st.list.length} ${plural(st.list.length, 'операція', 'операції', 'операцій')}` : '';
  const byDate = {};
  st.list.forEach((x) => (byDate[x.date] ||= []).push(x));
  const dates = Object.keys(byDate).sort().reverse();
  $('#moneyList').innerHTML = dates.length ? dates.map((d) => {
    const list = byDate[d].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const out = list.filter((x) => x.type === 'expense').reduce((a, x) => a + x.amount, 0);
    const inc = list.filter((x) => x.type === 'income').reduce((a, x) => a + x.amount, 0);
    return `<div class="tx-day"><div class="tx-day-head"><span>${cap(fmt(parse(d), { weekday: 'long', day: 'numeric', month: 'long' }))}</span><span>${inc ? `<span style="color:var(--accent-2)">+${fmtMoney(inc)}</span> ` : ''}${out ? `−${fmtMoney(out)}` : ''}</span></div>
      ${list.map((x) => `<div class="tx" data-id="${x.id}"><span class="emo">${moneyEmoji(x.type, x.category)}</span><div class="body"><div class="cat">${esc(x.category || 'Без категорії')}</div>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}</div><span class="amt ${x.type === 'income' ? 'plus' : 'minus'}">${x.type === 'income' ? '+' : '−'}${fmtMoney(x.amount)}</span><button class="del" data-del-tx title="Видалити">🗑</button></div>`).join('')}</div>`;
  }).join('') : `<div class="empty"><span class="big">💸</span>За цей місяць операцій немає. Додай перший дохід або витрату.</div>`;
}

$('#moneyType').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  ui.moneyType = b.dataset.type; ui.moneyCat = null;
  renderMoney();
  $('#moneyAmount').focus();
});
$('#moneyCats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  ui.moneyCat = ui.moneyCat === b.dataset.cat ? null : b.dataset.cat;
  $$('#moneyCats .chip').forEach((c) => c.classList.toggle('on', c.dataset.cat === ui.moneyCat));
});
$('#moneyDate').addEventListener('change', (e) => { ui.moneyDate = e.target.value || todayIso(); });
$('#moneyPrev').addEventListener('click', () => { const s = ui.moneyMonth; ui.moneyMonth = new Date(s.getFullYear(), s.getMonth() - 1, 1); renderMoney(); });
$('#moneyNext').addEventListener('click', () => { if ($('#moneyNext').disabled) return; const s = ui.moneyMonth; ui.moneyMonth = new Date(s.getFullYear(), s.getMonth() + 1, 1); renderMoney(); });
$('#moneyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = Math.round(parseFloat(String($('#moneyAmount').value).replace(',', '.')) * 100) / 100;
  if (!(amount > 0)) { toast('Введи суму більшу за нуль'); return; }
  const tx = { id: uid(), date: ui.moneyDate, type: ui.moneyType, amount, category: ui.moneyCat || 'Інше', note: $('#moneyNote').value.trim(), created_at: new Date().toISOString(), synced: false };
  data.money.push(tx);
  saveLocal(); pushMoney(tx);
  $('#moneyAmount').value = ''; $('#moneyNote').value = '';
  ui.moneyMonth = startOfMonth(parse(tx.date));
  renderMoney();
  if (tx.type === 'income') { confetti(50); toast(`💰 +${fmtMoney(amount)}, красень!`); } else toast(`Записав витрату: ${fmtMoney(amount)}`);
  $('#moneyAmount').focus();
});
$('#moneyList').addEventListener('click', (e) => {
  if (!e.target.closest('[data-del-tx]')) return;
  const id = e.target.closest('.tx').dataset.id;
  const idx = data.money.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [removed] = data.money.splice(idx, 1);
  saveLocal(); removeMoneyCloud(id); renderMoney();
  toast('Операцію видалено', 'Повернути', () => { removed.synced = false; data.money.push(removed); saveLocal(); pushMoney(removed); renderMoney(); });
});

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
  if (period === 'month') { const t = fmt(start, { month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1).replace(/ (р\.|г\.)/, ''); }
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
    $('#report').innerHTML = `<div><div style="font-size:40px">📊</div><p>Натисни «Отримати звіт» — зберу все, що ти зробив за ${ui.period === 'week' ? 'цей тиждень' : 'цей місяць'}.</p></div>`;
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

// invert: для расходов рост — это плохо (красный), падение — хорошо (зелёный)
function delta(cur, prev, unit = '', invert = false) {
  if (prev == null || (prev === 0 && cur === 0)) return '<span class="delta flat">— без змін</span>';
  if (prev === 0) return `<span class="delta ${invert ? 'down' : 'up'}">▲ нове</span>`;
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return '<span class="delta flat">= як минулого разу</span>';
  const good = invert ? p < 0 : p > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% ${unit}</span>`;
}

function moneyReportHtml(ms, mp) {
  if (!ms.list.length && !mp.list.length) return '';
  const exp = moneyCatTotals(ms.list, 'expense');
  const inc = moneyCatTotals(ms.list, 'income');
  const big = ms.list.filter((x) => x.type === 'expense').sort((a, b) => b.amount - a.amount).slice(0, 5);
  const total = ms.income + ms.expense || 1;
  return `<div class="card"><div class="card-head"><h2>💰 Гроші</h2><span class="pill">${ms.list.length} ${plural(ms.list.length, 'операція', 'операції', 'операцій')}</span></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Заробив</div><div class="value" style="color:var(--accent-2)">${fmtMoney(ms.income)}</div>${delta(ms.income, mp.income)}</div>
      <div class="kpi"><div class="label">Витратив</div><div class="value" style="color:var(--danger)">${fmtMoney(ms.expense)}</div>${delta(ms.expense, mp.expense, '', true)}</div>
      <div class="kpi"><div class="label">Залишок</div><div class="value" ${ms.balance < 0 ? 'style="color:var(--danger)"' : ''}>${fmtMoney(ms.balance, ms.balance > 0 ? '+' : '')}</div><span class="delta flat">було ${fmtMoney(mp.balance, mp.balance > 0 ? '+' : '')}</span></div>
    </div>
    <div class="balance-bar"><div class="in" style="width:${(ms.income / total) * 100}%"></div><div class="out" style="width:${(ms.expense / total) * 100}%"></div></div>
    <div class="money-split">
      <div><h2 style="font-size:15px">Витрати за категоріями</h2>${catBarsHtml(exp, 'expense')}</div>
      <div><h2 style="font-size:15px">Доходи</h2>${catBarsHtml(inc, 'income')}
        ${big.length ? `<h2 style="font-size:15px;margin-top:18px">Найбільші витрати</h2><ul class="wins">${big.map((x) => `<li style="border-color:var(--danger);background:linear-gradient(90deg,rgba(255,92,122,.1),transparent)">${moneyEmoji('expense', x.category)} ${fmtMoney(x.amount)} · ${esc(x.category)}${x.note ? ` · ${esc(x.note)}` : ''} <span class="hint">· ${fmt(parse(x.date), { day: 'numeric', month: 'short' })}</span></li>`).join('')}</ul>` : ''}
      </div>
    </div></div>`;
}

function moneyInsights(ms, mp, period) {
  const out = [];
  if (!ms.list.length) return out;
  const prevWord = period === 'week' ? 'минулим тижнем' : 'минулим місяцем';
  const exp = moneyCatTotals(ms.list, 'expense');
  if (exp[0]) out.push(`💸 Найбільше грошей пішло на <b>${esc(exp[0].name)}</b>: ${fmtMoney(exp[0].v)} (${Math.round(exp[0].share * 100)}% витрат).`);
  if (ms.income) out.push(ms.balance >= 0 ? `🏦 У плюсі на <b>${fmtMoney(ms.balance)}</b>: відклав ${Math.round((ms.balance / ms.income) * 100)}% заробітку.` : `⚠️ Витрати більші за доходи на <b>${fmtMoney(-ms.balance)}</b>. Глянь великі покупки.`);
  if (mp.expense && ms.expense) {
    const p = Math.round(((ms.expense - mp.expense) / mp.expense) * 100);
    const when = period === 'week' ? 'минулого тижня' : 'минулого місяця';
    if (Math.abs(p) >= 5) out.push(p < 0 ? `📉 Витратив на ${-p}% менше, ніж ${when}. Економія працює!` : `📈 Витрати зросли на ${p}% порівняно з ${prevWord}.`);
  }
  return out;
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
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Активність по днях"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ee6a6"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs>`;
  [0.5, 1].forEach((f) => { const y = top + ch * (1 - f); svg += `<line class="grid" x1="0" x2="${W}" y1="${y}" y2="${y}" stroke-dasharray="3 4"/>`; });
  days.forEach((x, i) => {
    const h = val(x) ? Math.max(4, (val(x) / max) * ch) : 3;
    const xPos = i * (bw + gap);
    svg += `<rect class="${val(x) ? 'bar' : 'bar-empty'}" x="${xPos}" y="${top + ch - h}" width="${bw}" height="${h}" rx="${Math.min(6, bw / 3)}"><title>${fmt(x.d, { day: 'numeric', month: 'long' })}: ${x.n} ${plural(x.n, 'справа', 'справи', 'справ')}${x.min ? ', ' + fmtHours(x.min) : ''}</title></rect>`;
    if (x.mood && days.length <= 10) svg += `<text x="${xPos + bw / 2}" y="${top + ch - h - 8}" text-anchor="middle" style="font-size:16px">${MOOD[x.mood]}</text>`;
    const showLabel = days.length <= 10 || i % 3 === 0 || i === days.length - 1;
    if (showLabel) svg += `<text x="${xPos + bw / 2}" y="${H - 10}" text-anchor="middle">${days.length <= 10 ? fmt(x.d, { weekday: 'short' }) : x.d.getDate()}</text>`;
  });
  svg += '</svg>';
  return { svg, useMin, days };
}

function insights(st, prev, days, period) {
  const out = [];
  const word = period === 'week' ? 'цьому тижні' : 'цьому місяці';
  const prevWord = period === 'week' ? 'минулим тижнем' : 'минулим місяцем';
  if (!st.list.length) return ['🌱 У цьому періоді записів немає. Почни з однієї справи на день — і за тиждень тут буде гарний звіт.'];
  const best = [...days].sort((a, b) => (b.min || b.n * 30) - (a.min || a.n * 30))[0];
  if (best && best.n) out.push(`🏆 Найпродуктивніший день — <b>${fmt(best.d, { weekday: 'long', day: 'numeric', month: 'long' })}</b>: ${best.n} ${plural(best.n, 'справа', 'справи', 'справ')}${best.min ? ` і ${fmtHours(best.min)}` : ''}.`);
  const byTag = tagTotals(st.list);
  if (byTag[0]) out.push(`🎯 Найбільше уваги пішло на <b>${esc(byTag[0].name)}</b> — ${Math.round(byTag[0].share * 100)}% ${byTag[0].byMin ? 'часу' : 'справ'}.`);
  if (prev.list.length) {
    const diff = st.list.length - prev.list.length;
    out.push(diff >= 0 ? `📈 Порівняно з ${prevWord} зроблено на <b>${diff}</b> ${plural(diff, 'справу', 'справи', 'справ')} більше. Прогрес!` : `📉 Порівняно з ${prevWord} на ${-diff} ${plural(-diff, 'справу', 'справи', 'справ')} менше — буває, головне не зупинятися.`);
  }
  const missed = st.totalDays - st.active;
  if (missed === 0) out.push(`🔥 Жодного пропущеного дня в ${word}. Це рівень!`);
  else if (missed > 0) out.push(`🗓 Пропущено ${missed} ${plural(missed, 'день', 'дні', 'днів')}. Спробуй хоча б один запис на день — серія мотивує.`);
  if (st.bestStreak >= 3) out.push(`⚡ Найкраща серія — ${st.bestStreak} ${plural(st.bestStreak, 'день', 'дні', 'днів')} поспіль.`);
  const good = days.filter((x) => x.mood >= 4), bad = days.filter((x) => x.mood && x.mood <= 2);
  if (good.length && bad.length) {
    const avg = (a) => a.reduce((s, x) => s + x.n, 0) / a.length;
    if (avg(good) > avg(bad)) out.push(`💡 У дні з гарним настроєм ти робиш у середньому ${avg(good).toFixed(1)} справ, а в погані — ${avg(bad).toFixed(1)}. Настрій = пальне.`);
  }
  if (st.wins.length) out.push(`⭐ Відзначено ${st.wins.length} ${plural(st.wins.length, 'перемогу', 'перемоги', 'перемог')} — не забувай себе хвалити.`);
  return out;
}

function tagTotals(list) {
  const byMin = list.some((x) => x.minutes);
  const m = {};
  list.forEach((x) => { const k = x.tag || 'Без категорії'; m[k] = (m[k] || 0) + (byMin ? x.minutes || 0 : 1); });
  const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(m).map(([name, v]) => ({ name, v, share: v / total, byMin })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
}

function grade(st) {
  const r = st.active / st.totalDays;
  if (!st.list.length) return '—';
  return r >= 0.9 ? '🏆 Легендарний період' : r >= 0.7 ? '🔥 Потужно' : r >= 0.45 ? '👍 Непогано' : '🌱 Є куди рости';
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
  const ms = moneyStats(iso(range.start), iso(range.end));
  const mp = moneyStats(iso(prevRange.start), iso(prevRange.end));
  const ins = insights(st, pv, chart.days, ui.period);
  if (!st.list.length && ms.list.length) ins.length = 0;
  ins.push(...moneyInsights(ms, mp, ui.period));

  const daysHtml = chart.days.filter((x) => iso(x.d) <= todayIso()).map((x) => {
    const list = entriesOn(x.k);
    const note = data.days[x.k]?.note;
    return `<div class="rd"><h4><span>${cap(fmt(x.d, { weekday: "long", day: "numeric", month: "long" }))}</span><span>${x.mood ? MOOD[x.mood] : ''} ${x.min ? fmtHours(x.min) : ''}</span></h4>
      ${list.length ? `<ul>${list.map((e) => `<li>${e.starred ? '⭐ ' : ''}${esc(e.text)}${e.tag ? ` <span class="hint">· ${esc(e.tag)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="miss">— немає записів</div>'}
      ${note ? `<p class="day-note">${esc(note)}</p>` : ''}</div>`;
  }).reverse().join('');

  $('#report').className = 'report';
  $('#report').innerHTML = `
    <div class="report-title"><h2>${ui.period === 'week' ? 'Тиждень' : 'Місяць'}: ${esc(title)}</h2><span class="grade">${grade(st)}</span></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Зроблено справ</div><div class="value">${st.list.length}</div>${delta(st.list.length, pv.list.length)}</div>
      <div class="kpi"><div class="label">Час</div><div class="value">${fmtHours(st.minutes)}</div>${delta(st.minutes, pv.minutes)}</div>
      <div class="kpi"><div class="label">Активних днів</div><div class="value">${st.active}<span class="hint">/${st.totalDays}</span></div>${delta(st.active, pv.active)}</div>
      <div class="kpi"><div class="label">Настрій</div><div class="value">${st.mood ? MOOD[Math.round(st.mood)] + ' ' + st.mood.toFixed(1) : '—'}</div>${st.mood && pv.mood ? delta(st.mood, pv.mood) : '<span class="delta flat">з 5</span>'}</div>
      <div class="kpi"><div class="label">Перемоги</div><div class="value">⭐ ${st.wins.length}</div>${delta(st.wins.length, pv.wins.length)}</div>
      <div class="kpi"><div class="label">Найкраща серія</div><div class="value">🔥 ${st.bestStreak}</div><span class="delta flat">${plural(st.bestStreak, 'день', 'дні', 'днів')} поспіль</span></div>
    </div>
    <div class="card"><div class="card-head"><h2>${chart.useMin ? 'Час по днях' : 'Справи по днях'}</h2></div>${chart.svg}</div>
    <div class="grid-2">
      <div class="card"><h2>💡 Висновки</h2><ul class="insights">${ins.map((x) => `<li>${x}</li>`).join('')}</ul></div>
      <div class="card"><h2>🏷 За категоріями</h2>${tags.length ? `<div class="tagbars">${tags.map((t) => `<div class="tagbar"><span>${esc(t.name === 'Без категорії' ? '✅' : tagEmoji(t.name))} ${esc(t.name)}</span><div class="track"><div class="fill" style="width:${Math.max(3, (t.v / tags[0].v) * 100)}%"></div></div><span class="v">${t.byMin ? fmtHours(t.v) : t.v}</span></div>`).join('')}</div>` : '<p class="hint">Немає даних</p>'}</div>
    </div>
    ${st.wins.length ? `<div class="card"><h2>⭐ Перемоги періоду</h2><ul class="wins">${st.wins.map((w) => `<li>${esc(w.text)} <span class="hint">· ${fmt(parse(w.date), { day: 'numeric', month: 'short' })}</span></li>`).join('')}</ul></div>` : ''}
    ${moneyReportHtml(ms, mp)}
    <div class="card report-days"><h2>📅 По днях</h2>${daysHtml || '<p class="hint">Період ще не почався</p>'}</div>`;

  ui.lastReport = { key: reportKey(), md: toMarkdown(title, st, pv, tags, ins, chart.days, ms, mp) };
  if (celebrate) {
    if (st.list.length) confetti(st.active / st.totalDays >= 0.7 ? 140 : 60);
    $('#report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toMarkdown(title, st, pv, tags, ins, days, ms, mp) {
  const strip = (s) => s.replace(/<[^>]+>/g, '');
  let md = `# Звіт: ${ui.period === 'week' ? 'тиждень' : 'місяць'} ${title}\n\n`;
  md += `**Підсумок:** ${strip(grade(st))}\n\n`;
  md += `| Показник | Значення | Минулий період |\n|---|---|---|\n`;
  md += `| Зроблено справ | ${st.list.length} | ${pv.list.length} |\n| Час | ${fmtHours(st.minutes)} | ${fmtHours(pv.minutes)} |\n`;
  md += `| Активних днів | ${st.active}/${st.totalDays} | ${pv.active}/${pv.totalDays} |\n| Настрій | ${st.mood ? st.mood.toFixed(1) : '—'} | ${pv.mood ? pv.mood.toFixed(1) : '—'} |\n| Перемоги | ${st.wins.length} | ${pv.wins.length} |\n\n`;
  md += `## Висновки\n${ins.map((x) => '- ' + strip(x)).join('\n')}\n\n`;
  if (tags.length) md += `## За категоріями\n${tags.map((t) => `- ${t.name}: ${t.byMin ? fmtHours(t.v) : t.v} (${Math.round(t.share * 100)}%)`).join('\n')}\n\n`;
  if (st.wins.length) md += `## Перемоги\n${st.wins.map((w) => `- ⭐ ${w.text}`).join('\n')}\n\n`;
  if (ms && (ms.list.length || mp.list.length)) {
    md += `## Гроші\n| | Зараз | Минулий період |\n|---|---|---|\n`;
    md += `| Заробив | ${fmtMoney(ms.income)} | ${fmtMoney(mp.income)} |\n| Витратив | ${fmtMoney(ms.expense)} | ${fmtMoney(mp.expense)} |\n| Залишок | ${fmtMoney(ms.balance)} | ${fmtMoney(mp.balance)} |\n\n`;
    const exp = moneyCatTotals(ms.list, 'expense');
    if (exp.length) md += `**Витрати за категоріями:**\n${exp.map((t) => `- ${t.name}: ${fmtMoney(t.v)} (${Math.round(t.share * 100)}%)`).join('\n')}\n\n`;
  }
  md += `## По днях\n`;
  days.filter((x) => iso(x.d) <= todayIso()).forEach((x) => {
    const list = entriesOn(x.k);
    md += `\n### ${fmt(x.d, { weekday: 'long', day: 'numeric', month: 'long' })}${x.mood ? ' ' + MOOD[x.mood] : ''}\n`;
    md += list.length ? list.map((e) => `- ${e.starred ? '⭐ ' : ''}${e.text}${e.tag ? ` _(${e.tag}${e.minutes ? ', ' + fmtHours(e.minutes) : ''})_` : ''}`).join('\n') + '\n' : '- немає записів\n';
    if (data.days[x.k]?.note) md += `> ${data.days[x.k].note}\n`;
  });
  return md;
}

function ensureReport() { if (!ui.lastReport || ui.lastReport.key !== reportKey()) buildReport(false); return ui.lastReport.md; }
$('#copyReport').addEventListener('click', async () => {
  const md = ensureReport();
  try { await navigator.clipboard.writeText(md); toast('Звіт скопійовано 📋'); } catch { toast('Не вдалося скопіювати'); }
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
  if (!seen.has(monthKey) && now.getDate() <= 7 && entriesBetween(iso(lastMonth), iso(addDays(startOfMonth(now), -1))).length) target = { period: 'month', anchor: lastMonth, key: monthKey, text: `📅 Готовий звіт за ${fmt(lastMonth, { month: 'long' })}!` };
  else if (!seen.has(weekKey) && entriesBetween(iso(lastWeek), iso(addDays(lastWeek, 6))).length) target = { period: 'week', anchor: lastWeek, key: weekKey, text: '📊 Готовий звіт за минулий тиждень!' };
  if (!target) return;
  const b = $('#banner');
  b.innerHTML = `<span><b>${target.text}</b> Подивись, як минув період.</span><span><button class="btn primary" id="openAuto">Відкрити</button> <button class="btn ghost" id="closeAuto">✕</button></span>`;
  b.classList.remove('hidden');
  const markSeen = () => { seen.add(target.key); prefs.lastSeenReport = [...seen].filter(Boolean).slice(-20).join(','); savePrefs(); b.classList.add('hidden'); };
  $('#openAuto').onclick = () => {
    markSeen();
    ui.period = target.period; ui.anchor = target.anchor;
    $$('#periodSeg button').forEach((x) => x.classList.toggle('active', x.dataset.period === ui.period));
    show('reports'); renderPeriodLabel(); buildReport(true);
  };
  $('#closeAuto').onclick = markSeen;
  notify(target.text, 'Натисни, щоб відкрити звіт');
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
  notify('Хроніка: день ще не записано ✍️', 'Пара рядків про те, що зробив сьогодні — і серія не перерветься.');
  toast('✍️ Не забудь записати, що зробив сьогодні');
}

// ---------------------------------------------------------------- SETTINGS
function renderTagEditor() {
  $('#tagEditor').innerHTML = prefs.tags.map((t, i) => `<span class="chip">${esc(t.emoji)} ${esc(t.name)} <span class="x" data-del-tag="${i}" title="Видалити">✕</span></span>`).join('');
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
  toast('Категорію додано');
});

function bindPref(id, key, after) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!prefs[key]; else el.value = prefs[key];
  el.addEventListener('change', () => { prefs[key] = el.type === 'checkbox' ? el.checked : el.value; savePrefs(); after?.(); });
}
bindPref('#optAutoReport', 'autoReport', checkAutoReport);
bindPref('#optReminder', 'reminder', async () => {
  if (prefs.reminder && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  if (prefs.reminder) toast(`Нагадаю о ${prefs.reminderTime}, якщо день буде порожній`);
});
bindPref('#reminderTime', 'reminderTime');
bindPref('#optTheme', 'light', applyTheme);
bindPref('#optCurrency', 'currency', () => { renderAll(); renderMoney(); });
function applyTheme() { document.documentElement.classList.toggle('light', !!prefs.light); }

function renderCloudBox() {
  const box = $('#cloudBox');
  const { url, key } = cloudCreds();
  if (!url || !key) {
    box.innerHTML = `
      <ol class="cloud-steps">
        <li>Зайди на <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com</a> і створи безкоштовний проєкт.</li>
        <li>У <b>SQL Editor</b> виконай скрипт <a href="supabase/schema.sql" target="_blank">supabase/schema.sql</a>.</li>
        <li>У <b>Project Settings → API</b> скопіюй <span class="mono">Project URL</span> і <span class="mono">anon public</span> ключ сюди.</li>
      </ol>
      <form id="cloudForm" class="stack">
        <input id="sbUrl" placeholder="https://xxxx.supabase.co" required>
        <input id="sbKey" placeholder="anon public key (eyJ… або sb_publishable_…)" required>
        <button class="btn primary" type="submit">Підключити хмару</button>
      </form>`;
    $('#cloudForm').addEventListener('submit', (e) => {
      e.preventDefault();
      prefs.supabaseUrl = $('#sbUrl').value.trim().replace(/\/$/, '');
      prefs.supabaseKey = $('#sbKey').value.trim();
      savePrefs();
      toast('Підключаю…');
      initCloud();
    });
    return;
  }
  if (!cloud.user) {
    box.innerHTML = `
      <p>Хмару підключено ✅ Увійди через email — прийде посилання для входу, пароль не потрібен.</p>
      <form id="loginForm" class="stack">
        <input type="email" id="loginEmail" placeholder="твій@email.com" required>
        <button class="btn primary" type="submit">Отримати посилання для входу</button>
      </form>
      ${prefs.supabaseUrl ? '<p class="hint" style="margin-top:12px"><a href="#" id="resetCloud">Відключити хмару</a></p>' : ''}`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!cloud.client) { toast('Хмара не завантажилась, онови сторінку'); return; }
      const email = $('#loginEmail').value.trim();
      const { error } = await cloud.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      toast(error ? 'Помилка: ' + error.message : '📬 Посилання надіслано — перевір пошту');
    });
    $('#resetCloud')?.addEventListener('click', (e) => { e.preventDefault(); prefs.supabaseUrl = ''; prefs.supabaseKey = ''; savePrefs(); location.reload(); });
    return;
  }
  box.innerHTML = `
    <p>☁️ Синхронізацію увімкнено: <b>${esc(cloud.user.email)}</b></p>
    <p class="hint">Записи зберігаються в хмарі й доступні на всіх пристроях.</p>
    <div class="row wrap"><button class="btn" id="syncNow">Синхронізувати зараз</button><button class="btn ghost" id="logout">Вийти</button></div>`;
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
    const mIds = new Set(data.money.map((x) => x.id));
    const freshMoney = (j.money || []).filter((x) => !mIds.has(x.id)).map((x) => ({ ...x, synced: false }));
    data.money.push(...freshMoney);
    saveLocal(); savePrefs(); renderAll();
    fresh.forEach(pushEntry); Object.keys(j.days || {}).forEach(pushDay); freshMoney.forEach(pushMoney);
    toast(`Імпортовано записів: ${fresh.length}`);
  } catch { toast("Файл не схожий на бекап Хроніки"); }
  e.target.value = '';
});
$('#wipeData').addEventListener('click', async () => {
  if (!confirm('Видалити ВСІ записи' + (online() ? ' (і в хмарі теж)' : '') + '? Це не можна скасувати.')) return;
  if (online()) {
    await cloud.client.from('entries').delete().eq('user_id', cloud.user.id);
    await cloud.client.from('days').delete().eq('user_id', cloud.user.id);
    await cloud.client.from('money').delete().eq('user_id', cloud.user.id);
  }
  data = { entries: [], days: {}, money: [] }; saveLocal(); renderAll(); toast('Усе видалено');
});
$('#demoData').addEventListener('click', () => {
  const samples = {
    'Робота': ['Закрив 3 задачі в трекері', 'Дзвінок з командою', 'Розібрав пошту й чати', 'Підготував презентацію', 'Код-рев’ю двох PR'],
    'Навчання': ['Пройшов урок з JavaScript', 'Прочитав розділ книги', 'Розв’язав 5 задач на алгоритми', 'Подивився лекцію з дизайну'],
    'Проєкт': ['Зверстав головну сторінку', 'Налаштував базу даних', 'Пофіксив баг з авторизацією', 'Задеплоїв нову версію'],
    'Спорт': ['Тренування в залі', 'Пробіжка 5 км', 'Розтяжка 20 хвилин', 'Турнік і віджимання'],
    "Здоров'я": ['Ліг спати до 23:00', 'Випив 2 літри води', 'Приготував нормальну вечерю'],
    'Побут': ['Прибрав у кімнаті', 'Закупився продуктами', 'Оплатив рахунки'],
    'Відпочинок': ['Погуляв з друзями', 'Подивився фільм', 'Пограв увечері'],
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
    data.days[d] = { mood: 2 + Math.floor(Math.random() * 4), note: Math.random() < 0.15 ? 'Гарний день, вдалося сфокусуватися.' : '', synced: false };
  }
  // демо-финансы: зарплата 2 раза в месяц, подработки и ежедневные траты
  const spend = { 'Їжа': [80, 600], 'Транспорт': [30, 250], 'Кафе': [150, 900], 'Підписки': [99, 399], 'Розваги': [200, 1500], 'Покупки': [300, 3500], "Здоров'я": [150, 1200] };
  const spendKeys = Object.keys(spend);
  const tx = (date, type, amount, category, note = '') => data.money.push({ id: uid(), date, type, amount, category, note, created_at: new Date(parse(date).getTime() + 12 * 36e5).toISOString(), synced: false });
  for (let i = 75; i >= 1; i--) {
    const dt = addDays(new Date(), -i), d = iso(dt);
    if (dt.getDate() === 5 || dt.getDate() === 20) tx(d, 'income', 22000, 'Зарплата');
    if (Math.random() < 0.08) tx(d, 'income', 1000 + Math.round(Math.random() * 6) * 1000, 'Підробіток', 'Фриланс-замовлення');
    const k = Math.floor(Math.random() * 3);
    for (let j = 0; j < k; j++) { const c = spendKeys[Math.floor(Math.random() * spendKeys.length)]; const [a, b] = spend[c]; tx(d, 'expense', Math.round((a + Math.random() * (b - a)) / 10) * 10, c); }
  }
  saveLocal(); renderAll();
  if (online()) { data.entries.filter((x) => !x.synced).forEach(pushEntry); Object.keys(data.days).forEach(pushDay); data.money.filter((x) => !x.synced).forEach(pushMoney); }
  confetti(80);
  toast(`Додано ${n} демо-записів`);
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'т') { e.preventDefault(); show('today'); setTimeout(() => $('#entryText').focus(), 50); }
  if (e.key === 'm' || e.key === 'ь') { e.preventDefault(); show('money'); setTimeout(() => $('#moneyAmount').focus(), 50); }
  if (e.key === 'r' || e.key === 'к') { e.preventDefault(); show('reports'); buildReport(true); }
});

// ---------------------------------------------------------------- boot
function renderAll() {
  renderTagPicker();
  renderToday();
  renderHeatmap();
  renderFilterTags();
  if ($('#view-history').classList.contains('active')) renderHistory();
  if ($('#view-money').classList.contains('active')) renderMoney();
  if (ui.lastReport && $('#view-reports').classList.contains('active')) buildReport(false);
}

applyTheme();
renderTagEditor();
renderAll();
renderPeriodLabel();
renderCloudBox();
setSync();
const startView = location.hash.slice(1);
if (['today', 'history', 'money', 'reports', 'settings'].includes(startView)) show(startView);
checkAutoReport();
setInterval(reminderTick, 60_000);
reminderTick();
initCloud();
// перерисовать «сегодня», если вкладка открыта через полночь
let lastDay = todayIso();
setInterval(() => { if (todayIso() !== lastDay) { if (ui.date === lastDay) ui.date = todayIso(); lastDay = todayIso(); renderAll(); checkAutoReport(); } }, 60_000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
