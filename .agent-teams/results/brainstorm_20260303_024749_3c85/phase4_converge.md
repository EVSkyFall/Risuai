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
