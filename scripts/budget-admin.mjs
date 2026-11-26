import { mkdir } from 'node:fs/promises';
import { loadProjects } from '../config.mjs';
import { budgetAdmin, parseBudgetConfig } from '../budget.mjs';

const usage = 'Usage: budget-admin.mjs <init|policy|reconcile|status> --authorized-by <operator> [--reservation <id> | --hold <id>] [--evidence <text>] [--stale-lock]';

function parseArgs(args) {
  const command = args.shift();
  if (!['init', 'policy', 'reconcile', 'status'].includes(command)) throw new Error(usage);
  const out = {};
  const values = new Map([
    ['--authorized-by', 'authorizedBy'],
    ['--reservation', 'reservation'],
    ['--hold', 'hold'],
    ['--evidence', 'evidence'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--stale-lock') {
      if (out.staleLock) throw new Error('Duplicate --stale-lock');
      out.staleLock = true;
      continue;
    }
    const key = values.get(flag);
    if (!key) throw new Error(`Unknown option: ${flag}`);
    if (out[key] !== undefined || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`Invalid ${flag} value`);
    out[key] = args[++i];
  }
  if (!out.authorizedBy) throw new Error('--authorized-by is required');
  if (out.staleLock && !out.evidence) throw new Error('--stale-lock requires --evidence');
  if (command === 'reconcile' && !out.reservation && !out.hold && !out.staleLock) throw new Error('Pass --reservation, --hold or --stale-lock');
  if (out.reservation && out.hold) throw new Error('Pass only one of --reservation and --hold');
  return { command, options: out };
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const admin = budgetAdmin({ dataDir });
  let result;
  if (command === 'init' || command === 'policy') {
    const projects = await loadProjects(process.env);
    const config = parseBudgetConfig(process.env.BUDGET_JSON, Object.keys(projects));
    result = await admin[command]({ ...options, config });
  } else if (command === 'reconcile') {
    result = await admin.reconcile(options);
  } else {
    result = await admin.status(options);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e?.message || 'Budget admin command failed');
  process.exitCode = 1;
}
