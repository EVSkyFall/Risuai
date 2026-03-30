/**
 * Build script: bundles frontend processScriptFull + risuChatParser for server use.
 * Replaces browser-only dependencies with stubs via esbuild plugin.
 *
 * Usage: node server/node/build-prompt-bundle.mjs
 */
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const stubFile = path.resolve(__dirname, 'stubs/browser-stubs.ts');

// Files that are ALLOWED to be bundled (the core chain)
const allowedFiles = new Set([
    // The entry point
    'serverScriptsEntry.ts',
    // Core scripts engine
    'src/ts/process/scripts.ts',
    // CBS parser
    'src/ts/parser/parser.svelte.ts',
    // CBS system
    'src/ts/cbs.ts',
    'src/ts/cbs.svelte.ts',
    // CBS functions (pure logic)
    'src/ts/process/cbs.svelte.ts',
    // Database types (no side effects)
    'src/ts/storage/database.svelte.ts',
    // Infunctions (calcString etc - pure logic)
    'src/ts/process/infunctions.ts',
    // Modules (getModuleRegexScripts)
    'src/ts/process/modules.ts',
    // ChatVar
    'src/ts/parser/chatVar.svelte.ts',
    // Lite mode check
    'src/ts/lite.ts',
    // Tokenizer
    'src/ts/tokenizer.ts',
    // Mutex
    'src/ts/mutex.ts',
    // rpack
    'src/ts/rpack/',
]);

function isAllowed(filePath) {
    const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
    for (const allowed of allowedFiles) {
        if (rel === allowed || rel.startsWith(allowed)) return true;
    }
    return false;
}

// Aggressive stub plugin: redirect ALL non-allowed imports to stubs
const aggressiveStubPlugin = {
    name: 'aggressive-stub',
    setup(build) {
        // Stub all node_modules except a small allowlist
        const allowedNodeModules = ['@adobe/css-tools', 'markdown-it', 'uuid', 'mutex'];
        build.onResolve({ filter: /.*/ }, (args) => {
            // Skip the entry point itself
            if (args.kind === 'entry-point') return null;

            // For relative imports, check if the resolved file is allowed
            if (args.path.startsWith('.') || args.path.startsWith('/') || args.path.startsWith('src/')) {
                // Let esbuild resolve it first, then check
                return null; // handled by onLoad
            }

            // For bare imports (node_modules), stub most of them
            const pkg = args.path.split('/')[0].startsWith('@')
                ? args.path.split('/').slice(0, 2).join('/')
                : args.path.split('/')[0];

            if (pkg === 'svelte') {
                return { path: stubFile };
            }

            // Stub known browser-only packages
            const stubPackages = [
                'dompurify', 'katex', 'highlight.js', 'postcss-selector-parser',
                'localforage', 'wasmoon', 'onnxruntime-node', 'onnxruntime-web',
                'pdfjs-dist', '@anthropic-ai', '@tauri-apps',
            ];
            for (const sp of stubPackages) {
                if (args.path.startsWith(sp)) return { path: stubFile };
            }

            // Allow everything else (markdown-it, css-tools, uuid etc)
            return null;
        });

        // For resolved files, check if they're in the allowed set
        build.onLoad({ filter: /\.(ts|svelte\.ts|svelte)$/ }, async (args) => {
            if (args.path === stubFile) return null; // don't intercept stubs

            const rel = path.relative(rootDir, args.path).replace(/\\/g, '/');

            // Check if this file should be stubbed
            if (!isAllowed(rel) && rel.startsWith('src/')) {
                return {
                    contents: `
                        // Stubbed: ${rel}
                        export default {};
                        export const language = {};
                        export const isTauri = false;
                        export const isNodeServer = true;
                        export const isIOS = false;
                        export const isLite = { subscribe: () => () => {} };
                        export function downloadFile() {}
                        export function alertError(m) { console.error(m); }
                        export function alertNormal() {}
                        export function alertNormalWait() { return Promise.resolve(); }
                        export function selectSingleFile() {}
                        export function getFileSrc() { return ''; }
                        export function aiWatermarkingLawApplies() { return false; }
                        export function runLuaEditTrigger(c, m, d) { return d; }
                        export function runTrigger() { return null; }
                        export const pluginV2 = [];
                        export class HypaProcesser { constructor(){} addText(){} similaritySearch(){ return ''; } similaritySearchScored(){ return []; } }
                        export function getInlayAssetBlob() { return null; }
                        export function writeInlayImage() {}
                        export function getInlayAsset() { return null; }
                        export function generateAIImage() { return null; }
                        export function requestChatData() { return null; }
                        export function processMultiCommand() { return ''; }
                        export function parseChatML() { return []; }
                        export function runScripted() { return ''; }
                        export function findCharacterbyId() { return null; }
                        export function getPersonaPrompt() { return ''; }
                        export function getUserIcon() { return ''; }
                        export function getUserName(db) { return db?.username || 'User'; }
                        export function pickHashRand(arr) { return arr?.[0]; }
                        export async function replaceAsync(str, re, fn) { return str.replace(re, fn); }
                        export const CharEmotion = { set(){}, subscribe(fn){ fn({}); return ()=>{}; }, value: {} };
                        export const selectedCharID = { set(){}, subscribe(fn){ fn(-1); return ()=>{}; }, value: -1 };
                        export const DBState = { db: null };
                        export const selIdState = { value: -1 };
                        export const ReloadChatPointer = { set(){}, subscribe(fn){ fn({}); return ()=>{}; } };
                        export const ReloadGUIPointer = { set(){}, subscribe(fn){ fn(0); return ()=>{}; } };
                        export const CurrentTriggerIdStore = { set(){}, subscribe(fn){ fn(null); return ()=>{}; } };
                        export function get(store) { return store?.value ?? store?._value; }
                        export function writable(v) { return { set(){}, subscribe(fn){ fn(v); return ()=>{}; }, value: v }; }
                        export const forageStorage = { isAccount: false };
                        export const appVer = '0.0.0';
                        export function getModelInfo() { return { parameters: [] }; }
                    `,
                    loader: 'ts',
                };
            }

            return null;
        });

        // Handle non-TS file types
        build.onLoad({ filter: /\.(css|mp3|bin|svelte|node)(\?.*)?$/ }, () => ({
            contents: '// stubbed binary/css file',
            loader: 'js',
        }));

        // Handle ?url and ?worker imports
        build.onResolve({ filter: /\?(url|worker)/ }, () => ({
            path: stubFile,
        }));
    },
};

try {
    const result = await build({
        entryPoints: [path.resolve(__dirname, 'serverScriptsEntry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        outfile: path.resolve(__dirname, 'promptBundle.cjs'),
        plugins: [aggressiveStubPlugin],
        alias: {
            'src/ts': path.resolve(rootDir, 'src/ts'),
            'src/lang': stubFile,
        },
        tsconfig: path.resolve(rootDir, 'tsconfig.json'),
        logLevel: 'warning',
        treeShaking: true,
        define: {
            'import.meta.env': '{}',
            'import.meta.env.DEV': 'false',
            'import.meta.env.VITE_RISU_LITE': '""',
        },
    });

    // Check output size
    const stat = fs.statSync(path.resolve(__dirname, 'promptBundle.cjs'));
    console.log(`[build-prompt-bundle] Success: ${(stat.size / 1024).toFixed(1)} KB`);
    if (result.warnings.length > 0) {
        console.log(`[build-prompt-bundle] ${result.warnings.length} warnings`);
    }
} catch (e) {
    console.error('[build-prompt-bundle] Failed:', e.message);
    process.exit(1);
}
