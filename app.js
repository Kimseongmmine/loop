"use strict";

// =====================================================================
// LOOP v1 — AI 계획 대시보드
// 접속 → AI가 목표 분석해 오늘 시간표 생성 → 진행도/스트릭 표시
// =====================================================================

// ---- generic storage ----
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

const K_PROFILE = "loop.profile";
const K_PLANS = "loop.plans";
const K_VISITS = "loop.visits";
const K_ORKEY = "loop.or_key";
const K_ORMODEL = "loop.or_model";

function loadProfile() {
  const p = lsGet(K_PROFILE, { goals: [] });
  if (!p || !Array.isArray(p.goals)) return { goals: [] };
  return p;
}
function saveProfile(p) { lsSet(K_PROFILE, p); }

function loadPlans() { return lsGet(K_PLANS, {}) || {}; }
function savePlans(p) { lsSet(K_PLANS, p); }

function loadVisits() { const v = lsGet(K_VISITS, []); return Array.isArray(v) ? v : []; }
function saveVisits(v) { lsSet(K_VISITS, v); }

// ---- date helpers (local; accept `now`) ----
function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function dateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayStr(now) { return dateStr(now || new Date()); }
function addDays(dateString, delta) {
  const p = dateString.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + delta);
  return dateStr(d);
}
function genId(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

// ---- visits / streak (pure) ----
function recordVisit(visits, today) {
  if (visits.indexOf(today) === -1) return visits.concat([today]);
  return visits;
}
// consecutive days ending at `today` (today must be present)
function computeStreak(visits, today) {
  const set = {};
  visits.forEach(function (d) { set[d] = true; });
  if (!set[today]) return 0;
  let n = 0, cur = today;
  while (set[cur]) { n++; cur = addDays(cur, -1); }
  return n;
}
// last `days` dates (oldest→newest) with visited flag, for the dot grid
function visitGrid(visits, today, days) {
  const set = {};
  visits.forEach(function (d) { set[d] = true; });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    out.push({ date: d, visited: !!set[d] });
  }
  return out;
}

// ---- goals / progress (pure) ----
function goalProgress(goal) {
  const tasks = (goal && goal.tasks) || [];
  const total = tasks.length;
  const done = tasks.filter(function (t) { return t.done; }).length;
  return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
}
function findGoal(profile, goalId) {
  return profile.goals.find(function (g) { return g.id === goalId; }) || null;
}
// next undone task per goal, up to `n` items total (round-robin across goals)
function nextPendingTasks(profile, n) {
  const queues = profile.goals.map(function (g) {
    return { goal: g, tasks: (g.tasks || []).filter(function (t) { return !t.done; }) };
  });
  const out = [];
  let i = 0;
  while (out.length < n) {
    let progressed = false;
    for (let q = 0; q < queues.length; q++) {
      const qq = queues[q];
      if (qq.tasks[i]) {
        out.push({ goalId: qq.goal.id, goalTitle: qq.goal.title, taskId: qq.tasks[i].id, text: qq.tasks[i].text });
        progressed = true;
        if (out.length >= n) break;
      }
    }
    if (!progressed) break;
    i++;
  }
  return out;
}

// ---- OpenRouter plumbing (reused from v0) ----
const OR_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OR_DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
function getKey() { try { return localStorage.getItem(K_ORKEY) || ""; } catch (e) { return ""; } }
function setKey(k) { try { localStorage.setItem(K_ORKEY, k); } catch (e) {} }
function getModel() { try { return localStorage.getItem(K_ORMODEL) || OR_DEFAULT_MODEL; } catch (e) { return OR_DEFAULT_MODEL; } }

// tolerant JSON extraction from a model reply (handles ```json fences, prose around it)
function extractJSON(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

async function orChat(messages, maxTokens) {
  const key = getKey();
  if (!key || typeof fetch === "undefined") return null;
  try {
    const res = await fetch(OR_ENDPOINT, {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: getModel(), max_tokens: maxTokens || 800, temperature: 0.6, messages: messages })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;
  } catch (e) { return null; }
}

// ---- render stubs (filled in later steps) ----
function render() {
  const root = document.getElementById("screen");
  if (!root) return;
  root.textContent = "LOOP v1";
}

// bootstrap: record today's visit, then render
function boot() {
  const today = todayStr();
  const visits = recordVisit(loadVisits(), today);
  saveVisits(visits);
  render();
}

// ---- exports for node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeStreak, visitGrid, recordVisit, goalProgress, nextPendingTasks,
    findGoal, extractJSON, todayStr, dateStr, addDays, pad2
  };
}

if (typeof document !== "undefined") boot();
