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
