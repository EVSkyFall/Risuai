# GitHub Copilot MCP Tool Call 할당량 최적화 패치

## 문제
RisuAI에서 GitHub Copilot API로 MCP tool call을 사용하면, 매 tool call마다 독립 요청으로 카운트되어 할당량이 과다 차감됨.

**예시 (Opus 4.6, 배율 3x):**
- 수정 전: 1회 대화 + MCP 2회 = 요청 3회 × 3배율 = **9 차감**
- 수정 후: 1회 대화 + MCP 2회 = 요청 1회 × 3배율 = **3 차감**

---

## 수정 방법

### 1단계: 커스텀 모델 설정

추가 파라미터에 한 줄 추가:
```
header::Copilot-Integration-Id=vscode-chat
```

### 2단계: 소스 코드 수정 (2개 파일)

#### 파일 1: `src/ts/process/request/anthropic.ts`

`requestClaudeHTTP` 함수 **바로 위**에 다음 코드를 추가:

```typescript
import { v4 } from "uuid"  // 파일 상단에 이미 있으면 스킵

function isCopilotURL(url: string): boolean {
    return url.includes('githubcopilot.com') || url.includes('copilot')
}

let _copilotInteractionId: string | null = null
function getCopilotInteractionId(): string {
    if (!_copilotInteractionId) _copilotInteractionId = v4()
    return _copilotInteractionId
}

function applyCopilotTaskHeaders(headers: { [key: string]: string }, url: string, taskId?: string, isContinuation = false): string | undefined {
    if (!isCopilotURL(url)) return taskId
    const id = taskId ?? v4()
    headers['X-Request-Id'] = id
    headers['X-Agent-Task-Id'] = id
    headers['X-Interaction-Id'] = getCopilotInteractionId()
    headers['X-Initiator'] = isContinuation ? 'agent' : 'user'
    headers['OpenAI-Intent'] = 'conversation-panel'
    headers['X-GitHub-Api-Version'] = '2025-05-01'
    if (url.includes('/v1/messages')) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20'
    }
    return id
}
```

`requestClaudeHTTP` 함수 시그니처에 `copilotTaskId` 파라미터 추가:

```diff
- async function requestClaudeHTTP(replacerURL: string, headers: { [key: string]: string }, body: any, arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
+ async function requestClaudeHTTP(replacerURL: string, headers: { [key: string]: string }, body: any, arg: RequestDataArgumentExtended, copilotTaskId?: string): Promise<requestDataResponse> {
+
+     const isContinuation = copilotTaskId !== undefined
+     copilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, isContinuation)
```

tool call 재귀 호출 (함수 내 `return requestClaudeHTTP(...)` 부분)에 `copilotTaskId` 전달:

```diff
- return requestClaudeHTTP(replacerURL, headers, body, arg)
+ return requestClaudeHTTP(replacerURL, headers, body, arg, copilotTaskId)
```

---

#### 파일 2: `src/ts/process/request/openAI.ts`

import 추가 (파일 상단):
```typescript
import { v4 } from "uuid";
```

`requestHTTPOpenAI` 함수 **바로 위**에 동일한 헬퍼 함수 추가:

```typescript
function isCopilotURL(url: string): boolean {
    return url.includes('githubcopilot.com') || url.includes('copilot')
}

let _copilotInteractionId: string | null = null
function getCopilotInteractionId(): string {
    if (!_copilotInteractionId) _copilotInteractionId = v4()
    return _copilotInteractionId
}

function applyCopilotTaskHeaders(headers: Record<string, string>, url: string, taskId?: string, isContinuation = false): string | undefined {
    if (!isCopilotURL(url)) return taskId
    const id = taskId ?? v4()
    headers['X-Request-Id'] = id
    headers['X-Agent-Task-Id'] = id
    headers['X-Interaction-Id'] = getCopilotInteractionId()
    headers['X-Initiator'] = isContinuation ? 'agent' : 'user'
    headers['OpenAI-Intent'] = 'conversation-panel'
    headers['X-GitHub-Api-Version'] = '2025-05-01'
    return id
}
```

`requestHTTPOpenAI` 함수 시그니처에 `copilotTaskId` 파라미터 추가:

```diff
- export async function requestHTTPOpenAI(replacerURL:string, body:any, headers:Record<string,string>, arg:RequestDataArgumentExtended): Promise<requestDataResponse> {
+ export async function requestHTTPOpenAI(replacerURL:string, body:any, headers:Record<string,string>, arg:RequestDataArgumentExtended, copilotTaskId?: string): Promise<requestDataResponse> {
+
+     const isContinuation = copilotTaskId !== undefined
+     copilotTaskId = applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, isContinuation)
```

tool call 재귀 호출 **2곳** 모두 수정:

**비스트리밍** (함수 내 `resRec = await requestHTTPOpenAI(...)` 부분):
```diff
- resRec = await requestHTTPOpenAI(replacerURL, body, headers, arg)
+ resRec = await requestHTTPOpenAI(replacerURL, body, headers, arg, copilotTaskId)
```

**스트리밍** (함수 내 `fetchNative(replacerURL, ...)` 호출 직전):
```diff
+ // Reapply Copilot task headers for tool continuation (same taskId)
+ applyCopilotTaskHeaders(headers, replacerURL, copilotTaskId, true)
+
  resRec = await fetchNative(replacerURL, {
```

### 3단계: 빌드

```bash
pnpm run build
```

---

## 작동 원리

Copilot 서버는 `X-Agent-Task-Id`가 동일한 연속 요청을 하나의 "turn"으로 인식합니다.

```
Turn 시작: taskId = 새 UUID 생성
  1차 요청: X-Agent-Task-Id=taskId, X-Initiator=user     ← 할당량 1회 차감
  → LLM이 tool_use 반환
  → tool 실행
  2차 요청: X-Agent-Task-Id=taskId, X-Initiator=agent    ← 차감 없음 (같은 turn)
  → LLM이 tool_use 반환
  → tool 실행
  3차 요청: X-Agent-Task-Id=taskId, X-Initiator=agent    ← 차감 없음 (같은 turn)
  → 최종 응답
```

## 필수 헤더 요약

| 헤더 | 값 | 비고 |
|------|-----|------|
| `Copilot-Integration-Id` | `vscode-chat` | 추가 파라미터로 설정 |
| `X-Agent-Task-Id` | UUID | tool loop 전체 동일 |
| `X-Request-Id` | UUID | Agent-Task-Id와 동일 |
| `X-Initiator` | `user` / `agent` | 첫 요청 vs continuation |
| `X-Interaction-Id` | UUID | 세션 고유 |
| `OpenAI-Intent` | `conversation-panel` | 요청 유형 |
| `X-GitHub-Api-Version` | `2025-05-01` | API 버전 |
| `anthropic-beta` | (복수 값) | Claude 모델 전용 |
