# Comprehensive Merge Patch Review

## Context
We merged upstream RisuAI v2026.2.200–v2026.2.241 into our `server-stream` branch. The pre-merge commit is `e983ea84`. We already found and fixed one critical bug (empty message rendering due to missing `reloadKeys` tracking in `Chats.svelte`).

## Your Task
Review ALL changes between `e983ea84` (pre-merge) and the current HEAD for potential bugs, regressions, or broken patterns. Focus on:

1. **Svelte 5 Reactivity Issues**: Any location where `$state` proxies are mutated deeply without proper tracking. Look for patterns like `obj.prop = value` that won't trigger `$effect` or `$derived` re-evaluation.
2. **Broken Merge Conflict Resolutions**: Look for duplicate code, missing code, or incorrectly merged logic where both local and upstream changes overlap.
3. **Missing Imports / Undefined References**: Variables or functions referenced but not imported or defined (like the `currentChar` TDZ issue we already found).
4. **Local Server-Specific Code Preservation**: Our local `server-stream` branch has custom code for server-side features (job tracking, plugin recovery, server chat). Ensure these weren't accidentally overwritten or broken by the merge.
5. **Type Errors**: TypeScript type mismatches that the build might not catch but could cause runtime errors.

## How to Review
Use `git diff e983ea84..HEAD -- <filepath>` mentally, or simply read the current file and look for suspicious patterns. For each file in your assigned group, report:
- **File**: path
- **Issue severity**: CRITICAL / WARNING / INFO
- **Description**: What's wrong and why
- **Suggested fix**: How to fix it

If a file looks clean, say so briefly. Focus your effort on CRITICAL and WARNING issues.
