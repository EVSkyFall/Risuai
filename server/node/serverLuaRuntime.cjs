/**
 * serverLuaRuntime.cjs — Server-side Lua scripting runtime
 *
 * Port of scriptings.ts Lua engine for Node.js using wasmoon.
 * Provides the same API surface as the browser version, but with
 * UI functions stubbed (alerts, reloadDisplay, generateImage).
 *
 * Dependencies: wasmoon (npm install wasmoon)
 */
'use strict';

let LuaFactory, LuaEngine;
let wasmoonAvailable = false;

try {
    const wasmoon = require('wasmoon');
    LuaFactory = wasmoon.LuaFactory;
    LuaEngine = wasmoon.LuaEngine;
    wasmoonAvailable = true;
    console.log('[LuaRuntime] wasmoon loaded');
} catch (e) {
    console.warn('[LuaRuntime] wasmoon not installed. Lua triggers disabled. Install with: npm install wasmoon');
}

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Engine state management ───
let luaFactory = null;
let luaFactoryPromise = null;
const engineStates = new Map(); // mode → { engine, code, mutex }

// Simple mutex implementation
class Mutex {
    constructor() {
        this._locked = false;
        this._queue = [];
    }
    async runExclusive(fn) {
        while (this._locked) {
            await new Promise(resolve => this._queue.push(resolve));
        }
        this._locked = true;
        try {
            return await fn();
        } finally {
            this._locked = false;
            if (this._queue.length > 0) {
                this._queue.shift()();
            }
        }
    }
}

// ─── Lua standard library wrapper ───
// Same as luaCodeWrapper in scriptings.ts
const LUA_WRAPPER = `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end
    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end
    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end
    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end
    error('Invalid type: ' .. type)
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)
        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end
                safe, result = coroutine.resume(co)
                checkresult()
            end
            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end
            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end
    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end
    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end
    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)
`;

/**
 * Initialize wasmoon LuaFactory and mount json.lua
 */
async function makeLuaFactory() {
    if (!wasmoonAvailable) return;

    const factory = new LuaFactory();

    // Mount json.lua (bundled with wasmoon or from local file)
    const jsonLuaPath = path.join(__dirname, 'lua', 'json.lua');
    if (fs.existsSync(jsonLuaPath)) {
        const code = fs.readFileSync(jsonLuaPath, 'utf-8');
        await factory.mountFile('json.lua', code);
    }

    luaFactory = factory;
    console.log('[LuaRuntime] LuaFactory initialized');
}

async function ensureLuaFactory() {
    if (luaFactory) return;
    if (luaFactoryPromise) {
        await luaFactoryPromise;
        return;
    }
    luaFactoryPromise = makeLuaFactory();
    await luaFactoryPromise;
    luaFactoryPromise = null;
}

async function getOrCreateEngineState(mode) {
    let state = engineStates.get(mode);
    if (state) return state;

    state = {
        engine: null,
        code: null,
        mutex: new Mutex(),
        chat: null,
        setVar: null,
        getVar: null,
    };
    engineStates.set(mode, state);
    return state;
}

/**
 * Run a Lua script with the full API surface
 *
 * @param {string} code - Lua code to execute
 * @param {object} opts
 * @param {object} opts.db - Database
 * @param {number} opts.charIndex - Character index
 * @param {object} [opts.chat] - Chat object
 * @param {string|object[]} [opts.data] - Data to process
 * @param {function} [opts.setVar] - setChatVar function
 * @param {function} [opts.getVar] - getChatVar function
 * @param {string} [opts.mode='manual'] - Script mode
 * @param {object} [opts.meta={}] - Metadata
 * @returns {{ res: any, chat: object, stopSending: boolean }}
 */
async function runLuaScript(code, opts = {}) {
    if (!wasmoonAvailable) {
        console.warn('[LuaRuntime] wasmoon not available, skipping Lua script');
        return { res: opts.data || '', chat: opts.chat, stopSending: false };
    }

    await ensureLuaFactory();
    if (!luaFactory) {
        return { res: opts.data || '', chat: opts.chat, stopSending: false };
    }

    const { db, charIndex } = opts;
    const char = db?.characters?.[charIndex];
    const mode = opts.mode || 'manual';
    const data = opts.data || '';
    const meta = opts.meta || {};
    const setVar = opts.setVar || (() => { });
    const getVar = opts.getVar || (() => '');

    let chat = opts.chat || { message: [] };
    let stopSending = false;

    // Security ID — all server-side scripts are trusted
    const safeId = 'server_' + crypto.randomUUID();

    const engineState = await getOrCreateEngineState(mode);

    return await engineState.mutex.runExclusive(async () => {
        engineState.chat = chat;
        engineState.setVar = setVar;
        engineState.getVar = getVar;

        // Recreate engine if code changed
        if (code !== engineState.code) {
            engineState.engine?.global?.close();
            engineState.code = code;
            engineState.engine = await luaFactory.createEngine({ injectObjects: true });
            const engine = engineState.engine;
            const g = engine.global;

            // ─── Core APIs ───
            g.set('getChatVar', (id, key) => getVar(key));
            g.set('setChatVar', (id, key, value) => setVar(key, value));
            g.set('getGlobalVar', (id, key) => getVar('__global_' + key));
            g.set('stopChat', () => { stopSending = true; });

            // ─── Chat manipulation ───
            g.set('getChatMain', (id, index) => {
                const msg = engineState.chat.message.at(index);
                return msg ? JSON.stringify({ role: msg.role, data: msg.data, time: msg.time ?? 0 }) : JSON.stringify(null);
            });
            g.set('setChat', (id, index, value) => {
                const msg = engineState.chat.message?.at(index);
                if (msg) msg.data = value ?? '';
            });
            g.set('setChatRole', (id, index, value) => {
                const msg = engineState.chat.message?.at(index);
                if (msg) msg.role = value === 'user' ? 'user' : 'char';
            });
            g.set('cutChat', (id, start, end) => {
                engineState.chat.message = engineState.chat.message.slice(start, end);
            });
            g.set('removeChat', (id, index) => {
                engineState.chat.message.splice(index, 1);
            });
            g.set('addChat', (id, role, value) => {
                engineState.chat.message.push({
                    role: role === 'user' ? 'user' : 'char',
                    data: value ?? '',
                });
            });
            g.set('insertChat', (id, index, role, value) => {
                engineState.chat.message.splice(index, 0, {
                    role: role === 'user' ? 'user' : 'char',
                    data: value ?? '',
                });
            });
            g.set('getChatLength', () => engineState.chat.message.length);
            g.set('getFullChatMain', () => {
                return JSON.stringify(engineState.chat.message.map(v => ({
                    role: v.role, data: v.data, time: v.time ?? 0,
                })));
            });
            g.set('setFullChatMain', (id, value) => {
                const parsed = JSON.parse(value);
                engineState.chat.message = parsed.map(v => ({ role: v.role, data: v.data }));
            });

            // ─── Character data ───
            g.set('getName', () => char?.name || '');
            g.set('setName', (id, name) => {
                if (char && typeof name === 'string') char.name = name;
            });
            g.set('getDescription', () => char?.desc || '');
            g.set('setDescription', (id, desc) => {
                if (char && typeof desc === 'string') char.desc = desc;
            });
            g.set('getCharacterFirstMessage', () => char?.firstMessage || '');
            g.set('setCharacterFirstMessage', (id, val) => {
                if (char && typeof val === 'string') char.firstMessage = val;
            });
            g.set('getPersonaName', () => db?.username || 'User');
            g.set('getPersonaDescription', () => db?.personaPrompt || '');
            g.set('getAuthorsNote', () => engineState.chat?.note ?? '');

            // ─── Utility ───
            g.set('logMain', (value) => console.log('[Lua]', JSON.parse(value)));
            g.set('sleep', (id, time) => new Promise(resolve => setTimeout(resolve, time)));
            g.set('hash', async (id, value) => {
                return crypto.createHash('sha256').update(value).digest('hex');
            });
            g.set('getTokens', async (id, value) => Math.ceil((value || '').length / 4));

            // ─── CBS ───
            if (opts.risuChatParser) {
                g.set('cbs', (value) => opts.risuChatParser(value));
            } else {
                g.set('cbs', (value) => value);
            }

            // ─── Lorebook ───
            g.set('getLoreBooksMain', (id, search) => {
                if (!char?.globalLore) return JSON.stringify([]);
                const allLore = [...(engineState.chat?.localLore ?? []), ...(char.globalLore ?? [])];
                const found = allLore.filter(b => b.comment === search);
                return JSON.stringify(found);
            });
            g.set('upsertLocalLoreBook', (id, name, content, options) => {
                const { alwaysActive = false, insertOrder = 100, key = '', regex = false, secondKey = '' } = options || {};
                if (!engineState.chat.localLore) engineState.chat.localLore = [];
                engineState.chat.localLore = engineState.chat.localLore.filter(b => b.comment !== name);
                engineState.chat.localLore.push({
                    alwaysActive, comment: name, content, insertorder: insertOrder,
                    mode: 'normal', key, secondkey: secondKey, selective: !!secondKey, useRegex: regex,
                });
            });

            // ─── HTTP request (server-safe) ───
            let requestCount = 0;
            let requestResetTime = Date.now();
            g.set('request', async (id, url) => {
                if (Date.now() - requestResetTime > 60000) {
                    requestCount = 0;
                    requestResetTime = Date.now();
                }
                if (requestCount > 5) {
                    return JSON.stringify({ status: 429, data: 'Rate limited: 5 requests/min' });
                }
                if (url.length > 120) {
                    return JSON.stringify({ status: 413, data: 'URL too long (max 120 chars)' });
                }
                if (!url.startsWith('https://')) {
                    return JSON.stringify({ status: 400, data: 'Only https requests allowed' });
                }
                requestCount++;
                try {
                    const resp = await fetch(url, { method: 'GET' });
                    const text = await resp.text();
                    return JSON.stringify({ status: resp.status, data: text });
                } catch (e) {
                    return JSON.stringify({ status: 500, data: 'Request failed: ' + e.message });
                }
            });

            // ─── UI stubs (no-op on server) ───
            g.set('alertError', () => { });
            g.set('alertNormal', () => { });
            g.set('alertInput', () => '');
            g.set('alertSelect', () => '');
            g.set('alertConfirm', () => false);
            g.set('reloadDisplay', () => { });
            g.set('reloadChat', () => { });
            g.set('generateImage', async () => '');
            g.set('getCharacterImageMain', async () => '');
            g.set('getPersonaImageMain', async () => '');
            g.set('getBackgroundEmbedding', () => char?.backgroundHTML || '');
            g.set('setBackgroundEmbedding', () => { });

            // Execute Lua code with wrapper
            const fullCode = LUA_WRAPPER + '\n' + code;
            await engine.doString(fullCode);
        }

        // Call the listener for the current mode
        const engine = engineState.engine;
        if (engine) {
            try {
                const callListen = engine.global.get('callListenMain');
                if (callListen && typeof callListen === 'function') {
                    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
                    const resultStr = await callListen(mode, safeId, dataStr, JSON.stringify(meta));
                    if (resultStr) {
                        const parsed = JSON.parse(resultStr);
                        return { res: parsed, chat: engineState.chat, stopSending };
                    }
                }
            } catch (e) {
                console.error('[LuaRuntime] Execution error:', e.message);
            }
        }

        return { res: data, chat: engineState.chat, stopSending };
    });
}

/**
 * Run Lua edit triggers for a character
 *
 * @param {object} char - Character object
 * @param {string} mode - Trigger mode (editInput, editOutput, editRequest, editDisplay)
 * @param {string|object[]} content - Content to process
 * @param {object} opts - Additional options (db, charIndex, etc.)
 * @returns {Promise<any>} Processed content
 */
async function runLuaEditTrigger(char, mode, content, opts = {}) {
    if (!wasmoonAvailable) return content;

    // Normalize mode names
    switch (mode) {
        case 'editinput': mode = 'editInput'; break;
        case 'editoutput': mode = 'editOutput'; break;
        case 'editdisplay': mode = 'editDisplay'; break;
        case 'editprocess': return content; // Skip editprocess
    }

    try {
        const triggers = char.triggerscript || [];
        let data = content;

        for (const trigger of triggers) {
            if (trigger?.effect?.[0]?.type === 'triggerlua') {
                const result = await runLuaScript(trigger.effect[0].code, {
                    ...opts,
                    char,
                    mode,
                    data,
                });
                data = result.res ?? data;
            }
        }

        return data;
    } catch (e) {
        console.error('[LuaRuntime] Edit trigger error:', e.message);
        return content;
    }
}

/**
 * Check if wasmoon is available
 */
function isLuaAvailable() {
    return wasmoonAvailable;
}

/**
 * Clear all engine states (for cleanup)
 */
function clearEngines() {
    for (const [, state] of engineStates) {
        state.engine?.global?.close();
    }
    engineStates.clear();
}

module.exports = {
    runLuaScript,
    runLuaEditTrigger,
    isLuaAvailable,
    clearEngines,
};
