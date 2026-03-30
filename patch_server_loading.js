const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/ts/process/index.svelte.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Hoist let currentChar: character
content = content.replace("    let currentChar: character\n", "");

const hookPoint = '    const stageTimings = {';
content = content.replace(hookPoint, "    let currentChar: character\n" + hookPoint);

// 2. Add try { after registerChatJob
const registerLine = '    const jobKey = registerChatJob(selectedCharForJob, chatPageForJob, jobAbortController ?? { signal: arg.signal, abort: () => { } } as any)';
content = content.replace(registerLine, registerLine + '\n\n    try {');

// 3. Add } finally { before the end of sendChat
const endOfSendChat = `
    // Note: active job cleanup is now handled by connectToJobSSE/waitForJobRawResponse
    // via removeActiveJob() in serverChat.ts
    unregisterChatJob(jobKey)
    return true
}`;

const finalReplacement = `
    return true
    } finally {
        // Guarantee loading state cleanup on ALL exit paths (error, abort, success).
        // Without this, throwError() + return false leaves doingChat=true permanently.
        unregisterChatJob(jobKey)
        chatProcessStage.set(0)
    }
}`;

content = content.replace(endOfSendChat, finalReplacement);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
