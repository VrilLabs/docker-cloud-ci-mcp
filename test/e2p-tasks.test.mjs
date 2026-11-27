import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeTask, prepareRun, reservedNames, validateConfig } from '../config.mjs';
import { resolveJob, scriptFor } from '../policy.mjs';

const config = JSON.parse(await readFile(new URL('../projects.e2p.example.json', import.meta.url), 'utf8'));
const project = config.e2p;
const commit = 'a'.repeat(40);

test('E2P sample allowlist validates and has only the three approved tasks', () => {
  assert.equal(validateConfig(config, {}), undefined);
  assert.deepEqual(Object.keys(project.tasks), ['verify', 'desktop-frontend', 'web-build']);
  assert.deepEqual(project.auth, { tokenEnv: 'E2P_GITLAB_READ_TOKEN' });
  assert.deepEqual(project.status, { provider: 'gitlab', tokenEnv: 'E2P_GITLAB_STATUS_TOKEN' });
});

test('E2P bridge tasks call the same repo entrypoints and declare one expected artifact', () => {
  const expected = {
    verify: ['sh tooling/ci/jobs/verify.sh', 'ci-artifacts/verify-provenance.json'],
    'desktop-frontend': ['sh tooling/ci/jobs/desktop-frontend.sh', 'ci-artifacts/desktop-dist.tar.gz'],
    'web-build': ['sh tooling/ci/jobs/web-build.sh', 'web-preview.tar.gz'],
  };
  for (const [name, [script, artifact]] of Object.entries(expected)) {
    const task = normalizeTask(project.tasks[name]);
    assert.equal(task.script, script, name);
    assert.deepEqual(task.artifacts, [artifact], name);
    assert.deepEqual(task.forward, {}, `${name} must not forward environment variables`);

    const job = resolveJob(config, 'e2p', name, commit, {});
    assert.equal(job.task.script, script);
    assert.match(scriptFor(job, commit), new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('E2P tasks use only private-clone injection and never forward a secret', () => {
  const env = {
    E2P_GITLAB_READ_TOKEN: 'synthetic-read-token',
    E2P_GITLAB_STATUS_TOKEN: 'synthetic-status-token',
  };
  const spec = resolveJob(config, 'e2p', 'verify', commit, {});
  const plan = prepareRun(spec, [], env, reservedNames(config));
  assert.deepEqual(plan.env, {});
  assert.deepEqual(plan.forwarded, []);
  assert.equal(plan.secrets.length, 1);
  assert.deepEqual(plan.secrets[0].create.custom.injection.hosts, ['gitlab.com']);
  assert(plan.redactions.includes(env.E2P_GITLAB_READ_TOKEN));
  assert(!plan.redactions.includes(env.E2P_GITLAB_STATUS_TOKEN), 'status credentials stay on the bridge and are not attached to the sandbox');
});
