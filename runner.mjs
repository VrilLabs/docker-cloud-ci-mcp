// Executes one build: attaches Docker-native stored secrets (injected by Docker's proxy, never written into the sandbox),
// runs the operator-approved script, exports declared artifacts, reports status to the forge, and always cleans up.
import { scriptFor } from './policy.mjs';
import { publishStatus } from './statuses.mjs';
import { collectArtifacts, storeArtifacts } from './artifacts.mjs';
import { LAUNCH_TIMEOUT_SECONDS, TTL_SECONDS } from './budget.mjs';

export const LAUNCH_TIMEOUT_MS = LAUNCH_TIMEOUT_SECONDS * 1000;
export const SANDBOX_TTL_MS = TTL_SECONDS * 1000;
// Tolerated difference between this host's clock and Docker's when checking the reported expiry.
const EXPIRY_SKEW_MS = 120_000;
const SMALL = { cpus: 2, memoryMib: 4096 };
const RUN_TIMEOUT_MS = 600_000;
const MAX_LOG_CHARS = 64_000;
const MAX_STATUS_REPORTS = 6;
const CLEANUP_FAILED = 'FAILED: inspect Docker Console';

const redactor = values => {
  const ordered = [...new Set(values)].filter(v => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length);
  return text => ordered.reduce((acc, v) => acc.split(v).join('[REDACTED]'), String(text ?? '')).slice(-MAX_LOG_CHARS);
};

// A crash mid-build can leave a stored secret (holding a real token) in Docker's store. Only secrets matching our own
// naming scheme AND older than any build can legitimately run (launch 2 min + wait 2 min + script 10 min) are purged,
// so a second bridge instance sharing the Docker account (a dev copy, say) can never delete an in-flight build's secret.
const ORPHAN_NAME = /^bridge-[a-f0-9]{8}-\d+$/;
const ORPHAN_MIN_AGE_MS = 30 * 60_000;
export async function purgeOrphanSecrets(client, { minAgeMs = ORPHAN_MIN_AGE_MS, now = Date.now } = {}) {
  const purged = [];
  const failed = [];
  for await (const secret of client.secrets.all()) {
    if (!ORPHAN_NAME.test(secret.displayName ?? '')) continue;
    const created = secret.createdAt ? new Date(secret.createdAt).getTime() : NaN;
    if (!Number.isFinite(created) || now() - created < minAgeMs) continue;
    try { await secret.delete(); purged.push(secret.displayName); } catch { failed.push(secret.displayName); }
  }
  return { purged, failed };
}

// The server-side lifetime is the only bound on billing once create is sent: local timeouts neither delete a sandbox nor
// stop its processes. maxRetries 0 keeps the SDK from replaying a create whose first attempt may have allocated one.
export const launchRequest = secretNames => ({
  resources: 'small',
  lifecycle: { timeoutMs: SANDBOX_TTL_MS, onTimeout: 'delete', autoResume: false },
  ...(secretNames.length ? { storage: { secrets: [...secretNames] } } : {}),
});
export const LAUNCH_OPTIONS = Object.freeze({ timeoutMs: LAUNCH_TIMEOUT_MS, maxRetries: 0 });

const durationSeconds = d => {
  const m = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(String(d ?? ''));
  return m ? Number(m[1]) + Number(`0.${m[2] ?? '0'}`) : NaN;
};

// Returns a short reason when the accepted sandbox's effective lifetime, timeout action or size is missing or differs
// from what was requested; null when it matches.
export function lifetimeProblem(sandbox, { now = Date.now(), latestExpiryMs } = {}) {
  const t = sandbox?.effectiveFeatures?.timeouts;
  if (!t) return 'effective timeouts missing';
  if (t.onTimeout !== 'delete') return 'timeout action is not delete';
  if (t.autoResume !== false) return 'auto-resume is not disabled';
  if (sandbox.effectiveFeatures?.lifecycle?.autoResume === true) return 'auto-resume is enabled';
  if (durationSeconds(t.initialTimeout) !== SANDBOX_TTL_MS / 1000) return 'initial timeout differs from the requested lifetime';
  const expires = t.expiresAt instanceof Date ? t.expiresAt.getTime() : Date.parse(t.expiresAt ?? '');
  if (!Number.isFinite(expires)) return 'expiry missing';
  if (expires > now + SANDBOX_TTL_MS + EXPIRY_SKEW_MS) return 'expiry is later than the requested lifetime';
  if (latestExpiryMs !== undefined && expires > latestExpiryMs) return 'expiry is outside the reserved window';
  const r = sandbox?.core?.resources;
  if (!r || Number(r.cpus) !== SMALL.cpus || Number(r.memoryMib) !== SMALL.memoryMib) return 'resources are not the small size';
  return null;
}

export function createRunner({ client, env = process.env, fetch: fetchImpl = globalThis.fetch, dataDir, save, limits, now = () => new Date().toISOString(), clock = Date.now, guard = null }) {
  const report = async (job, spec) => {
    if (!client) return; // mock mode must never post statuses to a real commit
    const result = await publishStatus({ project: spec.project, projectName: spec.projectName, task: spec.taskName, job, env, fetch: fetchImpl });
    if (result.skipped) return;
    job.statusReports = [...(job.statusReports || []), { ...result, at: now() }].slice(-MAX_STATUS_REPORTS);
    await save(job);
  };

  const collect = async (job, spec, sandbox, redact) => {
    if (spec.task.artifacts.length === 0) return;
    try {
      const { files, skipped } = await collectArtifacts(sandbox, spec.task.artifacts, limits);
      // File names come from the sandbox (untrusted output), so they get the same redaction and length cap as logs.
      const label = p => redact(p).slice(0, 200);
      if (files.length) job.artifacts = (await storeArtifacts(dataDir, job.id, files)).map(a => ({ ...a, path: label(a.path) }));
      if (skipped.length) job.artifactsSkipped = skipped.map(s => ({ path: label(s.path), reason: s.reason }));
    } catch (e) {
      job.artifactsError = redact(e.message);
    }
  };

  const cleanup = async (job, sandbox, secrets, redact) => {
    if (sandbox) {
      try { const latest = await sandbox.refresh(); const deleting = await latest.delete({ force: true }); await deleting?.waitUntilDeleted(); job.cleanup = 'deleted'; }
      catch (e) { job.cleanup = CLEANUP_FAILED; job.cleanupError = redact(e.message); }
    }
    if (secrets.length) {
      const failures = [];
      for (const secret of secrets) { try { await secret.delete(); } catch (e) { failures.push(redact(e.message)); } }
      job.secretsCleanup = failures.length ? `${CLEANUP_FAILED} (stored secrets named bridge-${job.id.slice(0, 8)}-*)` : 'deleted';
      if (failures.length) job.secretsCleanupError = failures.join('; ').slice(0, 500);
    }
  };

  async function execute(job, spec, plan) {
    const redact = redactor(plan.redactions);
    const secrets = [];
    const rid = guard && job.budget?.mode === 'real' ? job.budget.reservationId : undefined;
    const track = { createAttempted: false, lifetimeProblem: null };
    let sandbox;
    let outcome = 'error';
    try {
      job.status = 'running';
      job.forwarded = plan.forwarded;
      await save(job);
      await report(job, spec);
      if (!client) {
        await new Promise(r => setTimeout(r, 100));
        job.stdout = 'Mock CI completed (no real build executed)';
        job.stderr = '';
        job.exitCode = 0;
      } else {
        for (const [i, s] of plan.secrets.entries()) {
          try { secrets.push(await client.secrets.create({ displayName: `bridge-${job.id.slice(0, 8)}-${i}`, ...s.create })); }
          catch (e) { throw new Error(`Docker rejected the stored secret for "${s.label}": ${e.code ?? e.message}`); }
        }
        let latestExpiryMs;
        if (rid) ({ latestExpiryMs } = await guard.beforeCreate(rid));
        track.createAttempted = true;
        const launched = await client.kits.launch('shell', launchRequest(secrets.map(s => s.name)), { ...LAUNCH_OPTIONS });
        if (!launched?.name) throw new Error('Docker returned no sandbox identity; the create outcome is uncertain');
        sandbox = launched;
        job.sandbox = sandbox.name;
        if (rid) await guard.created(rid, sandbox.name);
        await save(job);
        sandbox = await sandbox.waitUntilRunning({ timeoutMs: LAUNCH_TIMEOUT_MS });
        const latest = await sandbox.refresh();
        track.lifetimeProblem = lifetimeProblem(latest, { now: clock(), latestExpiryMs });
        if (track.lifetimeProblem) throw new Error(`Sandbox lifetime check failed (${track.lifetimeProblem}); repository code was not run`);
        sandbox = latest;
        if (rid) await guard.verified(rid);
        const run = { args: ['sh', '-c', scriptFor(spec, job.commit)] };
        if (Object.keys(plan.env).length) run.env = plan.env;
        const result = await sandbox.processes.run(run, { timeoutMs: RUN_TIMEOUT_MS });
        job.stdout = redact(result.stdout);
        job.stderr = redact(result.stderr);
        job.exitCode = result.exitCode;
        await collect(job, spec, sandbox, redact);
      }
      outcome = job.exitCode === 0 ? 'passed' : 'failed';
    } catch (e) {
      outcome = 'error';
      job.error = redact(e.message);
    } finally {
      await cleanup(job, sandbox, secrets, redact);
      if (track.createAttempted && !job.sandbox) job.cleanup = 'UNKNOWN: create outcome uncertain; inspect Docker Console for a bridge sandbox';
      if (rid) {
        try { await guard.settle(rid, { createAttempted: track.createAttempted, sandboxName: job.sandbox, cleanup: job.cleanup, secretsCleanup: job.secretsCleanup, lifetimeProblem: track.lifetimeProblem }); }
        catch (e) { job.budgetError = redact(e.message).slice(0, 300); }
      }
      // Terminal only after cleanup and settlement, so the one-active-job check covers them.
      job.status = outcome;
      job.finished = now();
      await save(job);
      await report(job, spec);
    }
  }

  return { execute };
}
