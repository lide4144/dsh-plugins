/**
 * dsh-tidewatch —— DeepSeek 高峰/低谷时段与账户余额面板（Host 端）。
 *
 * 传输层：注册一条由已鉴权的 `/api` 载体分发的精确路由
 * （`connection.fetch.register`），浏览器同源 POST JSON 即可到达。
 *
 * 为什么不使用 `connection.rpc.handle`：当前构建的 HostConnectionService 以
 * 插件自身 ctx 构造，而该 ctx 的 inject 只有 `['credentials']`，因此
 * rpc.handle 内部访问 `owner.webServer` 时必然抛
 * `cannot get property "webServer" without inject`，路由永远注册不上
 * （HTTP 表现为落到 frontend-static 兜底的 405）。`connection.fetch` 的注册
 * 路径不经过 `owner.webServer`，且同样由 `/api` 载体施加 Host/Origin 校验与
 * 浏览器鉴权，因此是本构建下可用且受保护的选择。若将来宿主修复该注入，
 * 下面的 rpc 分支会自动接管。
 *
 * 端点：
 * - status         当前数据源（模型 provider 或手动 Key）与候选清单；
 * - providers      当前生效模型、已配置 provider 的凭据可用性与余额接口能力；
 * - save-key       保存用户手动输入的 Key（写入 credentials 服务）；
 * - clear-key      删除手动保存的 Key；
 * - fetch-balance  查询账户余额，可选 `provider` 指定数据源。
 *
 * Key 来源按优先级解析：手动保存 → 当前生效模型所属 provider 的 apiKeyEnv
 * → 环境变量 DEEPSEEK_API_KEY。Key 值永不回传浏览器，只回传来源与可用性；
 * 余额请求由 Host 执行 curl，Key 经环境变量传递。
 *
 * 时段判定（高峰/低谷）完全在浏览器半边按本地时钟计算，Host 不参与。
 */
import {
  BALANCE_URL, ENV_REF, KEY_REF, MANUAL_PROVIDER, RPC_CHANNEL,
  clearKey, describeKey, describeProviders, fetchBalance, saveKey,
} from './tide.js'

/** 稳定 Cordis 插件名。 */
const name = 'dsh-tidewatch'
/** 依赖的宿主服务：llm/settings/credentials/shell 均按可选读取，缺失时该能力降级而非整个插件停摆。 */
const inject = []
/** 精确路由路径：必须位于共享 API 通道之下。 */
export const ROUTE_PATH = '/api/dsh-tidewatch'
/** 路由接受的 HTTP 方法。 */
const ROUTE_METHODS = ['POST']

/** 统一成功信封：错误也放在 value.error 内，避免调用方把业务失败当传输失败。 */
function okResult(value) {
  return { ok: true, value }
}

/**
 * 把一个端点请求分发到业务实现。
 * @param ctx - 宿主根上下文。
 * @param endpoint - 端点名。
 * @param payload - JSON 负载。
 * @returns {Promise<object>} 结果对象；失败时含 `error` 字段。
 */
export async function dispatch(ctx, endpoint, payload) {
  const credentials = ctx.get('credentials')
  try {
    switch (endpoint) {
      case 'status':
        return await describeKey(ctx)
      case 'providers':
        return await describeProviders(ctx)
      case 'save-key':
        return await saveKey(credentials, payload)
      case 'clear-key':
        return await clearKey(credentials)
      case 'fetch-balance':
        return await fetchBalance(ctx, payload)
      default:
        return { error: `unknown endpoint ${JSON.stringify(endpoint)}` }
    }
  } catch (error) {
    return { error: (error && error.message) || String(error) }
  }
}

/**
 * 解析一个路由请求的 JSON 负载。
 * @param request - 入站 Fetch 请求。
 * @returns {Promise<{ endpoint: string, payload: object }>} 解析结果。
 */
async function readRequest(request) {
  let body = null
  try {
    body = await request.json()
  } catch (error) {
    body = null
  }
  const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint : ''
  const payload = body && typeof body.payload === 'object' && body.payload !== null ? body.payload : {}
  return { endpoint, payload }
}

/**
 * 插件主体：注册受鉴权的精确路由。
 * @param ctx - 宿主根上下文。
 */
function apply(ctx) {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection === undefined) return

    if (connection.fetch !== undefined) {
      connection.fetch.register({
        path: ROUTE_PATH,
        methods: ROUTE_METHODS,
        requestBody: 'buffered',
        fetch: async (request) => {
          const { endpoint, payload } = await readRequest(request)
          const value = await dispatch(ctx, endpoint, payload)
          return Response.json(okResult(value))
        },
      })
      return
    }

    // 回退：逻辑 RPC 通道。当前构建中它会抛注入错误，故仅在 fetch 面缺席时尝试，
    // 且失败只记录、不影响插件其余部分。
    if (connection.rpc !== undefined) {
      try {
        connection.rpc.handle(
          RPC_CHANNEL,
          async (endpoint, payload) => okResult(await dispatch(ctx, endpoint, payload)),
        )
      } catch (error) {
        console.error('dsh-tidewatch: connection.rpc.handle unavailable:', error)
      }
    }
  })
}

export { BALANCE_URL, ENV_REF, KEY_REF, MANUAL_PROVIDER, apply, inject, name }
