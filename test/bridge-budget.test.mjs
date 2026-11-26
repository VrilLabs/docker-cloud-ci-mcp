import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as nodeFs from 'node:fs/promises';
import { Sandboxes } from '@docker/sandboxes';
import { createBridge } from '../bridge.mjs';
import { budgetAdmin, ledgerStore, parseBudgetConfig } from '../budget.mjs';
import { LAUNCH_OPTIONS, launchRequest } from '../runner.mjs';

const key = 'k'.repeat(40);
const commit = 'b'.repeat(40);
const projects = {
  app: {
    repo: 'https://github.com/example/app.git',
    tasks: { test: 'true', other: 'true' },
  },
};

const currentMonth = (() => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();
const rawBudget = {
  version: 1, policyVersion: 1, currency: 'USD', smallHourlyRateMicroUsd: 3_600_000,
  monthlyAllowanceMicroUsd: 1_000_000_000, projects: { app: { monthlyAllowanceMicroUsd: 1_000_000_000 } },
  opening: { [currentMonth]: { globalMicroUsd: 0, projects: { app: 0 } } },
  maxSetupSeconds: 300, ttlSeconds: 3600,
  evidence: { rateVerified: true, lifetimeVerified: true, setupVerified: true },
};
const budgetConfig = parseBudgetConfig(JSON.stringify(rawBudget), Object.keys(projects));

function fakeClient({ run = async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) } = {}) {
  const sandbox = {
    name: `sandboxes/${randomUUID()}`,
    core: { resources: { cpus: 2, memoryMib: '4096' }, createdAt: new Date() },
    effectiveFeatures: {
      lifecycle: { autoResume: false },
      timeouts: { initialTimeout: '3600s', expiresAt: new Date(Date.now() + 3600_000), onTimeout: 'delete', autoResume: false },
    },
    waitUntilRunning: async () => sandbox,
    refresh: async () => sandbox,
    delete: async () => ({ waitUntilDeleted: async () => {} }),
    processes: { run },
  };
  return {
    secrets: { create: async () => { throw new Error('unexpected secret'); } },
    kits: { launch: async () => sandbox },
  };
}

async function connectBridge(t, { mock = false, client = fakeClient(), configured = budgetConfig } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bridge-mcp-budget-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  if (!mock) await budgetAdmin({ dataDir }).init({ config: configured, authorizedBy: 'bridge.test' });
  const bridge = await createBridge({
    key, config: projects, env: { BRIDGE_API_KEY: key }, dataDir, mock, client,
    budgetConfig: configured, limits: { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 4096 }, inlineMaxBytes: 1024,
    log: { error() {}, warn() {} },
  });
  const http = bridge.app.listen(0, '127.0.0.1');
  await new Promise(resolve => http.once('listening', resolve));
  const address = http.address();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const mcp = new Client({ name: 'budget-test', version: '1' });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close().catch(() => {});
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await bridge.shutdown().catch(() => {});
  });
  return { bridge, dataDir, mcp };
}

function jsonResult(response) {
  assert.equal(response.isError, undefined, response.content?.map(x => x.text).join('\n'));
  return JSON.parse(response.content.find(x => x.type === 'text').text);
}

async function waitForFinished(mcp, id) {
  for (let i = 0; i < 100; i++) {
    const status = jsonResult(await mcp.callTool({ name: 'get_build_status', arguments: { id } }));
    if (['passed', 'failed', 'error', 'interrupted'].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`build ${id} did not finish`);
}

test('MCP budget status, project summaries, serialized admission and request replay use the real handlers', async t => {
  let enterRun;
  let releaseRun;
  const running = new Promise(resolve => { enterRun = resolve; });
  const wait = new Promise(resolve => { releaseRun = resolve; });
  const client = fakeClient({ run: async () => { enterRun(); await wait; return { exitCode: 0, stdout: 'ok', stderr: '' }; } });
  const { bridge, dataDir, mcp } = await connectBridge(t, { client });
  t.after(() => releaseRun()); // a failed assertion must not leave the fake build blocked

  const tools = await mcp.listTools();
  assert(tools.tools.some(tool => tool.name === 'get_budget_status'));
  const initial = jsonResult(await mcp.callTool({ name: 'get_budget_status', arguments: { project: 'app' } }));
  assert.equal(initial.realAdmission, true);
  assert.equal(initial.label.includes('not amounts billed'), true);
  const listed = jsonResult(await mcp.callTool({ name: 'list_projects', arguments: {} }));
  assert(Array.isArray(listed));
  assert.equal(listed[0].budget.realAdmission, true);

  const requestId = randomUUID();
  const args = { project: 'app', task: 'test', commit, request_id: requestId };
  const first = jsonResult(await mcp.callTool({ name: 'start_build', arguments: args }));
  await running;
  const replay = jsonResult(await mcp.callTool({ name: 'start_build', arguments: args }));
  assert.equal(replay.id, first.id);
  const conflict = await mcp.callTool({ name: 'start_build', arguments: { ...args, task: 'other' } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content.map(x => x.text).join('\n'), /request_id conflict/);

  const second = await mcp.callTool({ name: 'start_build', arguments: { ...args, request_id: randomUUID(), task: 'other' } });
  assert.equal(second.isError, true);
  assert.match(second.content.map(x => x.text).join('\n'), /One build at a time/);
  assert.equal((await ledgerStore(dataDir).read()).reservations.length, 1);

  releaseRun();
  assert.equal((await waitForFinished(mcp, first.id)).status, 'passed');
  const finished = jsonResult(await mcp.callTool({ name: 'get_build_status', arguments: { id: first.id } }));
  assert.equal(finished.budget.outcome, 'deleted');
  assert.equal(bridge.guard.status().global.estimatedReservedMicroUsd, finished.budget.estimatedReservedMicroUsd);
});

test('mock MCP builds stay ledger-free and report budget mode as mock', async t => {
  const { bridge, dataDir, mcp } = await connectBridge(t, { mock: true, client: null });
  const status = jsonResult(await mcp.callTool({ name: 'get_budget_status', arguments: {} }));
  assert.equal(status.mode, 'mock');
  assert.equal(status.realAdmission, false);
  const job = jsonResult(await mcp.callTool({ name: 'start_build', arguments: {
    project: 'app', task: 'test', commit, request_id: randomUUID(),
  } }));
  assert.equal(job.budget.mode, 'mock');
  await waitForFinished(mcp, job.id);
  assert.equal(await ledgerStore(dataDir).read(), null);
  // The job record may still be mid-save (its temp file); anything else would be ledger state.
  assert.deepEqual((await nodeFs.readdir(dataDir)).filter(f => !f.startsWith(`${job.id}.json`)), []);
  assert.equal(bridge.guard.locked, false);
});

test('the installed SDK serializes the fixed lifecycle and a launch is attempted only once', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(buffers).toString()) });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    res.end(JSON.stringify({ code: 'unavailable', message: 'test response' }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sdk = new Sandboxes({ baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'test-token', maxRetries: 2 });
  t.after(() => sdk.close());
  await assert.rejects(sdk.kits.launch('shell', launchRequest([]), { ...LAUNCH_OPTIONS }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/sandboxes');
  assert.deepEqual(requests[0].body.resources, { cpus: 2, memoryMib: '4096' });
  assert.deepEqual(requests[0].body.features.timeouts, { timeout: '3600s', onTimeout: 'delete', autoResume: false });
});
