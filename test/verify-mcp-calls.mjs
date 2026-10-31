// 通过 MCP stdio 真调三个新工具，确认返回的是人话而不是异常。
// 用法：node test/verify-mcp-calls.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../lib/mcp-server.js');

const frames = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'qq_vision_models', arguments: {} } },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_vision_usage', arguments: { limit: 3 } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qq_vision_config', arguments: { action: 'get' } } }
];
const stdin = `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`;

const r = spawnSync(process.execPath, [server], { input: stdin, encoding: 'utf8', timeout: 60000 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const byId = new Map();
for (const line of out.split(/\r?\n/)) {
  if (!line.trim().startsWith('{')) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.id !== undefined && msg.result) byId.set(msg.id, msg.result);
}

const text = (id) => (byId.get(id)?.content ?? []).map((c) => c.text ?? '').join('\n');
let bad = 0;
const show = (id, label) => {
  const t = text(id);
  const ok = byId.has(id) && !byId.get(id).isError && t.length > 20;
  if (!ok) bad += 1;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(t.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n'));
};
show(2, 'qq_vision_models');
show(3, 'qq_vision_usage');
show(4, 'qq_vision_config get');

console.log(bad === 0 ? '\n三个工具全部可调' : `\n${bad} 个工具异常`);
process.exit(bad === 0 ? 0 : 1);
