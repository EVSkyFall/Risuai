```json
[
  {
    "id": "cross_p5_1",
    "title": "Standardized interactionComplete API Hook",
    "type": "evolution",
    "source_ids": ["idea_p2_2", "idea_p3_2"],
    "description": "Formalize an `interactionComplete` hook in the Plugin API that explicitly accepts a structured response (e.g., `{ action: 'open_popover', target_id: '...', scroll: true }`). The core Svelte components subscribe to this standardized state change, ensuring that the DOM is fully hydrated before natively calling `.scrollIntoView()` and `.showPopover()`, maintaining strict data flow."
  },
  {
    "id": "cross_p5_2",
    "title": "Data-Attribute Driven Core Observer",
    "type": "hybrid",
    "source_ids": ["idea_p2_1", "idea_p4_1"],
    "description": "Extend `editDisplay` to allow injecting a clean `data-focus-target=\"true\"` attribute into the interaction result. A centralized Svelte `afterUpdate` lifecycle hook at the core level watches for this attribute, natively executes `element.scrollIntoView()`, and manages popover state cleanly without relying on brittle CSS hacks."
  },
  {
    "id": "cross_p5_3",
    "title": "Official Lua Navigation API Extension",
    "type": "new",
    "source_ids": [],
    "description": "Expand the RisuAI Lua API to include `risu.ui.focusMessage(msgId, { openLightboard: true })`. When a Lightboard interaction finishes, the trigger script invokes this official API, which updates a centralized Svelte store, prompting the message component to reactively open its popover and scroll natively."
  },
  {
    "id": "cross_p5_4",
    "title": "Deferred UI Action Queue in Chat Pipeline",
    "type": "new",
    "source_ids": [],
    "description": "Implement a 'Deferred UI Action' queue in the core chat pipeline. When `editDisplay` processes an interaction, it yields secondary metadata alongside the HTML; the engine pushes a deferred action to open the popover, consumed safely by the UI layer only after the Svelte `$updated` tick guarantees DOM readiness."
  }
]
```
