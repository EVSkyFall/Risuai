VERDICT: FAIL

## Review Summary
- **Risk Level**: CRITICAL
- **Issues Found**: 2 critical, 3 warnings, 1 suggestions
- **Overall Assessment**: The intentional exclusions of provider permissions (00184a04) and URL blacklists (3387c691) are clean, leaving no orphaned references. However, the merge introduced a critical bug where V3 plugins cannot return streams to the host due to an incomplete `collectTransferables` update in the guest script. Additionally, a memory leak exists in the `SandboxHost` termination sequence, and plugin unloads fail to clean up provider stores.

## Critical Issues
(Must fix before merge)
1. [src/ts/plugins/apiV3/factory.ts:55] Guest bridge script `collectTransferables` is missing `ReadableStream`, `WritableStream`, and `TransformStream` (unlike the host's version at line 233). When a guest plugin returns a stream (e.g. from an `addProvider` callback), `postMessage` will throw a `DataCloneError` because streams must be explicitly transferred rather than cloned.
2. [src/ts/plugins/apiV3/factory.ts:350] The `SandboxHost.terminate()` method does not remove the `messageHandler` event listener from the `window` object. This causes a memory leak, accumulating active listeners on the host window every time a V3 plugin is hot-reloaded or terminated.

## Warnings
(Should fix, but not blocking)
1. [src/ts/plugins/apiV3/v3.svelte.ts:307] V3 API `addProvider` does not register an `addPluginUnloadCallback`. When a V3 plugin is unloaded or hot-reloaded, it fails to clean up `pluginV2.providers`, `customProviderStore`, and `customV3ProviderMetaStore`, causing duplicate provider entries in the UI and memory bloat.
2. [src/ts/plugins/plugins.svelte.ts:459] The V2 `addProvider` API pushes to `customProviderStore`, but the store is never cleared during `loadV2Plugin()`. Each plugin load/reload causes `customProviderStore` to grow with duplicated provider names.
3. [src/ts/plugins/apiV3/v3.svelte.ts:282] `DBState.db.plugins.find(p => p.name === pluginName)?.script` is passed directly to `new TextEncoder().encode()`. If the plugin is deleted but an active iframe triggers a permission check, `.find` returns `undefined`, causing `encode()` to throw a type error.

## Suggestions
(Nice to have improvements)
1. [src/ts/plugins/plugins.svelte.ts:167] `let displayName: string = undefined` can cause TypeScript compilation errors if `strictNullChecks` is enabled. Consider typing it as `let displayName: string | undefined = undefined;`.

## Checklist
- [x] All tasks in task_plan.md completed
- [x] No hardcoded secrets or credentials
- [ ] Error handling is adequate (failed due to unchecked undefined in permission hash)
- [x] Code follows project conventions
- [ ] No obvious performance issues (failed due to event listener memory leak)
