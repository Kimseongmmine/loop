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

// ---- energy (배터리) · 회고 · 완주 보관함 ----
const K_ENERGY = "loop.energy";   // { "YYYY-MM-DD": "high"|"mid"|"low" }
const K_NOTES = "loop.notes";     // { "YYYY-MM-DD": "한 줄 회고" }
const K_DONE = "loop.done";       // [{ text, goalTitle, date }]

const ENERGY_LEVELS = [
  { key: "high", label: "빵빵", hint: "핵심 3개 + 보너스" },
  { key: "mid", label: "보통", hint: "핵심 3개" },
  { key: "low", label: "방전", hint: "핵심 1개만" }
];
const ENERGY_RULE = {
  high: "오늘 컨디션 좋음: 핵심 학습 3개까지, 딥워크 블록 조금 길게(최대 90분).",
  mid: "오늘 컨디션 보통: 핵심 3개, 블록은 60분 이하, 사이사이 휴식 충분히.",
  low: "오늘 배터리 방전: 절대 몰아붙이지 마라. 핵심은 1개만(core:true 1개), 나머지는 휴식·가벼운 정리·산책 위주. 총 학습 2시간 이내."
};

function loadEnergy() { return lsGet(K_ENERGY, {}) || {}; }
function getEnergy(date) { return loadEnergy()[date] || ""; }
function setEnergy(date, level) { const e = loadEnergy(); e[date] = level; lsSet(K_ENERGY, e); }

function loadNotes() { return lsGet(K_NOTES, {}) || {}; }
function getNote(date) { return loadNotes()[date] || ""; }
function setNote(date, text) { const n = loadNotes(); n[date] = text; lsSet(K_NOTES, n); }
// most recent notes before `date`, newest first
function recentNotes(date, limit) {
  const n = loadNotes();
  return Object.keys(n).filter(function (d) { return d < date && n[d]; }).sort().reverse()
    .slice(0, limit || 3).map(function (d) { return { date: d, text: n[d] }; });
}

function loadDone() { const d = lsGet(K_DONE, []); return Array.isArray(d) ? d : []; }
function archiveDone(entry) {
  const list = loadDone();
  if (list.some(function (x) { return x.text === entry.text && x.date === entry.date; })) return;
  list.push(entry);
  lsSet(K_DONE, list);
}

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
  if (start === -1 || end === -1 || end < start) return repairTruncatedJSON(s);
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return repairTruncatedJSON(s); }
}

// The model hit its output limit mid-JSON. Salvage every COMPLETE object inside
// the first array we find (e.g. {"blocks":[{...},{...},{"time":"08:00-  <-- cut).
function repairTruncatedJSON(text) {
  const s = String(text || "");
  const keyMatch = s.match(/"(blocks|tasks|schedule)"\s*:\s*\[/);
  const arrStart = keyMatch ? s.indexOf("[", s.indexOf(keyMatch[0])) : s.indexOf("[");
  if (arrStart === -1) return null;
  const items = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { items.push(JSON.parse(s.slice(objStart, i + 1))); } catch (e) {}
        objStart = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) break;
  }
  if (!items.length) {
    // maybe it was an array of plain strings: ["a","b","c
    const strs = s.slice(arrStart).match(/"([^"\\]|\\.)*"/g);
    if (strs && strs.length >= 3) {
      const vals = strs.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      if (vals.length >= 3) return keyMatch && keyMatch[1] === "tasks" ? { tasks: vals } : null;
    }
    return null;
  }
  const key = keyMatch ? keyMatch[1] : "blocks";
  const out = {};
  out[key] = items;
  return out;
}

// parse a task list from a model reply: JSON {tasks:[...]} OR a plain numbered/bulleted list.
// small free models produce lists far more reliably than JSON.
function parseTaskList(content) {
  const j = extractJSON(content);
  if (j && Array.isArray(j.tasks) && j.tasks.length) {
    return j.tasks.map(function (t) { return String(t).trim(); }).filter(Boolean);
  }
  // top-level JSON array e.g. ["a","b"] (Gemini JSON mode may return this)
  const trimmed = String(content || "").trim();
  if (trimmed[0] === "[") {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length) {
        const items = arr.map(function (x) { return typeof x === "string" ? x : (x && (x.text || x.task || x.title)); })
          .filter(Boolean).map(function (s) { return String(s).trim(); });
        if (items.length) return items;
      }
    } catch (e) {}
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

// parse a human-readable schedule the model wrote as text, e.g.
//   * 09:00 - 10:15 [고정일정] 이동 및 등교
//   - 10:30~12:00 DB 1강 듣기 (핵심)
// returns block-shaped objects {time, text, core} so mapAIBlocks can consume them.
function parseTextSchedule(content, candidates) {
  const cands = candidates || [];
  const range = /(\d{1,2}\s*[:：]\s*\d{2})\s*(?:-|–|—|~|to|부터)\s*(\d{1,2}\s*[:：]\s*\d{2})/;
  const out = [];
  String(content || "").split("\n").forEach(function (line) {
    const m = line.match(range);
    if (!m) return;
    const t1 = m[1].replace(/\s/g, "").replace("：", ":");
    const t2 = m[2].replace(/\s/g, "").replace("：", ":");
    let text = line.slice(line.indexOf(m[0]) + m[0].length)
      .replace(/^[\s:：\-–—|·>]+/, "")
      .replace(/^[\[(]?(핵심|core|중요)[\])]?[\s:·-]*/i, "")
      .replace(/[\[(]\s*(핵심|core|중요|필수)\s*[\])]\s*$/i, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!text) {
      // text may sit before the time range ("이동 및 등교 09:00-10:15")
      text = line.slice(0, line.indexOf(m[0])).replace(/^[\s*\-–—•\d.\)]+/, "").trim();
    }
    if (!text) return;
    const core = /핵심|core|중요|필수/i.test(line);
    // link to a candidate task when the text mentions it
    let ref = null;
    for (let i = 0; i < cands.length; i++) {
      const key = String(cands[i].text || "").slice(0, 10);
      if (key && text.indexOf(key) !== -1) { ref = i; break; }
    }
    const b = { time: t1 + "-" + t2, text: text.slice(0, 80), core: core };
    if (ref != null) b.ref = ref;
    out.push(b);
  });
  return out.length >= 3 ? out : null;
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
    body: JSON.stringify({ model: model, max_tokens: maxTokens || 2048, temperature: 0.6, messages: messages })
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
  const body = { contents: [{ role: "user", parts: userParts }], generationConfig: { maxOutputTokens: maxTokens || 4096, temperature: 0.6 } };
  // force clean JSON output when the caller expects to parse it (no preamble / reasoning text)
  if (parse) body.generationConfig.responseMimeType = "application/json";
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
    // 후보 과제가 없을 때도 핵심 슬롯은 비우지 않는다. 첫 슬롯만 살리고 나머지는 여백으로.
    if (i === 0) return { id: genId("b"), time: time, text: "집중 블록 — 아래 설정에서 목표를 적으면 여기가 채워집니다", goalId: null, taskId: null, core: true, done: false };
    return { id: genId("b"), time: time, text: "집중 블록 (자유)", goalId: null, taskId: null, core: false, done: false };
  }
  function life(time, text) { return { id: genId("b"), time: time, text: text, goalId: null, taskId: null, core: false, done: false }; }
  return [
    study(0, "09:00-10:50"),
    life("10:50-11:00", "물 한 잔 · 눈 휴식(먼 곳 보기)"),
    study(1, "11:00-12:00"),
    life("12:00-13:00", "점심"),
    life("13:00-14:00", "휴식 · 산책"),
    study(2, "14:00-15:50"),
    life("15:50-16:00", "물 한 잔 · 눈 휴식"),
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

// 정시 판정: 블록 시작시각 ±ON_TIME_MIN 안에 체크해야 "정시 시작"
const ON_TIME_MIN = 5;

// "09:00-11:00" -> 540 (분). 파싱 실패 시 null
function blockStartMinutes(time) {
  const m = String(time || "").match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 지금이 그 블록의 정시 창(시작 -5분 ~ +5분) 안인가
function isOnTime(block, date, now) {
  now = now || new Date();
  if (todayStr(now) !== date) return false;         // 다른 날 소급 체크는 정시 아님
  const start = blockStartMinutes(block && block.time);
  if (start == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return Math.abs(cur - start) <= ON_TIME_MIN;
}

// "09:00-11:00" -> 끝 시각(분). 끝이 없으면 시작+60
function blockEndMinutes(time) {
  const all = String(time || "").match(/(\d{1,2})\s*:\s*(\d{2})/g);
  const start = blockStartMinutes(time);
  if (start == null) return null;
  if (!all || all.length < 2) return start + 60;
  const m = all[1].match(/(\d{1,2})\s*:\s*(\d{2})/);
  return Number(m[1]) * 60 + Number(m[2]);
}

// 지금 시각에 해당하는 블록(진행 중), 없으면 다음에 올 블록
function currentBlock(blocks, now) {
  now = now || new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const list = (blocks || []).filter(function (b) { return blockStartMinutes(b.time) != null; });
  const running = list.find(function (b) {
    const s = blockStartMinutes(b.time), e = blockEndMinutes(b.time);
    return cur >= s && cur < e;
  });
  if (running) return { block: running, state: "now" };
  const upcoming = list.filter(function (b) { return blockStartMinutes(b.time) > cur; })
    .sort(function (a, b) { return blockStartMinutes(a.time) - blockStartMinutes(b.time); })[0];
  if (upcoming) return { block: upcoming, state: "next" };
  return null;
}

// 하루 결산 (순수)
function daySummary(plan) {
  const blocks = (plan && plan.blocks) || [];
  const core = blocks.filter(function (b) { return b.core; });
  const onTime = core.filter(function (b) { return b.done && b.onTime; });
  const late = core.filter(function (b) { return b.done && !b.onTime; });
  const missed = core.filter(function (b) { return !b.done; });
  return {
    coreTotal: core.length,
    onTime: onTime.length,
    late: late.length,
    missedList: missed.map(function (b) { return b.text; }),
    allDone: core.length > 0 && missed.length === 0
  };
}

// 핵심 카운터는 "정시 체크"만 인정
function coreStatus(blocks) {
  const core = (blocks || []).filter(function (b) { return b.core; });
  return {
    done: core.filter(function (b) { return b.done && b.onTime; }).length,
    late: core.filter(function (b) { return b.done && !b.onTime; }).length,
    total: core.length
  };
}

// toggle a block; sync its linked goal task
function setBlockDone(date, blockId, checked, now) {
  const plans = loadPlans();
  const plan = plans[date];
  if (!plan) return;
  const block = plan.blocks.find(function (b) { return b.id === blockId; });
  if (!block) return;
  block.done = checked;
  block.onTime = checked ? isOnTime(block, date, now) : false;
  if (checked) block.checkedAt = (now || new Date()).toISOString();
  savePlans(plans);
  if (block.taskId) {
    const profile = loadProfile();
    for (let i = 0; i < profile.goals.length; i++) {
      const t = (profile.goals[i].tasks || []).find(function (x) { return x.id === block.taskId; });
      if (t) {
        t.done = checked;
        saveProfile(profile);
        if (checked) archiveDone({ text: t.text, goalTitle: profile.goals[i].title, date: date });
        break;
      }
    }
  }
}

// ---- AI flows ----
async function aiBreakdownGoal(goal) {
  const sys = "너는 학습 코치다. 목표를 '실제로 완수하려면 뭘 해야 하는지' 구체적 실행 과제로 쪼갠다. " +
    "규칙: 각 과제는 한 번에 60분 안에 끝낼 수 있어야 하고, '무엇을 얼마나' 명확해야 한다. " +
    "추상적 표현 금지('공부하기','정리하기','복습하기' 같은 것 금지). " +
    "구체적으로('3장 연습문제 1~10번 풀기','1강 강의 듣고 필기 2쪽','기출 2회분 채점까지'). " +
    "5~8개, 쉬운 것부터 순서대로. 한국어. 설명·인사·사고과정 없이 오직 JSON만 출력: {\"tasks\":[\"과제1\",\"과제2\"]}";
  const traits = (loadProfile().traits || "").trim();
  const usr = "목표: " + goal.title +
    (goal.deadline ? ("\n마감: " + goal.deadline) : "") +
    (goal.note ? ("\n메모: " + goal.note) : "") +
    (traits ? ("\n내 특성(참고): " + traits) : "") +
    "\n\n이 목표를 완수하기 위한 구체적 과제 목록:";
  const list = await aiChat([{ role: "system", content: sys }, { role: "user", content: usr }], 1500, parseTaskList);
  if (list) {
    return list.slice(0, 10).map(function (t) { return { id: genId("t"), text: String(t).slice(0, 70), done: false }; });
  }
  return null;
}

// "2026-08-25" -> "2026-08-25 (화요일)"
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function weekdayOf(dateString) {
  const p = String(dateString).split("-").map(Number);
  return WEEKDAYS[new Date(p[0], p[1] - 1, p[2]).getDay()] + "요일";
}
function dateWithWeekday(dateString) { return dateString + " (" + weekdayOf(dateString) + ")"; }

async function aiGeneratePlan(candidates, targetDate, opts) {
  opts = opts || {};
  const when = targetDate ? dateWithWeekday(targetDate) : "";
  const sys = "너는 대학 3학년의 하루 시간표를 짜는 코치다. 이 사람은 쉽게 지치고 미룬다. " +
    "반드시 지정된 '날짜와 요일'에 맞춰 짜라. 고정 일정은 요일별로 다르므로 그 요일에 해당하는 것만 반영한다(다른 요일 수업을 넣지 마라). " +
    "고정 일정 시간대는 절대 학습 블록으로 쓰지 말고 그대로 두거나 이동/식사로 채운다. " +
    "하루 리듬의 기상~취침 시간 안에서만 짜고, 집중 잘 되는 시간대에 핵심 학습을 배치한다. " +
    "현실적으로: 딥워크 사이에 휴식·이동·식사, 저녁은 가볍게, 강도 절반, 몰아치기 금지. " +
    "후보 과제를 시간표에 배치하고(각 블록 ref에 후보 index), 휴식/식사/운동/고정일정 같은 생활 블록은 ref 없이 넣어라. " +
    "가장 중요한 3개 학습 블록에만 core:true. " +
    "이 사람은 쉽게 지치고 눈이 건조하다: 딥워크 사이에 '물 마시기·눈 휴식(먼 곳 보기)' 같은 짧은 회복 블록을 최소 2개 넣어라. " +
    "meals에는 그날의 아침·점심·저녁 식단을 간단히 제안한다(간편하고 현실적인 한 끼, 15자 내외, 수분 보충 고려). " +
    "오직 JSON만: {\"blocks\":[{\"time\":\"09:00-11:00\",\"text\":\"...\",\"ref\":0,\"core\":true}]," +
    "\"meals\":{\"아침\":\"...\",\"점심\":\"...\",\"저녁\":\"...\"}}";
  const ctx = profileContext(loadProfile());
  const list = candidates.map(function (c, i) { return i + ": " + c.text + " (" + c.goalTitle + ")"; }).join("\n");
  const energy = targetDate ? getEnergy(targetDate) : "";
  const notes = targetDate ? recentNotes(targetDate, 3) : [];
  const usr =
    (when ? ("[날짜] " + when + "\n\n") : "") +
    (opts.fromTime ? ("[지금 " + opts.fromTime + "] 하루가 이미 시작됐다. " + opts.fromTime + "부터 취침까지 남은 시간만으로 다시 짜라. 지나간 시간은 넣지 마라. 남은 시간이 짧으면 핵심을 줄여라.\n\n") : "") +
    (energy && ENERGY_RULE[energy] ? ("[오늘 배터리] " + ENERGY_RULE[energy] + "\n\n") : "") +
    (ctx ? ("[내 프로필]\n" + ctx + "\n\n") : "") +
    (notes.length ? ("[최근 회고 — 반영해서 조정]\n" + notes.map(function (n) { return "- " + n.date + ": " + n.text; }).join("\n") + "\n\n") : "") +
    "[후보 과제]\n" + (list || "(없음)") +
    "\n\n위 날짜/요일에 맞춰 시간표와 식단을 JSON으로.";
  // accept JSON {blocks:[...]}, a bare JSON array, OR a plain text schedule
  const parse = function (c) {
    const j = extractJSON(c);
    if (j && Array.isArray(j.blocks) && j.blocks.length) return { blocks: j.blocks, meals: j.meals || null };
    if (j && Array.isArray(j.schedule) && j.schedule.length) return { blocks: j.schedule, meals: j.meals || null };
    const t = String(c || "").trim();
    if (t[0] === "[") {
      try { const arr = JSON.parse(t); if (Array.isArray(arr) && arr.length && arr[0] && arr[0].time) return { blocks: arr, meals: null }; } catch (e) {}
    }
    const text = parseTextSchedule(c, candidates);
    return text ? { blocks: text, meals: null } : null;
  };
  const res = await aiChat([{ role: "system", content: sys }, { role: "user", content: usr }], 4096, parse);
  if (!res) return null;
  const blocks = mapAIBlocks(res.blocks, candidates);
  if (!blocks) return null;
  return { blocks: blocks, meals: normalizeMeals(res.meals) };
}

// keep only the three meal slots, as short strings
function normalizeMeals(m) {
  if (!m || typeof m !== "object") return null;
  const pick = function (keys) {
    for (let i = 0; i < keys.length; i++) {
      const v = m[keys[i]];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
      if (v && typeof v === "object" && typeof v.text === "string" && v.text.trim()) return v.text.trim().slice(0, 40);
    }
    return "";
  };
  const out = {
    breakfast: pick(["아침", "breakfast", "조식"]),
    lunch: pick(["점심", "lunch", "중식"]),
    dinner: pick(["저녁", "dinner", "석식"])
  };
  return (out.breakfast || out.lunch || out.dinner) ? out : null;
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
async function generatePlan(targetDate, opts) {
  if (generating) return;
  opts = opts || {};
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
    let blocks = null, meals = null, source = "template";
    if (aiOn) {
      const res = await aiGeneratePlan(candidates, targetDate, opts);
      if (res) { blocks = res.blocks; meals = res.meals; source = "ai"; }
    }
    if (!blocks) {
      blocks = templatePlan(candidates);
      if (opts.fromTime) {
        // 템플릿 폴백에서도 지나간 블록은 버림
        const cutoff = blockStartMinutes(opts.fromTime);
        blocks = blocks.filter(function (b) { const s = blockStartMinutes(b.time); return s == null || s >= cutoff; });
        if (!blocks.length) blocks = templatePlan(candidates).slice(-3);
      }
      source = "template";
    }
    // 지난/완료 블록 보존
    if (opts.keep && opts.keep.length) {
      const keptIds = {}, keptStarts = {};
      opts.keep.forEach(function (b) { keptIds[b.id] = true; keptStarts[b.time] = true; });
      blocks = opts.keep.concat(blocks.filter(function (b) {
        return !keptIds[b.id] && !keptStarts[b.time]; // 보존된 시간대와 겹치는 새 블록은 버림
      }));
    }
    // 항상 시간순 정렬 (AI든 템플릿이든, keep이 있든 없든)
    blocks.sort(function (a, b) { return (blockStartMinutes(a.time) || 0) - (blockStartMinutes(b.time) || 0); });
    const plans = loadPlans();
    const prev = plans[targetDate];
    plans[targetDate] = {
      blocks: blocks,
      meals: meals || (prev && prev.meals) || null,
      generatedAt: new Date().toISOString(),
      source: source
    };
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
// 어떤 <details>가 열려 있었는지 기억해 재렌더 후 복원한다.
const openPanels = {};
function markOpen(det, key) {
  det.open = !!openPanels[key];
  det.addEventListener("toggle", function () { openPanels[key] = det.open; });
  return det;
}

// 재렌더가 사용자의 작업을 삼키지 않도록 포커스·커서·열린 패널을 보존한다.
function render() {
  const root = document.getElementById("screen");
  if (!root) return;

  // 1) 현재 포커스된 입력의 위치를 기억
  let restore = null;
  try {
    const a = document.activeElement;
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a.dataset && a.dataset.k) {
      restore = { k: a.dataset.k, start: a.selectionStart, end: a.selectionEnd };
    }
  } catch (e) {}

  root.innerHTML = "";
  root.appendChild(renderHero());
  root.appendChild(renderToday());
  root.appendChild(renderProgress());
  const meals = renderMeals();
  if (meals) root.appendChild(meals);
  root.appendChild(renderNote());
  root.appendChild(renderSettings());
  root.appendChild(renderFooter());

  // 2) 같은 필드를 다시 찾아 포커스와 커서 위치를 되돌림
  if (restore) {
    try {
      const next = root.querySelector('[data-k="' + restore.k + '"]');
      if (next) {
        next.focus();
        if (next.setSelectionRange && restore.start != null) next.setSelectionRange(restore.start, restore.end);
      }
    } catch (e) {}
  }
}

// 입력 중 유실을 막는 표준 바인딩: 타이핑 즉시(디바운스) 저장 + 필드 식별자 부여
function bindField(node, key, save) {
  node.dataset.k = key;
  let t = null;
  node.addEventListener("input", function () {
    if (t) clearTimeout(t);
    t = setTimeout(function () { save(node.value); }, 400);
  });
  node.addEventListener("change", function () { if (t) clearTimeout(t); save(node.value); });
  node.addEventListener("blur", function () { if (t) clearTimeout(t); save(node.value); });
  return node;
}

// landing/hero: what this app does + energy picker + the main action
function renderHero() {
  const box = el("section", { cls: "hero" });
  const now = new Date();
  const target = activeDate(now);
  const isTomorrow = target !== todayStr(now);
  const plan = loadPlans()[target];

  box.appendChild(el("h1", { cls: "brand", text: "LOOP" }));
  box.appendChild(el("p", { cls: "tag", text: "고민하지 말고, 정해진 대로." }));

  // 지금 뭐 할 차례 — 오늘 계획이 있을 때만
  const todayPlan = loadPlans()[todayStr(now)];
  if (todayPlan && !isTomorrow) {
    const cb = currentBlock(todayPlan.blocks.filter(function (b) { return !b.done; }), now);
    if (cb) {
      const nowbar = el("div", { cls: "nowbar" + (cb.state === "now" ? " active" : "") });
      nowbar.appendChild(el("span", { cls: "nlabel", text: cb.state === "now" ? "지금" : "다음" }));
      nowbar.appendChild(el("span", { cls: "ntext", text: cb.block.text }));
      nowbar.appendChild(el("span", { cls: "ntime", text: cb.block.time }));
      box.appendChild(nowbar);
    }
  }
  box.appendChild(el("p", {
    cls: "lede",
    text: "내 상황(수업·알바·리듬·목표)을 저장해두면, 버튼 한 번에 AI가 " +
      (isTomorrow ? "내일" : "오늘") + " 하루를 시간대별로 짜줍니다. " +
      "오전엔 집중 잘 되는 시간에 핵심 공부, 사이사이 물·눈 휴식, 점심·저녁과 운동, 밤엔 가볍게 마무리. " +
      "그중 굵게 표시된 핵심 3개만 하면 그날은 성공입니다."
  }));

  // energy picker — battery-aware planning
  const eWrap = el("div", { cls: "energy" });
  eWrap.appendChild(el("span", { cls: "elabel", text: "오늘 배터리" }));
  const cur = getEnergy(target);
  ENERGY_LEVELS.forEach(function (lv) {
    const b = el("button", { cls: "echip" + (cur === lv.key ? " on" : ""), text: lv.label });
    b.title = lv.hint;
    b.addEventListener("click", function () { setEnergy(target, lv.key); render(); });
    eWrap.appendChild(b);
  });
  box.appendChild(eWrap);

  box.appendChild(genButton(target, plan ? "계획 다시 생성" : (isTomorrow ? "내일 계획 생성" : "오늘 계획 생성")));

  // 오늘의 한 마디
  const q = quoteFor(todayStr(now));
  const qbox = el("blockquote", { cls: "quote" });
  qbox.appendChild(el("span", { cls: "qtext", text: q.t }));
  if (q.a) qbox.appendChild(el("span", { cls: "qauth", text: "— " + q.a }));
  box.appendChild(qbox);
  return box;
}

// ---- 정시 알림 (브라우저 탭이 살아있는 동안 동작) ----
let notifyTimer = null;
const notified = {};

function notifyOn() { try { return localStorage.getItem("loop.notify") === "1"; } catch (e) { return false; } }
function setNotifyOn(v) { try { localStorage.setItem("loop.notify", v ? "1" : "0"); } catch (e) {} }

function fireNotice(block) {
  const body = block.time + " · 지금 체크하면 정시";
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("LOOP — " + block.text, { body: body, tag: "loop-" + block.id });
      return;
    }
  } catch (e) {}
}

// every 30s: if a block just started (within the on-time window) and we haven't
// pinged for it yet, fire once.
function startNotifyLoop() {
  if (notifyTimer || typeof setInterval === "undefined") return;
  notifyTimer = setInterval(function () {
    if (!notifyOn()) return;
    const today = todayStr();
    const plan = loadPlans()[today];
    if (!plan) return;
    const now = new Date();
    plan.blocks.forEach(function (b) {
      if (b.done || notified[b.id]) return;
      const s = blockStartMinutes(b.time);
      if (s == null) return;
      const cur = now.getHours() * 60 + now.getMinutes();
      if (cur >= s && cur <= s + ON_TIME_MIN) { notified[b.id] = true; fireNotice(b); }
    });
  }, 30000);
}

async function enableNotify() {
  try {
    if (typeof Notification === "undefined") return false;
    const p = await Notification.requestPermission();
    if (p === "granted") { setNotifyOn(true); startNotifyLoop(); render(); return true; }
  } catch (e) {}
  return false;
}

// ---- 지금부터 리셋: 남은 시간만으로 다시 짜기 ----
async function replanFromNow() {
  const now = new Date();
  const today = todayStr(now);
  const plan = loadPlans()[today];
  if (!plan) return;
  const cur = now.getHours() * 60 + now.getMinutes();
  const keep = plan.blocks.filter(function (b) {
    const s = blockStartMinutes(b.time);
    return s != null && (s < cur || b.done); // 지난 것/이미 한 것은 보존
  });
  const hhmm = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  await generatePlan(today, { fromTime: hhmm, keep: keep });
}

// one-line evening review — feeds tomorrow's planning
function renderNote() {
  const today = todayStr();
  const box = el("section", { cls: "note" });
  box.appendChild(el("h2", { text: "오늘 한 줄" }));

  // 밤 결산 — 오늘 계획이 있으면 자동 요약
  const plan = loadPlans()[today];
  if (plan) {
    const s = daySummary(plan);
    const sum = el("div", { cls: "sumbox" + (s.allDone ? " good" : "") });
    sum.appendChild(el("div", {
      cls: "sumline",
      text: s.coreTotal
        ? ("핵심 " + s.onTime + "/" + s.coreTotal + " 정시" + (s.late ? (" · 늦음 " + s.late) : ""))
        : "오늘 핵심 블록 없음"
    }));
    if (s.allDone) {
      sum.appendChild(el("div", { cls: "muted", text: "오늘은 성공. 이건 기록에 남습니다." }));
    } else if (s.missedList.length) {
      sum.appendChild(el("div", { cls: "muted", text: "못 한 것: " + s.missedList.join(", ") + " — 내일 계획에 자동 반영됩니다." }));
    }
    box.appendChild(sum);
  }

  box.appendChild(el("p", { cls: "muted", text: "뭐가 걸렸는지 한 줄만. 내일 계획에 반영됩니다." }));
  const ta = el("textarea", { cls: "finput" });
  ta.placeholder = "예: 오후에 집중 안 됨 / 알바 끝나고 아무것도 못함";
  ta.value = getNote(today);
  ta.setAttribute("aria-label", "오늘 한 줄 회고");
  bindField(ta, "note", function (v) { setNote(today, v.trim()); });
  box.appendChild(ta);
  return box;
}

// bottom: streak + visit grid + finished-work archive (secondary info)
function renderFooter() {
  const box = el("section", { cls: "footer" });
  const today = todayStr();

  const done = loadDone();
  const dwrap = markOpen(el("details", { cls: "arch" }), "done");
  dwrap.appendChild(el("summary", { text: "🏁 내가 끝낸 것들 (" + done.length + ")" }));
  if (!done.length) {
    dwrap.appendChild(el("p", { cls: "muted", text: "완료한 과제가 여기 쌓입니다. 지워지지 않아요." }));
  } else {
    done.slice().reverse().slice(0, 50).forEach(function (d) {
      const row = el("div", { cls: "arow" });
      row.appendChild(el("span", { cls: "adate", text: d.date }));
      row.appendChild(el("span", { cls: "atext", text: d.text + (d.goalTitle ? (" · " + d.goalTitle) : "") }));
      dwrap.appendChild(row);
    });
  }
  box.appendChild(dwrap);

  const swrap = markOpen(el("details", { cls: "arch" }), "visits");
  swrap.appendChild(el("summary", { text: "🔥 접속 기록 · " + computeStreak(loadVisits(), today) + "일 연속" }));
  const grid = el("div", { cls: "grid" });
  visitGrid(loadVisits(), today, 28).forEach(function (d) {
    const dot = el("span", { cls: "dot" + (d.visited ? " on" : "") });
    dot.title = d.date;
    grid.appendChild(dot);
  });
  swrap.appendChild(grid);
  box.appendChild(swrap);
  return box;
}

// meal suggestions for the active day (only when the AI produced them)
function renderMeals() {
  const target = activeDate(new Date());
  const plan = loadPlans()[target];
  const m = plan && plan.meals;
  if (!m) return null;
  const box = el("section", { cls: "meals" });
  box.appendChild(el("h2", { text: "식단" }));
  [["아침", m.breakfast], ["점심", m.lunch], ["저녁", m.dinner]].forEach(function (pair) {
    if (!pair[1]) return;
    const row = el("div", { cls: "meal" });
    row.appendChild(el("span", { cls: "mlabel", text: pair[0] }));
    row.appendChild(el("span", { cls: "mtext", text: pair[1] }));
    box.appendChild(row);
  });
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

// 재생성은 그날의 실행 기록(체크·정시)을 절대 지우지 않는다.
// 완료했거나 이미 지나간 블록은 보존하고, 남은 부분만 새로 짠다.
function keepableBlocks(targetDate, now) {
  const plan = loadPlans()[targetDate];
  if (!plan) return [];
  const sameDay = targetDate === todayStr(now || new Date());
  const cur = (now || new Date()).getHours() * 60 + (now || new Date()).getMinutes();
  return plan.blocks.filter(function (b) {
    if (b.done) return true;                       // 한 것은 무조건 보존
    if (!sameDay) return false;                    // 미래 날짜는 전부 새로 짜도 됨
    const s = blockStartMinutes(b.time);
    return s != null && s < cur;                   // 오늘 지나간 시간대도 보존
  });
}

function genButton(target, label) {
  const btn = el("button", { cls: "gen", text: label });
  btn.disabled = generating;
  btn.addEventListener("click", function () {
    const keep = keepableBlocks(target, new Date());
    const doneCount = keep.filter(function (b) { return b.done; }).length;
    generatePlan(target, { keep: keep, preserved: doneCount });
  });
  return btn;
}

function renderToday() {
  const box = el("section", { cls: "today" });
  const now = new Date();
  const target = activeDate(now);
  const isTomorrow = target !== todayStr(now);
  const plan = loadPlans()[target];

  const head = el("div", { cls: "todayhead" });
  head.appendChild(el("h2", { text: (isTomorrow ? "내일 계획" : "오늘 계획") + " · " + dateWithWeekday(target) }));
  if (plan) {
    const cs = coreStatus(plan.blocks);
    head.appendChild(el("span", {
      cls: "core" + (cs.done >= cs.total && cs.total ? " done" : ""),
      text: "핵심 " + cs.done + "/" + cs.total + " 정시" + (cs.late ? (" · 늦음 " + cs.late) : "")
    }));
  }
  box.appendChild(head);

  if (generating) {
    box.appendChild(el("p", { cls: "muted", text: "AI가 계획 짜는 중…" }));
    return box;
  }

  if (!plan) {
    box.appendChild(el("p", { cls: "muted", text: "아직 계획이 없어요. 위의 “계획 생성”을 누르면 AI가 짜줍니다." }));
    return box;
  }

  box.appendChild(el("p", { cls: "muted onhint", text: "체크는 블록 시작시각 ±5분 안에 눌러야 “정시”로 인정됩니다. 늦게 눌러도 기록은 남아요." }));
  const nowTick = new Date();
  plan.blocks.forEach(function (b) {
    const open = !b.done && isOnTime(b, target, nowTick);
    const row = el("label", { cls: "block" + (b.core ? " isCore" : "") + (b.done ? " off" : "") + (open ? " open" : "") });
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!b.done;
    cb.addEventListener("change", function () { setBlockDone(target, b.id, cb.checked, new Date()); render(); });
    row.appendChild(cb);
    row.appendChild(el("span", { cls: "time", text: b.time }));
    row.appendChild(el("span", { cls: "txt", text: (b.core ? "● " : "") + b.text }));
    if (b.done && !b.onTime) row.appendChild(el("span", { cls: "badge late", text: "늦음" }));
    else if (b.done && b.onTime) row.appendChild(el("span", { cls: "badge ontime", text: "정시" }));
    else if (open) row.appendChild(el("span", { cls: "badge now", text: "지금" }));
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
  const brow = el("div", { cls: "addrow" });
  if (target === todayStr(new Date())) {
    const rp = el("button", { cls: "mini bd", text: "⏱ 지금부터 다시 짜기" });
    rp.disabled = generating;
    rp.addEventListener("click", function () { replanFromNow(); });
    brow.appendChild(rp);
  }
  if (typeof Notification !== "undefined" && !notifyOn()) {
    const nb = el("button", { cls: "mini", text: "🔔 정시 알림 켜기" });
    nb.addEventListener("click", function () { enableNotify(); });
    brow.appendChild(nb);
  } else if (notifyOn()) {
    brow.appendChild(el("span", { cls: "muted", text: "🔔 알림 켜짐 (탭이 열려 있을 때)" }));
  }
  if (brow.children.length) box.appendChild(brow);
  box.appendChild(genButton(target, "다시 생성"));
  return box;
}

function renderSettings() {
  const box = markOpen(el("details", { cls: "settings" }), "settings");
  const sum = el("summary", { text: "설정 · 목표" });
  box.appendChild(sum);

  const profile = loadProfile();

  // "내 정보" — categorized profile fields (all optional), fed to the AI planner
  const info = el("div", { cls: "infowrap" });
  info.appendChild(el("div", { cls: "infohd", text: "내 정보 (채울수록 계획이 정확해져요)" }));
  PROFILE_FIELDS.forEach(function (fld) {
    const wrap = el("div", { cls: "field" });
    const lab = el("label", { cls: "flabel", text: fld.label });
    lab.htmlFor = "f-" + fld.key;
    wrap.appendChild(lab);
    const ta = el("textarea", { cls: "finput" });
    ta.id = "f-" + fld.key;
    ta.placeholder = fld.ph;
    ta.value = profile[fld.key] || "";
    bindField(ta, "f-" + fld.key, function (v) {
      const p = loadProfile(); p[fld.key] = v; saveProfile(p);
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
    dl.setAttribute("aria-label", g.title + " 마감일");
    bindField(dl, "dl-" + g.id, function (v) {
      const p = loadProfile(); const gg = findGoal(p, g.id);
      if (gg) { gg.deadline = v; saveProfile(p); }
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
  box.appendChild(renderTimeline());
  return box;
}

// ---- 대운 타임라인 (긴 호흡의 앵커; 접어둠) ----
const BIRTH_YEAR = 2002;
const LUCK_CYCLES = [
  { from: 1, gz: "丁未", note: "유년" },
  { from: 11, gz: "戊申", note: "土金 시작 — 틀이 생기던 시기" },
  { from: 21, gz: "己酉", note: "金 채우는 구간 — 자격·실무·조직 경험을 쌓을 때" },
  { from: 31, gz: "庚戌", note: "金 완성 — 그릇이 단단해지고 결과가 붙기 시작" },
  { from: 41, gz: "辛亥", note: "전환점 — 金生水, 흐름이 바뀌는 지점" },
  { from: 51, gz: "壬子", note: "정점 — 용신 水 최대. 물 만난 나무" },
  { from: 61, gz: "癸丑", note: "水 지속 — 안정 구간" },
  { from: 71, gz: "甲寅", note: "木 회복" },
  { from: 81, gz: "乙卯", note: "木 왕성" },
  { from: 91, gz: "丙辰", note: "말년" }
];

function currentAge(now) { return (now || new Date()).getFullYear() - BIRTH_YEAR; }
function currentCycle(age) {
  let cur = LUCK_CYCLES[0];
  for (let i = 0; i < LUCK_CYCLES.length; i++) { if (age >= LUCK_CYCLES[i].from) cur = LUCK_CYCLES[i]; }
  return cur;
}

function renderTimeline() {
  const box = markOpen(el("details", { cls: "arch tl" }), "timeline");
  const age = currentAge(new Date());
  const cur = currentCycle(age);
  box.appendChild(el("summary", { text: "🧭 긴 호흡 — 지금 어디쯤인가 (" + age + "세 · " + cur.gz + ")" }));
  box.appendChild(el("p", {
    cls: "muted",
    text: "자수성가·대기만성 구조. 없는 金(그릇)과 부족한 水(에너지)를 대운이 순서대로 채워주는 우상향 흐름입니다. " +
      "지금 당장 안 풀려도 축적 구간이라 그렇습니다. 41세에 전환, 51~60이 정점."
  }));
  LUCK_CYCLES.filter(function (c) { return c.from >= 11 && c.from <= 61; }).forEach(function (c) {
    const on = c.from === cur.from;
    const row = el("div", { cls: "trow" + (on ? " now" : "") });
    row.appendChild(el("span", { cls: "tage", text: c.from + "세" }));
    row.appendChild(el("span", { cls: "tgz", text: c.gz }));
    row.appendChild(el("span", { cls: "tnote", text: c.note }));
    box.appendChild(row);
  });
  box.appendChild(el("p", { cls: "muted", text: "사주는 성향의 지도이지 확정된 미래가 아닙니다. 지금 쌓는 것이 그 지도를 바꿉니다." }));
  return box;
}

// ---- 오늘의 한 마디 (날짜 고정 로테이션) ----
const QUOTES = [
  { t: "시작이 반이라는 말은 과장이 아니다. 시작하지 않은 일은 0이다.", a: "" },
  { t: "완벽한 하루를 기다리다 아무 날도 쓰지 못한다.", a: "" },
  { t: "천천히 가는 것을 두려워 말고, 멈춰 서는 것을 두려워하라.", a: "중국 속담" },
  { t: "동기는 시작한 뒤에 따라온다. 먼저 움직여라.", a: "" },
  { t: "매일 조금씩 하는 사람을 몰아치는 사람이 이길 수 없다.", a: "" },
  { t: "큰 그릇은 늦게 만들어진다.", a: "노자 · 대기만성" },
  { t: "오늘 할 수 있는 최소한을 하라. 그게 내일의 나를 만든다.", a: "" },
  { t: "재능은 시작하게 하고, 습관은 끝내게 한다.", a: "" },
  { t: "지치는 건 약해서가 아니라 배터리가 작아서다. 나눠 써라.", a: "" },
  { t: "끝까지 해본 경험 하나가 자신감의 전부를 바꾼다.", a: "" },
  { t: "물이 바위를 뚫는 것은 힘이 아니라 반복이다.", a: "" },
  { t: "하루를 잘 보내는 법은 하나만 정해서 그것만 하는 것이다.", a: "" },
  { t: "미루는 것은 게으름이 아니라, 시작 장벽이 높다는 신호다.", a: "" },
  { t: "실패한 날을 세지 말고, 다시 시작한 날을 세라.", a: "" }
];
function quoteFor(dateString) {
  const p = String(dateString).split("-").map(Number);
  const key = p[0] * 372 + p[1] * 31 + p[2];
  return QUOTES[key % QUOTES.length];
}

// bootstrap: record visit, render. Plan is generated only on button press.
function boot() {
  saveVisits(recordVisit(loadVisits(), todayStr()));
  render();
  if (notifyOn()) startNotifyLoop();
  // 현재/다음 블록 표시가 시간이 지나면 갱신되도록 1분마다 리렌더
  if (typeof setInterval !== "undefined") {
    setInterval(function () { if (!generating && !breaking) render(); }, 60000);
  }
}

// ---- exports for node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeStreak, visitGrid, recordVisit, goalProgress, nextPendingTasks,
    findGoal, extractJSON, todayStr, dateStr, addDays, pad2, activeDate,
    templatePlan, mapAIBlocks, coreStatus, generatePlan, profileContext, loadProfile,
    parseTaskList, breakdownGoalNow, parseTextSchedule, repairTruncatedJSON, weekdayOf, dateWithWeekday, normalizeMeals, quoteFor, currentCycle, currentAge, isOnTime, blockStartMinutes, blockEndMinutes, setBlockDone, currentBlock, daySummary, replanFromNow, keepableBlocks, render
  };
}

if (typeof document !== "undefined") boot();
