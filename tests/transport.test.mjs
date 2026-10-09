/**
 * dsh-tidewatch 传输层测试：受鉴权路由注册、请求分发与 rpc 回退。
 *
 * apply() 只依赖 ctx.get / ctx.inject，因此可用最小 fake ctx 直接驱动，
 * 不需要真实 harness 进程。运行：node tests/transport.test.mjs
 */
import assert from 'node:assert/strict'
import { ROUTE_PATH, apply } from '../lib/index.js'

/** 构造一个最小宿主上下文；services.connection 决定走哪条传输分支。 */
function makeCtx(services) {
  return {
    get: (name) => services[name],
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['connection'], 'apply 必须只注入 connection')
      callback({ connection: services.connection })
    },
  }
}

/** 一个能解析出凭据、可查余额的服务集合。 */
function baseServices(overrides = {}) {
  const services = {
    llm: {
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
    },
    settings: { get: () => ({ apiKeyEnv: 'DEEPSEEK_API_KEY' }) },
    credentials: {
      resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-live', source: 'file' } : undefined),
      set: async () => {},
      unset: async () => {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }) },
    shell: {
      resolve: (request) => request,
      run: async () => ({
        stdout: { text: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7.00' }] }) + '\n200' },
      }),
    },
    ...overrides,
  }
  return services
}

/** 用 route 处理一个请求，返回解包后的 JSON。 */
async function callRoute(route, endpoint, payload) {
  const request = new Request('http://127.0.0.1:3080' + ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload || {} }),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 200)
  return response.json()
}

// --- 1. 注册的是 /api 下的 POST 精确路由 ---

{
  let route = null
  const connection = { fetch: { register: (registered) => { route = registered; return async () => {} } } }
  apply(makeCtx(baseServices({ connection })))
  assert.equal(route.path, ROUTE_PATH, '路由必须位于 /api 之下，才能由已鉴权载体分发')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  console.log('✓ 注册 /api 精确 POST 路由')
}

// --- 2. status 端到端返回当前模型与数据源 ---

{
  let route = null
  const connection = { fetch: { register: (registered) => { route = registered; return async () => {} } } }
  apply(makeCtx(baseServices({ connection })))
  const body = await callRoute(route, 'status')
  assert.equal(body.ok, true)
  assert.equal(body.value.active.provider, 'deepseek-official')
  assert.equal(body.value.selected, 'deepseek-official', '默认数据源应为当前生效 provider')
  const candidate = body.value.candidates.find((row) => row.provider === 'deepseek-official')
  assert.equal(candidate.hasKey, true)
  assert.equal(candidate.keyRef, 'DEEPSEEK_API_KEY')
  assert.equal(JSON.stringify(body).includes('sk-live'), false, 'Key 值绝不能回传浏览器')
  console.log('✓ status 返回模型/数据源且不泄漏 Key')
}

// --- 3. fetch-balance 端到端 ---

{
  let route = null
  const connection = { fetch: { register: (registered) => { route = registered; return async () => {} } } }
  apply(makeCtx(baseServices({ connection })))
  const body = await callRoute(route, 'fetch-balance')
  assert.equal(body.ok, true)
  assert.equal(body.value.balance.balance_infos[0].total_balance, '7.00')
  assert.equal(body.value.displayName, 'DeepSeek')
  console.log('✓ fetch-balance 端到端')
}

// --- 4. 未知端点与畸形请求体都被吸收为可读结果，不抛给载体 ---

{
  let route = null
  const connection = { fetch: { register: (registered) => { route = registered; return async () => {} } } }
  apply(makeCtx(baseServices({ connection })))
  const unknown = await callRoute(route, 'nope')
  assert.match(unknown.value.error, /unknown endpoint/)
  const malformed = await route.fetch(new Request('http://127.0.0.1:3080' + ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  assert.equal(malformed.status, 200, '畸形请求体也必须返回结构化信封而非 5xx')
  const malformedBody = await malformed.json()
  assert.match(malformedBody.value.error, /unknown endpoint/)
  console.log('✓ 未知端点与畸形请求体被吸收')
}

// --- 5. 业务异常被收敛进信封 ---

{
  let route = null
  const connection = { fetch: { register: (registered) => { route = registered; return async () => {} } } }
  apply(makeCtx(baseServices({
    connection,
    credentials: { resolve: async () => { throw new Error('credentials offline') } },
  })))
  const body = await callRoute(route, 'status')
  assert.equal(body.ok, true, '业务异常不应变成传输失败')
  assert.equal(body.value.configured, false, '凭据服务异常时按未配置降级')
  console.log('✓ 业务异常收敛进信封')
}

// --- 6. fetch 面缺席时回退到 rpc 通道，且 rpc 抛错不影响加载 ---

{
  const handled = []
  const connection = {
    rpc: { handle: (channel, handler) => { handled.push({ channel, handler }); return async () => {} } },
  }
  apply(makeCtx(baseServices({ connection })))
  assert.equal(handled.length, 1)
  assert.equal(handled[0].channel, '/dsh-tidewatch')
  const envelope = await handled[0].handler('status', {})
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.active.provider, 'deepseek-official')
  console.log('✓ fetch 缺席时回退 rpc 通道')
}

{
  const connection = {
    rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } },
  }
  apply(makeCtx(baseServices({ connection })))
  console.log('✓ rpc.handle 抛错时被容纳（不使插件加载失败）')
}

console.log('\n全部通过 ✅')
