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
const OR_FREE_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling:free",
  "poolside/laguna-s-2.1:free",
  "dots-studio/dots-3-note-preview:free",
  "thinkingmachines/inkling-small:free",
  "liquid/lfm-2.5-2.6b:free"
];
const OR_DEFAULT_MODEL = OR_FREE_MODELS[0];
function getKey() { try { return localStorage.getItem(K_ORKEY) || ""; } catch (e) { return ""; } }
function setKey(k) { try { localStorage.setItem(K_ORKEY, k); } catch (e) {} }
function getModel() { try { return localStorage.getItem(K_ORMODEL) || OR_DEFAULT_MODEL; } catch (e) { return OR_DEFAULT_MODEL; } }
function setModel(m) { try { localStorage.setItem(K_ORMODEL, m); } catch (e) {} }

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

// try the saved model first, then rotate through the free list until one works
async function orChat(messages, maxTokens) {
  const key = getKey();
  if (!key || typeof fetch === "undefined") { lastAIError = "API 키가 없습니다."; return null; }
  const tried = {};
  const order = [getModel()].concat(OR_FREE_MODELS).filter(function (m) {
    if (!m || tried[m]) return false; tried[m] = true; return true;
  });
  let last = "";
  for (let i = 0; i < order.length; i++) {
    try {
      const r = await orOnce(key, order[i], messages, maxTokens);
      if (r.ok) { setModel(order[i]); lastAIError = ""; return r.content; }
      last = "HTTP " + r.status + " · " + r.error + "  [" + order[i] + "]";
      // 401/403 = 키/권한 문제 → 다른 모델도 똑같이 실패하므로 즉시 중단
      if (r.status === 401 || r.status === 403) break;
    } catch (e) {
      last = "네트워크 오류 · " + (e && e.message ? e.message : e);
    }
  }
  lastAIError = last;
  return null;
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
  const sys = "너는 학습 코치다. 주어진 목표를 60분 안에 하나씩 끝낼 수 있는 아주 구체적인 실행 과제 5~8개로 쪼갠다. " +
    "순서대로, 작고 명확하게. 한국어. 오직 JSON만 출력: {\"tasks\":[\"과제1\",\"과제2\"]}";
  const situation = (loadProfile().situation || "").trim();
  const usr = "목표: " + goal.title +
    (goal.deadline ? ("\n마감: " + goal.deadline) : "") +
    (goal.note ? ("\n메모: " + goal.note) : "") +
    (situation ? ("\n내 상황: " + situation) : "");
  const txt = await orChat([{ role: "system", content: sys }, { role: "user", content: usr }], 500);
  const j = extractJSON(txt);
  if (j && Array.isArray(j.tasks) && j.tasks.length) {
    return j.tasks.slice(0, 10).map(function (t) { return { id: genId("t"), text: String(t).slice(0, 60), done: false }; });
  }
  return null;
}

async function aiGeneratePlan(candidates) {
  const sys = "너는 대학 3학년의 하루 시간표를 짜는 코치다. 이 사람은 쉽게 지치고 미룬다. " +
    "09:00~24:00을 시간 블록으로 채우되 현실적으로: 딥워크 사이에 휴식·이동·식사, 저녁은 가볍게. 강도는 절반, 몰아치기 금지. " +
    "주어진 후보 과제를 시간표에 배치하고(각 블록의 ref에 후보 index), 휴식/식사/운동 같은 생활 블록은 ref 없이 넣어라. " +
    "가장 중요한 3개 학습 블록에만 core:true. 오직 JSON만: {\"blocks\":[{\"time\":\"09:00-11:00\",\"text\":\"...\",\"ref\":0,\"core\":true}]}";
  const profile = loadProfile();
  const situation = (profile.situation || "").trim();
  const deadlines = profile.goals
    .filter(function (g) { return g.deadline; })
    .map(function (g) { return "- " + g.title + ": 마감 " + g.deadline; }).join("\n");
  const list = candidates.map(function (c, i) { return i + ": " + c.text + " (" + c.goalTitle + ")"; }).join("\n");
  const usr =
    (situation ? ("내 상황: " + situation + "\n\n") : "") +
    (deadlines ? ("마감 있는 목표:\n" + deadlines + "\n\n") : "") +
    "후보 과제:\n" + (list || "(없음)") +
    "\n\n09~24시 시간표를 JSON으로. 마감 급한 목표를 앞쪽·핵심으로.";
  const txt = await orChat([{ role: "system", content: sys }, { role: "user", content: usr }], 900);
  const j = extractJSON(txt);
  if (j && Array.isArray(j.blocks)) return mapAIBlocks(j.blocks, candidates);
  return null;
}

// on-demand plan generation for a target date. shows loading, falls back to template.
let generating = false;
async function generatePlan(targetDate) {
  if (generating) return;
  generating = true;
  render(); // loading state

  try {
    const hasAI = !!getKey() && typeof fetch !== "undefined";
    // 1) break down any goal that has no tasks (AI)
    if (hasAI) {
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
    if (hasAI) { blocks = await aiGeneratePlan(candidates); if (blocks) source = "ai"; }
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
    if (getKey()) {
      box.appendChild(el("p", { cls: "err", text: "AI 실패 → 기본 템플릿. 이유: " + (lastAIError || "알 수 없음") }));
      box.appendChild(el("p", { cls: "muted", text: "해결: ① openrouter.ai → Settings → Privacy에서 무료 모델(prompt logging) 허용 켜기  ② 안 되면 설정에서 키/모델 변경" }));
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

  // free-text situation memo (fed to the AI planner)
  const sitWrap = el("div", { cls: "sitwrap" });
  sitWrap.appendChild(el("div", { cls: "muted", text: "내 상황 (AI가 계획 짤 때 참고)" }));
  const sit = el("textarea", { cls: "situation" });
  sit.placeholder = "예: 아침에 약함 / 화요일 공강 / 정처기 7월 시험 / 저녁엔 집중 안 됨";
  sit.value = profile.situation || "";
  sit.addEventListener("change", function () {
    const p = loadProfile(); p.situation = sit.value; saveProfile(p);
  });
  sitWrap.appendChild(sit);
  box.appendChild(sitWrap);

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

    if (!g.tasks || !g.tasks.length) {
      const hint = el("span", { cls: "muted", text: getKey() ? "새로고침하면 AI가 과제로 분해합니다." : "과제를 직접 추가하거나, 아래 AI를 켜세요." });
      gv.appendChild(hint);
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

  // key entry
  if (!getKey()) {
    const kl = el("button", { cls: "mini", text: "🔑 AI 맞춤계획 켜기" });
    kl.addEventListener("click", function () {
      const k = window.prompt("OpenRouter API 키 (sk-or-...):", "");
      if (k && k.trim()) { setKey(k.trim()); render(); }
    });
    box.appendChild(kl);
  } else {
    const mrow = el("div", { cls: "addrow" });
    mrow.appendChild(el("span", { cls: "muted", text: "AI 켜짐 · 모델: " + getModel() }));
    const mc = el("button", { cls: "mini", text: "모델 변경" });
    mc.addEventListener("click", function () {
      const cur = getModel();
      const v = window.prompt("OpenRouter 모델 id (무료는 :free로 끝남):", cur);
      if (v && v.trim()) { try { localStorage.setItem(K_ORMODEL, v.trim()); } catch (e) {} render(); }
    });
    mrow.appendChild(mc);
    const kc = el("button", { cls: "mini", text: "키 변경" });
    kc.addEventListener("click", function () {
      const v = window.prompt("OpenRouter API 키 (sk-or-...):", "");
      if (v && v.trim()) { setKey(v.trim()); render(); }
    });
    mrow.appendChild(kc);
    box.appendChild(mrow);
  }
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
    templatePlan, mapAIBlocks, coreStatus, generatePlan
  };
}

if (typeof document !== "undefined") boot();
