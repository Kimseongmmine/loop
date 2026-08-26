# LOOP — 프로젝트 기록 (CLAUDE.md)

## 무엇 (v1.1)
내 상황(목표+자유 상황메모)을 적어두고 "계획 생성" 버튼을 누르면 AI가 하루(9~24시) 시간표를 짜주는 개인 대시보드 PWA.
밤(21시~) 누르면 내일 것, 낮이면 오늘 것(activeDate). 목표별 진행도 + 접속 스트릭 표시.
생성은 온디맨드(자동 아님). 무키/실패 시 템플릿 폴백.
- 배포: GitHub Pages (https://kimseongmmine.github.io/loop/), git push하면 자동 갱신
- 핵심 추가 함수: activeDate, generatePlan(로딩상태 generating), profile.situation, goal.deadline

## 왜 (사용자 맥락)
매일 "뭘 할지" 정하는 결정 자체가 실패 지점(관성 약함). 그 결정을 AI에게 넘긴다.
빽빽한 15시간 계획은 1일차 포기 → **핵심 3개만 하면 성공**(무너짐 방지)이 핵심 장치.
강제성은 접속 스트릭만(사람·돈·잔소리 전부 사용자가 거부).

## 스택 (변경 금지)
- 바닐라 JS + HTML + CSS. 빌드도구·프레임워크·의존성 0
- 파일 4개: index.html / app.js / style.css / manifest.json (+ 저장소 문서 README/CLAUDE.md, 아이콘 png)
- 저장 localStorage만. 서버 없음. Vercel 정적 배포
- AI: OpenRouter 무료 모델. 키는 localStorage "loop.or_key"에만(코드·깃 미포함)

## v1.3 (AI 신뢰성 + 목표 쪼개기 + 밝은 테마)
- AI 목표 쪼개기: JSON 대신 **번호/불릿 목록**으로 받아 parseTaskList로 파싱(작은 무료모델이 목록은 잘 만듦). 프리앰블/콜론줄 제거. JSON도 여전히 허용
- 프롬프트 조임: 추상적 과제('공부하기') 금지, 구체적('3장 1-10번 풀기') 요구
- 목표 카드에 "🧩 AI로 과제 쪼개기" 버튼(breakdownGoalNow, breaking 로딩플래그)
- 디자인: **라이트 테마**(흰 카드, 파란 포인트 #2563eb, 카드형 섹션). theme-color/manifest도 라이트로

## 프로필 양식 (v1.2)
- `loop.profile`에 카테고리 텍스트 필드: `fixed`(고정일정), `rhythm`(하루리듬), `traits`(특성), `prefs`(선호). 전부 선택.
- 구버전 `situation` → `traits` 자동 마이그레이션(loadProfile)
- `profileContext(profile)`가 4필드+마감을 AI 컨텍스트로 조립 → aiGeneratePlan에 주입
- 계획 프롬프트 규칙: 고정일정 시간대엔 학습블록 금지, 하루리듬 기상~취침 내, 집중시간에 핵심 배치
- 설정 UI: "내 정보" 블록(PROFILE_FIELDS 4개 라벨 textarea + 예시 placeholder)

## 데이터 모델 (localStorage)
- `loop.profile` = { fixed, rhythm, traits, prefs, goals:[ { id, title, deadline, tasks:[{id,text,done}] } ] }
  - 진행도 = done/total (goalProgress)
- `loop.plans` = { "YYYY-MM-DD": { blocks:[{id,time,text,goalId,taskId,core,done}], generatedAt, source:"template"|"ai" } }
  - 학습 블록은 goalId+taskId 보유, 체크 시 해당 task 완료 → 진행도 연동. 생활 블록은 null
- `loop.visits` = ["YYYY-MM-DD"] → 스트릭(오늘부터 역순 연속) + 접속 점그리드

## 동작
- boot: 오늘 방문 기록 → 템플릿 계획 즉시 생성 → 렌더 → (키 있으면) aiEnhance 비동기
- aiEnhance: 과제 없는 목표를 AI로 분해(A) + 손대지 않은 템플릿을 AI 계획(B)으로 교체
- 손대지 않은 템플릿은 목표/과제 추가 시 즉시 갱신(refreshTemplateIfUntouched)
- 무키/실패/깨진 JSON → 고정 템플릿 시간표로 폴백. 앱 안 깨짐

## 상태: v1 완성
- 순수 유닛테스트(33개) + 헤드리스 DOM(대시보드 흐름) + AI 스텁(분해/계획/폴백) 전부 통과
- 배포: 폴더째 Vercel

## 개발 규약
- 스택·파일4개 유지. 스펙 밖 기능은 사용자 승인 후에만
- 테스트는 시각 주입·fetch 스텁으로 결정적으로. 실제 시각/네트워크 대기 금지
- v0("하루 한 줄", 밤/아침 타이머)는 폐기됨. git 히스토리에만 존재

## v1.6 (특별 일정 + 월운)
- `loop.events` = { "YYYY-MM-DD": "14:00 병원, 19시-21시 알바" } — 그날 하루만의 예외 일정. 히어로에 입력칸(생성 버튼 바로 위), 날짜별 저장
  - `parseEvents`: ':' 또는 '시'가 붙은 것만 시각으로 인정(→ "3장 1-10번 풀기"를 시간으로 오해 안 함). "9시 30분"·"오후 2시" 정규화. 시각 없으면 time:null
  - AI 프롬프트에 `[특별 일정]` 주입 + 시스템 규칙(그 시각은 일정 블록으로, 학습은 이동)
  - `mergeEventBlocks`: 템플릿 폴백에도 일정을 실제 블록으로 삽입, 겹치는 템플릿 블록은 비움 → AI가 죽어도 일정이 사라지지 않음
  - 적어뒀는데 현재 계획에 없으면 "다시 생성하면 반영됩니다" 사실만 고지
- 월운(중간 흐름): `solarMonth`(절기 근사 TERM_DAY) → `monthPillar`(월지=절기월, 월간=오호둔) → `monthFlow(3개월)`. 흐름 카드에 "이번 달부터 3개월 · 월운"
  - `yearTone` → `gzTone`으로 일반화해서 세운·월운이 같은 판정(금수=순풍/전환, 화토=축적)을 쓴다
  - 절입일은 평년 근사값이라 실제와 하루 차이 가능 — 화면에도 명시
