import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export function distribution(values) {
  if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, sum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const p = q => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return { count: values.length, mean: sum / values.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1), sum };
}

// Per-scenario samples stay in the measured process; only summaries cross IPC.
export function createMetrics(role) {
  let active = false;
  let startedAt, cpuStart, eluStart, sampleTimer, loop;
  let series = new Map();
  let counts = {};
  let samples = [];
  let cpuPrevious, timePrevious;
  function sample() {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    samples.push({
      elapsedMs: now - startedAt,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      cpuOneCorePercent: ((cpu.user - cpuPrevious.user + cpu.system - cpuPrevious.system) / 1000) / (now - timePrevious) * 100,
    });
    cpuPrevious = cpu;
    timePrevious = now;
  }
  return {
    record(name, value) {
      if (!active) return;
      if (!series.has(name)) series.set(name, []);
      series.get(name).push(value);
    },
    count(name, value = 1) { if (active) counts[name] = (counts[name] || 0) + value; },
    begin() {
      series = new Map(); counts = {}; samples = [];
      startedAt = performance.now();
      cpuStart = cpuPrevious = process.cpuUsage(); timePrevious = startedAt;
      eluStart = performance.eventLoopUtilization();
      loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
      active = true;
      sample(); sampleTimer = setInterval(sample, 250); sampleTimer.unref();
    },
    end() {
      sample(); active = false; clearInterval(sampleTimer); loop.disable();
      const elapsedMs = performance.now() - startedAt;
      const cpu = process.cpuUsage(cpuStart);
      const elu = performance.eventLoopUtilization(eluStart);
      return {
        role, elapsedMs, counts,
        distributions: Object.fromEntries([...series].map(([key, values]) => [key, distribution(values)])),
        cpuMs: (cpu.user + cpu.system) / 1000,
        cpuOneCorePercent: (cpu.user + cpu.system) / 1000 / elapsedMs * 100,
        eventLoopUtilization: elu.utilization,
        eventLoopDelayMs: { mean: Number.isFinite(loop.mean) ? loop.mean / 1e6 : 0, p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
        peakRssBytes: Math.max(...samples.map(s => s.rssBytes)),
        peakHeapUsedBytes: Math.max(...samples.map(s => s.heapUsedBytes)),
        samples,
      };
    },
  };
}
