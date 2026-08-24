"use strict";

// ---- storage ----
const STORE_KEY = "loop.days";

function loadDays() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveDays(days) {
  localStorage.setItem(STORE_KEY, JSON.stringify(days));
}

function getDay(days, date) {
  return days.find(function (d) { return d.date === date; }) || null;
}

function upsertDay(day) {
  const days = loadDays();
  const i = days.findIndex(function (d) { return d.date === day.date; });
  if (i >= 0) days[i] = day; else days.push(day);
  saveDays(days);
  return day;
}

// most recent record strictly before the given date (by date string)
function mostRecentBefore(days, date) {
  const past = days
    .filter(function (d) { return d.date < date; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  return past[0] || null;
}

// ---- date helpers (local time; accept `now` for testability) ----
function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function dateStr(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function todayStr(now) { return dateStr(now || new Date()); }

function tomorrowStr(now) {
  const d = new Date(now || new Date());
  d.setDate(d.getDate() + 1);
  return dateStr(d);
}

function formatKoDate(dateString) {
  const parts = dateString.split("-");
  return Number(parts[1]) + "월 " + Number(parts[2]) + "일";
}

// ---- timer (pure, time-based) ----
const DURATION_MS = 60 * 60 * 1000; // 60 minutes

function remainingMs(startedAtISO, now) {
  const started = new Date(startedAtISO).getTime();
  return DURATION_MS - ((now || new Date()).getTime() - started);
}

function fmtMMSS(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return pad2(mm) + ":" + pad2(ss);
}

// morning state machine (pure). caller persists on "expired".
function morningState(record, now) {
  if (!record) return { mode: "empty" };
  if (record.completed) return { mode: "done" };
  if (!record.started_at) return { mode: "ready", task: record.task };
  const rem = remainingMs(record.started_at, now);
  if (rem <= 0) return { mode: "expired", task: record.task };
  return { mode: "running", task: record.task, remainingMs: rem };
}

// ---- screen dispatch ----
// 21:00–03:59 -> night, 04:00–20:59 -> morning
function currentScreen(now) {
  const h = (now || new Date()).getHours();
  return (h >= 21 || h < 4) ? "night" : "morning";
}

// ---- night view (pure) ----
// evening (21:00–23:59): plan/edit tomorrow.
// locked  (00:00–03:59): read-only view of the upcoming morning's task.
function nightView(now, days) {
  const h = now.getHours();
  if (h >= 21) {
    const target = tomorrowStr(now);
    const rec = getDay(days, target);
    return { mode: "evening", target: target, task: rec ? rec.task : null, confirmed: !!rec };
  }
  const upcoming = todayStr(now);
  const rec = getDay(days, upcoming);
  const carried = rec ? null : mostRecentBefore(days, upcoming);
  return { mode: "locked", target: upcoming, task: rec ? rec.task : (carried ? carried.task : null) };
}

function confirmTask(target, task, now) {
  return upsertDay({
    date: target,
    task: task,
    planned_at: (now || new Date()).toISOString(),
    started_at: null,
    completed: false,
    source: "manual",
    away_ms: 0
  });
}

// ---- render ----
let tickHandle = null;

function render() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  const root = document.getElementById("screen");
  root.innerHTML = "";
  if (currentScreen() === "night") renderNight(root);
  else renderMorning(root);
}

function el(tag, opts) {
  const n = document.createElement(tag);
  if (opts && opts.text != null) n.textContent = opts.text;
  if (opts && opts.cls) n.className = opts.cls;
  return n;
}

function renderNight(root) {
  const now = new Date();
  const view = nightView(now, loadDays());

  if (view.mode === "locked") {
    root.appendChild(el("p", { text: "다가올 오전", cls: "label" }));
    root.appendChild(el("p", { text: view.task || "", cls: "task" }));
    return;
  }

  // evening
  root.appendChild(el("p", { text: formatKoDate(view.target) + " 오전", cls: "label" }));

  if (view.confirmed) {
    renderNightConfirmed(root, view);
  } else {
    renderNightInput(root, view.target, "");
  }
}

function renderNightConfirmed(root, view) {
  root.appendChild(el("p", { text: view.task, cls: "task" }));
  const edit = el("button", { text: "수정", cls: "edit" });
  edit.addEventListener("click", function () {
    root.innerHTML = "";
    root.appendChild(el("p", { text: formatKoDate(view.target) + " 오전", cls: "label" }));
    renderNightInput(root, view.target, view.task);
  });
  root.appendChild(edit);
}

function renderNightInput(root, target, initial) {
  const input = el("input", { cls: "input" });
  input.type = "text";
  input.placeholder = "내일 오전: ____ 60분";
  input.value = initial || "";
  input.autofocus = true;

  const btn = el("button", { text: "확정", cls: "confirm" });
  function submit() {
    const task = input.value.trim();
    if (!task) return;
    confirmTask(target, task, new Date());
    render();
  }
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

  root.appendChild(input);
  root.appendChild(btn);
}

// ---- rule 1: auto-copy (pure decision) ----
// returns the record that should exist for `today`, or null if no history to carry.
function carryRecord(days, today, now) {
  const existing = getDay(days, today);
  if (existing) return existing;
  const recent = mostRecentBefore(days, today);
  if (!recent) return null;
  return {
    date: today,
    task: recent.task,
    planned_at: now.toISOString(),
    started_at: null,
    completed: false,
    source: "carried",
    away_ms: 0
  };
}

// materialize today's record (creating a carried one if needed)
function ensureToday(now) {
  const today = todayStr(now);
  const days = loadDays();
  const existing = getDay(days, today);
  if (existing) return existing;
  const rec = carryRecord(days, today, now);
  if (rec) upsertDay(rec);
  return rec;
}

// ---- morning ----
function markCompleted(date) {
  const days = loadDays();
  const rec = getDay(days, date);
  if (rec && !rec.completed) { rec.completed = true; upsertDay(rec); }
}

function renderMorning(root) {
  const now = new Date();
  const today = todayStr(now);
  const record = ensureToday(now); // rule 1: never empty when history exists
  const state = morningState(record, now);

  if (state.mode === "empty") {
    // first-ever run: nothing to carry yet -> allow planning today's one thing now
    root.appendChild(el("p", { text: "오늘 오전", cls: "label" }));
    const input = el("input", { cls: "input" });
    input.type = "text";
    input.placeholder = "오늘 오전: ____ 60분";
    input.autofocus = true;
    const btn = el("button", { text: "확정", cls: "confirm" });
    function submit() {
      const task = input.value.trim();
      if (!task) return;
      confirmTask(today, task, new Date());
      render();
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    root.appendChild(input);
    root.appendChild(btn);
    return;
  }
  if (state.mode === "done") {
    root.appendChild(el("p", { text: "완료", cls: "task" }));
    return;
  }
  if (state.mode === "expired") {
    markCompleted(today);
    root.appendChild(el("p", { text: "완료", cls: "task" }));
    return;
  }
  if (state.mode === "ready") {
    root.appendChild(el("p", { text: state.task, cls: "task" }));
    const btn = el("button", { text: "시작", cls: "start" });
    btn.addEventListener("click", function () {
      const days = loadDays();
      const rec = getDay(days, today);
      if (rec && !rec.started_at) { rec.started_at = new Date().toISOString(); upsertDay(rec); }
      render();
    });
    root.appendChild(btn);
    return;
  }
  // running
  const timer = el("p", { text: fmtMMSS(state.remainingMs), cls: "timer" });
  root.appendChild(timer);
  tickHandle = setInterval(function () {
    const rec = getDay(loadDays(), today);
    const rem = remainingMs(rec.started_at, new Date());
    if (rem <= 0) { clearInterval(tickHandle); tickHandle = null; render(); return; }
    timer.textContent = fmtMMSS(rem);
  }, 250);
}

// ---- exports for node tests (no effect in browser) ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = { nightView, currentScreen, todayStr, tomorrowStr, mostRecentBefore, getDay, morningState, remainingMs, fmtMMSS, DURATION_MS, carryRecord };
}

// ---- rule 2: measure (never display) time away during a running timer ----
let hiddenAt = null;

function onHide() {
  const rec = getDay(loadDays(), todayStr());
  if (rec && rec.started_at && !rec.completed) hiddenAt = Date.now();
}

function onShow() {
  if (hiddenAt != null) {
    const delta = Date.now() - hiddenAt;
    hiddenAt = null;
    const days = loadDays();
    const rec = getDay(days, todayStr());
    if (rec && rec.started_at && !rec.completed) {
      rec.away_ms = (rec.away_ms || 0) + delta;
      upsertDay(rec);
    }
  }
  render(); // time-based timer catches up; may transition to completed
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) onHide(); else onShow();
  });
  render();
}
