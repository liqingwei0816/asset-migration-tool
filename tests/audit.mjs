/**
 * 项目静态一致性审计：
 * 1) JS/HTML 使用的类名是否有对应 CSS 规则
 * 2) 前端调用的 API 是否都有服务端路由
 * 3) app.js 是否有重复函数定义
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/style.css');
const server = read('src/server.js');

let issues = 0;

// 1. CSS 类选择器
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const used = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => c && used.add(c));
for (const m of app.matchAll(/class="([^"$]+)"/g)) m[1].split(/\s+/).forEach(c => c && !c.includes('${') && used.add(c));
for (const m of app.matchAll(/className = '([^']+)'/g)) m[1].split(/\s+/).forEach(c => c && used.add(c));
for (const m of app.matchAll(/classList\.(?:add|toggle)\('([^']+)'/g)) used.add(m[1]);
const missingCss = [...used].filter(c => !cssClasses.has(c));
console.log('1) JS/HTML 使用但 CSS 未定义的类:', missingCss.length ? missingCss.join(', ') : '无');
if (missingCss.length) issues += missingCss.length;

// 2. API 调用 vs 路由（前缀匹配：前端路径含模板参数）
const apiCalls = new Set();
for (const m of app.matchAll(/['`](\/api\/[^'`$\s]*)/g)) apiCalls.add(m[1]);
const routes = [...server.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map(m => {
  return m[2].replace(/:(\w+)/g, '__P__').replace(/[?]\\|\/[a-z|]+$/,'');
});
const routeRegexes = [...server.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map(m => {
  const parts = m[2].split('/').map(p => p.startsWith(':') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + parts.join('/') + '$');
});
const missingApi = [...apiCalls].filter(p => {
  // 截断模板插值部分后匹配
  const pathPart = p.split('${')[0].replace(/\/$/, '');
  return !routeRegexes.some(re => re.test(pathPart) || re.test(pathPart.replace(/\/(start|pause|cancel|retry-failed)$/, '')));
});
console.log('2) 前端调用但无对应路由的 API:', missingApi.length ? missingApi.join(', ') : '无');
if (missingApi.length) issues += missingApi.length;

// 3. 重复函数定义
const fns = [...app.matchAll(/^function (\w+)/gm)].map(m => m[1]);
const dups = [...new Set(fns.filter((f, i) => fns.indexOf(f) !== i))];
console.log('3) app.js 重复函数定义:', dups.length ? dups.join(', ') : '无');
if (dups.length) issues += dups.length;

// 4. id 引用检查：JS 里 $('#x') 是否在生成的 HTML 中出现
const idRefs = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
const idDefs = new Set();
for (const m of html.matchAll(/id="([\w-]+)"/g)) idDefs.add(m[1]);
for (const m of app.matchAll(/id="([\w-]+)"/g)) idDefs.add(m[1]);
for (const m of app.matchAll(/id="\$\{/g)) { /* 模板 id 动态，跳过 */ }
const missingIds = [...idRefs].filter(id => !idDefs.has(id));
console.log('4) JS 引用但从未定义的元素 id:', missingIds.length ? missingIds.join(', ') : '无');
if (missingIds.length) issues += missingIds.length;

console.log(issues === 0 ? '\n审计通过：未发现一致性问题' : `\n发现 ${issues} 类问题`);
