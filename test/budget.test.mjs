import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BudgetError, budgetAdmin, buildSeconds, createBudgetGuard, ledgerStore, monthsOverlapping,
  parseBudgetConfig, policyDigest, reservationCost, validateBudgetConfig,
} from '../budget.mjs';
import { LAUNCH_TIMEOUT_SECONDS } from '../budget.mjs';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const RATE = 3_600_000;
const SECONDS = LAUNCH_TIMEOUT_SECONDS + 300 + 3600;
const COST = reservationCost(RATE, SECONDS);

function rawConfig({
  policyVersion = 1, global = COST * 10, project = COST * 10, openingGlobal = 0, openingProject = 0, opening,
  evidence = { rateVerified: true, lifetimeVerified: true, setupVerified: true, reference: 'verified by operator' },
} = {}) {
  const openingEntries = opening ?? {
    '2026-01': { globalMicroUsd: openingGlobal, projects: project === null ? {} : { app: openingProject } },
  };
  return {
    version: 1, policyVersion, currency: 'USD', smallHourlyRateMicroUsd: RATE, monthlyAllowanceMicroUsd: global,
    projects: project === null ? {} : { app: { monthlyAllowanceMicroUsd: project } }, opening: openingEntries, maxSetupSeconds: 300, ttlSeconds: 3600, evidence,
  };
}

function config(opts) {
  return validateBudgetConfig(rawConfig(opts), ['app']);
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function initialized(t, { conf = config(), now = () => NOW, fs = nodeFs } = {}) {
  const dataDir = await tempDir(t);
  await budgetAdmin({ dataDir, now, fs }).init({ config: conf, authorizedBy: 'budget.test' });
  const guard = await createBudgetGuard({ dataDir, config: conf, now, fs }).start();
  await guard.recover(new Map());
  return { dataDir, guard, admin: budgetAdmin({ dataDir, now, fs }), store: ledgerStore(dataDir, fs), conf };
}

const request = (overrides = {}) => ({
  jobId: randomUUID(), requestId: randomUUID(), project: 'app', task: 'test', commit: 'a'.repeat(40), forwardEnv: [], ...overrides,
});

test('budget configuration rejects unsafe values without echoing contents', () => {
  const good = rawConfig();
  assert.equal(parseBudgetConfig(JSON.stringify(good), ['app']).policyVersion, 1);
  assert.equal(buildSeconds(config(), LAUNCH_TIMEOUT_SECONDS), SECONDS);
  for (const [field, value] of [['currency', 'EUR'], ['smallHourlyRateMicroUsd', -1], ['maxSetupSeconds', 3601], ['ttlSeconds', 1], ['policyVersion', 0]]) {
    const bad = { ...good, [field]: value, secretMarker: 'do-not-echo' };
    assert.throws(() => validateBudgetConfig(bad, ['app']), e => !e.message.includes('do-not-echo'));
  }
  assert.throws(() => parseBudgetConfig('SECRET_CONFIG_MARKER'), e => /not valid JSON/.test(e.message) && !e.message.includes('SECRET_CONFIG_MARKER'));
  assert.throws(() => validateBudgetConfig({ ...good, projects: { unknown: { monthlyAllowanceMicroUsd: 1 } } }, ['app']), /do not match/);
});

test('reservation math rounds up safely and month windows include every overlapping UTC month', () => {
  assert.equal(reservationCost(1, 1), 1);
  assert.equal(reservationCost(3601, 1), 2);
  assert.equal(reservationCost(RATE, SECONDS), COST);
  assert.throws(() => reservationCost(Number.MAX_SAFE_INTEGER, 100_000), /safe integer|out of range/);
  assert.deepEqual(monthsOverlapping(Date.parse('2026-01-31T23:59:59Z'), Date.parse('2026-02-01T00:00:00Z')), ['2026-01', '2026-02']);
});

test('exact-fit admission succeeds and one micro-dollar over the cap is refused', async t => {
  const { guard, store } = await initialized(t, { conf: config({ global: COST, project: COST }) });
  const first = await guard.admit(request());
  assert.equal(first.costMicroUsd, COST);
  await guard.settle(first.id, { createAttempted: false });
  assert.equal((await store.read()).reservations[0].outcome, 'aborted_prelaunch');
  await assert.rejects(guard.admit(request()), /below the per-build reservation/);
  assert.equal((await store.read()).reservations.length, 1);
});

test('global and per-project ceilings independently block admission', async t => {
  const projectLimited = await initialized(t, { conf: config({ global: COST * 10, project: COST - 1 }) });
  await assert.rejects(projectLimited.guard.admit(request()), /project allowance/);

  const globalLimited = await initialized(t, { conf: config({ global: COST - 1, project: null }) });
  await assert.rejects(globalLimited.guard.admit(request()), /global.*allowance|remaining allowance/);
});

test('opening usage counts against both configured ceilings', async t => {
  const { guard } = await initialized(t, {
    conf: config({ global: COST * 2, project: COST * 2, openingGlobal: COST, openingProject: COST }),
  });
  assert.equal(guard.status('app').global.estimatedRemainingMicroUsd, COST);
  const r = await guard.admit(request());
  await guard.settle(r.id, { createAttempted: false });
  const status = guard.status('app');
  assert.equal(status.global.estimatedRemainingMicroUsd, 0);
  assert.equal(status.projects.app.estimatedRemainingMicroUsd, 0);
});

test('month-crossing reservations require opening usage in every touched month', async t => {
  const now = () => Date.parse('2026-01-31T23:00:00.000Z');
  const { guard } = await initialized(t, { conf: config(), now });
  await assert.rejects(guard.admit(request()), /month 2026-02 has no opening-usage entry/);

  const secondMonth = {
    '2026-01': { globalMicroUsd: 0, projects: { app: 0 } },
    '2026-02': { globalMicroUsd: 0, projects: { app: 0 } },
  };
  const opened = await initialized(t, { conf: config({ opening: secondMonth }), now });
  const r = await opened.guard.admit(request());
  assert.deepEqual(r.months, ['2026-01', '2026-02']);
});

test('an unopened current month never resets allowance automatically', async t => {
  const { guard } = await initialized(t, { conf: config({ opening: {} }) });
  assert.equal(guard.status().realAdmission, false);
  await assert.rejects(guard.admit(request()), /no opening-usage entry/);
});

test('duplicate request ids do not create a second reservation', async t => {
  const { guard, store } = await initialized(t);
  const req = request({ requestId: 'same-request' });
  const r = await guard.admit(req);
  await guard.settle(r.id, { createAttempted: false });
  await assert.rejects(guard.admit(request({ requestId: req.requestId })), /request_id already has a reservation/);
  assert.equal((await store.read()).reservations.length, 1);
});

test('a second process cannot own or admit against the same ledger', async t => {
  const { dataDir, guard, conf } = await initialized(t);
  const other = await createBudgetGuard({ dataDir, config: conf, now: () => NOW }).start();
  assert.equal(other.lockConflict, true);
  assert.equal(other.status().realAdmission, false);
  await assert.rejects(other.admit(request()), /lock is held|another bridge/);
  assert.equal(await guard.shutdown(), true);
  const restarted = await createBudgetGuard({ dataDir, config: conf, now: () => NOW }).start();
  assert.equal(restarted.lockConflict, false);
});

test('recovery at every persisted launch phase keeps the charge and creates a hold', async t => {
  for (const phase of ['reserved', 'launch_intent', 'created', 'verified']) {
    await t.test(phase, async st => {
      const { dataDir, guard, conf, store } = await initialized(st);
      const r = await guard.admit(request());
      if (phase !== 'reserved') await guard.beforeCreate(r.id);
      if (phase === 'created' || phase === 'verified') await guard.created(r.id, 'sandboxes/sbx');
      if (phase === 'verified') await guard.verified(r.id);
      await store.breakLock(); // Simulate a process death without clearing the durable reservation.
      const restarted = await createBudgetGuard({ dataDir, config: conf, now: () => NOW }).start();
      await restarted.recover(new Map());
      const ledger = await store.read();
      assert.equal(ledger.reservations[0].phase, 'closed');
      assert.equal(ledger.reservations[0].outcome, 'held');
      assert.equal(ledger.reservations[0].costMicroUsd, COST);
      assert.equal(restarted.status().realAdmission, false);
    });
  }
});

test('corrupt or missing initialized ledgers fail closed', async t => {
  const corrupt = await initialized(t);
  await corrupt.guard.shutdown();
  await writeFile(corrupt.store.paths.ledger, '{bad json');
  const corruptGuard = await createBudgetGuard({ dataDir: corrupt.dataDir, config: corrupt.conf, now: () => NOW }).start();
  assert.match(corruptGuard.status().reasons.join(' '), /corrupt/);
  await assert.rejects(corruptGuard.admit(request()), /corrupt/);

  const missing = await initialized(t);
  await missing.guard.shutdown();
  await unlink(missing.store.paths.ledger);
  const missingGuard = await createBudgetGuard({ dataDir: missing.dataDir, config: missing.conf, now: () => NOW }).start();
  assert.match(missingGuard.status().reasons.join(' '), /missing after initialization/);
  await assert.rejects(missingGuard.admit(request()), /missing after initialization/);
});

test('ledger persistence failure disables further real admissions', async t => {
  const dataDir = await tempDir(t);
  let rejectLedgerWrite = false;
  const fs = {
    ...nodeFs,
    open: async (path, flags, ...rest) => {
      if (rejectLedgerWrite && String(path).includes('budget-ledger.json.') && flags === 'w') throw Object.assign(new Error('disk secret marker'), { code: 'EIO' });
      return nodeFs.open(path, flags, ...rest);
    },
  };
  const conf = config();
  await budgetAdmin({ dataDir, now: () => NOW }).init({ config: conf, authorizedBy: 'budget.test' });
  const guard = await createBudgetGuard({ dataDir, config: conf, now: () => NOW, fs }).start();
  rejectLedgerWrite = true;
  await assert.rejects(guard.admit(request()), e => e instanceof BudgetError && /write failed/.test(e.message) && !e.message.includes('secret marker'));
  assert.equal(guard.status().realAdmission, false);
});

test('unknown create identity and failed cleanup hold the reservation without refunding', async t => {
  const unknown = await initialized(t);
  const r1 = await unknown.guard.admit(request());
  await unknown.guard.beforeCreate(r1.id);
  await unknown.guard.settle(r1.id, { createAttempted: true, cleanup: 'deleted', secretsCleanup: 'deleted' });
  assert.equal(unknown.guard.status().activeHoldCount, 1);
  assert.equal((await unknown.store.read()).reservations[0].costMicroUsd, COST);

  const cleanup = await initialized(t);
  const r2 = await cleanup.guard.admit(request());
  await cleanup.guard.beforeCreate(r2.id);
  await cleanup.guard.created(r2.id, 'sandboxes/known');
  await cleanup.guard.verified(r2.id);
  await cleanup.guard.settle(r2.id, { createAttempted: true, sandboxName: 'sandboxes/known', cleanup: 'FAILED', secretsCleanup: 'deleted' });
  assert.equal(cleanup.guard.status().realAdmission, false);
  assert.equal((await cleanup.store.read()).reservations[0].costMicroUsd, COST);
});

test('verified deletion closes the outcome but never refunds the reservation', async t => {
  const { guard, store } = await initialized(t);
  const r = await guard.admit(request());
  await guard.beforeCreate(r.id);
  await guard.created(r.id, 'sandboxes/known');
  await guard.verified(r.id);
  await guard.settle(r.id, { createAttempted: true, sandboxName: 'sandboxes/known', cleanup: 'deleted', secretsCleanup: 'deleted' });
  const ledger = await store.read();
  assert.equal(ledger.reservations[0].outcome, 'deleted');
  assert.equal(guard.status().global.estimatedReservedMicroUsd, COST);
});

test('admin actions are audited and reconciliation keeps charges', async t => {
  const { guard, admin, store } = await initialized(t);
  const r = await guard.admit(request());
  await guard.beforeCreate(r.id);
  await guard.settle(r.id, { createAttempted: true });
  await guard.shutdown();
  const result = await admin.reconcile({ reservation: r.id, evidence: 'Docker Console confirms no sandbox exists', authorizedBy: 'operator' });
  assert.equal(result.chargesKept, true);
  const status = await admin.status({ authorizedBy: 'operator' });
  assert.equal(status.activeHolds.length, 0);
  assert.equal(status.global.estimatedReservedMicroUsd, COST);
  const ledger = await store.read();
  assert.equal(ledger.reservations[0].outcome, 'reconciled');
  assert.deepEqual(ledger.audit.map(a => a.action), ['init', 'reconcile', 'status']);
});

test('policy changes append a version and cannot erase prior opening usage', async t => {
  const { admin, store, guard } = await initialized(t, { conf: config({ openingGlobal: 5, openingProject: 5 }) });
  await guard.shutdown();
  const next = config({ opening: {
    '2026-01': { globalMicroUsd: 6, projects: { app: 6 } },
    '2026-02': { globalMicroUsd: 0, projects: { app: 0 } },
  } });
  await admin.policy({ config: { ...next, policyVersion: 2 }, authorizedBy: 'operator' });
  const ledger = await store.read();
  assert.deepEqual(ledger.policies.map(p => p.version), [1, 2]);
  assert.equal(ledger.policies[1].digest, policyDigest({ ...next, policyVersion: 2 }));
  await assert.rejects(admin.policy({ config: config({ policyVersion: 3, openingGlobal: 0, openingProject: 0 }), authorizedBy: 'operator' }), /cannot be removed or lowered/);
});

test('a slow launch-intent write cannot push a create past the reserved window', async t => {
  const start = Date.parse('2026-01-31T22:40:00.000Z'); // window ends 23:52, inside January
  let clock = start;
  let slow = 0;
  const fs = { ...nodeFs, rename: async (a, b) => { clock += slow; return nodeFs.rename(a, b); } };
  const { guard, store } = await initialized(t, { now: () => clock, fs });
  const r = await guard.admit(request());
  assert.deepEqual(r.months, ['2026-01']);
  clock = Date.parse('2026-01-31T22:44:59.000Z'); // still fits before the intent write
  slow = 2000;
  await assert.rejects(guard.beforeCreate(r.id), /no longer covers a full launch/);
  slow = 0;
  await guard.settle(r.id, { createAttempted: false });
  const saved = (await store.read()).reservations[0];
  assert.deepEqual([saved.outcome, saved.costMicroUsd], ['aborted_prelaunch', COST]);

  clock = start;
  const control = await initialized(t, { now: () => clock });
  const c = await control.guard.admit(request());
  clock = Date.parse('2026-01-31T22:44:59.000Z');
  const { latestExpiryMs } = await control.guard.beforeCreate(c.id);
  assert.equal(latestExpiryMs, Date.parse((await control.store.read()).reservations[0].windowEnd));
});

test('stale-lock recovery breaks only the inspected lock, one recovery at a time', async t => {
  const dataDir = await tempDir(t);
  const a = ledgerStore(dataDir);
  const b = ledgerStore(dataDir);
  const stale = JSON.stringify({ token: 'dead', owner: 'bridge', pid: 1, host: 'gone-host', at: 'then' });
  await writeFile(a.paths.lock, stale);

  const seenByA = await a.acquireLock('budget-admin');
  const seenByB = await b.acquireLock('budget-admin');
  assert.equal(seenByA.ok, false);
  assert.equal(seenByA.raw, stale);
  const winner = await b.replaceStaleLock(seenByB.raw, 'budget-admin');
  assert.equal(winner.ok, true);
  await assert.rejects(a.replaceStaleLock(seenByA.raw, 'budget-admin'), /lock changed during recovery/);
  assert.equal((await a.readLock()).token, winner.token, 'the replacement lock is never unlinked');
  await assert.rejects(nodeFs.stat(a.paths.recovery), { code: 'ENOENT' });

  await writeFile(a.paths.recovery, 'crashed recovery');
  await assert.rejects(a.replaceStaleLock(JSON.stringify(await a.readLock()), 'budget-admin'), /Another stale-lock recovery/);
  assert.equal((await a.readLock()).token, winner.token);
  await unlink(a.paths.recovery);

  await writeFile(a.paths.lock, stale);
  const admin = budgetAdmin({ dataDir, now: () => NOW });
  await assert.rejects(admin.init({ config: config(), authorizedBy: 'budget.test' }), /lock is held/);
  const done = await admin.init({ config: config(), authorizedBy: 'budget.test', staleLock: true, evidence: 'no bridge running on gone-host' });
  assert.equal(done.initialized, true);
  assert.equal(await a.readLock(), null, 'the admin releases its own lock afterwards');
  const audit = (await a.read()).audit.map(x => x.action);
  assert.deepEqual(audit, ['stale-lock-cleared', 'init']);
});

test('a lock is never visible before its owner is published, so recovery cannot steal one being acquired', async t => {
  const dataDir = await tempDir(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const paused = { ...nodeFs, link: async (a, b) => { await gate; return nodeFs.link(a, b); } };
  const server = ledgerStore(dataDir, paused);
  const operator = ledgerStore(dataDir);
  const pending = server.acquireLock('bridge');
  await new Promise(resolve => setTimeout(resolve, 20)); // the server has written its owner file and waits to publish
  assert.equal(await operator.readLock(), null, 'nothing half-written is visible under the lock name');
  const admin = await operator.acquireLock('budget-admin');
  assert.equal(admin.ok, true);
  release();
  const late = await pending;
  assert.equal(late.ok, false, 'the second acquirer never believes it owns the lock');
  assert.equal(late.holder.token, admin.token);
  assert.equal((await operator.readLock()).token, admin.token);
  assert.deepEqual((await nodeFs.readdir(dataDir)).filter(f => f.endsWith('.tmp')), [], 'temporary owner files are removed');
});

test('a ledger whose reservation charge, window or months fall below its policy bound fails closed', async t => {
  const { guard, store, dataDir, conf } = await initialized(t);
  const r = await guard.admit(request());
  await guard.settle(r.id, { createAttempted: false });
  await guard.shutdown();
  const good = JSON.parse(await nodeFs.readFile(store.paths.ledger, 'utf8'));
  const tamper = [
    l => { l.reservations[0].costMicroUsd = 1; },
    l => { l.reservations[0].costMicroUsd = COST - 1; },
    l => { l.reservations[0].windowEnd = l.reservations[0].reservedAt; },
    l => { l.reservations[0].months = ['2025-12']; },
  ];
  for (const [i, mutate] of tamper.entries()) {
    const l = structuredClone(good);
    mutate(l);
    await writeFile(store.paths.ledger, JSON.stringify(l));
    await assert.rejects(store.read(), /inconsistent/, `tamper ${i}`);
    const restarted = await createBudgetGuard({ dataDir, config: conf, now: () => NOW }).start();
    assert.equal(restarted.status('app').realAdmission, false, `tamper ${i} must disable admission`);
    await restarted.shutdown();
  }
  const higher = structuredClone(good);
  higher.reservations[0].costMicroUsd = COST + 5;
  await writeFile(store.paths.ledger, JSON.stringify(higher));
  assert.equal((await store.read()).reservations[0].costMicroUsd, COST + 5, 'a larger charge is conservative and accepted');
});

test('mock mode does not create or access the ledger', async t => {
  const dataDir = await tempDir(t);
  const guard = await createBudgetGuard({ dataDir, config: config(), mock: true, now: () => NOW }).start();
  assert.equal(guard.status().mode, 'mock');
  assert.equal(await ledgerStore(dataDir).read(), null);
  assert.equal((await nodeFs.readdir(dataDir)).length, 0);
});
