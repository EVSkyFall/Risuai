# Server-Stream 브랜치 분석 — v2026.2.241 base → v2026.3.330 rebase 계획

> 분석일: 2026-03-31 | 97파일, +19,030 / -6,121줄 (52 커밋)

---

## 1. 우리 브랜치 커스텀 패치 전체 목록

### A. 서버 CJS 파이프라인 (신규 파일 — 충돌 없음)

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `server/node/chatEngine.cjs` | 806 | Job 시스템, SSE, saveJobResponse, proxy2 TEE |
| `server/node/chatArchive.cjs` | 207 | 채팅 아카이브 (현재 checkAndArchive 비활성화) |
| `server/node/inlayServer.cjs` | 363 | 인레이 CRUD API |
| `server/node/promptBuilder.cjs` | 315 | 서버 프롬프트 빌더 (현재 미사용 — 하이브리드 전환) |
| `server/node/serverCBS.cjs` | 655 | CBS 조건부 블록 처리 |
| `server/node/serverCBSUtils.cjs` | 262 | CBS 유틸리티 |
| `server/node/serverLorebook.cjs` | 433 | 로어북 엔진 |
| `server/node/serverLuaRuntime.cjs` | 502 | Lua 런타임 (wasmoon) |
| `server/node/serverParser.cjs` | 493 | CBS/템플릿 파싱 |
| `server/node/serverRisuSave.cjs` | 427 | RISUSAVE 코덱 |
| `server/node/serverScripts.cjs` | 220 | 정규식/스크립트 엔진 |
| `server/node/serverDbCache.cjs` | 114 | DB 캐시 (5초 디바운스) |
| `server/node/serverFeatureFlags.cjs` | 134 | 기능 플래그 (useServerChat) |
| `server/node/serverImageJob.cjs` | 179 | NovelAI/ComfyUI 비동기 이미지 큐 |
| `server/node/lua/json.lua` | 388 | Lua JSON 라이브러리 |
| `server/node/server-config.json` | 3 | 서버 설정 파일 |

**총 5,501줄 신규 CJS** — 전부 새 파일이므로 rebase 시 충돌 없음. 그대로 가져감.

### B. server.cjs 수정 (+502 / -81)

| 변경 | 설명 |
|------|------|
| proxy2 TEE 캡처 | 스트리밍 요청을 chatEngine job으로 캡처 |
| WS 동기화 (현재 미사용) | WebSocket 기반 다중 기기 동기화 — 롤백됨 |
| 인레이 라우트 등록 | `registerInlayRoutes(app, password)` |
| chatEngine 라우트 등록 | `/api/chat/*`, `/api/job/*` |
| chatArchive 라우트 등록 | `/api/chat/archive/*` |
| DB 캐시 통합 | `serverDbCache.cjs` 연동 |
| compression 미들웨어 | gzip 응답 압축 (try/catch) |
| notifyDbChange | WS 브로드캐스트 (charVersion 추적) |

**충돌 위험: 높음** — 업스트림이 JWT 인증으로 전환. 우리 라우트 등록 코드를 새 인증 체계에 맞춰 재작성 필요.

### C. 프론트엔드 — Copilot 할당량 번들링 (이번 세션)

| 파일 | 변경 | 핵심 |
|------|------|------|
| `src/ts/process/request/anthropic.ts` | +50줄 | `applyCopilotTaskHeaders()`, `requestClaudeHTTP` copilotTaskId 파라미터 |
| `src/ts/process/request/openAI.ts` | +40줄 | 동일 패턴, 비스트리밍/스트리밍 양쪽 |

**충돌 위험: 높음** — 업스트림에서 `openAI.ts`가 `openAI/` 디렉토리로 분리됨. `anthropic.ts`도 대규모 리팩토링.

### D. 프론트엔드 — Anthropic/Copilot 호환성 (이전 세션)

| 커밋 | 파일 | 변경 |
|------|------|------|
| `5cd377d0` | `anthropic.ts` | reverse_proxy Claude thinking 플래그 자동 주입 |
| `6af90fa9` | `anthropic.ts` | xcustom 모델에도 thinking 플래그 |
| `38902d14` | `anthropic.ts` | reverse_proxy/xcustom thinking mode UI |
| `c0899aaa` | `anthropic.ts` | reverse_proxy/xcustom Bearer auth 헤더 |
| `cdacdea9` | `anthropic.ts` | reverse_proxy/xcustom anthropic-beta 스킵 |
| `430935f3` | `anthropic.ts` | reverse_proxy/xcustom prefill + anthropic-version 스트립 |

**충돌 위험: 높음** — 전부 `anthropic.ts`에 집중. 업스트림 리팩토링과 충돌.

### E. 프론트엔드 — 성능 최적화 (이전 세션)

| 커밋 | 파일 | 변경 |
|------|------|------|
| `e3342e0f` | `parser.svelte.ts` | ParseMarkdown 캐시 + fast hash |
| `689fb724` | `scripts.ts`, `index.svelte.ts` | regex 캐시, script version hash |
| `75ff643a` | `scripts.ts` | 조건부 risuChatParser 스킵 |
| `b875ee6d` | — | rAF throttle revert |
| `80e7f3e9` | `index.svelte.ts` | Display Edit regex flicker 수정 |
| `95e71462` | `index.svelte.ts` | blob URL 캐시 200개 |

**충돌 위험: 중간** — `index.svelte.ts`, `parser.svelte.ts`, `scripts.ts` 모두 업스트림에서 변경됨.

### F. 프론트엔드 — 서버 채팅 파이프라인 (신규 파일)

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `src/ts/process/serverChat.ts` | 741 | WS 동기화, recovery, fetchAndMergeChar |
| `src/ts/chat/chatArchiveClient.ts` | 122 | 아카이브 API 클라이언트 |
| `src/ts/chat/serverJobClient.ts` | 190 | 서버 Job API 클라이언트 |
| `src/ts/process/files/inlayMeta.ts` | 156 | 인레이 메타데이터 |
| `src/ts/process/files/inlaysServer.ts` | 176 | 인레이 서버 API |

**충돌 위험: 없음** — 신규 파일.

### G. 프론트엔드 — 인레이 시스템 확장

| 파일 | 변경 | 핵심 |
|------|------|------|
| `src/ts/process/files/inlays.ts` | +596줄 | NodeInlayStorage, IndexedDB 캐시, 마이그레이션 |
| `src/ts/process/index.svelte.ts` | 대폭 수정 | isNodeServer 분기, 인레이 처리, 서버 채팅 |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | +1822줄 | 아카이브 lazy-loading, 인레이 미리보기 |
| `src/lib/SideBars/CharConfig.svelte` | +2426줄 | 인레이 관리 UI |

**충돌 위험: 높음** — 업스트림에서도 이 파일들을 수정함.

### H. 프론트엔드 — 기타 패치

| 커밋 | 파일 | 변경 |
|------|------|------|
| `ce158ca8` | TogglePresetManager.svelte | 토글 프리셋 매니저 (PTM) |
| `2dd4e1d7` | index.svelte.ts | 무한 로딩 스피너 방지 |
| `5b57a0ce` | Chats.svelte | reloadKeys 반응성 |
| `fbbbf9a7` | 여러 파일 | v3 보안 변경 revert |
| `2f98affb` | plugins.svelte.ts | 플러그인 텍스트 복구 |
| `e983ea84` | stableDiff.ts | NAI director_reference 빈 배열 제거 |
| `07ca0562` | risuSave.ts, globalApi.svelte.ts | 모듈 lazy-loading |
| `32f6ffd2` | bootstrap.ts | cleanChunks isNodeServer 스킵 |
| `5d368300` | chatArchive.cjs | auto-archive 비활성화 |
| `07ca0562` | inlays.ts | 인레이 IndexedDB read-through 캐시 |

---

## 2. 충돌 매트릭스

| 파일 | 우리 변경 | 업스트림 변경 | 충돌 심각도 |
|------|-----------|--------------|-------------|
| `server/node/server.cjs` | proxy2 TEE, WS, 라우트 등록 | JWT 인증, local-network, 보안 강화 | **Critical** |
| `src/ts/process/request/anthropic.ts` | Copilot 헤더, thinking 플래그, Bearer auth | 대규모 리팩토링 | **Critical** |
| `src/ts/process/request/openAI.ts` | Copilot 헤더 | 파일 삭제 → `openAI/` 디렉토리 분리 | **Critical** |
| `src/ts/process/index.svelte.ts` | isNodeServer 분기, flicker fix, blob cache | 리팩토링 | **High** |
| `src/ts/globalApi.svelte.ts` | compression, cleanChunks 스킵, auto-save | Loadout, 452줄 추가 | **High** |
| `src/ts/storage/risuSave.ts` | 모듈 lazy-loading | 152줄 변경 | **High** |
| `src/ts/bootstrap.ts` | isNodeServer cleanChunks 스킵 | meta file 스킵 추가 | **Low** (유사 변경) |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | 아카이브 UI | 리팩토링 | **Medium** |
| `src/ts/process/scripts.ts` | regex 캐시, 조건부 파싱 | perf 최적화 | **Medium** |
| `src/ts/parser/parser.svelte.ts` | ParseMarkdown 캐시 | 리팩토링 | **Medium** |
| `server/node/*.cjs` (신규 16개) | — | — | **None** |
| `src/ts/process/serverChat.ts` (신규) | — | — | **None** |
| `src/ts/chat/*.ts` (신규 2개) | — | — | **None** |

---

## 3. 패치 분류 — rebase 시 처리 방법

### 가져갈 패치 (필수)

| # | 패치 | 처리 |
|---|------|------|
| 1 | **Copilot 할당량 번들링** | `anthropic.ts` + `openAI/` 새 구조에 재적용 |
| 2 | **Copilot 호환성** (Bearer, thinking, prefill strip) | `anthropic.ts` 새 버전에 재적용 |
| 3 | **서버 CJS 파이프라인** (16개 신규 파일) | 그대로 복사 |
| 4 | **server.cjs 수정** | 새 JWT 구조 위에 재작성 |
| 5 | **인레이 시스템** (IndexedDB 캐시, NodeInlayStorage) | 재적용 |
| 6 | **chatArchive 비활성화** | 재적용 (1줄) |
| 7 | **cleanChunks 스킵** | 업스트림 변경 확인 후 병합 |

### 검토 필요 (업스트림과 중복/충돌 가능)

| # | 패치 | 이유 |
|---|------|------|
| 8 | **성능 최적화** (regex 캐시, ParseMarkdown 캐시) | 업스트림에도 perf 최적화 다수 — 중복 확인 |
| 9 | **blob URL 캐시 200** | 업스트림에서 이미 수정됐을 수 있음 |
| 10 | **Display Edit flicker fix** | 업스트림 index.svelte.ts 리팩토링으로 해결됐을 수 있음 |
| 11 | **v3 보안 revert** (`fbbbf9a7`) | 업스트림에서 보안 강화됨 — revert 불필요할 수 있음 |
| 12 | **모듈 lazy-loading** (`risuSave.ts`) | 업스트림 risuSave 변경과 충돌 — 호환성 확인 |

### 버릴 패치 (불필요/obsolete)

| # | 패치 | 이유 |
|---|------|------|
| 13 | **WS 동기화 코드** (serverChat.ts 일부) | 롤백됨. 나중에 재설계 |
| 14 | **rAF throttle + revert** (`31d771e1` + `b875ee6d`) | 이미 revert됨 |
| 15 | **serverAsyncFetch revert들** (`0b6892b2`, `e45bfa5e`) | 이미 revert됨 |
| 16 | **TogglePresetManager** (`ce158ca8`) | 업스트림에 Loadout 시스템으로 대체 |
| 17 | **promptBuilder.cjs** | 현재 미사용 (하이브리드 전환) — 유지하되 미사용 표시 |

---

## 4. 업스트림 주요 신기능 (가져올 것)

| 기능 | 커밋 | 영향 |
|------|------|------|
| **JWT 인증** | `61996dd2` | server.cjs 인증 체계 전환 |
| **Local Network Mode** | `494f9842` 외 다수 | 로컬 모델 지원 |
| **Loadout 시스템** | `6470e1c4`, `215974e8` | 프리셋 저장/로드 |
| **Cold storage 버그 수정** | `6e1ddaa0`, `9a59d483` | 채팅 데이터 손실 방지 |
| **Plugin V3 강화** | CSP, IPC, sendChat API | 플러그인 보안+기능 |
| **gpt-5.4 모델** | `1bd4a9cb` | 모델 추가 |
| **Settings 리팩토링** | `12793b0d` | Component Registry |
| **HypaV3 개선** | `4997f2d7` | queryChatCount |
| **OpenRouter UI** | `2fda52e4` | 모델 그리드 |
| **보안 강화** | rate limit, SSRF 방어 | 서버 보안 |
| **perf 최적화** | 배열 최적화, stream transform | 성능 |
| **openAI.ts 분리** | 타입 분리, 코드 정리 | 구조 개선 |
