/**
 * dsh-qq-vision —— 设置页「QQ 识图」面板 + 插件页配置（Client 半边）。
 *
 * 数据全走 host 侧的一条路由：/dsh-qq-vision-api
 *   GET  ?action=status|config|models|usage|selftest
 *   POST { tool, args }   → 转发给同名工具（白名单在 host 侧）
 *
 * 这里**不重复实现业务逻辑**：所有写操作都转发给 qq_vision_config 工具，
 * 界面能做的事 = 工具能做的事。改配置的备份、字段过滤、bridgeRoot 校验
 * 只有 host 那一份实现，界面不另开旁路。
 *
 * 注册 id 必须等于 loader entry 名（dsh-qq-vision），否则 ModuleLoader 报
 * "loaded without registering dsh-qq-vision"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-vision',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const API = '/dsh-qq-vision-api';

    // ── 数据层 ────────────────────────────────────────────────────

    async function apiGet(action, params) {
      const qs = new URLSearchParams({ action });
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const res = await fetch(`${API}?${qs.toString()}`);
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    }

    async function apiCall(tool, args) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args: args || {} })
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
      return json;
    }

    // ── 小部件 ────────────────────────────────────────────────────

    function Row(props) {
      return h('div', { className: 'qqz-row' }, props.children);
    }

    function Field(props) {
      return h('label', { className: 'qqz-field' },
        h('span', { className: 'qqz-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'qqz-hint' }, props.hint) : null
      );
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'qqz-switch' + (props.checked ? ' on' : ''),
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        disabled: props.disabled,
        onClick: () => props.onChange(!props.checked)
      }, h('span', { className: 'qqz-switch-dot' }));
    }

    function Badge(props) {
      return h('span', { className: 'qqz-badge' + (props.tone ? ' ' + props.tone : '') }, props.children);
    }

    function Banner(props) {
      if (!props.text) return null;
      return h('div', { className: 'qqz-banner ' + (props.tone || 'info') }, props.text);
    }

    function KV(props) {
      return h('div', null,
        h('span', { className: 'qqz-k' }, props.k),
        h('span', { className: 'qqz-v' }, props.v === undefined || props.v === null || props.v === '' ? '—' : props.v)
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────

    function VisionPanel() {
      const [status, setStatus] = useState(null);
      const [config, setConfig] = useState(null);
      const [models, setModels] = useState([]);
      const [usage, setUsage] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [selftest, setSelftest] = useState(null);

      // 识图测试区
      const [probePath, setProbePath] = useState('');
      const [probePrompt, setProbePrompt] = useState('');
      const [probeResult, setProbeResult] = useState(null);

      const fail = (e) => setError(e?.message || String(e));
      const clear = () => { setError(''); setNotice(''); };

      const loadStatus = useCallback(async () => {
        setBusy((b) => b || 'status');
        try {
          const s = await apiGet('status');
          setStatus(s.data || {});
        } catch (e) { fail(e); } finally { setBusy((b) => (b === 'status' ? '' : b)); }
      }, []);

      const loadConfig = useCallback(async () => {
        try {
          const c = await apiGet('config');
          setConfig(c.data || {});
        } catch (e) { fail(e); }
      }, []);

      const loadModels = useCallback(async () => {
        try {
          const m = await apiGet('models');
          setModels(Array.isArray(m.data?.models) ? m.data.models : []);
        } catch (e) { fail(e); }
      }, []);

      const loadUsage = useCallback(async () => {
        try {
          const u = await apiGet('usage', { limit: 20 });
          setUsage(u.data || {});
        } catch (e) { fail(e); }
      }, []);

      useEffect(() => {
        loadStatus(); loadConfig(); loadModels(); loadUsage();
      }, [loadStatus, loadConfig, loadModels, loadUsage]);

      // ── 动作 ──

      const saveConfig = async (patch, label) => {
        clear();
        setBusy('config');
        try {
          const r = await apiCall('qq_vision_config', { action: 'set', ...patch });
          setNotice(`${label}已保存${r.data?.backupFile ? '，改前备份在插件目录 usage-backup/' : ''}`);
          loadConfig(); loadStatus();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      const doSelftest = async (paid) => {
        clear();
        setBusy('selftest');
        try {
          const r = await apiGet('selftest', { paid: paid ? 1 : 0 });
          setSelftest(r.data || {});
          setNotice(r.summary || '自检完成');
          loadUsage();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      const doProbe = async () => {
        clear();
        if (!probePath.trim()) { setError('请先填图片的绝对路径'); return; }
        setBusy('probe');
        try {
          const args = { path: probePath.trim() };
          if (probePrompt.trim()) args.prompt = probePrompt.trim();
          const r = await apiCall('qq_vision_describe_file', args);
          setProbeResult(r.data || null);
          setNotice(r.summary || '识图完成');
          loadUsage();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      const doClearUsage = async () => {
        clear();
        setBusy('usage');
        try {
          const r = await apiCall('qq_vision_usage', { clear: true });
          setNotice(r.summary || '账本已清空');
          loadUsage();
        } catch (e) { fail(e); } finally { setBusy(''); }
      };

      // ── 渲染 ──

      const bridge = status?.bridge || {};
      const vision = status?.vision || {};
      const ocr = status?.ocr || {};
      const cfg = config || {};
      const busyAny = Boolean(busy);

      const visionOn = vision.enabled === true || cfg.visionEnabled === true;
      const currentModel = cfg.visionModel || vision.model || '';
      const priceOf = (id) => cfg.prices?.[id] || null;

      // 后端：workbuddy 用 vault 里的 token，百炼用 key —— 界面上要分开说，
      // 否则用户会盯着"key 为空"以为坏了。
      const provider = cfg.visionProvider || vision.provider || 'workbuddy';
      const isWb = provider === 'workbuddy';
      const providerLabel = isWb ? 'WorkBuddy' : '百炼';
      const wb = vision.workbuddy || cfg.workbuddy || null;
      const wbUsable = models.filter((m) => (m.provider || 'bailian') === provider);

      return h('div', { className: 'qqz-panel' },

        h(Banner, { text: error, tone: 'error' }),
        h(Banner, { text: notice, tone: 'ok' }),

        // ── 链路状态 ──
        h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' },
            h('strong', null, '识图链路'),
            h(Row, null,
              h(Badge, { tone: bridge.connected ? 'ok' : 'error' },
                bridge.connected ? '桥接在线' : '桥接离线'),
              h(Badge, { tone: visionOn ? 'ok' : undefined },
                visionOn ? `视觉开启（${providerLabel}，计费）` : '只走免费 OCR'),
              h(Badge, { tone: ocr.exists ? (ocr.bom ? 'ok' : 'error') : 'error' },
                ocr.exists ? (ocr.bom ? 'OCR 就绪' : 'OCR BOM 缺失') : 'OCR 缺失'),
              h('button', { type: 'button', onClick: () => { loadStatus(); loadConfig(); loadModels(); }, disabled: busyAny }, '刷新')
            )
          ),
          h('div', { className: 'qqz-grid' },
            h(KV, { k: '桥接地址', v: bridge.baseUrl }),
            h(KV, { k: '桥接根目录', v: bridge.root }),
            h(KV, { k: '令牌来源', v: bridge.tokenSource }),
            h(KV, { k: '视觉后端', v: `${providerLabel}${vision.baseUrl ? ' · ' + vision.baseUrl : ''}` }),
            h(KV, { k: '当前模型', v: currentModel }),
            isWb
              ? h(KV, { k: '凭据', v: wb?.ok
                ? `vault ${wb.region || '?'} 区 · ${wb.nickname || wb.uid || ''} · ${wb.expired ? '已过期' : wb.nearExpiry ? '快过期' : '有效'}`
                : `vault 不可用（${wb?.error || '未读取'}）` })
              : h(KV, { k: 'key 来源', v: vision.apiKeyVia || vision.apiKeyEnv }),
            isWb ? null : h(KV, { k: 'key', v: vision.apiKey }),
            h(KV, { k: '计费', v: vision.billing }),
            h(KV, { k: 'OCR 脚本', v: ocr.script })
          ),
          bridge.error ? h('div', { className: 'qqz-warn' }, `桥接读取提示：${bridge.error}`) : null
        ),

        // ── 视觉开关与模型 ──
        h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' },
            h('strong', null, '视觉模型'),
            h(Row, null,
              h(Badge, { tone: visionOn ? 'ok' : undefined }, visionOn ? '会花钱' : '零花费')
            )
          ),
          h(Row, null,
            h(Field, { label: '付费视觉总开关', hint: '关着只走系统 OCR（离线、免费）' },
              h(Switch, {
                checked: visionOn,
                disabled: busyAny,
                onChange: (v) => saveConfig({ visionEnabled: v }, '视觉总开关')
              })
            ),
            h(Field, { label: '视觉后端', hint: 'workbuddy=腾讯网关（按 credit，促销期几乎免费）；bailian=阿里百炼' },
              h('select', {
                value: provider,
                disabled: busyAny,
                onChange: (e) => saveConfig({ visionProvider: e.target.value }, '视觉后端')
              },
                h('option', { value: 'workbuddy' }, 'WorkBuddy（deepseek-v4.1-flash）'),
                h('option', { value: 'bailian' }, '百炼 DashScope（qwen 系列）')
              )
            ),
            h(Field, { label: '默认模型', hint: '改完立刻生效，不用重启' },
              h('select', {
                value: currentModel,
                disabled: busyAny,
                onChange: (e) => saveConfig({ visionModel: e.target.value }, '默认模型')
              },
                wbUsable.length === 0
                  ? h('option', { value: currentModel }, currentModel || '（读不到模型表）')
                  : wbUsable.map((m) => h('option', { key: m.id, value: m.id },
                    `${m.id}${m.id === currentModel ? '（当前）' : ''} · ${m.label || ''}`))
              )
            )
          ),
          models.length === 0 ? null : h('div', { className: 'qqz-models' },
            models.map((m) => {
              const on = m.id === currentModel;
              const usable = (m.provider || 'bailian') === provider;
              const p = priceOf(m.id);
              const meas = m.measured || {};
              return h('div', { key: m.id, className: 'qqz-model' + (on ? ' on' : '') },
                h('div', { className: 'qqz-model-main' },
                  h('span', { className: 'qqz-model-id' }, m.id, on ? h(Badge, { tone: 'ok' }, '当前') : null,
                    usable ? null : h(Badge, null, m.provider === 'workbuddy' ? 'WorkBuddy' : '百炼')),
                  h('span', { className: 'qqz-model-meta' },
                    [
                      m.label || null,
                      m.strength || null
                    ].filter(Boolean).join(' · ') || '—'
                  ),
                  h('span', { className: 'qqz-model-meta' },
                    [
                      meas.total ? `${meas.total} tok` : null,
                      meas.ms ? `${meas.ms}ms` : null,
                      meas.prompt !== undefined ? `in ${meas.prompt} / out ${meas.completion}` : null,
                      meas.credit ? `${meas.credit} credit` : null
                    ].filter(Boolean).join(' · ') || '本机未实测'
                  ),
                  m.note ? h('span', { className: 'qqz-model-note' }, m.note) : null
                ),
                h('div', { className: 'qqz-model-act' },
                  h('span', { className: 'qqz-model-price' },
                    m.provider === 'workbuddy' ? '按 credit 计' : (p ? `¥${p.in ?? '?'}/M in · ¥${p.out ?? '?'}/M out` : '单价未配')),
                  on ? null : h('button', {
                    type: 'button', disabled: busyAny,
                    onClick: () => saveConfig(usable
                      ? { visionModel: m.id }
                      : { visionProvider: m.provider || 'bailian', visionModel: m.id },
                    `默认模型（${m.id}）`)
                  }, usable ? '设为默认' : '切到该后端')
                )
              );
            })
          )
        ),

        // ── 后端与凭据 ──
        h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' }, h('strong', null, '后端与凭据')),
          isWb
            ? h(Row, null,
                h(Field, { label: 'WorkBuddy 凭据库', hint: '默认 ~/.dsh/workbuddy-vault，下面有 cn/ 与 global/' },
                  h('input', {
                    type: 'text', defaultValue: cfg.visionVault || '',
                    style: { minWidth: '300px' },
                    placeholder: 'C:\\Users\\<你>\\.dsh\\workbuddy-vault',
                    onBlur: (e) => {
                      const v = e.target.value.trim();
                      if (v !== (cfg.visionVault || '')) saveConfig({ visionVault: v }, '凭据库目录');
                    }
                  })
                ),
                h(Field, { label: '账号区', hint: '留空 = 自动挑刷新时间最新的那个' },
                  h('select', {
                    value: cfg.visionRegion || '',
                    disabled: busyAny,
                    onChange: (e) => saveConfig({ visionRegion: e.target.value }, '账号区')
                  },
                    h('option', { value: '' }, '自动'),
                    h('option', { value: 'cn' }, 'cn（国内 copilot.tencent.com）'),
                    h('option', { value: 'global' }, 'global（国际 workbuddy.ai）')
                  )
                )
              )
            : null,
          isWb ? null : h(Row, null,
            h(Field, { label: '视觉后端根地址', hint: 'OpenAI 兼容，含 /v1' },
              h('input', {
                type: 'text', defaultValue: cfg.visionBaseUrl || '',
                style: { minWidth: '300px' },
                placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                onBlur: (e) => {
                  const v = e.target.value.trim();
                  if (v !== (cfg.visionBaseUrl || '')) saveConfig({ visionBaseUrl: v }, '视觉后端地址');
                }
              })
            ),
            h(Field, { label: 'key 环境变量名', hint: '环境变量没有时去 ~/.dsh/.credentials.yaml 的 refs 段找' },
              h('input', {
                type: 'text', defaultValue: cfg.visionApiKeyEnv || '',
                style: { minWidth: '200px' },
                placeholder: 'BAILIAN_API_KEY',
                onBlur: (e) => {
                  const v = e.target.value.trim();
                  if (v !== (cfg.visionApiKeyEnv || '')) saveConfig({ visionApiKeyEnv: v }, 'key 来源');
                }
              })
            )
          ),
          h(Row, null,
            isWb ? null : h(Field, { label: 'key 明文覆盖', hint: '一般不用填；填了会写进 runtime.json' },
              h('input', {
                type: 'password', placeholder: '留空 = 按上面那个名字去找',
                style: { minWidth: '260px' },
                onBlur: (e) => {
                  const v = e.target.value.trim();
                  if (v) { saveConfig({ visionApiKey: v }, 'key 明文'); e.target.value = ''; }
                }
              })
            ),
            h(Field, { label: '单价 in（元/百万 tok）', hint: '配了账本才折成金额' },
              h('input', {
                type: 'number', step: '0.01', min: '0',
                defaultValue: priceOf(currentModel)?.in ?? '',
                onBlur: (e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && e.target.value !== '' && v !== priceOf(currentModel)?.in) {
                    saveConfig({ priceIn: v }, '输入单价');
                  }
                }
              })
            ),
            h(Field, { label: '单价 out（元/百万 tok）' },
              h('input', {
                type: 'number', step: '0.01', min: '0',
                defaultValue: priceOf(currentModel)?.out ?? '',
                onBlur: (e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && e.target.value !== '' && v !== priceOf(currentModel)?.out) {
                    saveConfig({ priceOut: v }, '输出单价');
                  }
                }
              })
            )
          ),
          h('div', { className: 'qqz-hint' },
            '这里改的是插件自己的 runtime.json，改完立刻生效、不用重启 DSH。每次保存都会在插件目录 usage-backup/ 留一份改前备份。')
        ),

        // ── 识图测试 ──
        h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' }, h('strong', null, '识图测试')),
          h('textarea', {
            className: 'qqz-textarea',
            rows: 2,
            placeholder: '自定义提问（留空用默认：描述画面 + 抄写文字 + 判断是不是表情包）',
            value: probePrompt,
            onChange: (e) => setProbePrompt(e.target.value)
          }),
          h(Row, null,
            h(Field, { label: '图片绝对路径', hint: 'png / jpg / webp / gif / bmp' },
              h('input', {
                type: 'text', placeholder: 'E:\\dsh-qq\\state\\_vision-test.png',
                style: { minWidth: '360px' },
                value: probePath,
                onChange: (e) => setProbePath(e.target.value)
              })
            ),
            h('button', { type: 'button', className: 'qqz-btn qqz-btn-primary', onClick: doProbe, disabled: busyAny },
              busy === 'probe' ? '识图中…' : '识图'),
            h('button', { type: 'button', className: 'qqz-btn', onClick: () => doSelftest(false), disabled: busyAny },
              busy === 'selftest' ? '自检中…' : '五层自检（不花钱）'),
            visionOn ? h('button', { type: 'button', className: 'qqz-btn', onClick: () => doSelftest(true), disabled: busyAny },
              '五层自检（真花钱）') : null
          ),
          probeResult ? h('div', { className: 'qqz-result' },
            h('div', { className: 'qqz-result-head' },
              h(Badge, { tone: probeResult.ok ? 'ok' : 'error' }, probeResult.ok ? '识别成功' : '识别失败'),
              h('span', { className: 'qqz-model-meta' },
                [
                  probeResult.mode ? `模式 ${probeResult.mode}` : null,
                  probeResult.lang ? `语言 ${probeResult.lang}` : null,
                  probeResult.ms ? `${probeResult.ms}ms` : null,
                  probeResult.billing?.totalTokens ? `${probeResult.billing.totalTokens} tok` : null
                ].filter(Boolean).join(' · ') || '—'
              )
            ),
            probeResult.error ? h('div', { className: 'qqz-warn' }, probeResult.error) : null,
            h('pre', { className: 'qqz-pre' }, probeResult.text || '（空）')
          ) : null
        ),

        // ── 自检结果 ──
        selftest ? h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' },
            h('strong', null, '五层自检'),
            h(Badge, { tone: selftest.ok ? 'ok' : 'error' }, selftest.ok ? '全通过' : '有失败'),
            selftest.billed ? h(Badge, { tone: 'ok' }, '本次真花了钱') : h(Badge, null, '没花钱')
          ),
          h('div', { className: 'qqz-layers' },
            (selftest.layers || []).map((line, i) => h('div', { key: i, className: 'qqz-layer' }, String(line)))
          )
        ) : null,

        // ── 账本 ──
        h('div', { className: 'qqz-card' },
          h('div', { className: 'qqz-card-head' },
            h('strong', null, `账单（共 ${usage?.total ?? 0} 条）`),
            h(Row, null,
              h('button', { type: 'button', onClick: loadUsage, disabled: busyAny }, '刷新'),
              h('button', { type: 'button', onClick: doClearUsage, disabled: busyAny || !(usage?.total > 0) }, '清空账本')
            )
          ),
          usage && usage.total > 0
            ? h('div', { className: 'qqz-usage-head' },
              h('span', null, `合计 ${usage.sumTokens ?? 0} tokens`),
              usage.sumCost !== null && usage.sumCost !== undefined
                ? h('span', null, `约 ¥${Number(usage.sumCost).toFixed(6)}`)
                : h('span', null, '单价未配置，不计金额')
            )
            : h('div', { className: 'qqz-empty' }, '账本是空的：只在真正调用付费视觉模型时才会记一条。'),
          usage && usage.total > 0
            ? h('div', { className: 'qqz-list' },
              (usage.rows || []).slice(0, 20).map((r, i) => h('div', { key: i, className: 'qqz-usage-row' },
                h('span', { className: 'qqz-model-meta' }, r.at || '—'),
                h('span', { className: 'qqz-model-meta' }, r.model || '—'),
                h('span', { className: 'qqz-model-meta' },
                  `${r.promptTokens ?? 0} in / ${r.completionTokens ?? 0} out / ${r.totalTokens ?? 0} tok`),
                h('span', { className: 'qqz-model-meta' },
                  r.cost !== null && r.cost !== undefined ? `¥${Number(r.cost).toFixed(6)}` : '—')
              ))
            )
            : null,
          h('div', { className: 'qqz-hint' }, `账本文件：${cfg.usageFile || '—'}`)
        ),

        busyAny ? h('div', { className: 'qqz-busy' }, '处理中…') : null
      );
    }

    // ── 样式 ──────────────────────────────────────────────────────

    const CSS = `
.qqz-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.qqz-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
.qqz-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qqz-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.qqz-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.qqz-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em}
.qqz-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.qqz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 14px}
.qqz-grid>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.qqz-k{font-size:11px;color:var(--dsw-alias-label-secondary)}
.qqz-v{font-size:12px;overflow-wrap:anywhere}
.qqz-warn{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px}
.qqz-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.qqz-badge.ok{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.qqz-badge.error{color:#e5484d;border-color:#e5484d}
.qqz-banner{border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.5}
.qqz-banner.error{background:color-mix(in srgb,#e5484d 14%,transparent);border:1px solid #e5484d}
.qqz-banner.ok{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border:1px solid var(--dsw-alias-brand-primary)}
.qqz-banner.info{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.qqz-textarea{width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;font-size:13px;line-height:1.6;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;outline:none}
.qqz-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.qqz-panel input[type=text],.qqz-panel input[type=number],.qqz-panel input[type=password],.qqz-panel select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:12px;outline:none;min-width:110px}
.qqz-panel input:focus,.qqz-panel select:focus{border-color:var(--dsw-alias-brand-primary)}
.qqz-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;transition:border-color .12s ease}
.qqz-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.qqz-btn:disabled{opacity:.5;cursor:default}
.qqz-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.qqz-switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);border:none;cursor:pointer;padding:0;transition:background .15s ease;flex:none}
.qqz-switch.on{background:var(--dsw-alias-brand-primary)}
.qqz-switch:disabled{opacity:.5;cursor:default}
.qqz-switch-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease}
.qqz-switch.on .qqz-switch-dot{transform:translateX(16px)}
.qqz-models{display:flex;flex-direction:column;gap:6px}
.qqz-model{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid transparent}
.qqz-model:hover{background:var(--dsw-alias-bg-layer-2)}
.qqz-model.on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.qqz-model-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.qqz-model-id{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}
.qqz-model-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.qqz-model-note{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.qqz-model-act{display:flex;align-items:center;gap:8px;flex:none}
.qqz-model-price{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.qqz-model-act button{background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 9px;font-size:11px;color:var(--dsw-alias-label-primary);cursor:pointer}
.qqz-model-act button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.qqz-model-act button:disabled{opacity:.5;cursor:default}
.qqz-result{display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px}
.qqz-result-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.qqz-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;font-size:12px;line-height:1.6;max-height:260px;overflow:auto}
.qqz-layers{display:flex;flex-direction:column;gap:3px}
.qqz-layer{font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.qqz-usage-head{display:flex;gap:16px;flex-wrap:wrap;font-size:12px}
.qqz-list{display:flex;flex-direction:column;gap:3px;max-height:280px;overflow:auto}
.qqz-usage-row{display:flex;gap:12px;flex-wrap:wrap;padding:4px 8px;border-radius:6px;font-size:11px}
.qqz-usage-row:hover{background:var(--dsw-alias-bg-layer-2)}
.qqz-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0}
.qqz-busy{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center;padding:2px 0}
`;

    // ── 插件装配 ──────────────────────────────────────────────────

    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      // 样式标签挂 ctx.effect：插件卸载 / 热重载时自动摘掉，不留孤儿规则。
      ctx.effect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-plugin', 'dsh-qq-vision');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => { el.remove(); };
      }, 'dsh-qq-vision: panel styles');

      // 设置页一个「QQ 识图」页。order 37：排在「QQ 语音」(35) 之后，
      // 系统自带那几项（account -10 / general 0 / models 10）之后，不抢位置。
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'qq-vision',
        order: 37,
        label: 'QQ 识图'
      }, () => h(VisionPanel, null)));

      // 插件自己的页面里也挂一份：用户从「插件」列表点进来就能直接用，
      // 不必先知道要去设置页找。key 必须是包名。
      slots.inject('plugins.bundle.config', () => slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-qq-vision'
      }, () => h(VisionPanel, null)));
    }

    return {
      inject: ['slots'],
      apply
    };
  }
});
