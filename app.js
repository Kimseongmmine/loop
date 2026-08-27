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
  { key: "prefs", label: "선호·비선호", ph: "예: 운동은 수영 / 아침 일찍은 싫음 / 카페에서 집중 잘됨" },
  { key: "courses", label: "이번 학기 과목", ph: "예: 데이터베이스 / 확률과통계 / 수치해석 / 기계학습개론 / 대규모병렬컴퓨팅" },
  { key: "places", label: "자주 가는 장소 · 이동 시간", ph: "예: 경북대 중앙도서관 / 집 책상 / 카페는 3시간 이상 앉을 때만 / 수영장 · 집→학교 25분" }
];

// 식단 강화용 필드. 전부 선택이며, 채운 것만 AI에 전달된다.
const MEAL_FIELDS = [
  { key: "fridge", label: "냉장고·찬장에 있는 것", ph: "예: 계란 10개 / 닭가슴살 3팩 / 김치 / 두부 2모 / 즉석밥 / 양파·대파", area: true },
  { key: "foodGoal", label: "식단 목표", ph: "예: 체중 5kg 감량 / 근육 늘리기 / 지금 유지 / 아침 거르지 않기" },
  { key: "foodAvoid", label: "못 먹는 것 · 피할 것", ph: "예: 유당 불내증 / 오이 싫음 / 매운 것 약함" },
  { key: "foodNote", label: "그 밖의 조건 (가중치)", ph: "예: 자취라 조리 10분 이내 / 한 끼 5천원 이내 / 점심은 학식 / 저녁은 알바 후라 늦음", area: true }
];
const BODY_FIELDS = [
  { key: "heightCm", label: "키 (cm)", ph: "175" },
  { key: "weightKg", label: "몸무게 (kg)", ph: "68" }
];

// 키·몸무게로 BMI와 하루 필요 열량 추정치(Mifflin-St Jeor, 가벼운 활동)를 낸다.
// 어디까지나 참고 추정치이며 의학적 처방이 아니다.
function bodyStats(profile, now) {
  const h = parseFloat(profile && profile.heightCm);
  const w = parseFloat(profile && profile.weightKg);
  if (!(h > 0) || !(w > 0)) return null;
  const age = ((now || new Date()).getFullYear()) - BIRTH_YEAR;
  const m = h / 100;
  const bmi = w / (m * m);
  const bmr = 10 * w + 6.25 * h - 5 * age + 5;   // 남성 기준
  const tdee = Math.round(bmr * 1.4 / 10) * 10;  // 가벼운 활동
  return { heightCm: h, weightKg: w, age: age, bmi: Math.round(bmi * 10) / 10, tdee: tdee };
}

// 식단 프롬프트에 넣을 컨텍스트를 조립 (순수)
function mealContext(profile, now) {
  const lines = [];
  const fridge = (profile.fridge || "").trim();
  const goal = (profile.foodGoal || "").trim();
  const avoid = (profile.foodAvoid || "").trim();
  const note = (profile.foodNote || "").trim();
  const b = bodyStats(profile, now);
  if (fridge) lines.push("지금 있는 재료(이걸 최대한 활용해서 짜라): " + fridge);
  if (b) lines.push("몸: 키 " + b.heightCm + "cm, 몸무게 " + b.weightKg + "kg, BMI " + b.bmi + ", 하루 필요 열량 추정 " + b.tdee + "kcal (참고치)");
  if (goal) lines.push("식단 목표: " + goal);
  if (avoid) lines.push("못 먹는 것·피할 것(반드시 제외): " + avoid);
  if (note) lines.push("그 밖의 조건: " + note);
  return lines.join("\n");
}

const OLD_DEFAULT_PLACES = "경북대 중앙도서관 / 집 책상 / 카페는 3시간 이상 앉을 때만 / 수영장";
const DEFAULT_COURSES = "데이터베이스 / 확률과통계 / 수치해석 / 기계학습개론 / 대규모병렬컴퓨팅";
// 자유 텍스트에서 과목 이름만 뽑는다 (순수)
function parseCourses(text) {
  return String(text || "")
    .split(/[\/,·\n]+/)
    .map(function (x) { return x.trim().slice(0, 30); })
    .filter(function (x) { return x.length > 1; })
    .slice(0, 10);
}
const DEFAULT_PLACES = "경북대 중앙도서관 25분 / 집 앞 스터디카페 5분 / 집 책상 / 수영장 15분 / 카페는 3시간 이상 앉을 때만";
function loadProfile() {
  const p = lsGet(K_PROFILE, { goals: [] });
  if (!p || !Array.isArray(p.goals)) return { goals: [] };
  // migrate legacy `situation` -> `traits`
  if (p.situation && !p.traits) { p.traits = p.situation; delete p.situation; }
  // 빈 입력창을 만들지 않는다(원칙 1). 한 번도 손대지 않았을 때만 기본 장소를 채워둔다.
  if (p.courses === undefined) p.courses = DEFAULT_COURSES;
  if (p.places === undefined) p.places = DEFAULT_PLACES;
  // 한 번도 안 고친 옛 기본값만 새 기본값으로 올린다. 직접 적은 값은 안 건드린다.
  else if (p.places === OLD_DEFAULT_PLACES) p.places = DEFAULT_PLACES;
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
  const co = (profile.courses || "").trim();
  if (co) lines.push("이번 학기 과목: " + co);
  const pl = (profile.places || "").trim();
  if (pl) lines.push("자주 가는 장소·이동 시간(각 블록의 place로 쓸 것): " + pl);
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
        const tk = qq.tasks[i];
        out.push({
          goalId: qq.goal.id, goalTitle: qq.goal.title, taskId: tk.id, text: tk.text,
          kind: tk.kind || taskKind(tk.text, qq.goal.title)
        });
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
// 한 번 쏘고 마는 대신, 한도(429)·일시 장애(503)에는 잠깐 쉬었다 다시, 그다음 다른 모델로.
const GEM_FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-2.5-flash"];
function isQuotaError(msg) { return /429|quota|rate limit|resource_exhausted/i.test(String(msg || "")); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function geminiChat(messages, maxTokens, parse) {
  const key = getGemKey();
  if (!key || typeof fetch === "undefined") { lastAIError = "Gemini 키가 없습니다."; return null; }
  const tried = {};
  const order = [getGemModel()].concat(GEM_FALLBACK_MODELS).filter(function (m) {
    if (!m || tried[m]) return false; tried[m] = true; return true;
  });
  for (let i = 0; i < order.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = await geminiOnce(key, order[i], messages, maxTokens, parse);
      if (v != null) { lastAIError = ""; return v; }
      if (!isQuotaError(lastAIError) || attempt) break;   // 한도 문제일 때만 한 번 쉬었다 재시도
      await sleep(1200);
    }
  }
  return null;
}
async function geminiOnce(key, model, messages, maxTokens, parse) {
  const sys = messages.filter(function (m) { return m.role === "system"; }).map(function (m) { return m.content; }).join("\n");
  const userParts = messages.filter(function (m) { return m.role !== "system"; }).map(function (m) { return { text: m.content }; });
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key);
  const body = { contents: [{ role: "user", parts: userParts }], generationConfig: { maxOutputTokens: maxTokens || 4096, temperature: 0.6 } };
  // force clean JSON output when the caller expects to parse it (no preamble / reasoning text)
  if (parse) body.generationConfig.responseMimeType = "application/json";
  if (sys) body.system_instruction = { parts: [{ text: sys }] };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      let b = ""; try { b = await res.text(); } catch (e) {}
      let msg = b; try { const j = JSON.parse(b); msg = (j.error && j.error.message) || b; } catch (e) {}
      lastAIError = "Gemini HTTP " + res.status + " · " + String(msg).slice(0, 200) + " [" + model + "]";
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
  if (getGemKey()) {
    const v = await geminiChat(messages, maxTokens, parse);
    if (v != null) return v;
    if (!getKey()) return null;
    const gemErr = lastAIError;
    const w = await orChat(messages, maxTokens, parse);      // Gemini가 죽으면 예비 경로를 쓴다
    if (w == null) lastAIError = gemErr + " / " + lastAIError;
    return w;
  }
  return orChat(messages, maxTokens, parse);
}

// ---- plan building (pure) ----
// fixed realistic schedule; core = up to 3 study blocks carrying a task
// ---- 장소 (어디서 할지까지 정해두면 시작 마찰이 준다) ----
const LONG_STUDY_MIN = 180;   // 이 이상 앉을 때만 카페, 그보다 짧으면 도서관
const MIN_BLOCK_MIN = 20;     // 이동을 끼워 넣고도 이만큼은 남아야 한다
const EVENING_MIN = 18 * 60;  // 이 시각 뒤 학습은 집 근처에서
function minToClock(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
}
// 프로필 장소 텍스트에서 쓸 이름과 이동 시간을 뽑는다 (순수)
function placeRules(profile) {
  const t = String((profile && profile.places) || "");
  const seg = t.split(/[\/,·\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  function pick(keys, fallback) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      for (let j = 0; j < seg.length; j++) {
        const idx = seg[j].indexOf(k);
        if (idx >= 0) return seg[j].slice(0, idx + k.length);
      }
    }
    return fallback;
  }
  const mm = t.match(/(\d{1,3})\s*분/);
  const base = mm ? Math.max(5, Math.min(120, Number(mm[1]))) : 20;
  // 세그먼트마다 적힌 분을 그 장소의 이동 시간으로 쓴다 ("집 앞 스터디카페 5분")
  const mins = {};
  seg.forEach(function (line) {
    const m2 = line.match(/(\d{1,3})\s*분/);
    if (!m2) return;
    const name = line.slice(0, m2.index).trim().replace(/[-·→>]+$/, "").trim();
    if (name) mins[name] = Math.max(0, Math.min(120, Number(m2[1])));
  });
  const lib = pick(["도서관", "독서실"], "도서관");
  const cafe = pick(["스터디카페", "카페"], "카페");
  const gym = pick(["수영장", "헬스장", "체육관"], "운동");
  const home = pick(["집"], "집");
  // 저녁엔 멀리 안 간다: 집이 이름에 들어간 학습 장소가 있으면 그걸 쓴다
  const nearHome = seg.filter(function (x) { return /집.*(카페|독서실|도서관)/.test(x); })[0];
  const night = nearHome ? nearHome.replace(/\s*\d{1,3}\s*분.*$/, "").trim() : home;
  if (mins[home] === undefined) mins[home] = 0;
  return {
    lib: lib, cafe: cafe, gym: gym, home: home, night: night,
    mins: mins, commuteMin: base
  };
}
// 두 장소 사이 이동 시간. 각자 집에서 얼마나 먼지로 어림한다. (순수)
function commuteBetween(a, b, rules) {
  if (!a || !b || a === b) return 0;
  const mins = (rules && rules.mins) || {};
  const def = (rules && rules.commuteMin) || 20;
  const va = mins[a] === undefined ? def : mins[a];
  const vb = mins[b] === undefined ? def : mins[b];
  return Math.max(va, vb);
}
// place 가 비어 있는 블록만 규칙으로 채운다. 사용자가 적은 특별 일정은 건드리지 않는다. (순수)
function fillPlaces(blocks, profile) {
  const r = placeRules(profile || {});
  let prev = null;
  return (blocks || []).map(function (b) {
    if (b.move) return b;
    if (b.place || b.event) { if (b.place) prev = b.place; return b; }
    const st = blockStartMinutes(b.time), en = blockEndMinutes(b.time);
    const len = (st != null && en != null) ? en - st : 0;
    const t = String(b.text || "");
    let place;
    if (/수영|헬스|운동/.test(t)) place = r.gym;
    else if (/기상|취침|잠자|샤워/.test(t)) place = r.home;
    else if (b.taskId || b.core || /집중|공부|복습|정리|풀기|강의|과제|독서/.test(t)) {
      // 구현 과제는 집 노트북에서 다 된다 (사용자 확인) — 이동을 만들 이유가 없다
      if (b.kind === "구현") place = r.home;
      else if (st != null && st >= EVENING_MIN) place = r.night;   // 저녁엔 멀리 안 나간다
      else place = len >= LONG_STUDY_MIN ? r.cafe : r.lib;
    }
    else if (/점심|저녁|아침|식사|휴식|산책|물|눈|쉬/.test(t)) place = (prev && prev !== r.gym) ? prev : r.home;
    else place = prev || r.home;
    // 밤엔 집. 단 저녁 학습 장소로 이미 정해진 건 그대로 둔다.
    if (st != null && st >= 21 * 60 && !(place === r.night && (b.taskId || b.core)) && !/수영|헬스|알바|수업/.test(t)) place = r.home;
    prev = place;
    const out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    out.place = place;
    return out;
  });
}
// 장소가 바뀌는 지점에 이동 블록을 끼운다. (순수)
// 이동 시간은 **앞 블록 끝에서** 가져온다 — 뒤를 미루면 목적지 활동이 깎인다(운동 60분 -> 35분).
// 앞 블록이 내줄 수 없으면 예전처럼 뒤 블록을 미룬다.
// rulesOrMin: 숫자면 모든 이동에 같은 시간, placeRules 결과면 장소별 시간.
function insertCommutes(blocks, rulesOrMin) {
  const rules = (rulesOrMin && typeof rulesOrMin === "object") ? rulesOrMin : null;
  const flat = rules ? null : Math.max(5, rulesOrMin || 20);
  const out = [];
  let prev = null;
  (blocks || []).forEach(function (b) {
    const st = blockStartMinutes(b.time), en = blockEndMinutes(b.time);
    const n = rules ? commuteBetween(prev, b.place, rules) : flat;
    if (b.place && prev && b.place !== prev && n > 0 && st != null && en != null) {
      // 직전이 짧은 휴식이면 그 자리를 이동이 대신한다 — 걷는 게 곧 휴식이고, 행도 하나 준다
      const before = out[out.length - 1];
      const bs = before ? blockStartMinutes(before.time) : null;
      const be = before ? blockEndMinutes(before.time) : null;
      const absorb = before && isFillerBlock(before) && bs != null && be === st && (be - bs) <= n;
      const from = absorb ? bs : st;
      const rest = absorb ? Math.max(0, n - (be - bs)) : n;
      if (absorb) out.pop();
      // 특별 일정은 시각이 고정이다 — 이동 때문에 병원 14:00 이 밀리면 안 된다
      const canShift = !b.event;
      if ((en - (st + rest)) >= MIN_BLOCK_MIN && (rest === 0 || canShift)) {
        out.push(moveBlock(from, st + rest, prev, b.place));
        if (rest > 0) {
          const moved = {};
          Object.keys(b).forEach(function (k) { moved[k] = b[k]; });
          moved.time = minToClock(st + rest) + "-" + minToClock(en);
          b = moved;
        }
      } else if (absorb) {
        out.push(moveBlock(from, st, prev, b.place));   // 뒤를 깎을 수 없으면 흡수한 만큼만
      }
    }
    if (b.place) prev = b.place;
    out.push(b);
  });
  return out;
}
// 계획을 채우려고 넣은 짧은 생활 블록인가 (순수)
const FILLER_RE = /점심|저녁|아침|식사|휴식|산책|물|눈|쉬/;
function isFillerBlock(b) {
  return !!b && !b.core && !b.taskId && !b.move && !b.event && FILLER_RE.test(String(b.text || ""));
}
function moveBlock(from, to, a, b) {
  return {
    id: genId("b"), time: minToClock(from) + "-" + minToClock(to),
    text: "이동 · " + a + " → " + b,
    place: null, goalId: null, taskId: null, core: false, done: false, move: true
  };
}

// ---- 특별 일정 (그날 하루만 있는 예외 일정) ----
const K_EVENTS = "loop.events";   // { "YYYY-MM-DD": "14:00 병원 / 19시-21시 알바" }
function loadEvents() { return lsGet(K_EVENTS, {}) || {}; }
function getEvent(date) { const e = loadEvents()[date]; return e ? String(e) : ""; }
function setEvent(date, text) {
  const all = loadEvents();
  const t = String(text || "").trim();
  if (t) all[date] = t.slice(0, 400); else delete all[date];
  lsSet(K_EVENTS, all);
}

function clockOf(h, m) {
  const hh = Number(h); if (!(hh >= 0 && hh <= 24)) return null;
  const mm = (m == null || m === "") ? 0 : Number(m); if (!(mm >= 0 && mm < 60)) return null;
  return pad2(hh) + ":" + pad2(mm);
}
function addHour(clock) {
  const c = clock.split(":");
  return pad2((Number(c[0]) + 1) % 24) + ":" + c[1];
}
// "14:00 병원", "14시-16시 알바", "과제 마감" -> [{time|null, text}] (pure)
// 시각으로 인정하는 표기는 ':' 또는 '시'가 붙은 경우뿐. ("1-10번 풀기"를 시간으로 오해하지 않도록)
function parseEvents(text) {
  const out = [];
  String(text || "").split(/[\n,\u00b7]+/).forEach(function (raw) {
    let line = raw.trim();
    if (!line) return;
    line = line.replace(/(\d{1,2})\s*시\s*(\d{1,2})\s*분/g, function (_, h, mm) { return h + ":" + pad2(Number(mm)); });
    const pm = /^오후\s*/.test(line), am = /^오전\s*/.test(line);
    if (pm || am) {
      line = line.replace(/^(오전|오후)\s*/, "");
      if (pm) line = line.replace(/^(\d{1,2})/, function (h) { return Number(h) < 12 ? String(Number(h) + 12) : h; });
    }
    const range = line.match(/^(\d{1,2})(?::(\d{2})|시)\s*(?:-|~|부터)\s*(\d{1,2})(?::(\d{2})|시)\s*(?:까지)?\s*(.+)$/);
    if (range) {
      const a = clockOf(range[1], range[2]), b = clockOf(range[3], range[4]);
      if (a && b) { out.push({ time: a + "-" + b, text: range[5].trim() }); return; }
    }
    const one = line.match(/^(\d{1,2})(?::(\d{2})|시)\s*(?:에)?\s*(.+)$/);
    if (one) {
      const a = clockOf(one[1], one[2]);
      if (a) { out.push({ time: a + "-" + addHour(a), text: one[3].trim() }); return; }
    }
    out.push({ time: null, text: line });
  });
  return out.filter(function (e) { return e.text; });
}
// 템플릿 폴백에도 특별 일정을 실제 블록으로 넣는다(AI가 죽어도 일정이 사라지지 않게).
function mergeEventBlocks(blocks, text) {
  const evs = parseEvents(text);
  if (!evs.length) return blocks;
  const timed = evs.filter(function (e) { return e.time; });
  const kept = blocks.filter(function (b) {
    const s = blockStartMinutes(b.time), e = blockEndMinutes(b.time);
    if (s == null || e == null) return true;
    return !timed.some(function (ev) {
      const es = blockStartMinutes(ev.time), ee = blockEndMinutes(ev.time);
      return es != null && ee != null && s < ee && es < e;   // 겹치는 템플릿 블록은 일정에 자리를 내준다
    });
  });
  evs.forEach(function (ev) {
    kept.push({ id: genId("b"), time: ev.time || "시간 미정", text: ev.text, goalId: null, taskId: null, core: false, done: false, event: true });
  });
  return kept;
}

// ---- 데이터 백업 (브라우저 저장소는 지워질 수 있다: 사파리 7일 미접속 삭제, 용량 부족 시 오리진 통째 삭제) ----
// API 키는 절대 내보내지 않는다. 백업 파일이 남에게 가도 키는 안 넘어간다.
const DATA_KEYS = [K_PROFILE, K_PLANS, K_VISITS, K_ENERGY, K_NOTES, K_DONE, K_EVENTS];
const K_BACKUP_AT = "loop.backup_at";
const BACKUP_NAME = "loop-backup.json";
function exportPayload() {
  const data = {};
  DATA_KEYS.forEach(function (k) {
    try { const v = localStorage.getItem(k); if (v != null) data[k] = v; } catch (e) {}
  });
  return { app: "loop", version: 1, exportedAt: new Date().toISOString(), data: data };
}
// 백업을 되돌린다. 형식이 아니거나 깨진 항목은 건너뛴다. 되돌린 항목 수를 반환.
function applyImport(payload) {
  const p = (typeof payload === "string") ? JSON.parse(payload) : payload;
  if (!p || p.app !== "loop" || !p.data || typeof p.data !== "object") throw new Error("LOOP 백업 파일이 아닙니다");
  let n = 0;
  DATA_KEYS.forEach(function (k) {
    const v = p.data[k];
    if (typeof v !== "string") return;
    try { JSON.parse(v); } catch (e) { return; }
    try { localStorage.setItem(k, v); n++; } catch (e) {}
  });
  if (!n) throw new Error("되돌릴 항목이 없습니다");
  return n;
}
function lastBackupAt() { try { return localStorage.getItem(K_BACKUP_AT) || ""; } catch (e) { return ""; } }
let dataMsg = "";
// PC(크로미움)는 같은 파일에 덮어쓰기, 그 외에는 다운로드.
async function downloadBackup() {
  const text = JSON.stringify(exportPayload(), null, 2);
  try {
    if (typeof window !== "undefined" && window.showSaveFilePicker) {
      const h = await window.showSaveFilePicker({ suggestedName: BACKUP_NAME, types: [{ description: "LOOP 백업", accept: { "application/json": [".json"] } }] });
      const w = await h.createWritable(); await w.write(text); await w.close();
    } else {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = BACKUP_NAME;
      if (document.body) document.body.appendChild(a);
      a.click();
      if (a.remove) a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    try { localStorage.setItem(K_BACKUP_AT, new Date().toISOString()); } catch (e) {}
    dataMsg = "내보냈습니다 · " + BACKUP_NAME;
  } catch (e) { dataMsg = ""; }   // 사용자가 취소하면 아무 일도 없다
  render();
}
function importBackup(file) {
  if (!file) return;
  const rd = new FileReader();
  rd.onload = function () {
    try { dataMsg = "되돌렸습니다 · 항목 " + applyImport(String(rd.result)) + "개"; }
    catch (e) { dataMsg = "되돌리기 실패 · " + (e && e.message ? e.message : "형식 오류"); }
    render();
  };
  rd.readAsText(file);
}
// 저장소를 지우지 말라고 브라우저에 요청한다(크로미움은 조용히 판단, 파이어폭스는 물어봄).
function askPersist() {
  try {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.persist) return;
    if (navigator.storage.persisted) navigator.storage.persisted().then(function (ok) { if (!ok) navigator.storage.persist(); });
    else navigator.storage.persist();
  } catch (e) {}
}

function templatePlan(candidates) {
  const c = candidates || [];
  function study(i, time) {
    if (c[i]) return { id: genId("b"), time: time, text: retrievalText(c[i].text, c[i].kind), goalId: c[i].goalId, taskId: c[i].taskId, reviewId: c[i].reviewId || null, kind: c[i].kind || null, core: true, done: false };
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
    c[3] ? { id: genId("b"), time: "19:00-21:00", text: retrievalText(c[3].text, c[3].kind), goalId: c[3].goalId, taskId: c[3].taskId, reviewId: c[3].reviewId || null, kind: c[3].kind || null, core: false, done: false }
         : life("19:00-21:00", "가벼운 복습 · 정리"),
    life("21:00-22:00", "오늘 기록 · 독서")
  ];
}

// map AI-returned blocks to Block objects, resolving `ref` index into candidates
function mapAIBlocks(aiBlocks, candidates) {
  if (!Array.isArray(aiBlocks)) return null;
  const out = aiBlocks.map(function (b) {
    const ref = (typeof b.ref === "number") ? candidates[b.ref] : null;
    const kind = ref ? (ref.kind || null) : null;
    const raw = String((ref ? (b.text || ref.text) : b.text) || "").slice(0, 80);
    return {
      id: genId("b"),
      time: String(b.time || "").slice(0, 20),
      text: ref ? retrievalText(raw, kind) : raw,
      kind: kind,
      goalId: ref ? ref.goalId : null,
      taskId: ref ? ref.taskId : null,
      reviewId: ref ? (ref.reviewId || null) : null,
      place: String(b.place || "").slice(0, 24) || null,
      first: String(b.first || "").slice(0, 40) || null,
      move: /^이동/.test(String(b.text || "")),
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

// 착수 창. 시작 ±ON_TIME_MIN 안에서만 착수할 수 있고, 놓치면 그 블록은 닫힌다.
// 완료는 막지 않는다 — 이미 착수한 두 시간짜리 블록은 끝나고 눌러야 하기 때문.
// 시각을 못 읽는 블록은 잠그지 않는다(영영 못 누르는 행을 만들지 않는다).
function startWindow(block, date, now) {
  now = now || new Date();
  const start = blockStartMinutes(block && block.time);
  if (start == null) return { open: true, state: "free" };
  const today = todayStr(now);
  if (date > today) return { open: false, state: "future" };   // 내일 계획은 미리 못 누른다
  if (date < today) return { open: false, state: "missed" };
  const d = (now.getHours() * 60 + now.getMinutes()) - start;
  if (d < -ON_TIME_MIN) return { open: false, state: "early" };
  if (d > ON_TIME_MIN) return { open: false, state: "missed" };
  return { open: true, state: "open" };
}

const LOCK_LABEL = { early: "아직", missed: "놓침", future: "내일" };
function lockReason(w) {
  if (!w || w.open) return "";
  if (w.state === "early") return "시작 " + ON_TIME_MIN + "분 전부터 누를 수 있습니다";
  if (w.state === "future") return "그날이 되면 누를 수 있습니다";
  return "착수할 수 있는 시간(시작 ±" + ON_TIME_MIN + "분)이 지났습니다";
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

// 자잘한 블록인가 — 체크할 것도 없고 자리만 차지한다 (순수)
const MICRO_MIN = 25;
function isMicroBlock(b) {
  if (!b || b.core || b.taskId || b.event) return false;
  if (b.move) return true;
  const st = blockStartMinutes(b.time), en = blockEndMinutes(b.time);
  return st != null && en != null && (en - st) <= MICRO_MIN;
}
// 하루를 [지난 것 · 지금 구간 · 이따] 로 쪼갠다 (순수)
// 지금 안 할 일이 지금 할 일과 같은 크기로 깔려 있으면 계획표를 읽을 수 없다.
function splitDay(blocks, nowMin, isToday, ahead) {
  const list = blocks || [];
  const a = (ahead == null) ? 3 : ahead;
  if (!isToday) return { past: [], live: list.slice(0, a + 1), later: list.slice(a + 1) };
  let idx = 0;
  while (idx < list.length) {
    const en = blockEndMinutes(list[idx].time);
    if (en == null || en > nowMin) break;
    idx++;
  }
  return { past: list.slice(0, idx), live: list.slice(idx, idx + a + 1), later: list.slice(idx + a + 1) };
}
// "12:00~22:00" (순수)
function spanText(list) {
  if (!list || !list.length) return "";
  const a = blockStartMinutes(list[0].time);
  const b = blockEndMinutes(list[list.length - 1].time);
  return (a == null || b == null) ? "" : minToClock(a) + "~" + minToClock(b);
}

// 하루 결산 (순수)
function daySummary(plan) {
  const blocks = (plan && plan.blocks) || [];
  const core = blocks.filter(function (b) { return b.core; });
  const onTime = core.filter(function (b) { return b.onTime; });
  const late = core.filter(function (b) { return (b.started || b.done) && !b.onTime; });
  const missed = core.filter(function (b) { return !b.started && !b.done; });
  return {
    coreTotal: core.length,
    onTime: onTime.length,
    late: late.length,
    missedList: missed.map(function (b) { return b.text; }),
    allDone: core.length > 0 && missed.length === 0
  };
}

// ---- 세션 기록 ----
// 기록이 목적이 아니다. "90분 계획을 실제로 55분 한다"를 알아내 계획을 현실로 끌어내리는 게 목적이다.
// 사람이 자기 계획을 짜면 실제 수행량의 몇 배로 잡는다는 게 사전등록 RCT 결과다.
const K_SESSIONS = "loop.sessions";
const SESSION_KEEP = 200;
function loadSessions() { const v = lsGet(K_SESSIONS, []); return Array.isArray(v) ? v : []; }
function saveSessions(v) { lsSet(K_SESSIONS, v.slice(-SESSION_KEEP)); }
function addSession(date, block, actualMin, breaks) {
  const planned = (function () {
    const st = blockStartMinutes(block.time), en = blockEndMinutes(block.time);
    return (st != null && en != null) ? (en - st) : null;
  })();
  if (planned == null || actualMin == null) return null;
  const rec = {
    date: date, blockId: block.id, kind: block.kind || null,
    plannedMin: planned, actualMin: Math.max(0, Math.round(actualMin)), breaks: breaks || 0
  };
  const all = loadSessions();
  all.push(rec);
  saveSessions(all);
  return rec;
}
// 유형별 계획 대비 실제 비율. 기록이 없으면 null — 없는 걸 지어내지 않는다. (순수하지 않음)
const SESSION_MIN_N = 3;   // 이만큼 쌓이기 전에는 말하지 않는다
function sessionStats(days, today) {
  const from = addDays(today || todayStr(new Date()), -(days || 21));
  const rows = loadSessions().filter(function (r) { return r.date >= from && r.plannedMin > 0; });
  if (!rows.length) return null;
  const by = {};
  rows.forEach(function (r) {
    const k = r.kind || "기타";
    by[k] = by[k] || { n: 0, planned: 0, actual: 0, breaks: 0 };
    by[k].n++; by[k].planned += r.plannedMin; by[k].actual += r.actualMin; by[k].breaks += r.breaks || 0;
  });
  const out = {};
  Object.keys(by).forEach(function (k) {
    const b = by[k];
    if (b.n < SESSION_MIN_N) return;
    out[k] = { n: b.n, ratio: Math.round((b.actual / b.planned) * 100) / 100, breaks: Math.round((b.breaks / b.n) * 10) / 10 };
  });
  return Object.keys(out).length ? out : null;
}
// AI에게 줄 한 줄. 없으면 빈 문자열 — 프롬프트를 억지로 채우지 않는다. (순수)
function sessionLine(stats) {
  if (!stats) return "";
  const parts = Object.keys(stats).map(function (k) {
    return k + " 과제는 계획의 " + stats[k].ratio + "배";
  });
  return parts.length ? ("실제로 걸리는 시간: " + parts.join(", ") + " (이 비율에 맞춰 블록 길이를 잡아라)") : "";
}

// ---- 하루 과목 수 · 시험 역산 ----
// 5과목을 라운드로빈하면 하루에 다섯 번 문맥이 바뀐다. 세 과목까지만 다룬다.
const DAILY_COURSES = 3;
const HEAVY_COURSE = /기계학습|머신러닝|확률|통계|확통|데이터베이스|데베/;   // 사용자가 부담된다고 한 것

// 그 과목을 마지막으로 계획에 넣은 날. 없으면 null. (최근 days일만 본다)
function lastTouched(goalId, today, days) {
  const plans = loadPlans();
  for (let i = 1; i <= (days || 14); i++) {
    const d = addDays(today, -i);
    const pl = plans[d];
    if (pl && (pl.blocks || []).some(function (b) { return b.goalId === goalId; })) return d;
  }
  return null;
}
// 오늘 이 과목을 다뤄야 하는 정도. 큰 쪽이 먼저. (순수하지 않음 — 계획 기록을 읽는다)
function courseScore(goal, today) {
  let sc = 0;
  const d = daysUntil(goal.deadline, today);
  if (d != null) sc += Math.max(0, 60 - Math.max(0, d)) * 2;      // 마감이 가까울수록 크게
  if (HEAVY_COURSE.test(goal.title)) sc += 15;                    // 부담된다고 한 과목
  const last = lastTouched(goal.id, today, 14);
  const gap = last == null ? 14 : Math.round((new Date(today.split("-")[0], +today.split("-")[1] - 1, +today.split("-")[2])
    - new Date(last.split("-")[0], +last.split("-")[1] - 1, +last.split("-")[2])) / 86400000);
  sc += Math.min(14, gap) * 3;                                     // 며칠씩 비지 않게
  return sc;
}
// 오늘 다룰 과목. 남은 과제가 있는 것 중에서만 고른다. (결정론적 — 같은 날 같은 상태면 같은 답)
function dailyCourses(profile, today, max) {
  const live = ((profile && profile.goals) || []).filter(function (g) {
    return (g.tasks || []).some(function (t) { return !t.done; });
  });
  return live
    .map(function (g) { return { g: g, s: courseScore(g, today) }; })
    .sort(function (a, b) { return (b.s - a.s) || (a.g.id < b.g.id ? -1 : 1); })
    .slice(0, max || DAILY_COURSES)
    .map(function (x) { return x.g; });
}

// "1~6장" -> 6, "3장" -> 3, "1-4주차" -> 4. 못 읽으면 null (순수)
function scopeUnits(scope) {
  const t = String(scope || "");
  let m = t.match(/(\d{1,3})\s*[~\-–ï½ž]\s*(\d{1,3})\s*(장|절|챕터|주차|강)/);
  if (m) { const n = Number(m[2]) - Number(m[1]) + 1; return { n: n > 0 ? n : null, unit: m[3] }; }
  m = t.match(/(\d{1,3})\s*(장|절|챕터|주차|강)/);
  if (m) return { n: Number(m[1]), unit: m[2] };
  return { n: null, unit: "" };
}
// 마감까지 이 속도로 끝나는가. 격려하지 않고 숫자만. (순수하지 않음 — 오늘 날짜만 받는다)
function examPace(goal, today) {
  const daysLeft = daysUntil(goal && goal.deadline, today);
  if (daysLeft == null) return null;
  const su = scopeUnits(goal.scope);
  const pr = goalProgress(goal);
  const out = { daysLeft: daysLeft, unit: su.unit, total: su.n, done: null, left: null, daysPer: null, need: null };
  if (su.n && pr.total) {
    out.done = Math.round(su.n * (pr.done / pr.total) * 10) / 10;
    out.left = Math.round((su.n - out.done) * 10) / 10;
    if (out.left > 0 && daysLeft > 0) {
      out.daysPer = Math.round((daysLeft / out.left) * 10) / 10;   // 며칠에 한 단위
      out.need = Math.round((out.left / daysLeft) * 100) / 100;    // 하루에 몇 단위
    }
  }
  return out;
}
// 목표 카드에 한 줄. 사실만.
function paceLine(goal, today) {
  const p2 = examPace(goal, today);
  if (!p2) return "";
  const head = p2.daysLeft >= 0 ? ("D-" + p2.daysLeft) : ("마감 " + (-p2.daysLeft) + "일 지남");
  if (!p2.total) return head;
  const body = p2.total + p2.unit + " 중 " + p2.done + p2.unit + " · 남은 " + p2.left + p2.unit;
  if (p2.left <= 0) return head + " · " + p2.total + p2.unit + " 다 함";
  if (p2.daysLeft <= 0) return head + " · " + body;
  const rate = p2.need >= 1
    ? ("하루 " + p2.need + p2.unit)
    : (p2.daysPer + "일에 1" + p2.unit);
  return head + " · " + body + " → " + rate;
}

// ---- 복습 큐 (간격 반복) ----
// 틀린 것만 다시 뜬다. 아는 걸 다시 읽는 시간이 사라지는 게 이 기능의 값어치다.
const K_REVIEWS = "loop.reviews";
const REVIEW_STEPS = [1, 3, 7, 16, 35];   // 라이트너 상자 1~5의 간격(일)
const REVIEW_MIN = 30;                    // 복습 블록 길이. isMicroBlock(25분)에 안 걸리게
function loadReviews() { const v = lsGet(K_REVIEWS, []); return Array.isArray(v) ? v : []; }
function saveReviews(v) { lsSet(K_REVIEWS, v); }

// 다음 차례를 정한다. 맞히면 상자 하나 위, 틀리면 1로. (순수)
function scheduleReview(item, correct, today) {
  const box = correct ? Math.min(REVIEW_STEPS.length, (item.box || 1) + 1) : 1;
  const out = {};
  Object.keys(item || {}).forEach(function (k) { out[k] = item[k]; });
  out.box = box;
  out.due = addDays(today, REVIEW_STEPS[box - 1]);
  out.seen = (item.seen || 0) + 1;
  return out;
}
function addReview(goalId, kind, text, today, note) {
  const t = String(text || "").trim();
  if (!t) return null;
  const all = loadReviews();
  const same = all.filter(function (r) { return r.goalId === goalId && r.text === t; })[0];
  if (same) {                                  // 같은 걸 또 틀렸다 -> 처음으로 되돌린다
    same.box = 1;
    same.due = addDays(today, REVIEW_STEPS[0]);
    if (note) same.missed = String(note).slice(0, 80);
    saveReviews(all);
    return same;
  }
  const item = {
    id: genId("r"), goalId: goalId || null, kind: kind || "개념",
    text: t.slice(0, 70), missed: note ? String(note).slice(0, 80) : "",
    box: 1, due: addDays(today, REVIEW_STEPS[0]), seen: 0, made: today
  };
  all.push(item);
  saveReviews(all);
  return item;
}
// 시험이 가까울수록 새 진도보다 굳히기다. 하루에 넣을 복습 개수를 늘린다. (순수하지 않음)
const REVIEW_QUOTA = { far: 2, near: 4, imminent: 5 };
function reviewQuota(profile, date) {
  let min = null;
  ((profile && profile.goals) || []).forEach(function (g) {
    const d = daysUntil(g.deadline, date);
    if (d != null && d >= 0 && (min == null || d < min)) min = d;
  });
  if (min == null) return REVIEW_QUOTA.far;
  if (min <= 3) return REVIEW_QUOTA.imminent;
  if (min <= 7) return REVIEW_QUOTA.near;
  return REVIEW_QUOTA.far;
}

// 오늘까지 차례가 된 것. 오래 밀린 것부터. (순수하지 않음 — 저장소를 읽는다)
function dueReviews(date, limit) {
  return loadReviews()
    .filter(function (r) { return r.due && r.due <= date; })
    .sort(function (a, b) { return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0); })
    .slice(0, limit || 3);
}
// 복습을 계획 후보 모양으로. 학습 과제와 같은 자리에 섞인다.
function dueReviewCandidates(date, profile, limit) {
  return dueReviews(date, limit).map(function (r) {
    const g = findGoal(profile, r.goalId);
    return {
      goalId: r.goalId, goalTitle: g ? g.title : "복습", taskId: null, reviewId: r.id,
      text: "복습 — " + r.text, kind: r.kind, review: true
    };
  });
}
// 복습 블록을 끝냈다. 한 줄이 적혀 있으면 틀린 것으로 본다.
// correct 를 넘기면 그대로 쓴다. 안 넘기면 한 줄이 비었는지로 판단한다.
function settleReview(reviewId, note, today, correct) {
  const all = loadReviews();
  const i = all.map(function (r) { return r.id; }).indexOf(reviewId);
  if (i < 0) return null;
  if (correct == null) correct = !String(note || "").trim();
  const next = scheduleReview(all[i], correct, today);
  if (!correct && String(note || "").trim()) next.missed = String(note).slice(0, 80);
  // 여섯 번을 봤는데도 1번 상자면 그대로 두면 매일 나온다. 열흘 물리고 쪼개라고 표시한다.
  if (isLeech(next)) { next.due = addDays(today, LEECH_REST); next.leech = true; }
  all[i] = next;
  saveReviews(all);
  return next;
}
// Gemini가 만든 인출 문제를 되받는다. 번호 목록 또는 "Q:" 줄. 답(--- 아래)은 버린다. (순수)
function parseQuestions(text) {
  const body = String(text || "").split(/^\s*-{3,}\s*$/m)[0];   // 답을 몰아둔 구획 앞까지
  const out = [];
  body.split(/\r?\n/).forEach(function (line) {
    let m = line.match(/^\s*(?:\d{1,2}[.)]|[-*•]|Q\s*[:.])\s*(.+?)\s*$/i);
    if (!m) return;
    const t = m[1].replace(/\*\*/g, "").trim();
    if (t.length > 4) out.push(t.slice(0, 140));
  });
  return out;
}
// 오늘 차례가 된 항목에 순서대로 붙인다. 개수가 안 맞으면 있는 만큼만.
function attachQuestions(date, list) {
  const qs = Array.isArray(list) ? list : parseQuestions(list);
  if (!qs.length) return 0;
  const all = loadReviews();
  const due = all.filter(function (r) { return r.due && r.due <= date; })
    .sort(function (a, b) { return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0); });
  let n = 0;
  due.forEach(function (r, i) { if (qs[i]) { r.q = qs[i]; n++; } });
  if (n) saveReviews(all);
  return n;
}

// ---- 여러 번 틀린 항목 (leech) ----
// 계속 1번 상자로 떨어지는 항목이 큐를 잠식한다. 표시해서 잠시 물리고, 쪼개라고 말해준다.
const LEECH_AT = 6;
const LEECH_REST = 10;   // 물리는 날 수
function isLeech(item) { return !!item && (item.seen || 0) >= LEECH_AT && (item.box || 1) <= 1; }
function leechItems() { return loadReviews().filter(isLeech); }

// 유형마다 묻는 말이 다르다. 한 줄을 넘지 않는다 — 입력 부담은 이탈 원인이다.
const ASK_LABEL = {
  구현: "막혔던 지점?",
  문제: "틀린 번호?",
  유도: "막힌 단계?",
  개념: "안 나온 것?"
};
function askLabel(kind) { return ASK_LABEL[kind] || "안 된 것?"; }

// ---- 브리지: 앱이 아는 사실을 프롬프트에 박아 Gemini 앱으로 보낸다 ----
// 무료 API 티어를 쥐어짜는 대신, 무거운 추론은 사용자가 쓰는 유료 Gemini 앱이 한다.
// 이 상수들이 이 기능의 본체다. 나중에 Gemini에게 "이 프롬프트를 개선해줘" 하고 여기만 갈아끼우면 된다.
// ---- 지난 나 ----
// 앱이 매일 조금씩 쌓아온 것(회고·배터리·착수·완료·막힌 지점)을 한 덩어리로 모은다.
// 이 더미가 재료다. 하루치는 아무 의미가 없지만 한 달치는 본인도 못 보는 패턴을 갖고 있다. (순수)
const PAST_MIN_DAYS = 5;   // 이보다 적으면 패턴이랄 게 없다. 죽은 버튼을 만들지 않는다
function pastRecord(today, days) {
  const n = days || 30;
  const plans = loadPlans(), notes = loadNotes(), energy = loadEnergy();
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const p = plans[d], note = String(notes[d] || "").trim(), e = energy[d] || null;
    if (!p && !note && !e) continue;          // 아무것도 안 남긴 날은 넣지 않는다
    const core = p ? p.blocks.filter(function (b) { return b.core; }) : [];
    rows.push({
      date: d,
      weekday: weekdayOf(d),
      note: note,
      energy: e,
      onTime: core.filter(function (b) { return b.onTime; }).length,
      fin: core.filter(function (b) { return b.done; }).length,
      total: core.length
    });
  }
  const stuck = [];
  const all = loadStuck();
  Object.keys(all).forEach(function (k) {
    (all[k] || []).slice(-4).forEach(function (s) { stuck.push(s); });
  });
  return { rows: rows, done: loadDone().slice(-25), stuck: stuck.slice(-12), span: rows.length };
}

const PROMPTS = {
  past:
    "아래는 내가 지난 며칠 동안 실제로 남긴 기록이다. 이 기록만 근거로 답하라.\n\n" +
    "답할 것\n" +
    "1. 이 기록에서 반복되는 패턴 3개. 내가 스스로는 못 볼 만한 것 위주로\n" +
    "2. 무너진 날과 버틴 날을 가른 게 무엇인지 (배터리·요일·과목·시각 중 무엇이 갈랐나)\n" +
    "3. 다음 한 주에 딱 하나만 바꾼다면 무엇인가\n\n" +
    "규칙\n" +
    "- 기록에 없는 것을 지어내지 마라. 근거가 모자라면 '자료 부족'이라고 써라\n" +
    "- 각 주장 옆에 근거가 된 날짜를 괄호로 달아라\n" +
    "- 위로·칭찬·격려·자책 유도 전부 금지. 사실과 다음 동작만",

  breakdown:
    "너는 컴퓨터공학 전공 3학년의 학습 코치다. 아래 과목들을 이번 학기에 실제로 완수하려면 뭘 해야 하는지 구체적 과제로 쪼개라.\n\n" +
    "규칙\n" +
    "- 각 과제는 한 번에 60분 안에 끝낼 수 있어야 한다\n" +
    "- '무엇을 얼마나'가 명확해야 한다. 추상적 표현 금지('공부하기', '정리하기', '복습하기')\n" +
    "- 좋은 예: '3장 연습문제 1~10번 풀기', 'CUDA 행렬곱 커널 짜고 로컬 테스트', '정규화 1NF~3NF 정의 백지에 쓰기'\n" +
    "- 코드를 짜는 과제는 '짜기'/'디버깅'처럼 동작이 드러나게 써라\n" +
    "- 과목마다 6~8개, 쉬운 것부터 순서대로\n\n" +
    "출력은 아래 형식만. 인사·설명·머리말 없이 바로 시작하라.\n" +
    "## 과목이름\n1. 과제\n2. 과제\n## 다음 과목이름\n1. 과제",

  retrieval:
    "너는 내 학습 코치다. 아래 항목들을 내가 \"안 보고\" 답할 수 있는지 확인하는 문제로 바꿔라.\n\n" +
    "규칙\n" +
    "- 항목당 문제 1~2개\n" +
    "- 개념·유도 항목은 백지에 재현하게 하는 문제로 ('~을 유도하라', '~의 정의와 조건을 쓰라')\n" +
    "- 구현 항목은 코드를 쓰게 하지 말고 판단을 물어라 ('이 증상이면 뭘 먼저 확인하나')\n" +
    "- 내가 틀렸던 지점이 적혀 있으면 그 지점을 반드시 건드려라\n" +
    "- 답은 문제 뒤에 몰아서 '---' 아래에 한꺼번에 둬라. 먼저 풀 수 있게\n\n" +
    "출력은 문제 목록부터 바로 시작하라.",

  stuck:
    "지금 막혔다. 답을 통째로 주지 말고 다음 한 걸음만 알려줘.\n\n" +
    "규칙\n" +
    "- 먼저 내가 뭘 잘못 짚고 있는지 한 문장\n" +
    "- 그다음 지금 당장 할 수 있는 확인 하나만\n" +
    "- 전체 해답과 완성 코드는 내가 다시 요청할 때까지 주지 마라\n" +
    "- 위로하거나 격려하지 마라. 사실과 다음 동작만",

  pace:
    "내 진도가 현실적인지 봐줘. 위로하지 말고 숫자로만 답해라.\n\n" +
    "답할 것\n" +
    "1. 지금 페이스로 마감까지 끝나는가 (된다/안 된다 + 며칠 초과)\n" +
    "2. 안 되면 무엇을 버려야 하는가. 버릴 우선순위를 이유와 함께\n" +
    "3. 남은 기간에 시험 점수를 가장 크게 올리는 항목 3개\n\n" +
    "격려·응원 문장은 넣지 마라."
};

// 앱이 아는 사실 + 고정 프롬프트 = 붙여넣을 것 (순수)
function buildPrompt(kind, ctx) {
  const c = ctx || {};
  const head = PROMPTS[kind];
  if (!head) return "";
  const lines = [head, ""];
  if (kind === "past") {
    const r = c.rec || { rows: [], done: [], stuck: [] };
    lines.push("[하루하루 기록]  날짜 · 요일 · 배터리 · 핵심 정시착수/완료/전체 · 그날 한 줄");
    r.rows.forEach(function (x) {
      lines.push("- " + x.date + " " + x.weekday +
        " · 배터리 " + (x.energy || "미기록") +
        " · " + x.onTime + "/" + x.fin + "/" + x.total +
        (x.note ? ("  — \"" + x.note + "\"") : ""));
    });
    if (r.done.length) {
      lines.push("", "[끝낸 과제]");
      r.done.forEach(function (d) { lines.push("- " + d.date + " " + d.text + (d.goalTitle ? (" · " + d.goalTitle) : "")); });
    }
    if (r.stuck.length) {
      lines.push("", "[막혔던 지점]");
      r.stuck.forEach(function (s) { lines.push("- " + s); });
    }
    if (c.traits) lines.push("", "[내 특성 — 참고]", c.traits);
  } else if (kind === "breakdown") {
    lines.push("[내 과목]");
    (c.goals || []).forEach(function (g) {
      lines.push("- " + g.title +
        (g.scope ? (" · 범위 " + g.scope) : "") +
        (g.deadline ? (" · 마감/시험 " + g.deadline) : "") +
        (g.note ? (" · " + g.note) : ""));
    });
    if (c.traits) lines.push("", "[내 특성 — 참고]", c.traits);
  } else if (kind === "retrieval") {
    lines.push("[오늘 확인할 것]");
    (c.items || []).forEach(function (it) {
      lines.push("- (" + (it.course || "과목") + " · " + (it.kind || "개념") + ") " + it.text +
        (it.missed ? ("  — 지난번 틀린 곳: " + it.missed) : "") +
        (it.leech ? "  — 여러 번 놓쳤다. 더 작은 조각으로 나눠서 물어봐라" : ""));
    });
  } else if (kind === "stuck") {
    lines.push("[상황]");
    lines.push("과목: " + (c.course || "-") + " (" + (c.kind || "-") + ")");
    lines.push("지금 하는 것: " + (c.text || "-"));
    lines.push("막힌 지점: " + (c.note || "(아직 안 적음)"));
    if (c.past && c.past.length) lines.push("전에 같은 과목에서 막혔던 곳: " + c.past.join(" / "));
  } else if (kind === "pace") {
    lines.push("[상황] 오늘 " + (c.today || ""));
    (c.goals || []).forEach(function (g) {
      lines.push("- " + g.title +
        (g.deadline ? (" · 마감 " + g.deadline + (g.daysLeft != null ? (" (D-" + g.daysLeft + ")") : "")) : " · 마감 미정") +
        (g.scope ? (" · 범위 " + g.scope) : "") +
        " · 과제 " + g.done + "/" + g.total + " 완료");
    });
    if (c.recent) lines.push("", "[최근 실제 진도] " + c.recent);
  }
  return lines.join("\n");
}

// Gemini가 돌려준 목록을 다시 읽는다. "## 과목" + 번호 목록. (순수)
function parseCourseTasks(text) {
  const out = {};
  let cur = null;
  String(text || "").split(/\r?\n/).forEach(function (line) {
    const h = line.match(/^\s*#{1,4}\s*(.+?)\s*$/) || line.match(/^\s*\[(.+?)\]\s*$/);
    if (h) { cur = h[1].replace(/[:：]\s*$/, "").trim(); if (cur) out[cur] = out[cur] || []; return; }
    const li = line.match(/^\s*(?:\d{1,2}[.)]|[-*•])\s*(.+?)\s*$/);
    if (li && cur && li[1].length > 1) out[cur].push(li[1].replace(/\*\*/g, "").trim());
  });
  Object.keys(out).forEach(function (k) { if (!out[k].length) delete out[k]; });
  return out;
}

// ---- 과제 유형 ----
// 무료 모델에게 묻지 않는다. 5과목이 정해져 있어 패턴이 좁고, 규칙이 더 정확하고 0원·0지연이다.
const KINDS = ["개념", "문제", "유도", "구현"];
// 과목이 주로 어떤 일인지 (기본값)
const COURSE_KIND = [
  { re: /병렬|cuda|gpu|컴퓨팅|시스템|운영체제|네트워크/i, kind: "구현" },
  { re: /확률|통계|확통|선형대수/i, kind: "문제" },
  { re: /수치해석|수치|알고리즘|이산/i, kind: "유도" },
  { re: /기계학습|머신러닝|딥러닝|인공지능|ml\b/i, kind: "유도" },
  { re: /데이터베이스|데베|\bdb\b|컴파일러|소프트웨어/i, kind: "개념" }
];
function courseKind(title) {
  const t = String(title || "");
  for (let i = 0; i < COURSE_KIND.length; i++) if (COURSE_KIND[i].re.test(t)) return COURSE_KIND[i].kind;
  return "개념";
}
// 과제 문장이 과목 기본값을 덮는다. 순서가 곧 우선순위다.
const TASK_KIND = [
  { re: /cuda|커널|kernel|sql|numpy|파이썬|python|코드|구현|디버그|디버깅|실습|컴파일|프로파일|짜기|돌려|실행/i, kind: "구현" },
  { re: /유도|증명|수렴|보장|전개|도출/, kind: "유도" },
  { re: /연습문제|기출|풀기|계산|\d+\s*번/, kind: "문제" }
];
function taskKind(text, goalTitle) {
  const t = String(text || "");
  for (let i = 0; i < TASK_KIND.length; i++) if (TASK_KIND[i].re.test(t)) return TASK_KIND[i].kind;
  return courseKind(goalTitle);
}
// 유형마다 필요한 최소 길이가 다르다. 구현은 컴파일·디버깅 사이클이 들어간다.
const KIND_MIN = { 구현: 90, 문제: 60, 유도: 60, 개념: 40 };
const KIND_TARGET = { 구현: 110, 문제: 75, 유도: 75, 개념: 50 };
function blockMinutesFor(kind) {
  return { min: KIND_MIN[kind] || 60, target: KIND_TARGET[kind] || 60 };
}
// 다시 읽기 대신 안 보고 인출. 학습과학에서 안 깎인 두 축 중 하나다.
// 코드는 백지가 안 통하므로 구현·문제에는 안 붙인다.
function retrievalText(text, kind) {
  const t = String(text || "");
  if (!t || /안 보고/.test(t) || /^복습 — /.test(t)) return t;
  if (kind === "개념") return "안 보고 써보기 — " + t;
  if (kind === "유도") return "안 보고 유도 — " + t;
  return t;
}

// ---- 첫 동작: 그 자리에 도착해서 5분 안에 끝나는 물리적 동작 하나 ----
// 시작이 막히는 지점은 "장소"가 아니라 "다음 몸동작"이 비어 있는 것이다.
const FIRST_SKIP = /점심|저녁|아침|식사|휴식|산책|물 한 잔|눈 휴식|기상|취침|잠자/;
const KIND_FIRST = {
  구현: "터미널 열고 빌드/실행 한 번 돌리기",
  문제: "첫 1문제만 풀기",
  유도: "결과 식만 적어놓고 백지에서 거슬러 올라가기",
  개념: "목차만 보고 백지에 아는 것 쏟기"
};
function firstStep(block) {
  const b = block || {};
  if (b.first) return String(b.first);
  const t = String(b.text || "");
  if (b.move) return "지금 일어나서 나가기";
  if (/수영|헬스|운동/.test(t)) return "옷 갈아입고 가방 챙기기";
  if (b.event || FIRST_SKIP.test(t)) return null;
  if (b.kind && KIND_FIRST[b.kind]) return KIND_FIRST[b.kind];
  if (b.taskId || b.core || /집중|공부|복습|정리|풀기|강의|과제|독서|문제/.test(t)) {
    const short = t.length > 26 ? (t.slice(0, 26) + "…") : t;
    return "자리에 앉아 " + short + " · 5분만";
  }
  return null;
}

// 핵심 카운터는 "정시 착수"만 인정
function coreStatus(blocks) {
  const core = (blocks || []).filter(function (b) { return b.core; });
  return {
    done: core.filter(function (b) { return b.onTime; }).length,           // 정시 착수
    late: core.filter(function (b) { return (b.started || b.done) && !b.onTime; }).length,
    fin: core.filter(function (b) { return b.done; }).length,
    total: core.length
  };
}

// toggle a block; sync its linked goal task
const K_STUCK = "loop.stuck";   // { goalId: ["막혔던 지점", ...] }
function loadStuck() { return lsGet(K_STUCK, {}) || {}; }
function addStuck(goalId, text) {
  const t = String(text || "").trim();
  if (!goalId || !t) return;
  const all = loadStuck();
  all[goalId] = (all[goalId] || []).concat([t.slice(0, 80)]).slice(-20);
  lsSet(K_STUCK, all);
}

// ---- 브리지 UI 상태 ----
let bridgeMsg = "";
let promptText = "";     // 클립보드가 막혔을 때 직접 복사하라고 띄우는 원문
let pasteOpen = false;

function copyPrompt(text) {
  bridgeMsg = "";
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        bridgeMsg = "복사됐습니다. Gemini에 붙여넣으세요.";
        promptText = "";
        render();
      }, function () { promptText = text; render(); });
      return;
    }
  } catch (e) {}
  promptText = text;      // 클립보드 API가 없거나 막힘 → 직접 복사
  render();
}

// Gemini가 준 목록을 목표에 넣는다. 제목이 겹치는 목표를 찾고, 없으면 만든다.
function importCourseTasks(text) {
  const map = parseCourseTasks(text);
  const names = Object.keys(map);
  if (!names.length) return 0;
  const p = loadProfile();
  let n = 0;
  names.forEach(function (name) {
    let g = p.goals.filter(function (x) {
      return x.title.indexOf(name) >= 0 || name.indexOf(x.title) >= 0;
    })[0];
    if (!g) { g = { id: genId("g"), title: name, note: "", tasks: [], analyzedAt: null }; p.goals.push(g); }
    const have = {};
    (g.tasks || []).forEach(function (t) { have[t.text] = true; });
    map[name].slice(0, 12).forEach(function (txt) {
      const t = String(txt).slice(0, 70);
      if (have[t]) return;
      g.tasks.push({ id: genId("t"), text: t, done: false, kind: taskKind(t, g.title) });
      n++;
    });
    g.analyzedAt = new Date().toISOString();
  });
  if (n) saveProfile(p);
  return n;
}

// ---- 계획 고치기 ----
// AI가 하루 뼈대를 정하고, 사용자는 자리만 바꾼다. 시각은 그대로 두고 내용을 옮긴다.
// 이렇게 하면 특별 일정과 이미 지나간 블록이 밀려나지 않는다.

// 옮길 수 있는 블록 — 이동·짧은 휴식은 파생물, 특별 일정은 시각이 고정 (순수)
function editableBlocks(blocks) {
  return (blocks || []).filter(function (b) { return !isMicroBlock(b) && !b.event; });
}
// 옮겨 다니는 것들. 자리에 남는 것(time·기록)과 구분한다.
const CARRIED = ["text", "goalId", "taskId", "first", "core"];
function swapSlots(blocks, idA, idB) {
  const list = blocks || [];
  const a = list.filter(function (b) { return b.id === idA; })[0];
  const b2 = list.filter(function (b) { return b.id === idB; })[0];
  if (!a || !b2 || a === b2) return list;
  if (isMicroBlock(a) || isMicroBlock(b2) || a.event || b2.event) return list;
  return list.map(function (b) {
    if (b !== a && b !== b2) return b;
    const other = (b === a) ? b2 : a;
    const out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    CARRIED.forEach(function (k) { out[k] = other[k]; });
    return out;
  });
}
// 한 칸 위/아래로 — 옮길 수 있는 블록끼리만 센다 (순수)
function shiftBlock(blocks, id, dir) {
  const movable = editableBlocks(blocks);
  let i = -1;
  movable.forEach(function (b, n) { if (b.id === id) i = n; });
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= movable.length) return blocks;   // 끝이면 아무 일도 안 한다
  return swapSlots(blocks, movable[i].id, movable[j].id);
}
// 그 자리의 과제만 갈아끼운다. first 는 지워서 firstStep 이 다시 만들게 한다. (순수)
function swapTask(blocks, id, cand) {
  if (!cand) return blocks;
  return (blocks || []).map(function (b) {
    if (b.id !== id) return b;
    const out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    out.text = String(cand.text || "").slice(0, 80);
    out.goalId = cand.goalId || null;
    out.taskId = cand.taskId || null;
    out.first = null;
    return out;
  });
}
// 블록을 빼고 앞 블록을 그만큼 늘린다 — 구멍을 남기지 않는다 (순수)
function dropBlock(blocks, id) {
  const list = blocks || [];
  let i = -1;
  list.forEach(function (b, n) { if (b.id === id) i = n; });
  if (i < 0 || list.length < 2) return list;
  const gone = list[i];
  const gs = blockStartMinutes(gone.time), ge = blockEndMinutes(gone.time);
  const out = list.slice(0, i).concat(list.slice(i + 1));
  const nb = i > 0 ? out[i - 1] : out[0];
  const ns = blockStartMinutes(nb.time), ne = blockEndMinutes(nb.time);
  if (gs != null && ge != null && ns != null && ne != null) {
    const grown = {};
    Object.keys(nb).forEach(function (k) { grown[k] = nb[k]; });
    grown.time = (i > 0)
      ? minToClock(ns) + "-" + minToClock(Math.max(ne, ge))       // 앞 블록이 뒤로 늘어남
      : minToClock(Math.min(ns, gs)) + "-" + minToClock(ne);      // 첫 블록이면 뒤 블록이 당겨짐
    out[i > 0 ? i - 1 : 0] = grown;
  }
  return out;
}
// 교체 후보 — 오늘 계획에 아직 안 들어간 미완료 과제. AI를 부르지 않는다.
function swapCandidates(profile, blocks, limit) {
  const used = {};
  (blocks || []).forEach(function (b) { if (b.taskId) used[b.taskId] = true; });
  return nextPendingTasks(profile, 12)
    .filter(function (c) { return !used[c.taskId]; })
    .slice(0, limit || 4);
}
// 모든 편집이 지나는 단 하나의 저장 경로.
// 자리를 바꾸면 장소도 달라진다(11시 학습을 19시로 옮기면 도서관 -> 집 앞 스터디카페).
// 그래서 이동 블록을 버리고 장소를 비운 뒤 다시 계산한다.
function applyEdit(date, mutate) {
  const plans = loadPlans();
  const plan = plans[date];
  if (!plan) return null;
  const prof = loadProfile();
  const before = plan.blocks.filter(function (b) { return !b.move; });
  const edited = mutate(before);
  if (!edited || edited === before) return null;                  // 옮길 데가 없으면 아무 일도 안 한다
  const cleared = edited.map(function (b) {
    if (b.event) return b;
    const out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    out.place = null;
    return out;
  });
  plan.blocks = insertCommutes(fillPlaces(cleared, prof), placeRules(prof));
  plan.editedAt = new Date().toISOString();
  savePlans(plans);
  return plan.blocks;
}

// 블록을 끝낸다. 한 줄이 적혀 있으면 "틀렸다"로 읽어 복습 큐에 넣는다.
// 복습 블록이면 상자를 올리거나(비었으면) 1로 되돌린다(적혀 있으면).
// 인출로 확인할 수 있는 유형인가. 코드는 백지가 안 통한다.
function isRecallable(kind) { return kind === "개념" || kind === "유도"; }

function finishBlock(date, block, correct) {
  const note = (askDraft[block.id] || "").trim();
  // 착수 시각이 있어야 실제 시간을 안다. 없으면 기록하지 않는다(지어내지 않는다).
  if (block.startedAt) {
    const ms = new Date().getTime() - new Date(block.startedAt).getTime();
    if (ms > 0) addSession(date, block, ms / 60000, focusBreaks[block.id] || 0);
  }
  delete focusBreaks[block.id];
  if (block.reviewId) {
    settleReview(block.reviewId, note, date, correct);
  } else {
    const clean = String(block.text || "").replace(/^(안 보고 (써보기|유도) — |첫 1개만 · )/, "");
    // 인출로 확인할 수 있는 과제는 한 줄을 안 적어도 큐에 넣는다.
    // 안 그러면 타이핑을 한 번도 안 한 사람에게는 복습이 영영 안 쌓인다.
    if (note || isRecallable(block.kind)) addReview(block.goalId, block.kind, clean, date, note);
    if (note) addStuck(block.goalId, note);
  }
  delete askDraft[block.id];
  setBlockDone(date, block.id, true, new Date());
}

// 착수 기록: 완료가 아니라 "시작했는가". 정시 판정은 여기서 한 번만 굳는다.
function setBlockStarted(date, blockId, now) {
  const plans = loadPlans();
  const plan = plans[date];
  if (!plan) return null;
  const block = plan.blocks.find(function (b) { return b.id === blockId; });
  if (!block || block.started) return block || null;
  if (!startWindow(block, date, now).open) return null;   // 창 밖이면 착수 자체가 안 된다
  block.started = true;
  block.startedAt = (now || new Date()).toISOString();
  block.onTime = isOnTime(block, date, now);
  savePlans(plans);
  return block;
}

function setBlockDone(date, blockId, checked, now) {
  const plans = loadPlans();
  const plan = plans[date];
  if (!plan) return;
  const block = plan.blocks.find(function (b) { return b.id === blockId; });
  if (!block) return;
  // 착수 없이 완료부터 누르는 건 그 순간의 착수와 같다 → 창이 닫혔으면 그것도 막는다.
  // 이미 착수한 블록의 완료·해제는 언제든 된다.
  if (checked && !block.started && !startWindow(block, date, now).open) return;
  block.done = checked;
  // 착수 기록 없이 완료부터 누른 경우엔 그 순간을 착수로 본다(예전 데이터와 같은 뜻).
  if (checked && !block.started) {
    block.started = true;
    block.startedAt = (now || new Date()).toISOString();
    block.onTime = isOnTime(block, date, now);
  } else if (!checked && !block.startedAt) {
    block.started = false;
    block.onTime = false;
  }
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
    return list.slice(0, 10).map(function (t) {
      const text = String(t).slice(0, 70);
      return { id: genId("t"), text: text, done: false, kind: taskKind(text, goal.title) };
    });
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
    "코드를 짜는 과제(CUDA·SQL·구현·디버깅)는 컴파일과 디버깅 사이클이 들어가므로 90분 미만으로 쪼개지 마라. " +
    "학습·운동 블록마다 first(첫 동작)를 넣어라: 그 장소에 도착해서 5분 안에 끝나는 물리적 동작 하나. 20자 내외로 아주 구체적으로('노트북 열고 3장 1번 문제만 읽기', '수경 챙겨서 탈의실 들어가기'). 추상적 표현 금지. 휴식·식사·이동에는 넣지 마라. " +
        "[특별 일정]이 있으면 그 시각을 그 일정 블록으로 채우고, 원래 그 시간에 넣으려던 학습은 다른 시간으로 옮겨라. 시각이 없는 일정은 그날 안의 적절한 시간에 넣어라. " +
    "meals에는 그날의 아침·점심·저녁을 제안한다. 규칙: [식단 조건]의 '지금 있는 재료'를 최대한 활용하고, 못 먹는 것은 반드시 제외하며, 조리 조건·목표(감량/증량/유지)·열량 추정치를 반영한다. 한 끼 20자 내외로 구체적으로. " +
    "shopping에는 지금 재료로 부족해서 사두면 좋은 것을 3~6개, 짧은 품목명으로 넣는다(이미 있다고 적힌 재료는 넣지 마라). 재료 정보가 없으면 shopping은 빈 배열. " +
    "장소와 첫 동작은 앱이 알아서 채우니 넣지 마라. " +
    "오직 JSON만: {\"blocks\":[{\"time\":\"09:00-11:00\",\"text\":\"...\",\"ref\":0,\"core\":true}]," +
    "\"meals\":{\"아침\":\"...\",\"점심\":\"...\",\"저녁\":\"...\"},\"shopping\":[\"품목1\",\"품목2\"]}";
  const ctx = profileContext(loadProfile());
  const evt = targetDate ? getEvent(targetDate) : "";
  const mctx = mealContext(loadProfile(), new Date());
  const list = candidates.map(function (c, i) { return i + ": " + c.text + " (" + c.goalTitle + ")"; }).join("\n");
  const energy = targetDate ? getEnergy(targetDate) : "";
  const sline = sessionLine(sessionStats(21, targetDate || todayStr(new Date())));
  const notes = targetDate ? recentNotes(targetDate, 3) : [];
  const usr =
    (when ? ("[날짜] " + when + "\n\n") : "") +
    (evt ? ("[특별 일정 - 반드시 반영, 이 시간엔 다른 걸 넣지 마라]\n" + evt + "\n\n") : "") +
    (opts.fromTime ? ("[지금 " + opts.fromTime + "] 하루가 이미 시작됐다. " + opts.fromTime + "부터 취침까지 남은 시간만으로 다시 짜라. 지나간 시간은 넣지 마라. 남은 시간이 짧으면 핵심을 줄여라.\n\n") : "") +
    (energy && ENERGY_RULE[energy] ? ("[오늘 배터리] " + ENERGY_RULE[energy] + "\n\n") : "") +
    (ctx ? ("[내 프로필]\n" + ctx + "\n\n") : "") +
    (sline ? ("[내가 실제로 쓰는 시간]\n" + sline + "\n\n") : "") +
    (mctx ? ("[식단 조건]\n" + mctx + "\n\n") : "") +
    (notes.length ? ("[최근 회고 — 반영해서 조정]\n" + notes.map(function (n) { return "- " + n.date + ": " + n.text; }).join("\n") + "\n\n") : "") +
    "[후보 과제]\n" + (list || "(없음)") +
    "\n\n위 날짜/요일에 맞춰 시간표와 식단을 JSON으로.";
  // accept JSON {blocks:[...]}, a bare JSON array, OR a plain text schedule
  const parse = function (c) {
    const j = extractJSON(c);
    if (j && Array.isArray(j.blocks) && j.blocks.length) return { blocks: j.blocks, meals: j.meals || null, shopping: j.shopping || null };
    if (j && Array.isArray(j.schedule) && j.schedule.length) return { blocks: j.schedule, meals: j.meals || null, shopping: j.shopping || null };
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
  return { blocks: blocks, meals: normalizeMeals(res.meals), shopping: normalizeShopping(res.shopping) };
}

// 장보기 목록 정규화: 짧은 품목명 최대 6개
function normalizeShopping(arr) {
  if (!Array.isArray(arr)) return null;
  const out = arr.map(function (x) {
    if (typeof x === "string") return x.trim();
    return (x && (x.name || x.item || x.text) ? String(x.name || x.item || x.text).trim() : "");
  }).filter(function (v) { return v && v.length <= 30; }).slice(0, 6);
  return out.length ? out : null;
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
    // 과제 쪼개기는 여기서 하지 않는다. 5과목이면 콜이 6번 나가 무료 한도를 바로 넘긴다.
    // 쪼개기는 목표 탭의 "✨ 과제 쪼개기 프롬프트" → Gemini 앱 → 붙여넣기로 한다(쿼터 0).
    // 여기서 쓰는 콜은 시간표 배치 한 번뿐이다.
    // 2) build the hourly plan (AI, else template)
    // 오늘 차례가 된 복습을 먼저 놓고, 남은 자리를 새 과제로 채운다.
    const prof0 = loadProfile();
    const revs = dueReviewCandidates(targetDate, prof0, reviewQuota(prof0, targetDate));
    // 하루 세 과목까지만. 다섯 과목을 돌리면 하루에 다섯 번 문맥이 바뀐다.
    const today3 = { goals: dailyCourses(prof0, targetDate, DAILY_COURSES) };
    const candidates = revs.concat(nextPendingTasks(today3, Math.max(3, 6 - revs.length)));
    let blocks = null, meals = null, shopping = null, source = "template";
    if (aiOn) {
      const res = await aiGeneratePlan(candidates, targetDate, opts);
      if (res) { blocks = fillPlaces(res.blocks, loadProfile()); meals = res.meals; shopping = res.shopping; source = "ai"; }
    }
    if (!blocks) {
      const prof = loadProfile();
      blocks = insertCommutes(
        fillPlaces(mergeEventBlocks(templatePlan(candidates), getEvent(targetDate)), prof),
        placeRules(prof)
      );
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
      shopping: shopping || (prev && prev.shopping) || null,
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
// 브랜드 링(loop). SVG는 네임스페이스로 만들어야 실제로 렌더된다.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgRing() {
  if (!document.createElementNS) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ring");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9");
  svg.appendChild(c);
  return svg;
}


function el(tag, opts) {
  const n = document.createElement(tag);
  if (opts) {
    if (opts.text != null) n.textContent = String(opts.text);
    if (opts.cls) n.className = opts.cls;
    if (opts.html != null) n.innerHTML = opts.html;
  }
  return n;
}

// ---- render ----
// 어떤 <details>가 열려 있었는지 기억해 재렌더 후 복원한다.
const openPanels = {};
// 기능 버튼에서 해당 카드로 데려간다. 테스트용 가짜 DOM에는 없는 API라 전부 감싼다.
function scrollTo(id) {
  try {
    const n = document.getElementById(id);
    if (n && n.scrollIntoView) n.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {}
}

function markOpen(det, key) {
  det.open = !!openPanels[key];
  det.addEventListener("toggle", function () { openPanels[key] = det.open; });
  return det;
}

// 재렌더가 사용자의 작업을 삼키지 않도록 포커스·커서·열린 패널을 보존한다.
// ---- 탭: 계획표가 메인이고, 나머지는 각자 페이지를 갖는다 ----
const TABS = [
  { key: "today", label: "오늘", icon: "📋" },
  { key: "goal", label: "목표", icon: "🎯" },
  { key: "flow", label: "흐름", icon: "🀄" },
  { key: "me", label: "설정", icon: "⚙" }
];
let tabKey = "today";
function currentTab() {
  try {
    if (typeof location !== "undefined" && location.hash) {
      const h = location.hash.replace(/^#\/?/, "");
      if (TABS.some(function (t) { return t.key === h; })) return h;
    }
  } catch (e) {}
  return tabKey;
}
function goTab(k) {
  tabKey = k;
  closeFocusQuiet();
  try { if (typeof location !== "undefined") location.hash = "#/" + k; } catch (e) {}
  render();
  try { if (typeof window !== "undefined" && window.scrollTo) window.scrollTo(0, 0); } catch (e) {}
}
function renderTopbar() {
  const bar = el("header", { cls: "topbar" });
  const tab = currentTab();
  // 로고가 곧 홈 버튼이다
  const mark = el("button", { cls: "mark homebtn" });
  mark.setAttribute("aria-label", "오늘 화면으로");
  mark.title = "오늘 화면으로";
  const ring = svgRing();
  if (ring) mark.appendChild(ring);
  mark.appendChild(el("h1", { cls: "brand", text: "LOOP" }));
  mark.addEventListener("click", function () { goTab("today"); });
  bar.appendChild(mark);
  // 다른 화면에 들어와 있으면 돌아가는 길을 눈에 보이게 둔다
  if (tab !== "today") {
    const back = el("button", { cls: "backbtn", text: "← 오늘" });
    back.addEventListener("click", function () { goTab("today"); });
    bar.appendChild(back);
  }
  const now = new Date();
  const target = activeDate(now);
  const streak = computeStreak(loadVisits(), todayStr(now));
  if (streak > 0) bar.appendChild(el("span", { cls: "tstreak", text: "🔥 " + streak + "일" }));
  bar.appendChild(el("span", { cls: "tdate", text: (target !== todayStr(now) ? "내일 · " : "") + dateWithWeekday(target) }));
  return bar;
}
function renderTabbar() {
  const nav = el("nav", { cls: "tabbar" });
  nav.setAttribute("aria-label", "화면 이동");
  const cur = currentTab();
  TABS.forEach(function (t) {
    const b = el("button", { cls: "tab" + (t.key === cur ? " on" : "") });
    b.appendChild(el("span", { cls: "ticon", text: t.icon }));
    b.appendChild(el("span", { cls: "tlabel", text: t.label }));
    b.setAttribute("aria-current", t.key === cur ? "page" : "false");
    b.addEventListener("click", function () { goTab(t.key); });
    nav.appendChild(b);
  });
  return nav;
}

// ---- 실행 모드: 지금 블록 하나만 남기고 전부 치운다 ----
let focusId = null;      // 열어둔 블록 id
const askDraft = {};     // blockId -> 한 줄 초안 (리렌더를 견딘다)
const focusBreaks = {};  // blockId -> 실행 모드에서 탭을 벗어난 횟수 (사실만 센다)
let focusUntil = 0;      // 5분 타이머 종료 시각(ms). 0이면 안 돎
let focusTick = null;
function openFocus(id) { focusId = id; focusUntil = 0; render(); }
// 탭을 벗어나면 센다. 화면에 평가를 쓰지 않는다 — 계획 길이를 고치는 데만 쓴다.
function noteBreak() {
  if (!focusId) return;
  try { if (typeof document !== "undefined" && !document.hidden) return; } catch (e) { return; }
  focusBreaks[focusId] = (focusBreaks[focusId] || 0) + 1;
}
function closeFocusQuiet() {
  focusId = null; focusUntil = 0;
  if (focusTick && typeof clearInterval !== "undefined") { clearInterval(focusTick); focusTick = null; }
}
function closeFocus() { closeFocusQuiet(); render(); }
function startFive() {
  focusUntil = Date.now() + 5 * 60 * 1000;
  if (typeof setInterval !== "undefined" && !focusTick) {
    focusTick = setInterval(function () {
      if (!focusId || !focusUntil) return;
      if (Date.now() >= focusUntil) focusUntil = 0;
      render();
    }, 1000);
  }
  render();
}
function focusNow() {
  const date = todayStr(new Date());
  const plan = loadPlans()[date];
  if (!plan) return;
  const cb = currentBlock(plan.blocks.filter(function (b) { return !b.done; }), new Date());
  if (cb) openFocus(cb.block.id);
}

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
  const foc = renderFocus();
  if (foc) {
    root.appendChild(foc);
  } else {
    root.appendChild(renderTopbar());
    const tab = currentTab();
    if (tab === "goal") {
      root.appendChild(renderProgress());
      root.appendChild(renderGoalsPanel());
    } else if (tab === "flow") {
      root.appendChild(renderFortune());
      root.appendChild(renderFlow());
      root.appendChild(renderNatal());
    } else if (tab === "me") {
      root.appendChild(renderSettings());
      root.appendChild(renderFooter());
      root.appendChild(renderGuide());
    } else {
      const nb = renderNowbar();
      if (nb) root.appendChild(nb);
      root.appendChild(renderToday());
      const meals = renderMeals();
      if (meals) root.appendChild(meals);
      root.appendChild(renderPlanTools());
      root.appendChild(renderNote());
      root.appendChild(renderQuote());
    }
    root.appendChild(renderTabbar());
  }

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

// 실행 모드 화면. 지금 블록 하나 + 첫 동작 + 남은 시간. 아무것도 평가하지 않는다.
// ISO 문자열은 UTC다. 화면에는 내 시각으로 보여준다.
function localHHMM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}
function renderFocus() {
  if (!focusId) return null;
  const now = new Date();
  const date = todayStr(now);
  const plan = loadPlans()[date];
  const b = plan && plan.blocks.find(function (x) { return x.id === focusId; });
  if (!b) { focusId = null; return null; }

  const box = el("section", { cls: "focus" });
  const head = el("div", { cls: "fhead" });
  head.appendChild(el("span", { cls: "ftime", text: b.time }));
  if (b.place) head.appendChild(el("span", { cls: "place", text: b.place }));
  const x = el("button", { cls: "mini fclose", text: "닫기" });
  x.addEventListener("click", function () { closeFocus(); });
  head.appendChild(x);
  const home = el("button", { cls: "mini", text: "오늘 계획" });
  home.addEventListener("click", function () { goTab("today"); });
  head.appendChild(home);
  box.appendChild(head);

  box.appendChild(el("h2", { cls: "fnow", text: b.text }));

  const fs = firstStep(b);
  if (fs) {
    const f = el("div", { cls: "ffirst" });
    f.appendChild(el("span", { cls: "flabel", text: "첫 동작" }));
    f.appendChild(el("span", { cls: "ftext", text: fs }));
    box.appendChild(f);
  }

  const st = blockStartMinutes(b.time), en = blockEndMinutes(b.time);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (st != null && en != null && en > st) {
    const pct = Math.max(0, Math.min(100, Math.round(((cur - st) / (en - st)) * 100)));
    const bar = el("div", { cls: "fbar" });
    const fill = el("div", { cls: "fbarfill" });
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    box.appendChild(bar);
    const elapsed = b.startedAt ? Math.max(0, Math.round((now.getTime() - new Date(b.startedAt).getTime()) / 60000)) : null;
    box.appendChild(el("div", { cls: "muted sessionline", text:
      (cur < st ? ((st - cur) + "분 뒤 시작") : (Math.max(0, en - cur) + "분 남음")) +
      (elapsed != null ? ("  ·  예상 " + (en - st) + "분 · 지금까지 " + elapsed + "분") : "") }));
  }

  const row = el("div", { cls: "addrow" });
  if (focusUntil && Date.now() < focusUntil) {
    const left = Math.max(0, Math.ceil((focusUntil - Date.now()) / 1000));
    row.appendChild(el("span", { cls: "ftimer", text: Math.floor(left / 60) + ":" + pad2(left % 60) }));
    const stop = el("button", { cls: "mini", text: "그만" });
    stop.addEventListener("click", function () { focusUntil = 0; render(); });
    row.appendChild(stop);
  } else {
    const five = el("button", { cls: "mini bd", text: "5분만 시작" });
    five.addEventListener("click", function () { setBlockStarted(date, b.id, new Date()); startFive(); });
    row.appendChild(five);
  }
  // 착수 창이 닫혔으면 기록 버튼은 잠긴다. 타이머는 그대로 돈다 — 잠긴 건 기록이지 실행이 아니다.
  const fwin = startWindow(b, date, now);
  const flocked = !b.started && !b.done && !fwin.open;
  if (!b.started) {
    const sb = el("button", { cls: "mini", text: "시작 기록" });
    if (flocked) { sb.disabled = true; sb.title = lockReason(fwin); }
    else sb.addEventListener("click", function () { setBlockStarted(date, b.id, new Date()); render(); });
    row.appendChild(sb);
  } else {
    row.appendChild(el("span", { cls: "muted", text: "시작 " + localHHMM(b.startedAt) + (b.onTime ? " · 정시" : "") }));
  }
  if (b.reviewId) {
    const item = loadReviews().filter(function (r) { return r.id === b.reviewId; })[0];
    if (item && item.q) {
      const qb = el("div", { cls: "recallq" });
      qb.appendChild(el("span", { cls: "flabel", text: "안 보고 답하기" }));
      qb.appendChild(el("span", { cls: "qtextline", text: item.q }));
      box.appendChild(qb);
    }
    if (item && item.missed) box.appendChild(el("div", { cls: "muted", text: "지난번 막힌 곳 · " + item.missed }));
    if (item && item.leech) box.appendChild(el("div", { cls: "muted", text: "여러 번 놓친 항목입니다. ✨ 로 더 잘게 쪼개보세요." }));
  }
  if (b.reviewId && !b.done) {
    // 인출 확인. 답을 본 뒤 스스로 판정한다 — 이게 상자를 움직이는 유일한 신호다.
    const rrow = el("div", { cls: "addrow recallrow" });
    const yes = el("button", { cls: "mini bd", text: "✓ 기억났다" });
    yes.title = "다음 차례가 멀어집니다";
    const no = el("button", { cls: "mini", text: "✗ 안 나왔다" });
    no.title = "내일 다시 나옵니다";
    if (flocked) { yes.disabled = true; no.disabled = true; yes.title = lockReason(fwin); }
    else {
      yes.addEventListener("click", function () { finishBlock(date, b, true); render(); });
      no.addEventListener("click", function () { finishBlock(date, b, false); render(); });
    }
    rrow.appendChild(yes);
    rrow.appendChild(no);
    box.appendChild(rrow);
  }
  if (!b.done) {
    const db = el("button", { cls: "mini", text: "완료" });
    if (flocked) { db.disabled = true; db.title = lockReason(fwin); }
    else db.addEventListener("click", function () { finishBlock(date, b); render(); });
    if (!b.reviewId) row.appendChild(db);
  } else {
    row.appendChild(el("span", { cls: "muted", text: "완료됨" }));
  }
  box.appendChild(row);
  if (flocked) box.appendChild(el("div", { cls: "locknote", text: lockReason(fwin) }));

  // 한 줄만 묻는다. 이게 복습 큐의 연료다. 비우고 넘어가는 게 기본.
  if (b.taskId || b.reviewId) {
    const ask = el("div", { cls: "askline" });
    const lab = el("label", { cls: "asklabel", text: askLabel(b.kind) });
    lab.htmlFor = "askField";
    const inp = el("input", { cls: "askinput" });
    inp.type = "text";
    inp.id = "askField";
    inp.placeholder = "없으면 비워두고 넘어가세요";
    inp.value = askDraft[b.id] || "";
    bindField(inp, "ask:" + b.id, function (v) { askDraft[b.id] = v; });
    ask.appendChild(lab);
    ask.appendChild(inp);
    box.appendChild(ask);
  }

  // 막혔을 때 — 답이 아니라 다음 한 걸음만 물어보는 프롬프트
  const stuck = el("div", { cls: "addrow" });
  stuck.appendChild(bridgeButton("막힘 — 다음 한 걸음만", "stuck", function () {
    const pf = loadProfile();
    const g = findGoal(pf, b.goalId);
    return {
      course: g ? g.title : "",
      kind: b.kind || "",
      text: String(b.text).replace(/^안 보고 (써보기|유도) — /, ""),
      note: (askDraft[b.id] || "").trim(),
      past: (loadStuck()[b.goalId] || []).slice(-3)
    };
  }));
  if (b.taskId) {
    const tiny = el("button", { cls: "mini", text: "✂ 첫 1개만" });
    tiny.title = "과제를 지금 할 수 있는 크기로 줄입니다";
    tiny.addEventListener("click", function () {
      const note = (askDraft[b.id] || "").trim();
      if (note) addStuck(b.goalId, note);
      applyEdit(date, function (bs) {
        return bs.map(function (x) {
          if (x.id !== b.id) return x;
          const o = {}; Object.keys(x).forEach(function (k) { o[k] = x[k]; });
          o.text = /^첫 1개만 · /.test(x.text) ? x.text : ("첫 1개만 · " + x.text);
          o.first = null;
          return o;
        });
      });
      render();
    });
    stuck.appendChild(tiny);
  }
  box.appendChild(stuck);
  if (bridgeMsg || promptText) box.appendChild(bridgeBox({}));

  const rest = plan.blocks.filter(function (x2) {
    return x2.id !== b.id && !x2.done && (blockStartMinutes(x2.time) || 0) >= (st || 0);
  });
  const nx = currentBlock(rest, now);
  if (nx) box.appendChild(el("div", { cls: "fnext", text: "끝나면 다음 · " + nx.block.time + " " + nx.block.text + (nx.block.place ? (" · " + nx.block.place) : "") }));
  return box;
}

// landing/hero: what this app does + energy picker + the main action
// 지금 뭐 할 차례. 줄 전체가 실행 모드 진입 버튼이다.
function renderNowbar() {
  const now = new Date();
  if (activeDate(now) !== todayStr(now)) return null;
  const plan = loadPlans()[todayStr(now)];
  if (!plan) return null;
  const cb = currentBlock(plan.blocks.filter(function (x) { return !x.done; }), now);
  if (!cb) return null;
  const bar = el("button", { cls: "nowbar" + (cb.state === "now" ? " active" : "") });
  bar.appendChild(el("span", { cls: "nlabel", text: cb.state === "now" ? "지금" : "다음" }));
  bar.appendChild(el("span", { cls: "ntext", text: cb.block.text }));
  bar.appendChild(el("span", { cls: "ntime", text: cb.block.time }));
  bar.appendChild(el("span", { cls: "ngo", text: "▶ 실행" }));
  bar.addEventListener("click", function () { openFocus(cb.block.id); });
  return bar;
}

// 계획을 만드는 도구 — 배터리 · 특별 일정 · 생성 버튼. 계획 아래에 둔다(계획이 먼저 보여야 한다).
function renderPlanTools() {
  const now = new Date();
  const target = activeDate(now);
  const isTomorrow = target !== todayStr(now);
  const plan = loadPlans()[target];
  const box = el("section", { cls: "tools" });
  box.id = "tools";
  box.appendChild(el("h2", { text: plan ? "다시 짜기" : (isTomorrow ? "내일 계획 만들기" : "오늘 계획 만들기") }));
  box.appendChild(el("p", { cls: "what", text: "배터리와 특별 일정을 반영해 AI가 시간표를 짭니다. 블록마다 장소와 첫 동작까지 붙습니다." }));

  const eWrap = el("div", { cls: "energy" });
  eWrap.appendChild(el("span", { cls: "elabel", text: "오늘 배터리" }));
  const cur = getEnergy(target);
  ENERGY_LEVELS.forEach(function (lv) {
    const c = el("button", { cls: "echip" + (cur === lv.key ? " on" : ""), text: lv.label });
    c.title = lv.hint;
    c.setAttribute("aria-label", "오늘 배터리 " + lv.label + " — " + lv.hint);
    c.setAttribute("aria-pressed", cur === lv.key ? "true" : "false");
    c.addEventListener("click", function () { setEnergy(target, lv.key); render(); });
    eWrap.appendChild(c);
  });
  box.appendChild(eWrap);

  const evWrap = el("div", { cls: "evt" });
  const evLab = el("label", { cls: "evtlabel", text: (isTomorrow ? "내일" : "오늘") + " 특별한 일정 (선택)" });
  evLab.setAttribute("for", "evtField");
  const evTa = el("textarea", { cls: "evtinput" });
  evTa.id = "evtField";
  evTa.rows = 2;
  evTa.placeholder = "예: 14:00 병원, 19시-21시 알바, 과제 마감";
  evTa.value = getEvent(target);
  bindField(evTa, "evt:" + target, function (v) { setEvent(target, v); });
  evWrap.appendChild(evLab);
  evWrap.appendChild(evTa);
  evWrap.appendChild(el("p", { cls: "evthint", text: "적어두고 아래 버튼을 누르면 그 시각을 비워두고 나머지를 짭니다." }));
  box.appendChild(evWrap);

  box.appendChild(genButton(target, plan ? "계획 다시 생성" : (isTomorrow ? "내일 계획 생성" : "오늘 계획 생성")));
  return box;
}

// 이 앱이 뭘 할 수 있는지 — 이름만 보고 바로 누를 수 있게
function renderGuide() {
  const now = new Date();
  const box = el("section", { cls: "guidebox" });
  const guide = el("div", { cls: "guide" });
  guide.appendChild(el("div", { cls: "glabel", text: "할 수 있는 것" }));
  const todayHas = !!loadPlans()[todayStr(now)];
  const mealsOn = mealsAvailable();
  [
    { icon: "▶", name: "실행 모드", what: "지금 할 것 하나만 크게. 첫 동작과 남은 시간이 같이 나옵니다",
      off: !todayHas, offwhy: "오늘 탭에서 계획을 먼저 만드세요", go: function () { goTab("today"); focusNow(); } },
    { icon: "🧩", name: "목표 쪼개기", what: "큰 목표를 AI가 60분짜리 과제로 나눠줍니다",
      go: function () { goTab("goal"); } },
    { icon: "🍚", name: "식단 · 장보기", what: mealsOn ? "냉장고 재료로 오늘 세 끼와 장볼 것을 뽑습니다" : "아래 “식단 · 몸”에 재료를 적으면 세 끼와 장보기 목록이 나옵니다",
      go: function () { if (mealsOn) { goTab("today"); scrollTo("meals"); } else scrollTo("food"); } },
    { icon: "🀄", name: "사주 · 운세", what: "오늘의 결, 이번 달·올해 구간, 내 원국 네 기둥",
      go: function () { goTab("flow"); } },
    { icon: "⬇", name: "백업", what: "계획·기록을 파일로 빼둡니다. 브라우저는 데이터를 지울 수 있습니다",
      go: function () { downloadBackup(); } }
  ].forEach(function (it) {
    const btn = el("button", { cls: "grow" + (it.off ? " goff" : "") });
    btn.appendChild(el("span", { cls: "gicon", text: it.icon }));
    btn.appendChild(el("span", { cls: "gname", text: it.name }));
    btn.appendChild(el("span", { cls: "gwhat", text: it.off ? it.offwhy : it.what }));
    btn.disabled = !!it.off;
    btn.addEventListener("click", function () { if (!it.off) it.go(); });
    guide.appendChild(btn);
  });
  box.appendChild(guide);
  return box;
}

function renderQuote() {
  const q = quoteFor(todayStr(new Date()));
  const qbox = el("blockquote", { cls: "quote" });
  qbox.appendChild(el("span", { cls: "qtext", text: q.t }));
  if (q.a) qbox.appendChild(el("span", { cls: "qauth", text: "— " + q.a }));
  return qbox;
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
  box.setAttribute("aria-label", "오늘 한 줄");
  box.id = "note";
  box.appendChild(el("h2", { text: "오늘 한 줄" }));
  box.appendChild(el("p", { cls: "what", text: "오늘 어땠는지 한 줄. 다음 계획을 짤 때 AI가 이걸 읽고 조정합니다." }));

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
  box.setAttribute("aria-label", "기록");
  const today = todayStr();

  // 쌓인 기록을 Gemini에게 읽힌다. 하루치는 의미 없지만 쌓이면 본인도 못 보는 게 나온다.
  const rec = pastRecord(today, 30);
  const pwrap = el("div", { cls: "pastread" });
  pwrap.appendChild(el("h2", { text: "📜 지난 나" }));
  if (rec.span < PAST_MIN_DAYS) {
    pwrap.appendChild(el("p", { cls: "muted",
      text: "기록이 " + rec.span + "일치 모였습니다. " + PAST_MIN_DAYS + "일이 넘으면 여기서 패턴을 찾아볼 수 있어요. 오늘 한 줄과 배터리가 재료입니다." }));
  } else {
    pwrap.appendChild(el("p", { cls: "muted",
      text: "최근 30일 중 " + rec.span + "일치 기록 · 끝낸 과제 " + rec.done.length + "개 · 막힌 지점 " + rec.stuck.length + "개를 모아 프롬프트로 만듭니다." }));
    const prow = el("div", { cls: "addrow" });
    prow.appendChild(bridgeButton("내 기록에서 패턴 찾기", "past", function () {
      return { rec: pastRecord(todayStr(), 30), traits: (loadProfile().traits || "").trim() };
    }));
    pwrap.appendChild(prow);
  }
  box.appendChild(pwrap);
  if (bridgeMsg || promptText) box.appendChild(bridgeBox({}));

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
// 식단 카드가 뜰 조건 — 기능 버튼이 죽은 버튼이 되지 않게 미리 안다
function mealsAvailable() {
  const now = new Date();
  const plan = loadPlans()[activeDate(now)];
  const profile = loadProfile();
  return !!((plan && (plan.meals || plan.shopping)) || bodyStats(profile, now) || (profile.fridge || "").trim());
}
function renderMeals() {
  const now = new Date();
  const target = activeDate(now);
  const plan = loadPlans()[target];
  const m = plan && plan.meals;
  const shopping = plan && plan.shopping;
  const profile = loadProfile();
  const b = bodyStats(profile, now);
  const hasFridge = !!(profile.fridge || "").trim();
  if (!m && !shopping && !b && !hasFridge) return null;

  const box = el("section", { cls: "meals" });
  box.setAttribute("aria-label", "식단");
  box.id = "meals";
  box.appendChild(el("h2", { text: "식단" }));
  box.appendChild(el("p", { cls: "what", text: "설정에 적어둔 냉장고 재료·몸 상태로 AI가 뽑은 오늘 세 끼와 장볼 것." }));

  if (m) {
    [["아침", m.breakfast], ["점심", m.lunch], ["저녁", m.dinner]].forEach(function (pair) {
      if (!pair[1]) return;
      const row = el("div", { cls: "meal" });
      row.appendChild(el("span", { cls: "mlabel", text: pair[0] }));
      row.appendChild(el("span", { cls: "mtext", text: pair[1] }));
      box.appendChild(row);
    });
  } else {
    box.appendChild(el("p", { cls: "muted", text: "계획을 생성하면 지금 있는 재료로 식단이 짜입니다." }));
  }

  // 몸 참고치 — 건조한 사실만
  if (b) {
    box.appendChild(el("p", { cls: "muted bodyline", text: "키 " + b.heightCm + " · " + b.weightKg + "kg · BMI " + b.bmi + " · 하루 " + b.tdee + "kcal 추정" }));
  }

  // 장보기: 지금 재료로 부족한 것
  if (shopping && shopping.length) {
    const sw = el("div", { cls: "shop" });
    sw.appendChild(el("div", { cls: "llabel", text: "사두면 좋은 것" }));
    const ul = el("ul", { cls: "shoplist" });
    shopping.forEach(function (it) { ul.appendChild(el("li", { text: it })); });
    sw.appendChild(ul);
    box.appendChild(sw);
  } else if (!hasFridge) {
    box.appendChild(el("p", { cls: "muted", text: "설정에 냉장고 재료를 적으면, 그걸로 짜고 부족한 것만 알려줍니다." }));
  }
  return box;
}

function renderProgress() {
  const box = el("section", { cls: "prog" });
  box.id = "prog";
  box.setAttribute("aria-label", "목표 진행도");
  box.appendChild(el("h2", { text: "진행도" }));
  box.appendChild(el("p", { cls: "what", text: "목표마다 과제가 몇 개 남았는지. 계획의 학습 블록을 체크하면 여기가 찹니다." }));
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

// 고치기 모드 — 켜기 전에는 없는 것과 같다.
let editing = false;
let dragId = null;      // 끄는 중인 블록 (PC 기본 드래그)
let swapFor = null;     // 교체 서랍이 열린 블록
function setEditing(v) {
  editing = !!v;
  if (!editing) { swapFor = null; dragId = null; }
  render();
}

function renderToday() {
  const box = el("section", { cls: "today" });
  box.setAttribute("aria-label", "오늘 계획");
  const now = new Date();
  const target = activeDate(now);
  const isTomorrow = target !== todayStr(now);
  const plan = loadPlans()[target];

  const head = el("div", { cls: "todayhead" });
  box.id = "today";
  head.appendChild(el("h2", { text: (isTomorrow ? "내일 계획" : "오늘 계획") + " · " + dateWithWeekday(target) }));
  if (plan) {
    const cs = coreStatus(plan.blocks);
    head.appendChild(el("span", {
      cls: "core" + (cs.done >= cs.total && cs.total ? " done" : ""),
      text: "착수 " + cs.done + "/" + cs.total + (cs.late ? (" · 늦음 " + cs.late) : "") + (cs.fin ? (" · 완료 " + cs.fin) : "")
    }));
  }
  if (plan && !generating) {
    const ed = el("button", { cls: "mini edit" + (editing ? " on" : ""), text: editing ? "완료" : "✎ 고치기" });
    ed.addEventListener("click", function () { setEditing(!editing); });
    head.appendChild(ed);
  }
  box.appendChild(head);
  box.appendChild(el("p", { cls: "what", text: editing
    ? "≡ 를 끌어서 자리를 바꾸거나 ↑↓ 로 한 칸씩. ⇄ 는 다른 과제로 교체, ✕ 는 빼기. 시각은 그대로 두고 내용만 옮깁니다."
    : "블록이 시작될 때 “시작”(±5분이면 정시), 다 끝내면 체크. 핵심(●) 3개가 그날의 기준입니다." }));

  if (generating) {
    const load = el("p", { cls: "muted", text: "AI가 계획 짜는 중…" });
    load.setAttribute("role", "status");
    box.appendChild(load);
    return box;
  }

  if (!plan) {
    box.appendChild(el("p", { cls: "muted", text: "아직 계획이 없어요. 위의 “계획 생성”을 누르면 AI가 짜줍니다." }));
    return box;
  }

  const nowTick = new Date();
  const blocksWrap = el("div", { cls: "blocks" });

  // 제 몫을 하는 블록 한 행
  function editBtn(sym, label, fn) {
    const b = el("button", { cls: "rowbtn", text: sym });
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();   // 행이 label 이라 클릭이 체크박스로 샌다
      fn();
    });
    return b;
  }

  function fullRow(bk) {
    const open = !bk.done && isOnTime(bk, target, nowTick);
    const movable = editing && !bk.event && !bk.done;
    const row = el("label", { cls: "block" + (bk.core ? " isCore" : "") + (bk.event ? " isEvent" : "") + (bk.done ? " off" : "") + (open ? " open" : "") + (editing ? " editing" : "") + (dragId === bk.id ? " dragging" : "") });
    if (movable) {
      row.draggable = true;
      row.addEventListener("dragstart", function (e) {
        dragId = bk.id;
        try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", bk.id); } catch (x) {}
      });
      row.addEventListener("dragover", function (e) {
        if (!dragId || dragId === bk.id) return;
        if (e && e.preventDefault) e.preventDefault();
        row.className = row.className.indexOf("dropinto") < 0 ? (row.className + " dropinto") : row.className;
      });
      row.addEventListener("dragleave", function () {
        row.className = row.className.replace(" dropinto", "");
      });
      row.addEventListener("drop", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        const from = dragId;
        dragId = null;
        if (!from || from === bk.id) { render(); return; }
        applyEdit(target, function (bs) { return swapSlots(bs, from, bk.id); });
        render();
      });
      row.addEventListener("dragend", function () { dragId = null; render(); });
      const h = el("span", { cls: "handle", text: "≡" });
      h.setAttribute("aria-hidden", "true");
      row.appendChild(h);
    }
    // 착수 창이 닫혔으면 체크 자체가 안 된다. 이미 착수·완료한 행은 그대로 둔다.
    const win = startWindow(bk, target, new Date());
    const locked = !bk.started && !bk.done && !win.open;
    if (locked) row.className += " islocked";
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!bk.done;
    if (locked) { cb.disabled = true; cb.title = lockReason(win); }
    cb.addEventListener("change", function () { setBlockDone(target, bk.id, cb.checked, new Date()); render(); });
    row.appendChild(cb);
    row.appendChild(el("span", { cls: "time", text: bk.time }));
    if (bk.core) { const dotm = el("span", { cls: "coremark", text: "●" }); dotm.setAttribute("aria-hidden", "true"); row.appendChild(dotm); }
    row.appendChild(el("span", { cls: "txt", text: bk.text }));
    if (bk.kind) row.appendChild(el("span", { cls: "kindchip k" + KINDS.indexOf(bk.kind), text: bk.kind }));
    if (bk.place) row.appendChild(el("span", { cls: "place", text: bk.place }));
    if (bk.event) row.appendChild(el("span", { cls: "badge evtb", text: "일정" }));
    if (editing) {
      if (movable) {
        const btns = el("span", { cls: "rowbtns" });
        btns.appendChild(editBtn("↑", "한 칸 위로", function () {
          applyEdit(target, function (bs) { return shiftBlock(bs, bk.id, -1); }); render();
        }));
        btns.appendChild(editBtn("↓", "한 칸 아래로", function () {
          applyEdit(target, function (bs) { return shiftBlock(bs, bk.id, 1); }); render();
        }));
        btns.appendChild(editBtn("⇄", "다른 과제로 교체", function () {
          swapFor = (swapFor === bk.id) ? null : bk.id; render();
        }));
        btns.appendChild(editBtn("✕", "이 블록 빼기", function () {
          applyEdit(target, function (bs) { return dropBlock(bs, bk.id); }); render();
        }));
        row.appendChild(btns);
      } else {
        row.appendChild(el("span", { cls: "badge evtb", text: bk.done ? "완료" : "고정" }));
      }
      return row;
    }
    // 창이 열려 있으면 진행 중이 아니어도 시작 버튼을 보여준다(창은 시작 5분 전에 열린다)
    if (!bk.started && !bk.done && win.open && (open || win.state === "open")) {
      const sb = el("button", { cls: "mini startb", text: "시작" });
      sb.addEventListener("click", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        setBlockStarted(target, bk.id, new Date());
        openFocus(bk.id);
      });
      row.appendChild(sb);
    }
    if (bk.onTime) row.appendChild(el("span", { cls: "badge ontime", text: "착수" }));
    else if (bk.started || bk.done) row.appendChild(el("span", { cls: "badge late", text: "늦음" }));
    else if (locked && win.state === "missed") row.appendChild(el("span", { cls: "badge locked", text: "놓침" }));
    else if (open) row.appendChild(el("span", { cls: "badge now", text: "지금" }));
    if (bk.done) row.appendChild(el("span", { cls: "badge fin", text: "완료" }));
    return row;
  }

  // 교체 서랍 — ⇄ 를 눌렀을 때 그 행 아래에만 열린다. AI를 부르지 않는다.
  function swapDrawer() {
    const wrap = el("div", { cls: "swapdrawer" });
    wrap.appendChild(el("div", { cls: "sdlabel", text: "이 자리에 대신 넣을 것" }));
    const cands = swapCandidates(loadProfile(), plan.blocks, 4);
    if (!cands.length) {
      wrap.appendChild(el("div", { cls: "muted", text: "남은 과제가 없습니다. 목표 탭에서 과제를 추가하세요." }));
      return wrap;
    }
    cands.forEach(function (c) {
      const b = el("button", { cls: "sdrow" });
      b.appendChild(el("span", { cls: "sdtext", text: c.text }));
      b.appendChild(el("span", { cls: "sdgoal", text: c.goalTitle }));
      b.addEventListener("click", function (e) {
        if (e && e.preventDefault) e.preventDefault();
        const id = swapFor;
        swapFor = null;
        applyEdit(target, function (bs) { return swapTask(bs, id, c); });
        render();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // 10분 휴식·이동 — 체크할 것이 없으므로 얇은 실선 한 줄로 둔다
  function microRow(bk) {
    const st = blockStartMinutes(bk.time), en = blockEndMinutes(bk.time);
    const len = (st != null && en != null) ? (en - st) : null;
    const row = el("div", { cls: "microrow" + (bk.move ? " isMove" : "") });
    row.appendChild(el("span", { cls: "mtime", text: minToClock(st == null ? 0 : st) }));
    row.appendChild(el("span", { cls: "mtxt", text: bk.text }));
    if (len != null) row.appendChild(el("span", { cls: "mlen", text: len + "분" }));
    return row;
  }

  function rowFor(bk) {
    const row = isMicroBlock(bk) ? microRow(bk) : fullRow(bk);
    if (editing && swapFor === bk.id) {
      const holder = el("div", { cls: "rowholder" });
      holder.appendChild(row);
      holder.appendChild(swapDrawer());
      return holder;
    }
    return row;
  }

  function group(key, label, list, forceOpen) {
    const d = markOpen(el("details", { cls: "daygroup" }), key + ":" + target);
    if (forceOpen) d.open = true;
    d.appendChild(el("summary", { text: label }));
    list.forEach(function (bk) { d.appendChild(rowFor(bk)); });
    return d;
  }

  const nowMin = nowTick.getHours() * 60 + nowTick.getMinutes();
  const parts = splitDay(plan.blocks, nowMin, !isTomorrow, 3);

  if (parts.past.length) {
    const pc = coreStatus(parts.past);
    blocksWrap.appendChild(group("past", "지난 " + parts.past.length + "개" +
      (pc.total ? (" · 착수 " + pc.done + "/" + pc.total + (pc.late ? (" · 늦음 " + pc.late) : "")) : ""), parts.past));
  }
  parts.live.forEach(function (bk) { blocksWrap.appendChild(rowFor(bk)); });
  if (parts.later.length) {
    const lc = coreStatus(parts.later);
    blocksWrap.appendChild(group("later", "이따 " + parts.later.length + "개" +
      (spanText(parts.later) ? (" (" + spanText(parts.later) + ")") : "") +
      (lc.total ? (" · 핵심 " + lc.total) : ""), parts.later, editing));
  }
  box.appendChild(blocksWrap);
  // 적어둔 특별 일정이 지금 계획에 안 들어가 있으면 사실만 알린다
  const evMiss = parseEvents(getEvent(target)).filter(function (ev) {
    return !plan.blocks.some(function (b) { return b.text.indexOf(ev.text) >= 0; });
  });
  if (evMiss.length) {
    box.appendChild(el("p", { cls: "muted", text: "적어둔 특별 일정이 이 계획에 없습니다: " + evMiss.map(function (e) { return e.text; }).join(", ") + " · 다시 생성하면 반영됩니다." }));
  }
  if (plan.source === "template") {
    if (hasAI()) {
      const quota = isQuotaError(lastAIError);
      const errp = el("p", { cls: "err", text: quota
        ? "오늘 무료 API 한도를 다 썼습니다. 기본 템플릿으로 짰습니다."
        : ("AI 실패 → 기본 템플릿. 이유: " + (lastAIError || "알 수 없음")) });
      errp.setAttribute("role", "alert");
      box.appendChild(errp);
      box.appendChild(el("p", { cls: "muted", text: quota
        ? "목표 탭의 ✨ 프롬프트를 Gemini 앱에 붙여넣으면 한도와 상관없이 됩니다."
        : "설정에서 Gemini 키를 넣으면 가장 안정적이에요. 또는 다시 생성." }));
    } else {
      box.appendChild(el("p", { cls: "muted", text: "AI 없이 기본 템플릿입니다. 설정에서 AI를 켜면 맞춤 계획이 됩니다." }));
    }
  }
  const brow = el("div", { cls: "addrow" });
  const drill = plan.blocks.filter(function (b) { return b.reviewId || (b.taskId && (b.kind === "개념" || b.kind === "유도")); });
  if (drill.length) {
    brow.appendChild(bridgeButton("오늘 인출 문제", "retrieval", function () {
      const pf = loadProfile();
      const revs = loadReviews();
      return {
        items: drill.map(function (b) {
          const g = findGoal(pf, b.goalId);
          const r = b.reviewId ? revs.filter(function (x) { return x.id === b.reviewId; })[0] : null;
          return {
            course: g ? g.title : "",
            kind: b.kind,
            text: String(b.text).replace(/^(복습 — |안 보고 (써보기|유도) — )/, ""),
            missed: (r && r.missed) || "",
            leech: !!(r && r.leech)
          };
        })
      };
    }));
  }
  if (target === todayStr(new Date())) {
    const fb = el("button", { cls: "mini bd", text: "▶ 실행 모드" });
    fb.addEventListener("click", function () { focusNow(); });
    brow.appendChild(fb);
    const rp = el("button", { cls: "mini", text: "⏱ 지금부터 다시 짜기" });
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
  if (drill.length) box.appendChild(bridgeBox({ questions: true }));
  else if (bridgeMsg || promptText) box.appendChild(bridgeBox({}));
  box.appendChild(genButton(target, "다시 생성"));
  return box;
}

// "Gemini로 보내기" 버튼 하나 + 복사가 막혔을 때의 원문 상자
function bridgeButton(label, kind, ctxFn) {
  const b = el("button", { cls: "mini bd", text: "✨ " + label });
  b.title = "앱이 아는 것을 넣어 프롬프트를 만들고 복사합니다. Gemini 앱에 붙여넣으세요.";
  b.addEventListener("click", function (e) {
    if (e && e.preventDefault) e.preventDefault();
    copyPrompt(buildPrompt(kind, ctxFn()));
  });
  return b;
}
// 복사 결과·원문·붙여넣기 칸. 화면마다 같은 모양으로 붙는다.
function bridgeBox(opts) {
  const o = opts || {};
  const box = el("div", { cls: "bridge" });
  if (bridgeMsg) box.appendChild(el("div", { cls: "bridgemsg", text: bridgeMsg }));
  if (promptText) {
    box.appendChild(el("div", { cls: "muted", text: "자동 복사가 막혔습니다. 아래 전체를 선택해 복사하세요." }));
    const ta = el("textarea", { cls: "promptbox" });
    ta.rows = 8;
    ta.value = promptText;
    box.appendChild(ta);
    const close = el("button", { cls: "mini", text: "닫기" });
    close.addEventListener("click", function () { promptText = ""; render(); });
    box.appendChild(close);
  }
  // Gemini가 만든 인출 문제를 오늘 복습에 붙인다
  if (o.questions) {
    if (!pasteOpen) {
      const open = el("button", { cls: "mini", text: "📋 만들어진 문제를 여기 붙여넣기" });
      open.addEventListener("click", function () { pasteOpen = true; render(); });
      box.appendChild(open);
    } else {
      const ta = el("textarea", { cls: "promptbox" });
      ta.rows = 6;
      ta.placeholder = "1. 3NF의 조건을 쓰고 2NF와 뭐가 다른지…";
      box.appendChild(ta);
      const row = el("div", { cls: "addrow" });
      const take = el("button", { cls: "mini bd", text: "오늘 복습에 붙이기" });
      take.addEventListener("click", function () {
        const n = attachQuestions(todayStr(new Date()), ta.value);
        bridgeMsg = n ? ("문제 " + n + "개를 오늘 복습에 붙였습니다.") : "읽을 수 있는 문제가 없습니다. 번호 목록인지 보세요.";
        if (n) pasteOpen = false;
        render();
      });
      const cancel = el("button", { cls: "mini", text: "취소" });
      cancel.addEventListener("click", function () { pasteOpen = false; bridgeMsg = ""; render(); });
      row.appendChild(take); row.appendChild(cancel);
      box.appendChild(row);
    }
  }
  if (o.paste) {
    if (!pasteOpen) {
      const open = el("button", { cls: "mini", text: "📋 Gemini 답을 여기 붙여넣기" });
      open.addEventListener("click", function () { pasteOpen = true; render(); });
      box.appendChild(open);
    } else {
      const ta = el("textarea", { cls: "promptbox" });
      ta.rows = 6;
      ta.placeholder = "## 데이터베이스\n1. 3장 연습문제 1~10번 풀기\n2. …";
      box.appendChild(ta);
      const row = el("div", { cls: "addrow" });
      const take = el("button", { cls: "mini bd", text: "가져오기" });
      take.addEventListener("click", function () {
        const n = importCourseTasks(ta.value);
        bridgeMsg = n ? ("과제 " + n + "개를 넣었습니다.") : "읽을 수 있는 목록이 없습니다. “## 과목” 아래 번호 목록 형식인지 보세요.";
        if (n) pasteOpen = false;
        render();
      });
      const cancel = el("button", { cls: "mini", text: "취소" });
      cancel.addEventListener("click", function () { pasteOpen = false; bridgeMsg = ""; render(); });
      row.appendChild(take); row.appendChild(cancel);
      box.appendChild(row);
    }
  }
  return box;
}

// "2026-10-20" 또는 "10/20" 에서 남은 날. 못 읽으면 null (순수)
function daysUntil(deadline, today) {
  const t = String(deadline || "").trim();
  if (!t) return null;
  const p = String(today).split("-").map(Number);
  let y, mo, d;
  let m = t.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = t.match(/(\d{1,2})[-./월]\s*(\d{1,2})/);
    if (!m) return null;
    mo = +m[1]; d = +m[2]; y = p[0];
    if (mo < p[1] - 6) y += 1;                 // 해를 넘긴 마감
  }
  const a = new Date(p[0], p[1] - 1, p[2]), b = new Date(y, mo - 1, d);
  const diff = Math.round((b - a) / 86400000);
  return isNaN(diff) ? null : diff;
}

// 목표 · 과제 — 자기 페이지를 갖는다
function renderGoalsPanel() {
  const profile = loadProfile();
  const box = el("section", { cls: "goals" });
  box.id = "goals";
  box.appendChild(el("h2", { text: "목표 · 과제" }));
  box.appendChild(el("p", { cls: "what", text: "과목을 적고 ✨ 버튼으로 프롬프트를 복사해 Gemini에 붙여넣으세요. 돌아온 목록을 다시 붙여넣으면 과제가 됩니다. 그 과제가 계획의 학습 블록이 됩니다." }));

  // 학기 초 한 번. 다섯 개를 손으로 치게 두지 않는다.
  const names = parseCourses(loadProfile().courses);
  const missing = names.filter(function (n) {
    return !loadProfile().goals.some(function (g) { return g.title === n; });
  });
  if (missing.length) {
    const seedRow = el("div", { cls: "addrow" });
    const sb = el("button", { cls: "mini bd", text: "＋ 과목 " + missing.length + "개를 목표로 만들기" });
    sb.title = missing.join(" / ");
    sb.addEventListener("click", function () {
      const pf = loadProfile();
      missing.forEach(function (n) {
        pf.goals.push({ id: genId("g"), title: n, note: "", deadline: "", scope: "", tasks: [], analyzedAt: null });
      });
      saveProfile(pf);
      bridgeMsg = "과목 " + missing.length + "개를 만들었습니다. 이제 ✨ 로 과제를 쪼개세요.";
      render();
    });
    seedRow.appendChild(sb);
    box.appendChild(seedRow);
  }

  const grow2 = el("div", { cls: "addrow" });
  grow2.appendChild(bridgeButton("과제 쪼개기 프롬프트", "breakdown", function () {
    const pf = loadProfile();
    return {
      traits: (pf.traits || "").trim(),
      goals: pf.goals.map(function (g) {
        return { title: g.title, scope: g.scope || "", deadline: g.deadline || "", note: g.note || "" };
      })
    };
  }));
  grow2.appendChild(bridgeButton("진도 점검 프롬프트", "pace", function () {
    const pf = loadProfile();
    const today = todayStr(new Date());
    return {
      today: today,
      goals: pf.goals.map(function (g) {
        const pr = goalProgress(g);
        return {
          title: g.title, scope: g.scope || "", deadline: g.deadline || "",
          daysLeft: daysUntil(g.deadline, today), done: pr.done, total: pr.total
        };
      })
    };
  }));
  box.appendChild(grow2);
  box.appendChild(bridgeBox({ paste: true }));
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
    const sc = el("input", { cls: "dl" }); sc.type = "text"; sc.placeholder = "범위(선택)"; sc.value = g.scope || "";
    sc.setAttribute("aria-label", g.title + " 시험 범위");
    bindField(sc, "sc-" + g.id, function (v) {
      const p2 = loadProfile(); const gg = findGoal(p2, g.id);
      if (gg) { gg.scope = v; saveProfile(p2); }
    });
    top.appendChild(sc);
    const pace = paceLine(g, todayStr(new Date()));
    if (pace) gv.appendChild(el("div", { cls: "paceline", text: pace }));
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
    const ti = el("input"); ti.type = "text"; ti.placeholder = "과제 추가"; ti.setAttribute("aria-label", g.title + " 새 과제");
    const ta = el("button", { cls: "mini", text: "+" });
    ta.setAttribute("aria-label", g.title + " 과제 추가");
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
        const bl = el("span", { cls: "muted", text: "AI가 과제로 쪼개는 중…" });
        bl.setAttribute("role", "status");
        gv.appendChild(bl);
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
  const gi = el("input"); gi.type = "text"; gi.placeholder = "목표 추가 (예: 데이터베이스 따라가기)"; gi.setAttribute("aria-label", "새 목표");
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
  return box;
}

function renderSettings() {
  const box = el("section", { cls: "settings" });
  box.id = "settings";
  box.appendChild(el("h2", { text: "설정" }));
  box.appendChild(el("p", { cls: "what", text: "채울수록 계획이 정확해집니다. 전부 선택이고, 이 기기 안에만 저장됩니다." }));

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

  // ---- 식단·몸 ----
  const food = el("div", { cls: "infowrap" });
  food.id = "food";
  food.appendChild(el("div", { cls: "infohd", text: "식단 · 몸 (채우면 식단이 내 재료와 몸에 맞춰집니다)" }));

  const brow = el("div", { cls: "addrow bodyrow" });
  BODY_FIELDS.forEach(function (fld) {
    const w = el("div", { cls: "bodyfield" });
    const lab = el("label", { cls: "flabel", text: fld.label });
    lab.htmlFor = "f-" + fld.key;
    w.appendChild(lab);
    const inp = el("input", { cls: "dl bodyinput" });
    inp.type = "number"; inp.id = "f-" + fld.key; inp.placeholder = fld.ph;
    inp.value = profile[fld.key] || "";
    bindField(inp, "f-" + fld.key, function (v) {
      const p = loadProfile(); p[fld.key] = v; saveProfile(p);
      render(); // BMI·열량 추정치를 바로 갱신 (포커스·커서는 render가 보존)
    });
    w.appendChild(inp);
    brow.appendChild(w);
  });
  food.appendChild(brow);
  const bs = bodyStats(profile, new Date());
  if (bs) food.appendChild(el("div", { cls: "muted", text: "BMI " + bs.bmi + " · 하루 필요 열량 추정 " + bs.tdee + "kcal (참고치)" }));

  MEAL_FIELDS.forEach(function (fld) {
    const wrap = el("div", { cls: "field" });
    const lab = el("label", { cls: "flabel", text: fld.label });
    lab.htmlFor = "f-" + fld.key;
    wrap.appendChild(lab);
    const node = fld.area ? el("textarea", { cls: "finput" }) : el("input", { cls: "finput oneline" });
    if (!fld.area) node.type = "text";
    node.id = "f-" + fld.key;
    node.placeholder = fld.ph;
    node.value = profile[fld.key] || "";
    bindField(node, "f-" + fld.key, function (v) {
      const p = loadProfile(); p[fld.key] = v; saveProfile(p);
    });
    wrap.appendChild(node);
    food.appendChild(wrap);
  });
  box.appendChild(food);



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

  // ---- 데이터 (브라우저 저장소는 지워질 수 있다) ----
  box.appendChild(el("div", { cls: "aihd", text: "데이터" }));
  const lb = lastBackupAt();
  box.appendChild(el("div", { cls: "muted", text: lb
    ? ("마지막 백업 " + lb.slice(0, 10))
    : "아직 백업한 적이 없습니다. 사파리는 7일 안 들어오면 저장 데이터를 지우고, 기기 용량이 부족하면 통째로 지워집니다." }));
  const drow = el("div", { cls: "addrow" });
  const eb = el("button", { cls: "mini bd", text: "⬇ 백업 내보내기" });
  eb.addEventListener("click", function () { downloadBackup(); });
  drow.appendChild(eb);
  const fi = el("input");
  fi.type = "file";
  fi.setAttribute("accept", "application/json,.json");
  fi.setAttribute("aria-label", "백업 파일에서 되돌리기");
  fi.addEventListener("change", function () {
    const file = fi.files && fi.files[0];
    if (!file) return;
    const okAsk = (typeof window !== "undefined" && window.confirm)
      ? window.confirm("지금 저장된 계획·목표·기록을 백업 파일 내용으로 덮어씁니다. 진행할까요?") : true;
    if (okAsk) importBackup(file); else fi.value = "";
  });
  drow.appendChild(fi);
  box.appendChild(drow);
  if (dataMsg) box.appendChild(el("div", { cls: "muted", text: dataMsg }));
  box.appendChild(el("div", { cls: "muted", text: "API 키는 백업에 들어가지 않습니다." }));
  return box;
}

// 원국 카드 — 계산 결과를 그대로 보여준다. 해석은 한 줄뿐.
const NATAL_COLS = [{ k: "year", l: "년" }, { k: "month", l: "월" }, { k: "day", l: "일" }, { k: "hour", l: "시" }];
function renderNatal() {
  const n = natalChart();
  const box = el("section", { cls: "natal" });
  box.id = "natal";
  box.appendChild(el("h2", { text: "내 사주 원국" }));
  box.appendChild(el("p", { cls: "what", text: BIRTH_DATE + " " + BIRTH_HOUR + "시 출생으로 계산한 네 기둥. 이 앱의 색과 판정이 전부 여기서 나옵니다." }));
  const grid = el("div", { cls: "ngrid" });
  NATAL_COLS.forEach(function (c) {
    const gz = n[c.k];
    const col = el("div", { cls: "ncol" + (c.k === "day" ? " isday" : "") });
    col.appendChild(el("span", { cls: "nlab", text: c.l }));
    col.appendChild(el("span", { cls: "nstem", text: gz[0] }));
    col.appendChild(el("span", { cls: "nbranch", text: gz[1] }));
    col.appendChild(el("span", { cls: "nel", text: STEM_EL[gz[0]] + BRANCH_EL[gz[1]] }));
    grid.appendChild(col);
  });
  box.appendChild(grid);

  const bar = el("div", { cls: "nels" });
  ["목", "화", "토", "금", "수"].forEach(function (e) {
    const c = n.count[e];
    const chip = el("span", { cls: "elchip" + (e === "수" || e === "금" ? " use" : "") + (c === 0 ? " zero" : ""), text: e + " " + c });
    bar.appendChild(chip);
  });
  box.appendChild(bar);
  box.appendChild(el("p", { cls: "fact", text: "일간 " + n.dayMaster + "(" + STEM_EL[n.dayMaster] + ") · 화토 " + (n.count["화"] + n.count["토"]) + ", 금 " + n.count["금"] + ", 수 " + n.count["수"] + " — 그래서 용신이 水, 희신이 金입니다." }));
  box.appendChild(el("p", { cls: "muted", text: "월주는 절기 근사값이라 절입일 전후 하루는 다를 수 있습니다." }));
  return box;
}

// 오늘의 운세. 사주로 "무엇을 할 날인지"만 말하고, 나쁜 날이라고 하지 않는다.
function renderFortune() {
  const today = todayStr(new Date());
  const f = dayFortune(today);
  const box = el("section", { cls: "fortune" });
  box.id = "fortune";
  box.setAttribute("aria-label", "오늘의 운세");
  box.appendChild(el("h2", { text: "오늘의 운세" }));
  box.appendChild(el("p", { cls: "what", text: "사주(용신 水 · 희신 金)로 본 오늘 하루의 결. 오늘 뭘 하는 게 나은지만 말합니다." }));

  const top = el("div", { cls: "frow " + f.tone.key });
  top.appendChild(el("span", { cls: "fgz", text: f.gz }));
  top.appendChild(el("span", { cls: "fel", text: f.el }));
  top.appendChild(el("span", { cls: "ftone", text: f.tone.label }));
  box.appendChild(top);
  box.appendChild(el("p", { cls: "fact", text: f.act }));

  const hwrap = el("div", { cls: "fhours" });
  hwrap.appendChild(el("span", { cls: "llabel", text: "힘 실리는 시간" }));
  f.hours.forEach(function (h) {
    hwrap.appendChild(el("span", { cls: "hchip" + (h.on ? " on" : ""), text: h.label + " · " + h.el }));
  });
  box.appendChild(hwrap);
  box.appendChild(el("p", { cls: "muted", text: "오전 " + BIRTH_HOUR + "시(" + hourBranch(BIRTH_HOUR) + "시) 출생 — 원국에 화가 하나 더 있어서 용신 水의 비중이 그만큼 큽니다." }));
  box.appendChild(el("p", { cls: "muted", text: "일진은 달력 하루로 셉니다. 사주 원칙으로는 23시부터 다음 날입니다." }));
  return box;
}

// ---- 대운 타임라인 (긴 호흡의 앵커; 접어둠) ----
// ---- 세운(년운): 60갑자로 정확히 계산된다. 1984년 = 甲子 기준 ----
const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
// 각 글자의 오행 → 용신 水 · 희신 金 · 기신 火土 기준으로 그 해의 성격을 판정
const STEM_EL = { 甲: "목", 乙: "목", 丙: "화", 丁: "화", 戊: "토", 己: "토", 庚: "금", 辛: "금", 壬: "수", 癸: "수" };
const BRANCH_EL = { 子: "수", 丑: "토", 寅: "목", 卯: "목", 辰: "토", 巳: "화", 午: "화", 未: "토", 申: "금", 酉: "금", 戌: "토", 亥: "수" };

function yearPillar(year) {
  const i = ((year - 1984) % 60 + 60) % 60;
  return STEMS[i % 10] + BRANCHES[i % 12];
}

// 간지 한 쌍이 도움이 되는지(금·수) 버티는 구간인지(화·토) 판정 — 세운·월운 공용
function gzTone(gz) {
  const els = [STEM_EL[gz[0]], BRANCH_EL[gz[1]]];
  const good = els.filter(function (e) { return e === "금" || e === "수"; }).length;
  const bad = els.filter(function (e) { return e === "화" || e === "토"; }).length;
  if (good === 2) return { key: "good", label: "순풍", note: "희신·용신이 함께 드는 구간" };
  if (good === 1) return { key: "mixed", label: "전환", note: "도움이 되는 기운이 절반 들어옴" };
  if (bad === 2) return { key: "hold", label: "축적", note: "기신 구간 — 벌이지 말고 쌓을 때" };
  return { key: "mixed", label: "보통", note: "" };
}
function yearTone(year) { return gzTone(yearPillar(year)); }

// ---- 중간 흐름: 월운 (절기 기준 근사) ----
// 절입일은 해마다 하루쯤 움직인다. 여기서는 평년 근사값을 쓴다(1월~12월).
const TERM_DAY = [6, 4, 6, 5, 6, 6, 7, 8, 8, 8, 7, 7];
// 달력 날짜 -> 절기월 {y, m}. m=2면 인월(寅), m=1이면 축월(丑, 지난해에 속함)
function solarMonth(dateString) {
  const p = String(dateString).split("-").map(Number);
  let y = p[0], m = p[1];
  if (p[2] < TERM_DAY[m - 1]) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return { y: y, m: m };
}
// 월주(月柱). 월지는 절기월로, 월간은 오호둔(연간에서 유도).
function monthPillar(dateString) {
  const sm = solarMonth(dateString);
  const bi = sm.m % 12;                                  // 2월->寅(2), 12월->子(0), 1월->丑(1)
  const stemYear = sm.m === 1 ? sm.y - 1 : sm.y;         // 한 해는 인월(입춘)부터
  const ys = (((stemYear - 1984) % 60 + 60) % 60) % 10;  // 연간 index
  const base = ((ys % 5) * 2 + 2) % 10;                  // 오호둔: 甲己->丙寅 ...
  const si = (base + ((bi - 2 + 12) % 12)) % 10;
  return STEMS[si] + BRANCHES[bi];
}
// 이번 달부터 count개월의 흐름
function monthFlow(dateString, count) {
  const start = solarMonth(dateString);
  const out = [];
  for (let i = 0; i < (count || 3); i++) {
    let m = start.m + i, y = start.y;
    while (m > 12) { m -= 12; y += 1; }
    const probe = y + "-" + pad2(m) + "-" + pad2(TERM_DAY[m - 1] + 1);
    const gz = monthPillar(probe);
    out.push({ y: y, m: m, gz: gz, el: STEM_EL[gz[0]] + BRANCH_EL[gz[1]], tone: gzTone(gz) });
  }
  return out;
}

// ---- 일진(오늘의 간지) ----
// 율리우스 적일로 60갑자를 센다. 기준점 두 개로 검증됨: 1900-01-01 = 甲戌, 2000-01-01 = 戊午.
function julianDay(dateString) {
  const p = String(dateString).split("-").map(Number);
  const a = Math.floor((14 - p[1]) / 12);
  const y = p[0] + 4800 - a;
  const m = p[1] + 12 * a - 3;
  return p[2] + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}
function dayPillar(dateString) {
  const i = ((julianDay(dateString) + 49) % 60 + 60) % 60;
  return STEMS[i % 10] + BRANCHES[i % 12];
}

// 출생 시각 10시 → 巳시. 시지는 23시부터 두 시간씩 끊는다.
const BIRTH_HOUR = 10;
const HOUR_BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
function hourBranch(h) { return HOUR_BRANCHES[Math.floor((((h % 24) + 25) % 24) / 2)]; }

// 용신 水 · 희신 金에 해당하는 시간대 중 하루 계획(9~24시) 안에 드는 것
const GOOD_HOURS = [
  { label: "15–17시", el: "금", br: "申" },
  { label: "17–19시", el: "금", br: "酉" },
  { label: "21–23시", el: "수", br: "亥" }
];
// 그날 무엇을 하라는 말만 한다. 그 사람을 평가하지 않는다.
const DAY_ACT = {
  "순풍": "벌이기 좋은 구간입니다. 미뤄둔 것 중 제일 큰 걸 오늘 시작하세요.",
  "전환": "절반만 순풍입니다. 여러 개보다 하나를 끝까지 가는 쪽이 낫습니다.",
  "축적": "쌓는 날입니다. 새로 벌이지 말고 하던 것을 이어서 하세요.",
  "보통": "특별히 실리는 기운은 없습니다. 짜둔 계획대로 가면 됩니다."
};
// 시주: 일간에서 오자둔으로 시간을 뽑는다 (甲己일 -> 甲子시, 乙庚 -> 丙子 ...)
function hourPillar(dateString, hour) {
  const dp = dayPillar(dateString);
  const base = ((STEMS.indexOf(dp[0]) % 5) * 2) % 10;
  const bi = HOUR_BRANCHES.indexOf(hourBranch(hour));
  return STEMS[(base + bi) % 10] + HOUR_BRANCHES[bi];
}
// 원국 네 기둥과 오행 개수. 용신 水·희신 金이 왜 그렇게 정해졌는지가 여기서 그대로 보인다.
const BIRTH_DATE = "2002-07-05";
function natalChart() {
  const y = yearPillar(BIRTH_YEAR);
  const mo = monthPillar(BIRTH_DATE);
  const d = dayPillar(BIRTH_DATE);
  const h = hourPillar(BIRTH_DATE, BIRTH_HOUR);
  const count = { 목: 0, 화: 0, 토: 0, 금: 0, 수: 0 };
  [y, mo, d, h].forEach(function (gz) {
    count[STEM_EL[gz[0]]] += 1;
    count[BRANCH_EL[gz[1]]] += 1;
  });
  return { year: y, month: mo, day: d, hour: h, dayMaster: d[0], count: count };
}

function dayFortune(dateString) {
  const gz = dayPillar(dateString);
  const tone = gzTone(gz);
  const has = {};
  has[STEM_EL[gz[0]]] = true;
  has[BRANCH_EL[gz[1]]] = true;
  return {
    gz: gz,
    el: STEM_EL[gz[0]] + "·" + BRANCH_EL[gz[1]],
    tone: tone,
    act: DAY_ACT[tone.label] || DAY_ACT["보통"],
    hours: GOOD_HOURS.map(function (h) { return { label: h.label, el: h.el, on: !!has[h.el] }; })
  };
}

function yearFlow(fromYear, count) {
  const out = [];
  for (let i = 0; i < (count || 6); i++) {
    const y = fromYear + i;
    const gz = yearPillar(y);
    out.push({ year: y, gz: gz, el: STEM_EL[gz[0]] + BRANCH_EL[gz[1]], tone: yearTone(y) });
  }
  return out;
}

// ---- 짧은 흐름: 사주가 아니라 내 실제 기록 ----
// 최근 n일의 정시율·배터리·요일 경향·가장 오래 밀린 과제
function recentStats(today, days) {
  const n = days || 7;
  const plans = loadPlans(), energy = loadEnergy();
  let onTime = 0, coreTotal = 0, late = 0;
  const battery = { high: 0, mid: 0, low: 0 };
  const byWeekday = {};   // 요일별 { core, onTime }
  for (let i = 0; i < n; i++) {
    const d = addDays(today, -i);
    const p = plans[d];
    const e = energy[d];
    if (e && battery[e] != null) battery[e]++;
    if (!p) continue;
    const core = p.blocks.filter(function (b) { return b.core; });
    const ot = core.filter(function (b) { return b.onTime; }).length;
    coreTotal += core.length;
    onTime += ot;
    late += core.filter(function (b) { return (b.started || b.done) && !b.onTime; }).length;
    const w = weekdayOf(d);
    if (!byWeekday[w]) byWeekday[w] = { core: 0, onTime: 0 };
    byWeekday[w].core += core.length;
    byWeekday[w].onTime += ot;
  }
  // 가장 약한 요일 (핵심이 2개 이상 있었던 요일 중 정시율 최저)
  let worstDay = null;
  Object.keys(byWeekday).forEach(function (w) {
    const v = byWeekday[w];
    if (v.core < 2) return;
    const rate = v.onTime / v.core;
    if (!worstDay || rate < worstDay.rate) worstDay = { day: w, rate: rate, core: v.core, onTime: v.onTime };
  });
  return {
    days: n,
    onTime: onTime, late: late, coreTotal: coreTotal,
    pct: coreTotal ? Math.round((onTime / coreTotal) * 100) : null,
    battery: battery,
    worstDay: worstDay
  };
}

// 가장 오래 밀린 미완료 과제 (진행도가 멈춘 지점)
function stalledTask(profile) {
  const goals = (profile && profile.goals) || [];
  for (let i = 0; i < goals.length; i++) {
    const pending = (goals[i].tasks || []).filter(function (t) { return !t.done; });
    const done = (goals[i].tasks || []).filter(function (t) { return t.done; }).length;
    if (pending.length && done > 0) return { text: pending[0].text, goalTitle: goals[i].title };
  }
  for (let i = 0; i < goals.length; i++) {
    const pending = (goals[i].tasks || []).filter(function (t) { return !t.done; });
    if (pending.length) return { text: pending[0].text, goalTitle: goals[i].title };
  }
  return null;
}

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

// "흐름" 카드 — 짧은(내 기록 7일) → 중간(세운) → 긴(대운) 세 층위
function renderFlow() {
  const now = new Date();
  const today = todayStr(now);
  const box = el("section", { cls: "flow" });
  box.id = "flow";
  box.setAttribute("aria-label", "흐름");
  box.appendChild(el("h2", { text: "흐름" }));
  box.appendChild(el("p", { cls: "what", text: "내 실제 기록 7일치 + 사주로 본 이번 달·올해 구간. 하루가 아니라 흐름을 봅니다." }));

  // --- 짧은 흐름: 사주가 아니라 실제 기록 ---
  const s = recentStats(today, 7);
  const short = el("div", { cls: "layer" });
  short.appendChild(el("div", { cls: "llabel", text: "최근 7일 · 내 기록" }));
  if (s.pct == null) {
    short.appendChild(el("div", { cls: "muted", text: "아직 기록이 없습니다. 계획을 만들고 정시에 체크하면 여기에 쌓입니다." }));
  } else {
    short.appendChild(el("div", { cls: "bignum", text: "정시 " + s.onTime + "/" + s.coreTotal + " (" + s.pct + "%)" + (s.late ? "  · 늦음 " + s.late : "") }));
    const b = s.battery;
    if (b.high || b.mid || b.low) {
      short.appendChild(el("div", { cls: "muted", text: "배터리 빵빵 " + b.high + " · 보통 " + b.mid + " · 방전 " + b.low }));
    }
    if (s.worstDay) {
      short.appendChild(el("div", { cls: "muted", text: s.worstDay.day + "이 가장 약함 — 정시 " + s.worstDay.onTime + "/" + s.worstDay.core }));
    }
  }
  const st = stalledTask(loadProfile());
  if (st) short.appendChild(el("div", { cls: "muted", text: "다음 차례: " + st.text + " · " + st.goalTitle }));
  box.appendChild(short);

  // --- 중간 흐름: 이번 달부터 3개월 · 월운 ---
  const mon = el("div", { cls: "layer" });
  mon.appendChild(el("div", { cls: "llabel", text: "이번 달부터 3개월 · 월운" }));
  monthFlow(today, 3).forEach(function (mo, i) {
    const row = el("div", { cls: "yrow " + mo.tone.key + (i === 0 ? " now" : "") });
    row.appendChild(el("span", { cls: "yy", text: mo.m + "월" }));
    row.appendChild(el("span", { cls: "ygz", text: mo.gz }));
    row.appendChild(el("span", { cls: "ytone", text: mo.tone.label }));
    if (i === 0 || mo.tone.key === "good") row.appendChild(el("span", { cls: "ynote", text: mo.tone.note }));
    mon.appendChild(row);
  });
  mon.appendChild(el("div", { cls: "muted", text: "월 경계는 절기(입춘·경칩 …) 기준이라 달력 1일과 다릅니다." }));
  box.appendChild(mon);

  // --- 중간 흐름: 세운 6년 ---
  const mid = el("div", { cls: "layer" });
  mid.appendChild(el("div", { cls: "llabel", text: "앞으로 6년 · 세운" }));
  yearFlow(now.getFullYear(), 6).forEach(function (y, i) {
    const row = el("div", { cls: "yrow " + y.tone.key + (i === 0 ? " now" : "") });
    row.appendChild(el("span", { cls: "yy", text: String(y.year) }));
    row.appendChild(el("span", { cls: "ygz", text: y.gz }));
    row.appendChild(el("span", { cls: "ytone", text: y.tone.label }));
    if (i === 0 || y.tone.key === "good") row.appendChild(el("span", { cls: "ynote", text: y.tone.note }));
    mid.appendChild(row);
  });
  box.appendChild(mid);

  // --- 긴 흐름: 대운 (접어둠) ---
  box.appendChild(renderTimeline());
  box.appendChild(el("p", { cls: "muted", text: "사주는 성향의 지도이지 확정된 미래가 아닙니다. 위 7일 숫자만이 실제로 일어난 일입니다." }));
  return box;
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
  askPersist();
  saveVisits(recordVisit(loadVisits(), todayStr()));
  render();
  if (notifyOn()) startNotifyLoop();
  try { if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("visibilitychange", noteBreak); } catch (e) {}
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("hashchange", function () { closeFocusQuiet(); render(); });
    }
  } catch (e) {}
  // 현재/다음 블록 표시가 시간이 지나면 갱신되도록 1분마다 리렌더
  if (typeof setInterval !== "undefined") {
    setInterval(function () { if (!generating && !breaking && !dragId) render(); }, 60000);
  }
}

// ---- exports for node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeStreak, visitGrid, recordVisit, goalProgress, nextPendingTasks,
    findGoal, extractJSON, todayStr, dateStr, addDays, pad2, activeDate,
    templatePlan, mapAIBlocks, coreStatus, generatePlan, profileContext, loadProfile,
    parseTaskList, breakdownGoalNow, parseTextSchedule, repairTruncatedJSON, weekdayOf, dateWithWeekday, normalizeMeals, normalizeShopping, bodyStats, mealContext, quoteFor, currentCycle, currentAge, yearPillar, yearTone, yearFlow, gzTone, solarMonth, monthPillar, monthFlow, recentStats, stalledTask, renderFlow, isOnTime, startWindow, lockReason, blockStartMinutes, blockEndMinutes, setBlockDone, currentBlock, daySummary, replanFromNow, keepableBlocks, dayPillar, julianDay, dayFortune, hourBranch, commuteBetween, isFillerBlock, isMicroBlock, splitDay, spanText, isRecallable, parseQuestions, attachQuestions, isLeech, leechItems, reviewQuota, LEECH_AT, parseCourses, DEFAULT_COURSES, loadSessions, saveSessions, addSession, sessionStats, sessionLine, dailyCourses, courseScore, lastTouched, scopeUnits, examPace, paceLine, DAILY_COURSES, loadReviews, saveReviews, scheduleReview, addReview, dueReviews, dueReviewCandidates, settleReview, askLabel, finishBlock, REVIEW_STEPS, isQuotaError, buildPrompt, parseCourseTasks, pastRecord, importCourseTasks, daysUntil, loadStuck, addStuck, PROMPTS, taskKind, courseKind, blockMinutesFor, retrievalText, KINDS, setEditing, editableBlocks, swapSlots, shiftBlock, swapTask, dropBlock, swapCandidates, applyEdit, renderFortune, renderNatal, natalChart, hourPillar, renderGoalsPanel, renderGuide, renderNowbar, renderPlanTools, currentTab, goTab, mealsAvailable, firstStep, setBlockStarted, exportPayload, applyImport, openFocus, closeFocus, renderFocus, placeRules, fillPlaces, insertCommutes, minToClock, parseEvents, mergeEventBlocks, getEvent, setEvent, render
  };
}

if (typeof document !== "undefined") boot();
