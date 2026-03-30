/**
 * Browser dependency stubs for server-side prompt bundle.
 * These replace Svelte stores, browser APIs, and UI functions
 * that are not needed when running processScriptFull on Node.js.
 */

// ─── svelte/store ───
export function get(store: any): any {
    if (store && typeof store === 'object' && 'value' in store) return store.value;
    if (store && typeof store._value !== 'undefined') return store._value;
    return undefined;
}
export function writable<T>(initial: T) {
    let value = initial;
    return {
        set: (v: T) => { value = v; },
        update: (fn: (v: T) => T) => { value = fn(value); },
        subscribe: (fn: (v: T) => void) => { fn(value); return () => {}; },
        get value() { return value; },
    };
}
export function readable<T>(initial: T) { return writable(initial); }
export function derived(_stores: any, _fn: any) { return writable(undefined); }

// ─── stores.svelte ───
export const selectedCharID = writable(-1);
export const CharEmotion = writable({} as Record<string, [string, string, number][]>);
export const DBState = { db: null as any };
export const ReloadChatPointer = writable({} as Record<number, number>);
export const ReloadGUIPointer = writable(0);
export const CurrentTriggerIdStore = writable<string | null>(null);
export const selIdState: any = { value: -1 };

// ─── globalApi.svelte ───
export function downloadFile(_name: string, _data: any) {}
export async function fetchNative(_url: string, _init?: any) { return new Response(); }
export function readImage() { return ''; }
export function getFileSrc(_src: string) { return ''; }
export function aiWatermarkingLawApplies() { return false; }
export const forageStorage = { isAccount: false };
export function saveDb() {}
export function alertError(msg: any) { console.error('[stub] alertError:', msg); }
export function alertNormal(msg: any) { console.log('[stub] alertNormal:', msg); }
export function alertNormalWait(msg: any) { return Promise.resolve(); }

// ─── alert ───
export function alertSelect(_items: any[]) { return Promise.resolve(''); }
export function alertInput(_msg: string) { return Promise.resolve(''); }
export function alertConfirm(_msg: string) { return Promise.resolve(false); }

// ─── lang ───
export const language = new Proxy({}, { get: () => '' }) as any;

// ─── util ───
export function selectSingleFile(): never { throw new Error('Not in browser'); }
export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
export function findCharacterbyId(_db: any, _id: string) { return null; }
export function getPersonaPrompt(_db: any) { return ''; }
export function getUserIcon() { return ''; }
export function getUserName(_db: any) { return _db?.username || 'User'; }
export function pickHashRand(_arr: any[], _seed: string) { return _arr[0]; }
export async function replaceAsync(str: string, regex: RegExp, asyncFn: any) {
    const matches = [...str.matchAll(regex)];
    if (matches.length === 0) return str;
    let result = str;
    for (const match of matches.reverse()) {
        const replacement = await asyncFn(...match, match.index, str);
        result = result.slice(0, match.index!) + replacement + result.slice(match.index! + match[0].length);
    }
    return result;
}

// ─── HypaProcesser stub ───
export class HypaProcesser {
    oaiargs: any = {};
    constructor() {}
    async addText(_text: string) {}
    async similaritySearch(_query: string) { return ''; }
    async similaritySearchScored(_query: string, _k?: number) { return []; }
}

// ─── scriptings (Lua) stub ───
export async function runLuaEditTrigger(_char: any, _mode: string, _data: string, _opts?: any) {
    return _data; // Return data unchanged — server has its own Lua runtime
}
export function runScripted() { return ''; }

// ─── plugins stub ───
export const pluginV2: any[] = [];

// ─── triggers stub ───
export async function runTrigger(_char: any, _mode: string, _opts?: any) { return null; }

// ─── DOMPurify stub ───
export const DOMPurify = {
    sanitize: (html: string) => html,
    addHook: () => {},
    removeHook: () => {},
    isSupported: true,
};

// ─── inlays stub ───
export function getInlayAssetBlob() { return null; }
export function writeInlayImage() {}
export function getInlayAsset() { return null; }

// ─── stableDiff stub ───
export function generateAIImage() { return Promise.resolve(null); }

// ─── request stub ───
export function requestChatData() { return Promise.resolve(null); }

// ─── command stub ───
export function processMultiCommand() { return ''; }

// ─── chatML stub ───
export function parseChatML(_text: string) { return []; }

// ─── platform ───
export const isTauri = false;
export const isNodeServer = true;
export const isIOS = false;
