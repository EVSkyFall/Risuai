## Analysis: Svelte 5 Reactivity Break in Chat Streaming

### Findings
- **Static Props in Programmatic Mount** (`src/lib/ChatScreens/Chats.svelte`, lines 129-152): Svelte 5's `mount()` API requires dynamic/reactive properties to be passed as getter functions. The codebase currently passes the Svelte proxy's properties statically (e.g., `message: message.data`). When `index.svelte.ts` pushes the initial empty chunk (`data: ""`), `Chats.svelte` evaluates `message.data` exactly once, and the child `Chat` component never receives subsequent text updates.
- **Destructive Re-mounting via Hash** (`src/lib/ChatScreens/Chats.svelte`, lines 112-120): The component identity hash `hashd` is calculated using `dataHash` (`fastMessageHash(message.data)`). If Svelte 5's `$effect` were to successfully react to string mutations during a stream, this design would cause `currentHash` to change on every streaming chunk. Svelte would completely unmount and remount the `<Chat>` DOM element 10+ times a second instead of updating the text node, leading to a blank UI or intense flickering.
- **Disconnected Update Triggers** (`src/ts/process/index.svelte.ts`, lines 1626 & 1643): The merged streaming loop increments `charRef.reloadKeys += 1` to manually flag updates. However, the `$effect` in `Chats.svelte` (line 218) is hardcoded to track `$ReloadChatPointer`, which is no longer updated during the streaming cycle. Consequently, `updateChatBody()` is never forced to run again to evaluate new data.

### Risks / Issues
- The UI mounts the incoming `Chat` component with `message: ""` and completely ignores the Svelte 5 state proxy mutations (`getChatRef().message[msgIndex].data = ...`) happening in `sendChat`.
- Relying on text content (`message.data`) to compute component uniqueness (`hashd`) is a severe anti-pattern in Svelte 5 that breaks fine-grained component reactivity and risks silently degrading the DOM.

### Recommendations
1. **Pass Reactive Getters to `mount()`**: In `src/lib/ChatScreens/Chats.svelte`, update the `props` object to use getter functions. This ensures that the `Chat` component remains synchronized with the Svelte 5 `$state` proxy dynamically:
   ```javascript
   props: {
       get message() { return message.data; },
       get messageGenerationInfo() { return message.generationInfo; },
       get disabled() { return message.disabled ?? false; },
       // ... keep other static props as normal (idx, role, etc)
   }
   ```
2. **Remove Text Data from Component Hash**: In `src/lib/ChatScreens/Chats.svelte`, remove `dataHash` from the `hashd` computation entirely. The hash must only rely on stable structural identifiers (like `chatId`, index `i`, and `reloadPointer`) so the `Chat` component can update reactively instead of being repeatedly destroyed.
   ```javascript
   // Remove `const dataHash = fastMessageHash(message.data);`
   let hashd = (message.chatId ?? "") + i.toString() + messageLargePortrait.toString() + (message.disabled?.toString() ?? "false") + reloadPointer.toString();
   ```
3. **Rely on Svelte 5 Deep Reactivity**: With getters properly in place, mutating the proxy via `getChatRef().message[msgIndex].data = result2.data` in `index.svelte.ts` will automatically flow into the `Chat` component's `$effect.pre` without requiring manual pointer bumps or re-mounting the container.
