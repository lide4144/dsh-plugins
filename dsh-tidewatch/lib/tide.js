/**
 * dsh-tidewatch Host 端业务实现：模型提供商发现、API Key 解析与余额查询。
 *
 * Key 的解析优先级（全部由 Host 完成，Key 值永不回传浏览器）：
 * 1. 用户在面板里显式保存的 Key（credentials ref `DSH_PLUGIN_DEEPSEEK_KEY`）；
 * 2. 当前生效模型所属 provider 的凭据引用 —— 即该 provider 在 settings 中的
 *    `apiKeyEnv`（credential-ref 字段），经 credentials 服务解析；
 * 3. 兼容回退：`DEEPSEEK_API_KEY`。
 *
 * provider 目录来自 `ctx.llm.listConfigurableProviders()`，每个条目给出
 * `settingsNs` + `settingsPath`，两者共同定位该 provider 的配置对象；
 * `apiKeyEnv` 与 `baseURL` 都从该配置对象里读，因此新增 provider 无需改代码。
 *
 * 余额接口只有 DeepSeek 系提供（`<baseURL>/user/balance`），其余 provider
 * 会被标记为 balanceCapable=false，面板据此给出明确提示而不是发一次必失败的请求。
 */

/** 插件自有凭据引用（用户手动保存的 Key 存于此，优先级最高）。 */
export const KEY_REF = 'DSH_PLUGIN_DEEPSEEK_KEY'
/** 兼容回退的环境变量引用。 */
export const ENV_REF = 'DEEPSEEK_API_KEY'
/** DeepSeek 官方余额端点。 */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
/** 余额端点相对 baseURL 的路径。 */
const BALANCE_PATH = '/user/balance'
/** 浏览器半边与本插件共享的 loopback RPC 通道。 */
export const RPC_CHANNEL = '/dsh-tidewatch'
/** 「手动输入」在 provider 选择中的伪 id。 */
export const MANUAL_PROVIDER = 'manual'

/**
 * 沿 settingsPath 读取一个 provider 的配置对象。
 * @param settings - 宿主 settings 服务，可能缺席。
 * @param entry - provider 目录条目（含 settingsNs 与 settingsPath）。
 * @returns {object|null} 配置对象，或 null 表示不可读。
 */
function readProviderConfig(settings, entry) {
  if (!settings || typeof settings.get !== 'function') return null
  const ns = entry && entry.settingsNs
  if (typeof ns !== 'string' || ns.length === 0) return null
  let value
  try {
    value = settings.get(ns)
  } catch (error) {
    return null
  }
  const path = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return null
    value = value[segment]
  }
  return value !== null && typeof value === 'object' ? value : null
}

/**
 * 该 provider 是否具备公开余额接口。
 * 判据是 provider id / settings 命名空间 / baseURL 里出现 deepseek——
 * 只有 DeepSeek 系提供 /user/balance。
 */
function isBalanceCapable(providerId, settingsNs, baseURL) {
  const haystack = `${String(providerId)} ${String(settingsNs)} ${String(baseURL || '')}`.toLowerCase()
  return haystack.includes('deepseek')
}

/** 由 provider 的 baseURL 推导余额端点（缺省回落到官方端点）。 */
function balanceUrlFor(baseURL) {
  if (typeof baseURL === 'string' && baseURL.length > 0) {
    return baseURL.replace(/\/+$/, '') + BALANCE_PATH
  }
  return BALANCE_URL
}

/**
 * 读取当前生效的模型选择。
 * @param ctx - 宿主上下文。
 * @returns {{ provider: string, model: string | null } | null} 当前 provider 与模型。
 */
function activeSelection(ctx) {
  const defaultModel = ctx.get('agentDefaultModel')
  if (!defaultModel || typeof defaultModel.currentSelection !== 'function') return null
  try {
    const selection = defaultModel.currentSelection()
    if (!selection || typeof selection.provider !== 'string') return null
    return {
      provider: selection.provider,
      model: typeof selection.model === 'string' ? selection.model : null,
    }
  } catch (error) {
    return null
  }
}

/**
 * 遍历 provider 目录，解析每个条目的凭据引用。
 * @param ctx - 宿主上下文。
 * @returns {Promise<Array<object>>} 含 Key 值的内部条目（不得直接回传浏览器）。
 */
async function scanProviders(ctx) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  if (!llm || typeof llm.listConfigurableProviders !== 'function') return []

  let entries = []
  try {
    entries = llm.listConfigurableProviders() || []
  } catch (error) {
    return []
  }

  const rows = []
  for (const entry of entries) {
    if (!entry || typeof entry.provider !== 'string') continue
    const config = readProviderConfig(settings, entry)
    const apiKeyEnv = config && typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : null
    const baseURL = config && typeof config.baseURL === 'string' ? config.baseURL : null

    let key = null
    let source = null
    if (credentials && apiKeyEnv) {
      try {
        const resolved = await credentials.resolve(apiKeyEnv)
        if (resolved) {
          key = resolved.value
          source = resolved.source
        }
      } catch (error) {
        key = null
      }
    }

    rows.push({
      provider: entry.provider,
      displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : entry.provider,
      declared: entry.declared !== false,
      keyRef: apiKeyEnv,
      key,
      source,
      balanceUrl: balanceUrlFor(baseURL),
      balanceCapable: isBalanceCapable(entry.provider, entry.settingsNs, baseURL),
    })
  }
  return rows
}

/**
 * 解析用户手动保存的 Key（只认插件自有的 ref）。
 *
 * 这里刻意**不**回退到 ENV_REF：`DEEPSEEK_API_KEY` 通常正是 deepseek provider
 * 自己的 apiKeyEnv，若在此回退，它会被当成「手动输入」候选并抢占默认数据源，
 * 面板也就无法显示真正的 provider 来源。环境变量只作为最后兜底，见 selectCredential。
 * @param credentials - 宿主 credentials 服务。
 * @returns {Promise<{ key: string, source: string } | null>} Key 及其来源。
 */
async function resolveManualKey(credentials) {
  if (!credentials) return null
  try {
    const own = await credentials.resolve(KEY_REF)
    if (own) return { key: own.value, source: 'saved' }
  } catch (error) {
    return null
  }
  return null
}

/**
 * 解析兜底的环境变量 Key。
 * @param credentials - 宿主 credentials 服务。
 * @returns {Promise<{ key: string, source: string } | null>} Key 及其来源。
 */
async function resolveEnvFallback(credentials) {
  if (!credentials) return null
  try {
    const env = await credentials.resolve(ENV_REF)
    if (env) return { key: env.value, source: 'env' }
  } catch (error) {
    return null
  }
  return null
}

/**
 * 列出可作为数据源的凭据候选（不含 Key 值）。
 *
 * 只保留「能解析出 Key」或「正是当前生效 provider」的条目：
 * llm-pi-ai 会声明几十个休眠路由，全列出来只是噪声。
 * @param ctx - 宿主上下文。
 * @returns {Promise<{ active: object|null, selected: string|null, candidates: Array<object> }>} 候选清单。
 */
export async function describeProviders(ctx) {
  const credentials = ctx.get('credentials')
  const active = activeSelection(ctx)
  const rows = await scanProviders(ctx)
  const manual = await resolveManualKey(credentials)

  const candidates = []
  for (const row of rows) {
    const isActive = active !== null && active.provider === row.provider
    if (row.key === null && !isActive) continue
    candidates.push({
      provider: row.provider,
      displayName: row.displayName,
      active: isActive,
      declared: row.declared,
      hasKey: row.key !== null,
      keyRef: row.keyRef,
      keySource: row.source,
      balanceCapable: row.balanceCapable,
    })
  }

  if (manual) {
    candidates.unshift({
      provider: MANUAL_PROVIDER,
      displayName: '手动输入',
      active: false,
      declared: true,
      hasKey: true,
      keyRef: manual.source === 'saved' ? KEY_REF : ENV_REF,
      keySource: manual.source,
      balanceCapable: true,
    })
  }

  // 默认数据源：用户手动保存的 Key > 当前生效 provider > 第一个有 Key 的候选
  const activeRow = candidates.find((row) => row.active && row.hasKey)
  const firstWithKey = candidates.find((row) => row.hasKey)
  const selected = manual
    ? MANUAL_PROVIDER
    : activeRow
      ? activeRow.provider
      : firstWithKey
        ? firstWithKey.provider
        : null

  return { active, selected, candidates }
}

/**
 * 描述 Key 配置状态（不含 Key 值）。
 * @param ctx - 宿主上下文。
 * @returns {Promise<object>} 状态与候选清单。
 */
export async function describeKey(ctx) {
  const described = await describeProviders(ctx)
  const chosen = described.candidates.find((row) => row.provider === described.selected)
  return {
    configured: chosen !== undefined && chosen.hasKey,
    source: chosen ? chosen.keySource : null,
    provider: chosen ? chosen.provider : null,
    active: described.active,
    selected: described.selected,
    candidates: described.candidates,
  }
}

/**
 * 保存用户手动输入的 API Key。
 * @param credentials - 宿主 credentials 服务。
 * @param payload - RPC 负载，`key` 为待保存的明文 Key。
 * @returns {Promise<object>} `{ ok: true }` 或 `{ error: { code, message } }`。
 */
export async function saveKey(credentials, payload) {
  const key = payload && typeof payload.key === 'string' ? payload.key.trim() : ''
  if (!key) return { error: { code: 'bad-request', message: 'Key 不能为空' } }
  if (!credentials) return { error: { code: 'unavailable', message: '凭据服务不可用' } }
  try {
    await credentials.set(KEY_REF, key)
    return { ok: true }
  } catch (error) {
    return { error: { code: 'store-failed', message: (error && error.message) || String(error) } }
  }
}

/**
 * 删除手动保存的 API Key（provider 配置与环境变量来源不受影响）。
 * @param credentials - 宿主 credentials 服务。
 * @returns {Promise<object>} `{ ok: true }` 或 `{ error: { code, message } }`。
 */
export async function clearKey(credentials) {
  if (!credentials) return { error: { code: 'unavailable', message: '凭据服务不可用' } }
  try {
    await credentials.unset(KEY_REF)
    return { ok: true }
  } catch (error) {
    return { error: { code: 'store-failed', message: (error && error.message) || String(error) } }
  }
}

/**
 * 选定本次查询使用的 Key 及其余额端点。
 * @param ctx - 宿主上下文。
 * @param wantProvider - 面板显式选择的 provider id，可为空。
 * @returns {Promise<object>} 选定结果，含 error 字段时表示无法查询。
 */
async function selectCredential(ctx, wantProvider) {
  const credentials = ctx.get('credentials')

  if (wantProvider === MANUAL_PROVIDER) {
    const manual = await resolveManualKey(credentials)
    if (!manual) return { error: '未手动保存 Key' }
    return {
      key: manual.key,
      provider: MANUAL_PROVIDER,
      displayName: '手动输入',
      keyRef: KEY_REF,
      source: manual.source,
      balanceUrl: BALANCE_URL,
    }
  }

  const rows = await scanProviders(ctx)
  const active = activeSelection(ctx)
  const wanted = wantProvider && wantProvider.length > 0
    ? rows.find((row) => row.provider === wantProvider)
    : (active ? rows.find((row) => row.provider === active.provider && row.key !== null) : undefined) ||
      rows.find((row) => row.key !== null)

  if (wanted && wanted.key !== null) {
    if (!wanted.balanceCapable) {
      return {
        error: `${wanted.displayName} 未提供公开的余额接口`,
        provider: wanted.provider,
        displayName: wanted.displayName,
      }
    }
    return {
      key: wanted.key,
      provider: wanted.provider,
      displayName: wanted.displayName,
      keyRef: wanted.keyRef,
      source: wanted.source,
      balanceUrl: wanted.balanceUrl,
    }
  }

  if (wantProvider && wantProvider.length > 0 && wantProvider !== MANUAL_PROVIDER) {
    return { error: `provider ${wantProvider} 未配置可用的 Key` }
  }

  const manual = await resolveManualKey(credentials)
  if (manual) {
    return {
      key: manual.key,
      provider: MANUAL_PROVIDER,
      displayName: '手动输入',
      keyRef: KEY_REF,
      source: manual.source,
      balanceUrl: BALANCE_URL,
    }
  }

  // 最后兜底：环境变量。与 provider 的 apiKeyEnv 同名时上面早已命中，走到这里
  // 说明没有任何 provider 可供凭据，只能依赖进程环境。
  const env = await resolveEnvFallback(credentials)
  if (env) {
    return {
      key: env.key,
      provider: 'env',
      displayName: '环境变量 ' + ENV_REF,
      keyRef: ENV_REF,
      source: env.source,
      balanceUrl: BALANCE_URL,
    }
  }
  return { error: '未找到任何可用的 API Key' }
}

/**
 * 查询账户余额。
 *
 * 经 shell 执行 curl，Key 由环境变量注入：既不进入命令行，也不落进任何日志。
 * @param ctx - 宿主上下文。
 * @param payload - RPC 负载，可选 `provider` 指定数据源。
 * @returns {Promise<object>} 包含 `balance` 或 `error` 的结果对象。
 */
export async function fetchBalance(ctx, payload) {
  const shell = ctx.get('shell')
  const provider = payload && typeof payload.provider === 'string' && payload.provider.length > 0 ? payload.provider : null

  const chosen = await selectCredential(ctx, provider)
  if (chosen.error !== undefined) {
    return {
      configured: chosen.provider !== undefined,
      provider: chosen.provider || null,
      displayName: chosen.displayName || null,
      error: chosen.error,
    }
  }

  if (!shell) {
    return { configured: true, provider: chosen.provider, displayName: chosen.displayName, error: 'shell 服务不可用，无法发起余额查询' }
  }

  const spec = shell.resolve({
    command: 'curl -sS -m 15 -w "\\n%{http_code}" -H "Authorization: Bearer $DSH_DS_KEY" ' + chosen.balanceUrl,
    env: { DSH_DS_KEY: chosen.key },
    timeoutMs: 20000,
    stdoutMaxBytes: 65536,
  })

  let result
  try {
    result = await shell.run(spec)
  } catch (error) {
    return {
      configured: true,
      provider: chosen.provider,
      displayName: chosen.displayName,
      error: '执行失败: ' + ((error && error.message) || String(error)),
    }
  }

  const text = result && result.stdout ? result.stdout.text || '' : ''
  const lines = text.replace(/\n$/, '').split('\n')
  const httpStatus = Number(lines[lines.length - 1]) || 0
  const body = lines.slice(0, lines.length - 1).join('\n')

  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    parsed = null
  }

  const meta = {
    configured: true,
    provider: chosen.provider,
    displayName: chosen.displayName,
    keyRef: chosen.keyRef,
    source: chosen.source,
    httpStatus,
  }
  if (!parsed) return { ...meta, error: `响应解析失败 (HTTP ${httpStatus})` }
  if (parsed.error) return { ...meta, error: parsed.error.message || 'API 错误' }
  return { ...meta, balance: parsed }
}
