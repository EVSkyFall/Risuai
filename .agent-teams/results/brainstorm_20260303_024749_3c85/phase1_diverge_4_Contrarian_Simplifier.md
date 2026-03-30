[
  {
    "id": "idea_p4_1",
    "title": "CSS `:target` 기반 자동 스크롤 및 펼침 (Pure CSS URL Hash Hack)",
    "core_concept": "[개요] URL 해시와 CSS `:target`을 이용해 JS 없이 자동 열림 및 스크롤을 구현합니다. [기술적 근거] 브라우저 네이티브 동작인 `#id` 네비게이션과 `.lbd-content:target { display:block; }` CSS를 활용합니다. 새 메시지 렌더링 시 고유 ID를 부여하고 해당 앵커로 이동하게 유도합니다. [구현 난이도] 모듈 측 HTML/CSS 수정만으로 가능 (하). [실현 가능성] 높음. RisuAI의 라우터가 해시 변경을 방해하지 않는다면 완벽히 동작합니다.",
    "perspective_reveal": "복잡한 팝오버 API나 JS 포커스 제어는 오버엔지니어링입니다. 순수 CSS의 상태 선택자인 `:target`을 사용하면 렌더링 파이프라인 개입 없이도 브라우저가 알아서 스크롤과 가시성 전환을 처리해줍니다."
  },
  {
    "id": "idea_p4_2",
    "title": "Hidden Checkbox 상태 머신을 통한 자동 전개",
    "core_concept": "[개요] 숨겨진 `<input type=\"checkbox\" checked>`를 생성된 HTML에 포함시켜 렌더링 즉시 열린 상태를 강제합니다. [기술적 근거] `editDisplay` 콜백이 반환하는 HTML 내에 `<input id=\"lbd-toggle\" type=\"checkbox\" checked hidden>`과 `input:checked + .content { display: block; }` 구조를 주입합니다. [구현 난이도] 모듈 측 HTML/CSS 수정만으로 완벽히 독립적 구현 가능 (하). [실현 가능성] 매우 높음. RisuAI의 DOM 삽입 로직이나 팝오버 충돌과 무관하게 HTML/CSS 표준만으로 동작합니다.",
    "perspective_reveal": "JS 기반의 상태 관리는 프레임워크 제약에 부딪히기 쉽지만, HTML Checkbox 트릭은 DOM이 존재하는 한 절대 실패하지 않는 가장 견고한 UI 상태 저장소입니다."
  },
  {
    "id": "idea_p4_3",
    "title": "CSS Anchor Positioning을 이용한 인라인 오버레이",
    "core_concept": "[개요] `<dialog popover>` 대신 CSS Anchor Positioning을 사용하여 팝오버를 대체하고 자동으로 표시합니다. [기술적 근거] 새로운 CSS 표준인 `anchor-name`을 이용해 메시지 컨텍스트 내에서 UI를 띄웁니다. JS의 `showPopover()` 호출이 필요 없이 렌더링 즉시 지정된 앵커 위치에 오버레이가 나타납니다. [구현 난이도] 모듈 측 CSS 수정 (중). [실현 가능성] 중간. 구형 브라우저 지원 문제와 RisuAI의 `overflow: hidden` 컨테이너에 의해 잘릴 위험이 있습니다.",
    "perspective_reveal": "사용자가 수동으로 팝오버를 열어야 한다는 전제 자체가 문제입니다. Anchor Positioning을 사용하면 JS 호출 없이 DOM 구조 흐름을 깨지 않고도 플로팅 UI를 화면에 즉시 렌더링할 수 있습니다."
  },
  {
    "id": "idea_p4_4",
    "title": "CSS Animation 및 Scroll-Snap을 활용한 강제 포커싱",
    "core_concept": "[개요] 새 메시지에 CSS 애니메이션을 적용하고 `scroll-snap`을 통해 브라우저가 해당 위치로 스크롤을 당기도록 유도합니다. [기술적 근거] `.new-lbd-msg { animation: auto-focus 0.1s forwards; scroll-snap-align: start; }`를 적용. RisuAI 파이프라인에서 새 메시지 DOM 삽입 시 트리거됩니다. [구현 난이도] 모듈 측 CSS 수정만으로 가능 (하). [실현 가능성] 중간. 부모 컨테이너(채팅 스크롤 영역)에 `scroll-snap-type`이 설정되어야 완벽히 동작할 수 있습니다.",
    "perspective_reveal": "API의 `scrollToMessage`를 찾아서 억지로 호출할 필요가 없습니다. DOM 노드가 생성될 때 발생하는 CSS 라이프사이클을 악용하면 브라우저의 네이티브 스크롤 엔진을 우리 마음대로 조종할 수 있습니다."
  },
  {
    "id": "idea_p4_5",
    "title": "CSS Containment로 격리된 강제 `<details open>`",
    "core_concept": "[개요] 이전에 실패했던 `<details open>` 방식을 CSS `contain` 속성으로 완전히 격리시켜 기존 UI 파괴를 막습니다. [기술적 근거] `editDisplay`에서 `<details open style=\"contain: strict;\">`를 반환합니다. h DSL의 nil hole 문제가 DOM 트리 외부로 전파되는 것을 브라우저 엔진 레벨에서 차단합니다. [구현 난이도] 모듈 측 HTML/CSS 수정 (하). [실현 가능성] 높음. RisuAI의 코어 렌더링을 건드리지 않고 브라우저의 렌더링 격리(Isolation) 기능만 빌려 쓰므로 매우 안정적입니다.",
    "perspective_reveal": "실패한 기존 접근법이 근본적으로 틀린 게 아니라, CSS 스코핑이 부족했을 뿐입니다. 팝오버 같은 무거운 개념을 도입하기보다 렌더링 트리를 격리하는 `contain: strict` 한 줄이 훨씬 우아하고 가벼운 해결책입니다."
  }
]
