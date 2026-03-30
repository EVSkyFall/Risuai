# Brainstorm v2: # 🎯 Mission: 인터랙션 메시지 생성 후 해당 메시지로 가는 UX 경로 최소화

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


**Personas:** DOM Hacker, Core Architect, UX Purist, Contrarian Simplifier
**Axes:** feasibility, ux-impact, implementation-difficulty

## Personas

### DOM Hacker (p1)
- **Background:** Expert in browser DOM manipulation, MutationObservers, and Svelte internals.
- **Thinking Style:** Pragmatic, workaround-oriented, looks for client-side tricks.
- **Golden Question:** Can we use CSS :has() or a MutationObserver injected via Lua/Trigger to automatically open the popover when new LBDATA renders?
- **Blind Spot:** Ignores clean architectural boundaries; workarounds might break in future RisuAI updates.

### Core Architect (p2)
- **Background:** Deep understanding of RisuAI's Svelte lifecycle, plugin system, and chat rendering pipeline.
- **Thinking Style:** Systematic, prefers API-level solutions and clean data flow.
- **Golden Question:** What is the official plugin API for scrolling and focusing, and can we extend editDisplay to emit an event that triggers popover.showPopover() natively?
- **Blind Spot:** Overcomplicates things by demanding engine-level changes instead of using existing tools.

### UX Purist (p3)
- **Background:** Specializes in user flow, interaction design, and seamless transitions.
- **Thinking Style:** User-centric, focuses on the psychological friction of extra clicks.
- **Golden Question:** Instead of a popover, can the interaction result be rendered inline dynamically, or can we auto-scroll the user directly to the new message without them losing context?
- **Blind Spot:** May propose designs that are technically impossible within the current Lightboard HTML-only constraints.

### Contrarian Simplifier (p4)
- **Background:** Minimalist developer who hates over-engineering and loves CSS-only or state-machine solutions.
- **Thinking Style:** Reductive, challenges the premise of the problem.
- **Golden Question:** Why use a popover at all? Can we just use CSS anchor positioning or a pure CSS state hack (like hidden checkboxes or target pseudo-classes) to keep the interaction visible?
- **Blind Spot:** Might sacrifice visual fidelity or advanced functionality for the sake of simplicity.

---

## Top Picks & Patterns

[
  {
    "id": "task-1",
    "title": "Analyze Chat Pipeline & Svelte Lifecycle",
    "assigned_to": "researcher",
    "depends_on": [],
    "description": "Analyze src/ts/process/ and core Svelte components to identify the optimal insertion point for a 'Deferred UI Action Queue' (cross_p5_4). Evaluate how to safely trigger scrollIntoView and popover UI actions after the Svelte DOM update cycle guarantees node readiness.",
    "priority": "high"
  },
  {
    "id": "task-2",
    "title": "Implement Lua Navigation API & Deferred Action Queue",
    "assigned_to": "implementer",
    "depends_on": ["task-1"],
    "description": "Expand the RisuAI Lua API (cross_p5_3) to include official navigation commands (e.g., `risu.ui.focusMessage`). Update the trigger system and core chat engine to push these commands into a Deferred UI Action Queue, executing them natively once the target message is appended.",
    "priority": "high"
  },
  {
    "id": "task-3",
    "title": "Implement Lightboard Inline Preview & CSS Containment",
    "assigned_to": "implementer",
    "depends_on": ["task-1"],
    "description": "Refactor Lightboard's interaction HTML generation (idea_p3_4). Implement a micro-interaction inline preview or utilize CSS strict containment / Shadow DOM (idea_p4_5) to immediately show the interaction result within the chat message, bypassing the need for manual popover opening.",
    "priority": "high"
  },
  {
    "id": "task-4",
    "title": "Review & Validate UX Path Optimization",
    "assigned_to": "code-reviewer",
    "depends_on": ["task-2", "task-3"],
    "description": "Perform comprehensive review of the core engine API and Lightboard module updates. Validate the complete UX flow: triggering a Lightboard interaction should generate the response, auto-scroll to the new message via the queue, and cleanly display the result without breaking the UI.",
    "priority": "high"
  }
]


---

## Deep Dives

### CSS Containment로 격리된 강제 `<details open>`

## Analysis: CSS Containment로 격리된 강제 `<details open>` (Idea Deep Dive)

### Findings
- [src/lib/ChatScreens/ChatBody.svelte, `markParsingResult`, Line 266] RisuAI의 채팅 렌더링 파이프라인은 `ParseMarkdown`을 통해 생성된 HTML 문자열을 Svelte의 `{@html addMetadataToElement(trimMarkdown(md), modelShortName)}` 디렉티브를 사용해 DOM에 직접 삽입하는 방식입니다. 이 과정에서 유효하지 않은 HTML 트리(예: h DSL의 nil hole 등)가 생성될 경우, 브라우저 렌더링 엔진에 의해 기존 DOM 레이아웃(팝오버 등) 전체가 파괴될 수 있는 취약점이 있습니다.
- [src/ts/process/scripts.ts, `processScriptFull`, Line 139] `editdisplay` 모드가 실행될 때 플러그인 V2, 트리거, 정규식 스크립트가 순차적으로 적용되며 HTML/Markdown 문자열을 변환합니다. 모듈(Lightboard)은 이 단계에서 커스텀 태그를 주입할 수 있습니다.
- [src/ts/parser/parser.svelte.ts, `ParseMarkdown`, Line 780] 채팅 문자열은 렌더링 직전에 `DOMPurify.sanitize`를 거칩니다. 인라인 스타일을 주입할 경우 DOMPurify의 `ADD_ATTR` 설정에 의해 `style` 속성이 필터링되지 않아야 정상적으로 CSS Containment(`contain: strict;`)가 적용됩니다.
- [src/lib/ChatScreens/DefaultChatScreen.svelte, `scrollToMessage`, Line 202] RisuAI 내부 API로는 `ScrollToMessageStore`를 사용하여 특정 채팅 인덱스로 스크롤을 이동할 수 있습니다. 모듈이 스크롤을 유도하려면 `triggerV2UpdateGUI`나 관련 내부 Store(또는 API v3의 DOM 제어)를 간접적으로 호출해야 합니다.

### Risks / Issues (Roadblocks & Mitigations)
- **Roadblock 1 (Layout Constraints)**: `contain: strict;`는 `layout`, `style`, `paint`, `size`를 모두 격리시킵니다. 특히 `size` 격리로 인해 `<details>` 태그 내부 콘텐츠의 크기가 무시되고 높이/너비가 0으로 렌더링될 위험이 있습니다.
  - *Mitigation*: 모듈에서 HTML을 반환할 때 `contain: strict;` 대신 `contain: layout paint style;` (size 제외) 또는 `contain: content;`를 명시적으로 사용하여, 격리(Isolation)의 이점은 얻으면서도 콘텐츠 크기 유동성을 보장해야 합니다.
- **Roadblock 2 (Sanitization)**: DOMPurify가 `style="contain: ..."` 속성이나 `<details open>` 속성을 지워버릴 가능성이 있습니다.
  - *Mitigation*: RisuAI의 `parser.svelte.ts` DOMPurify 훅에 커스텀 속성(`x-risu-...` 등)이 허용되므로, 필요하다면 `class`나 허용된 구조를 사용하거나, `plugins.md` (API v3.0) 가이드에 따라 `SafeElement.setStyle()` API를 플러그인 레벨에서 호출하여 인라인 스타일을 강제 적용합니다.
- **Roadblock 3 (Auto Scroll)**: 인터랙션 후 즉시 해당 렌더링 위치로 포커스가 가지 않을 경우 UX가 반감됩니다.
  - *Mitigation*: `ScrollToMessageStore`에 가장 최근 메시지 인덱스(`message.length - 1`)를 갱신시키는 트리거를 호출하거나, `SafeElement.scrollIntoView()`를 이용해 후처리 네비게이션을 수행해야 합니다.

### Recommendations

- **MVP Definition (최소 기능 제품)**:
  인터랙션 완료 후 `editDisplay` 단계에서 반환되는 SNS UI 문자열을 `<details open style="contain: content;">`로 감싸는 단일 처리. 이를 통해 기존 팝오버 방식(2단계 클릭)을 없애고 즉각적으로 표시하며, h DSL에 의해 발생하는 UI 파괴(nil hole) 현상이 없는지 검증합니다.

- **Technical Requirements (기술적 요구사항)**:
  1. Lightboard 모듈의 렌더러 로직에서 반환하는 최상위 태그 수정 권한.
  2. CSS `contain` 프로퍼티의 속성값 조정(strict -> content).
  3. API v3.0의 `Risuai.getRootDocument()` 또는 V2 `editdisplay` 후처리 후의 스크롤 제어.

- **Implementation Roadmap (구현 로드맵)**:
  1. **Phase 1 (렌더링 격리)**: Lightboard 모듈 내 `renderSNS()` 출력 결과를 `<details open style="contain: content; display: block; overflow: auto;">`로 래핑하여 반환하도록 수정합니다.
  2. **Phase 2 (안정성 테스트)**: DOMPurify가 스타일을 보존하는지 체크하고, 만약 지워진다면 모듈 측 CSS 주입이나 `setStyle`을 통해 `contain` 속성을 안전하게 부여합니다.
  3. **Phase 3 (포커스 이동)**: 메시지 전송 및 LBDATA 업데이트 후, 플러그인 스크립트에서 해당 메시지 컨테이너(`.chat-message:last-child` 등)를 찾아 `scrollIntoView({ behavior: "smooth" })`를 호출하여 시야를 즉각적으로 이동시킵니다.

- **Success Metrics (성공 지표)**:
  - SNS 인터랙션 완료 직후 유저의 추가적인 클릭(버튼 -> 팝오버 여는 동작) 없이 0-click으로 결과 확인 가능.
  - Svelte 렌더링 파이프라인에서 기존 `dialog` 및 `popover` 기능에 아무런 간섭이나 깨짐 현상(Console 에러 및 UI 파괴)이 발생하지 않음.


### Hidden Checkbox 상태 머신을 통한 자동 전개

## Analysis: Hidden Checkbox 상태 머신을 통한 자동 전개 (idea_p4_2)

### 1. RisuAI의 채팅 렌더링 파이프라인 분석 (Findings)
- **`editDisplay` 및 HTML 삽입 구조**: 채팅 렌더링 시 `src/ts/parser/parser.svelte.ts`의 `processScriptFull` 함수를 통해 `editDisplay` 모드의 스크립트/모듈이 실행됩니다(line 755).
- **DOMPurify 보안 정책 (`id` 및 `class` 처리)**: `editDisplay`가 반환한 데이터는 `src/ts/parser/parser.svelte.ts`의 `trimMarkdown` 함수에서 `DOMPurify.sanitize`를 거칩니다(line 780).
  - 기본적으로 DOMPurify는 DOM Clobbering 공격을 방지하기 위해 HTML 요소의 `id` 속성을 **제거**합니다.
  - 하지만, `class` 속성의 경우 `uponSanitizeAttribute` 훅(line 76-113)을 통해 허용되나, `hljs`나 `x-risu-`로 시작하지 않는 클래스에는 자동으로 `x-risu-` 접두사가 추가됩니다.
- **스타일(`style`) 허용**: `trimMarkdown` 함수의 `ADD_TAGS` 설정에 `["style", "risu-style"]`이 명시적으로 포함되어 있어(line 781), `editDisplay` 내에서 직접 CSS를 주입할 수 있습니다.
- **채팅 렌더링 DOM 주입**: 정제된 HTML 문자열은 `src/lib/ChatScreens/Chat.svelte`의 `RenderGUIHtml` 함수(line 166)에서 `DOMParser`를 통해 파싱된 후, 실제 화면에 주입됩니다.

### 2. 모듈이 사용할 수 있는 API 확인 (Findings)
- **UI 네비게이션 API의 부재**: `src/lib/ChatScreens/DefaultChatScreen.svelte`에 `scrollToMessage` 같은 함수(line 206)가 있고, 상태 관리에 `ScrollToMessageStore`(src/ts/stores.svelte.ts line 43)를 사용하고 있으나, 이는 Svelte 컴포넌트 내부 상태에 강하게 결합되어 있습니다.
- **상호작용 후처리 한계**: 사용자가 `risu-btn` 클릭 시 `src/lib/ChatScreens/Chat.svelte`의 `handleButtonTriggerWithin`(line 175)이 호출되고 `runLuaButtonTrigger`(src/ts/process/scriptings.ts line 1342)를 실행하여 LBDATA를 업데이트하지만, 결과 반환 후 `<dialog popover>`를 강제로 열도록 DOM을 조작할 수 있는 JS API는 제공되지 않습니다(메시지 내 JS는 차단됨).

### 3. 인터랙션 시스템의 후처리 확인 (Findings)
- `risu-btn` 트리거 실행이 성공하면 `Chat.svelte`에서 `ReloadChatPointer.update`(line 195)를 호출하여 해당 메시지를 재렌더링합니다. 이때 `editDisplay` 콜백이 다시 실행되며, 새 상태가 포함된 HTML로 교체됩니다.

---

### Risks / Issues (Roadblocks & Mitigations)
- **`id` 속성 삭제 문제 (Risk)**: DOMPurify가 `id`를 삭제하므로, 표준 체크박스 렌더링 방식인 `<input id="sns-toggle">`와 `<label for="sns-toggle">`의 연결이 끊어집니다.
  - **Mitigation**: `for` 속성을 포기하고, `<label>` 내부에 `<input type="checkbox">`를 직접 포함(`Nesting`)시키거나, 공통 부모를 두고 CSS `:has()` 선택자를 활용하여 형제 요소를 제어해야 합니다.
- **이벤트 버블링 문제 (Risk)**: `<label>` 내부에 SNS 카드 콘텐츠 전체를 포함시킬 경우, 카드 내부의 텍스트나 빈 공간을 클릭해도 체크박스가 토글(닫힘)되는 문제가 발생합니다.
  - **Mitigation**: 토글 버튼(`<label>`)과 콘텐츠 영역(`div`)을 형제 요소(Sibling)로 분리하고, 부모 요소에서 `:has(input:checked)` 가상 선택자를 통해 콘텐츠의 가시성(`display`)을 제어해야 합니다.
- **클래스명 변경 문제 (Risk)**: DOMPurify가 임의로 `x-risu-`를 붙여 CSS 선택자가 깨질 수 있습니다.
  - **Mitigation**: 모듈에서 생성하는 모든 클래스 이름(CSS 태그 및 HTML 속성)의 접두사를 명시적으로 `x-risu-`로 강제 지정하여(예: `.x-risu-sns-container`) 변형을 방지합니다.

---

### Recommendations (아이디어 평가 및 구현 계획)

- **개요**: 숨겨진 `<input type="checkbox" checked>`를 생성된 HTML에 포함시켜 렌더링 즉시 열린 상태를 강제합니다.
- **기술적 근거**: `editDisplay`가 반환하는 HTML 내에 `<input type="checkbox" checked hidden>`과 `input:checked + .content { display: block; }` 구조를 주입합니다. RisuAI의 보안(DOMPurify)에 위배되지 않는 표준 속성이며 `<style>` 태그 삽입도 허용됩니다.
- **구현 난이도**: 모듈 측 HTML/CSS 수정만으로 완전히 독립적 구현 가능 (하). RisuAI 코어의 변경이 불필요합니다.
- **실현 가능성**: 매우 높음. RisuAI의 DOM 삽입 로직이나 팝오버 충돌과 무관하게 HTML/CSS 표준만으로 동작합니다. JS 기반의 상태 관리가 프레임워크 제약에 부딪히기 쉽지만, HTML Checkbox 트릭은 DOM이 존재하는 한 절대 실패하지 않는 가장 견고한 UI 상태 저장소입니다.

#### Implementation Roadmap
1. Lightboard 모듈의 템플릿 렌더러 로직 업데이트 (JS/HTML 구조 변경)
2. `editDisplay` 결과에 `checked` 속성을 포함한 `<input type="checkbox">` 주입 로직 추가
3. 관련된 CSS 클래스를 전부 `x-risu-` 접두사로 통일하고 동적 `<style>` 블록으로 주입
4. 기존 `<dialog popover>` 기반의 렌더링을 새로운 CSS `:has()` 기반 토글 컨테이너로 교체

#### Technical Requirements
- HTML의 `<label>`, `<input type="checkbox">` 사용
- CSS Level 4 Selectors (`:has`, `:checked`) 지원
- 클래스 네임스페이스(`x-risu-`) 강제 적용
- `editDisplay`가 반환하는 DOM 문자열 내장

#### Success Metrics
- 사용자가 댓글/좋아요 등 인터랙션 버튼 클릭 후, 페이지를 새로고침하거나 수동으로 클릭하지 않아도 SNS 창이 최신 상태로 펼쳐져 있음.
- 이전 메시지들의 SNS UI는 사용자가 닫기 버튼을 누르기 전까지 해당 `checked` 상태를 안정적으로 유지함 (스크롤/재렌더링 시 상태 보존).

#### MVP Definition
SNS 카드 렌더링 함수(`renderSNS`)의 템플릿을 수정하여, `interaction`의 후처리 결과로 반환될 때는 HTML 문자열 최상단 컨테이너에 `<input type="checkbox" class="x-risu-sns-toggle" checked style="display:none">`를 포함시키고, `x-risu-sns-container:has(.x-risu-sns-toggle:checked)` CSS 룰에 따라 UI가 노출되도록 하는 단방향 코드 반영.
