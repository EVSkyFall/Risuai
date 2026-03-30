/**
 * serverRisuSave.cjs — Server-side RISUSAVE format decoder/encoder
 * 
 * Handles reading and writing the RisuAI database binary format.
 * Port of risuSave.ts for Node.js CJS environment.
 * 
 * Format:
 *   RISUSAVE\0  (9 bytes header)
 *   [Block]*    (concatenated blocks)
 * 
 * Block:
 *   [type:u8] [compression:u8] [nameLen:u8] [name:utf8] [dataLen:u32LE] [data:bytes]
 * 
 * Block types:
 *   0=CONFIG, 1=ROOT, 2=CHARACTER_WITH_CHAT, 3=CHAT,
 *   4=BOTPRESET, 5=MODULES, 6=REMOTE, 7=CHARACTER_WITHOUT_CHAT, 8=ROOT_COMPONENT
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

// ─── Constants ───
const MAGIC_HEADER = Buffer.from('RISUSAVE\0', 'utf-8');
const LEGACY_RAW_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const LEGACY_COMP_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const LEGACY_STREAM_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);

const SaveType = {
    CONFIG: 0,
    ROOT: 1,
    CHARACTER_WITH_CHAT: 2,
    CHAT: 3,
    BOTPRESET: 4,
    MODULES: 5,
    REMOTE: 6,
    CHARACTER_WITHOUT_CHAT: 7,
    ROOT_COMPONENT: 8,
};

const savePath = path.join(process.cwd(), 'save');

// ─── msgpackr (optional) ───
let msgpackr = null;
try {
    msgpackr = require('msgpackr');
} catch (e) {
    // Will be needed only for legacy formats
}

// ─── Header detection ───
function checkHeader(buf) {
    if (buf.length < MAGIC_HEADER.length) return 'none';

    // Check RISUSAVE header first
    if (buf.slice(0, MAGIC_HEADER.length).equals(MAGIC_HEADER)) return 'risusave';
    if (buf.slice(0, LEGACY_RAW_HEADER.length).equals(LEGACY_RAW_HEADER)) return 'raw';
    if (buf.slice(0, LEGACY_COMP_HEADER.length).equals(LEGACY_COMP_HEADER)) return 'compressed';
    if (buf.slice(0, LEGACY_STREAM_HEADER.length).equals(LEGACY_STREAM_HEADER)) return 'stream';
    return 'none';
}

// ─── Decode RISUSAVE blocks ───
function decodeBlocks(buf) {
    const blocks = [];
    let offset = MAGIC_HEADER.length;

    while (offset < buf.length) {
        try {
            const type = buf[offset];
            const compression = buf[offset + 1] === 1;
            offset += 2;

            const nameLength = buf[offset];
            offset += 1;
            const name = buf.slice(offset, offset + nameLength).toString('utf-8');
            offset += nameLength;

            const dataLength = buf.readUInt32LE(offset);
            offset += 4;

            let blockData = buf.slice(offset, offset + dataLength);
            offset += dataLength;

            if (compression) {
                blockData = zlib.gunzipSync(blockData);
            }

            blocks.push({
                name,
                type,
                compression,
                content: blockData.toString('utf-8'),
            });
        } catch (e) {
            console.error('[RisuSave] Block decode error at offset', offset, e.message);
            break;
        }
    }
    return blocks;
}

// ─── Read remote file (Node server stores characters as separate files) ───
async function readRemoteFile(name) {
    // On Node server, remote files are stored via NodeStorage (hex-encoded keys)
    const key = `remotes/${name}.local.bin`;
    const hexKey = Buffer.from(key, 'utf-8').toString('hex');
    const filePath = path.join(savePath, hexKey);

    try {
        if (fs.existsSync(filePath)) {
            return await fsp.readFile(filePath);
        }
    } catch (e) {
        console.error(`[RisuSave] Failed to read remote file ${key}:`, e.message);
    }
    return null;
}

// ─── Write remote file ───
async function writeRemoteFile(name, data) {
    const key = `remotes/${name}.local.bin`;
    const hexKey = Buffer.from(key, 'utf-8').toString('hex');
    const filePath = path.join(savePath, hexKey);

    try {
        await fsp.writeFile(filePath, data);
        return true;
    } catch (e) {
        console.error(`[RisuSave] Failed to write remote file ${key}:`, e.message);
        return false;
    }
}

// ─── Full database decode ───
async function decodeDatabase(buf) {
    const header = checkHeader(buf);

    switch (header) {
        case 'risusave':
            return await decodeRisuSaveFormat(buf);
        case 'raw': {
            if (!msgpackr) throw new Error('msgpackr required for legacy raw format');
            const data = buf.slice(LEGACY_RAW_HEADER.length);
            const unpackr = new msgpackr.Unpackr({ int64AsType: 'number', useRecords: false });
            return unpackr.decode(data);
        }
        case 'compressed': {
            if (!msgpackr) throw new Error('msgpackr required for legacy compressed format');
            const data = zlib.inflateSync(buf.slice(LEGACY_COMP_HEADER.length));
            const unpackr = new msgpackr.Unpackr({ int64AsType: 'number', useRecords: false });
            return unpackr.decode(data);
        }
        case 'stream': {
            if (!msgpackr) throw new Error('msgpackr required for legacy stream format');
            const data = zlib.gunzipSync(buf.slice(LEGACY_STREAM_HEADER.length));
            const unpackr = new msgpackr.Unpackr({ int64AsType: 'number', useRecords: false });
            return unpackr.decode(data);
        }
        default:
            // Try JSON as last resort
            try {
                return JSON.parse(buf.toString('utf-8'));
            } catch (e) {
                throw new Error('Unknown database format');
            }
    }
}

async function decodeRisuSaveFormat(buf) {
    const blocks = decodeBlocks(buf);
    const db = {};
    const loadedNames = new Set(blocks.map(b => b.name));

    // First pass: process all blocks
    for (const block of blocks) {
        switch (block.type) {
            case SaveType.ROOT: {
                const rootData = JSON.parse(block.content);
                for (const key in rootData) {
                    if (!key.startsWith('__')) {
                        db[key] = rootData[key];
                    }
                    if (key === '__directory') {
                        // Load missing remote blocks
                        const directory = rootData[key];
                        for (const dirKey of directory) {
                            if (!loadedNames.has(dirKey)) {
                                const remoteData = await readRemoteFile(dirKey);
                                if (remoteData) {
                                    blocks.push({
                                        name: dirKey,
                                        type: SaveType.CHARACTER_WITH_CHAT,
                                        compression: false,
                                        content: remoteData.toString('utf-8'),
                                    });
                                    loadedNames.add(dirKey);
                                }
                            }
                        }
                    }
                }
                break;
            }
            case SaveType.CHARACTER_WITH_CHAT:
            case SaveType.CHARACTER_WITHOUT_CHAT: {
                db.characters = db.characters || [];
                db.characters.push(JSON.parse(block.content));
                break;
            }
            case SaveType.BOTPRESET: {
                db.botPresets = JSON.parse(block.content);
                break;
            }
            case SaveType.MODULES: {
                db.modules = JSON.parse(block.content);
                break;
            }
            case SaveType.REMOTE: {
                const remoteInfo = JSON.parse(block.content);
                const remoteData = await readRemoteFile(remoteInfo.name);
                if (remoteData) {
                    // Re-add as the actual type for processing
                    blocks.push({
                        name: remoteInfo.name,
                        type: remoteInfo.type,
                        compression: false,
                        content: remoteData.toString('utf-8'),
                    });
                }
                break;
            }
            case SaveType.ROOT_COMPONENT: {
                const comp = JSON.parse(block.content);
                db[comp.key] = comp.data;
                break;
            }
            case SaveType.CONFIG:
                break;
            default:
                console.warn(`[RisuSave] Unknown block type ${block.type} for ${block.name}`);
        }
    }

    db.characters = db.characters || [];
    return db;
}

// ─── Encode a single block ───
function encodeBlock(type, name, data, compress = false) {
    let dataBuf;
    if (compress) {
        dataBuf = zlib.gzipSync(Buffer.from(data, 'utf-8'));
    } else {
        dataBuf = Buffer.from(data, 'utf-8');
    }

    const nameBuf = Buffer.from(name, 'utf-8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(dataBuf.length, 0);

    // [type:1] [compression:1] [nameLen:1] [name:N] [dataLen:4] [data:M]
    const block = Buffer.alloc(2 + 1 + nameBuf.length + 4 + dataBuf.length);
    block[0] = type;
    block[1] = compress ? 1 : 0;
    block[2] = nameBuf.length;
    nameBuf.copy(block, 3);
    lengthBuf.copy(block, 3 + nameBuf.length);
    dataBuf.copy(block, 7 + nameBuf.length);

    return block;
}

// ─── Encode full database to RISUSAVE format ───
async function encodeDatabase(db) {
    const blocks = [];

    // Config block
    blocks.push(encodeBlock(SaveType.CONFIG, 'config', JSON.stringify({ version: 1 })));

    // Characters as REMOTE blocks (Node server pattern)
    const directory = [];
    for (const char of (db.characters || [])) {
        const chaId = char.chaId || `char_${Date.now()}`;
        const charData = JSON.stringify(char);

        // Save character data as remote file
        await writeRemoteFile(chaId, charData);

        // Add REMOTE pointer block
        blocks.push(encodeBlock(SaveType.REMOTE, chaId, JSON.stringify({
            v: 1,
            type: SaveType.CHARACTER_WITH_CHAT,
            name: chaId,
        })));
        directory.push(chaId);
    }

    // Bot presets
    if (db.botPresets) {
        blocks.push(encodeBlock(SaveType.BOTPRESET, 'preset', JSON.stringify(db.botPresets)));
        directory.push('preset');
    }

    // Modules
    if (db.modules) {
        blocks.push(encodeBlock(SaveType.MODULES, 'modules', JSON.stringify(db.modules)));
        directory.push('modules');
    }

    // ROOT block (everything except characters, botPresets, modules)
    const rootObj = {};
    for (const key of Object.keys(db)) {
        if (key !== 'characters' && key !== 'botPresets' && key !== 'modules') {
            rootObj[key] = db[key];
        }
    }
    rootObj['__directory'] = directory;
    blocks.push(encodeBlock(SaveType.ROOT, 'root', JSON.stringify(rootObj)));

    // Assemble: header + all blocks
    const totalLength = MAGIC_HEADER.length + blocks.reduce((sum, b) => sum + b.length, 0);
    const result = Buffer.alloc(totalLength);
    let offset = 0;
    MAGIC_HEADER.copy(result, offset);
    offset += MAGIC_HEADER.length;
    for (const block of blocks) {
        block.copy(result, offset);
        offset += block.length;
    }

    return result;
}

// ─── High-level API ───

/**
 * Load database from save directory.
 * @returns {Promise<Object>} The decoded database object
 */
async function loadDatabaseFromDisk() {
    const dbKey = 'database/database.bin';
    const hexKey = Buffer.from(dbKey, 'utf-8').toString('hex');
    const filePath = path.join(savePath, hexKey);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Database file not found: ${filePath}`);
    }

    const buf = await fsp.readFile(filePath);
    return await decodeDatabase(buf);
}

/**
 * Save database to disk in RISUSAVE format.
 * @param {Object} db - The database object to save
 */
async function saveDatabaseToDisk(db) {
    const encoded = await encodeDatabase(db);
    const dbKey = 'database/database.bin';
    const hexKey = Buffer.from(dbKey, 'utf-8').toString('hex');
    const filePath = path.join(savePath, hexKey);

    await fsp.writeFile(filePath, encoded);
    console.log(`[RisuSave] Database saved (${encoded.length} bytes, ${(db.characters || []).length} characters)`);
}

/**
 * Update only a specific character's chat data (efficient partial save).
 * Reads the current DB, updates the character, and writes back.
 * @param {number} charIndex - Character index
 * @param {Object} chatUpdate - Updated chat data { message: [...] }
 * @param {number} chatPage - Chat page index (default 0)
 */
async function updateCharacterChat(charIndex, chatUpdate, chatPage = 0) {
    // Use memory cache instead of disk read for performance
    let dbCache;
    try { dbCache = require('./serverDbCache.cjs'); } catch (e) { dbCache = null; }

    let char;
    if (dbCache) {
        const db = await dbCache.getDb();
        char = db.characters[charIndex];
        if (!char) throw new Error(`Character not found at index ${charIndex}`);

        char.chats[chatPage] = { ...char.chats[chatPage], ...chatUpdate };

        const chaId = char.chaId;
        if (chaId) {
            // Update cache + schedule async disk flush (no blocking I/O)
            dbCache.updateChar(chaId, char);
            console.log(`[RisuSave] Character ${chaId} chat updated via cache (${chatUpdate.message?.length || 0} messages)`);
        } else {
            await saveDatabaseToDisk(db);
        }
        return db;
    }

    // Fallback: original disk-based path
    const db = await loadDatabaseFromDisk();
    char = db.characters[charIndex];
    if (!char) throw new Error(`Character not found at index ${charIndex}`);

    char.chats[chatPage] = { ...char.chats[chatPage], ...chatUpdate };

    const chaId = char.chaId;
    if (chaId) {
        await writeRemoteFile(chaId, JSON.stringify(char));
        console.log(`[RisuSave] Character ${chaId} chat updated (${chatUpdate.message?.length || 0} messages)`);
    } else {
        await saveDatabaseToDisk(db);
    }
    return db;
}


module.exports = {
    loadDatabaseFromDisk,
    saveDatabaseToDisk,
    updateCharacterChat,
    decodeDatabase,
    encodeDatabase,
    SaveType,
    readRemoteFile,
    writeRemoteFile,
};
