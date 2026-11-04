// 用假 ctx 验证 registerWebApi 是否真的把路由注册出去，并跑通 handler。
// 目的：把「代码是否注册了路由」和「线上 404 是认证/进程问题」分开。
//
// 不碰真实网络：所有用例都走未知 action / 白名单拦截 / Host 判定这些
// 在发请求之前就返回的分支。要验真实链路请跑 test/deep.mjs。
import assert from 'node:assert/strict';
import { __internals, apply } from '../lib/index.js';

const { registerWebApi, API_ROUTE, WEB_TOOL_ALLOW, hostNameOf } = __internals;

// ── 假 ctx：记录 effect / register / logger ──────────────────────
function makeCtx() {
  const routes = [];
  const effects = [];
  const logs = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    }
  };
  const ctx = {
    webServer,
    logger: {
      info: (m) => logs.push(['info', m]),
      error: (m) => logs.push(['error', m]),
      warn: (m) => logs.push(['warn', m])
    },
    get: (k) => (k === 'webServer' ? webServer : undefined),
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    tools: { register() {} }
  };
  return { ctx, routes, effects, logs };
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  OK   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name} -> ${error.message}`);
    process.exitCode = 1;
  }
}

// ── 1. 有 webServer 时必须注册路由 ─────────────────────────────
{
  const { ctx, routes, effects } = makeCtx();
  const ok = registerWebApi(ctx, () => ({}));
  check('registerWebApi 返回 true', () => assert.equal(ok, true));
  check('注册了一条路由', () => assert.equal(routes.length, 1));
  check('路由路径是 /dsh-qq-vision-api', () => assert.equal(routes[0].path, '/dsh-qq-vision-api'));
  check('路由 kind 是 exact', () => assert.equal(routes[0].kind, 'exact'));
  check('路由有 handler', () => assert.equal(typeof routes[0].handler, 'function'));
  check('effect 标签写全', () => assert.equal(effects.length, 1));
  check('effect 标签含路由名', () => assert.match(String(effects[0]), /dsh-qq-vision/));
}

// ── 2. 没有 webServer 时必须安全退出 ───────────────────────────
{
  const ctx = { logger: { info() {}, error() {} }, get: () => undefined, effect() {} };
  let ok;
  let threw = null;
  try {
    ok = registerWebApi(ctx, () => ({}));
  } catch (error) {
    threw = error;
  }
  check('无 webServer 不抛错', () => assert.equal(threw, null));
  check('无 webServer 返回 false', () => assert.equal(ok, false));
}

// ── 3. 无 ctx.get 也不崩 ───────────────────────────────────────
{
  const ctx = { logger: { info() {}, error() {} }, effect() {} };
  let ok;
  let threw = null;
  try {
    ok = registerWebApi(ctx, () => ({}));
  } catch (error) {
    threw = error;
  }
  check('ctx 没有 get 也不抛错', () => assert.equal(threw, null));
  check('ctx 没有 get 返回 false', () => assert.equal(ok, false));
}

// ── 4. 白名单必须正好覆盖 7 个工具，不多不少 ────────────────────
check('WEB_TOOL_ALLOW 有 7 项', () => assert.equal(WEB_TOOL_ALLOW.size, 7));
check('白名单全以 qq_vision_ 开头', () => {
  for (const name of WEB_TOOL_ALLOW) assert.match(name, /^qq_vision_/);
});
check('白名单不含通配或空串', () => {
  for (const name of WEB_TOOL_ALLOW) assert.ok(name && !name.includes('*'));
});

// ── 5. hostNameOf 边界 ────────────────────────────────────────
check('hostNameOf 去掉端口', () => assert.equal(hostNameOf('127.0.0.1:43719'), '127.0.0.1'));
check('hostNameOf 保留方括号 IPv6', () => assert.equal(hostNameOf('[::1]:43719'), '[::1]'));
check('hostNameOf 裸 IPv6 不被切坏', () => assert.equal(hostNameOf('::1'), '::1'));
check('hostNameOf 空值', () => assert.equal(hostNameOf(''), ''));
check('hostNameOf 域名原样', () => assert.equal(hostNameOf('evil.example.com'), 'evil.example.com'));

// ── 6. handler 端到端 ─────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/', host = '127.0.0.1:43719', body = null } = {}) {
  const handlers = {};
  const req = {
    method,
    url,
    headers: host === null ? {} : { host },
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== null) (handlers.data || []).forEach((f) => f(Buffer.from(body, 'utf8')));
          (handlers.end || []).forEach((f) => f());
        });
      }
      return req;
    }
  };
  return req;
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      res.ended = true;
    }
  };
  return res;
}

const bodyOf = (res) => {
  try {
    return JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
  } catch {
    return null;
  }
};

async function handlerChecks() {
  const { ctx, routes } = makeCtx();
  registerWebApi(ctx, () => ({}));
  const apiRoute = routes.find((r) => r.path === API_ROUTE);
  check('拿到 API 路由', () => assert.ok(apiRoute));

  // 6a. 域名 Host 必须 403（DNS rebinding 防线）
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ host: 'evil.example.com' }), res);
    check('域名 Host -> 403', () => assert.equal(res.statusCode, 403));
  }
  // 6b. 裸 IPv6 Host 放行（不因冒号被误判成域名）
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ host: '[::1]:43719', url: `${API_ROUTE}?action=nope` }), res);
    check('裸 IPv6 Host 不被 403', () => assert.notEqual(res.statusCode, 403));
  }
  // 6c. 局域网 IP Host 放行
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ host: '192.168.1.9:43719', url: `${API_ROUTE}?action=nope` }), res);
    check('局域网 IP Host 不被 403', () => assert.notEqual(res.statusCode, 403));
  }
  // 6d. 未知 action -> 400
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ url: `${API_ROUTE}?action=nope` }), res);
    check('未知 action -> 400', () => assert.equal(res.statusCode, 400));
    check('未知 action 回 ok:false', () => assert.equal(bodyOf(res)?.ok, false));
  }
  // 6e. 白名单外的工具 -> 403
  for (const bad of ['rm_rf', 'qq_voice_speak', '', 'constructor', '__proto__']) {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({
      method: 'POST', url: API_ROUTE,
      body: JSON.stringify({ tool: bad, args: {} })
    }), res);
    check(`白名单外工具 ${JSON.stringify(bad)} -> 403`, () => assert.equal(res.statusCode, 403));
  }
  // 6f. 405
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ method: 'DELETE', url: API_ROUTE }), res);
    check('DELETE -> 405', () => assert.equal(res.statusCode, 405));
  }
  // 6g. JSON 响应头
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ url: `${API_ROUTE}?action=nope` }), res);
    check('JSON Content-Type', () => assert.match(String(res.headers['Content-Type']), /application\/json/));
    check('no-store', () => assert.equal(res.headers['Cache-Control'], 'no-store'));
    check('Content-Length 是数字', () => assert.equal(typeof res.headers['Content-Length'], 'number'));
  }
  // 6h. 坏 JSON 请求体 -> 500 且回人话
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({ method: 'POST', url: API_ROUTE, body: '{not json' }), res);
    check('坏 JSON -> 500', () => assert.equal(res.statusCode, 500));
    check('坏 JSON 回 ok:false', () => assert.equal(bodyOf(res)?.ok, false));
  }
  // 6i. POST 白名单内的工具能真的跑到 execute（qq_vision_models 纯本地、不花钱）
  {
    const res = fakeRes();
    await apiRoute.handler(fakeReq({
      method: 'POST', url: API_ROUTE,
      body: JSON.stringify({ tool: 'qq_vision_models', args: {} })
    }), res);
    const json = bodyOf(res);
    check('POST models -> 200', () => assert.equal(res.statusCode, 200));
    check('POST models 回 ok:true', () => assert.equal(json?.ok, true));
    check('POST models 带模型表', () => assert.ok(Array.isArray(json?.data?.models) && json.data.models.length > 0));
  }
}

await handlerChecks();

// ── 7. apply() 在只有 tools 的最小 ctx 下也要跑完 ───────────────
{
  const registered = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    logger: { info() {}, error() {}, warn() {} },
    effect(fn) { fn(); }
  };
  let threw = null;
  try {
    apply(ctx, {});
  } catch (error) {
    threw = error;
  }
  check('apply 在无 webServer 时不抛错', () => assert.equal(threw, null));
  check('apply 注册了 7 个工具', () => assert.equal(registered.length, 7));
  check('注册的工具名与白名单一致', () => {
    const names = registered.map((t) => t.name).sort();
    assert.deepEqual(names, [...WEB_TOOL_ALLOW].sort());
  });
  check('每个工具都有 output.schema', () => {
    for (const t of registered) assert.equal(typeof t.output?.schema?.type, 'string');
  });
  check('每个工具都有 execute', () => {
    for (const t of registered) assert.equal(typeof t.execute, 'function');
  });
}

// ── 8. apply() 在带 webServer 的 ctx 下同时挂路由 ───────────────
{
  const { ctx, routes } = makeCtx();
  const registered = [];
  ctx.tools = { register: (t) => registered.push(t) };
  apply(ctx, {});
  check('apply 有 webServer 时注册路由', () => assert.equal(routes.length, 1));
  check('apply 同时注册 7 个工具', () => assert.equal(registered.length, 7));
}

console.log('=== dsh-qq-vision Web 通道单测 ===');
console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('  FAIL')).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
