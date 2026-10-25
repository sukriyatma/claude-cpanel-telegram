const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'bot.pid');
const CURRENT_DIR = __dirname;
const CURRENT_PID = process.pid;

/**
 * Scans the system for all running instances related to claude-cpanel-telegram.
 * Returns structured information about active processes and the bot.pid file.
 * 
 * @param {Object} [options]
 * @param {number|null} [options.excludePid] PID to exclude (defaults to current process if CLI)
 * @param {number|null} [options.callerPid] PID of caller (e.g. if bot.js calls this, to flag itself)
 */
function getRunningInstances(options = {}) {
  const isCli = require.main === module;
  const callerPid = options.callerPid || null;
  const excludePid = options.excludePid !== undefined ? options.excludePid : (isCli ? CURRENT_PID : null);

  let filePid = null;
  let filePidAlive = false;

  if (fs.existsSync(PID_FILE)) {
    try {
      const content = fs.readFileSync(PID_FILE, 'utf8').trim();
      const parsed = parseInt(content, 10);
      if (!isNaN(parsed)) {
        filePid = parsed;
        try {
          process.kill(filePid, 0);
          filePidAlive = true;
        } catch (e) {
          filePidAlive = false;
        }
      }
    } catch (e) {}
  }

  const instances = [];
  const foundPids = new Set();

  // Try parsing ps -eo pid,ppid,%cpu,%mem,etime,command (standard on macOS & Linux)
  let psOutput = '';
  try {
    psOutput = execSync('ps -eo pid,ppid,%cpu,%mem,etime,command 2>/dev/null', { encoding: 'utf8' });
  } catch (err) {
    try {
      psOutput = execSync('ps aux 2>/dev/null', { encoding: 'utf8' });
    } catch (e) {}
  }

  if (psOutput) {
    const lines = psOutput.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const tokens = line.split(/\s+/);
      if (tokens.length < 6) continue;

      // Detect format (ps -eo pid,ppid,%cpu,%mem,etime,command vs ps aux)
      let pid, ppid, cpu, mem, etime, command;
      if (line.match(/^\d+/)) {
        // ps -eo pid,ppid,%cpu,%mem,etime,command
        pid = parseInt(tokens[0], 10);
        ppid = parseInt(tokens[1], 10);
        cpu = tokens[2] + '%';
        mem = tokens[3] + '%';
        etime = tokens[4];
        command = tokens.slice(5).join(' ');
      } else {
        // ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
        pid = parseInt(tokens[1], 10);
        ppid = null;
        cpu = tokens[2] + '%';
        mem = tokens[3] + '%';
        etime = tokens[9] || tokens[8];
        command = tokens.slice(10).join(' ');
      }

      if (!pid) continue;
      if (excludePid && pid === excludePid) continue;

      // Filter: ignore ps, grep, and the instances script itself
      if (command.includes('instances.js') || command.includes('instances.sh') || command.includes('ps -eo')) {
        continue;
      }

      // Check if this process belongs to the app
      const isBot = command.includes('bot.js');
      const isProjectClaude = (command.includes('claude') || command.includes('node')) &&
        (command.includes(CURRENT_DIR) || command.includes('@anthropic-ai/claude-code'));
      const isRegisteredPid = (filePid && pid === filePid);

      if (isBot || isProjectClaude || isRegisteredPid) {
        if (!foundPids.has(pid)) {
          foundPids.add(pid);

          let type = 'Node Process';
          if (isBot) {
            type = (callerPid && pid === callerPid) ? '🤖 Bot Daemon (Active)' : '🤖 Bot Daemon';
          } else if (command.includes('claude')) {
            type = '⚡ Claude CLI';
          }

          instances.push({
            pid,
            ppid: ppid || 'N/A',
            type,
            cpu,
            mem,
            etime,
            isCurrent: (callerPid && pid === callerPid),
            registered: (filePid && pid === filePid),
            command
          });
        }
      }
    }
  }

  // Fallback: If ps was blocked by sandbox or failed, but bot.pid is alive
  if (filePid && filePidAlive && !foundPids.has(filePid)) {
    if (!excludePid || filePid !== excludePid) {
      instances.push({
        pid: filePid,
        ppid: 'N/A',
        type: (callerPid && filePid === callerPid) ? '🤖 Bot Daemon (Active)' : '🤖 Bot Daemon',
        cpu: 'N/A',
        mem: 'N/A',
        etime: 'N/A',
        isCurrent: (callerPid && filePid === callerPid),
        registered: true,
        command: 'node bot.js (from bot.pid)'
      });
    }
  }

  return {
    instances,
    count: instances.length,
    pidFile: {
      exists: fs.existsSync(PID_FILE),
      pid: filePid,
      alive: filePidAlive,
      status: !fs.existsSync(PID_FILE)
        ? 'Not found (No active single-instance registered)'
        : filePidAlive
          ? `Active & alive (PID: ${filePid})`
          : `Stale PID file (PID ${filePid} is not running)`
    }
  };
}

// Format instances into a clean CLI table / display string
function formatInstancesCLI(data) {
  const { instances, count, pidFile } = data;
  let out = '';

  out += '=================================================================\n';
  out += '          Claude Code cPanel - Active Instances Inspector        \n';
  out += '=================================================================\n\n';

  out += `📁 Working Directory : ${CURRENT_DIR}\n`;
  out += `📄 bot.pid Status     : ${pidFile.status}\n`;
  out += `📊 Total Active       : ${count} instance(s)\n\n`;

  if (count === 0) {
    out += '🟢 No active bot instances or subprocesses are currently running.\n';
    out += '   Start with: npm start (or node bot.js)\n';
    out += '=================================================================\n';
    return out;
  }

  out += 'ACTIVE PROCESSES:\n';
  out += '------------------------------------------------------------------------------------------------------\n';
  out += `${'PID'.padEnd(8)} ${'PPID'.padEnd(8)} ${'TYPE'.padEnd(18)} ${'CPU'.padEnd(8)} ${'MEM'.padEnd(8)} ${'UPTIME'.padEnd(12)} ${'REG'.padEnd(6)} COMMAND\n`;
  out += '------------------------------------------------------------------------------------------------------\n';

  instances.forEach((inst) => {
    const regLabel = inst.registered ? 'YES' : 'NO';
    const cmdSummary = inst.command.length > 50 ? inst.command.slice(0, 47) + '...' : inst.command;
    out += `${String(inst.pid).padEnd(8)} ${String(inst.ppid).padEnd(8)} ${inst.type.padEnd(18)} ${inst.cpu.padEnd(8)} ${inst.mem.padEnd(8)} ${inst.etime.padEnd(12)} ${regLabel.padEnd(6)} ${cmdSummary}\n`;
  });

  out += '------------------------------------------------------------------------------------------------------\n';
  out += 'Legend: [REG: YES = PID is registered in bot.pid | NO = Unregistered or background child process]\n\n';

  out += 'MANAGEMENT COMMANDS:\n';
  out += ' • Stop single instance   : npm stop          (or: node stop.js)\n';
  out += ' • Stop ALL instances     : npm run stop:all  (or: node stop-all.js)\n';
  out += ' • Kill specific PID      : kill <PID>        (e.g., kill ' + instances[0].pid + ')\n';
  out += '=================================================================\n';

  return out;
}

// If executed directly from command line
if (require.main === module) {
  const isJson = process.argv.includes('--json');
  const data = getRunningInstances();

  if (isJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatInstancesCLI(data));
  }
}

module.exports = {
  getRunningInstances,
  formatInstancesCLI
};
