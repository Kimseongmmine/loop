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

// ---- suggestions (pre-fill so the box is never blank; deterministic per date) ----
const PRESETS = [
  "자격증 인강 1강 듣고 필기",
  "포트폴리오 기능 1개 만들기",
  "전공서 10페이지 읽고 요약 1장",
  "지원할 인턴·대외활동 3개 찾아 저장",
  "어제 만든 것 이어서 정리"
];

function suggestionFor(dateString) {
  const parts = dateString.split("-").map(Number);
  const key = parts[0] * 372 + parts[1] * 31 + parts[2]; // stable per calendar day
  return PRESETS[key % PRESETS.length];
}

// ---- AI suggestion via OpenRouter (optional; falls back to presets) ----
const OR_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OR_DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const OR_KEY = "loop.or_key";
const OR_MODEL = "loop.or_model";

function getKey() { try { return localStorage.getItem(OR_KEY) || ""; } catch (e) { return ""; } }
function setKey(k) { try { localStorage.setItem(OR_KEY, k); } catch (e) {} }
function getModel() { try { return localStorage.getItem(OR_MODEL) || OR_DEFAULT_MODEL; } catch (e) { return OR_DEFAULT_MODEL; } }

const AI_SYSTEM = [
  "너는 대학 3학년 남학생의 하루 계획을 짜주는 코치다.",
  "이 사람은 스스로 시작·지속하는 힘이 약해서, 아침에 '뭘 할지 고르는 것' 자체를 못한다.",
  "그래서 너가 오늘 아침에 할 '단 하나'를 대신 정해준다.",
  "목표: 자격증 1개 취득, 자기 이름 붙은 결과물 1개, 실무 경험, 전공서 읽기.",
  "규칙: 딱 60분 분량. 아침에 혼자 할 수 있는 것. 작고 구체적. 몰아치기 금지.",
  "최근에 완료한 것과 비슷하면 다음 단계로, 계속 미룬 것이면 더 잘게 쪼개서 제안.",
  "출력은 한국어 한 줄, 25자 이내, 할 일만. 따옴표·설명·이모지·번호 금지."
].join(" ");

function buildUserPrompt(dateString, days) {
  const wd = ["일", "월", "화", "수", "목", "금", "토"];
  const parts = dateString.split("-").map(Number);
  const dow = wd[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
  const recent = days
    .filter(function (d) { return d.date < dateString; })
    .sort(function (a, b) { return a.date < b.date ? 1 : -1; })
    .slice(0, 7)
    .map(function (d) { return d.date + " " + (d.completed ? "완료" : "미완료") + ": " + d.task; });
  return "오늘은 " + dateString + " (" + dow + "요일).\n" +
    (recent.length ? "최근 기록:\n" + recent.join("\n") : "기록 없음(첫날).") +
    "\n오늘 오전에 할 단 하나를 정해줘.";
}

function cleanLine(text) {
  let s = String(text).split("\n").find(function (l) { return l.trim(); }) || "";
  s = s.trim().replace(/^["'`\-•\d.\)\s]+/, "").replace(/["'`]+$/, "").trim();
  return s.length > 40 ? s.slice(0, 40) : s;
}

async function fetchSuggestion(dateString, key) {
  const body = {
    model: getModel(),
    max_tokens: 60,
    temperature: 0.7,
    messages: [
      { role: "system", content: AI_SYSTEM },
      { role: "user", content: buildUserPrompt(dateString, loadDays()) }
    ]
  };
  const res = await fetch(OR_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) return null;
  const data = await res.json();
  const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const line = txt ? cleanLine(txt) : "";
  return line || null;
}

// non-blocking: keep the seeded preset, swap in the AI line only if it arrives
// and the user hasn't started editing.
function attachSuggestion(input, dateString) {
  if (typeof fetch === "undefined") return;
  const key = getKey();
  if (!key) return;
  const seeded = input.value;
  fetchSuggestion(dateString, key).then(function (s) {
    if (s && input.isConnected && input.value === seeded) input.value = s;
  }).catch(function () {});
}

// tiny one-time key entry; shown only until a key exists
function keyLink() {
  const link = el("button", { text: "🔑 맞춤추천 켜기", cls: "edit" });
  link.addEventListener("click", function () {
    const k = window.prompt("OpenRouter API 키를 붙여넣으세요 (sk-or-... ):", "");
    if (k && k.trim()) { setKey(k.trim()); render(); }
  });
  return link;
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
    renderNightInput(root, view.target, suggestionFor(view.target));
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
  if (!getKey()) root.appendChild(keyLink());
  attachSuggestion(input, target);
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
    input.value = suggestionFor(today);
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
    if (!getKey()) root.appendChild(keyLink());
    attachSuggestion(input, today);
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
  module.exports = { nightView, currentScreen, todayStr, tomorrowStr, mostRecentBefore, getDay, morningState, remainingMs, fmtMMSS, DURATION_MS, carryRecord, buildUserPrompt, cleanLine, suggestionFor };
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
