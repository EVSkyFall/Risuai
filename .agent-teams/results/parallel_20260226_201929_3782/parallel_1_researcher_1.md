## Analysis: Chat Message Empty Block Rendering Bug

### Findings
- **Reactivity Break via Plain Array Spread**: In `src/lib/ChatScreens/DefaultChatScreen.svelte` (line 133), the displayed messages are derived via `let displayMessages = $derived([...archivedMessages, ...currentChat]);`. The array spread creates a new plain array. While Svelte 5 tracks the array's length when elements are pushed (causing the UI to render the initial empty block), it does not track deep mutations to the `.data` property of elements inside that array spread unless specifically re-evaluated.
- **Static Component Mounting**: In `src/lib/ChatScreens/Chats.svelte` (line 127), `updateChatBody` manually mounts `<Chat>` components, passing `message: message.data` as a static string prop. The component is only remounted when `currentHash` (which depends on `message.data`) changes.
- **Missing Effect Trigger**: The `$effect` block in `Chats.svelte` (line 216) that calls `updateChatBody()` is not triggered by deep property mutations (`getChatRef().message[msgIndex].data = ...`) because the `messages` prop reference (`displayMessages`) does not change during the text streaming process.
- **Disconnected Manual Trigger**: In `src/ts/process/index.svelte.ts` (lines 1660, 1677), the developer attempted to fix Svelte 5 reactivity drops during streaming by introducing a localized trigger: `charRef.reloadKeys += 1`. However, `Chats.svelte`'s `$effect` (line 218) only tracks the legacy Svelte 4 store `void $ReloadChatPointer;` and completely ignores the new `reloadKeys` state.

### Risks / Issues
- Because the `$effect` in `Chats.svelte` fails to track deep mutations and ignores the `reloadKeys` trigger, the application never recalculates `currentHash` during the `req.type === 'streaming'` phase.
- Consequently, the `Chat` component is mounted once with an empty string and is never remounted with the newly streamed text chunks, leaving the UI showing an empty block until the user manually triggers a full reactivity cycle (e.g., F5 refresh).

### Recommendations
To restore reactivity, `Chats.svelte` must track the `reloadKeys` Svelte 5 state variable that `sendChat` updates iteratively during the streaming loop.

**Actionable Suggestion:**
Update `src/lib/ChatScreens/Chats.svelte` to track `currentCharacter.reloadKeys` inside its `$effect` block (around line 218):

```svelte
    $effect(() => {
        console.log("Updating Chats");
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        void (currentCharacter as character).reloadKeys; // <-- ADD THIS to track localized streaming updates
        const wasAtBottom = checkIfAtBottom();
        updateChatBody();
        // ...
    });
```
This will force the `$effect` to re-run every time `charRef.reloadKeys += 1` executes in `index.svelte.ts`, successfully recalculating the hash and remounting the Chat blocks with the updated text.
