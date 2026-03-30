[
  {
    "id": "cross_p3_1",
    "title": "Seamless Inline Preview with Auto-Scroll Context",
    "type": "hybrid",
    "source_ids": [
      "idea_p3_4",
      "idea_p4_4"
    ],
    "description": "By combining a compact inline summary with CSS `scroll-snap`, the new message gently pulls into the user's viewport immediately upon rendering. This eliminates the cognitive friction of a blocking popover, providing instant visual confirmation of the interaction while keeping the user immersed in the primary chat flow."
  },
  {
    "id": "cross_p3_2",
    "title": "Stateful Inline Expansion to Preserve Mental Context",
    "type": "hybrid",
    "source_ids": [
      "idea_p3_1",
      "idea_p2_3"
    ],
    "description": "Instead of disjointed popovers, we track the interaction state to render the result fully inline using a pre-expanded HTML structure (like the CSS checkbox trick). This maintains the user's mental model by ensuring the result appears as a natural, fluid extension of the conversation rather than a separate floating layer they must manage."
  },
  {
    "id": "cross_p3_3",
    "title": "Visual Breadcrumbs via Hash Navigation and Glow",
    "type": "hybrid",
    "source_ids": [
      "idea_p3_3",
      "idea_p4_1"
    ],
    "description": "Utilizing pure CSS `:target` navigation combined with a fading animation, the UI naturally jumps to the newly appended message and highlights it with a subtle glow. This provides an elegant, frictionless pathway that guides the user's eye exactly to the outcome of their action without requiring any manual searching or extra clicks."
  }
]
