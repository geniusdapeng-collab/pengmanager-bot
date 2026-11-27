import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { runHealthProbe } from '../src/bot/health-probe.mjs';

function credential(name) {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  const error = new Error('PROBE_CREDENTIAL_UNAVAILABLE');
  error.code = error.message;
  if (!directory || !isAbsolute(directory)) throw error;
  let fd;
  try {
    fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077)) throw error;
    return readFileSync(fd, 'utf8').trim();
  } catch { throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

process.umask(0o077);
try {
  const status = await runHealthProbe({
    origin: process.env.BOT_HEALTH_ORIGIN,
    monitorId: process.env.BOT_HEALTH_MONITOR_ID,
    stateDirectory: process.env.BOT_HEALTH_STATE_DIR || process.env.STATE_DIRECTORY,
    receiverUrl: credential('BOT_HEALTH_WEBHOOK_URL'),
    token: credential('BOT_HEALTH_WEBHOOK_TOKEN'),
  });
  process.stdout.write(JSON.stringify(status) + '\n');
  if (status.notification === 'delivery_failed') process.exitCode = 1;
} catch (error) {
  const reason = /^PROBE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'PROBE_RUN_FAILED';
  process.stderr.write(`BOT health probe: ${reason}\n`);
  process.exitCode = 1;
}
