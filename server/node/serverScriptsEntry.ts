/**
 * Entry point for esbuild server-side prompt bundle.
 * Re-exports processScriptFull from the frontend code.
 * Browser dependencies are replaced by stubs via esbuild aliases.
 */
export { processScriptFull } from '../../src/ts/process/scripts';
export { risuChatParser } from '../../src/ts/parser/parser.svelte';
