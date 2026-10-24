# Claude Code cPanel Controller (Telegram Bot)

A lightweight bridge that enables you to run and control **Claude Code** on a cPanel web server (without SSH access) remotely from your phone using Telegram, featuring **interactive session switching** and **persistent file logging for debugging**.

---

## Features

- 📱 **Control Claude from Mobile:** Send instructions and receive code modifications directly within Telegram.
- 🔄 **Interactive Session Switcher:** View past sessions and switch between them using clickable inline buttons (`/sessions`).
- 📝 **Dedicated Debug Log File (`bot.log`):** Automatically logs all messages, unauthorized attempts, Claude execution commands, timestamps, and errors.
- 🔍 **Live In-Chat Log Inspection:** Inspect debug logs directly on your phone using `/logs [count]`.
- 🔑 **Claude Pro / Team Subscription Support:** Use your existing Claude subscription without paying for API tokens (by uploading `~/.claude.json`).
- ⚡ **No SSH Required:** Works completely inside cPanel's **Setup Node.js App** (Passenger daemon).
- 🔒 **Secure:** Restricted to your personal Telegram User ID (`TELEGRAM_USER_ID`) so no unauthorized person can run commands on your server.
- 💾 **Persistent:** Sessions and history survive server restarts (`sessions.json`).

---

## Architecture

```
 📱 Your Phone (Telegram)
       │
       │ (1) Chat / Tap Session Buttons / Check /logs
       ▼
 🌐 cPanel Server (Phusion Passenger / Node.js)
       │
       │ (2) Runs `bot.js` 24/7 in background
       │ (3) Appends events & errors to `bot.log`
       ▼
 🤖 Claude Code Engine (`@anthropic-ai/claude-code`)
       │
       │ (4) Loads subscription auth (~/.claude.json)
       │ (5) Executes `--resume <id> -p "prompt"`
       │ (6) Modifies files in your project directory
       ▼
 📬 Telegram Bot replies with the execution results & diffs
```

---

## Setup Instructions

### 1. Create a Telegram Bot
1. Open Telegram on your phone and search for `@BotFather`.
2. Send `/newbot`, follow the prompts, and copy the **Bot Token**.
3. Open `@userinfobot` on Telegram to get your numeric **User ID** (e.g., `123456789`).

### 2. (Optional) Transfer Your Claude Pro / Team Subscription
If you have a Claude subscription and don't want to buy API credits:
1. On your personal computer, install and authenticate Claude Code once:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude
   ```
   Select **Claude.ai (Pro/Team)** and log in via your browser.
2. Locate the generated config file on your computer:
   - **Mac/Linux:** `~/.claude.json`
   - **Windows:** `C:\Users\<YourUser>\.claude.json`
3. In cPanel **File Manager**, enable *Show Hidden Files*, and upload `.claude.json` to your home directory (`/home/yourusername/`).

### 3. Deploy to cPanel
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
   - *(Optional)* `PROJECT_CWD`: `/home/username/public_html` (folder you want Claude to edit)
   - *(Optional if not using subscription)*: `ANTHROPIC_API_KEY`: `sk-ant-...`
6. Click **Restart**.

---

## Debugging with `bot.log`

Whenever you want to debug:

1. **Option A (Via cPanel File Manager):**  
   Open your application folder in cPanel File Manager. You will find `bot.log`. Double-click to view or download it.
2. **Option B (Directly on Your Phone):**  
   Simply send `/logs` in your Telegram chat to see the latest 30 log lines (or `/logs 50` for 50 lines).

Example log entries in `bot.log`:
```text
[2026-10-25 03:30:12] [INFO] Starting Claude Code Telegram controller... | Details: {"nodeVersion":"v20.11.0","pid":4120}
[2026-10-25 03:31:05] [INFO] Executing Claude Code command in session: Session 1 (uuid-123) | Details: {"prompt":"Fix header color in style.css"}
[2026-10-25 03:31:18] [INFO] Claude Code execution succeeded in 13240ms | Details: {"outputLength":482}
[2026-10-25 03:32:00] [WARN] Unauthorized access attempt blocked | Details: {"fromId":987654321}
```

---

## Usage from Telegram

| Command | Action |
|---|---|
| *Any text* | Prompts Claude Code on the currently active session |
| `/sessions` or `/list` | Shows clickable buttons to switch between past sessions |
| `/new [title]` | Creates and switches to a fresh new session |
| `/logs [count]` | Shows the latest log entries in Telegram (default: 30 lines) |
| `/cwd` | Displays the directory Claude is currently editing |
| `/help` | Shows command cheat sheet |

---

## License

MIT License
