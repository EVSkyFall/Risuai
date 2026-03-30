/**
 * serverCBS.cjs — Server-side CBS (Conditional Block Syntax) engine
 * Ported from: cbs.ts (2481 lines)
 * 
 * Strategy: registerCBS() is called with a server-side CBSRegisterArg that
 * provides DB access via plain objects instead of Svelte stores.
 * Browser-only callbacks (screenwidth/height, navigator.language) return safe defaults.
 */
'use strict';

const {
    createCalcString, pickHashRand, dateTimeFormat,
    getChatVar, setChatVar, getGlobalChatVar,
    safeStructuredClone, makeArray, parseArraySafe, parseDictSafe,
} = require('./serverCBSUtils.cjs');

/**
 * Registers all CBS callback functions into the provided matcherMap.
 * This is a direct port of registerCBS() from cbs.ts with browser deps replaced.
 * 
 * @param {object} arg - CBSRegisterArg-compatible object
 */
function registerCBS(arg) {
    const {
        registerFunction, getDatabase, getUserName, getPersonaPrompt,
        risuChatParser, makeArray: makeArr, safeStructuredClone: sClone,
        parseArray, parseDict, getChatVar: getCV, setChatVar: setCV,
        getGlobalChatVar: getGCV, calcString, dateTimeFormat: dtf,
        getModules, getModuleLorebooks, pickHashRand: pickHR,
        getSelectedCharID, isTauri, isNodeServer, isMobile, appVer,
        getModelInfo, callInternalFunction
    } = arg;

    // ─── Character/User variables ───
    registerFunction({
        name: 'char', callback: (s, m, a, v) => {
            if (m.consistantChar) return 'botname';
            const db = getDatabase(); let sc = getSelectedCharID(); let cc = db.characters[sc];
            if (cc && cc.type !== 'group') return cc.nickname || cc.name;
            if (m.chara) { return typeof m.chara === 'string' ? m.chara : m.chara.name; }
            return cc.nickname || cc.name;
        }, alias: ['bot'], description: ''
    });

    registerFunction({
        name: 'user', callback: (s, m, a, v) => {
            if (m.consistantChar) return 'username';
            return getUserName();
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'trigger_id', callback: (s, m, a, v) => {
            return m.triggerId || 'null';
        }, alias: ['triggerid'], description: ''
    });

    registerFunction({
        name: 'previouscharchat', callback: (s, m, a, v) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()];
            const chat = sc.chats[sc.chatPage];
            let ptr = m.chatID !== -1 ? m.chatID - 1 : chat.message.length - 1;
            while (ptr >= 0) { if (chat.message[ptr].role === 'char') return chat.message[ptr].data; ptr--; }
            return chat.fmIndex === -1 ? sc.firstMessage : sc.alternateGreetings[chat.fmIndex];
        }, alias: ['previouscharchat', 'lastcharmessage'], description: ''
    });

    registerFunction({
        name: 'previoususerchat', callback: (s, m, a, v) => {
            if (m.chatID === -1) return '';
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()];
            const chat = sc.chats[sc.chatPage]; let ptr = m.chatID - 1;
            while (ptr >= 0) { if (chat.message[ptr].role === 'user') return chat.message[ptr].data; ptr--; }
            return '';
        }, alias: ['previoususerchat', 'lastusermessage'], description: ''
    });

    // ─── Character data ───
    registerFunction({
        name: 'personality', callback: (s, m, a, v) => {
            const db = getDatabase(); const ac = (m.chara && typeof m.chara !== 'string') ? m.chara : db.characters[getSelectedCharID()];
            return ac.type === 'group' ? '' : risuChatParser(ac.personality, m);
        }, alias: ['charpersona'], description: ''
    });

    registerFunction({
        name: 'description', callback: (s, m, a, v) => {
            const db = getDatabase(); const ac = (m.chara && typeof m.chara !== 'string') ? m.chara : db.characters[getSelectedCharID()];
            return ac.type === 'group' ? '' : risuChatParser(ac.desc, m);
        }, alias: ['chardesc'], description: ''
    });

    registerFunction({
        name: 'scenario', callback: (s, m, a, v) => {
            const db = getDatabase(); const ac = (m.chara && typeof m.chara !== 'string') ? m.chara : db.characters[getSelectedCharID()];
            return ac.type === 'group' ? '' : risuChatParser(ac.scenario, m);
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'exampledialogue', callback: (s, m, a, v) => {
            const db = getDatabase(); const ac = (m.chara && typeof m.chara !== 'string') ? m.chara : db.characters[getSelectedCharID()];
            return ac.type === 'group' ? '' : risuChatParser(ac.exampleMessage, m);
        }, alias: ['examplemessage', 'example_dialogue'], description: ''
    });

    // ─── Prompt/System ───
    registerFunction({ name: 'persona', callback: (s, m, a, v) => risuChatParser(getPersonaPrompt(), m), alias: ['userpersona'], description: '' });
    registerFunction({ name: 'mainprompt', callback: (s, m, a, v) => risuChatParser(getDatabase().mainPrompt, m), alias: ['systemprompt', 'main_prompt'], description: '' });

    registerFunction({
        name: 'lorebook', callback: (s, m, a, v) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()];
            const chat = sc.chats[sc.chatPage]; const ac = (m.chara && typeof m.chara !== 'string') ? m.chara : sc;
            const charLore = (ac.type === 'group') ? [] : (ac.globalLore || []);
            const chatLore = chat.localLore || [];
            return makeArr(charLore.concat(chatLore.concat(getModuleLorebooks())).map(v => JSON.stringify(v)));
        }, alias: ['worldinfo'], description: ''
    });

    registerFunction({
        name: 'userhistory', callback: (s, m, a, v) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
            return makeArr(chat.message.filter(v => v.role === 'user').map(v => { v = sClone(v); v.data = risuChatParser(v.data, m); return JSON.stringify(v); }));
        }, alias: ['usermessages', 'user_history'], description: ''
    });

    registerFunction({
        name: 'charhistory', callback: (s, m, a, v) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
            return makeArr(chat.message.filter(v => v.role === 'char').map(v => { v = sClone(v); v.data = risuChatParser(v.data, m); return JSON.stringify(v); }));
        }, alias: ['charmessages', 'char_history'], description: ''
    });

    registerFunction({ name: 'jb', callback: (s, m, a, v) => risuChatParser(getDatabase().jailbreak, m), alias: ['jailbreak'], description: '' });
    registerFunction({ name: 'globalnote', callback: (s, m, a, v) => risuChatParser(getDatabase().globalNote, m), alias: ['globalnote', 'systemnote', 'ujb'], description: '' });
    registerFunction({ name: 'chatindex', callback: (s, m, a, v) => m.chatID.toString(), alias: ['chat_index'], description: '' });

    registerFunction({
        name: 'firstmsgindex', callback: (s, m, a, v) => {
            const sc = getDatabase().characters[getSelectedCharID()]; return sc.chats[sc.chatPage].fmIndex.toString();
        }, alias: ['firstmessageindex', 'first_msg_index'], description: ''
    });

    registerFunction({ name: 'blank', callback: () => '', alias: ['none'], description: '' });

    // ─── Time functions ───
    registerFunction({
        name: 'messagetime', callback: (s, m, a, v) => {
            if (m.tokenizeAccurate) return '00:00:00'; if (m.chatID === -1) return '[Cannot get time]';
            const sc = getDatabase().characters[getSelectedCharID()]; const msg = sc.chats[sc.chatPage].message[m.chatID];
            if (!msg.time) return '[Cannot get time, message was sent in older version]';
            return new Date(msg.time).toLocaleTimeString();
        }, alias: ['message_time'], description: ''
    });

    registerFunction({
        name: 'messagedate', callback: (s, m, a, v) => {
            if (m.tokenizeAccurate) return '00:00:00'; if (m.chatID === -1) return '[Cannot get time]';
            const sc = getDatabase().characters[getSelectedCharID()]; const msg = sc.chats[sc.chatPage].message[m.chatID];
            if (!msg.time) return '[Cannot get time, message was sent in older version]';
            return new Date(msg.time).toLocaleDateString();
        }, alias: ['message_date'], description: ''
    });

    registerFunction({
        name: 'messageunixtimearray', callback: (s, m, a, v) => {
            const sc = getDatabase().characters[getSelectedCharID()];
            return makeArr(sc.chats[sc.chatPage].message.map(f => `${f.time || 0}`));
        }, alias: ['message_unixtime_array'], description: ''
    });

    registerFunction({ name: 'unixtime', callback: () => (Date.now() / 1000).toFixed(0), alias: [], description: '' });
    registerFunction({ name: 'time', callback: () => { const n = new Date(); return `${n.getHours()}:${n.getMinutes()}:${n.getSeconds()}`; }, alias: [], description: '' });
    registerFunction({ name: 'isotime', callback: () => { const n = new Date(); return `${n.getUTCHours()}:${n.getUTCMinutes()}:${n.getUTCSeconds()}`; }, alias: [], description: '' });
    registerFunction({ name: 'isodate', callback: () => { const n = new Date(); return `${n.getUTCFullYear()}-${n.getUTCMonth() + 1}-${n.getUTCDate()}`; }, alias: [], description: '' });

    registerFunction({
        name: 'messageidleduration', callback: (s, m, a, v) => {
            if (m.tokenizeAccurate) return '00:00:00'; if (m.chatID === -1) return '[Cannot get time]';
            const sc = getDatabase().characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
            let ptr = m.chatID, msg, prev, mode = 'findLast';
            while (ptr >= 0) { if (chat.message[ptr].role === 'user') { if (mode === 'findLast') { msg = chat.message[ptr]; mode = 'findSecondLast'; } else { prev = chat.message[ptr]; break; } } ptr--; }
            if (!msg) return '[No user message found]'; if (!prev) return '[No previous user message found]';
            if (!msg.time || !prev.time) return '[Cannot get time, message was sent in older version]';
            let dur = msg.time - prev.time, sec = Math.floor(dur / 1000), min = Math.floor(sec / 60), hr = Math.floor(min / 60);
            return hr + ':' + String(min % 60).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
        }, alias: ['message_idle_duration'], description: ''
    });

    registerFunction({
        name: 'idleduration', callback: (s, m, a, v) => {
            if (m.tokenizeAccurate) return '00:00:00';
            const sc = getDatabase().characters[getSelectedCharID()]; const msgs = sc.chats[sc.chatPage].message;
            if (!msgs.length) return '00:00:00'; const last = msgs[msgs.length - 1];
            if (!last.time) return '[Cannot get time, message was sent in older version]';
            let dur = Date.now() - last.time, sec = Math.floor(dur / 1000), min = Math.floor(sec / 60), hr = Math.floor(min / 60);
            return hr + ':' + String(min % 60).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
        }, alias: ['idle_duration'], description: ''
    });

    registerFunction({ name: 'br', callback: () => '\n', alias: ['newline'], description: '' });
    registerFunction({ name: 'model', callback: () => getDatabase().aiModel, alias: [], description: '' });
    registerFunction({ name: 'axmodel', callback: () => getDatabase().subModel, alias: [], description: '' });

    registerFunction({
        name: 'role', callback: (s, m, a, v) => {
            if (m.cbsConditions.chatRole) return m.cbsConditions.chatRole;
            if (m.cbsConditions.firstmsg) return 'char';
            if (m.chatID !== -1) { const sc = getDatabase().characters[getSelectedCharID()]; return sc.chats[sc.chatPage].message[m.chatID].role; }
            return m.role || 'null';
        }, alias: [], description: ''
    });

    registerFunction({ name: 'isfirstmsg', callback: (s, m) => m.cbsConditions.firstmsg ? '1' : '0', alias: ['isfirstmsg', 'isfirstmessage'], description: '' });
    registerFunction({ name: 'jbtoggled', callback: () => getDatabase().jailbreakToggle ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'maxcontext', callback: () => getDatabase().maxContext.toString(), alias: [], description: '' });

    registerFunction({
        name: 'lastmessage', callback: (s, m, a, v) => {
            const sc = getDatabase().characters[getSelectedCharID()]; if (!sc) return '';
            const chat = sc.chats[sc.chatPage]; return chat.message[chat.message.length - 1].data;
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'lastmessageid', callback: (s, m, a, v) => {
            const sc = getDatabase().characters[getSelectedCharID()]; if (!sc) return '';
            return (sc.chats[sc.chatPage].message.length - 1).toString();
        }, alias: ['lastmessageindex'], description: ''
    });

    // ─── Variable handling ───
    registerFunction({ name: 'tempvar', callback: (s, m, a, v) => ({ text: v[a[0]] || '', var: v }), alias: ['gettempvar'], description: '' });
    registerFunction({ name: 'settempvar', callback: (s, m, a, v) => { v[a[0]] = a[1]; return { text: '', var: v }; }, alias: [], description: '' });
    registerFunction({ name: 'return', callback: (s, m, a, v) => { v['__return__'] = a[0]; v['__force_return__'] = '1'; return { text: '', var: v }; }, alias: [], description: '' });
    registerFunction({ name: 'getvar', callback: (s, m, a, v) => getCV(a[0]), alias: [], description: '' });
    registerFunction({ name: 'calc', callback: (s, m, a, v) => calcString(a[0]).toString(), alias: [], description: '' });

    registerFunction({
        name: 'addvar', callback: (s, m, a, v) => {
            if (m.rmVar) return ''; if (m.runVar) { setCV(a[0], (Number(getCV(a[0])) + Number(a[1])).toString()); return ''; } return null;
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'setvar', callback: (s, m, a, v) => {
            if (m.rmVar) return ''; if (m.runVar) { setCV(a[0], a[1]); return ''; } return null;
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'setdefaultvar', callback: (s, m, a, v) => {
            if (m.rmVar) return ''; if (m.runVar) { if (!getCV(a[0])) setCV(a[0], a[1]); return ''; } return null;
        }, alias: [], description: ''
    });

    registerFunction({ name: 'getglobalvar', callback: (s, m, a, v) => getGCV(a[0]), alias: [], description: '' });

    // ─── UI functions (safe server defaults) ───
    registerFunction({ name: 'button', callback: (s, m, a, v) => `<button class="button-default" risu-trigger="${a[1]}">${a[0]}</button>`, alias: [], description: '' });
    registerFunction({ name: 'risu', callback: (s, m, a, v) => `<img src="/logo2.png" style="height:${a[0] || '45'}px;width:${a[0] || '45'}px" />`, alias: [], description: '' });

    // ─── Comparison functions ───
    registerFunction({ name: 'equal', callback: (s, m, a) => (a[0] === a[1]) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'notequal', callback: (s, m, a) => (a[0] !== a[1]) ? '1' : '0', alias: ['not_equal'], description: '' });
    registerFunction({ name: 'greater', callback: (s, m, a) => (Number(a[0]) > Number(a[1])) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'less', callback: (s, m, a) => (Number(a[0]) < Number(a[1])) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'greaterequal', callback: (s, m, a) => (Number(a[0]) >= Number(a[1])) ? '1' : '0', alias: ['greater_equal'], description: '' });
    registerFunction({ name: 'lessequal', callback: (s, m, a) => (Number(a[0]) <= Number(a[1])) ? '1' : '0', alias: ['less_equal'], description: '' });
    registerFunction({ name: 'and', callback: (s, m, a) => (a[0] === '1' && a[1] === '1') ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'or', callback: (s, m, a) => (a[0] === '1' || a[1] === '1') ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'not', callback: (s, m, a) => a[0] === '1' ? '0' : '1', alias: [], description: '' });

    registerFunction({
        name: 'file', callback: (s, m, a) => {
            if (m.displaying) return `<br><div class="risu-file">${a[0]}</div><br>`;
            return Buffer.from(a[1], 'base64').toString('utf-8');
        }, alias: [], description: ''
    });

    // ─── String manipulation ───
    registerFunction({ name: 'startswith', callback: (s, m, a) => a[0].startsWith(a[1]) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'endswith', callback: (s, m, a) => a[0].endsWith(a[1]) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'contains', callback: (s, m, a) => a[0].includes(a[1]) ? '1' : '0', alias: [], description: '' });
    registerFunction({ name: 'replace', callback: (s, m, a) => a[0].replaceAll(a[1], a[2]), alias: [], description: '' });
    registerFunction({ name: 'split', callback: (s, m, a) => makeArr(a[0].split(a[1])), alias: [], description: '' });
    registerFunction({ name: 'join', callback: (s, m, a) => parseArray(a[0]).join(a[1]), alias: [], description: '' });
    registerFunction({ name: 'spread', callback: (s, m, a) => parseArray(a[0]).join('::'), alias: [], description: '' });
    registerFunction({ name: 'trim', callback: (s, m, a) => a[0].trim(), alias: [], description: '' });
    registerFunction({ name: 'length', callback: (s, m, a) => a[0].length.toString(), alias: [], description: '' });
    registerFunction({ name: 'lower', callback: (s, m, a) => a[0].toLocaleLowerCase(), alias: [], description: '' });
    registerFunction({ name: 'upper', callback: (s, m, a) => a[0].toLocaleUpperCase(), alias: [], description: '' });
    registerFunction({ name: 'capitalize', callback: (s, m, a) => a[0].charAt(0).toUpperCase() + a[0].slice(1), alias: [], description: '' });

    // ─── Math functions ───
    registerFunction({ name: 'round', callback: (s, m, a) => Math.round(Number(a[0])).toString(), alias: [], description: '' });
    registerFunction({ name: 'floor', callback: (s, m, a) => Math.floor(Number(a[0])).toString(), alias: [], description: '' });
    registerFunction({ name: 'ceil', callback: (s, m, a) => Math.ceil(Number(a[0])).toString(), alias: [], description: '' });
    registerFunction({ name: 'abs', callback: (s, m, a) => Math.abs(Number(a[0])).toString(), alias: [], description: '' });
    registerFunction({ name: 'remaind', callback: (s, m, a) => (Number(a[0]) % Number(a[1])).toString(), alias: [], description: '' });
    registerFunction({ name: 'tonumber', callback: (s, m, a) => [...a[0]].filter(v => !isNaN(Number(v)) || v === '.').join(''), alias: [], description: '' });
    registerFunction({ name: 'pow', callback: (s, m, a) => Math.pow(Number(a[0]), Number(a[1])).toString(), alias: [], description: '' });
    registerFunction({ name: 'fixnum', callback: (s, m, a) => Number(a[0]).toFixed(Number(a[1])), alias: ['fixnum', 'fixnumber'], description: '' });

    // ─── Array/Object manipulation ───
    registerFunction({ name: 'arraylength', callback: (s, m, a) => parseArray(a[0]).length.toString(), alias: ['arraylength'], description: '' });
    registerFunction({
        name: 'arrayelement', callback: (s, m, a) => {
            const e = parseArray(a[0]).at(Number(a[1])) || 'null'; return typeof e === 'object' ? JSON.stringify(e) : String(e);
        }, alias: ['arrayelement'], description: ''
    });
    registerFunction({
        name: 'dictelement', callback: (s, m, a) => {
            const e = parseDict(a[0])[a[1]] || 'null'; return typeof e === 'object' ? JSON.stringify(e) : String(e);
        }, alias: ['dictelement', 'objectelement'], description: ''
    });
    registerFunction({
        name: 'objectassert', callback: (s, m, a) => {
            const d = parseDict(a[0]); if (!d[a[1]]) d[a[1]] = a[2]; return JSON.stringify(d);
        }, alias: ['dictassert', 'object_assert'], description: ''
    });
    registerFunction({
        name: 'element', callback: (s, m, a) => {
            try { const ags = a.slice(1); let cur = a[0]; for (const ag of ags) { const p = JSON.parse(cur); if (p === null || (typeof p !== 'object' && !Array.isArray(p))) return 'null'; cur = p[ag]; if (!cur) return 'null'; } return cur; } catch { return 'null'; }
        }, alias: ['ele'], description: ''
    });
    registerFunction({ name: 'arrayshift', callback: (s, m, a) => { const ar = parseArray(a[0]); ar.shift(); return makeArr(ar); }, alias: ['arrayshift'], description: '' });
    registerFunction({ name: 'arraypop', callback: (s, m, a) => { const ar = parseArray(a[0]); ar.pop(); return makeArr(ar); }, alias: ['arraypop'], description: '' });
    registerFunction({ name: 'arraypush', callback: (s, m, a) => { const ar = parseArray(a[0]); ar.push(a[1]); return makeArr(ar); }, alias: ['arraypush'], description: '' });
    registerFunction({ name: 'arraysplice', callback: (s, m, a) => { const ar = parseArray(a[0]); ar.splice(Number(a[1]), Number(a[2]), a[3]); return makeArr(ar); }, alias: ['arraysplice'], description: '' });
    registerFunction({ name: 'arrayassert', callback: (s, m, a) => { const ar = parseArray(a[0]); const i = Number(a[1]); if (i >= ar.length) ar[i] = a[2]; return makeArr(ar); }, alias: ['arrayassert'], description: '' });
    registerFunction({ name: 'makearray', callback: (s, m, a) => makeArr(a), alias: ['array', 'a', 'makearray'], description: '' });
    registerFunction({
        name: 'makedict', callback: (s, m, a) => {
            let o = {}; for (let i = 0; i < a.length; i++) { const c = a[i], eq = c.indexOf('='); if (eq === -1) continue; o[c.substring(0, eq)] = c.substring(eq + 1) || 'null'; } return JSON.stringify(o);
        }, alias: ['dict', 'd', 'makedict', 'makeobject', 'object', 'o'], description: ''
    });

    // ─── Chat history/info ───
    registerFunction({
        name: 'previouschatlog', callback: (s, m, a) => {
            const sc = getDatabase().characters[getSelectedCharID()];
            return sc?.chats?.[sc.chatPage]?.message[Number(a[0])]?.data || 'Out of range';
        }, alias: ['previous_chat_log'], description: ''
    });

    registerFunction({
        name: 'emotionlist', callback: (s, m, a) => {
            const sc = getDatabase().characters[getSelectedCharID()]; if (!sc) return '';
            return makeArr(sc.emotionImages?.map(f => f[0])) || '';
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'assetlist', callback: (s, m, a) => {
            const sc = getDatabase().characters[getSelectedCharID()]; if (!sc || sc.type === 'group') return '';
            return makeArr(sc.additionalAssets?.map(f => f[0]));
        }, alias: [], description: ''
    });

    registerFunction({ name: 'prefillsupported', callback: () => getDatabase().aiModel.startsWith('claude') ? '1' : '0', alias: ['prefill_supported', 'prefill'], description: '' });

    // ─── Screen (server defaults) ───
    registerFunction({ name: 'screenwidth', callback: () => '1920', alias: ['screen_width'], description: '' });
    registerFunction({ name: 'screenheight', callback: () => '1080', alias: ['screen_height'], description: '' });

    // ─── Special characters ───
    registerFunction({ name: 'cbr', callback: (s, m, a) => { if (a.length > 0) return s.repeat(Math.max(1, Number(a[0]))); return '\\n'; }, alias: ['cnl', 'cnewline'], description: '' });
    registerFunction({ name: 'decbo', callback: () => '\uE9b8', alias: ['displayescapedcurlybracketopen'], description: '' });
    registerFunction({ name: 'decbc', callback: () => '\uE9b9', alias: ['displayescapedcurlybracketclose'], description: '' });
    registerFunction({ name: 'bo', callback: () => '\uE9b8\uE9b8', alias: ['ddecbo', 'doubledisplayescapedcurlybracketopen'], description: '' });
    registerFunction({ name: 'bc', callback: () => '\uE9b9\uE9b9', alias: ['ddecbc', 'doubledisplayescapedcurlybracketclose'], description: '' });
    registerFunction({ name: 'displayescapedbracketopen', callback: () => '\uE9BA', alias: ['debo', '('], description: '' });
    registerFunction({ name: 'displayescapedbracketclose', callback: () => '\uE9BB', alias: ['debc', ')'], description: '' });
    registerFunction({ name: 'displayescapedanglebracketopen', callback: () => '\uE9BC', alias: ['deabo', '<'], description: '' });
    registerFunction({ name: 'displayescapedanglebracketclose', callback: () => '\uE9BD', alias: ['deabc', '>'], description: '' });
    registerFunction({ name: 'displayescapedcolon', callback: () => '\uE9BE', alias: ['dec', ':'], description: '' });
    registerFunction({ name: 'displayescapedsemicolon', callback: () => '\uE9BF', alias: [';'], description: '' });

    registerFunction({
        name: 'chardisplayasset', callback: (s, m, a) => {
            const sc = getDatabase().characters[getSelectedCharID()]; if (!sc?.prebuiltAssetCommand) return makeArr([]);
            const ex = sc.prebuiltAssetExclude || [];
            return makeArr((sc.additionalAssets || []).filter(f => !ex.includes(f[1])).map(f => f[0]));
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'history', callback: (s, m, a) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
            if (a.length === 0) {
                return makeArr([{ role: 'char', data: chat.fmIndex === -1 ? sc.firstMessage : sc.alternateGreetings[chat.fmIndex] }]
                    .concat(chat.message).map(v => { v = sClone(v); v.data = risuChatParser(v.data, m); return JSON.stringify(v); }));
            }
            return makeArr(chat.message.map(f => { let d = ''; if (a.includes('role')) d += f.role + ': '; d += f.data; return d; }));
        }, alias: ['messages'], description: ''
    });

    registerFunction({
        name: 'range', callback: (s, m, a) => {
            const ar = parseArray(a[0]); const st = ar.length > 1 ? Number(ar[0]) : 0; const en = ar.length > 1 ? Number(ar[1]) : Number(ar[0]);
            const step = ar.length > 2 ? Number(ar[2]) : 1; let o = []; for (let i = st; i < en; i += step)o.push(i.toString()); return makeArr(o);
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'date', callback: (s, m, a) => {
            if (a.length === 0) { const n = new Date(); return `${n.getFullYear()}-${n.getMonth() + 1}-${n.getDate()}`; }
            let t = 0; if (a[1]) { t = Number(a[1]) / 1000; if (isNaN(t)) t = 0; } return dtf(a[0], t);
        }, alias: ['datetimeformat'], description: ''
    });

    registerFunction({
        name: 'time', callback: (s, m, a) => {
            if (a.length === 0) { const n = new Date(); return `${n.getHours()}:${n.getMinutes()}:${n.getSeconds()}`; }
            let t = 0; if (a[1]) { t = Number(a[1]) / 1000; if (isNaN(t)) t = 0; } return dtf(a[0], t);
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'moduleenabled', callback: (s, m, a) => {
            return getModules()?.some(f => f.namespace === a[0]) ? '1' : '0';
        }, alias: ['module_enabled'], description: ''
    });

    registerFunction({
        name: 'moduleassetlist', callback: (s, m, a) => {
            const mod = getModules()?.find(f => f.namespace === a[0]); if (!mod) return '';
            return makeArr(mod.assets?.map(f => f[0]));
        }, alias: ['module_assetlist'], description: ''
    });

    // ─── Filter/Aggregation ───
    registerFunction({
        name: 'filter', callback: (s, m, a) => {
            const ar = parseArray(a[0]); const types = ['all', 'nonempty', 'unique']; let ft = types.indexOf(a[1]); if (ft === -1) ft = 0;
            return makeArr(ar.filter((f, i) => { switch (ft) { case 0: return f !== '' && i === ar.indexOf(f); case 1: return f !== ''; case 2: return i === ar.indexOf(f); }return true; }));
        }, alias: [], description: ''
    });
    registerFunction({ name: 'all', callback: (s, m, a) => { const ar = a.length > 1 ? a : parseArray(a[0]); return ar.every(f => f === '1') ? '1' : '0'; }, alias: [], description: '' });
    registerFunction({ name: 'any', callback: (s, m, a) => { const ar = a.length > 1 ? a : parseArray(a[0]); return ar.some(f => f === '1') ? '1' : '0'; }, alias: [], description: '' });
    registerFunction({ name: 'min', callback: (s, m, a) => { const v = a.length > 1 ? a : parseArray(a[0]); return Math.min(...v.map(f => { const n = Number(f); return isNaN(n) ? 0 : n; })).toString(); }, alias: [], description: '' });
    registerFunction({ name: 'max', callback: (s, m, a) => { const v = a.length > 1 ? a : parseArray(a[0]); return Math.max(...v.map(f => { const n = Number(f); return isNaN(n) ? 0 : n; })).toString(); }, alias: [], description: '' });
    registerFunction({ name: 'sum', callback: (s, m, a) => { const v = a.length > 1 ? a : parseArray(a[0]); return v.map(f => { const n = Number(f); return isNaN(n) ? 0 : n; }).reduce((x, y) => x + y, 0).toString(); }, alias: [], description: '' });
    registerFunction({ name: 'average', callback: (s, m, a) => { const v = a.length > 1 ? a : parseArray(a[0]); const sm = v.map(f => { const n = Number(f); return isNaN(n) ? 0 : n; }).reduce((x, y) => x + y, 0); return (sm / v.length).toString(); }, alias: [], description: '' });

    // ─── Unicode/Encoding ───
    registerFunction({ name: 'unicodeencode', callback: (s, m, a) => a[0].charCodeAt(a[1] ? Number(a[1]) : 0).toString(), alias: ['unicode_encode'], description: '' });
    registerFunction({ name: 'unicodedecode', callback: (s, m, a) => String.fromCharCode(Number(a[0])), alias: ['unicode_decode'], description: '' });
    registerFunction({ name: 'u', callback: (s, m, a) => String.fromCharCode(parseInt(a[0], 16)), alias: ['unicodedecodefromhex'], description: '' });
    registerFunction({ name: 'ue', callback: (s, m, a) => String.fromCharCode(parseInt(a[0], 16)), alias: ['unicodeencodefromhex'], description: '' });
    registerFunction({ name: 'fromhex', callback: (s, m, a) => Number.parseInt(a[0], 16).toString(), alias: [], description: '' });
    registerFunction({ name: 'tohex', callback: (s, m, a) => Number.parseInt(a[0]).toString(16), alias: [], description: '' });

    // ─── Hash/Random ───
    registerFunction({ name: 'hash', callback: (s, m, a) => ((pickHR(0, a[0]) * 10000000) + 1).toFixed(0).padStart(7, '0'), alias: [], description: '' });
    registerFunction({ name: 'randint', callback: (s, m, a) => { const mn = Number(a[0]), mx = Number(a[1]); if (isNaN(mn) || isNaN(mx)) return 'NaN'; return (Math.floor(Math.random() * (mx - mn + 1)) + mn).toString(); }, alias: [], description: '' });
    registerFunction({ name: 'dice', callback: (s, m, a) => { const n = a[0].split('d'); const nm = Number(n[0]), si = Number(n[1]); if (isNaN(nm) || isNaN(si)) return 'NaN'; let t = 0; for (let i = 0; i < nm; i++)t += Math.floor(Math.random() * si) + 1; return t.toString(); }, alias: [], description: '' });

    const randomPickImpl = (s, m, a, rand) => {
        if (a.length === 0) return rand.toString();
        let ar; if (a.length === 1) { if (a[0].startsWith('[') && a[0].endsWith(']')) ar = parseArray(a[0]); else ar = a[0].replace(/\\,/g, '\u00A7X').split(/\:|\,/g); } else ar = a;
        const idx = m.tokenizeAccurate ? 0 : Math.floor(rand * ar.length); const el = ar[idx];
        return typeof el === 'string' ? el.replace(/\u00A7X/g, ',') : JSON.stringify(el) || '';
    };
    registerFunction({ name: 'random', callback: (s, m, a) => randomPickImpl(s, m, a, Math.random()), alias: [], description: '' });
    registerFunction({
        name: 'pick', callback: (s, m, a) => {
            const db = getDatabase(); const sc = db.characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
            return randomPickImpl(s, m, a, pickHR(chat.message.length, sc.chaId + (chat.id || '')));
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'roll', callback: (s, m, a) => {
            if (a.length === 0) return '1'; const n = a[0].split('d'); let nm = 1, si = 6;
            if (n.length === 2) { nm = Number(n[0] || 1); si = Number(n[1] || 6); } else si = Number(n[0]);
            if (isNaN(nm) || isNaN(si) || nm < 1 || si < 1) return 'NaN'; let t = 0; for (let i = 0; i < nm; i++)t += Math.floor(Math.random() * si) + 1; return t.toString();
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'rollp', callback: (s, m, a) => {
            if (a.length === 0) return '1'; const n = a[0].split('d'); let nm = 1, si = 6;
            if (n.length === 2) { nm = Number(n[0] || 1); si = Number(n[1] || 6); } else si = Number(n[0]);
            if (isNaN(nm) || isNaN(si) || nm < 1 || si < 1) return 'NaN'; let t = 0;
            for (let i = 0; i < nm; i++) {
                const db = getDatabase(); const sc = db.characters[getSelectedCharID()]; const chat = sc.chats[sc.chatPage];
                t += Math.floor(pickHR(chat.message.length + (i * 15), sc.chaId + (chat.id || '')) * si) + 1;
            }
            return t.toString();
        }, alias: ['rollpick'], description: ''
    });

    // ─── Metadata ───
    registerFunction({
        name: 'metadata', callback: (s, m, a) => {
            const db = getDatabase();
            switch (a[0].toLocaleLowerCase()) {
                case 'mobile': return isMobile ? '1' : '0';
                case 'local': return isTauri ? '1' : '0';
                case 'node': return isNodeServer ? '1' : '0';
                case 'version': return appVer;
                case 'majorversion': case 'majorver': case 'major': return appVer.split('.')[0];
                case 'language': case 'locale': case 'lang': return db.language;
                case 'browserlanguage': case 'browserlocale': case 'browserlang': return 'en';
                case 'modelshortname': { const mi = getModelInfo(db.aiModel); return mi.shortName || mi.name || mi.id; }
                case 'modelname': { const mi = getModelInfo(db.aiModel); return mi.name || mi.id; }
                case 'modelinternalid': { const mi = getModelInfo(db.aiModel); return mi.internalID || mi.id; }
                case 'modelformat': { return getModelInfo(db.aiModel).format.toString(); }
                case 'modelprovider': { return getModelInfo(db.aiModel).provider.toString(); }
                case 'modeltokenizer': { return getModelInfo(db.aiModel).tokenizer.toString(); }
                case 'imateapot': return '\uD83E\uDED6';
                case 'risutype': return 'node';
                case 'maxcontext': return db.maxContext.toString();
                default: return `Error: ${a[0]} is not a valid metadata key.`;
            }
        }, alias: [], description: ''
    });

    registerFunction({ name: 'iserror', callback: (s, m, a) => a[0].toLocaleLowerCase().startsWith('error:') ? '1' : '0', alias: [], description: '' });

    // ─── XOR/Crypt ───
    registerFunction({
        name: 'xor', callback: (s, m, a) => {
            const buf = Buffer.from(a[0], 'utf-8'); for (let i = 0; i < buf.length; i++)buf[i] ^= 0xFF; return buf.toString('base64');
        }, alias: ['xorencrypt', 'xorencode', 'xore'], description: ''
    });
    registerFunction({
        name: 'xordecrypt', callback: (s, m, a) => {
            const buf = Buffer.from(a[0], 'base64'); for (let i = 0; i < buf.length; i++)buf[i] ^= 0xFF; return buf.toString('utf-8');
        }, alias: ['xordecode', 'xord'], description: ''
    });
    registerFunction({
        name: 'crypt', callback: (s, m, a) => {
            let sh = a[1] ? Number(a[1]) : 32768; if (isNaN(sh)) sh = 32768; let r = '';
            for (let i = 0; i < a[0].length; i++) {
                const cc = a[0].charCodeAt(i); if (cc > 65535) { r += a[0][i]; continue; }
                let sc = cc + sh; if (sc > 65535) sc -= 65536; r += String.fromCharCode(sc);
            } return r;
        }, alias: ['crypto', 'caesar', 'encrypt', 'decrypt'], description: ''
    });

    // ─── Misc ───
    registerFunction({ name: 'hiddenkey', callback: () => '', alias: [], description: '' });
    registerFunction({ name: 'reverse', callback: (s) => [...s].reverse().join(''), alias: [], description: '' });
    registerFunction({ name: 'comment', callback: (s, m, a) => { if (!m.displaying) return ''; return `<div class="risu-comment">${a[0]}</div>`; }, alias: [], description: '' });
    registerFunction({ name: 'tex', callback: (s, m, a) => `$$${a[0]}$$`, alias: ['latex', 'katex'], description: '' });
    registerFunction({ name: 'ruby', callback: (s, m, a) => `<ruby>${a[0]}<rp> (</rp><rt>${a[1]}</rt><rp>) </rp></ruby>`, alias: ['furigana'], description: '' });
    registerFunction({
        name: 'codeblock', callback: (s, m, a) => {
            let code = a[a.length - 1].replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            if (a.length > 1) return `<pre-hljs-placeholder lang="${a[0]}">` + code + '</pre-hljs-placeholder>';
            return `<pre><code>${code}</code></pre>`;
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'bkspc', callback: (s, m, a) => {
            let root = m.getNested?.()?.[0]; if (!root) return ''; root = root.trimEnd();
            let tp = root.length - 1; for (; tp >= 0; tp--) { const c = root[tp]; if (tp === 0) break; if (c === ' ' || c === '\n' || c === '\t') break; }
            if (tp === -1) tp = 0; m.setNestedRoot?.(root.substring(0, tp).trimEnd()); return '';
        }, alias: [], description: ''
    });

    registerFunction({
        name: 'erase', callback: (s, m, a) => {
            let root = m.getNested?.()?.[0]; if (!root) return ''; root = root.trimEnd();
            let tp = root.length - 1, found = false;
            for (; tp >= 0; tp--) { const c = root[tp]; if (c === '.' || c === '!' || c === '?' || c === '\n') { found = true; break; } if (tp === 0) break; }
            if (tp === -1) tp = 0; else if (found) tp += 1;
            m.setNestedRoot?.(root.substring(0, tp).trimEnd()); return '';
        }, alias: [], description: ''
    });

    registerFunction({ name: 'declare', callback: (s, m, a, v) => { m.var[`__declared_${a[0]}__`] = '1'; return ''; }, alias: [], description: '' });
    registerFunction({ name: '//', callback: 'doc_only', alias: [], description: '' });
    registerFunction({ name: '?', callback: 'doc_only', alias: [], description: '' });
    registerFunction({ name: '__', callback: (s, m, a) => callInternalFunction(a), alias: [], description: '', internalOnly: true });

    // ─── doc_only (display-only asset functions) ───
    const docOnlyNames = ['asset', 'emotion', 'audio', 'bg', 'bgm', 'video', 'video-img', 'image', 'img', 'path', 'inlay', 'inlayed', 'inlayeddata', 'source', '#if', '#if_pure', '#when', '#each', '#func'];
    for (const name of docOnlyNames) { registerFunction({ name, callback: 'doc_only', alias: [], description: '' }); }
}


/**
 * Creates a server-side CBSRegisterArg and initializes the CBS matcherMap.
 * 
 * @param {object} opts
 * @param {object} opts.db - Full Database object
 * @param {number} opts.charIndex - Selected character index
 * @param {Function} opts.risuChatParser - Server-side parser function
 * @param {Function} [opts.getModules] - Returns active RisuModule[]
 * @param {Function} [opts.getModuleLorebooks] - Returns loreBook[]
 * @param {Function} [opts.getModelInfo] - Returns LLMModel for a model string
 * @param {string} [opts.appVer] - Application version
 * @returns {{matcherMap: Map<string, Function>}} Initialized matcherMap
 */
function createServerCBS(opts) {
    const { db, charIndex, risuChatParser: parser } = opts;
    const matcherMap = new Map();

    const boundGetCV = (key) => getChatVar(key, db, charIndex);
    const boundSetCV = (key, val) => setChatVar(key, val, db, charIndex);
    const boundGetGCV = (key) => getGlobalChatVar(key, db);
    const boundCalcString = createCalcString(boundGetCV, boundGetGCV);

    const char = db.characters[charIndex];
    const getUserName = () => db.username || db.userName || 'User';
    const getPersonaPrompt = () => db.personaPrompt || '';

    registerCBS({
        registerFunction: (arg) => {
            const cb = arg.callback;
            if (cb === 'doc_only') return;
            const names = [arg.name, ...arg.alias];
            for (const name of names) { matcherMap.set(name, cb); }
        },
        getDatabase: () => db,
        getUserName,
        getPersonaPrompt,
        risuChatParser: parser || ((text) => text),
        makeArray,
        safeStructuredClone,
        parseArray: parseArraySafe,
        parseDict: parseDictSafe,
        getChatVar: boundGetCV,
        setChatVar: boundSetCV,
        getGlobalChatVar: boundGetGCV,
        calcString: boundCalcString,
        dateTimeFormat,
        getModules: opts.getModules || (() => []),
        getModuleLorebooks: opts.getModuleLorebooks || (() => []),
        pickHashRand,
        getSelectedCharID: () => charIndex,
        getModelInfo: opts.getModelInfo || ((model) => ({
            id: model, name: model, shortName: model, internalID: model,
            format: 0, provider: 0, tokenizer: 0
        })),
        callInternalFunction: (args) => '',
        isTauri: false,
        isNodeServer: true,
        isMobile: false,
        appVer: opts.appVer || '0.0.0',
    });

    return { matcherMap };
}

module.exports = {
    registerCBS,
    createServerCBS,
};
