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

// profile text fields the user fills in (all optional), fed to the AI planner
const PROFILE_FIELDS = [
  { key: "fixed", label: "고정 일정 (수업·알바)", ph: "예: 월수금 9-12 전공수업 / 화 알바 18-22 / 목 공강" },
  { key: "rhythm", label: "하루 리듬", ph: "예: 8시 기상 1시 취침 / 오전 집중 잘됨 / 밥 먹고 나면 졸림" },
  { key: "traits", label: "나의 특성", ph: "예: 쉽게 지침 / 1시간 넘으면 딴짓 / 시작이 어려움" },
  { key: "prefs", label: "선호·비선호", ph: "예: 운동은 수영 / 아침 일찍은 싫음 / 카페에서 집중 잘됨" }
];

function loadProfile() {
  const p = lsGet(K_PROFILE, { goals: [] });
  if (!p || !Array.isArray(p.goals)) return { goals: [] };
  // migrate legacy `situation` -> `traits`
  if (p.situation && !p.traits) { p.traits = p.situation; delete p.situation; }
  return p;
}
function saveProfile(p) { lsSet(K_PROFILE, p); }

// assemble the user's profile into a context string for the AI (pure)
function profileContext(profile) {
  const lines = [];
  const f = (profile.fixed || "").trim();
  const r = (profile.rhythm || "").trim();
  const t = (profile.traits || "").trim();
  const pr = (profile.prefs || "").trim();
  if (f) lines.push("고정 일정(이 시간대는 반드시 비워두거나 이동/식사로, 학습 블록 금지): " + f);
  if (r) lines.push("하루 리듬(기상~취침 안에서, 집중 잘 되는 시간에 핵심 배치): " + r);
  if (t) lines.push("나의 특성(강도·휴식 조절에 반영): " + t);
  if (pr) lines.push("선호·비선호: " + pr);
  const deadlines = (profile.goals || [])
    .filter(function (g) { return g.deadline; })
    .map(function (g) { return "- " + g.title + ": 마감 " + g.deadline; });
  if (deadlines.length) lines.push("마감 있는 목표(급한 것을 앞쪽·핵심으로):\n" + deadlines.join("\n"));
  return lines.join("\n");
}

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
// which day a "계획 생성" targets: night (21:00~) -> tomorrow, else today
function activeDate(now) {
  now = now || new Date();
  return now.getHours() >= 21 ? addDays(todayStr(now), 1) : todayStr(now);
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
// 무료 모델 목록은 수시로 바뀜. orChat이 아래 순서로 자동 시도해 되는 걸 찾음.
// thinkingmachines/* 는 게이팅됨(403 "agentic harnesses only") → 제외
const OR_FREE_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "poolside/laguna-s-2.1:free",
  "dots-studio/dots-3-note-preview:free",
  "liquid/lfm-2.5-2.6b:free"
];
const OR_DEFAULT_MODEL = OR_FREE_MODELS[0];
function getKey() { try { return localStorage.getItem(K_ORKEY) || ""; } catch (e) { return ""; } }
function setKey(k) { try { localStorage.setItem(K_ORKEY, k); } catch (e) {} }
function getModel() { try { return localStorage.getItem(K_ORMODEL) || OR_DEFAULT_MODEL; } catch (e) { return OR_DEFAULT_MODEL; } }
function setModel(m) { try { localStorage.setItem(K_ORMODEL, m); } catch (e) {} }

// ---- Google Gemini (more reliable free tier; preferred when a key is set) ----
const K_GEMKEY = "loop.gemini_key";
const K_GEMMODEL = "loop.gemini_model";
const GEM_DEFAULT_MODEL = "gemini-2.0-flash";
function getGemKey() { try { return localStorage.getItem(K_GEMKEY) || ""; } catch (e) { return ""; } }
function setGemKey(k) { try { localStorage.setItem(K_GEMKEY, k); } catch (e) {} }
function getGemModel() { try { return localStorage.getItem(K_GEMMODEL) || GEM_DEFAULT_MODEL; } catch (e) { return GEM_DEFAULT_MODEL; } }
function hasAI() { return (getGemKey() || getKey()) && typeof fetch !== "undefined"; }

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

// parse a task list from a model reply: JSON {tasks:[...]} OR a plain numbered/bulleted list.
// small free models produce lists far more reliably than JSON.
function parseTaskList(content) {
  const j = extractJSON(content);
  if (j && Array.isArray(j.tasks) && j.tasks.length) {
    return j.tasks.map(function (t) { return String(t).trim(); }).filter(Boolean);
  }
  const raw = String(content || "").split("\n");
  const marker = /^\s*(?:[-*•]|\d+[\.\)])\s+/;
  // prefer lines that carry a list marker; drop the marker + wrapping quotes
  const marked = raw.filter(function (l) { return marker.test(l); })
    .map(function (l) { return l.replace(marker, "").replace(/^["'`]+|["'`,]+$/g, "").trim(); })
    .filter(function (l) { return l.length >= 2 && l.length <= 80; });
  if (marked.length >= 3) return marked;
  // fallback: plain lines, dropping colon-ending preambles and bracket/JSON noise
  const plain = raw.map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length >= 2 && l.length <= 80 && !/[:：]$/.test(l) && !/^[{}\[\]]/.test(l); });
  return plain.length >= 3 ? plain : null;
}

let lastAIError = "";

async function orOnce(key, model, messages, maxTokens) {
  const res = await fetch(OR_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://kimseongmmine.github.io/loop/",
      "X-Title": "LOOP"
    },
    body: JSON.stringify({ model: model, max_tokens: maxTokens || 800, temperature: 0.6, messages: messages })
  });
  if (!res.ok) {
    let body = ""; try { body = await res.text(); } catch (e) {}
    let msg = body;
    try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error.code)) || body; } catch (e) {}
    return { ok: false, status: res.status, error: String(msg).slice(0, 220) };
  }
  const data = await res.json();
  const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!c) return { ok: false, status: 200, error: "빈 응답 · " + JSON.stringify(data).slice(0, 200) };
  return { ok: true, content: c };
}

// try the saved model first, then rotate through the free list.
// `parse` (optional): content -> value|null. A 200 whose content fails to parse
// is treated as a miss for THAT model, so we rotate to the next one.
async function orChat(messages, maxTokens, parse) {
  const key = getKey();
  if (!key || typeof fetch === "undefined") { lastAIError = "API 키가 없습니다."; return null; }
  const tried = {};
  const order = [getModel()].concat(OR_FREE_MODELS).filter(function (m) {
    if (!m || tried[m]) return false; tried[m] = true; return true;
  });
  let last = "";
  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    try {
      const r = await orOnce(key, model, messages, maxTokens);
      if (r.ok) {
        if (parse) {
          const v = parse(r.content);
          if (v != null) { setModel(model); lastAIError = ""; return v; }
          last = "응답을 JSON으로 못 읽음 [" + model + "] · " + String(r.content).replace(/\s+/g, " ").slice(0, 140);
          continue; // this model replied but not usable JSON → try next
        }
        setModel(model); lastAIError = ""; return r.content;
      }
      last = "HTTP " + r.status + " · " + r.error + " [" + model + "]";
      // 401 = 키 자체 문제(모든 모델 무의미) → 중단. 403은 그 모델만 막힌 것 → 다음 모델로.
      if (r.status === 401) break;
    } catch (e) {
      last = "네트워크 오류 · " + (e && e.message ? e.message : e);
    }
  }
  lastAIError = last;
  return null;
}

// Google Gemini — single reliable call with JSON-friendly output
async function geminiChat(messages, maxTokens, parse) {
  const key = getGemKey();
  if (!key || typeof fetch === "undefined") { lastAIError = "Gemini 키가 없습니다."; return null; }
  const sys = messages.filter(function (m) { return m.role === "system"; }).map(function (m) { return m.content; }).join("\n");
  const userParts = messages.filter(function (m) { return m.role !== "system"; }).map(function (m) { return { text: m.content }; });
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + getGemModel() + ":generateContent?key=" + encodeURIComponent(key);
  const body = { contents: [{ role: "user", parts: userParts }], generationConfig: { maxOutputTokens: maxTokens || 900, temperature: 0.6 } };
  if (sys) body.system_instruction = { parts: [{ text: sys }] };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      let b = ""; try { b = await res.text(); } catch (e) {}
      let msg = b; try { const j = JSON.parse(b); msg = (j.error && j.error.message) || b; } catch (e) {}
      lastAIError = "Gemini HTTP " + res.status + " · " + String(msg).slice(0, 200);
      return null;
    }
    const data = await res.json();
    const cand = data && data.candidates && data.candidates[0];
    const c = cand && cand.content && cand.content.parts && cand.content.parts.map(function (p) { return p.text || ""; }).join("");
    if (!c) { lastAIError = "Gemini 빈 응답 · " + JSON.stringify(data).slice(0, 200); return null; }
    if (parse) {
      const v = parse(c);
      if (v != null) { lastAIError = ""; return v; }
      lastAIError = "Gemini 응답을 못 읽음 · " + String(c).replace(/\s+/g, " ").slice(0, 140);
      return null;
    }
    lastAIError = "";
    return c;
  } catch (e) { lastAIError = "Gemini 네트워크 오류 · " + (e && e.message ? e.message : e); return null; }
}

// route to whichever provider has a key (Gemini preferred for reliability)
async function aiChat(messages, maxTokens, parse) {
  if (getGemKey()) return geminiChat(messages, maxTokens, parse);
  return orChat(messages, maxTokens, parse);
}

// ---- plan building (pure) ----
// fixed realistic schedule; core = up to 3 study blocks carrying a task
function templatePlan(candidates) {
  const c = candidates || [];
  function study(i, time) {
    if (c[i]) return { id: genId("b"), time: time, text: c[i].text, goalId: c[i].goalId, taskId: c[i].taskId, core: true, done: false };
    return { id: genId("b"), time: time, text: "딥워크 (자유)", goalId: null, taskId: null, core: false, done: false };
  }
  function life(time, text) { return { id: genId("b"), time: time, text: text, goalId: null, taskId: null, core: false, done: false }; }
  return [
    study(0, "09:00-11:00"),
    study(1, "11:00-12:00"),
    life("12:00-13:00", "점심"),
    life("13:00-14:00", "휴식 · 산책"),
    study(2, "14:00-16:00"),
    life("16:00-17:00", "운동 (수영 우선)"),
    life("17:00-19:00", "저녁 · 휴식"),
    c[3] ? { id: genId("b"), time: "19:00-21:00", text: c[3].text, goalId: c[3].goalId, taskId: c[3].taskId, core: false, done: false }
         : life("19:00-21:00", "가벼운 복습 · 정리"),
    life("21:00-22:00", "오늘 기록 · 독서")
  ];
}

// map AI-returned blocks to Block objects, resolving `ref` index into candidates
function mapAIBlocks(aiBlocks, candidates) {
  if (!Array.isArray(aiBlocks)) return null;
  const out = aiBlocks.map(function (b) {
    const ref = (typeof b.ref === "number") ? candidates[b.ref] : null;
    return {
      id: genId("b"),
      time: String(b.time || "").slice(0, 20),
      text: String((ref ? (b.text || ref.text) : b.text) || "").slice(0, 80),
      goalId: ref ? ref.goalId : null,
      taskId: ref ? ref.taskId : null,
      core: !!b.core,
      done: false
    };
  }).filter(function (b) { return b.text; });
  if (!out.length) return null;
  // clamp core to at most 3; if none marked but tasks exist, mark first up-to-3 task blocks
  let coreCount = out.filter(function (b) { return b.core; }).length;
  if (coreCount === 0) {
    let n = 0;
    out.forEach(function (b) { if (b.taskId && n < 3) { b.core = true; n++; } });
  } else if (coreCount > 3) {
    let n = 0;
    out.forEach(function (b) { if (b.core) { n++; if (n > 3) b.core = false; } });
  }
  return out;
}

function coreStatus(blocks) {
  const core = (blocks || []).filter(function (b) { return b.core; });
  return { done: core.filter(function (b) { return b.done; }).length, total: core.length };
}

// toggle a block; sync its linked goal task
function setBlockDone(date, blockId, checked) {
  const plans = loadPlans();
  const plan = plans[date];
  if (!plan) return;
  const block = plan.blocks.find(function (b) { return b.id === blockId; });
  if (!block) return;
  block.done = checked;
  savePlans(plans);
  if (block.taskId) {
    const profile = loadProfile();
    for (let i = 0; i < profile.goals.length; i++) {
      const t = (profile.goals[i].tasks || []).find(function (x) { return x.id === block.taskId; });
      if (t) { t.done = checked; saveProfile(profile); break; }
    }
  }
}

// ---- AI flows ----
async function aiBreakdownGoal(goal) {
  const sys = "너는 학습 코치다. 목표를 '실제로 완수하려면 뭘 해야 하는지' 구체적 실행 과제로 쪼갠다. " +
    "규칙: 각 과제는 한 번에 60분 안에 끝낼 수 있어야 하고, '무엇을 얼마나' 명확해야 한다. " +
    "추상적 표현 금지('공부하기','정리하기','복습하기' 같은 것 금지). " +
    "구체적으로('3장 연습문제 1~10번 풀기','1강 강의 듣고 필기 2쪽','기출 2회분 채점까지'). " +
    "5~8개, 쉬운 것부터 순서대로. 한국어. 번호 목록으로, 한 줄에 하나씩만 출력. 설명·인사 금지.";
  const traits = (loadProfile().traits || "").trim();
  const usr = "목표: " + goal.title +
    (goal.deadline ? ("\n마감: " + goal.deadline) : "") +
    (goal.note ? ("\n메모: " + goal.note) : "") +
    (traits ? ("\n내 특성(참고): " + traits) : "") +
    "\n\n이 목표를 완수하기 위한 구체적 과제 목록:";
  const list = await aiChat([{ role: "system", content: sys }, { role: "user", content: usr }], 500, parseTaskList);
  if (list) {
    return list.slice(0, 10).map(function (t) { return { id: genId("t"), text: String(t).slice(0, 70), done: false }; });
  }
  return null;
}

async function aiGeneratePlan(candidates) {
  const sys = "너는 대학 3학년의 하루 시간표를 짜는 코치다. 이 사람은 쉽게 지치고 미룬다. " +
    "아래 '내 프로필'을 최우선으로 반영해라: 고정 일정 시간대는 절대 학습 블록으로 쓰지 말고 그대로 두거나 이동/식사로 채운다. " +
    "하루 리듬의 기상~취침 시간 안에서만 짜고, 집중 잘 되는 시간대에 핵심 학습을 배치한다. " +
    "현실적으로: 딥워크 사이에 휴식·이동·식사, 저녁은 가볍게, 강도 절반, 몰아치기 금지. " +
    "후보 과제를 시간표에 배치하고(각 블록 ref에 후보 index), 휴식/식사/운동/고정일정 같은 생활 블록은 ref 없이 넣어라. " +
    "가장 중요한 3개 학습 블록에만 core:true. 오직 JSON만: {\"blocks\":[{\"time\":\"09:00-11:00\",\"text\":\"...\",\"ref\":0,\"core\":true}]}";
  const ctx = profileContext(loadProfile());
  const list = candidates.map(function (c, i) { return i + ": " + c.text + " (" + c.goalTitle + ")"; }).join("\n");
  const usr =
    (ctx ? ("[내 프로필]\n" + ctx + "\n\n") : "") +
    "[후보 과제]\n" + (list || "(없음)") +
    "\n\n위를 반영해 시간표를 JSON으로.";
  const parse = function (c) { const j = extractJSON(c); return (j && Array.isArray(j.blocks) && j.blocks.length) ? j.blocks : null; };
  const blocks = await aiChat([{ role: "system", content: sys }, { role: "user", content: usr }], 900, parse);
  if (blocks) return mapAIBlocks(blocks, candidates);
  return null;
}

// on-demand plan generation for a target date. shows loading, falls back to template.
let generating = false;
let breaking = null; // goalId currently being broken down by AI

async function breakdownGoalNow(goalId) {
  if (breaking) return;
  const profile = loadProfile();
  const goal = findGoal(profile, goalId);
  if (!goal) return;
  breaking = goalId;
  render();
  try {
    const tasks = await aiBreakdownGoal(goal);
    if (tasks) {
      const p = loadProfile();
      const g = findGoal(p, goalId);
      if (g) { g.tasks = (g.tasks || []).concat(tasks); g.analyzedAt = new Date().toISOString(); saveProfile(p); }
    }
  } catch (e) {} finally {
    breaking = null;
    render();
  }
}
async function generatePlan(targetDate) {
  if (generating) return;
  generating = true;
  render(); // loading state

  try {
    const aiOn = hasAI();
    // 1) break down any goal that has no tasks (AI)
    if (aiOn) {
      const profile = loadProfile();
      let changed = false;
      for (let i = 0; i < profile.goals.length; i++) {
        const g = profile.goals[i];
        if (!g.tasks || g.tasks.length === 0) {
          const tasks = await aiBreakdownGoal(g);
          if (tasks) { g.tasks = tasks; g.analyzedAt = new Date().toISOString(); changed = true; }
        }
      }
      if (changed) saveProfile(profile);
    }
    // 2) build the hourly plan (AI, else template)
    const candidates = nextPendingTasks(loadProfile(), 6);
    let blocks = null, source = "template";
    if (aiOn) { blocks = await aiGeneratePlan(candidates); if (blocks) source = "ai"; }
    if (!blocks) { blocks = templatePlan(candidates); source = "template"; }
    const plans = loadPlans();
    plans[targetDate] = { blocks: blocks, generatedAt: new Date().toISOString(), source: source };
    savePlans(plans);
  } catch (e) {
    // last-resort template so the button never leaves an empty screen
    const plans = loadPlans();
    if (!plans[targetDate]) {
      plans[targetDate] = { blocks: templatePlan(nextPendingTasks(loadProfile(), 6)), generatedAt: new Date().toISOString(), source: "template" };
      savePlans(plans);
    }
  } finally {
    generating = false;
    render();
  }
}

// ---- DOM helpers ----
function el(tag, opts) {
  const n = document.createElement(tag);
  if (opts) {
    if (opts.text != null) n.textContent = opts.text;
    if (opts.cls) n.className = opts.cls;
    if (opts.html != null) n.innerHTML = opts.html;
  }
  return n;
}

// ---- render ----
function render() {
  const root = document.getElementById("screen");
  if (!root) return;
  root.innerHTML = "";
  root.appendChild(renderHeader());
  root.appendChild(renderProgress());
  root.appendChild(renderToday());
  root.appendChild(renderSettings());
}

function renderHeader() {
  const box = el("section", { cls: "hdr" });
  const today = todayStr();
  box.appendChild(el("div", { cls: "date", text: today }));
  const streak = computeStreak(loadVisits(), today);
  box.appendChild(el("div", { cls: "streak", text: "🔥 " + streak + "일 연속 접속" }));
  const grid = el("div", { cls: "grid" });
  visitGrid(loadVisits(), today, 28).forEach(function (d) {
    const dot = el("span", { cls: "dot" + (d.visited ? " on" : "") });
    dot.title = d.date;
    grid.appendChild(dot);
  });
  box.appendChild(grid);
  return box;
}

function renderProgress() {
  const box = el("section", { cls: "prog" });
  box.appendChild(el("h2", { text: "진행도" }));
  const profile = loadProfile();
  if (!profile.goals.length) {
    box.appendChild(el("p", { cls: "muted", text: "아래 설정에서 목표를 추가하세요." }));
    return box;
  }
  profile.goals.forEach(function (g) {
    const p = goalProgress(g);
    const row = el("div", { cls: "prow" });
    row.appendChild(el("div", { cls: "ptitle", text: g.title + "  " + p.pct + "%  (" + p.done + "/" + p.total + ")" }));
    const bar = el("div", { cls: "bar" });
    const fill = el("div", { cls: "fill" });
    fill.style.width = p.pct + "%";
    bar.appendChild(fill);
    row.appendChild(bar);
    box.appendChild(row);
  });
  return box;
}

function genButton(target, label) {
  const btn = el("button", { cls: "gen", text: label });
  btn.disabled = generating;
  btn.addEventListener("click", function () { generatePlan(target); });
  return btn;
}

function renderToday() {
  const box = el("section", { cls: "today" });
  const now = new Date();
  const target = activeDate(now);
  const isTomorrow = target !== todayStr(now);
  const plan = loadPlans()[target];

  const head = el("div", { cls: "todayhead" });
  head.appendChild(el("h2", { text: (isTomorrow ? "내일 계획" : "오늘 계획") + " · " + target }));
  if (plan) {
    const cs = coreStatus(plan.blocks);
    head.appendChild(el("span", { cls: "core" + (cs.done >= cs.total && cs.total ? " done" : ""), text: "핵심 " + cs.done + "/" + cs.total + " · 셋만 하면 성공" }));
  }
  box.appendChild(head);

  if (generating) {
    box.appendChild(el("p", { cls: "muted", text: "AI가 계획 짜는 중…" }));
    return box;
  }

  if (!plan) {
    box.appendChild(el("p", { cls: "muted", text: "아직 계획이 없어요. 아래 버튼을 누르면 AI가 짜줍니다." }));
    box.appendChild(genButton(target, "계획 생성"));
    return box;
  }

  plan.blocks.forEach(function (b) {
    const row = el("label", { cls: "block" + (b.core ? " isCore" : "") + (b.done ? " off" : "") });
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!b.done;
    cb.addEventListener("change", function () { setBlockDone(target, b.id, cb.checked); render(); });
    row.appendChild(cb);
    row.appendChild(el("span", { cls: "time", text: b.time }));
    row.appendChild(el("span", { cls: "txt", text: (b.core ? "● " : "") + b.text }));
    box.appendChild(row);
  });
  if (plan.source === "template") {
    if (hasAI()) {
      box.appendChild(el("p", { cls: "err", text: "AI 실패 → 기본 템플릿. 이유: " + (lastAIError || "알 수 없음") }));
      box.appendChild(el("p", { cls: "muted", text: "설정에서 Gemini 키를 넣으면 가장 안정적이에요. 또는 다시 생성." }));
    } else {
      box.appendChild(el("p", { cls: "muted", text: "AI 없이 기본 템플릿입니다. 설정에서 AI를 켜면 맞춤 계획이 됩니다." }));
    }
  }
  box.appendChild(genButton(target, "다시 생성"));
  return box;
}

function renderSettings() {
  const box = el("details", { cls: "settings" });
  const sum = el("summary", { text: "설정 · 목표" });
  box.appendChild(sum);

  const profile = loadProfile();

  // "내 정보" — categorized profile fields (all optional), fed to the AI planner
  const info = el("div", { cls: "infowrap" });
  info.appendChild(el("div", { cls: "infohd", text: "내 정보 (채울수록 계획이 정확해져요)" }));
  PROFILE_FIELDS.forEach(function (fld) {
    const wrap = el("div", { cls: "field" });
    wrap.appendChild(el("label", { cls: "flabel", text: fld.label }));
    const ta = el("textarea", { cls: "finput" });
    ta.placeholder = fld.ph;
    ta.value = profile[fld.key] || "";
    ta.addEventListener("change", function () {
      const p = loadProfile(); p[fld.key] = ta.value; saveProfile(p);
    });
    wrap.appendChild(ta);
    info.appendChild(wrap);
  });
  box.appendChild(info);

  profile.goals.forEach(function (g) {
    const gv = el("div", { cls: "goal" });
    const top = el("div", { cls: "goaltop" });
    top.appendChild(el("strong", { text: g.title }));
    const dl = el("input", { cls: "dl" }); dl.type = "text"; dl.placeholder = "마감(선택)"; dl.value = g.deadline || "";
    dl.addEventListener("change", function () {
      const p = loadProfile(); const gg = findGoal(p, g.id);
      if (gg) { gg.deadline = dl.value; saveProfile(p); }
    });
    top.appendChild(dl);
    const del = el("button", { cls: "mini", text: "삭제" });
    del.addEventListener("click", function () {
      const p = loadProfile();
      p.goals = p.goals.filter(function (x) { return x.id !== g.id; });
      saveProfile(p); render();
    });
    top.appendChild(del);
    gv.appendChild(top);

    (g.tasks || []).forEach(function (t) {
      const tr = el("label", { cls: "task" + (t.done ? " off" : "") });
      const cb = el("input"); cb.type = "checkbox"; cb.checked = !!t.done;
      cb.addEventListener("change", function () {
        const p = loadProfile();
        const gg = findGoal(p, g.id);
        const tt = gg && gg.tasks.find(function (x) { return x.id === t.id; });
        if (tt) { tt.done = cb.checked; saveProfile(p); }
        render();
      });
      tr.appendChild(cb);
      tr.appendChild(el("span", { text: t.text }));
      gv.appendChild(tr);
    });

    // add task
    const addRow = el("div", { cls: "addrow" });
    const ti = el("input"); ti.type = "text"; ti.placeholder = "과제 추가";
    const ta = el("button", { cls: "mini", text: "+" });
    function addTask() {
      const v = ti.value.trim(); if (!v) return;
      const p = loadProfile();
      const gg = findGoal(p, g.id);
      if (gg) { gg.tasks = gg.tasks || []; gg.tasks.push({ id: genId("t"), text: v, done: false }); saveProfile(p); }
      render();
    }
    ta.addEventListener("click", addTask);
    ti.addEventListener("keydown", function (e) { if (e.key === "Enter") addTask(); });
    addRow.appendChild(ti); addRow.appendChild(ta);
    gv.appendChild(addRow);

    // AI breakdown button (generate concrete homework for this goal)
    if (hasAI()) {
      if (breaking === g.id) {
        gv.appendChild(el("span", { cls: "muted", text: "AI가 과제로 쪼개는 중…" }));
      } else {
        const bd = el("button", { cls: "mini bd", text: "🧩 AI로 과제 쪼개기" });
        bd.disabled = !!breaking;
        bd.addEventListener("click", function () { breakdownGoalNow(g.id); });
        gv.appendChild(bd);
      }
    } else if (!g.tasks || !g.tasks.length) {
      gv.appendChild(el("span", { cls: "muted", text: "과제를 직접 추가하거나, 아래에서 AI를 켜세요." }));
    }
    box.appendChild(gv);
  });

  // add goal
  const gadd = el("div", { cls: "addrow" });
  const gi = el("input"); gi.type = "text"; gi.placeholder = "목표 추가 (예: 데이터베이스 따라가기)";
  const gb = el("button", { cls: "mini", text: "목표 추가" });
  function addGoal() {
    const v = gi.value.trim(); if (!v) return;
    const p = loadProfile();
    p.goals.push({ id: genId("g"), title: v, note: "", tasks: [], analyzedAt: null });
    saveProfile(p); render();
  }
  gb.addEventListener("click", addGoal);
  gi.addEventListener("keydown", function (e) { if (e.key === "Enter") addGoal(); });
  gadd.appendChild(gi); gadd.appendChild(gb);
  box.appendChild(gadd);

  // ---- AI 연결 (provider 설정) ----
  box.appendChild(el("div", { cls: "aihd", text: "AI 연결" }));
  const active = getGemKey() ? ("Gemini · " + getGemModel()) : (getKey() ? ("OpenRouter · " + getModel()) : "꺼짐 (기본 템플릿만)");
  box.appendChild(el("div", { cls: "muted", text: "현재: " + active }));

  const krow = el("div", { cls: "addrow" });

  const gemBtn = el("button", { cls: "mini bd", text: getGemKey() ? "Gemini 키 변경" : "🔑 Gemini 키 입력 (추천)" });
  gemBtn.addEventListener("click", function () {
    const v = window.prompt("Google Gemini API 키 (aistudio.google.com/apikey 에서 발급):", "");
    if (v && v.trim()) { setGemKey(v.trim()); render(); }
  });
  krow.appendChild(gemBtn);

  const orBtn = el("button", { cls: "mini", text: getKey() ? "OpenRouter 키 변경" : "OpenRouter 키" });
  orBtn.addEventListener("click", function () {
    const v = window.prompt("OpenRouter API 키 (sk-or-...):", "");
    if (v && v.trim()) { setKey(v.trim()); render(); }
  });
  krow.appendChild(orBtn);
  box.appendChild(krow);

  // provider-specific model change / turn off
  const mrow = el("div", { cls: "addrow" });
  if (getGemKey()) {
    const gm = el("button", { cls: "mini", text: "Gemini 모델 변경" });
    gm.addEventListener("click", function () {
      const v = window.prompt("Gemini 모델 (예: gemini-2.0-flash, gemini-2.5-flash):", getGemModel());
      if (v && v.trim()) { try { localStorage.setItem(K_GEMMODEL, v.trim()); } catch (e) {} render(); }
    });
    mrow.appendChild(gm);
    const off = el("button", { cls: "mini", text: "Gemini 끄기" });
    off.addEventListener("click", function () { try { localStorage.removeItem(K_GEMKEY); } catch (e) {} render(); });
    mrow.appendChild(off);
  } else if (getKey()) {
    const mc = el("button", { cls: "mini", text: "모델 변경" });
    mc.addEventListener("click", function () {
      const v = window.prompt("OpenRouter 모델 id (무료는 :free로 끝남):", getModel());
      if (v && v.trim()) { try { localStorage.setItem(K_ORMODEL, v.trim()); } catch (e) {} render(); }
    });
    mrow.appendChild(mc);
  }
  if (mrow.children.length) box.appendChild(mrow);
  return box;
}

// bootstrap: record visit, render. Plan is generated only on button press.
function boot() {
  saveVisits(recordVisit(loadVisits(), todayStr()));
  render();
}

// ---- exports for node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeStreak, visitGrid, recordVisit, goalProgress, nextPendingTasks,
    findGoal, extractJSON, todayStr, dateStr, addDays, pad2, activeDate,
    templatePlan, mapAIBlocks, coreStatus, generatePlan, profileContext, loadProfile,
    parseTaskList, breakdownGoalNow
  };
}

if (typeof document !== "undefined") boot();
