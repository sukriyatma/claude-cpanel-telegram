# Claude Code cPanel Controller (Telegram Bot)

A lightweight bridge that enables you to run and control **Claude Code** on a cPanel web server (without SSH access) remotely from your phone using Telegram, featuring:
- **Interactive Permission Control (`/mode`):** Switch between Auto-Accept Edits, Full Autonomous, and Safe Plan modes with one tap.
- **Interactive OAuth `/login` from Telegram:** Sign in to your Claude Pro/Team account via link.
- **Interactive session switching:** Toggle between separate tasks with Telegram inline buttons (`/sessions`).
- **Rich Markdown Formatting:** Automatically renders Claude's output with bold headers, bullet lists, monospace badges, and copyable code blocks.
- **Persistent file logging & live in-chat debugging:** Inspect logs on your phone via `/logs`.

---

## Features

- 📱 **Control Claude from Mobile:** Send instructions and receive code modifications directly within Telegram.
- ⚙️ **One-Tap Permission Mode (`/mode`):** Control whether Claude can auto-edit files, run shell commands, or run in read-only mode.
- 🔐 **One-Tap OAuth Login (`/login`):** Generates an official Anthropic OAuth authorization link directly in Telegram. Tap to login on your phone, copy the code, and paste it back into the chat!
- 🔑 **API Key Support (`/setkey`):** Set or update your Anthropic API Key directly from Telegram.
- 🔄 **Interactive Session Switcher:** View past sessions and switch between them using clickable inline buttons (`/sessions`).
- 📝 **Dedicated Debug Log File (`bot.log`):** Automatically logs all messages, unauthorized attempts, Claude execution commands, timestamps, and errors.
- 🔍 **Live In-Chat Log Inspection:** Inspect debug logs directly on your phone using `/logs [count]`.
- ⚡ **No SSH Required:** Works completely inside cPanel's **Setup Node.js App** (Passenger daemon).
- 🔒 **Secure:** Restricted to your personal Telegram User ID (`TELEGRAM_USER_ID`) so no unauthorized person can run commands on your server.
- 💾 **Persistent:** Sessions and history survive server restarts (`sessions.json`).

---

## Permission Modes (`/mode`)

In headless mode, nobody is sitting at a terminal to type `y` or `n`. You can control permissions on the fly using `/mode`:

| Mode | Flag | Description |
|---|---|---|
| **✍️ Auto-Accept Edits** *(Default)* | `--permission-mode acceptEdits` | Allows Claude to read, create, and modify project files automatically without prompting, but prevents running unapproved shell commands. |
| **🚀 Full Autonomous** | `--dangerously-skip-permissions` | Complete automation: allows editing files **and** executing shell/terminal commands (`npm`, `git`, build scripts). |
| **🛡️ Safe / Plan Only** | `--permission-mode plan` | Read-only mode: Claude inspects code, reviews, and answers questions, but cannot make any file edits. |

---

## Usage Commands

| Command | Action |
|---|---|
| *Any text* | Prompts Claude Code on the currently active session |
| `/mode` | Interactive menu to toggle permission approvals (Edits, Full Auto, Safe) |
| `/sessions` or `/list` | Shows clickable buttons to switch between past sessions |
| `/new [title]` | Creates and switches to a fresh new session |
| `/login` or `/reauth` | Generates a sign-in link to connect your Claude Pro/Team account |
| `/status` | Checks your current authentication status |
| `/setkey <api-key>` | Directly saves an Anthropic API Key (`sk-ant-...`) |
| `/logs [count]` | Shows the latest log entries in Telegram (default: 30 lines) |
| `/cwd` | Displays the directory Claude is currently editing |
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
   - *(Optional)* `PROJECT_CWD`: `/home/username/public_html` (folder you want Claude to edit)
6. Click **Restart**.

### 3. Log In from Telegram
1. Type `/login` in your bot chat.
2. Tap the button to log in with your Claude Pro/Team account.
3. Paste the code back into the chat. Done!

---

## License

MIT License
