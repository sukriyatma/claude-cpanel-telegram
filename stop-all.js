const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'bot.pid');
const CURRENT_DIR = __dirname;
const CURRENT_PID = process.pid;

console.log('🔍 Scanning for all running instances of claude-cpanel-telegram...');

const pidsToKill = new Set();

// 1. Read PID file if available
if (fs.existsSync(PID_FILE)) {
  try {
    const filePid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(filePid) && filePid !== CURRENT_PID) {
      try {
        process.kill(filePid, 0); // check alive
        pidsToKill.add(filePid);
        console.log(`• Found PID from bot.pid: ${filePid}`);
      } catch (e) {}
    }
  } catch (e) {}
}

// 2. Scan process table for bot.js and Claude processes associated with this app
try {
  const psOutput = execSync('ps -eo pid,command 2>/dev/null || ps aux 2>/dev/null || true', { encoding: 'utf8' });
  const lines = psOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip the current script process
    const parts = trimmed.split(/\s+/);
    const pid = parseInt(parts[0], 10) || parseInt(parts[1], 10);
    if (!pid || pid === CURRENT_PID) continue;

    // Match bot.js or Claude binaries running in this app directory
    const isBot = trimmed.includes('bot.js');
    const isProjectClaude = trimmed.includes(CURRENT_DIR) && (trimmed.includes('claude') || trimmed.includes('node'));

    if (isBot || isProjectClaude) {
      pidsToKill.add(pid);
      console.log(`• Found matching process: [PID: ${pid}] ${trimmed.slice(0, 80)}...`);
    }
  }
} catch (err) {
  // Fallback to pgrep if ps fails
  try {
    const pgrepOut = execSync('pgrep -f "bot\\.js" 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (pgrepOut) {
      pgrepOut.split('\n').map(p => parseInt(p.trim(), 10)).forEach(p => {
        if (p && p !== CURRENT_PID) pidsToKill.add(p);
      });
    }
  } catch (e) {}
}

if (pidsToKill.size === 0) {
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  console.log('✅ No running instances found. Everything is clean.');
  process.exit(0);
}

console.log(`\n🛑 Terminating ${pidsToKill.size} active process(es)...`);

// First pass: Graceful SIGTERM
for (const pid of pidsToKill) {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`  └ Sent SIGTERM to PID ${pid}`);
  } catch (e) {}
}

// Wait 1.5 seconds and force kill any stubborn processes with SIGKILL
setTimeout(() => {
  let anyRemaining = false;

  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 0); // Check if still alive
      anyRemaining = true;
      process.kill(pid, 'SIGKILL');
      console.log(`  └ Force killed (SIGKILL) stubborn PID ${pid}`);
    } catch (e) {
      // Process has successfully exited
    }
  }

  // Clean up PID file
  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
  }

  console.log('🎉 All instances have been completely stopped.\n');
  process.exit(0);
}, 1500);
