# Claude Code cPanel Controller (Telegram Bot)

A lightweight bridge that enables you to run and control **Claude Code** on a cPanel web server (without SSH access) remotely from your phone using Telegram, featuring:
- **Interactive OAuth `/login` from Telegram** (Sign in to your Claude Pro/Team account via link)
- **Interactive session switching** via Telegram Inline Keyboard buttons
- **Persistent file logging & live in-chat debugging**

---

## Features

- 📱 **Control Claude from Mobile:** Send instructions and receive code modifications directly within Telegram.
- 🔐 **One-Tap OAuth Login (`/login`):** Generates an official Anthropic OAuth authorization link directly in Telegram. Tap to login on your phone, copy the code, and paste it back into the chat!
- 🔑 **API Key Support (`/setkey`):** Set or update your Anthropic API Key directly from Telegram.
- 🔄 **Interactive Session Switcher:** View past sessions and switch between them using clickable inline buttons (`/sessions`).
- 📝 **Dedicated Debug Log File (`bot.log`):** Automatically logs all messages, unauthorized attempts, Claude execution commands, timestamps, and errors.
- 🔍 **Live In-Chat Log Inspection:** Inspect debug logs directly on your phone using `/logs [count]`.
- ⚡ **No SSH Required:** Works completely inside cPanel's **Setup Node.js App** (Passenger daemon).
- 🔒 **Secure:** Restricted to your personal Telegram User ID (`TELEGRAM_USER_ID`) so no unauthorized person can run commands on your server.
- 💾 **Persistent:** Sessions and history survive server restarts (`sessions.json`).

---

## Architecture

```
 📱 Your Phone (Telegram)
       │
       │ (1) Chat / Tap Login Link / Switch Sessions
       ▼
 🌐 cPanel Server (Phusion Passenger / Node.js)
       │
       │ (2) Runs `bot.js` 24/7 in background
       │ (3) Manages OAuth code exchange & session state
       ▼
 🤖 Claude Code Engine (`@anthropic-ai/claude-code`)
       │
       │ (4) Executes `--resume <id> -p "prompt"`
       │ (5) Modifies files in your project directory
       ▼
 📬 Telegram Bot replies with the execution results & diffs
```

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
   - *(Optional)* `PROJECT_CWD`: `/home/username/public_html` (folder you want Claude to edit)
6. Click **Restart**.

### 3. Log In from Telegram (No SSH Needed!)
Once the bot is running:
1. Open your Telegram bot and type:
   ```text
   /login
   ```
2. The bot sends a button: **🔗 Tap to Log In to Claude**.
3. Tap the link to open the Claude authorization page in your mobile browser.
4. Sign in with your Claude Pro / Team account and click **Authorize**.
5. Copy the code displayed on your screen, and paste it directly into your Telegram chat.
6. The bot confirms authentication, and you are ready to code!

---

## Usage Commands

| Command | Action |
|---|---|
| *Any text* | Prompts Claude Code on the currently active session |
| `/login` or `/reauth` | Generates a sign-in link to connect your Claude Pro/Team account |
| `/status` | Checks your current authentication status |
| `/setkey <api-key>` | Directly saves an Anthropic API Key (`sk-ant-...`) |
| `/sessions` or `/list` | Shows clickable buttons to switch between past sessions |
| `/new [title]` | Creates and switches to a fresh new session |
| `/logs [count]` | Shows the latest log entries in Telegram (default: 30 lines) |
| `/cwd` | Displays the directory Claude is currently editing |
| `/help` | Shows command cheat sheet |

---

## License

MIT License
