# Session Handoff — RisuAI Server Pipeline

> 최종 갱신: 2026-03-31 KST | v2026.3.330 rebase + 누락 패치 재적용 완료 (Phase 1-4)

## 프로젝트 개요

- **프로젝트명**: RisuAI Server-Stream Pipeline
- **한줄 요약**: RisuAI 서버 배포판. 프론트는 프롬프트 빌드만, 서버가 LLM 요청/저장/후처리 전담. 다중 기기 동기화 예정.
- **기술 스택**: Svelte 5 + TypeScript + Vite (프론트), Node.js + Express (서버 `server/node/`)
- **브랜치**: `server-stream-v2` (로컬) → `server-stream` (fork remote)
- **base**: v2026.3.330 (업스트림 kwaroran/RisuAI)
- **배포**:
```bash
cd g:/Antigravity/RisuAI/Risuai_Latest
git push fork server-stream-v2:server-stream --force
ssh -i C:/SSH/Oracle_RisuAI_SSH.key ubuntu@134.185.114.135 \
  "cd ~/Risu-AI/RisuAI && git fetch origin server-stream && git checkout origin/server-stream -- <files> && pnpm run build && pm2 restart risu"
```

## 현재 진행 상태

### 이번 세션 완료 작업

- [x] **v2026.3.330 rebase** — clean rebase, 신규 CJS 16개 + 프론트 5개 복사
- [x] **Copilot 할당량 번들링** — X-Agent-Task-Id, X-Initiator, X-Interaction-Id 헤더 (anthropic.ts + openAI/requests.ts)
- [x] **Copilot 호환성 패치** — Bearer auth, anthropic-version 삭제, beta 스킵, prefill strip
- [x] **서버 CJS 라우트 등록** — chatEngine, chatArchive, inlayServer (JWT 구조 위에)
- [x] **compression 미들웨어** — gzip 응답 압축
- [x] **cleanChunks 스킵** — isNodeServer에서 부팅 가속
- [x] **globalApi compression** — isNodeServer에서 RisuSave gzip 활성화
- [x] **인레이 IndexedDB 캐시** — NodeInlayStorage read-through
- [x] **chatArchive 비활성화** — auto-archive 데이터 오염 방지
- [x] **serverRisuSave 블록 타입** — PLUGINS(9), LOADOUTS(10), PLUGIN_STORAGE(11) 추가
- [x] **rate limit 600/분** — 업스트림 90→600
- [x] **JWT 만료 30분** — 5분→30분 (tool call 타임아웃 방지)
- [x] **fetchNative proxy2 라우팅** — isNodeServer에서 throughProxy=true 강제
- [x] **스트리밍 tool_use 처리** — Anthropic SSE에서 tool_use 블록 수집 + tool 실행 + 스트리밍 재귀
- [x] **모듈/플러그인 복원** — 구 DB에서 remote 모듈 57개 + 플러그인 11개 병합

### 이번 세션 완료 (2026-03-31 #2)

- [x] **Phase 1: server.cjs TEE 보완**
  - `activeStreamState` 전역 추적 (모델, 청크 수, 클라이언트 연결)
  - `GET /api/chat/recovery` — 프론트 재접속시 미완료 응답 확인
  - `GET /api/chat/streaming-status` — 스트리밍 진행 상태 폴링
  - `DELETE /api/chat/recovery` — 복구 데이터 삭제
  - serverDbCache invalidation 복원 (`/api/write`)
  - serverImageJob 라우트 등록
  - SIGTERM/SIGINT graceful shutdown 훅
- [x] **Phase 2: index.svelte.ts 서버 분기**
  - `forageStorage` + `isNodeServer` import
  - `ChatJobInfo` + `activeChatJobs` per-chat 생성 추적 (그룹챗 병렬 지원)
  - `registerChatJob`/`unregisterChatJob` 생명주기 관리
  - `doingChat.set(false)` → `unregisterChatJob(jobKey)` 교체 (4곳)
  - try-finally 감싸기 — 모든 exit path 보장
  - Plugin stream recovery (isNodeServer: localStorage + forageStorage 저장/정리)
- [x] **Phase 3: 나머지 필수 파일**
  - `stableDiff.ts` — `isNodeServer` + `serverAsyncFetch` import, `globalFetch` → `imgFetch` 조건분기 (11곳)
  - `database.svelte.ts` — togglePresets 스킵 (upstream Loadout 대체)
  - `request.ts` — 커스텀 패치 없음, 스킵
- [x] **Phase 4: 성능 패치**
  - `scripts.ts` — compiledRegexCache (500 LRU) + 조건부 CBS 파싱
  - `parser.svelte.ts` — blob URL 캐시 LRU (200개) + revokeObjectURL + lazy loading
  - `Chats.svelte` — 스트리밍 flicker fix 스킵 (upstream Svelte 5 충돌 위험)
- [x] **Anthropic 스트리밍 tool continuation 개선** (anthropic.ts)
  - `redacted_thinking` 블록 추적 추가
  - 인라인 continuation → 재귀 `requestClaudeHTTP` 호출로 교체
  - thinking 태그 미닫힘 수정

### 미완료 — 다음 세션 필수

- [ ] **[P0] Phase 5: 빌드 + 배포 + 테스트** — 서버에서 빌드/배포 필요
- [ ] **[P0] 스트리밍 tool_use thinking 블록 실제 검증** — Copilot API로 MCP 호출 테스트
- [ ] **[P1] WS 다중 기기 동기화** — 이전에 롤백됨. 처음부터 재설계 필요.
- [ ] **[P2] 인레이 캐시 최적화** — 업스트림 inlays.ts 구조 변경으로 재검토
- [ ] **[P2] Chats.svelte 스트리밍 flicker fix** — upstream Svelte 5 렌더링과 호환성 확인 후 적용

## 핵심 아키텍처 (목표 상태)

```
프론트: requestChatData() → 프롬프트 빌드
  → fetchNative() → /proxy2 (X-Risu-Char-Index 헤더)
  → 서버 proxy2: LLM fetch + TEE 캡처
    → 프론트에 스트리밍 미러링 (화면 표시용)
    → 서버: 전체 응답 캡처 → 후처리 → DB 저장
  → 프론트 꺼져도 서버가 완료 처리
```

**현재 상태**: TEE 캡처 완료. recovery 엔드포인트 + activeStreamState 추적 완료. 빌드/배포 대기.

## 핵심 의사결정 로그

| 결정 | 이유 |
|------|------|
| v2026.3.330 clean rebase | git rebase 불가 (97파일 충돌). 신규 파일 복사 + 패치 수동 재적용 |
| Copilot X-Agent-Task-Id | VSCode Copilot 확장 리버스 엔지니어링으로 발견. tool call loop을 1 요청으로 번들링 |
| fetchNative throughProxy=true | 업스트림이 isNodeServer에서 직접 fetch하도록 변경했지만, 우리는 서버 proxy2 필수 |
| JWT 30분 만료 | tool call 재귀가 5분 초과 가능 |
| 스트리밍 tool_use 처리 | 비스트리밍 재귀 시 proxy2 타임아웃/chunked encoding 에러 |
| 모듈 lazy-loading 제거 | v2026.3.330과 비호환. 모듈을 DB 인라인으로 복원 |
| TogglePresetManager 제거 | 업스트림 Loadout 시스템으로 대체 |

## 파일 위치

### 서버 CJS (server/node/)

| 파일 | 역할 | 상태 |
|------|------|------|
| `server.cjs` | Express + JWT + proxy2 + TEE + recovery API | ✅ 패치됨 |
| `chatEngine.cjs` | Job 시스템, SSE, saveJobResponse | ✅ 복사됨 |
| `chatArchive.cjs` | 채팅 아카이브 (비활성화) | ✅ 복사됨 |
| `inlayServer.cjs` | 인레이 CRUD API | ✅ 복사됨 |
| `serverRisuSave.cjs` | RISUSAVE 코덱 (블록 9/10/11 추가) | ✅ 패치됨 |
| `promptBuilder.cjs` | 서버 프롬프트 빌더 (미사용) | ✅ 복사됨 |
| 기타 10개 CJS | CBS, Lorebook, Lua, Scripts 등 | ✅ 복사됨 |

### 프론트 (src/ts/)

| 파일 | 역할 | 상태 |
|------|------|------|
| `process/request/anthropic.ts` | Copilot 헤더 + 스트리밍 tool_use + 재귀 continuation | ✅ 패치됨 |
| `process/request/openAI/requests.ts` | Copilot 헤더 | ✅ 패치됨 |
| `process/index.svelte.ts` | activeChatJobs + plugin stream recovery | ✅ 패치됨 |
| `process/stableDiff.ts` | isNodeServer + serverAsyncFetch 분기 | ✅ 패치됨 |
| `process/scripts.ts` | regex 캐시 + 조건부 CBS 파싱 | ✅ 패치됨 |
| `parser/parser.svelte.ts` | blob URL 캐시 LRU + revocation | ✅ 패치됨 |
| `globalApi.svelte.ts` | proxy2 라우팅 + compression | ✅ 패치됨 |
| `bootstrap.ts` | cleanChunks 스킵 | ✅ 패치됨 |
| `storage/nodeStorage.ts` | JWT 30분 만료 | ✅ 패치됨 |
| `storage/risuSave.ts` | 업스트림 그대로 (lazy-loading 제거) | ✅ |
| `process/files/inlays.ts` | NodeInlayStorage + IndexedDB 캐시 | ✅ 패치됨 |
| `process/serverChat.ts` | WS 동기화 (미사용) | ✅ 복사됨 |

### 참고 문서

| 파일 | 용도 |
|------|------|
| `_Inbox/REBASE_ANALYSIS.md` | v2026.3.330 rebase 전체 분석 |
| `_Inbox/Copilot_MCP_Quota_Fix.md` | Copilot MCP 할당량 패치 가이드 |

## 환경 노트

- CJS 파일만 변경 시 빌드 없이 `pm2 restart risu`만으로 적용
- TS 변경 시 `pnpm run build` 필요 (~2분)
- restic 10분 간격 백업: `RESTIC_PASSWORD_FILE=~/.restic_pass restic -r ~/restic-repo snapshots`
- `compression` 패키지 서버에 설치됨 (`pnpm add compression`)
- 서버 Oracle Cloud `134.185.114.135:6001`
- MCP 서버: `pm2 list` → `korean-rerender-mcp` (localhost:3001)
