const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'bot.pid');

function stopService() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('ℹ️ No bot.pid file found. Checking for running bot.js processes...');
    try {
      // Fallback for Linux / Mac environments
      const { execSync } = require('child_process');
      const pids = execSync('pgrep -f "node.*bot.js" || true', { encoding: 'utf8' }).trim();
      if (pids) {
        const pidList = pids.split('\n').filter(Boolean);
        for (const pid of pidList) {
          if (parseInt(pid, 10) !== process.pid) {
            process.kill(parseInt(pid, 10), 'SIGTERM');
            console.log(`🛑 Terminated process PID: ${pid}`);
          }
        }
        console.log('✅ Service stopped successfully.');
        return;
      }
    } catch (e) {
      // Ignore fallback errors
    }
    console.log('⚠️ No active Claude Code service appears to be running.');
    return;
  }

  const pidStr = fs.readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    console.error(`❌ Invalid PID found in ${PID_FILE}: "${pidStr}"`);
    fs.unlinkSync(PID_FILE);
    return;
  }

  try {
    // Check if process is alive
    process.kill(pid, 0);
  } catch (err) {
    console.log(`ℹ️ Process PID ${pid} is not running (stale pid file). Cleaning up...`);
    fs.unlinkSync(PID_FILE);
    return;
  }

  console.log(`🛑 Stopping Claude Code service (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    
    // Give it a moment to gracefully exit
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      try {
        process.kill(pid, 0); // Still alive?
        if (attempts >= 5) {
          // Force kill if it doesn't respond to SIGTERM
          console.log(`⚠️ Process PID ${pid} did not exit gracefully, sending SIGKILL...`);
          process.kill(pid, 'SIGKILL');
          clearInterval(interval);
          if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
          console.log('✅ Service forcefully stopped.');
        }
      } catch (e) {
        // Process is dead
        clearInterval(interval);
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        console.log('✅ Service stopped successfully.');
      }
    }, 500);

  } catch (err) {
    console.error(`❌ Failed to stop process PID ${pid}:`, err.message);
  }
}

stopService();
