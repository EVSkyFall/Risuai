[
  {
    "id": "idea_p2_1",
    "title": "Emit Custom Svelte Event via editDisplay Pipeline",
    "core_concept": "Modify the core Svelte message rendering component to listen for a specific event emitted during the `editDisplay` plugin lifecycle. When detected, the component natively calls `showPopover()` on the Lightboard dialog and executes `scrollIntoView`.",
    "perspective_reveal": "By tapping directly into the Svelte lifecycle, we ensure the DOM is fully updated before attempting to focus, avoiding race conditions and respecting the strict data flow of the core engine."
  },
  {
    "id": "idea_p2_2",
    "title": "Extend Plugin API with Native Navigation Commands",
    "core_concept": "Introduce new Lua/plugin API endpoints that allow Lightboard to send structured `scrollToMessage` and `openPopover` commands back to the engine. The core chat processor will parse these commands and execute the UI navigations natively after appending the new message.",
    "perspective_reveal": "A formalized API approach maintains a clean separation of concerns, treating UI actions as state-driven side effects rather than relying on hacky DOM manipulations."
  },
  {
    "id": "idea_p2_3",
    "title": "State-Driven Auto-Focus via lb-interaction__ Interception",
    "core_concept": "Hook into the Svelte event delegation system where `lb-interaction__` clicks are handled, storing the interaction context in a global Svelte store. Once the subsequent AI response stream completes, the core engine automatically resolves this state by opening the target popover.",
    "perspective_reveal": "Managing interaction state globally within the Svelte store ensures that asynchronous chat streaming doesn't break the UI focus flow, maintaining strict architectural control."
  },
  {
    "id": "idea_p2_4",
    "title": "Engine-Level MutationObserver for Lightboard Nodes",
    "core_concept": "Implement a global MutationObserver within the root `App.svelte` that watches for newly added `.chat-message` nodes containing specific Lightboard data-flags. Upon detection, it automatically triggers the popover API and scrolls to the node.",
    "perspective_reveal": "This provides a reactive, engine-level safety net that guarantees the popover opens regardless of how the plugin system injects the HTML, prioritizing system-wide consistency."
  },
  {
    "id": "idea_p2_5",
    "title": "Introduce DOM-Safe postRender Lifecycle Hook",
    "core_concept": "Create a new plugin lifecycle phase called `postRender` that executes strictly after the Svelte `$updated` tick. This hook passes a reference to the actual DOM node of the message to the plugin, allowing safe execution of `showPopover()` without raw script injections.",
    "perspective_reveal": "Designing a robust DOM-safe lifecycle hook solves the immediate problem cleanly while expanding the core plugin architecture's capabilities for future UI-intensive modules."
  }
]
