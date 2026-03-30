/**
 * Node-Risu Server-Side Inlay Image Storage
 * 
 * Replaces the browser-side localforage (IndexedDB) inlay storage with
 * server-side file system storage. Images are stored as files in save/inlays/.
 * 
 * Phase 2 of the backend migration: Server-side inlay assets.
 */

const { existsSync, mkdirSync, readFileSync } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const savePath = path.join(process.cwd(), "save");
const inlayDir = path.join(savePath, 'inlays');
const indexPath = path.join(inlayDir, '_index.json');

// Ensure inlay directory exists
if (!existsSync(inlayDir)) {
    mkdirSync(inlayDir, { recursive: true });
}

// =============================================================================
// Inlay Index Management
// =============================================================================

async function readIndex() {
    try {
        if (existsSync(indexPath)) {
            const raw = await fs.readFile(indexPath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('[InlayServer] Index read error:', e.message);
    }
    return {};
}

async function writeIndex(index) {
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

// =============================================================================
// Image Processing (sharp-optional, fallback to raw storage)
// =============================================================================

let sharp = null;
try {
    sharp = require('sharp');
    console.log('[InlayServer] sharp is available for image processing');
} catch (e) {
    console.log('[InlayServer] sharp not installed — images will be stored without resize');
    console.log('[InlayServer] Run: npm install sharp  (in server/node/ directory) to enable');
}

/**
 * Process and optionally resize an image buffer.
 * @param {Buffer} imageBuffer
 * @param {Object} options - { maxWidth, maxHeight }
 * @returns {{ buffer: Buffer, width: number, height: number, ext: string }}
 */
async function processImage(imageBuffer, options = {}) {
    const maxWidth = options.maxWidth || 1024;
    const maxHeight = options.maxHeight || 1024;

    if (sharp) {
        const img = sharp(imageBuffer);
        const metadata = await img.metadata();

        let width = metadata.width || 0;
        let height = metadata.height || 0;

        // Resize if needed
        if (width > maxWidth || height > maxHeight) {
            const processed = await img
                .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
                .png()
                .toBuffer({ resolveWithObject: true });

            return {
                buffer: processed.data,
                width: processed.info.width,
                height: processed.info.height,
                ext: 'png'
            };
        }

        // Convert to PNG without resize
        const processed = await img.png().toBuffer({ resolveWithObject: true });
        return {
            buffer: processed.data,
            width: processed.info.width,
            height: processed.info.height,
            ext: 'png'
        };
    }

    // Without sharp: store raw, no dimension info
    return {
        buffer: imageBuffer,
        width: 0,
        height: 0,
        ext: 'png'
    };
}

// =============================================================================
// Register Express Routes
// =============================================================================

/**
 * Register inlay storage routes on the Express app.
 * @param {import('express').Express} app
 * @param {string} serverPassword
 */
function registerInlayRoutes(app, serverPassword) {

    // Middleware: auth check for inlay routes
    const authCheck = (req, res, next) => {
        const authHeader = req.headers['risu-auth'];
        if (!authHeader || authHeader.trim() !== serverPassword.trim()) {
            res.status(401).json({ error: 'Password Incorrect' });
            return;
        }
        next();
    };

    /**
     * POST /api/inlay/upload
     * 
     * Accepts raw binary image in request body (application/octet-stream)
     * or base64 JSON: { data: "base64...", name: "filename", type: "image" }
     * 
     * Response: { id: string, width: number, height: number }
     */
    app.post('/api/inlay/upload', authCheck, async (req, res) => {
        try {
            let imageBuffer;
            let name = 'untitled';
            let type = 'image';

            if (req.is('application/octet-stream')) {
                imageBuffer = req.body;
            } else if (req.is('application/json')) {
                const { data, name: n, type: t } = req.body;
                if (!data) {
                    res.status(400).json({ error: 'No image data provided' });
                    return;
                }
                // Remove data URL prefix if present (data:image/png;base64,...)
                const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
                imageBuffer = Buffer.from(base64Data, 'base64');
                if (n) name = n;
                if (t) type = t;
            } else {
                res.status(400).json({ error: 'Unsupported content type. Use application/octet-stream or application/json' });
                return;
            }

            if (!imageBuffer || imageBuffer.length === 0) {
                res.status(400).json({ error: 'Empty image data' });
                return;
            }

            // Process
            const processed = await processImage(imageBuffer);
            const id = crypto.randomUUID();
            const filename = `${id}.${processed.ext}`;

            // Save file
            await fs.writeFile(path.join(inlayDir, filename), processed.buffer);

            // Update index
            const index = await readIndex();
            index[id] = {
                id,
                name,
                type,
                ext: processed.ext,
                width: processed.width,
                height: processed.height,
                size: processed.buffer.length,
                created: Date.now(),
            };
            await writeIndex(index);

            console.log(`[InlayServer] Uploaded: ${id} (${name}, ${processed.width}x${processed.height})`);

            res.json({
                id,
                width: processed.width,
                height: processed.height,
                ext: processed.ext,
            });
        } catch (error) {
            console.error('[InlayServer] Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/inlay/:id
     * 
     * Serve an inlay image.
     * Supports optional ?format=base64 query param to return base64 data URI.
     */
    app.get('/api/inlay/:id', authCheck, async (req, res) => {
        try {
            const id = req.params.id;
            const index = await readIndex();
            const meta = index[id];

            if (!meta) {
                res.status(404).json({ error: 'Inlay not found' });
                return;
            }

            const filePath = path.join(inlayDir, `${id}.${meta.ext}`);
            if (!existsSync(filePath)) {
                res.status(404).json({ error: 'Inlay file missing' });
                return;
            }

            if (req.query.format === 'base64') {
                const buffer = await fs.readFile(filePath);
                const base64 = buffer.toString('base64');
                const dataUri = `data:image/${meta.ext};base64,${base64}`;
                res.json({
                    id,
                    data: dataUri,
                    width: meta.width,
                    height: meta.height,
                    name: meta.name,
                    type: meta.type,
                    ext: meta.ext,
                });
                return;
            }

            // Direct binary serve
            res.setHeader('Content-Type', `image/${meta.ext}`);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.sendFile(filePath);
        } catch (error) {
            console.error('[InlayServer] Get error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * DELETE /api/inlay/:id
     */
    app.delete('/api/inlay/:id', authCheck, async (req, res) => {
        try {
            const id = req.params.id;
            const index = await readIndex();
            const meta = index[id];

            if (!meta) {
                res.status(404).json({ error: 'Inlay not found' });
                return;
            }

            const filePath = path.join(inlayDir, `${id}.${meta.ext}`);
            try { await fs.rm(filePath); } catch (e) { /* file may already be gone */ }

            delete index[id];
            await writeIndex(index);

            console.log(`[InlayServer] Deleted: ${id}`);
            res.json({ success: true });
        } catch (error) {
            console.error('[InlayServer] Delete error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/inlay/list/all
     * 
     * List all inlay assets with metadata.
     */
    app.get('/api/inlay/list/all', authCheck, async (req, res) => {
        try {
            const index = await readIndex();
            const items = Object.values(index).map(item => ({
                id: item.id,
                name: item.name,
                type: item.type,
                width: item.width,
                height: item.height,
                size: item.size,
                created: item.created,
            }));
            res.json({ items, count: items.length });
        } catch (error) {
            console.error('[InlayServer] List error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/inlay/migrate
     * 
     * Bulk import from client-side localforage data.
     * Body: { assets: [{ id, data, name, type, width, height, ext }] }
     */
    app.post('/api/inlay/migrate', authCheck, async (req, res) => {
        try {
            const { assets } = req.body;
            if (!assets || !Array.isArray(assets)) {
                res.status(400).json({ error: 'assets array required' });
                return;
            }

            const index = await readIndex();
            let migrated = 0;
            const idMap = {};

            for (const asset of assets) {
                const id = asset.id || crypto.randomUUID();
                let imageBuffer;

                if (typeof asset.data === 'string') {
                    const base64Data = asset.data.replace(/^data:image\/\w+;base64,/, '');
                    imageBuffer = Buffer.from(base64Data, 'base64');
                } else {
                    continue; // Skip non-string data
                }

                const processed = await processImage(imageBuffer);
                const filename = `${id}.${processed.ext}`;
                await fs.writeFile(path.join(inlayDir, filename), processed.buffer);

                index[id] = {
                    id,
                    name: asset.name || 'migrated',
                    type: asset.type || 'image',
                    ext: processed.ext,
                    width: processed.width || asset.width || 0,
                    height: processed.height || asset.height || 0,
                    size: processed.buffer.length,
                    created: Date.now(),
                };

                idMap[asset.id] = id;
                migrated++;
            }

            await writeIndex(index);
            console.log(`[InlayServer] Migration complete: ${migrated} assets`);
            res.json({ success: true, migrated, idMap });
        } catch (error) {
            console.error('[InlayServer] Migration error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    console.log('[Server] Inlay storage routes registered');
}

module.exports = { registerInlayRoutes };
