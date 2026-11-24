import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { createMockArk, seedVendor } from '../mock-ark.js';
import { createApp } from '../../src/server.js';
import { ArkClient } from '../../src/ark.js';
import { createMetrics } from './metrics.mjs';

const role = process.argv[2];
const options = JSON.parse(process.env.LOCAL_LOAD_OPTIONS);
const metrics = createMetrics(role);
let engine, mock, originalFlush, profileSession;
const listen = app => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.on('error', reject);
});
const inspectorPost = (method, params = {}) => new Promise((resolve, reject) => profileSession.post(method, params, (err, value) => err ? reject(err) : resolve(value)));
const outer = express();
outer.use((req, res, next) => {
  const start = performance.now();
  const label = role === 'mock' ? `${req.query.Action || 'media'}` : `${req.method} ${req.path.replace(/job-[^/]+/g, ':job')}`;
  res.once('finish', () => {
    metrics.record(`http.${label}`, performance.now() - start);
    metrics.count(`http.status.${res.statusCode}`);
  });
  next();
});

if (role === 'mock') {
  let nextId = 0;
  mock = createMockArk({
    processDelayMs: options.processDelayMs,
    // The default fixture's short random IDs can collide at large sample sizes.
    idFactory: prefix => `${prefix}-load-${++nextId}`,
    consumeMedia: true,
    onAssetProcessed: result => { metrics.record('processingMs', result.durationMs); metrics.count(`processed.${result.status}`); },
  });
  outer.use(mock.app);
  const server = await listen(outer);
  mock.baseUrl = `http://127.0.0.1:${server.address().port}`;
  mock.media.set('payload', Buffer.alloc(options.mediaBytes, 7));
  const source = seedVendor(mock, 'load-source', 'local-load');
  seedVendor(mock, 'load-target', 'local-load');
  for (let group = 0; group < options.groups; group++) source.addGroup(`source-group-${group}`, `load-group-${group}`);
  const types = ['Image', 'Video', 'Audio'];
  for (let i = 0; i < options.assets; i++) source.addAsset(`source-${i}`, `source-group-${i % options.groups}`, `load-${String(i).padStart(7, '0')}`, types[i % types.length], 'Active', 'payload');
  process.send({ ready: true, url: mock.baseUrl });
} else if (role === 'sut') {
  const originalCall = ArkClient.prototype.callOnce;
  ArkClient.prototype.callOnce = async function (action, body) {
    const start = performance.now();
    const side = this.vendor === 'load-source' ? 'source' : 'target';
    try { return await originalCall.call(this, action, body); }
    catch (err) { metrics.count(`upstream.error.${err.status || err.kind || 'unknown'}`); throw err; }
    finally { metrics.record(`upstream.${side}.${action}`, performance.now() - start); }
  };
  const instance = createApp({ dataDir: options.dataDir });
  engine = instance.engine;
  originalFlush = engine.flush.bind(engine);
  engine.flush = () => {
    if (options.persistence === false) { metrics.count('flushSkipped'); return; }
    const dirty = engine.dirty.size;
    const start = performance.now();
    try { return originalFlush(); }
    finally { if (dirty) { metrics.record('flushMs', performance.now() - start); metrics.count('flushJobs', dirty); } }
  };
  const originalProcessItem = engine.processItem.bind(engine);
  engine.processItem = async (job, item) => {
    const start = performance.now();
    try { return await originalProcessItem(job, item); }
    finally { metrics.record('itemServiceMs', performance.now() - start); }
  };
  const originalPoll = engine.pollTarget.bind(engine);
  engine.pollTarget = async (job, item) => {
    const start = performance.now();
    try { return await originalPoll(job, item); }
    finally { metrics.record('pollResidenceMs', performance.now() - start); }
  };
  const originalScan = engine.runScan.bind(engine);
  engine.runScan = async job => {
    const start = performance.now();
    try { return await originalScan(job); }
    finally { metrics.record('scanMs', performance.now() - start); }
  };
  const starts = new WeakMap();
  const originalStart = engine.start.bind(engine);
  engine.start = job => { starts.set(job, performance.now()); return originalStart(job); };
  const originalFinalize = engine.maybeFinalize.bind(engine);
  engine.maybeFinalize = job => {
    const wasRunning = job.status === 'running';
    const result = originalFinalize(job);
    if (wasRunning && job.status === 'completed') metrics.record('migrationWallMs', performance.now() - starts.get(job));
    return result;
  };
  outer.use(instance.app);
  const server = await listen(outer);
  process.send({ ready: true, url: `http://127.0.0.1:${server.address().port}` });
} else {
  throw new Error(`Unknown worker role ${role}`);
}

process.on('message', async message => {
  const reply = result => process.send({ replyTo: message.id, result });
  try {
    switch (message.action) {
      case 'begin':
        if (role === 'sut' && options.profilePath) {
          profileSession = new inspector.Session(); profileSession.connect();
          await inspectorPost('Profiler.enable'); await inspectorPost('Profiler.start');
        }
        metrics.begin(); reply({ ok: true }); break;
      case 'end': {
        const result = metrics.end();
        if (profileSession) {
          const { profile } = await inspectorPost('Profiler.stop'); profileSession.disconnect(); profileSession = null;
          fs.writeFileSync(options.profilePath, JSON.stringify(profile));
          result.cpuProfilePath = options.profilePath;
          const samples = new Map();
          for (const id of profile.samples || []) samples.set(id, (samples.get(id) || 0) + 1);
          result.cpuTopFrames = profile.nodes.map(node => ({ function: node.callFrame.functionName || '(anonymous)', file: node.callFrame.url, line: node.callFrame.lineNumber + 1, samples: samples.get(node.id) || 0 }))
            .filter(frame => frame.samples && !['(idle)', '(program)', '(root)'].includes(frame.function))
            .sort((a, b) => b.samples - a.samples).slice(0, 15);
        }
        reply(result); break;
      }
      case 'verify': {
        if (role === 'mock') {
          const target = [...mock.vstate('load-target').assets.values()];
          const sourceByName = new Map([...mock.vstate('load-source').assets.values()].map(asset => [asset.Name, asset]));
          reply({ count: target.length, active: target.filter(a => a.Status === 'Active').length, uniqueNames: new Set(target.map(a => a.Name)).size,
            mismatched: target.filter(a => !sourceByName.has(a.Name) || sourceByName.get(a.Name).AssetType !== a.AssetType).length });
        } else {
          // The diagnostic scenario restores durability after the timed window.
          originalFlush();
          const jobs = [...engine.jobs.values()];
          const persisted = jobs.map(job => JSON.parse(fs.readFileSync(path.join(options.dataDir, 'jobs', `${job.id}.json`), 'utf8')));
          reply({ jobCount: jobs.length, persistedCounters: persisted.map(job => job.counters), jobBytes: persisted.reduce((sum, job) => sum + fs.statSync(path.join(options.dataDir, 'jobs', `${job.id}.json`)).size, 0), errors: jobs.flatMap(job => job.items.filter(item => item.error).slice(0, 5).map(item => item.error)) });
        }
        break;
      }
      case 'shutdown':
        if (engine) { for (const job of engine.jobs.values()) job._stop = true; originalFlush(); }
        reply({ ok: true }); process.exit(0); break;
      default: throw new Error(`Unknown action ${message.action}`);
    }
  } catch (err) { process.send({ replyTo: message.id, error: err.stack || String(err) }); }
});
process.on('disconnect', () => process.exit(1));
