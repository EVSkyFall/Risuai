# 🎯 Mission: 인터랙션 메시지 생성 후 해당 메시지로 가는 UX 경로 최소화

## 배경

RisuAI는 AI 대화형 앱이다. "라이트보드(Lightboard)"는 RisuAI의 모듈 시스템으로, 커스텀 UI(SNS 시뮬레이션 등)를 채팅 메시지 내에 렌더링한다.

### 현재 인터랙션 흐름
1. 사용자가 SNS 포스트의 댓글 버튼 클릭 (예: Reply)
2. 라이트보드가 "인터랙션" two-step flow 실행: 기존 데이터 보존(preserve) + 사용자 방향 입력
3. LLM이 새 댓글이 포함된 결과 생성 → **최신 채팅 메시지의 LBDATA에 저장**
4. `editDisplay` 콜백에서 `renderSNS()` 호출 → 렌더링된 SNS 카드가 팝오버(`<dialog popover>`) 안에 배치
5. 사용자가 해당 팝오버를 **수동으로 찾아서 열어야** 방금 단 댓글을 확인 가능

### 문제
- 인터랙션 결과는 **가장 최근 채팅 메시지**에 렌더링됨
- 채팅이 길면 해당 메시지를 찾기 어려움
- 현재는 `[SNS]` 버튼 → 팝오버 클릭이라는 2단계가 필요

### 이전 실패한 접근 (참고용)
- `<details open>` 인라인 펼침 시도 → h DSL의 nil hole 문제로 기존 팝오버까지 깨짐
- `editCurrentDisplay`는 팝오버를 파괴하므로 사용 불가
- RisuAI 내부에서 `<script>` 태그는 차단됨 (JavaScript 직접 실행 불가)

## 당신이 해야 할 일

RisuAI 소스 코드를 분석하여, 모듈(Lightboard)이 활용할 수 있는 **구현 가능한 방안**을 찾아라:

1. **RisuAI의 채팅 렌더링 파이프라인 분석** — `src/` 디렉토리에서 채팅 메시지가 어떻게 렌더링되는지 파악
   - 특히 `editDisplay` 콜백이 반환한 HTML이 DOM에 어떻게 삽입되는지
   - popover/dialog가 어떻게 핸들링되는지
   - 메시지 간 스크롤이 어떻게 동작하는지 (자동 스크롤 등)

2. **모듈이 사용할 수 있는 API 확인** — 트리거 스크립트에서 호출 가능한 RisuAI API 중 UI 네비게이션에 쓸 수 있는 것
   - `scrollToMessage`, `focusMessage` 같은 API가 있는지
   - `popover.showPopover()` 같은 것을 트리거할 수 있는 메커니즘이 있는지
   - CSS만으로 popover를 자동으로 열 수 있는 방법이 있는지

3. **인터랙션 시스템의 후처리 확인** — Lightboard가 인터랙션 완료 후 어떤 동작을 하는지
   - `risu-btn`의 `lb-interaction__` 핸들러가 완료된 후 스크롤이나 포커스를 트리거하는지
   - 인터랙션 결과가 어디에 삽입되는지 (마지막 메시지? 새 메시지?)

### 📂 중요한 소스 파일/디렉토리

- `src/ts/process/` — 채팅 처리 파이프라인 (sendChat, display 등)
- `src/svelte/` — Svelte 컴포넌트 (채팅 UI, 메시지 렌더링)
- `src/ts/plugins/` — 플러그인/모듈 시스템 (트리거, 로어북 등)
- `plugins.md` — 플러그인 API 문서

### 📂 참고할 스킬 문서 (절대 경로)

- `C:/Users/Cardinal/.gemini/antigravity/skills/risuai-lightboard/SKILL.md` — Lightboard 아키텍처
- `C:/Users/Cardinal/.gemini/antigravity/skills/risuai-trigger/SKILL.md` — 트리거 시스템
- `C:/Users/Cardinal/.gemini/antigravity/skills/risuai-lua-api/SKILL.md` — Lua API 레퍼런스
- `C:/Users/Cardinal/.gemini/antigravity/skills/risuai-css/SKILL.md` — CSS 시스템

### 🎯 원하는 출력

각 아이디어에 대해:
- **개요**: 한 줄 요약
- **기술적 근거**: RisuAI 소스 코드에서 찾은 구체적인 코드 경로/API/메커니즘
- **구현 난이도**: 모듈 측에서만 가능한지, RisuAI 코어 수정이 필요한지
- **실현 가능성**: 높음/중간/낮음 + 이유
