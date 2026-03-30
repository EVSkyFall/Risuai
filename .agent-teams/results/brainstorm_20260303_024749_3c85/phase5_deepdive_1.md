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
