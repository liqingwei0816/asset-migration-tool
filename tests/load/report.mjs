import fs from 'node:fs';
import path from 'node:path';

const num = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const mib = n => n / 1024 / 1024;
const metric = (r, name) => r.sut?.distributions[name] || { count: 0, sum: 0, mean: 0, p95: 0, p99: 0, max: 0 };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function findings(results) {
  const notes = [];
  const base = results.find(r => r.id === 'c20');
  const fast = results.find(r => r.id === 'fast-poll');
  if (base && fast) notes.push(`同样 ${base.assets} 个素材、并发 20、模拟处理 ${base.processDelayMs}ms，轮询 ${base.pollIntervalMs} → ${fast.pollIntervalMs}ms 后，吞吐 ${num(base.throughput)} → ${num(fast.throughput)} 个/秒（${num(fast.throughput / base.throughput)} 倍）。这组对照说明轮询等待对当前工作槽的占用是主要限制之一。`);
  const scale = results.find(r => r.id === 'scale-10k');
  const noFlush = results.find(r => r.id === 'scale-10k-no-flush');
  if (scale?.sut && noFlush?.sut) {
    notes.push(`万级任务的落盘对照：正常 ${num(scale.throughput)} 个/秒，关闭定时落盘 ${num(noFlush.throughput)} 个/秒（变化 ${num((noFlush.throughput / scale.throughput - 1) * 100)}%）；正常模式累计 flush ${num(metric(scale, 'flushMs').sum)}ms / ${metric(scale, 'flushMs').count} 次，单次 P95 ${num(metric(scale, 'flushMs').p95)}ms、最大 ${num(metric(scale, 'flushMs').max)}ms。关闭落盘仅用于诊断，不能作为正式运行配置；两次顺序运行并非统计显著性结论。`);
    notes.push(`同步落盘对响应性的影响：关闭后工作台 CPU ${num(scale.sut.cpuOneCorePercent)}% → ${num(noFlush.sut.cpuOneCorePercent)}%，事件循环 P99 ${num(scale.sut.eventLoopDelayMs.p99)} → ${num(noFlush.sut.eventLoopDelayMs.p99)}ms、最大 ${num(scale.sut.eventLoopDelayMs.max)} → ${num(noFlush.sut.eventLoopDelayMs.max)}ms；控制台 API P95 ${num(scale.controlApi.p95)} → ${num(noFlush.controlApi.p95)}ms。flush 同时包含 JSON 序列化和同步文件操作，本轮没有单独分离二者，因此不能归因于磁盘硬件性能不足。`);
    if (scale.sut.cpuTopFrames?.[0]?.function === 'writeJsonAtomic') notes.push('正常落盘的万级任务中，CPU profile 的非 idle 自身采样首位为 writeJsonAtomic，与全量序列化和写入的阻塞测量一致；等待占用工作槽和同步持久化是两个不同层面的开销。');
  }
  const largest = scale || results.at(-1);
  if (largest?.sut) {
    const residence = metric(largest, 'pollResidenceMs').sum;
    const service = metric(largest, 'itemServiceMs').sum;
    notes.push(`场景 ${largest.id} 中，轮询阶段占素材累计服务时间 ${num(residence / service * 100)}%，工作台平均 CPU ${num(largest.sut.cpuOneCorePercent)}%（单核 100%），事件循环 P99 ${num(largest.sut.eventLoopDelayMs.p99)}ms、最大 ${num(largest.sut.eventLoopDelayMs.max)}ms。CPU、等待与磁盘指标应结合看，不能仅凭完成吞吐断定 CPU 已饱和。`);
  }
  if (results.every(r => r.ok)) notes.push('全部已执行场景通过：源数量、目标数量、唯一名称、类型、Active 状态、任务计数和最终持久化计数均一致。');
  else notes.push(`有 ${results.filter(r => !r.ok).length} 个场景未通过；必须先检查对应错误和原始数据，不能把失败场景作为有效容量结果。`);
  return notes;
}

export function writeReports(report, outputDir) {
  const results = report.results;
  const notes = findings(results);
  const lines = [
    '# 本地素材上传模拟压测报告', '',
    `- 开始时间：${report.startedAtShanghai}（Asia/Shanghai）`,
    `- 完成状态：${report.complete === undefined ? '运行中（以下为已完成场景）' : report.complete ? '全部场景完成' : '未完整完成，请检查错误'}；已记录 ${results.length} 个场景、${results.reduce((sum, result) => sum + (result.counters?.done || 0), 0)} 次成功模拟迁移。`,
    `- 运行环境：${report.environment.platform} ${report.environment.release} / ${report.environment.arch}；Node ${report.environment.node}；CPU ${report.environment.cpu}（${report.environment.logicalCpus} 逻辑核）；物理内存 ${num(report.environment.totalMemoryBytes / 1024 ** 3)} GiB。`,
    `- Git：${report.environment.commit}；运行时工作区修改：${report.environment.gitDirty ? '是（包含本次压测脚本）' : '否'}。`,
    `- 素材：每个 ${report.mediaBytes} 字节内存占位数据，Image / Video / Audio 均匀分布，${report.groups} 个组，唯一名称。Mock 读取完整响应体。`,
    '- 工作台、Mock、调度器为三个独立进程；仅监听 127.0.0.1 随机端口；不读取正式配置，不访问外部平台。每个场景使用独立数据目录和新进程，启动、造数和配置不计入测量。',
    '- 窗口：CPU/内存/事件循环/请求/flush 指标覆盖扫描开始至迁移完成；吞吐 = 成功数 / 迁移阶段耗时，扫描单列；服务时间从领取素材到最终状态，包含轮询等待，不包含排队。吞吐不计启动、造数、扫描和报告生成。',
    '- HTTP 延迟采用单调时钟；百分位为本轮实际请求样本的 nearest-rank；CPU 按单核 100% 计，内存每 250ms 采样。控制台 API 延迟由调度器从客户端测量。',
    '- 该轮为短时探索性对照，每个场景仅运行一次；不代表长期稳定容量，不代表真实媒体传输/转码/审核/公网性能。CPU 采样分析会有开销；有采样的场景在表中标记。', '',
    '## 测量结果', '',
    '| 场景 | 数量 | 并发 | 轮询/处理 ms | 扫描 s | 迁移 s | 成功/失败 | 个/秒 | 素材服务 P95 ms | CPU % | 峰值 RSS MiB | 循环 P99/max ms | 校验 |',
    '| --- | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const r of results) lines.push(`| ${r.id}${r.profile ? '（CPU采样）' : ''} | ${r.assets} | ${r.concurrency} | ${r.pollIntervalMs}/${r.processDelayMs} | ${num(r.scanMs / 1000)} | ${num(r.migrationMs / 1000)} | ${r.counters?.done ?? 0}/${r.counters?.failed ?? 0} | ${num(r.throughput)} | ${num(metric(r, 'itemServiceMs').p95)} | ${num(r.sut?.cpuOneCorePercent)} | ${num(mib(r.sut?.peakRssBytes))} | ${num(r.sut?.eventLoopDelayMs.p99)}/${num(r.sut?.eventLoopDelayMs.max)} | ${r.ok ? '通过' : '失败'} |`);
  lines.push('', '## 瓶颈判断与证据', '', ...notes.map((note, i) => `${i + 1}. ${note}`), '', '## 分项证据', '',
    '| 场景 | CreateAsset P95 ms | 目标 GetAsset P95 ms | 控制台 API P95 ms | 轮询次数/素材 | Mock CPU % | Mock 循环 max ms | flush 次数 / P95 ms | 任务文件 MiB |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |');
  for (const r of results) lines.push(`| ${r.id} | ${num(metric(r, 'upstream.target.CreateAsset').p95)} | ${num(metric(r, 'upstream.target.GetAsset').p95)} | ${num(r.controlApi?.p95)} | ${num(metric(r, 'upstream.target.GetAsset').count / r.assets)} | ${num(r.mock?.cpuOneCorePercent)} | ${num(r.mock?.eventLoopDelayMs.max)} | ${metric(r, 'flushMs').count} / ${num(metric(r, 'flushMs').p95)} | ${num(mib(r.persistenceCheck?.jobBytes))} |`);
  for (const r of results.filter(r => r.sut?.cpuTopFrames)) {
    lines.push('', `### ${r.id} CPU 热点（非 idle 的自身采样数）`, '', '| 函数 | 文件:行 | 自身采样数 |', '| --- | --- | ---: |');
    for (const frame of r.sut.cpuTopFrames) lines.push(`| ${frame.function.replace(/\|/g, '\\|')} | ${frame.file.replace(/^file:\/\//, '')}:${frame.line} | ${frame.samples} |`);
  }
  lines.push('', '## 建议', '',
    '1. 优先把“提交并发”和“等待处理/轮询并发”分开，或使用集中轮询调度；缩短轮询需同时核对真实平台的 GetAsset 配额。当前单个工作槽覆盖源详情、提交、等待和确认整个生命周期。',
    '2. 若大任务的 flush 延迟影响控制台或事件循环，优先考虑增量持久化、减少全量 JSON 重写、将同步写入移出主线程；保留断点恢复语义。',
    '3. 任务领取使用 items.find，且每个素材重复构造组映射；大规模下可改游标/队列并缓存组映射。这是代码层面的潜在扩展风险，需用 CPU profile 和更大规模验证，不直接视为本轮已证实的首要瓶颈。',
    '4. 下一步以真实合法素材、真实处理时延和平台配额验证，再做持续压测。本轮没有注入限流或网络错误，不能据此评价重试和断点恢复。', '',
    '## 产物与复现', '',
    '- report.html：可离线打开的汇总图表；results.json：完整汇总及 250ms 资源样本；results.csv：场景汇总；*.cpuprofile：可用 DevTools Performance 导入的 CPU 采样。',
    '- .work/：各场景独立数据目录，保留最终任务 JSON 以便复核。关闭落盘的诊断场景在测量结束后补做最终持久化，因此可做相同的最终计数校验。',
    '- 默认运行：npm run load:local；快速验证：npm run load:local -- --quick；指定场景：npm run load:local -- --only scale-10k；禁用采样：--no-profile。',
    '- 相同机器复跑时对比多轮结果；测试期间机器上的其他负载、OS 调度和文件缓存会影响数值。', '',
  );
  for (const r of results.filter(r => !r.ok)) lines.push(`- ${r.id} 失败：${r.error || JSON.stringify(r.checks)}`);
  fs.writeFileSync(path.join(outputDir, 'report.md'), lines.join('\n'));
  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify({ ...report, findings: notes }, null, 2));
  const csvKeys = ['id', 'assets', 'concurrency', 'pollIntervalMs', 'processDelayMs', 'persistence', 'scanMs', 'migrationMs', 'throughput', 'ok'];
  fs.writeFileSync(path.join(outputDir, 'results.csv'), csvKeys.join(',') + '\n' + results.map(r => csvKeys.map(key => JSON.stringify(r[key] ?? '')).join(',')).join('\n') + '\n');
  const width = 960, rowHeight = 38, maxThroughput = Math.max(1, ...results.map(r => r.throughput || 0));
  const chart = `<svg viewBox="0 0 ${width} ${60 + results.length * rowHeight}" role="img" aria-label="各场景完成吞吐量"><text x="16" y="25" fill="#cbd5e1" font-size="15">完成吞吐（个/秒；关闭落盘场景仅供诊断）</text>${results.map((r, i) => `<text x="16" y="${62 + i * rowHeight}" fill="#cbd5e1" font-size="13">${escape(r.id)}</text><rect x="210" y="${44 + i * rowHeight}" width="${(r.throughput || 0) / maxThroughput * 620}" height="25" rx="4" fill="${r.persistence === false ? '#a78bfa' : '#2dd4bf'}"/><text x="${220 + (r.throughput || 0) / maxThroughput * 620}" y="${62 + i * rowHeight}" fill="#f1f5f9" font-size="13">${num(r.throughput)}</text>`).join('')}</svg>`;
  const table = `<table><thead><tr>${['场景', '数量', '并发', '轮询 ms', '个/秒', '服务 P95 ms', 'CPU %', 'RSS MiB', '循环 P99 ms', '结果'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${results.map(r => `<tr>${[r.id, r.assets, r.concurrency, r.pollIntervalMs, num(r.throughput), num(metric(r, 'itemServiceMs').p95), num(r.sut?.cpuOneCorePercent), num(mib(r.sut?.peakRssBytes)), num(r.sut?.eventLoopDelayMs.p99), r.ok ? '通过' : '失败'].map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地模拟压测报告</title><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1200px;margin:40px auto;padding:0 24px}h1{font-size:30px}p{color:#cbd5e1}.card{background:#182339;border:1px solid #334155;border-radius:12px;padding:24px;margin:24px 0}svg{width:100%}table{width:100%;border-collapse:collapse;font-size:14px;white-space:nowrap}td,th{text-align:left;padding:12px;border-bottom:1px solid #334155}.scroll{overflow:auto}a{color:#5eead4}li{margin:14px 0}</style><main><h1>本地素材上传模拟压测报告</h1><p>${escape(report.startedAtShanghai)} · Node ${escape(report.environment.node)} · ${escape(report.environment.cpu)}</p><p>独立进程 / 回环网络 / ${report.mediaBytes} 字节占位素材 / 单次探索性运行；完整结论和口径见 <a href="report.md">report.md</a>。</p><section class="card">${chart}</section><section class="card scroll">${table}</section><section class="card"><h2>瓶颈判断与证据</h2><ol>${notes.map(note => `<li>${escape(note)}</li>`).join('')}</ol></section><p>Mock 不模拟真实转码、审核及公网速度。关闭落盘仅用于诊断。CPU/内存窗口包含扫描；吞吐只计算迁移阶段。</p><p><a href="results.json">原始数据</a> · <a href="results.csv">CSV 汇总</a></p></main></html>`;
  fs.writeFileSync(path.join(outputDir, 'report.html'), html);
}
