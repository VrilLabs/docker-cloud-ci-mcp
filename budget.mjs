// Fail-closed reservation guard for billable Docker builds. Every admitted build is charged its full worst-case
// compute bound in every UTC month it could overlap, and nothing is ever refunded. This is a conservative estimate
// of what this bridge could have launched, not an account-wide Docker cap and not an invoice.
import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LEDGER_FILE = 'budget-ledger.json';
export const LOCK_FILE = 'budget-ledger.lock';
export const MARKER_FILE = 'budget-ledger.initialized';
export const RECOVERY_FILE = 'budget-ledger.lock.recovery';
const FORMAT = 'docker-ci-bridge-budget-ledger';
const LEDGER_VERSION = 1;
export const TTL_SECONDS = 3600;
export const LAUNCH_TIMEOUT_SECONDS = 120;
// Time allowed between reservation and the Docker create call (stored-secret creation and the pending status post).
export const PRECREATE_MAX_SECONDS = 300;
export const ESTIMATE_LABEL = 'Estimated reservations made by this bridge; not amounts billed by Docker';
export const UNIT = 'micro-USD (1 USD = 1000000)';

const MAX_MICRO = 1_000_000_000_000;
const MAX_RATE = 1_000_000_000;
const MAX_SETUP_SECONDS = 3600;
const MAX_POLICY_VERSION = 1_000_000;
const MAX_PROJECTS = 200;
const MAX_MONTHS = 240;
const MAX_TEXT = 500;
const MAX_LISTED = 20;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PHASES = ['reserved', 'launch_intent', 'created', 'verified', 'closed'];
const OUTCOMES = ['deleted', 'aborted_prelaunch', 'held', 'reconciled'];
const JOB_FILE = /^[a-f0-9-]+\.json$/;
const TERMINAL = ['passed', 'failed', 'error'];

export class BudgetError extends Error {
  constructor(message) { super(message); this.name = 'BudgetError'; }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const iso = ms => new Date(ms).toISOString();
const text = (v, max = MAX_TEXT) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

// ---------------------------------------------------------------- configuration

const TOP_KEYS = ['version', 'policyVersion', 'currency', 'smallHourlyRateMicroUsd', 'monthlyAllowanceMicroUsd', 'projects', 'opening', 'maxSetupSeconds', 'ttlSeconds', 'evidence'];
const EVIDENCE_FLAGS = ['rateVerified', 'lifetimeVerified', 'setupVerified'];

function extraKeys(obj, allowed, where, problems) {
  const n = Object.keys(obj).filter(k => !allowed.includes(k)).length;
  if (n) problems.push(`${where}: ${n} unknown field(s)`);
}

// Problems name fields only, never values: BUDGET_JSON can hold private allowances and evidence references.
export function validateBudgetConfig(c, projectNames = null) {
  const problems = [];
  if (!isObj(c)) throw new Error('Invalid BUDGET_JSON:\n- must be a JSON object');
  extraKeys(c, TOP_KEYS, 'top level', problems);
  if (c.version !== 1) problems.push('version must be 1');
  if (!intIn(c.policyVersion, 1, MAX_POLICY_VERSION)) problems.push('policyVersion must be a positive integer');
  if (c.currency !== 'USD') problems.push('currency must be "USD"');
  if (!intIn(c.smallHourlyRateMicroUsd, 1, MAX_RATE)) problems.push(`smallHourlyRateMicroUsd must be an integer from 1 to ${MAX_RATE}`);
  if (!intIn(c.monthlyAllowanceMicroUsd, 0, MAX_MICRO)) problems.push(`monthlyAllowanceMicroUsd must be an integer from 0 to ${MAX_MICRO}`);
  if (!intIn(c.maxSetupSeconds, 1, MAX_SETUP_SECONDS)) problems.push(`maxSetupSeconds must be an integer from 1 to ${MAX_SETUP_SECONDS}`);
  if (c.ttlSeconds !== TTL_SECONDS) problems.push(`ttlSeconds must be ${TTL_SECONDS}`);

  const projects = c.projects ?? {};
  if (!isObj(projects) || Object.keys(projects).length > MAX_PROJECTS) problems.push(`projects must be an object with at most ${MAX_PROJECTS} entries`);
  else {
    let unknown = 0;
    for (const [name, p] of Object.entries(projects)) {
      if (projectNames && !projectNames.includes(name)) unknown++;
      if (!isObj(p)) { problems.push('every projects entry must be an object'); continue; }
      extraKeys(p, ['monthlyAllowanceMicroUsd'], 'projects entry', problems);
      if (!intIn(p.monthlyAllowanceMicroUsd, 0, MAX_MICRO)) problems.push(`projects entry monthlyAllowanceMicroUsd must be an integer from 0 to ${MAX_MICRO}`);
      else if (Number.isSafeInteger(c.monthlyAllowanceMicroUsd) && p.monthlyAllowanceMicroUsd > c.monthlyAllowanceMicroUsd) problems.push('a project allowance exceeds the global allowance');
    }
    if (unknown) problems.push(`projects: ${unknown} entry(ies) do not match a project in the allowlist`);
  }

  const opening = c.opening ?? {};
  if (!isObj(opening) || Object.keys(opening).length > MAX_MONTHS) problems.push(`opening must be an object with at most ${MAX_MONTHS} months`);
  else {
    for (const [month, o] of Object.entries(opening)) {
      if (!MONTH.test(month)) { problems.push('opening keys must be YYYY-MM months'); continue; }
      if (!isObj(o)) { problems.push(`opening ${month} must be an object`); continue; }
      extraKeys(o, ['globalMicroUsd', 'projects'], `opening ${month}`, problems);
      if (!intIn(o.globalMicroUsd, 0, MAX_MICRO)) problems.push(`opening ${month} globalMicroUsd must be an integer from 0 to ${MAX_MICRO}`);
      const po = o.projects ?? {};
      if (!isObj(po)) { problems.push(`opening ${month} projects must be an object`); continue; }
      let unknown = 0;
      for (const [name, v] of Object.entries(po)) {
        if (!isObj(projects) || !Object.hasOwn(projects, name)) unknown++;
        if (!intIn(v, 0, MAX_MICRO)) problems.push(`opening ${month} project usage must be integers from 0 to ${MAX_MICRO}`);
        else if (Number.isSafeInteger(o.globalMicroUsd) && v > o.globalMicroUsd) problems.push(`opening ${month} project usage exceeds global usage`);
      }
      if (unknown) problems.push(`opening ${month}: ${unknown} project entry(ies) have no project allowance`);
    }
  }

  const ev = c.evidence;
  if (!isObj(ev)) problems.push('evidence must be an object');
  else {
    extraKeys(ev, [...EVIDENCE_FLAGS, 'reference'], 'evidence', problems);
    for (const f of EVIDENCE_FLAGS) if (typeof ev[f] !== 'boolean') problems.push(`evidence.${f} must be true or false`);
    if (ev.reference !== undefined && !text(ev.reference)) problems.push(`evidence.reference must be a non-empty string of at most ${MAX_TEXT} characters`);
  }
  if (problems.length) throw new Error(`Invalid BUDGET_JSON:\n- ${[...new Set(problems)].join('\n- ')}`);

  return {
    version: 1, policyVersion: c.policyVersion, currency: 'USD',
    smallHourlyRateMicroUsd: c.smallHourlyRateMicroUsd, monthlyAllowanceMicroUsd: c.monthlyAllowanceMicroUsd,
    maxSetupSeconds: c.maxSetupSeconds, ttlSeconds: c.ttlSeconds,
    projects: Object.fromEntries(Object.entries(projects).map(([n, p]) => [n, { monthlyAllowanceMicroUsd: p.monthlyAllowanceMicroUsd }])),
    opening: Object.fromEntries(Object.entries(opening).map(([m, o]) => [m, { globalMicroUsd: o.globalMicroUsd, projects: { ...(o.projects ?? {}) } }])),
    evidence: { ...Object.fromEntries(EVIDENCE_FLAGS.map(f => [f, ev[f]])), ...(ev.reference === undefined ? {} : { reference: ev.reference }) },
  };
}

export function parseBudgetConfig(raw, projectNames = null) {
  if (raw === undefined || raw === '') return null;
  let c;
  try { c = JSON.parse(raw); } catch { throw new Error('BUDGET_JSON is not valid JSON'); }
  return validateBudgetConfig(c, projectNames);
}

const canonical = v => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));
export const policyDigest = config => createHash('sha256').update(canonical(config)).digest('hex');

// ---------------------------------------------------------------- arithmetic

export const buildSeconds = (config, launchSeconds = LAUNCH_TIMEOUT_SECONDS) => launchSeconds + config.maxSetupSeconds + config.ttlSeconds;

export function reservationCost(rateMicroUsdPerHour, seconds) {
  if (!intIn(rateMicroUsdPerHour, 1, MAX_RATE) || !intIn(seconds, 1, 1_000_000)) throw new BudgetError('Reservation inputs are out of range');
  const v = (BigInt(rateMicroUsdPerHour) * BigInt(seconds) + 3599n) / 3600n; // round up: never under-reserve
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetError('Reservation cost is not a safe integer');
  return Number(v);
}

export function monthsOverlapping(startMs, endMs) {
  const s = new Date(startMs);
  const e = new Date(endMs);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();
  const out = [];
  while (y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth())) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    if (++m === 12) { m = 0; y++; }
  }
  return out;
}

const chargedIn = (ledger, month, project) => ledger.reservations
  .filter(r => r.months.includes(month) && (project === undefined || r.project === project))
  .reduce((sum, r) => sum + r.costMicroUsd, 0);

function monthFigures(config, ledger, month, project) {
  const o = Object.hasOwn(config.opening, month) ? config.opening[month] : undefined;
  const g = {
    monthlyAllowanceMicroUsd: config.monthlyAllowanceMicroUsd,
    openingMicroUsd: o ? o.globalMicroUsd : null,
    estimatedReservedMicroUsd: ledger ? chargedIn(ledger, month) : null,
  };
  g.estimatedRemainingMicroUsd = o && ledger ? g.monthlyAllowanceMicroUsd - g.openingMicroUsd - g.estimatedReservedMicroUsd : null;
  if (project === undefined || !Object.hasOwn(config.projects, project)) return { global: g, project: null };
  const po = o && Object.hasOwn(o.projects, project) ? o.projects[project] : null;
  const p = {
    monthlyAllowanceMicroUsd: config.projects[project].monthlyAllowanceMicroUsd,
    openingMicroUsd: po,
    estimatedReservedMicroUsd: ledger ? chargedIn(ledger, month, project) : null,
  };
  p.estimatedRemainingMicroUsd = po !== null && ledger ? p.monthlyAllowanceMicroUsd - po - p.estimatedReservedMicroUsd : null;
  return { global: g, project: p };
}

function monthProblem(config, ledger, months, project, cost) {
  for (const month of months) {
    const { global, project: p } = monthFigures(config, ledger, month, project);
    if (global.openingMicroUsd === null) return `month ${month} has no opening-usage entry (no automatic new-month reset)`;
    if (p && p.openingMicroUsd === null) return `month ${month} has no opening-usage entry for this project`;
    if (global.estimatedRemainingMicroUsd < cost) return `estimated remaining allowance for ${month} is below the per-build reservation`;
    if (p && p.estimatedRemainingMicroUsd < cost) return `estimated remaining project allowance for ${month} is below the per-build reservation`;
  }
  return null;
}

// ---------------------------------------------------------------- durable storage

export async function durableWrite(path, dir, data, fs = nodeFs) {
  const tmp = `${path}.${process.pid}.tmp`;
  const h = await fs.open(tmp, 'w', 0o600);
  try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, path);
  await syncDir(dir, fs);
}

async function syncDir(dir, fs) {
  const h = await fs.open(dir, 'r');
  try { await h.sync(); } finally { await h.close(); }
}

function checkLedger(l) {
  const bad = what => { throw new BudgetError(`Budget ledger is inconsistent (${what})`); };
  if (!isObj(l) || l.format !== FORMAT) throw new BudgetError('Budget ledger has an unsupported format');
  if (l.version !== LEDGER_VERSION) throw new BudgetError('Budget ledger version is unsupported');
  for (const k of ['policies', 'reservations', 'holds', 'history', 'audit']) if (!Array.isArray(l[k])) bad(k);
  if (l.policies.length === 0) bad('no policy');
  l.policies.forEach((p, i) => {
    if (!isObj(p) || !intIn(p.version, 1, MAX_POLICY_VERSION) || (i > 0 && p.version !== l.policies[i - 1].version + 1)) bad('policy versions');
    let cfg;
    try { cfg = validateBudgetConfig(p.config); } catch { bad('policy content'); }
    if (cfg.policyVersion !== p.version || policyDigest(cfg) !== p.digest) bad('policy digest');
  });
  const latest = l.policies.at(-1).version;
  const policyConfig = v => l.policies.find(p => p.version === v)?.config;
  const ids = new Set();
  const requests = new Set();
  for (const r of l.reservations) {
    if (!isObj(r) || typeof r.id !== 'string' || ids.has(r.id)) bad('reservation ids');
    ids.add(r.id);
    if (typeof r.requestId !== 'string' || requests.has(r.requestId)) bad('reservation request ids');
    requests.add(r.requestId);
    if (typeof r.jobId !== 'string' || typeof r.project !== 'string') bad('reservation identity');
    if (!intIn(r.costMicroUsd, 1, Number.MAX_SAFE_INTEGER)) bad('reservation cost');
    if (!Array.isArray(r.months) || r.months.length === 0 || !r.months.every(m => MONTH.test(m))) bad('reservation months');
    if (!PHASES.includes(r.phase) || (r.phase === 'closed') !== OUTCOMES.includes(r.outcome)) bad('reservation phase');
    if (!intIn(r.policyVersion, 1, latest) || !policyConfig(r.policyVersion)) bad('reservation policy');
    const reservedMs = Date.parse(r.reservedAt);
    const windowEndMs = Date.parse(r.windowEnd);
    if (!Number.isFinite(reservedMs) || !Number.isFinite(windowEndMs)) bad('reservation window');
    // A charge or window smaller than its policy's fixed bound would silently free allowance.
    const cfg = policyConfig(r.policyVersion);
    const bound = buildSeconds(cfg, LAUNCH_TIMEOUT_SECONDS);
    if (r.costMicroUsd < reservationCost(cfg.smallHourlyRateMicroUsd, bound)) bad('reservation cost below its policy bound');
    if (windowEndMs - reservedMs < (PRECREATE_MAX_SECONDS + bound) * 1000) bad('reservation window shorter than its policy bound');
    if (!monthsOverlapping(reservedMs, windowEndMs).every(m => r.months.includes(m))) bad('reservation months do not cover its window');
  }
  for (const h of l.holds) {
    if (!isObj(h) || typeof h.id !== 'string' || typeof h.reason !== 'string') bad('holds');
    if (h.reservationId != null && !ids.has(h.reservationId)) bad('hold reference');
  }
  for (const r of l.reservations) if (r.outcome === 'held' && !l.holds.some(h => h.reservationId === r.id)) bad('held reservation without hold');
  return l;
}

export function ledgerStore(dataDir, fs = nodeFs) {
  const paths = { ledger: join(dataDir, LEDGER_FILE), lock: join(dataDir, LOCK_FILE), marker: join(dataDir, MARKER_FILE), recovery: join(dataDir, RECOVERY_FILE) };
  const readLockRaw = async () => { try { return await fs.readFile(paths.lock, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new BudgetError('Budget ledger lock could not be read'); } };
  const readLock = async () => { try { return JSON.parse(await fs.readFile(paths.lock, 'utf8')); } catch { return null; } };
  return {
    paths,
    async read() {
      let raw;
      try { raw = await fs.readFile(paths.ledger, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new BudgetError('Budget ledger could not be read'); }
      let l;
      try { l = JSON.parse(raw); } catch { throw new BudgetError('Budget ledger is corrupt (invalid JSON)'); }
      return checkLedger(l);
    },
    write: l => durableWrite(paths.ledger, dataDir, JSON.stringify(l), fs),
    async markerExists() {
      try { await fs.stat(paths.marker); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw new BudgetError('Budget ledger marker could not be read'); }
    },
    writeMarker: at => durableWrite(paths.marker, dataDir, JSON.stringify({ initializedAt: at }), fs),
    readLock,
    // The lock appears only through link(), with its ownership already written and synced: a lock file is never
    // observable without its owner, so stale-lock recovery cannot mistake an acquisition in progress for a dead owner.
    async acquireLock(owner) {
      const token = randomUUID();
      const tmp = `${paths.lock}.${token}.tmp`;
      try {
        try {
          const h = await fs.open(tmp, 'wx', 0o600);
          try { await h.writeFile(JSON.stringify({ token, owner, pid: process.pid, host: hostname(), at: new Date().toISOString() })); await h.sync(); } finally { await h.close(); }
        } catch { throw new BudgetError('Budget ledger lock could not be created'); }
        try { await fs.link(tmp, paths.lock); } catch (e) {
          if (e.code === 'EEXIST') { const raw = await readLockRaw(); let holder = null; try { holder = JSON.parse(raw); } catch {} return { ok: false, holder, raw }; }
          throw new BudgetError('Budget ledger lock could not be created');
        }
        await syncDir(dataDir, fs);
        return { ok: true, token };
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    },
    async releaseLock(token) {
      if ((await readLock())?.token !== token) return false;
      await fs.unlink(paths.lock);
      await syncDir(dataDir, fs);
      return true;
    },
    async breakLock() {
      try { await fs.unlink(paths.lock); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await syncDir(dataDir, fs);
    },
    // Breaks only the exact lock the operator inspected (seenRaw), one recovery at a time, then takes the lock.
    async replaceStaleLock(seenRaw, owner) {
      let m;
      try { m = await fs.open(paths.recovery, 'wx', 0o600); } catch (e) {
        if (e.code === 'EEXIST') throw new BudgetError(`Another stale-lock recovery is in progress. If none is running, delete ${RECOVERY_FILE} and retry`);
        throw new BudgetError('Stale-lock recovery file could not be created');
      }
      try {
        await m.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
        await m.sync();
        const current = await readLockRaw();
        if (current !== seenRaw) throw new BudgetError('Budget ledger lock changed during recovery; inspect it and retry');
        if (current !== null) { await fs.unlink(paths.lock); await syncDir(dataDir, fs); }
        const got = await this.acquireLock(owner);
        if (!got.ok) throw new BudgetError('Budget ledger lock was taken by another process');
        return got;
      } finally {
        await m.close().catch(() => {});
        await fs.unlink(paths.recovery).catch(() => {});
        await syncDir(dataDir, fs).catch(() => {});
      }
    },
  };
}

// A legacy or unbudgeted job is clean only when nothing it could have allocated can still exist.
// passed/failed without a sandbox name can only be a mock run: a real run records the name before executing anything.
export function jobIsClean(j) {
  if (!TERMINAL.includes(j?.status)) return false;
  if (j.secretsCleanup !== undefined && j.secretsCleanup !== 'deleted') return false;
  if (j.sandbox) return j.cleanup === 'deleted';
  return j.status === 'passed' || j.status === 'failed';
}

const activeHolds = l => (l ? l.holds.filter(h => !h.resolvedAt) : []);
const openReservation = l => l?.reservations.find(r => r.phase !== 'closed');
const holdFor = (l, { reservationId = null, jobId = null }) => l.holds.some(h => (reservationId && h.reservationId === reservationId) || (jobId && h.jobId === jobId));
const addHold = (l, { reservationId = null, jobId = null, reason, at }) => { l.holds.push({ id: randomUUID(), reservationId, jobId, reason, at, resolvedAt: null, evidence: null, authorizedBy: null }); };
const publicHold = h => ({ id: h.id, reservationId: h.reservationId, jobId: h.jobId, reason: h.reason, at: h.at });

function summarize({ config, ledger, nowMs, project, launchSeconds, reasons, mode }) {
  const month = monthsOverlapping(nowMs, nowMs)[0];
  const seconds = buildSeconds(config, launchSeconds);
  const out = {
    mode, configured: true, realAdmission: reasons.length === 0, reasons: reasons.slice(0, 10), label: ESTIMATE_LABEL, currency: 'USD', unit: UNIT,
    policyVersion: config.policyVersion, perBuildBillableSecondsBound: seconds,
    perBuildReservationMicroUsd: reservationCost(config.smallHourlyRateMicroUsd, seconds), month,
  };
  out.global = monthFigures(config, ledger, month).global;
  const names = project === undefined ? Object.keys(config.projects) : [project];
  out.projects = Object.fromEntries(names.filter(n => Object.hasOwn(config.projects, n)).map(n => [n, monthFigures(config, ledger, month, n).project]));
  const holds = activeHolds(ledger);
  out.activeHoldCount = holds.length;
  out.activeHolds = holds.slice(0, MAX_LISTED).map(publicHold);
  return out;
}

// ---------------------------------------------------------------- server-side guard

export function createBudgetGuard({ dataDir, config = null, mock = false, now = Date.now, fs = nodeFs, launchSeconds = LAUNCH_TIMEOUT_SECONDS } = {}) {
  const store = ledgerStore(dataDir, fs);
  const s = { lockToken: null, lockConflict: false, ledger: null, problems: [], fatal: null };
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const seconds = config ? buildSeconds(config, launchSeconds) : 0;
  const cost = config ? reservationCost(config.smallHourlyRateMicroUsd, seconds) : 0;
  const find = id => s.ledger?.reservations.find(r => r.id === id);

  // Callers are already serialized. A failed write keeps the newer (more conservative) state in memory and
  // disables further real admissions, because the disk may hold either version.
  async function apply(fn) {
    if (!s.ledger) throw new BudgetError('Budget ledger is not loaded');
    if (!s.lockToken) throw new BudgetError('Budget ledger lock is not held');
    const next = structuredClone(s.ledger);
    const result = fn(next);
    if (canonical(next) === canonical(s.ledger)) return result;
    try { await store.write(next); } catch {
      s.fatal = 'Budget ledger write failed; real builds are disabled until the operator checks the volume and restarts the bridge';
      s.ledger = next;
      throw new BudgetError(s.fatal);
    }
    s.ledger = next;
    return result;
  }

  function reasons(project) {
    if (mock) return ['MOCK_DOCKER=1: builds are simulated and never consume allowance'];
    if (!config) return ['Budget guard is not configured (BUDGET_JSON); real builds are disabled'];
    const out = [...s.problems];
    if (!s.ledger && out.length === 0) out.push('Budget ledger is not loaded');
    if (s.fatal) out.push(s.fatal);
    if (!EVIDENCE_FLAGS.every(f => config.evidence[f])) out.push('Rate, lifetime or setup evidence is not marked verified in BUDGET_JSON');
    if (s.ledger) {
      const holds = activeHolds(s.ledger).length;
      if (holds) out.push(`${holds} unresolved budget hold(s); an operator must reconcile them with budget-admin`);
      if (openReservation(s.ledger)) out.push('A reserved build is still in progress');
      const t = now();
      const problem = monthProblem(config, s.ledger, monthsOverlapping(t, t + (PRECREATE_MAX_SECONDS + seconds) * 1000), project, cost);
      if (problem) out.push(`Budget: ${problem}`);
    }
    return [...new Set(out)];
  }

  const advance = (rid, from, to, extra = {}) => apply(l => {
    const r = l.reservations.find(x => x.id === rid);
    if (!r || !from.includes(r.phase)) throw new BudgetError(`Reservation is not in an expected phase for ${to}`);
    Object.assign(r, { phase: to, ...extra });
    r.phases.push({ phase: to, at: iso(now()) });
    return r;
  });

  return {
    get configured() { return Boolean(config); },
    get lockConflict() { return s.lockConflict; },
    get locked() { return Boolean(s.lockToken); },

    async start() {
      if (mock || !config) return this;
      const got = await store.acquireLock('server').catch(() => ({ ok: false }));
      if (got.ok) s.lockToken = got.token;
      else {
        s.lockConflict = true;
        s.problems.push('Budget ledger lock is held by another bridge process or was left by a crash; stop other instances, then run budget-admin reconcile --stale-lock');
      }
      try {
        const l = await store.read();
        if (!l) s.problems.push((await store.markerExists()) ? 'Budget ledger is missing after initialization; restore it from backup (do not re-initialize)' : 'Budget ledger is not initialized; run budget-admin init');
        else {
          s.ledger = l;
          if (l.policies.at(-1).digest !== policyDigest(config)) s.problems.push('BUDGET_JSON does not match the latest ledger policy version; apply it with budget-admin policy');
        }
      } catch (e) {
        s.problems.push(e instanceof BudgetError ? e.message : 'Budget ledger could not be read');
      }
      return this;
    },

    // Joins ledger and job records after a restart. Anything that may still own Docker resources becomes a hold.
    async recover(jobs) {
      if (mock || !config) return;
      const list = [...jobs.values()];
      if (!s.ledger) {
        if (list.some(j => j.budget?.reservationId) && !s.problems.some(p => p.includes('missing after'))) s.problems.push('Budget ledger is missing but job records reference reservations; restore it from backup');
        return;
      }
      if (!s.lockToken) return;
      await serial(() => apply(l => {
        const at = iso(now());
        for (const r of l.reservations) {
          if (r.phase === 'closed') continue;
          addHold(l, { reservationId: r.id, jobId: r.jobId, reason: `bridge restarted while the reservation was in phase ${r.phase}`, at });
          Object.assign(r, { phase: 'closed', outcome: 'held', closedAt: at });
          r.phases.push({ phase: 'closed', at });
        }
        for (const j of list) {
          if (j.budget?.mode === 'mock') continue;
          if (j.budget?.reservationId) {
            if (!l.reservations.some(r => r.id === j.budget.reservationId) && !holdFor(l, { jobId: j.id })) addHold(l, { jobId: j.id, reason: 'job references a reservation that is missing from the ledger', at });
            continue;
          }
          if (l.history.some(h => h.jobId === j.id) || holdFor(l, { jobId: j.id }) || jobIsClean(j)) continue;
          addHold(l, { jobId: j.id, reason: `job without a reservation is ${String(j.status).slice(0, 20)} or not cleanly deleted`, at });
        }
        const added = l.holds.length - s.ledger.holds.length;
        if (added) l.audit.push({ at, action: 'recovery', actor: 'bridge', details: { holdsAdded: added } });
      }));
    },

    reasons,

    admit(req) {
      return serial(async () => {
        const blockers = reasons(req.project);
        if (blockers.length) throw new BudgetError(`Budget guard refused the build: ${blockers[0]}`);
        if (s.ledger.reservations.some(r => r.requestId === req.requestId)) throw new BudgetError('Budget guard refused the build: request_id already has a reservation; use a new request_id');
        const t = now();
        const windowEnd = t + (PRECREATE_MAX_SECONDS + seconds) * 1000;
        const months = monthsOverlapping(t, windowEnd);
        const problem = monthProblem(config, s.ledger, months, req.project, cost);
        if (problem) throw new BudgetError(`Budget guard refused the build: ${problem}`);
        return apply(l => {
          const r = {
            id: randomUUID(), jobId: req.jobId, requestId: req.requestId, project: req.project, task: req.task, commit: req.commit,
            forwardEnv: [...(req.forwardEnv || [])], policyVersion: config.policyVersion, months, costMicroUsd: cost,
            reservedAt: iso(t), windowEnd: iso(windowEnd), phase: 'reserved', phases: [{ phase: 'reserved', at: iso(t) }],
            sandbox: null, outcome: null, closedAt: null, holdReasons: [],
          };
          l.reservations.push(r);
          return { id: r.id, costMicroUsd: cost, months };
        });
      });
    },

    // Last check before Docker create; a refusal here means create is never attempted.
    beforeCreate(rid) {
      return serial(async () => {
        const r = find(rid);
        if (!r || r.phase !== 'reserved') throw new BudgetError('Launch aborted before Docker create: reservation is not in the reserved phase');
        const blockers = [];
        if (s.fatal) blockers.push(s.fatal);
        if (!s.lockToken) blockers.push('budget ledger lock is not held');
        if (activeHolds(s.ledger).length) blockers.push('an unresolved budget hold exists');
        const windowEnd = Date.parse(r.windowEnd);
        if (now() + seconds * 1000 > windowEnd) blockers.push('the reservation window no longer covers a full launch and lifetime');
        if (blockers.length) throw new BudgetError(`Launch aborted before Docker create: ${blockers[0]}`);
        await advance(rid, ['reserved'], 'launch_intent');
        // The intent write and fsync take time; the create happens after them, so the window is checked again.
        const late = [];
        if (s.fatal) late.push(s.fatal);
        if (!s.lockToken) late.push('budget ledger lock is not held');
        if (now() + seconds * 1000 > windowEnd) late.push('the reservation window no longer covers a full launch and lifetime');
        if (late.length) throw new BudgetError(`Launch aborted before Docker create: ${late[0]}`);
        return { latestExpiryMs: windowEnd };
      });
    },
    created: (rid, sandbox) => serial(() => advance(rid, ['launch_intent'], 'created', { sandbox })),
    verified: rid => serial(() => advance(rid, ['created'], 'verified')),

    abortPrelaunch(rid, reason) {
      return serial(() => apply(l => {
        const r = l.reservations.find(x => x.id === rid);
        if (!r || r.phase !== 'reserved') return;
        const at = iso(now());
        Object.assign(r, { phase: 'closed', outcome: 'aborted_prelaunch', closedAt: at, holdReasons: [String(reason).slice(0, 200)] });
        r.phases.push({ phase: 'closed', at });
      }));
    },

    // Closes the reservation's outcome; the charge always stays.
    settle(rid, { createAttempted, sandboxName, cleanup, secretsCleanup, lifetimeProblem } = {}) {
      return serial(() => apply(l => {
        const r = l.reservations.find(x => x.id === rid);
        if (!r || r.phase === 'closed') return;
        const why = [];
        if (secretsCleanup !== undefined && secretsCleanup !== 'deleted') why.push('stored secret cleanup failed');
        if (createAttempted || r.phase !== 'reserved' && r.phase !== 'launch_intent') {
          if (!sandboxName) why.push('Docker create outcome is uncertain (no sandbox identity)');
          else if (cleanup !== 'deleted') why.push('sandbox deletion was not verified');
          if (lifetimeProblem) why.push(`sandbox lifetime check failed: ${lifetimeProblem}`);
        }
        const at = iso(now());
        Object.assign(r, { phase: 'closed', outcome: why.length ? 'held' : createAttempted ? 'deleted' : 'aborted_prelaunch', closedAt: at, sandbox: sandboxName ?? r.sandbox, holdReasons: why });
        r.phases.push({ phase: 'closed', at });
        if (why.length) addHold(l, { reservationId: r.id, jobId: r.jobId, reason: why.join('; '), at });
      }));
    },

    jobBudget(j) {
      if (!j?.budget) return undefined;
      if (j.budget.mode !== 'real') return { mode: j.budget.mode };
      const r = find(j.budget.reservationId);
      return {
        mode: 'real', reservationId: j.budget.reservationId, estimatedReservedMicroUsd: j.budget.estimatedReservedMicroUsd, months: j.budget.months,
        phase: r?.phase ?? 'unknown', outcome: r?.outcome ?? null, onHold: Boolean(r && s.ledger.holds.some(h => h.reservationId === r.id && !h.resolvedAt)),
      };
    },

    status(project) {
      if (mock || !config) return { mode: mock ? 'mock' : 'real', configured: Boolean(config), realAdmission: false, reasons: reasons(project), label: ESTIMATE_LABEL };
      return summarize({ config, ledger: s.ledger, nowMs: now(), project, launchSeconds, reasons: reasons(project), mode: 'real' });
    },

    projectSummary(name) {
      const r = reasons(name);
      const st = config && !mock ? summarize({ config, ledger: s.ledger, nowMs: now(), project: name, launchSeconds, reasons: r, mode: 'real' }) : null;
      const remaining = [st?.global?.estimatedRemainingMicroUsd, st?.projects?.[name]?.estimatedRemainingMicroUsd].filter(v => typeof v === 'number');
      return {
        realAdmission: r.length === 0, reason: r[0] ?? null,
        estimatedRemainingMicroUsd: remaining.length ? Math.min(...remaining) : null,
        perBuildReservationMicroUsd: st?.perBuildReservationMicroUsd ?? null,
      };
    },

    // Releases the lock only when no reservation could still own Docker resources.
    shutdown() {
      return serial(async () => {
        if (!s.lockToken || openReservation(s.ledger)) return false;
        const released = await store.releaseLock(s.lockToken).catch(() => false);
        if (released) s.lockToken = null;
        return released;
      });
    },
  };
}

// ---------------------------------------------------------------- offline operator commands

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function readJobRecords(dataDir, fs = nodeFs) {
  const jobs = [];
  for (const file of await fs.readdir(dataDir)) {
    if (!JOB_FILE.test(file)) continue;
    try { jobs.push(JSON.parse(await fs.readFile(join(dataDir, file), 'utf8'))); } catch { throw new BudgetError(`Job record ${file} is unreadable; fix it before changing the budget ledger`); }
  }
  return jobs;
}

export function budgetAdmin({ dataDir, fs = nodeFs, now = Date.now, launchSeconds = LAUNCH_TIMEOUT_SECONDS }) {
  const store = ledgerStore(dataDir, fs);

  const requireText = (v, name, max = 200) => { if (!text(v, max)) throw new BudgetError(`${name} is required (non-empty, at most ${max} characters)`); return v.trim(); };

  async function withLock(opts, fn) {
    let got = await store.acquireLock('budget-admin');
    let stale = null;
    if (!got.ok) {
      if (!opts.staleLock) throw new BudgetError('Budget ledger lock is held: stop the bridge first. If no bridge process is running, pass --stale-lock with --evidence');
      const evidence = requireText(opts.evidence, '--evidence', MAX_TEXT);
      const h = got.holder;
      if (h && h.host === hostname() && pidAlive(h.pid)) throw new BudgetError('The lock owner process is still running on this host');
      got = await store.replaceStaleLock(got.raw, 'budget-admin');
      stale = { holder: h ? { owner: h.owner, pid: h.pid, host: h.host, at: h.at } : null, evidence };
    }
    try { return await fn(stale); } finally { await store.releaseLock(got.token).catch(() => {}); }
  }

  async function loadExisting() {
    const l = await store.read();
    if (!l) throw new BudgetError((await store.markerExists()) ? 'Budget ledger is missing after initialization; restore it from backup' : 'Budget ledger is not initialized; run init first');
    return l;
  }

  return {
    async init({ config, authorizedBy, ...opts }) {
      const who = requireText(authorizedBy, '--authorized-by');
      if (!config) throw new BudgetError('BUDGET_JSON is required for init');
      if (config.policyVersion !== 1) throw new BudgetError('The first policy must use policyVersion 1');
      return withLock(opts, async stale => {
        if (await store.read().catch(() => { throw new BudgetError('A budget ledger file already exists but is unreadable; restore it instead of re-initializing'); })) throw new BudgetError('Budget ledger is already initialized');
        if (await store.markerExists()) throw new BudgetError('Budget ledger is missing after initialization; restore it from backup instead of re-initializing');
        const at = iso(now());
        const jobs = await readJobRecords(dataDir, fs);
        const ledger = { format: FORMAT, version: LEDGER_VERSION, createdAt: at, policies: [{ version: 1, digest: policyDigest(config), appliedAt: at, authorizedBy: who, config }], reservations: [], holds: [], history: [], audit: [] };
        for (const j of jobs) {
          if (jobIsClean(j)) ledger.history.push({ jobId: j.id, status: j.status, created: j.created ?? null, sandbox: j.sandbox ?? null });
          else addHold(ledger, { jobId: j.id, reason: `pre-ledger job is ${String(j.status).slice(0, 20)} or not cleanly deleted; count its cost in opening usage`, at });
        }
        if (stale) ledger.audit.push({ at, action: 'stale-lock-cleared', authorizedBy: who, evidence: stale.evidence, details: { holder: stale.holder } });
        ledger.audit.push({ at, action: 'init', authorizedBy: who, details: { policyVersion: 1, historyJobs: ledger.history.length, heldJobs: ledger.holds.length } });
        checkLedger(ledger);
        await store.write(ledger);
        await store.writeMarker(at);
        return { initialized: true, policyVersion: 1, historyJobs: ledger.history.length, holds: ledger.holds.map(publicHold) };
      });
    },

    async policy({ config, authorizedBy, ...opts }) {
      const who = requireText(authorizedBy, '--authorized-by');
      if (!config) throw new BudgetError('BUDGET_JSON is required for policy');
      return withLock(opts, async stale => {
        const l = await loadExisting();
        const prev = l.policies.at(-1);
        if (config.policyVersion !== prev.version + 1) throw new BudgetError(`BUDGET_JSON policyVersion must be ${prev.version + 1}`);
        for (const [month, o] of Object.entries(prev.config.opening)) {
          const n = Object.hasOwn(config.opening, month) ? config.opening[month] : null;
          if (!n || n.globalMicroUsd < o.globalMicroUsd) throw new BudgetError(`Opening usage for ${month} cannot be removed or lowered`);
          for (const [p, v] of Object.entries(o.projects)) if (!Object.hasOwn(n.projects, p) || n.projects[p] < v) throw new BudgetError(`Project opening usage for ${month} cannot be removed or lowered`);
        }
        const at = iso(now());
        if (stale) l.audit.push({ at, action: 'stale-lock-cleared', authorizedBy: who, evidence: stale.evidence, details: { holder: stale.holder } });
        l.policies.push({ version: config.policyVersion, digest: policyDigest(config), appliedAt: at, authorizedBy: who, config });
        l.audit.push({ at, action: 'policy', authorizedBy: who, details: { policyVersion: config.policyVersion, monthsAdded: Object.keys(config.opening).filter(m => !Object.hasOwn(prev.config.opening, m)) } });
        checkLedger(l);
        await store.write(l);
        return { policyVersion: config.policyVersion };
      });
    },

    async reconcile({ reservation, hold, evidence, authorizedBy, ...opts }) {
      const who = requireText(authorizedBy, '--authorized-by');
      const proof = requireText(evidence, '--evidence', MAX_TEXT);
      if (!reservation && !hold && !opts.staleLock) throw new BudgetError('Pass --reservation <id>, --hold <id> or --stale-lock');
      return withLock({ ...opts, evidence: proof }, async stale => {
        const l = await loadExisting();
        const at = iso(now());
        if (stale) l.audit.push({ at, action: 'stale-lock-cleared', authorizedBy: who, evidence: stale.evidence, details: { holder: stale.holder } });
        const resolved = [];
        let reservationId = null;
        if (reservation || hold) {
          const h = hold ? l.holds.find(x => x.id === hold) : null;
          if (hold && !h) throw new BudgetError('Unknown hold id');
          reservationId = reservation ?? h.reservationId;
          const r = reservationId ? l.reservations.find(x => x.id === reservationId) : null;
          if (reservationId && !r) throw new BudgetError('Unknown reservation id');
          const targets = l.holds.filter(x => !x.resolvedAt && (x.id === hold || (reservationId && x.reservationId === reservationId)));
          if (!targets.length && !(r && r.phase !== 'closed')) throw new BudgetError('Nothing to reconcile: no unresolved hold or open reservation matches');
          for (const x of targets) { Object.assign(x, { resolvedAt: at, evidence: proof, authorizedBy: who }); resolved.push(x.id); }
          if (r && (r.phase !== 'closed' || r.outcome === 'held')) {
            Object.assign(r, { phase: 'closed', outcome: 'reconciled', closedAt: at });
            r.phases.push({ phase: 'closed', at });
          }
        }
        l.audit.push({ at, action: 'reconcile', authorizedBy: who, evidence: proof, details: { reservationId, holdsResolved: resolved, staleLock: Boolean(stale) } });
        checkLedger(l);
        await store.write(l);
        return { reservationId, holdsResolved: resolved, staleLockCleared: Boolean(stale), chargesKept: true };
      });
    },

    async status({ authorizedBy, ...opts } = {}) {
      const who = requireText(authorizedBy, '--authorized-by');
      return withLock(opts, async stale => {
        const l = await loadExisting();
        const at = iso(now());
        if (stale) l.audit.push({ at, action: 'stale-lock-cleared', authorizedBy: who, evidence: stale.evidence, details: { holder: stale.holder } });
        l.audit.push({ at, action: 'status', authorizedBy: who });
        checkLedger(l);
        await store.write(l);
        const config = l.policies.at(-1).config;
        const out = summarize({ config, ledger: l, nowMs: now(), launchSeconds, reasons: [], mode: 'ledger' });
        delete out.realAdmission;
        delete out.reasons;
        out.lock = await store.readLock().then(h => (h ? { owner: h.owner, pid: h.pid, host: h.host, at: h.at } : null));
        out.activeHolds = activeHolds(l).map(publicHold);
        out.openOrHeldReservations = l.reservations.filter(r => r.phase !== 'closed' || r.outcome === 'held')
          .map(r => ({ id: r.id, jobId: r.jobId, project: r.project, phase: r.phase, outcome: r.outcome, sandbox: r.sandbox, months: r.months, costMicroUsd: r.costMicroUsd }));
        out.reservationCount = l.reservations.length;
        out.historyJobs = l.history.length;
        out.auditEntries = l.audit.length;
        return out;
      });
    },
  };
}
