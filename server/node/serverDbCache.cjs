/**
 * serverDbCache.cjs
 * 
 * In-memory cache for the RisuAI database and character remote files.
 * Handles debounced disk writes for performance and manages memory synchronization.
 */

const fs = require('fs');
const path = require('path');
const serverRisuSave = require('./serverRisuSave.cjs');

let cachedDb = null;
const charCache = new Map();
const dirtyChars = new Set();
let flushTimer = null;

async function getDb() {
    if (cachedDb) return cachedDb;
    cachedDb = await serverRisuSave.loadDatabaseFromDisk();
    return cachedDb;
}

async function getChar(chaId) {
    if (charCache.has(chaId)) return charCache.get(chaId);

    const rawData = await serverRisuSave.readRemoteFile(chaId);
    if (!rawData) return null;

    try {
        const charData = JSON.parse(rawData.toString('utf-8'));
        charCache.set(chaId, charData);
        return charData;
    } catch (e) {
        console.error(`[DbCache] Failed to parse character JSON for ${chaId}:`, e.message);
        return null;
    }
}

function updateChar(chaId, charData) {
    charCache.set(chaId, charData);
    dirtyChars.add(chaId);

    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushDirty().catch(e => console.error('[DbCache] Flush error:', e));
    }, 5000);
}

function invalidateDb() {
    cachedDb = null;
    console.log('[DbCache] Database cache invalidated');
}

function invalidateChar(chaId) {
    charCache.delete(chaId);
    dirtyChars.delete(chaId);
    console.log(`[DbCache] Character ${chaId} cache invalidated`);
}

async function flushDirty() {
    if (dirtyChars.size === 0) return;

    // Snapshot dirty set — remove from dirtyChars immediately so new
    // updateChar calls during the async loop will re-add to dirtyChars
    const toFlush = new Set(dirtyChars);
    for (const chaId of toFlush) {
        dirtyChars.delete(chaId);
    }
    console.log(`[DbCache] Flushing ${toFlush.size} dirty characters to disk...`);
    for (const chaId of toFlush) {
        const charData = charCache.get(chaId);
        if (charData) {
            await serverRisuSave.writeRemoteFile(chaId, JSON.stringify(charData));
        }
    }
    if (flushTimer && dirtyChars.size === 0) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

function shutdown() {
    if (dirtyChars.size === 0) return;
    console.log(`[DbCache] Graceful shutdown: syncing ${dirtyChars.size} characters to disk synchronously...`);

    const savePath = path.join(process.cwd(), 'save');
    for (const chaId of dirtyChars) {
        const charData = charCache.get(chaId);
        if (charData) {
            const key = `remotes/${chaId}.local.bin`;
            const hexKey = Buffer.from(key, 'utf-8').toString('hex');
            const filePath = path.join(savePath, hexKey);
            try {
                fs.writeFileSync(filePath, JSON.stringify(charData));
            } catch (e) {
                console.error(`[DbCache] Failed sync write for ${chaId}:`, e.message);
            }
        }
    }
    dirtyChars.clear();
}

// Note: shutdown() is called by server.cjs SIGTERM/SIGINT handlers.
// Do NOT register process event handlers here to avoid double-flush.

module.exports = {
    getDb,
    getChar,
    updateChar,
    invalidateDb,
    invalidateChar,
    flushDirty,
    shutdown
};
