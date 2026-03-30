# RisuAI 서버 채팅 파이프라인 정상화 — 세션 인수인계 지시문

> 최종 갱신: 2026-03-15 | Phase 1-4c 완료, Phase 5 핵심 아키텍처 완료 (UI 잔여)

---

## 1. 프로젝트 개요

- **프로젝트**: RisuAI Server-Stream (`server-stream` 브랜치)
- **목표**: 프론트 중심 → 서버 중심 아키텍처 전환. 모든 LLM 요청이 서버에서 프롬프트 조합 → 응답 수신 → 후처리(트리거, 보조 LLM, 스크립트) → DB 저장까지 완전히 처리되고, 프론트엔드는 결과를 미러링/표시만 함.
- **기술 스택**: Svelte 5 + TypeScript + Vite (프론트), Node.js + Express (서버 `server/node/`)
- **배포**: GitHub `fork/server-stream` → SSH → `pnpm run build` → `pm2 restart risu`
- **서버**: Oracle Cloud `134.185.114.135:6001`
- **배포 명령**:
```bash
# 로컬
cd g:/Antigravity/RisuAI/RisuAI_Latest
git push fork server-stream
# 서버
ssh -i C:/SSH/Oracle_RisuAI_SSH.key ubuntu@134.185.114.135 \
  "cd ~/Risu-AI/RisuAI && git stash && git pull origin server-stream && pnpm run build && pm2 restart risu"
```

---

## 2. 완료된 작업 (Phase 1-2)

### Phase 1: 리커버리 수정 ✅

**문제**: `initServerChatRecovery()`가 데이터를 서버에서 가져와 `DBState.db`에 주입하지만, Svelte가 UI를 다시 렌더링하지 않았음.

**원인**: `DBState.db.characters[].chats[].message[]`를 직접 mutation 후 `reloadKeys`를 증가시키지 않음. `saveDb()`도 호출하지 않아 디스크에 영속화되지 않음.

**수정 (커밋 `6bce2576`)**:
- `src/ts/process/serverChat.ts`에 `triggerChatReload()` 헬퍼 추가 — `char.reloadKeys++`
- `injectRecoveredResponse()` 후 `triggerChatReload()` 호출
- SSE 스트리밍 리커버리 중 매 청크마다 `triggerChatReload()` 호출
- Plugin recovery 양쪽 경로에 `triggerChatReload()` + `saveDb()` 추가
- 메인 job recovery 완료 후 `saveDb()` 호출

### Phase 1b: 서버 Job 영속성 ✅

**문제**: `chatEngine.cjs`의 `activeJobs = new Map()`이 인메모리 전용. 서버 재시작 시 전부 손실.

**수정 (커밋 `ebe543c0`)**:
- `save/__active_jobs/{jobId}.json`으로 디스크 persist
- `persistJob(job)` — 생성, 상태 전환(done/error), 스트리밍 중 5초마다 호출
- `unpersistJob(jobId)` — TTL 만료 시 파일 삭제
- `loadPersistedJobs()` — 서버 시작 시 디스크에서 복원
  - streaming/pending 상태 Job: fullText 있으면 `done`으로 마크, 없으면 `error`로 마크
  - TTL(10분) 초과 Job: 삭제

### Phase 2: 모든 모델 Job 라우팅 ✅

**접근**: 개별 모델 파일 수정 대신, `/proxy2` TEE 캡처를 Job 시스템과 통합.

**수정 (커밋 `4f2babf5`)**:

**서버 (`server/node/server.cjs` reverseProxyFunc)**:
- `X-Risu-Char-Index` + `X-Risu-Chat-Page` 헤더 감지 시 `chatEngine.createJob()` 호출
- TEE 스트리밍 루프에서 `extractDeltaFromSSE()`로 텍스트 축적 → `proxyJob.fullText`
- 스트리밍 완료 후 `proxyJob.status = 'done'`, `persistJob()`, `endAllListeners()`
- `X-Risu-Job-Id` 응답 헤더로 Job ID 반환

**서버 (`server/node/chatEngine.cjs`)**:
- `createJob`, `persistJob`, `broadcastToListeners`, `endAllListeners`, `extractDeltaFromSSE` export 추가

**프론트 (`src/ts/globalApi.svelte.ts` fetchNative)**:
- `isNodeServer && chatId` 조건에서 `X-Risu-Char-Index`, `X-Risu-Chat-Page` 헤더 추가
- 응답의 `X-Risu-Job-Id` 헤더를 읽어 `__risu_active_server_jobs` localStorage에 등록

**프론트 (`src/ts/process/index.svelte.ts` 스트리밍 루프)**:
- 스트리밍 정상 완료 시 `__risu_active_server_jobs`에서 해당 Job 제거

**동작 원리**:
1. 프론트가 LLM 요청 → `fetchNative()` → `/proxy2`로 전달 (기존 경로)
2. 서버가 LLM API로 요청 전달하면서 동시에 Job 생성 + SSE 텍스트 축적
3. 프론트가 raw LLM SSE 형식을 그대로 받아 기존 모델별 파서로 처리 (변경 없음)
4. 프론트 새로고침 → `initServerChatRecovery()` → Job 폴링 → 복구
5. 모든 모델이 자동으로 적용됨 (모델 파일 수정 불필요)

**현재 한계**:
- `/proxy2`는 프론트 연결에 의존하여 LLM 요청을 시작. 프론트가 요청 시작 전에 종료되면 서버가 요청을 시작하지 못함.
- 프론트가 스트리밍 도중 종료되면, 서버의 TEE 모드가 LLM 스트림을 끝까지 읽고 Job에 저장하므로 복구 가능. 하지만 서버가 **독립적으로** LLM 요청을 시작하는 것은 아님.
- Phase 3 (서버 빌드)에서 이 한계가 해결됨: 프론트는 charIndex/chatPage/userMessage만 전송, 서버가 프롬프트부터 빌드.

---

## 3. 완료된 작업 (Phase 3)

### Phase 3: 서버 빌드 (send) 전환 ✅

**목표**: 프론트가 `charIndex`, `chatPage`, `userMessage`만 전송하면 서버가 프롬프트 조합부터 전부 처리.

**수정 (2026-03-14 세션)**:

**서버 (`server/node/chatEngine.cjs`)**:
- `POST /api/chat/send`에 `clientManaged` 플래그 추가. `true`면 `job.isRaw = true` → 서버가 프롬프트 빌드 + LLM 호출하되 DB 쓰기는 스킵 (프론트가 관리)
- `resolveApiUrl(db, model)` / `resolveApiKey(db, model)` — 모델 인식 API 해상도. Anthropic(`x-api-key`), Google Gemini URL 자동 감지
- `detectApiFormat(model)` — 모델명 기반 API 포맷 감지
- `runBackgroundLLMFetch()` — Anthropic용 `x-api-key` + `anthropic-version` 헤더 지원
- `requestBody`에서 `lorebookLog`, `luaEnabled` 등 메타데이터 필드를 LLM API 전송 전 제거
- 응답에 `model` 필드 포함하여 프론트에서 추적 가능

**서버 (`server/node/promptBuilder.cjs`)**:
- `extractModuleLorebooks(db, char, chat)` 함수 추가 — 프론트의 `getModuleLorebooks()` 로직 재현
  - `db.enabledModules` + `char.modules` + `chat.modules` + `db.moduleIntergration`에서 ID 수집
  - `db.modules[]`에서 ID/namespace 매칭 + 중복 제거
  - 매칭된 모듈의 `module.lorebook[]` 수집
- `moduleLorebooks: []` TODO 해결 → `extractModuleLorebooks()` 결과 사용

**프론트 (`src/ts/process/serverChat.ts`)**:
- `sendChatToServer()` 함수 추가 — `/api/chat/send` 호출 + SSE 연결 + `StreamResponseChunk` 변환
  - `clientManaged: true` 전송 → 서버 DB 쓰기 스킵
  - `connectToJobSSE()`의 `Uint8Array` 출력을 `{ model: fullText }` 형식으로 변환
  - `requestDataResponse` 타입과 호환되는 `ServerChatResult` 반환
  - recovery를 위해 `addActiveJob()` 자동 호출
  - 에러 핸들링 + AbortSignal 지원

**프론트 (`src/ts/process/index.svelte.ts`)**:
- `sendChat()`의 `requestChatData()` 호출을 `isNodeServer` 조건부로 교체:
  ```typescript
  if (isNodeServer && !arg.previewPrompt) {
      req = await sendChatToServer(selectedChar, selectedChat, serverUserMsg, abortSignal);
  } else {
      req = await requestChatData({...}, 'model', abortSignal);
  }
  ```
- `sendChatToServer` import 추가
- 기존 스트리밍 루프 + 후처리가 서버 응답에도 그대로 작동

**동작 원리**:
1. 프론트: `sendChat()` 호출 → Stage 1 프롬프트 빌드는 로컬에서도 실행 (트리거/스크립트 사이드이펙트 유지)
2. 프론트: `isNodeServer`일 때 `sendChatToServer()` 호출 → `/api/chat/send` POST
3. 서버: `buildFullPrompt()` → 서버 DB 기반 프롬프트 조합 (CBS, 로어북, 스크립트, Lua)
4. 서버: `runBackgroundLLMFetch()` → LLM API 호출 + SSE 스트리밍
5. 프론트: `connectToJobSSE()` → 스트리밍 결과를 기존 루프로 UI 업데이트
6. 프론트: Stage 4b 후처리 (트리거, TTS, auto-continue 등) 프론트에서 실행
7. recovery: 프론트 새로고침 → `initServerChatRecovery()` → job 복구

**현재 한계**:
- 프론트가 Stage 1을 여전히 실행함 (사이드이펙트 유지 목적). 서버도 프롬프트를 빌드하므로 이중 처리. Phase 4에서 해소 예정.
- Vertex AI, AWS Bedrock 등 복잡한 인증이 필요한 프로바이더는 `send-raw` 경로로 fallback 필요.
- HypaV3 메모리는 서버 promptBuilder에 미구현 (임베딩 모델 필요).
- 후처리 파이프라인(Phase 4)은 여전히 프론트에서만 실행.

---

## 4. 남은 작업 (Phase 4-5)

### Phase 4a: 후처리 파이프라인 서버 이식 ✅ (editoutput + auto-continue)

**목표**: 메인 LLM 응답 완료 후 실행되는 후처리 체인을 서버에서 실행.

**수정 (2026-03-15 세션)**:

**서버 (`server/node/chatEngine.cjs`)**:
- `runPostProcessing(job, apiUrl, apiKey, requestBody)` 함수 추가
  - `processScriptFull('editoutput')` — 서버측 정규식/CBS/모듈 스크립트 적용
  - `runLuaEditTrigger('editOutput')` — Lua editOutput 트리거 실행
  - Auto-continue 로직: `db.autoContinueMinTokens`, `db.autoContinueChat` 체크
    - 필요 시 LLM 재호출 + 텍스트 누적 (최대 5회 안전 제한)
    - 각 continuation 후 editoutput 스크립트 재적용
    - 중간 결과를 SSE로 브로드캐스트 + 디스크 persist
- `isLastCharPunctuation()`, `approxTokensForPostProcess()` 유틸리티 추가
- Post-processing 모듈 import 추가 (serverScripts, serverLuaRuntime, serverParser)
- `runBackgroundLLMFetch()`에서 `!job.isRaw` 조건으로 post-processing 호출
- `clientManaged` 미전송 시 서버가 user message + 후처리된 char response를 DB에 저장

**프론트 (`src/ts/process/serverChat.ts`)**:
- `clientManaged: true` 제거 → 서버가 후처리 + DB 저장 전담
- 서버가 editoutput, auto-continue, DB 저장까지 처리

**프론트 (`src/ts/process/index.svelte.ts`)**:
- `isNodeServer`일 때 auto-continue 스킵 (서버가 처리)
- `resultTokens` 스코프 수정 (TypeScript 에러 해결)

**현재 서버 후처리 흐름**:
```
서버: LLM 응답 완료
  → processScriptFull('editoutput') ✅
  → runLuaEditTrigger('editOutput') ✅
  → auto-continue? → 연속 LLM 요청 ✅
  → SSE 브로드캐스트 (후처리된 텍스트) ✅
  → saveJobResponse → DB 저장 ✅
```

### Phase 4b: 트리거 시스템 서버 이식 ✅

**수정 (2026-03-15 세션)**:

**서버 (`server/node/serverTriggers.cjs`)** — 신규 생성:
- `runTrigger(opts)` — 서버측 트리거 평가 엔진
  - 조건 평가: `var`, `value`, `exists`, `chatindex` 4가지 타입 모두 지원
  - V1 이펙트: `setvar`, `modifychat`, `cutchat`, `impersonate`, `sendAIprompt`, `systemprompt`, `stop`, `command`
  - V2 이펙트: `v2SetVar`, `v2GetVar`, `v2If`, `v2EndIndent`, `v2Loop`, `v2SetChat`, `v2GetChat`, `v2GetChatRole`, `v2GetChatLength`, `v2Calc`, `v2StringLength`, `v2StringReplace`
  - 브라우저 전용 이펙트 (`showAlert`, `generateAIImage`, `imggen`, `triggercode`, `triggerlua`): 안전한 no-op
- `collectTriggers(db, char)` — 캐릭터 + 모듈 트리거 수집
- `extractModuleTriggers(db, char)` — 모듈 트리거 추출 (ID/네임스페이스 매칭)
- 3단계 변수 시스템: 로컬 변수 (V2 인덴트 스코핑) → `chat.scriptstate` → 기본값

**서버 (`server/node/chatEngine.cjs`)**:
- `runPostProcessing()`에 트리거 실행 통합 (editoutput 후, auto-continue 전)
- `sendAIprompt` 재귀: 트리거가 `sendAIprompt=true` 반환 시:
  1. `promptBuilder.buildFullPrompt()`로 프롬프트 재빌드
  2. LLM 재호출 + editoutput 재적용
  3. output 트리거 재평가 (최대 3회 안전 제한)
- `stopSending` 처리: 후처리 즉시 중단
- `varChanged` 시 `chat.scriptstate` DB 영속화

**프론트 (`src/ts/process/index.svelte.ts`)**:
- `isNodeServer`일 때 streaming 경로의 `runTrigger('output')` 스킵
- `isNodeServer`일 때 non-streaming 경로의 `runTrigger('output')` 스킵
- `resendChat` 플래그: `isNodeServer`일 때 항상 false (서버가 재귀 처리)

**현재 서버 후처리 흐름**:
```
서버: LLM 응답 완료
  → processScriptFull('editoutput') ✅
  → runLuaEditTrigger('editOutput') ✅
  → runTrigger('output') ✅
  → sendAIprompt? → 프롬프트 재빌드 + 재귀 LLM ✅ (최대 3회)
  → auto-continue? → 연속 LLM 요청 ✅ (최대 5회)
  → saveJobResponse → DB 저장 ✅
```

### Phase 4c: 이미지 생성 서버 이식 ✅

**수정 (2026-03-15 세션)**:

**서버 (`server/node/serverImageGen.cjs`)** — 신규 생성:
- `generateNovelAI()` — NovelAI API + ZIP 응답 처리 (v4/v4.5, Variety+)
- `generateComfyUI()` — ComfyUI 워크플로우 실행 (Legacy/Modern, 폴링)
- `runImageGeneration()` — 전체 파이프라인 (LLM→프롬프트→이미지→인레이 저장)
- `processImgGenTags()` — `<ImgGen="prompt">` 태그 처리
- `storeInlayImage()` — 서버 인레이 파일 저장

| 순서 | 단계 | 서버 포팅 상태 |
|------|------|:-:|
| 1 | `processScriptFull('editoutput')` | ✅ 완료 |
| 2 | Lua `editOutput` 트리거 | ✅ 완료 |
| 3 | Auto-continue | ✅ 완료 |
| 4 | `runTrigger(char, 'output')` + `sendAIprompt` 재귀 | ✅ 완료 |
| 5 | `processImgGenTags()` — ImgGen 태그 | ✅ 완료 |
| 6 | `stableDiff()` — NovelAI, ComfyUI | ✅ 완료 |
| 7 | IGP 감정 모델 | ⏭️ 스킵 (미사용 기능) |
| 8 | 감정 자동 선택 | ⏭️ 스킵 (미사용 기능) |

### Phase 5: 병렬 Job + 멀티 기기 (핵심 아키텍처 완료)

**목표**: 한 브라우저에서 캐릭터/채팅을 전환하면서 여러 응답을 동시에 생성. 다중 기기 접속도 가능하면 구현.

**현재 상태**:
- `activeChatJobs` (프론트): `Map<string, ChatJobInfo>` — `charId:chatPage` 키로 관리
- `activeJobs` (서버): `Map<string, ChatJob>` — 여러 Job 동시 가능
- `__risu_active_server_jobs` (localStorage): 멀티 Job 추적 이미 구현
- `initServerChatRecovery()`에서 `Promise.allSettled()`로 병렬 복구 이미 구현

**이미 완료된 사항** (Phase 2에서 구현):
- ✅ `activeChatJobs` Map — `charId:chatPage` 키로 멀티 Job 추적
- ✅ `registerChatJob()` / `unregisterChatJob()` — 개별 Job 등록/해제
- ✅ `isChatGenerating(charId, chatPage)` — 특정 채팅의 생성 상태 확인
- ✅ 캐릭터 전환 시 abort 안 됨 — `lastCharId`는 reroll 상태용, Job 제어 아님
- ✅ 각 Job에 독립 AbortController — 개별 취소 가능
- ✅ streaming loop가 캡처된 참조(`charRef`, `getChatRef`)로 올바른 slot에 기록
- ✅ `doingChat`은 "any job active" 플래그로 역할 변경 (Phase 2)
- ✅ 서버 `activeJobs` Map — 복수 Job 동시 처리
- ✅ `initServerChatRecovery()` — `Promise.allSettled()`로 병렬 복구

**남은 작업 (UI/UX)**:
1. **채팅별 로딩 인디케이터**: `isChatGenerating()` 기반 per-chat 로딩 표시 (현재 전역 로딩바)
2. **다중 기기 동기화**: 서버 DB를 여러 클라이언트가 폴링하여 동기화
3. **캐릭터 전환 시 완료 Job 감지**: 다른 캐릭터 보는 중 완료된 Job을 표시

---

## 4. 핵심 파일 참조

### 서버 (server/node/)

| 파일 | 역할 | 줄수 | 상태 |
|------|------|------|------|
| `server.cjs` | Express 메인, `/proxy2` 리버스 프록시 + TEE Job 통합 | ~580 | ✅ 수정됨 |
| `chatEngine.cjs` | 백그라운드 Job 시스템, SSE 스트리밍, DB 저장, Job 영속성 | ~918 | ✅ 수정됨 |
| `promptBuilder.cjs` | 서버측 프롬프트 조합 | ~300 | ⚠️ moduleLorebooks TODO |
| `serverParser.cjs` | CBS/템플릿 파싱 (프론트 risuChatParser 포트) | ~494 | ✅ |
| `serverCBS.cjs` | CBS 함수 레지스트리 | ~1000 | ✅ |
| `serverCBSUtils.cjs` | CBS 유틸리티 | - | ✅ |
| `serverDbCache.cjs` | DB 캐시 + 5초 디바운스 flush | - | ✅ |
| `serverRisuSave.cjs` | RISUSAVE 포맷 코덱 | - | ✅ |
| `serverLorebook.cjs` | 로어북 엔진 | - | ✅ |
| `serverLuaRuntime.cjs` | Lua 런타임 (wasmoon, optional) | - | ✅ |
| `serverScripts.cjs` | 스크립트/정규식 엔진 | - | ✅ |
| `serverFeatureFlags.cjs` | 기능 플래그 시스템 | - | ✅ |
| `chatArchive.cjs` | 채팅 아카이브 | - | ✅ |
| `inlayServer.cjs` | 인레이/이미지 저장 | - | ✅ |

### 프론트 (src/ts/)

| 파일 | 역할 | 핵심 라인 |
|------|------|-----------|
| `process/serverChat.ts` | 서버 Job 클라이언트, 리커버리 | 전체 (772줄) |
| `process/index.svelte.ts` | sendChat() 메인, 후처리 파이프라인 | 133-2133 |
| `process/request/request.ts` | requestChatData() 디스패치 | 92-448 |
| `process/request/openai.ts` | OpenAI/커스텀 모델 요청 | - |
| `process/triggers.ts` | 트리거 시스템 | 1037-2794 |
| `process/modules.ts` | 모듈 트리거/스크립트/에셋 | 391-450 |
| `process/scripts.ts` | processScriptFull | 136-340 |
| `globalApi.svelte.ts` | globalFetch, fetchNative (proxy 라우팅) | 614-1638 |
| `platform.ts` | isNodeServer 감지 (`globalThis.__NODE__`) | 2 |
| `stores.svelte.ts` | DBState, ReloadGUIPointer, ReloadChatPointer | - |
| `bootstrap.ts` | initServerChatRecovery() 호출 | 252 |
| `storage/database.svelte.ts` | character, Chat, Message 타입 정의 | - |

---

## 5. 아키텍처 상세

### 현재 데이터 흐름

```
[프론트엔드]                                    [서버]
1. sendChat() 시작
2. 프롬프트 빌드 (formatPrompt, HypaV3, 로어북...)
3. requestChatData() → 모델별 함수 호출
4. fetchNative(url, {body, headers})
   → isNodeServer 경로:
     headers 추가: X-Risu-Char-Index, X-Risu-Chat-Page
     fetch('/proxy2', {risu-url, risu-header, body})   ──→  reverseProxyFunc()
                                                            TEE 모드:
                                                            - X-Risu-Char-Index 감지
                                                            - createJob() → jobId
                                                            - fetch(LLM API)
                                                            - 스트림 읽기 + 클라이언트 전달
                                                            - Job에 fullText 축적
                                                            - persistJob()
5. 응답 수신 (raw LLM SSE 형식)                  ←──  X-Risu-Job-Id 헤더 반환
6. 모델별 파서로 처리
7. 스트리밍 루프: message.data 업데이트
8. 후처리: 트리거, 보조 LLM, 감정...
9. 정상 완료: localStorage에서 Job 제거

[새로고침 시]
1. bootstrap.ts → initServerChatRecovery()
2. localStorage.__risu_active_server_jobs 읽기
3. 서버 /api/chat/job/:jobId 폴링
4. done → injectRecoveredResponse() → triggerChatReload() → saveDb()
5. streaming → connectToJobSSE() → 스트리밍 재개
```

### Svelte 반응성 체인 (UI 업데이트)

```
message.data 변경
  → charRef.reloadKeys += 1
  → Chats.svelte $effect() → updateChatBody()
  → Chat 컴포넌트 mount/update
  → ChatBody.svelte markParsing() → ParseMarkdown()
  → {#await} 블록 → HTML 렌더링
```

**핵심**: `reloadKeys`를 증가시켜야 UI가 업데이트됨. 리커버리/서버 업데이트에서 반드시 `triggerChatReload(charIndex)` 호출 필요.

### Job 시스템 상세

**프론트 localStorage**:
```json
// __risu_active_server_jobs
{
  "0:0": { "jobId": "uuid", "charIndex": 0, "chatPage": 0, "time": 1710000000000 },
  "1:2": { "jobId": "uuid2", "charIndex": 1, "chatPage": 2, "time": 1710000001000 }
}
```

**서버 메모리 + 디스크**:
```javascript
// activeJobs Map (메모리)
activeJobs.get(jobId) → {
    id, status, charIndex, chatPage, userMessage, fullText,
    error, createdAt, completedAt, model, listeners: Set<Response>,
    isRaw, rawResponse
}

// save/__active_jobs/{jobId}.json (디스크)
// listeners 제외한 동일 데이터
```

**Job 생명주기**:
```
pending → streaming → saving → done (10분 TTL 후 삭제)
                    ↘ error (10분 TTL 후 삭제)
```

### sendChat() 함수 구조 (index.svelte.ts:133-2133)

```
export async function sendChat(chatProcessIndex, arg):
  ├─ Stage 1 (line 394-1537): 프롬프트 빌드
  │   ├─ formatPrompt()
  │   ├─ lorebook loading (loadLoreBookV3Prompt)
  │   ├─ HypaV3 메모리
  │   ├─ runTrigger('input')
  │   ├─ processScriptFull('editprocess')
  │   └─ 컨텍스트 제한 처리
  │
  ├─ Stage 3 (line 1538-1569): LLM 요청
  │   └─ req = requestChatData({formated, biases, ...})
  │
  ├─ Stage 4a (line 1582-1681): 스트리밍 루프
  │   ├─ while (reader.read())
  │   ├─ processScriptFull('editoutput') [150ms 쓰로틀]
  │   ├─ charRef.reloadKeys += 1
  │   └─ 10청크마다 이벤트 루프 양보
  │
  ├─ Stage 4b (line 1696-2109): 후처리
  │   ├─ runTrigger('output') → resendChat?
  │   ├─ runInlayScreen()
  │   ├─ TTS (프론트 전용)
  │   ├─ auto-continue → 재귀 sendChat()
  │   ├─ IGP 감정 모델 (requestChatData)
  │   ├─ resendChat → 재귀 sendChat()
  │   ├─ 감정 자동 선택 (requestChatData)
  │   └─ stableDiff 이미지 생성
  │
  └─ finally: unregisterChatJob()
```

### 트리거 시스템 (triggers.ts)

```typescript
runTrigger(char, mode, arg) → {
    additonalSysPrompt, chat, tokens, stopSending,
    sendAIprompt,  // true → 재귀 sendChat
    displayData, tempVars
}

// 트리거 소스:
// 1. char.triggerscript (캐릭터 트리거)
// 2. getModuleTriggers() (모듈 트리거)
//    → modules.ts:406-420
//    → 각 모듈의 trigger[] 배열

// 트리거 모드:
// 'start', 'input', 'request', 'output', 'manual', 'display'
```

### 후처리 파이프라인 상세

**1. editoutput 스크립트 (scripts.ts:136)**:
```typescript
processScriptFull(char, data, 'editoutput', chatID)
  → Lua edit trigger
  → Plugin V2 processing
  → risuChatParser (CBS/macros)
  → 프리셋 정규식 (db.presetRegex)
  → 캐릭터 커스텀 스크립트 (char.customscript)
  → 모듈 정규식 (getModuleRegexScripts())
  → 특수 치환: @@emo, @@inject, @@move_top/bottom, @@repeat_back
```

**2. output 트리거 (index.svelte.ts:1698)**:
```typescript
const triggerResult = await runTrigger(currentChar, 'output', { chat: currentChat })
if (triggerResult.sendAIprompt) resendChat = true
if (triggerResult.chat) currentChat = triggerResult.chat
```

**3. Auto-continue (index.svelte.ts:1802-1815)**:
```typescript
if (db.autoContinueMinTokens > 0 && resultTokens < db.autoContinueMinTokens)
    needsAutoContinue = true
if (db.autoContinueChat && !isLastCharPunctuation(result))
    needsAutoContinue = true
if (needsAutoContinue) return await sendChat(..., { continue: true })
```

**4. IGP 감정 (index.svelte.ts:1817-1828)**:
```typescript
const igp = risuChatParser(db.igpPrompt ?? "")
if (igp) {
    const rq = await requestChatData({formated: parseChatML(igp)}, 'emotion', signal)
    chatMsgs[chatMsgs.length - 1].data += rq
}
```

**5. 감정 자동 선택 (index.svelte.ts:1903-2083)**:
- 임베딩 기반: HypaProcessor 유사도 검색
- LLM 기반: requestChatData() → 감정 이름 매칭 → CharEmotion 스토어 업데이트

**6. 이미지 생성 (index.svelte.ts:2090-2108)**:
```typescript
if (currentChar.viewScreen === 'imggen') {
    await stableDiff(currentChar, msgStr)
}
```

---

## 6. 필수 조건

1. **모든 모델의 서버 라우팅**: 커스텀 모델 포함 전체. `isNodeServer === true`일 때 서버 `/api/chat/send` 사용.
2. **서버 빌드(send) 방식**: 프론트는 `charIndex`, `chatPage`, `userMessage`만 전송. 서버가 프롬프트 조합, API 선택, 요청 전송 전부 처리.
3. **서버측 후처리 파이프라인 완전 이식**: `editoutput` 스크립트 → `output` 트리거 → 보조 LLM → auto-continue → 이미지 생성까지 서버에서 실행.
4. **단일 탭 병렬 응답**: 캐릭터 A 응답 중 → B 전환 → B 응답 생성 → 각각 올바른 위치에 저장.
5. **프론트 전용 기능 분리**: TTS/알림은 프론트, 감정/이미지 결과는 서버 저장 → 프론트 표시.
6. **기존 프론트 모드 보존**: `isNodeServer === false`(Tauri/Web)에서 기존 동작 완전 유지.

## 7. 금지 사항

1. **프론트 전용 코드 경로 파괴 금지**: `isNodeServer === false` 환경의 기존 동작 변경 금지.
2. **서버 Job의 인메모리 전용 저장 금지**: 디스크 persist 필수 (이미 구현됨).
3. **동기적 LLM 요청 금지**: 모든 LLM 요청은 비동기 Job으로 실행.

## 8. 검증 기준

1. **기본**: `isNodeServer` 환경 채팅 → 서버 프롬프트 조합 → LLM 응답 → 후처리 → DB 저장 → 프론트 표시
2. **리커버리**: 스트리밍 중 F5 → 진행 중인 응답 복구
3. **프론트 없는 완수**: 브라우저 종료 → 서버가 전체 완수 → 재접속 시 확인
4. **트리거 체인**: 모듈 output 트리거 `sendAIprompt=true` → 서버에서 추가 LLM → DB 저장
5. **병렬**: A 응답 중 B 전환 → B 응답 → 둘 다 올바른 위치에 저장
6. **기존 호환**: `isNodeServer === false` 정상 작동

## 9. 작업 우선순위 권장

1. **Phase 3 준비**: `promptBuilder.cjs`를 프론트의 `formatPrompt()` 수준으로 완성
2. **Phase 3 구현**: `sendChat()`에 `isNodeServer` → `/api/chat/send` 경로 추가
3. **Phase 4 점진적**: 후처리 항목을 하나씩 서버로 이동 (editoutput → output 트리거 → auto-continue → 보조 LLM)
4. **Phase 5**: 병렬 Job 지원 (UI 변경 포함)

## 10. 관련 스킬/도구

| 스킬 | 용도 |
|------|------|
| `risuai-prompt-pipeline` | 프롬프트 처리 파이프라인 레퍼런스 |
| `risuai-trigger` | 트리거 시스템 레퍼런스 |
| `risuai-lua-api` | Lua API 레퍼런스 |
| `risuai-regex` | 정규식 시스템 레퍼런스 |
| `risuai-cbs` | CBS 문법 레퍼런스 |
| `risuai-module-dev` | 모듈 개발 레퍼런스 |
| `risuai-lorebook` | 로어북 시스템 레퍼런스 |
| `risuai-lightboard` | 라이트보드 프레임워크 레퍼런스 |
| `session-handoff` | 세션 인수인계 프로토콜 |
