Find the root cause of the empty message block rendering bug in the merged codebase.

# Bug Description
When the user generates a response from the AI, the new message is fully received and processed, but the UI renders it as an empty block (blank text). The text only appears if the user refreshes the page (F5). This issue started occurring after merging upstream v2026.2.200 ~ v2026.2.241 into the `server-stream` branch.

# Context
- The application uses Svelte 5 (`.svelte.ts` files with `$state()` and Svelte 4 `writable()` stores mixed).
- The core chat processing logic is in `src/ts/process/index.svelte.ts`, specifically the `sendChat` function.
- The UI component responsible for displaying chat messages is `src/lib/ChatScreens/ChatBody.svelte` (and possibly `src/lib/ChatScreens/Chat.svelte`).
- The message array is accessed via `DBState.db.characters[selectedChar].chats[selectedChat].message`.
- This branch has a localized accessor pattern introduced for server streaming:
  ```typescript
  // In index.svelte.ts sendChat()
  const charRef = DBState.db.characters[selectedChar]
  const getChatRef = () => charRef.chats[selectedChat]
  ```

# Task
Analyze the codebase to determine why the UI is failing to update reactively when new text is added to the message. Look for:
1. Reactivity breaks in Svelte 5 (e.g., modifying properties of an object inside an array without triggering $state updates, or Svelte 4 store interactions).
2. Changes from the recent upstream merge in `index.svelte.ts` or `ChatBody.svelte` that might have affected how message data is mutated or read.
3. Check where `v.data` or `msg.data` is updated during the streaming response (`req.type === 'streaming'` in `sendChat`). Note that `getChatRef().message[msgIndex].data += req.result` is used for streaming. Why doesn't this trigger UI updates anymore?

Provide a detailed analysis of the root cause and exactly which lines of code need to be fixed to restore reactivity.
