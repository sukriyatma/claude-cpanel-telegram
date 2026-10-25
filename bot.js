require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
let PROJECT_CWD = process.env.PROJECT_CWD || __dirname;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const LOG_FILE = path.join(__dirname, 'bot.log');
const ENV_FILE = path.join(__dirname, '.env');
const PID_FILE = path.join(__dirname, 'bot.pid');

// Save PID file for service stopping
try {
  fs.writeFileSync(PID_FILE, process.pid.toString(), 'utf8');
} catch (e) {}

// Graceful cleanup on shutdown
function cleanupAndExit(code = 0) {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (e) {}
  process.exit(code);
}

process.on('SIGINT', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('exit', () => {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (e) {}
});

// Track interactive authentication process
let activeAuthProcess = null;
let activeAuthTimeout = null;

// --- Helper: Path Resolver (supports ~, relative, and absolute paths) ---
function resolvePath(userPath) {
  if (!userPath) return null;
  let p = userPath.trim();
  if (p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(2));
  } else if (p === '~') {
    p = os.homedir();
  } else if (!path.isAbsolute(p)) {
    p = path.resolve(PROJECT_CWD, p);
  }
  return path.normalize(p);
}

// --- Structured File Logger ---
function log(level, message, meta = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let entry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (meta) {
    entry += ` | Details: ${typeof meta === 'object' ? JSON.stringify(meta) : meta}`;
  }
  entry += '\n';

  process.stdout.write(entry);

  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf8');
  } catch (err) {
    console.error('Failed writing to bot.log:', err.message);
  }
}

// Locate Claude binary
const claudeBin = process.env.CLAUDE_BIN || (
  fs.existsSync(path.join(__dirname, 'node_modules', '.bin', 'claude'))
    ? path.join(__dirname, 'node_modules', '.bin', 'claude')
    : 'claude'
);

if (!TELEGRAM_TOKEN) {
  log('FATAL', 'TELEGRAM_TOKEN is missing in environment variables.');
  cleanupAndExit(1);
}

log('INFO', 'Starting Claude Code Telegram controller...', {
  nodeVersion: process.version,
  pid: process.pid,
  projectCwd: PROJECT_CWD,
  claudeBin
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  log('ERROR', 'Telegram polling error', error.message);
});

// --- Convert Standard GitHub Markdown to Telegram HTML ---
function mdToTelegramHtml(markdown) {
  if (!markdown) return '';

  const codeBlocks = [];
  const inlineCodes = [];

  // 1. Extract and preserve multiline code blocks (``` ... ```)
  let text = markdown.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    codeBlocks.push(`<pre><code>${escapedCode}</code></pre>`);
    return placeholder;
  });

  // 2. Extract and preserve inline code (`...`)
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    const placeholder = `\x00INLINECODE${inlineCodes.length}\x00`;
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    inlineCodes.push(`<code>${escapedCode}</code>`);
    return placeholder;
  });

  // 3. Escape HTML special characters in remaining regular text
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 4. Headers: # Header -> <b>Header</b>
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 5. Bold: **text** or __text__ -> <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');

  // 6. Italic: *text* or _text_ -> <i>text</i>
  text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  text = text.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // 7. Markdown links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // 8. Bullet points: "- " or "* " at start of line -> "• "
  text = text.replace(/^[\*\-]\s+/gm, '• ');

  // 9. Restore inline code
  text = text.replace(/\x00INLINECODE(\d+)\x00/g, (match, index) => inlineCodes[index]);

  // 10. Restore code blocks
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (match, index) => codeBlocks[index]);

  return text;
}

// --- Split HTML into Safe Chunks Keeping Tags Balanced (<3500 chars) ---
function splitHtmlMessage(html, maxChunkSize = 3200) {
  if (!html) return [];
  if (html.length <= maxChunkSize) return [html];

  const chunks = [];
  const lines = html.split('\n');
  let currentChunk = '';
  let inPre = false;
  let inBold = false;
  let inItalic = false;

  function updateTagState(str) {
    const preOpens = (str.match(/<pre>/g) || []).length;
    const preCloses = (str.match(/<\/pre>/g) || []).length;
    if (preOpens > preCloses) inPre = true;
    else if (preCloses > preOpens) inPre = false;

    const bOpens = (str.match(/<b>/g) || []).length;
    const bCloses = (str.match(/<\/b>/g) || []).length;
    if (bOpens > bCloses) inBold = true;
    else if (bCloses > bOpens) inBold = false;

    const iOpens = (str.match(/<i>/g) || []).length;
    const iCloses = (str.match(/<\/i>/g) || []).length;
    if (iOpens > iCloses) inItalic = true;
    else if (iCloses > iOpens) inItalic = false;
  }

  function flushChunk() {
    if (!currentChunk.trim()) return;
    let chunkToSend = currentChunk;

    // Automatically close tags if cut across chunk boundary
    if (inPre && !chunkToSend.endsWith('</code></pre>')) chunkToSend += '</code></pre>';
    if (inBold && !chunkToSend.endsWith('</b>')) chunkToSend += '</b>';
    if (inItalic && !chunkToSend.endsWith('</i>')) chunkToSend += '</i>';

    chunks.push(chunkToSend);

    // Reopen tags in next chunk so formatting continues seamlessly
    currentChunk = '';
    if (inPre) currentChunk += '<pre><code>';
    if (inBold) currentChunk += '<b>';
    if (inItalic) currentChunk += '<i>';
  }

  for (let line of lines) {
    while (line.length > maxChunkSize) {
      const slicePart = line.slice(0, maxChunkSize);
      line = line.slice(maxChunkSize);
      currentChunk += (currentChunk ? '\n' : '') + slicePart;
      updateTagState(slicePart);
      flushChunk();
    }

    if ((currentChunk + '\n' + line).length > maxChunkSize) {
      flushChunk();
    }

    currentChunk = currentChunk ? (currentChunk + '\n' + line) : line;
    updateTagState(line);
  }

  if (currentChunk.trim()) {
    flushChunk();
  }

  return chunks;
}

// --- Single Message Sender with Plain Text Fallback ---
async function sendSingleMessage(chatId, text, options = {}) {
  if (!text) return;
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    log('WARN', 'Telegram send failed with formatting, retrying as plain text', err.message);
    if (options.parse_mode) {
      const plainOptions = { ...options };
      delete plainOptions.parse_mode;
      try {
        const cleanText = text.replace(/<[^>]+>/g, '');
        if (cleanText.length > 3500) {
          for (let i = 0; i < cleanText.length; i += 3500) {
            await bot.sendMessage(chatId, cleanText.slice(i, i + 3500), plainOptions);
          }
          return;
        }
        return await bot.sendMessage(chatId, cleanText, plainOptions);
      } catch (retryErr) {
        log('ERROR', 'Telegram plain text send also failed', retryErr.message);
      }
    }
  }
}

// --- Universal Safe Message Dispatcher (Hard Limit Guarantee: Never Exceeds 3500 chars) ---
async function sendSafeMessage(chatId, text, options = {}) {
  if (!text) return;
  const HARD_LIMIT = 3500;

  if (text.length > HARD_LIMIT && options.parse_mode !== 'HTML') {
    for (let i = 0; i < text.length; i += HARD_LIMIT) {
      await sendSingleMessage(chatId, text.slice(i, i + HARD_LIMIT), options);
    }
    return;
  }

  return await sendSingleMessage(chatId, text, options);
}

// --- Formatted Output Dispatcher ---
async function sendFormattedOutput(chatId, rawMarkdown) {
  if (!rawMarkdown) {
    return sendSafeMessage(chatId, 'Task completed with no output.');
  }

  const html = mdToTelegramHtml(rawMarkdown);
  const chunks = splitHtmlMessage(html, 3200);

  for (const chunk of chunks) {
    await sendSafeMessage(chatId, chunk, { parse_mode: 'HTML' });
  }
}

// --- Session & Multi-Directory Store Management ---
function loadSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (data && Array.isArray(data.list) && data.activeId) {
        if (!data.permissionMode) data.permissionMode = 'acceptEdits';
        if (!Array.isArray(data.extraDirs)) data.extraDirs = [];
        if (data.primaryCwd) PROJECT_CWD = data.primaryCwd;
        return data;
      }
    } catch (e) {
      log('ERROR', 'Failed parsing sessions.json, reinitializing default session', e.message);
    }
  }

  const defaultId = crypto.randomUUID();
  const initialData = {
    activeId: defaultId,
    permissionMode: 'acceptEdits',
    primaryCwd: PROJECT_CWD,
    extraDirs: process.env.EXTRA_DIRS ? process.env.EXTRA_DIRS.split(',').map(s => s.trim()).filter(Boolean) : [],
    list: [{
      id: defaultId,
      title: 'Default Session',
      createdAt: Date.now(),
      initialized: false
    }]
  };
  saveSessions(initialData);
  return initialData;
}

function saveSessions(data) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log('ERROR', 'Failed to save sessions.json', err.message);
  }
}

function getActiveSession(data) {
  return data.list.find(s => s.id === data.activeId) || data.list[0];
}

// --- Render Interactive Sessions Menu ---
function renderSessionsMenu(chatId, messageId = null) {
  const data = loadSessions();
  const buttons = [];

  let text = '📋 *Available Claude Sessions:*\n\n';

  data.list.forEach((session, index) => {
    const isActive = session.id === data.activeId;
    text += `${isActive ? '🟢' : '⚪'} *${index + 1}.* ${session.title} ${isActive ? '_(Active)_' : ''}\n`;

    if (!isActive) {
      buttons.push([{
        text: `👉 Switch to: ${session.title}`,
        callback_data: `switch_${session.id}`
      }]);
    }
  });

  buttons.push([{ text: '➕ Create New Session', callback_data: 'create_new' }]);

  const options = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }).catch(() => {});
  } else {
    sendSafeMessage(chatId, text, options);
  }
}

// --- Render Permission Mode Menu ---
function renderModeMenu(chatId, messageId = null) {
  const data = loadSessions();
  const currentMode = data.permissionMode || 'acceptEdits';

  const modes = [
    { key: 'acceptEdits', label: '✍️ Auto-Accept Edits', desc: 'Can read, create & edit files without asking (Default).' },
    { key: 'bypass', label: '🚀 Full Autonomous', desc: 'Can edit files + run terminal & bash commands.' },
    { key: 'plan', label: '🛡️ Safe / Plan Only', desc: 'Read-only mode. Forbidden from modifying files.' }
  ];

  let text = '⚙️ *Permission Approval Settings*\n\n';
  text += 'Choose how Claude Code handles tool and execution permissions on your server:\n\n';

  const buttons = [];
  modes.forEach((m) => {
    const isSelected = currentMode === m.key;
    text += `${isSelected ? '🟢' : '⚪'} *${m.label}* ${isSelected ? '_(Active)_' : ''}\n   └ ${m.desc}\n\n`;

    buttons.push([{
      text: `${isSelected ? '✓ ' : ''}${m.label}`,
      callback_data: `set_mode_${m.key}`
    }]);
  });

  const options = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }).catch(() => {});
  } else {
    sendSafeMessage(chatId, text, options);
  }
}

// --- Handle /login and OAuth Reauth ---
function startOAuthLogin(chatId) {
  if (activeAuthProcess) {
    try {
      activeAuthProcess.kill();
    } catch (e) {}
    activeAuthProcess = null;
  }

  sendSafeMessage(chatId, '🔄 Starting Claude authentication flow...');
  log('INFO', 'Starting claude auth login process...');

  const authProcess = spawn(claudeBin, ['auth', 'login'], {
    env: process.env,
    cwd: PROJECT_CWD
  });

  activeAuthProcess = authProcess;

  if (activeAuthTimeout) clearTimeout(activeAuthTimeout);
  activeAuthTimeout = setTimeout(() => {
    if (activeAuthProcess === authProcess) {
      log('WARN', 'Auth process timed out after 5 minutes');
      try { authProcess.kill(); } catch (e) {}
      activeAuthProcess = null;
      sendSafeMessage(chatId, '⏰ Login session timed out. Type `/login` to try again.');
    }
  }, 5 * 60 * 1000);

  let outputBuffer = '';
  let urlSent = false;

  authProcess.stdout.on('data', (chunk) => {
    const str = chunk.toString();
    outputBuffer += str;
    log('DEBUG', 'Auth stdout', str);

    if (!urlSent) {
      const match = outputBuffer.match(/(https:\/\/claude\.com\/cai\/oauth\/authorize\S+)/);
      if (match) {
        urlSent = true;
        const authUrl = match[1];
        log('INFO', 'Extracted OAuth login URL', authUrl);

        const reply = 
          '🔐 *Claude Pro / Team Login*\n\n' +
          '1. Tap the button below to open the Claude authorization page:\n\n' +
          '2. Sign in to your Claude account and approve access.\n\n' +
          '3. Copy the **authorization code** shown on screen, and **paste it directly into this chat**!\n\n' +
          '*(Type `/cancel` if you want to cancel)*';

        bot.sendMessage(chatId, reply, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 Tap to Log In to Claude', url: authUrl }]
            ]
          }
        }).catch((err) => {
          sendSafeMessage(chatId, `${reply}\n\nURL: ${authUrl}`);
        });
      }
    }
  });

  authProcess.stderr.on('data', (chunk) => {
    log('WARN', 'Auth stderr', chunk.toString());
  });

  authProcess.on('close', (code) => {
    log('INFO', `Auth process exited with code ${code}`);
    activeAuthProcess = null;
    if (activeAuthTimeout) clearTimeout(activeAuthTimeout);

    if (code === 0) {
      sendSafeMessage(chatId, '🎉 *Authentication Successful!*\n\nYour Claude subscription is now connected and active. You can now send prompts!', { parse_mode: 'Markdown' });
    } else if (code !== null && !outputBuffer.includes('Paste code here')) {
      sendSafeMessage(chatId, `❌ Login process ended with code ${code}.\n\nOutput: ${outputBuffer.slice(-300)}`);
    }
  });

  authProcess.on('error', (err) => {
    log('ERROR', 'Auth process error', err.message);
    activeAuthProcess = null;
    sendSafeMessage(chatId, '❌ Failed to start login process: ' + err.message);
  });
}

// --- Inline Button Callbacks ---
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const action = query.data;

  // Authorization check
  if (ALLOWED_USER_ID && query.from.id.toString() !== ALLOWED_USER_ID.toString()) {
    log('WARN', 'Unauthorized callback query attempt', { from: query.from });
    return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
  }

  const data = loadSessions();

  // Mode change handler
  if (action.startsWith('set_mode_')) {
    const newMode = action.replace('set_mode_', '');
    data.permissionMode = newMode;
    saveSessions(data);

    log('INFO', `Changed permission mode to ${newMode}`);
    bot.answerCallbackQuery(query.id, { text: `Permission mode set to ${newMode}` });
    renderModeMenu(chatId, messageId);
    return;
  }

  // Session create
  if (action === 'create_new') {
    const newId = crypto.randomUUID();
    const newSession = {
      id: newId,
      title: `Session ${data.list.length + 1}`,
      createdAt: Date.now(),
      initialized: false,
      isNew: true
    };
    data.list.push(newSession);
    data.activeId = newId;
    saveSessions(data);

    log('INFO', 'New session created via button', { sessionId: newId, title: newSession.title });
    bot.answerCallbackQuery(query.id, { text: 'New session created!' });
    renderSessionsMenu(chatId, messageId);
    sendSafeMessage(chatId, `✨ Created & switched to *${newSession.title}*. Send your first instruction!`, { parse_mode: 'Markdown' });
    return;
  }

  // Session switch
  if (action.startsWith('switch_')) {
    const targetId = action.replace('switch_', '');
    const target = data.list.find(s => s.id === targetId);

    if (target) {
      data.activeId = target.id;
      saveSessions(data);
      log('INFO', 'Switched active session', { sessionId: target.id, title: target.title });
      bot.answerCallbackQuery(query.id, { text: `Switched to ${target.title}` });
      renderSessionsMenu(chatId, messageId);
      sendSafeMessage(chatId, `Switched to: *${target.title}*`, { parse_mode: 'Markdown' });
    }
  }
});

// --- Incoming Messages ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Authorization check
  if (ALLOWED_USER_ID && msg.from.id.toString() !== ALLOWED_USER_ID.toString()) {
    log('WARN', 'Unauthorized access attempt blocked', {
      fromId: msg.from.id,
      username: msg.from.username,
      text: text?.slice(0, 50)
    });
    return sendSafeMessage(chatId, '⛔ Unauthorized access. Configure TELEGRAM_USER_ID.');
  }

  if (!text) return;

  log('DEBUG', 'Received message', { from: msg.from.username || msg.from.id, text });

  // Stop service command
  if (text === '/stop' || text === '/shutdown') {
    await sendSafeMessage(chatId, '🛑 *Stopping Claude Code controller service...*\n\nThe daemon will terminate now.', { parse_mode: 'Markdown' });
    log('INFO', 'Service stopped via Telegram /stop command.');
    setTimeout(() => {
      cleanupAndExit(0);
    }, 1000);
    return;
  }

  // Cancel ongoing auth
  if (text === '/cancel') {
    if (activeAuthProcess) {
      try { activeAuthProcess.kill(); } catch (e) {}
      activeAuthProcess = null;
      if (activeAuthTimeout) clearTimeout(activeAuthTimeout);
      return sendSafeMessage(chatId, '🚫 Authentication process cancelled.');
    }
    return sendSafeMessage(chatId, 'ℹ️ No active process to cancel.');
  }

  // If waiting for OAuth authorization code from user
  if (activeAuthProcess) {
    log('INFO', 'Delivering pasted auth code to Claude process...');
    await sendSafeMessage(chatId, '⏳ Verifying your authorization code with Claude...');
    try {
      activeAuthProcess.stdin.write(text + '\n');
    } catch (e) {
      log('ERROR', 'Failed writing code to auth process stdin', e.message);
      sendSafeMessage(chatId, '❌ Error submitting code: ' + e.message);
    }
    return;
  }

  // --- Commands ---
  if (text === '/start' || text === '/help') {
    const helpMsg = 
      '🤖 *Claude Code cPanel Controller*\n\n' +
      '• *Send any text:* Prompt Claude Code on active session.\n' +
      '• `/dirs`: View all accessible folders (simultaneous multi-folder access).\n' +
      '• `/adddir <path>`: Grant Claude access to an additional folder.\n' +
      '• `/rmdir <path>`: Revoke access to an additional folder.\n' +
      '• `/cd <path>`: Switch primary working directory.\n' +
      '• `/mode`: Configure permission approval mode (Edits, Full Auto, Safe).\n' +
      '• `/sessions` or `/list`: View and switch sessions.\n' +
      '• `/new [name]`: Start a new named session.\n' +
      '• `/login` or `/reauth`: Sign in with your Claude Pro/Team subscription.\n' +
      '• `/status`: Check authentication status.\n' +
      '• `/setkey <key>`: Configure an Anthropic API Key directly.\n' +
      '• `/logs [lines]`: Read recent debug log entries (default 30).\n' +
      '• `/stop`: Gracefully stop the controller daemon.\n' +
      '• `/help`: Display this guide.';
    return sendSafeMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
  }

  // View all accessible folders
  if (text === '/dirs' || text === '/folders' || text === '/cwd') {
    const data = loadSessions();
    const extraDirs = data.extraDirs || [];

    let msg = `📁 *Accessible Folders for Claude:*\n\n`;
    msg += `• *Primary Working Dir (\`cwd\`):*\n  \`${PROJECT_CWD}\`\n\n`;

    if (extraDirs.length > 0) {
      msg += `• *Simultaneous Additional Folders (\`--add-dir\`):*\n`;
      extraDirs.forEach((dir, i) => {
        const exists = fs.existsSync(dir);
        msg += `  ${i + 1}. \`${dir}\` ${exists ? '✅' : '❌ (Path not found)'}\n`;
      });
    } else {
      msg += `• *Simultaneous Additional Folders:*\n  _None configured yet._\n`;
    }

    msg += `\n*Manage Folders:*\n`;
    msg += `• \`/adddir <path>\` to grant access to another folder\n`;
    msg += `• \`/rmdir <path>\` to remove an additional folder\n`;
    msg += `• \`/cd <path>\` to change primary working directory\n`;
    msg += `• \`/cleardirs\` to clear all extra folders\n`;

    return sendSafeMessage(chatId, msg, { parse_mode: 'Markdown' });
  }

  // Add additional folder access
  if (text.startsWith('/adddir')) {
    const rawPath = text.replace('/adddir', '').trim();
    if (!rawPath) {
      return sendSafeMessage(chatId, '⚠️ Please specify a path. Example:\n`/adddir /home/username/public_html/api`', { parse_mode: 'Markdown' });
    }

    const resolved = resolvePath(rawPath);
    if (!fs.existsSync(resolved)) {
      return sendSafeMessage(chatId, `❌ Directory does not exist:\n\`${resolved}\``, { parse_mode: 'Markdown' });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return sendSafeMessage(chatId, `❌ Path is a file, not a directory:\n\`${resolved}\``, { parse_mode: 'Markdown' });
    }

    const data = loadSessions();
    if (!Array.isArray(data.extraDirs)) data.extraDirs = [];

    if (!data.extraDirs.includes(resolved)) {
      data.extraDirs.push(resolved);
      saveSessions(data);
      log('INFO', 'Added extra accessible directory', resolved);
      return sendSafeMessage(chatId, `✅ *Granted access to folder:*\n\`${resolved}\`\n\nClaude can now read, search, and edit files in this folder simultaneously!`, { parse_mode: 'Markdown' });
    } else {
      return sendSafeMessage(chatId, `ℹ️ Directory is already in the allowed list:\n\`${resolved}\``, { parse_mode: 'Markdown' });
    }
  }

  // Remove additional folder access
  if (text.startsWith('/rmdir')) {
    const rawPath = text.replace('/rmdir', '').trim();
    if (!rawPath) {
      return sendSafeMessage(chatId, '⚠️ Please specify a path. Usage:\n`/rmdir <path>`', { parse_mode: 'Markdown' });
    }

    const resolved = resolvePath(rawPath);
    const data = loadSessions();
    if (!Array.isArray(data.extraDirs) || !data.extraDirs.includes(resolved)) {
      return sendSafeMessage(chatId, `ℹ️ Folder not found in allowed list:\n\`${resolved}\``, { parse_mode: 'Markdown' });
    }

    data.extraDirs = data.extraDirs.filter(d => d !== resolved);
    saveSessions(data);
    log('INFO', 'Removed extra directory', resolved);
    return sendSafeMessage(chatId, `🗑️ *Removed folder access:*\n\`${resolved}\``, { parse_mode: 'Markdown' });
  }

  // Clear all additional folders
  if (text === '/cleardirs') {
    const data = loadSessions();
    data.extraDirs = [];
    saveSessions(data);
    return sendSafeMessage(chatId, '🧹 Cleared all additional accessible folders.', { parse_mode: 'Markdown' });
  }

  // Switch primary working directory
  if (text.startsWith('/cd')) {
    const rawPath = text.replace('/cd', '').trim();
    if (!rawPath) {
      return sendSafeMessage(chatId, `📁 Current working directory: \`${PROJECT_CWD}\`\n\nUsage: \`/cd /path/to/folder\``, { parse_mode: 'Markdown' });
    }

    const resolved = resolvePath(rawPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return sendSafeMessage(chatId, `❌ Invalid directory:\n\`${resolved}\``, { parse_mode: 'Markdown' });
    }

    PROJECT_CWD = resolved;
    const data = loadSessions();
    data.primaryCwd = resolved;
    saveSessions(data);

    log('INFO', 'Switched primary working directory', resolved);
    return sendSafeMessage(chatId, `📂 *Switched primary directory to:*\n\`${resolved}\``, { parse_mode: 'Markdown' });
  }

  // Permission mode switcher
  if (text === '/mode' || text === '/permissions') {
    return renderModeMenu(chatId);
  }

  // Login / Reauth command
  if (text === '/login' || text === '/auth' || text === '/reauth') {
    return startOAuthLogin(chatId);
  }

  // Check auth status
  if (text === '/status' || text === '/whoami') {
    await sendSafeMessage(chatId, '🔍 Checking authentication status...');
    exec(`"${claudeBin}" auth status < /dev/null`, { cwd: PROJECT_CWD, env: process.env }, async (err, stdout, stderr) => {
      const output = (stdout || stderr || err?.message || '').trim();
      return await sendFormattedOutput(chatId, '```json\n' + output + '\n```');
    });
    return;
  }

  // Directly set API Key
  if (text.startsWith('/setkey')) {
    const key = text.replace('/setkey', '').trim();
    if (!key || !key.startsWith('sk-ant-')) {
      return sendSafeMessage(chatId, '⚠️ Invalid API key format. Usage:\n`/setkey sk-ant-api03-...`', { parse_mode: 'Markdown' });
    }

    process.env.ANTHROPIC_API_KEY = key;

    try {
      let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
      if (envContent.includes('ANTHROPIC_API_KEY=')) {
        envContent = envContent.replace(/#?\s*ANTHROPIC_API_KEY=.*/g, `ANTHROPIC_API_KEY=${key}`);
      } else {
        envContent += `\nANTHROPIC_API_KEY=${key}\n`;
      }
      fs.writeFileSync(ENV_FILE, envContent, 'utf8');
      log('INFO', 'Saved ANTHROPIC_API_KEY to .env file');
      return sendSafeMessage(chatId, '✅ *API Key saved & activated successfully!*', { parse_mode: 'Markdown' });
    } catch (e) {
      log('ERROR', 'Failed writing API key to .env', e.message);
      return sendSafeMessage(chatId, '⚠️ API key activated in memory, but failed to write to .env: ' + e.message);
    }
  }

  if (text === '/sessions' || text === '/list') {
    return renderSessionsMenu(chatId);
  }

  if (text.startsWith('/new')) {
    const customTitle = text.replace('/new', '').trim() || `Session ${Date.now().toString().slice(-4)}`;
    const data = loadSessions();
    const newId = crypto.randomUUID();
    data.list.push({
      id: newId,
      title: customTitle,
      createdAt: Date.now(),
      initialized: false,
      isNew: true
    });
    data.activeId = newId;
    saveSessions(data);
    log('INFO', 'New session created via command', { sessionId: newId, title: customTitle });
    return sendSafeMessage(chatId, `✨ Started new session: *${customTitle}*. Type your task below!`, { parse_mode: 'Markdown' });
  }

  // Debug logs inspection
  if (text.startsWith('/logs')) {
    const parts = text.split(' ');
    const count = parseInt(parts[1], 10) || 30;

    if (!fs.existsSync(LOG_FILE)) {
      return sendSafeMessage(chatId, 'ℹ️ Log file (bot.log) does not exist yet.');
    }

    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.trim().split('\n');
      const recent = lines.slice(-count).join('\n');
      await sendSafeMessage(chatId, `📄 *Recent ${Math.min(count, lines.length)} log lines:*`, { parse_mode: 'Markdown' });
      return await sendFormattedOutput(chatId, '```text\n' + recent + '\n```');
    } catch (err) {
      log('ERROR', 'Failed reading log file', err.message);
      return sendSafeMessage(chatId, '❌ Error reading log file: ' + err.message);
    }
  }

  // --- Process Claude Code Instruction ---
  const data = loadSessions();
  const currentSession = getActiveSession(data);
  const currentMode = data.permissionMode || 'acceptEdits';
  const extraDirs = (data.extraDirs || []).filter(d => fs.existsSync(d));

  // Build --add-dir flags for simultaneous multi-folder access
  const addDirFlags = extraDirs.map(d => `--add-dir "${d}"`).join(' ');

  // Determine permission flag
  let permissionFlag = '--permission-mode acceptEdits';
  if (currentMode === 'bypass') {
    permissionFlag = '--dangerously-skip-permissions';
  } else if (currentMode === 'plan') {
    permissionFlag = '--permission-mode plan';
  }

  // Auto-name session from first prompt if newly created
  if (currentSession.isNew) {
    currentSession.title = text.slice(0, 30) + (text.length > 30 ? '...' : '');
    delete currentSession.isNew;
    saveSessions(data);
  }

  const folderCount = extraDirs.length + 1;
  await sendSafeMessage(chatId, `⏳ Running in *${currentSession.title}* [${currentMode}] (${folderCount} folder${folderCount > 1 ? 's' : ''})...`, { parse_mode: 'Markdown' });

  const safePrompt = text.replace(/"/g, '\\"');
  const startTime = Date.now();

  log('INFO', `Executing Claude Code command in session: ${currentSession.title} (${currentSession.id})`, {
    permissionMode: currentMode,
    permissionFlag,
    primaryCwd: PROJECT_CWD,
    extraDirs,
    initialized: !!currentSession.initialized,
    prompt: text
  });

  // Self-healing execution handler that handles --resume vs --session-id automatically
  function executeCommand(flag, sessionId, retryCount = 0) {
    const extraArgs = [permissionFlag, addDirFlags].filter(Boolean).join(' ');
    const command = `"${claudeBin}" ${flag} "${sessionId}" ${extraArgs} -p "${safePrompt}" < /dev/null`;

    exec(command, {
      cwd: PROJECT_CWD,
      env: process.env,
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer
    }, async (error, stdout, stderr) => {
      const combined = ((stderr || '') + ' ' + (stdout || '') + ' ' + (error ? error.message : '')).trim();

      // Case 1: Not logged in
      if (combined.includes('Not logged in') || combined.includes('Please run /login')) {
        log('ERROR', 'Claude is not authenticated', { combined });
        return sendSafeMessage(chatId, 
          '⚠️ *Authentication Required*\n\n' +
          'Claude Code is not logged in.\n\n' +
          '• Type `/login` to sign in with your Claude Pro / Team account via link.\n' +
          '• Or type `/setkey sk-ant-...` to set an API key.',
          { parse_mode: 'Markdown' }
        );
      }

      // Case 2: Session ID already in use -> Switch to --resume
      if (error && combined.includes('already in use') && retryCount === 0) {
        log('WARN', `Session ${sessionId} already in use, auto-recovering with --resume...`);
        currentSession.initialized = true;
        saveSessions(data);
        return executeCommand('--resume', sessionId, retryCount + 1);
      }

      // Case 3: No conversation found with session ID -> Generate fresh ID and use --session-id
      if (error && combined.includes('No conversation found') && retryCount === 0) {
        const freshId = crypto.randomUUID();
        log('WARN', `Session ${sessionId} has no prior conversation on disk, recovering with fresh ID: ${freshId}...`);
        currentSession.id = freshId;
        currentSession.initialized = false;
        saveSessions(data);
        return executeCommand('--session-id', freshId, retryCount + 1);
      }

      const elapsed = Date.now() - startTime;
      const output = (stdout || stderr || error?.message || '').trim();

      if (error) {
        log('ERROR', `Claude Code execution failed after ${elapsed}ms`, {
          error: error.message,
          stdout: stdout?.trim(),
          stderr: stderr?.trim()
        });
      } else {
        currentSession.initialized = true;
        saveSessions(data);
        log('INFO', `Claude Code execution succeeded in ${elapsed}ms`, {
          outputLength: output.length
        });
      }

      await sendFormattedOutput(chatId, output);
    });
  }

  const initialFlag = currentSession.initialized ? '--resume' : '--session-id';
  executeCommand(initialFlag, currentSession.id);
});

log('INFO', 'Claude Code Telegram controller is now listening.');
