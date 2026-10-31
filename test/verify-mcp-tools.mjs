// 用 MCP stdio 真起一次服务，跑 initialize + tools/list，确认工具都注册上了。
// 用法：node test/verify-mcp-tools.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../lib/mcp-server.js');

const frames = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
];
const stdin = `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`;

const r = spawnSync(process.execPath, [server], { input: stdin, encoding: 'utf8', timeout: 30000 });
if (r.error) {
  console.error(`spawn 失败：${r.error.message}`);
  process.exit(1);
}
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const lines = out.split(/\r?\n/).filter(Boolean);

let listed = null;
for (const line of lines) {
  if (!line.trim().startsWith('{')) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.id === 2 && msg.result?.tools) listed = msg.result.tools;
}

if (!listed) {
  console.error('没拿到 tools/list 结果。原始输出：');
  console.error(out.slice(0, 3000));
  process.exit(1);
}

const names = listed.map((t) => t.name);
const want = ['qq_describe_image', 'qq_describe_file', 'qq_vision_status', 'qq_vision_models', 'qq_vision_usage', 'qq_vision_config', 'qq_vision_selftest'];
const missing = want.filter((n) => !names.includes(n));
const extra = names.filter((n) => !want.includes(n));
console.log(`MCP 工具共 ${names.length} 个：${names.join(', ')}`);
if (extra.length) console.log(`多出来的：${extra.join(', ')}`);
console.log(missing.length === 0 ? `PASS ${want.length} 个工具全部注册` : `FAIL 缺 ${missing.join(', ')}`);
process.exit(missing.length === 0 ? 0 : 1);
