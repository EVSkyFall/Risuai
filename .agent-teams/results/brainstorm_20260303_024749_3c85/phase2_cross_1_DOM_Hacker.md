```json
[
  {
    "id": "cross_p4_1",
    "title": "Global Popover Control via :has() and Checked Inputs",
    "type": "evolution",
    "source_ids": ["idea_p4_2", "idea_p1_1"],
    "description": "Evolves the hidden checkbox idea by leveraging CSS `:has()` from the document root. By injecting an `<input type=\"radio\" name=\"lb-active\" checked hidden>` into the newly rendered LBDATA, global CSS can detect this newly checked radio and force its specific sibling/target popover to display block, bypassing both the native Popover API and Svelte's state entirely."
  },
  {
    "id": "cross_p4_2",
    "title": "Animation-Driven Lua Event Bridge",
    "type": "hybrid",
    "source_ids": ["idea_p1_4", "idea_p3_3"],
    "description": "Combines CSS animations with a global Lua event listener. The newly inserted LBDATA includes an element with a 1ms `@keyframes` animation. A persistent Lua trigger listens for the `animationstart` event globally, instantly identifying the new DOM node, calling `.scrollIntoView()`, and programmatically executing `showPopover()` on it."
  },
  {
    "id": "cross_p4_3",
    "title": "Autofocus + :focus-within Auto-Expander",
    "type": "new",
    "source_ids": [],
    "description": "Embeds a visually hidden `<button autofocus>` inside the interaction result HTML. Upon rendering, the browser natively and instantly scrolls down to focus the button without JS intervention. A `.lb-container:focus-within .lb-content { display: block; }` CSS rule then automatically expands the UI inline."
  },
  {
    "id": "cross_p4_4",
    "title": "Dynamic <style> Tag Injection Override",
    "type": "new",
    "source_ids": [],
    "description": "Directly injects a scoped `<style>` block within the new LBDATA HTML snippet returned by `editDisplay`. This style block targets the specific unique ID of the newly generated popover, instantly overriding its native hidden state and forcing it to render as soon as Svelte commits the DOM update."
  }
]
```
