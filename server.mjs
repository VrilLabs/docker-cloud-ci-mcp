import { mkdir } from 'node:fs/promises';
import { loadProjects, validateConfig } from './config.mjs';
import { purgeOrphanSecrets } from './runner.mjs';
import { parseBudgetConfig } from './budget.mjs';
import { createBridge } from './bridge.mjs';

const key = process.env.BRIDGE_API_KEY;
if (!key || key.length < 32) throw new Error('BRIDGE_API_KEY must have at least 32 characters');
const mock = process.env.MOCK_DOCKER === '1';
if (!mock && (!process.env.DOCKER_ID || !process.env.DOCKER_PAT)) throw new Error('Set DOCKER_ID and DOCKER_PAT');
const config = await loadProjects(process.env);
validateConfig(config, process.env); // fail fast with every problem listed, before serving anything
// Malformed budget configuration stops startup; a valid but unverified or unopened one only blocks real admission.
const budgetConfig = parseBudgetConfig(process.env.BUDGET_JSON, Object.keys(config));

// Railway mounts a persistent volume at RAILWAY_VOLUME_MOUNT_PATH; job records and artifacts must survive restarts.
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
const dir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (onRailway && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('Attach a Railway volume (or set DATA_DIR): job records and request_id dedupe need persistent disk');
await mkdir(dir, { recursive: true });

const positiveInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};
const limits = { maxFiles: positiveInt('ARTIFACT_MAX_FILES', 20), maxFileBytes: positiveInt('ARTIFACT_MAX_FILE_BYTES', 5 * 1024 * 1024), maxTotalBytes: positiveInt('ARTIFACT_MAX_TOTAL_BYTES', 20 * 1024 * 1024) };
const inlineMaxBytes = positiveInt('ARTIFACT_INLINE_MAX_BYTES', 256 * 1024);

let client = null;
if (!mock) {
  const { Sandboxes, pat } = await import('@docker/sandboxes');
  client = new Sandboxes({ auth: pat({ username: process.env.DOCKER_ID, personalAccessToken: process.env.DOCKER_PAT }), maxRetries: 0 });
}
if (client) {
  try {
    const { purged, failed } = await purgeOrphanSecrets(client);
    if (purged.length || failed.length) console.warn(`Startup: purged ${purged.length} leftover stored secret(s)${failed.length ? `; FAILED to delete ${failed.length} (${failed.join(', ')}): remove them in the Docker Console` : ''}`);
  } catch (e) { console.warn(`Startup: could not check for leftover stored secrets (${e.code ?? e.message})`); }
}

const bridge = await createBridge({ key, config, env: process.env, dataDir: dir, mock, client, budgetConfig, limits, inlineMaxBytes });
const budget = bridge.guard.status();
if (!mock) console.log(`Budget guard: real admission ${budget.realAdmission ? 'ready' : `disabled (${budget.reasons[0]})`}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  // The ledger lock stays behind if a reserved build is in flight, so the next start requires operator reconciliation.
  try { await bridge.shutdown(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

bridge.app.listen(Number(process.env.PORT || 8080), process.env.HOST || (onRailway ? '0.0.0.0' : '127.0.0.1'), () => console.log('Docker CI bridge ready; mock=' + mock));
