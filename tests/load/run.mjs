import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { distribution } from './metrics.mjs';
import { writeReports } from './report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const allowed = new Set(['--quick', '--only', '--no-profile', '--help']);
let only;
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === '--only') { only = args[++i]; if (!only || only.startsWith('--')) throw new Error('--only requires a scenario ID'); }
}
if (args.includes('--help')) {
  console.log('npm run load:local [-- --quick | --only <scenario-id>] [--no-profile]\nRuns loopback-only simulated migration in isolated child processes. Reports: reports/local-load/<timestamp>/');
  process.exit(0);
}
const groups = 4, mediaBytes = 1024;
const defaults = { groups, mediaBytes, processDelayMs: 100, pollIntervalMs: 3000, persistence: true, profile: false };
const full = [
  ...[1, 3, 5, 10, 20].map(c => ({ id: `c${c}`, concurrency: c, assets: c * 6 })),
  { id: 'fast-poll', concurrency: 20, assets: 120, pollIntervalMs: 250 },
  { id: 'slow-processing', concurrency: 20, assets: 120, pollIntervalMs: 250, processDelayMs: 1000 },
  { id: 'scale-1k', concurrency: 20, assets: 1000, pollIntervalMs: 250 },
  { id: 'scale-10k', concurrency: 20, assets: 10000, pollIntervalMs: 250, profile: true },
  { id: 'scale-10k-no-flush', concurrency: 20, assets: 10000, pollIntervalMs: 250, persistence: false, profile: true },
];
const quick = [
  { id: 'quick-normal', concurrency: 5, assets: 20, pollIntervalMs: 250 },
  { id: 'quick-no-flush', concurrency: 5, assets: 20, pollIntervalMs: 250, persistence: false, profile: true },
];
const scenarios = (args.includes('--quick') ? quick : full).filter(s => !only || s.id === only).map(s => ({ ...defaults, ...s, profile: s.profile === true && !args.includes('--no-profile') }));
if (!scenarios.length) throw new Error(`No matching scenario: ${only}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.join(ROOT, 'reports', 'local-load', `${stamp}-${process.pid}`);
fs.mkdirSync(outputDir, { recursive: true });
const git = (...parameters) => { try { return execFileSync('git', parameters, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(); } catch { return 'unknown'; } };
const report = {
  startedAt: new Date().toISOString(), startedAtShanghai: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  mediaBytes, groups,
  environment: { platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), commit: git('rev-parse', '--short', 'HEAD'), gitDirty: !!git('status', '--porcelain') },
  results: [],
};
const children = new Set();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; for (const child of children) child.kill(); });
let requestId = 0;

function launch(role, options) {
  const child = fork(WORKER, [role], { cwd: ROOT, env: { ...process.env, LOCAL_LOAD_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, execArgv: [] });
  children.add(child);
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
  const pending = new Map();
  let bootResolve, bootReject;
  const ready = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
  const bootTimer = setTimeout(() => bootReject(new Error(`${role} startup timed out\n${logs}`)), 30000);
  child.on('message', message => {
    if (message.ready) { clearTimeout(bootTimer); bootResolve(message); }
    if (message.replyTo && pending.has(message.replyTo)) {
      const { resolve, reject, timer } = pending.get(message.replyTo); clearTimeout(timer); pending.delete(message.replyTo);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    }
  });
  function fail(error) {
    clearTimeout(bootTimer); bootReject(error);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  }
  child.on('error', fail);
  child.on('exit', (code, signal) => { children.delete(child); fail(new Error(`${role} exited (${code ?? signal})\n${logs}`)); });
  return {
    child, ready,
    rpc(action) {
      return new Promise((resolve, reject) => {
        if (!child.connected) return reject(new Error(`${role} is disconnected\n${logs}`));
        const id = ++requestId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${role} ${action} timed out`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, action }, err => { if (err) { clearTimeout(timer); pending.delete(id); reject(err); } });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { await this.rpc('shutdown'); } catch { child.kill(); }
      const timer = setTimeout(() => child.kill(), 3000);
      await exited; clearTimeout(timer);
    },
  };
}

async function runScenario(scenario) {
  const workDir = path.join(outputDir, '.work', scenario.id);
  fs.mkdirSync(workDir, { recursive: true });
  const options = { ...scenario, dataDir: path.join(workDir, 'data'), profilePath: scenario.profile ? path.join(outputDir, `${scenario.id}.cpuprofile`) : null };
  let mock, sut, result = { ...scenario, ok: false };
  const probes = [];
  try {
    mock = launch('mock', options);
    const mockReady = await mock.ready;
    sut = launch('sut', options);
    const sutReady = await sut.ready;
    async function http(method, endpoint, body, probe = false) {
      const started = performance.now();
      const response = await fetch(`${sutReady.url}${endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const value = await response.json();
      if (probe) probes.push(performance.now() - started);
      if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    }
    let config;
    for (const [name, vendor] of [['source', 'load-source'], ['target', 'load-target']]) config = await http('POST', '/api/channels', { name, vendor, baseUrl: mockReady.url, projectName: 'local-load', token: 'sk-local-load' });
    const sourceId = config.channels.find(c => c.name === 'source').id;
    const targetId = config.channels.find(c => c.name === 'target').id;
    await Promise.all([mock.rpc('begin'), sut.rpc('begin')]);
    const scanStart = performance.now();
    const job = await http('POST', '/api/jobs', { name: scenario.id, sourceChannelId: sourceId, targetChannelId: targetId, groupIds: 'all', statuses: ['Active'], skipExisting: false, autoStart: false,
      settings: { concurrency: scenario.concurrency, pollIntervalMs: scenario.pollIntervalMs, pollTimeoutMs: 30000, requestRetries: 0, requestTimeoutMs: 10000, listPageSize: 200 } });
    const deadline = performance.now() + Math.max(120000, Math.ceil(scenario.assets / scenario.concurrency) * (Math.max(scenario.pollIntervalMs, scenario.processDelayMs) + 1000) * 3);
    let lastProgress = performance.now();
    const snapshots = [];
    async function waitFor(states, interval) {
      for (;;) {
        if (interrupted) throw new Error('Interrupted');
        if (performance.now() > deadline) throw new Error('Scenario timed out');
        const jobs = await http('GET', '/api/jobs', undefined, true);
        const current = jobs.find(j => j.id === job.id);
        if (!current) throw new Error('Job disappeared');
        if (states.includes(current.status)) return current;
        if (['failed', 'cancelled'].includes(current.status)) throw new Error(`Job ${current.status}: ${current.error}`);
        if (performance.now() - lastProgress >= 10000) {
          lastProgress = performance.now(); snapshots.push({ elapsedMs: lastProgress - scanStart, counters: current.counters });
          console.log(`[${scenario.id}] ${current.status} done=${current.counters.done}/${scenario.assets}, polling=${current.counters.polling}`);
        }
        await sleep(interval);
      }
    }
    await waitFor(['ready'], 25);
    const observedScanMs = performance.now() - scanStart;
    const migrationStart = performance.now();
    await http('POST', `/api/jobs/${job.id}/start`, {});
    const terminal = await waitFor(['completed'], 200);
    const observedMigrationMs = performance.now() - migrationStart;
    const [sutMetrics, mockMetrics] = await Promise.all([sut.rpc('end'), mock.rpc('end')]);
    const [targetCheck, persistenceCheck] = await Promise.all([mock.rpc('verify'), sut.rpc('verify')]);
    const counters = terminal.counters;
    const checks = {
      counters: counters.total === scenario.assets && counters.done === scenario.assets && counters.failed === 0 && counters.skipped === 0 && counters.pending === 0 && counters.uploading === 0 && counters.polling === 0,
      target: targetCheck.count === scenario.assets && targetCheck.active === scenario.assets && targetCheck.uniqueNames === scenario.assets && targetCheck.mismatched === 0,
      persisted: persistenceCheck.jobCount === 1 && persistenceCheck.persistedCounters[0]?.done === scenario.assets && persistenceCheck.persistedCounters[0]?.total === scenario.assets,
      requests: (sutMetrics.distributions['upstream.target.CreateAsset']?.count || 0) === scenario.assets && (mockMetrics.counts['processed.Active'] || 0) === scenario.assets && !Object.keys(sutMetrics.counts).some(k => k.startsWith('upstream.error.')),
    };
    const scanMs = sutMetrics.distributions.scanMs?.mean ?? observedScanMs;
    const migrationMs = sutMetrics.distributions.migrationWallMs?.mean ?? observedMigrationMs;
    result = { ...result, ok: Object.values(checks).every(Boolean), checks, counters, targetCheck, persistenceCheck, scanMs, migrationMs, observedScanMs, observedMigrationMs, throughput: counters.done / (migrationMs / 1000), controlApi: distribution(probes), sut: sutMetrics, mock: mockMetrics, snapshots, jobId: job.id };
  } catch (err) {
    result.error = err.stack || String(err);
    console.error(`[${scenario.id}] FAILED: ${result.error}`);
  } finally {
    await Promise.allSettled([sut?.stop(), mock?.stop()]);
  }
  return result;
}

console.log(`Reports: ${outputDir}`);
try {
  for (const scenario of scenarios) {
    if (interrupted) break;
    console.log(`Starting ${scenario.id}: N=${scenario.assets} C=${scenario.concurrency} poll=${scenario.pollIntervalMs}ms process=${scenario.processDelayMs}ms persistence=${scenario.persistence}`);
    const result = await runScenario(scenario);
    report.results.push(result); writeReports(report, outputDir);
    console.log(`Finished ${scenario.id}: ${result.ok ? 'PASS' : 'FAIL'}, throughput=${result.throughput?.toFixed(2) ?? 'n/a'} assets/s`);
    if (!result.ok) break;
  }
} finally {
  for (const child of children) child.kill();
  report.finishedAt = new Date().toISOString(); report.interrupted = interrupted;
  report.complete = !interrupted && report.results.length === scenarios.length && report.results.every(r => r.ok);
  writeReports(report, outputDir);
}
console.log(`Report: ${path.join(outputDir, 'report.md')}`);
process.exitCode = report.complete ? 0 : 1;
