/**
 * dsh-tidewatch Host 端逻辑测试：provider 发现、凭据引用解析与数据源选择。
 *
 * 用最小 mock ctx 驱动 lib/tide.js，不需要真实 harness 进程。
 * 运行：node tests/tide.test.mjs
 */
import assert from 'node:assert/strict'
import { BALANCE_URL, describeProviders, describeKey, fetchBalance } from '../lib/tide.js'

/** 构造一个 mock 宿主上下文：deepseek-official 有 Key，openai 有 Key，anthropic 无 Key。 */
function makeCtx(overrides = {}) {
  const settings = {
    'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    'llm-pi-ai': {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1' },
        anthropic: {},
        'deepseek-byo': { apiKeyEnv: 'BYO_DEEPSEEK_KEY', baseURL: 'https://proxy.example.com/v1' },
      },
    },
  }
  const keys = {
    DEEPSEEK_API_KEY: { value: 'sk-ds', source: 'file' },
    OPENAI_API_KEY: { value: 'sk-oa', source: 'file' },
    BYO_DEEPSEEK_KEY: { value: 'sk-byo', source: 'env' },
  }
  const services = {
    llm: {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: false },
        { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
        { provider: 'deepseek-byo', displayName: 'deepseek-byo', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek-byo'], declared: false },
      ],
    },
    settings: { get: (ns) => settings[ns] },
    credentials: {
      resolve: async (ref) => keys[ref],
      set: async () => {},
      unset: async () => {},
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }),
    },
    shell: {
      resolve: (request) => request,
      run: async () => ({
        stdout: { text: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.00' }] }) + '\n200' },
      }),
    },
  }
  return { get: (name) => (name in overrides ? overrides[name] : services[name]) }
}

// --- 1. provider 发现：只保留有 Key 或当前生效的条目，并正确判定余额能力 ---

{
  const ctx = makeCtx()
  const described = await describeProviders(ctx)
  const ids = described.candidates.map((row) => row.provider).sort()
  assert.deepEqual(ids, ['deepseek-byo', 'deepseek-official', 'openai'],
    '只应保留有 Key（或当前生效）的 provider')

  const ds = described.candidates.find((row) => row.provider === 'deepseek-official')
  assert.equal(ds.hasKey, true)
  assert.equal(ds.active, true)
  assert.equal(ds.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(ds.balanceCapable, true, 'deepseek-official 应支持余额查询')

  const oa = described.candidates.find((row) => row.provider === 'openai')
  assert.equal(oa.hasKey, true)
  assert.equal(oa.balanceCapable, false, 'openai 不应被判定为支持余额查询')

  const byo = described.candidates.find((row) => row.provider === 'deepseek-byo')
  assert.equal(byo.balanceCapable, true, 'baseURL 含 deepseek 的代理应判定为支持')
  assert.equal(byo.keySource, 'env')

  assert.equal(described.active.provider, 'deepseek-official')
  assert.equal(described.selected, 'deepseek-official', '默认应选中当前生效 provider')
  console.log('✓ provider 发现与余额能力判定')
}

// --- 2. 无 Key 的休眠 provider 被过滤掉（防噪） ---

{
  const ctx = makeCtx()
  const described = await describeProviders(ctx)
  assert.equal(described.candidates.some((row) => row.provider === 'anthropic'), false,
    'anthropic 未配置 apiKeyEnv，应被过滤')
  console.log('✓ 休眠 provider 过滤')
}

// --- 3. 手动 Key 优先，且被标记为候选 ---

{
  const ctx = makeCtx({
    credentials: {
      resolve: async (ref) => (ref === 'DSH_PLUGIN_DEEPSEEK_KEY'
        ? { value: 'sk-manual', source: 'file' }
        : ref === 'DEEPSEEK_API_KEY'
          ? { value: 'sk-ds', source: 'file' }
          : undefined),
      set: async () => {},
      unset: async () => {},
    },
  })
  const described = await describeProviders(ctx)
  assert.equal(described.selected, 'manual', '存在手动 Key 时应优先使用')
  const manual = described.candidates.find((row) => row.provider === 'manual')
  assert.equal(manual.hasKey, true)
  assert.equal(manual.keyRef, 'DSH_PLUGIN_DEEPSEEK_KEY')
  console.log('✓ 手动 Key 优先级')
}

// --- 4. 余额查询：默认走当前生效 provider，并把元数据一并带回 ---

{
  const ctx = makeCtx()
  const result = await fetchBalance(ctx, {})
  assert.equal(result.configured, true)
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.displayName, 'DeepSeek')
  assert.equal(result.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(result.httpStatus, 200)
  assert.equal(result.balance.balance_infos[0].total_balance, '42.00')
  assert.equal(result.error, undefined)
  console.log('✓ 余额查询（provider 自动取用）')
}

// --- 5. 非余额能力 provider：给出明确错误而不是发一次必失败的请求 ---

{
  const ctx = makeCtx()
  const result = await fetchBalance(ctx, { provider: 'openai' })
  assert.match(result.error, /未提供公开的余额接口/)
  console.log('✓ 非余额能力 provider 的明确提示')
}

// --- 6. 显式选择 provider 时使用其 baseURL 推导的余额端点 ---

{
  let seenCommand = null
  const ctx = makeCtx({
    shell: {
      resolve: (request) => request,
      run: async (spec) => {
        seenCommand = spec.command
        return { stdout: { text: '{"is_available":true,"balance_infos":[]}\n200' } }
      },
    },
  })
  const result = await fetchBalance(ctx, { provider: 'deepseek-byo' })
  assert.equal(result.provider, 'deepseek-byo')
  assert.match(seenCommand, /https:\/\/proxy\.example\.com\/v1\/user\/balance/, '应按 baseURL 推导端点')
  console.log('✓ baseURL 推导余额端点')
}

// --- 7. 完全无凭据时回落到官方端点语义（无 Key → 不查询） ---

{
  const ctx = makeCtx({
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
  })
  const described = await describeKey(ctx)
  assert.equal(described.configured, false)
  const result = await fetchBalance(ctx, {})
  assert.equal(result.configured, false)
  assert.match(result.error, /未找到任何可用的 API Key|未提供公开的余额接口/)
  console.log('✓ 无凭据时的降级')
}

// --- 8. 官方端点常量未被 baseURL 逻辑污染 ---

assert.equal(BALANCE_URL, 'https://api.deepseek.com/user/balance')

console.log('\n全部通过 ✅')
