/**
 * chatArchive.cjs
 * 
 * Handles moving old chat messages out of the active character file
 * and into paginated archive files to keep the main DB/character file small.
 */

const fs = require('fs/promises');
const path = require('path');
const dbCache = require('./serverDbCache.cjs');

const ARCHIVE_THRESHOLD = 500;
const KEEP_RECENT = 200;
const savePath = path.join(process.cwd(), 'save');

async function archiveOldMessages(chaId, chatPage, keepCount = KEEP_RECENT) {
    const char = await dbCache.getChar(chaId);
    if (!char) throw new Error(`[Archive] Character not found: ${chaId}`);

    const chat = char.chats[chatPage];
    if (!chat || !chat.message || chat.message.length <= keepCount) {
        return { archivedCount: 0, remainingCount: chat?.message?.length || 0 };
    }

    const messagesToArchive = chat.message.slice(0, chat.message.length - keepCount);
    const recentMessages = chat.message.slice(chat.message.length - keepCount);

    const timestamp = Date.now();
    const archiveKey = `remotes/${chaId}_archive_${chatPage}_${timestamp}.json`;
    const hexKey = Buffer.from(archiveKey, 'utf-8').toString('hex');
    const filePath = path.join(savePath, hexKey);

    await fs.writeFile(filePath, JSON.stringify(messagesToArchive));
    console.log(`[Archive] Archived ${messagesToArchive.length} messages for ${chaId} (page ${chatPage}) to ${archiveKey}`);

    chat.message = recentMessages;
    dbCache.updateChar(chaId, char);

    return { archivedCount: messagesToArchive.length, remainingCount: recentMessages.length };
}

async function getArchiveInfo(chaId, chatPage) {
    const files = await fs.readdir(savePath);
    const archivePrefix = `remotes/${chaId}_archive_${chatPage}_`;

    const archiveFiles = [];
    let totalArchived = 0;

    for (const fileHex of files) {
        try {
            const key = Buffer.from(fileHex, 'hex').toString('utf-8');
            if (key.startsWith(archivePrefix) && key.endsWith('.json')) {
                const data = await fs.readFile(path.join(savePath, fileHex), 'utf-8');
                const messages = JSON.parse(data);
                totalArchived += messages.length;

                const parts = key.split('_');
                const timestampStr = parts[parts.length - 1].replace('.json', '');
                const timestamp = parseInt(timestampStr, 10);

                archiveFiles.push({
                    key,
                    timestamp,
                    count: messages.length
                });
            }
        } catch (e) {
            // ignore files that don't match
        }
    }

    archiveFiles.sort((a, b) => a.timestamp - b.timestamp);

    let activeCount = 0;
    const char = await dbCache.getChar(chaId);
    if (char && char.chats && char.chats[chatPage] && char.chats[chatPage].message) {
        activeCount = char.chats[chatPage].message.length;
    }

    return { totalArchived, archiveFiles, activeCount };
}

async function loadArchivedMessages(chaId, chatPage, offset = 0, limit = 100) {
    const files = await fs.readdir(savePath);
    const archivePrefix = `remotes/${chaId}_archive_${chatPage}_`;

    // Find and sort matching archive files by timestamp
    const archiveFiles = [];
    for (const fileHex of files) {
        try {
            const key = Buffer.from(fileHex, 'hex').toString('utf-8');
            if (key.startsWith(archivePrefix) && key.endsWith('.json')) {
                const parts = key.split('_');
                const timestampStr = parts[parts.length - 1].replace('.json', '');
                archiveFiles.push({ key, hexKey: fileHex, timestamp: parseInt(timestampStr, 10) });
            }
        } catch (e) { /* not a valid hex filename */ }
    }
    archiveFiles.sort((a, b) => a.timestamp - b.timestamp);

    // Read files sequentially, skip offset, collect limit messages
    let allArchived = [];
    let skipped = 0;

    for (const file of archiveFiles) {
        try {
            const data = await fs.readFile(path.join(savePath, file.hexKey), 'utf-8');
            const messages = JSON.parse(data);

            // Skip entire file if all messages are before offset
            if (skipped + messages.length <= offset) {
                skipped += messages.length;
                continue;
            }

            const startInFile = Math.max(0, offset - skipped);
            const remaining = limit - allArchived.length;
            allArchived = allArchived.concat(messages.slice(startInFile, startInFile + remaining));
            skipped += messages.length;

            if (allArchived.length >= limit) break;
        } catch (e) {
            console.error(`[Archive] Failed to read archive file ${file.key}:`, e.message);
        }
    }

    return allArchived;
}

async function checkAndArchive(chaId, chatPage, messageCount) {
    // Disabled: auto-archive causes data corruption when character indices shift.
    // Archive should only be triggered manually via API if ever re-enabled.
    return null;
}

function registerArchiveRoutes(app, serverPassword) {
    function checkAuth(req, res) {
        const authHeader = req.headers['risu-auth'];
        if (!authHeader || authHeader.trim() !== serverPassword.trim()) {
            res.status(401).json({ error: 'Password Incorrect' });
            return false;
        }
        return true;
    }

    app.post('/api/chat/archive/trigger', async (req, res) => {
        if (!checkAuth(req, res)) return;
        const { chaId, chatPage } = req.body;
        if (!chaId || chatPage === undefined) {
            return res.status(400).json({ error: 'chaId and chatPage required' });
        }

        try {
            const result = await archiveOldMessages(chaId, chatPage, KEEP_RECENT);
            res.json(result);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/chat/archive/load', async (req, res) => {
        if (!checkAuth(req, res)) return;
        const { chaId, chatPage, offset, limit } = req.query;
        if (!chaId || chatPage === undefined) {
            return res.status(400).json({ error: 'chaId and chatPage required' });
        }

        try {
            const messages = await loadArchivedMessages(
                chaId,
                parseInt(chatPage),
                parseInt(offset || 0),
                parseInt(limit || 100)
            );
            res.json({ messages });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/chat/archive/info', async (req, res) => {
        if (!checkAuth(req, res)) return;
        const { chaId, chatPage } = req.query;
        if (!chaId || chatPage === undefined) {
            return res.status(400).json({ error: 'chaId and chatPage required' });
        }

        try {
            const info = await getArchiveInfo(chaId, parseInt(chatPage));
            res.json(info);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[Archive] Archive routes registered');
}

module.exports = {
    ARCHIVE_THRESHOLD,
    KEEP_RECENT,
    archiveOldMessages,
    loadArchivedMessages,
    getArchiveInfo,
    checkAndArchive,
    registerArchiveRoutes
};
