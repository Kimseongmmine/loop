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
function render() {
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

// ---- stub (filled in step 3) ----
function renderMorning(root) {
  root.textContent = "morning";
}

// ---- exports for node tests (no effect in browser) ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = { nightView, currentScreen, todayStr, tomorrowStr, mostRecentBefore, getDay };
}

if (typeof document !== "undefined") render();
