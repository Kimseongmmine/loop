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

## v1.7 (블록에 장소 + 이동 블록)
- 블록에 `place` 추가: `{ id, time, text, place, goalId, taskId, core, done, event?, move? }`. 구버전 계획엔 없으므로 없으면 표시 안 함(마이그레이션 불필요)
- 프로필 5번째 필드 `places`(자주 가는 장소 · 이동 시간). `loadProfile`에서 undefined일 때만 기본값 시드(빈 입력창 금지 원칙). 빈 문자열로 지우면 지운 대로 둔다
- `placeRules`: 자유 텍스트에서 도서관/카페/운동/집 이름과 이동 시간(`(\d+)분`, 기본 20·최대 120)을 뽑는다
- `fillPlaces`: place 없는 블록만 규칙으로 채움 — 학습 180분 이상=카페 / 미만=도서관, 운동=운동 장소, 식사·휴식=직전 장소(단 운동 뒤엔 집), 21시 이후=집. 특별 일정(`event`)과 이미 있는 place는 안 건드림
- `insertCommutes`: 장소가 바뀌면 이동 블록 삽입 + 뒤 블록 시작을 이동 시간만큼 미룸. 남는 길이가 20분 미만이면 삽입 안 함. 템플릿 폴백 전용(AI 경로는 AI가 직접 이동 블록을 넣게 프롬프트)
- AI: 시스템 규칙 + JSON 스키마에 `place`. 빠뜨리면 `fillPlaces`가 뒤에서 채움
- 화면: 텍스트 옆 회색 장소 칩(`.place`), 이동 블록은 흐리게(`.block.isMove`)

## v1.8 (착수 · 실행 모드 · 백업) — 리서치 반영
근거: 시간·장소만 정하는 계획은 반복 행동에 효과 없음(사전등록 RCT null, 출판편향 보정 d=.15). 살아남는 형태는 **접합점 큐**("A 끝나면 바로 B", d=.50)와 **구체적 첫 몸동작**. 성공 지표는 완료가 아니라 **착수**.

### 착수(started)를 완료(done)에서 분리
- 블록: `{ ..., first, started, startedAt, onTime, done }`. `onTime`은 **착수 시점에 한 번만** 굳는다(두 번 눌러도 안 바뀜)
- `setBlockStarted(date, id, now)` — 멱등. `setBlockDone(true)`는 착수 기록이 없으면 그 순간을 착수로 본다(구버전 데이터와 같은 뜻)
- `coreStatus` → `{ done: 정시 착수 수, late, fin: 완료 수, total }`. 화면 문구 "핵심 n/m 정시" → **"착수 n/m · 완료 k"**
- `daySummary` / `recentStats`도 `b.onTime` 기준으로 통일 (구버전 계획은 done 시점에 onTime이 찍혔으므로 그대로 호환)

### 첫 동작 (firstStep)
- 시작이 막히는 지점은 장소가 아니라 **다음 몸동작이 비어 있는 것**. 블록마다 5분 안에 끝나는 물리적 동작 한 줄
- AI가 `first`를 채우고(프롬프트+스키마), 없으면 `firstStep`이 규칙으로 만든다: 이동→"지금 일어나서 나가기" / 운동→"옷 갈아입고 가방 챙기기" / 학습→"자리에 앉아 {과제 26자} · 5분만" / 휴식·식사·특별일정→없음

### 실행 모드 (renderFocus)
- `focusId`가 있으면 `render()`가 **그 블록 하나만** 그린다(히어로·계획·흐름 전부 안 그림)
- 구성: 시각·장소 / 블록 제목 / **첫 동작(가장 크게)** / 남은 시간 바 / [5분만 시작] [시작 기록] [완료] / "끝나면 다음 · …"
- 5분 타이머는 `focusUntil`(ms) + 1초 인터벌. 끝나도 아무 평가 안 함
- 진입: 히어로의 "지금/다음" 줄 전체가 버튼, 계획 카드의 "▶ 실행 모드", 블록 행의 "시작"(라벨 안이라 `preventDefault` 필요)

### 데이터 백업 (localStorage는 지워진다)
- 사파리 7일 미접속 시 스크립트 저장 데이터 삭제, 용량 부족 시 오리진 통째 삭제, 상한 5MiB — 유실이 실재해서 넣음
- `DATA_KEYS` = profile/plans/visits/energy/notes/done/events. **API 키는 절대 내보내지 않는다**
- `exportPayload()` → `{app:"loop", version:1, exportedAt, data:{키:원문자열}}` / `applyImport(payload)` → 형식 확인 후 파싱 되는 항목만 복구, 개수 반환
- 내보내기: 크로미움 PC는 `showSaveFilePicker`로 같은 파일 덮어쓰기, 그 외 Blob 다운로드. 가져오기 전 `confirm`
- `askPersist()`를 boot에서 호출(`navigator.storage.persist()`)
- 설정 하단 "데이터" 블록에 버튼·마지막 백업일·경고 문구

### 안 넣기로 한 것 (리서치 근거)
벌칙형 커밋먼트(55% 실패) / 알림 강화(앱 이탈 1위 원인) / 버디·소셜(자동 코치와 차이 없음이 RCT로 확인) / 21일 챌린지(자동화까지 18~254일, 정해진 기간 없음)

## v1.9 (기능 노출 + 오늘의 운세)
"뭐가 뭔지 모르겠다"가 출발점. 기능이 있는 것과 보이는 것은 다르다.

### 기능이 드러나게
- 히어로의 긴 설명 문단 → 한 줄로 줄이고, 그 아래 **"할 수 있는 것"** 목록(`.guide` / `.grow`) 5개: 실행 모드 · 목표 쪼개기 · 식단·장보기 · 오늘의 운세 · 백업. 각 줄 = 아이콘 + 이름 + **이게 뭘 하는지 한 줄** + 바로 실행
  - 조건이 안 되면 잠그고 이유를 그 자리에 쓴다: 계획 없음 → "오늘 계획을 먼저 만드세요", 재료 없음 → "설정에 냉장고 재료를 적으면…"(이 경우는 잠그지 않고 설정으로 보냄)
  - `mealsAvailable()` — 식단 카드가 뜰 조건을 미리 계산해서 죽은 버튼을 없앤다
- 모든 카드 h2 아래에 `.what` 한 줄 설명(계획/진행도/식단/오늘 한 줄/흐름/운세)
- 설정 summary: "설정 · 목표" → **"⚙ 설정 — 내 정보 · 목표 · 식단 재료 · AI 키 · 백업"**
- `scrollTo(id)` + 각 섹션에 id(today/prog/meals/note/flow/fortune/settings)

### 오늘의 운세 (일진)
- `julianDay(dateString)` — 그레고리력 → 율리우스 적일. `dayPillar` = `(JDN + 49) % 60`
  - **기준점 두 개로 교차 검증**: 1900-01-01 = 甲戌, 2000-01-01 = 戊午 (테스트로 고정)
  - 주의: "1984-02-02 = 甲子"는 **연주** 이야기다. 일주로는 丙寅. 혼동 금지
- `BIRTH_HOUR = 10` → `hourBranch(10)` = 巳시. 시지는 23시부터 두 시간씩(`(h+25)%24/2`)
- `dayFortune(date)` → `{ gz, el, tone, act, hours }`. tone은 `gzTone` 재사용(세운·월운과 같은 판정)
- **`act`는 지시문만 쓴다. 그 날을 나쁘다고 하지 않는다** — 순풍/전환/축적/보통 넷 다 "오늘 뭘 하라"만. 테스트가 부정 단어(나쁜·불리·조심·실패…)를 막는다
  - 근거: 부정적 운세는 인지 수행을 실제로 떨어뜨린다(실험 3개). 반대로 긍정 프레이밍은 올린다. 그리고 앱은 사용자를 평가하지 않는다는 원칙과도 같은 방향
- `hours`: 용신 水 · 희신 金 시간대(15–17 申, 17–19 酉, 21–23 亥) 중 그날 일진의 오행과 겹치는 것을 강조
- 고지 두 줄: 출생 시각(巳시 = 원국에 화가 하나 더), 일진은 달력 기준이고 사주 원칙으로는 23시부터 다음 날
- 미보유 정보: **생년월일**이 없어 시주 천간(오자둔)은 계산 못 한다. 시지까지만
