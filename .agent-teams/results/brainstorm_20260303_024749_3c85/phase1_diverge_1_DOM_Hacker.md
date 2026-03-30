[
  {
    "id": "idea_p1_1",
    "title": "Pure CSS :has() Override",
    "core_concept": "Inject a unique class into the new Lightboard data output. Use RisuAI's global custom CSS feature with a selector like `body:has(.new-interaction) .lb-popover { display: block !important; opacity: 1; }` to force it open, completely bypassing the native JS Popover API.",
    "perspective_reveal": "As a DOM Hacker, I know that native browser APIs can often be brute-forced into submission with CSS; if we control the markup and global styles, we don't need Svelte's permission to make things visible."
  },
  {
    "id": "idea_p1_2",
    "title": "The Autofocus Scroll Exploit",
    "core_concept": "Embed a tiny, invisible `<input autofocus>` element inside the resulting Lightboard HTML. When Svelte attaches the new chat message to the DOM, the browser's native behavior will instantly scroll the user down to the newly created popover.",
    "perspective_reveal": "Exploiting native browser accessibility features like `autofocus` gives us a free 'scroll to bottom' mechanism without needing to access RisuAI's internal `scrollToMessage` API."
  },
  {
    "id": "idea_p1_3",
    "title": "Persistent Checkbox Hack Replacement",
    "core_concept": "Discard `<dialog popover>` entirely for the interaction result. Instead, render the new UI using the classic 'CSS Checkbox Hack' (`<input type=\"checkbox\" id=\"lbtoggle\" checked>`). Because it renders with `checked` already set, the 'popover' is open by default.",
    "perspective_reveal": "Why fight with Svelte's lifecycle and modern Popover APIs when a decades-old CSS trick allows us to encode the 'open' state directly into the raw HTML string?"
  },
  {
    "id": "idea_p1_4",
    "title": "Animation Events as Stealth Callbacks",
    "core_concept": "Attach a 1ms CSS animation to the newly generated Lightboard wrapper. Use a persistent Lua plugin or global trigger to attach an `animationstart` listener to the document. When the animation fires, the script catches the event target and calls `.showPopover()`.",
    "perspective_reveal": "When direct `<script>` tags are sanitized or blocked, CSS animations provide a stealthy side-channel to broadcast a 'DOM node inserted' signal to any waiting global scripts."
  },
  {
    "id": "idea_p1_5",
    "title": "Brute-force MutationObserver Injection",
    "core_concept": "Write a Lua plugin or use an initial trigger script to attach a `MutationObserver` to the main chat container. The observer blindly watches for new DOM nodes matching `.lb-interaction-result`, instantly scrolling them into view and executing `.showPopover()`.",
    "perspective_reveal": "If we cannot cleanly hook into Svelte's `editDisplay` pipeline, we can just sit outside the framework, watch the DOM blindly, and hijack the UI state the millisecond Svelte commits its changes."
  }
]
