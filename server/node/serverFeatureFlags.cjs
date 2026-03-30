/**
 * serverFeatureFlags.cjs — Server-side feature flag system
 *
 * Controls which server-side features are enabled.
 * Priority: Environment Variable > Config File > Defaults
 */
'use strict';

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'server-config.json');

// ─── Default flags ───
const DEFAULT_FLAGS = {
    useServerChat: true,        // Full prompt pipeline + background job LLM processing
    useServerInlay: true,       // Server-side inlay image storage
    debugPromptLog: false,      // Log assembled prompt messages for debugging
    maxAgentTimeout: 600000,    // Max agent timeout (10 minutes)
};

let _flags = null;

/**
 * Load flags from config file (if exists)
 */
function loadConfigFile() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn('[FeatureFlags] Failed to read config:', e.message);
    }
    return {};
}

/**
 * Write current flags to config file
 */
function saveConfigFile(flags) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(flags, null, 2), 'utf-8');
    } catch (e) {
        console.error('[FeatureFlags] Failed to save config:', e.message);
    }
}

/**
 * Parse env bool: '1', 'true', 'yes' → true; '0', 'false', 'no' → false; else undefined
 */
function parseEnvBool(val) {
    if (val === undefined || val === null || val === '') return undefined;
    const lower = val.toLowerCase().trim();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
    return undefined;
}

/**
 * Initialize flags: defaults → config file → env vars
 */
function initFlags() {
    const configFlags = loadConfigFile();

    _flags = { ...DEFAULT_FLAGS, ...configFlags };

    // Environment variable overrides
    const envMap = {
        NODE_RISU_USE_SERVER_CHAT: 'useServerChat',
        NODE_RISU_USE_SERVER_INLAY: 'useServerInlay',
        NODE_RISU_DEBUG_PROMPT_LOG: 'debugPromptLog',
    };

    for (const [envKey, flagKey] of Object.entries(envMap)) {
        const envVal = parseEnvBool(process.env[envKey]);
        if (envVal !== undefined) {
            _flags[flagKey] = envVal;
        }
    }

    // Log active flags
    console.log('[FeatureFlags] Active flags:', JSON.stringify(_flags));
    return _flags;
}

/**
 * Get all feature flags (lazy-initialized)
 */
function getFeatureFlags() {
    if (!_flags) initFlags();
    return { ..._flags };
}

/**
 * Check if server chat (full pipeline) is enabled
 */
function isServerChatEnabled() {
    if (!_flags) initFlags();
    return _flags.useServerChat === true;
}

/**
 * Check if a specific feature flag is enabled
 */
function isEnabled(flagName) {
    if (!_flags) initFlags();
    return _flags[flagName] === true;
}

/**
 * Set a feature flag value at runtime and persist to config
 */
function setFeatureFlag(name, value) {
    if (!_flags) initFlags();
    _flags[name] = value;

    // Persist to config file
    const configFlags = loadConfigFile();
    configFlags[name] = value;
    saveConfigFile(configFlags);

    console.log(`[FeatureFlags] ${name} = ${value} (persisted)`);
    return _flags;
}

module.exports = {
    getFeatureFlags,
    isServerChatEnabled,
    isEnabled,
    setFeatureFlag,
    initFlags,
};
