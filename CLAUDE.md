# LOOP — 프로젝트 기록 (CLAUDE.md)

## 무엇 (v1)
접속하면 AI가 내 목표를 분석해 오늘 하루(9~24시) 시간표를 짜주고, 목표별 진행도 + 접속 스트릭을 보여주는 개인 대시보드 PWA.

## 왜 (사용자 맥락)
매일 "뭘 할지" 정하는 결정 자체가 실패 지점(관성 약함). 그 결정을 AI에게 넘긴다.
빽빽한 15시간 계획은 1일차 포기 → **핵심 3개만 하면 성공**(무너짐 방지)이 핵심 장치.
강제성은 접속 스트릭만(사람·돈·잔소리 전부 사용자가 거부).

## 스택 (변경 금지)
- 바닐라 JS + HTML + CSS. 빌드도구·프레임워크·의존성 0
- 파일 4개: index.html / app.js / style.css / manifest.json (+ 저장소 문서 README/CLAUDE.md, 아이콘 png)
- 저장 localStorage만. 서버 없음. Vercel 정적 배포
- AI: OpenRouter 무료 모델. 키는 localStorage "loop.or_key"에만(코드·깃 미포함)

## 데이터 모델 (localStorage)
- `loop.profile` = { goals:[ { id, title, note, tasks:[{id,text,done}], analyzedAt } ] }
  - 진행도 = done/total (goalProgress)
- `loop.plans` = { "YYYY-MM-DD": { blocks:[{id,time,text,goalId,taskId,core,done}], generatedAt, source:"template"|"ai" } }
  - 학습 블록은 goalId+taskId 보유, 체크 시 해당 task 완료 → 진행도 연동. 생활 블록은 null
- `loop.visits` = ["YYYY-MM-DD"] → 스트릭(오늘부터 역순 연속) + 접속 점그리드

## 동작
- boot: 오늘 방문 기록 → 템플릿 계획 즉시 생성 → 렌더 → (키 있으면) aiEnhance 비동기
- aiEnhance: 과제 없는 목표를 AI로 분해(A) + 손대지 않은 템플릿을 AI 계획(B)으로 교체
- 손대지 않은 템플릿은 목표/과제 추가 시 즉시 갱신(refreshTemplateIfUntouched)
- 무키/실패/깨진 JSON → 고정 템플릿 시간표로 폴백. 앱 안 깨짐

## 핵심 함수 (app.js)
- 순수: computeStreak, visitGrid, goalProgress, nextPendingTasks, templatePlan, mapAIBlocks, coreStatus, extractJSON
- AI: orChat, aiBreakdownGoal(A), aiGeneratePlan(B), aiEnhance
- 렌더: renderHeader/renderProgress/renderToday/renderSettings

## 작업 순서 (v1 — 전부 완료)
1. [x] 데이터 계층(profile/plans/visits, 스트릭·진행도) + 유닛테스트
2. [x] 대시보드 골격(헤더·스트릭 그리드·진행도)
3. [x] 설정: 목표/과제 CRUD·수동 체크
4. [x] AI 배관(분해 A·계획 B·관대 파서·템플릿 폴백)
5. [x] 오늘 계획 렌더·핵심3·체크→진행도 연동
6. [x] style.css 대시보드
7. [x] README/CLAUDE.md 갱신

## 상태: v1 완성
- 순수 유닛테스트(33개) + 헤드리스 DOM(대시보드 흐름) + AI 스텁(분해/계획/폴백) 전부 통과
- 배포: 폴더째 Vercel

## 개발 규약
- 스택·파일4개 유지. 스펙 밖 기능은 사용자 승인 후에만
- 테스트는 시각 주입·fetch 스텁으로 결정적으로. 실제 시각/네트워크 대기 금지
- v0("하루 한 줄", 밤/아침 타이머)는 폐기됨. git 히스토리에만 존재
