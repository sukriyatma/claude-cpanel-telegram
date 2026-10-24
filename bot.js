require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID;
const PROJECT_CWD = process.env.PROJECT_CWD || __dirname;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const LOG_FILE = path.join(__dirname, 'bot.log');
const ENV_FILE = path.join(__dirname, '.env');

// Track interactive authentication process
let activeAuthProcess = null;
let activeAuthTimeout = null;

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
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      if (data && Array.isArray(data.list) && data.activeId) {
        return data;
      }
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

  // Timeout after 5 minutes if user doesn't complete
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

    // Look for authorization URL
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
          // If inline button fails, send plain text URL
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
      '• `/login` or `/reauth`: Sign in with your Claude Pro/Team subscription via link.\n' +
      '• `/status`: Check authentication status.\n' +
      '• `/setkey <key>`: Configure an Anthropic API Key directly.\n' +
      '• `/sessions` or `/list`: View and switch sessions.\n' +
      '• `/new [name]`: Start a new named session.\n' +
      '• `/logs [lines]`: Read recent debug log entries (default 30).\n' +
      '• `/cwd`: Show current working directory.\n' +
      '• `/help`: Display this guide.';
    return sendSafeMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
  }

  // Login / Reauth command
  if (text === '/login' || text === '/auth' || text === '/reauth') {
    return startOAuthLogin(chatId);
  }

  // Check auth status
  if (text === '/status' || text === '/whoami') {
    await sendSafeMessage(chatId, '🔍 Checking authentication status...');
    exec(`"${claudeBin}" auth status < /dev/null`, { cwd: PROJECT_CWD, env: process.env }, (err, stdout, stderr) => {
      const output = (stdout || stderr || err?.message || '').trim();
      return sendSafeMessage(chatId, `📋 *Auth Status:*\n\`\`\`json\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
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

    // Persist into .env file
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

  if (text === '/cwd') {
    return sendSafeMessage(chatId, `📁 Working Directory: \`${PROJECT_CWD}\``, { parse_mode: 'Markdown' });
  }

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

  // Auto-name session from first prompt if newly created
  if (currentSession.isNew) {
    currentSession.title = text.slice(0, 30) + (text.length > 30 ? '...' : '');
    delete currentSession.isNew;
    saveSessions(data);
  }

  await sendSafeMessage(chatId, `⏳ Running in *${currentSession.title}*...`, { parse_mode: 'Markdown' });

  const safePrompt = text.replace(/"/g, '\\"');
  const startTime = Date.now();

  log('INFO', `Executing Claude Code command in session: ${currentSession.title} (${currentSession.id})`, {
    initialized: !!currentSession.initialized,
    prompt: text,
    cwd: PROJECT_CWD
  });

  // Self-healing execution handler that handles --resume vs --session-id automatically
  function executeCommand(flag, sessionId, retryCount = 0) {
    const command = `"${claudeBin}" ${flag} "${sessionId}" -p "${safePrompt}" < /dev/null`;

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
      const output = (stdout || stderr || error?.message || 'Task completed with no output.').trim();

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

      await sendLongOutput(chatId, output);
    });
  }

  const initialFlag = currentSession.initialized ? '--resume' : '--session-id';
  executeCommand(initialFlag, currentSession.id);
});

log('INFO', 'Claude Code Telegram controller is now listening.');
