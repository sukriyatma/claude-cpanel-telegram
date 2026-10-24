require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
const PROJECT_CWD = process.env.PROJECT_CWD || __dirname;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const LOG_FILE = path.join(__dirname, 'bot.log');

// --- Structured File Logger ---
function log(level, message, meta = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let entry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (meta) {
    entry += ` | Details: ${typeof meta === 'object' ? JSON.stringify(meta) : meta}`;
  }
  entry += '\n';

  // Output to standard console (cPanel passenger logs)
  process.stdout.write(entry);

  // Append to bot.log file for easy debugging
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
  process.exit(1);
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

// --- Safe Messaging (Handles Telegram Markdown Parsing Errors) ---
async function sendSafeMessage(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    log('WARN', 'Telegram send failed with formatting, retrying as plain text', err.message);
    if (options.parse_mode) {
      delete options.parse_mode;
      try {
        return await bot.sendMessage(chatId, text, options);
      } catch (retryErr) {
        log('ERROR', 'Telegram plain text send also failed', retryErr.message);
      }
    }
  }
}

// Split large messages according to Telegram's 4096 character limit
async function sendLongOutput(chatId, text) {
  const CHUNK_SIZE = 4000;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.slice(i, i + CHUNK_SIZE);
    await sendSafeMessage(chatId, chunk);
  }
}

// --- Session Store Management ---
function loadSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (e) {
      log('ERROR', 'Failed parsing sessions.json, reinitializing default session', e.message);
    }
  }

  const defaultId = crypto.randomUUID();
  const initialData = {
    activeId: defaultId,
    list: [{
      id: defaultId,
      title: 'Default Session',
      createdAt: Date.now()
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

// --- Render Interactive Menu ---
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

  if (action === 'create_new') {
    const newId = crypto.randomUUID();
    const newSession = {
      id: newId,
      title: `Session ${data.list.length + 1}`,
      createdAt: Date.now(),
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

  // Commands
  if (text === '/start' || text === '/help') {
    const helpMsg = 
      '🤖 *Claude Code cPanel Controller*\n\n' +
      '• *Send any text:* Prompt Claude Code on active session.\n' +
      '• `/sessions` or `/list`: View and switch sessions.\n' +
      '• `/new [name]`: Start a new named session.\n' +
      '• `/logs [lines]`: Read recent debug log entries (default 30).\n' +
      '• `/cwd`: Show current working directory.\n' +
      '• `/help`: Display this guide.';
    return sendSafeMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
  }

  if (text === '/sessions' || text === '/list') {
    return renderSessionsMenu(chatId);
  }

  if (text.startsWith('/new')) {
    const customTitle = text.replace('/new', '').trim() || `Session ${Date.now().toString().slice(-4)}`;
    const data = loadSessions();
    const newId = crypto.randomUUID();
    data.list.push({ id: newId, title: customTitle, createdAt: Date.now(), isNew: true });
    data.activeId = newId;
    saveSessions(data);
    log('INFO', 'New session created via command', { sessionId: newId, title: customTitle });
    return sendSafeMessage(chatId, `✨ Started new session: *${customTitle}*. Type your task below!`, { parse_mode: 'Markdown' });
  }

  if (text === '/cwd') {
    return sendSafeMessage(chatId, `📁 Working Directory: \`${PROJECT_CWD}\``, { parse_mode: 'Markdown' });
  }

  // --- /logs command to view debug logs right in Telegram ---
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
      const reply = `📄 *Recent ${Math.min(count, lines.length)} log lines:*\n\`\`\`text\n${recent}\n\`\`\``;
      return sendSafeMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      log('ERROR', 'Failed reading log file', err.message);
      return sendSafeMessage(chatId, '❌ Error reading log file: ' + err.message);
    }
  }

  // --- Process Claude Code Instruction ---
  const data = loadSessions();
  const currentSession = getActiveSession(data);

  // Auto-name new session from first prompt
  if (currentSession.isNew) {
    currentSession.title = text.slice(0, 30) + (text.length > 30 ? '...' : '');
    delete currentSession.isNew;
    saveSessions(data);
  }

  await sendSafeMessage(chatId, `⏳ Running in *${currentSession.title}*...`, { parse_mode: 'Markdown' });

  // Escape prompt for shell execution
  const safePrompt = text.replace(/"/g, '\\"');
  const command = `"${claudeBin}" --resume "${currentSession.id}" -p "${safePrompt}"`;

  const startTime = Date.now();
  log('INFO', `Executing Claude Code command in session: ${currentSession.title} (${currentSession.id})`, {
    prompt: text,
    cwd: PROJECT_CWD
  });

  exec(command, {
    cwd: PROJECT_CWD,
    env: process.env,
    maxBuffer: 1024 * 1024 * 10 // 10MB buffer
  }, async (error, stdout, stderr) => {
    const elapsed = Date.now() - startTime;
    const output = (stdout || stderr || error?.message || 'Task completed with no output.').trim();

    if (error) {
      log('ERROR', `Claude Code execution failed after ${elapsed}ms`, {
        error: error.message,
        stderr: stderr?.trim()
      });
    } else {
      log('INFO', `Claude Code execution succeeded in ${elapsed}ms`, {
        outputLength: output.length
      });
    }

    await sendLongOutput(chatId, output);
  });
});

log('INFO', 'Claude Code Telegram controller is now listening.');
