# Claude Code cPanel Controller (Telegram Bot)

A lightweight bridge that enables you to run and control **Claude Code** on a cPanel web server (without SSH access) remotely from your phone using Telegram, featuring:
- **Real-Time Live Progress Monitoring:** Watch Claude work in real time! The bot displays and updates an in-chat status card showing every file read, search, edit, and bash command as it happens.
- **Simultaneous Multi-Folder Access (`/adddir`, `/dirs`):** Give Claude access to multiple project directories at the same time using `--add-dir`.
- **Interactive Permission Control (`/mode`):** Switch between Auto-Accept Edits, Full Autonomous, and Safe Plan modes with one tap.
- **Interactive OAuth `/login` from Telegram:** Sign in to your Claude Pro/Team account via link.
- **Interactive Session Switching (`/sessions`):** Toggle between separate tasks with Telegram inline buttons.
- **Rich Markdown Formatting & Auto-Chunking:** Automatically renders Claude's output with bold headers, bullet lists, monospace badges, and copyable code blocks without message-length errors.
- **Service Management (`npm start`, `npm stop`, `npm run stop:all`, `/stop`):** Easily start, stop, or terminate all instances anytime.
- **Persistent file logging & live in-chat debugging:** Inspect logs on your phone via `/logs`.

---

## Real-Time Live Progress Monitoring

When you send a prompt, the bot sends a **Live Activity Card** and continuously edits it in place as Claude works:

```text
⏳ Claude is working... [acceptEdits]
Session: Main Site (2 folders)

🛠️ Live Activity:
✓ 📖 Reading index.html
✓ 🔍 Searching codebase for 'handleLogin'
▶️ ✍️ Editing auth.php...
```

When finished, the card updates to:
```text
✅ Task Completed! (5.2s)
Session: Main Site

🛠️ Actions performed:
• 📖 Reading index.html
• 🔍 Searching codebase for 'handleLogin'
• ✍️ Editing auth.php
```
...and the final formatted answer/diff is delivered cleanly below!

---

## Starting and Stopping the Service

### Starting
```bash
npm start
# or: node bot.js
```

### Stopping Single Instance
1. **Via Telegram:** Send `/stop` or `/shutdown` in your Telegram chat.
2. **Via NPM:** `npm stop`
3. **Via Node:** `node stop.js`
4. **Via Bash:** `./stop.sh`

### Stopping ALL Instances & Subprocesses
If you accidentally ran multiple background processes or want to completely kill all bot runners and Claude subprocesses:
```bash
npm run stop:all
# or: node stop-all.js
# or: ./stop-all.sh
```

---

## Simultaneous Multi-Folder Access

Claude Code supports working across multiple folders at once using the `--add-dir` flag:

| Command | Action |
|---|---|
| `/dirs` or `/folders` | Lists the primary working directory and all additional accessible folders |
| `/adddir <path>` | Grants Claude access to another folder simultaneously |
| `/rmdir <path>` | Revokes access to an additional folder |
| `/cd <path>` | Changes the primary working directory (`cwd`) |
| `/cleardirs` | Clears all additional folder permissions |

---

## Permission Modes (`/mode`)

In headless mode, you can control approvals directly from Telegram:

| Mode | Flag | Description |
|---|---|---|
| **✍️ Auto-Accept Edits** *(Default)* | `--permission-mode acceptEdits` | Allows Claude to read, create, and modify project files automatically across all allowed folders without prompting. |
| **🚀 Full Autonomous** | `--dangerously-skip-permissions` | Complete automation: allows editing files **and** executing shell/terminal commands (`npm`, `git`, build scripts). |
| **🛡️ Safe / Plan Only** | `--permission-mode plan` | Read-only mode: Claude inspects code, reviews, and answers questions, but cannot make any file edits. |

---

## All Telegram Commands

| Command | Action |
|---|---|
| *Any text* | Prompts Claude Code with real-time live activity tracking |
| `/dirs` | Displays all configured directories (primary + additional) |
| `/adddir <path>` | Adds an additional folder for simultaneous access |
| `/rmdir <path>` | Removes an additional folder |
| `/cd <path>` | Switches primary working directory |
| `/mode` | Interactive menu to toggle permission approvals (Edits, Full Auto, Safe) |
| `/sessions` or `/list` | Shows clickable buttons to switch between past sessions |
| `/new [title]` | Creates and switches to a fresh new session |
| `/login` or `/reauth` | Generates a sign-in link to connect your Claude Pro/Team account |
| `/status` | Checks your current authentication status |
| `/setkey <api-key>` | Directly saves an Anthropic API Key (`sk-ant-...`) |
| `/logs [count]` | Shows the latest log entries in Telegram (default: 30 lines) |
| `/stop` | Gracefully terminates the running controller daemon |
| `/help` | Shows command cheat sheet |

---

## Setup Instructions

### 1. Create a Telegram Bot
1. Open Telegram on your phone and search for `@BotFather`.
2. Send `/newbot`, follow the prompts, and copy the **Bot Token**.
3. Open `@userinfobot` on Telegram to get your numeric **User ID** (e.g., `123456789`).

### 2. Deploy to cPanel
1. In cPanel, go to **Setup Node.js App**.
2. Click **Create Application**:
   - **Node.js version:** Select `18` or `20`.
   - **Application mode:** `Production`.
   - **Application root:** `claude-bridge` (or folder of choice).
   - **Application startup file:** `bot.js`.
3. Upload this repository's files into that application folder.
4. Click **Run NPM Install** in cPanel.
5. In the same Node.js setup page, scroll down to **Environment Variables** and add:
   - `TELEGRAM_TOKEN`: `your-bot-token-from-botfather`
   - `TELEGRAM_USER_ID`: `your-numeric-user-id`
   - *(Optional)* `PROJECT_CWD`: `/home/username/public_html`
   - *(Optional)* `EXTRA_DIRS`: `/home/username/api,/home/username/shared`
6. Click **Restart**.

### 3. Log In from Telegram
1. Type `/login` in your bot chat.
2. Tap the button to log in with your Claude Pro/Team account.
3. Paste the code back into the chat. Done!

---

## License

MIT License
