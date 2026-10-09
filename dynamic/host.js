// dsh-tidewatch — Host half
// DeepSeek Harness dynamic Cordis plugin: peak/off-peak indicator + API balance.
// Paste this file's body into `code.host` of cordis_define (plain JS, no imports).

const KEY_REF = 'DSH_PLUGIN_DEEPSEEK_KEY'
const ENV_REF = 'DEEPSEEK_API_KEY'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

return {
  inject: ['shell'],
  apply(ctx) {
    const credentials = ctx.get('credentials')

    async function resolveKey() {
      if (!credentials) return null
      try {
        const own = await credentials.resolve(KEY_REF)
        if (own) return { key: own.value, source: 'saved' }
        const env = await credentials.resolve(ENV_REF)
        if (env) return { key: env.value, source: 'env' }
      } catch (error) {
        console.error('ds-tide resolveKey:', error)
      }
      return null
    }

    harness.handle('ds-status', async () => {
      const resolved = await resolveKey()
      return { configured: resolved !== null, source: resolved ? resolved.source : null }
    })

    harness.handle('ds-save-key', async (args) => {
      const key = args && typeof args.key === 'string' ? args.key.trim() : ''
      if (!key) return { ok: false, error: 'Key 不能为空' }
      if (!credentials) return { ok: false, error: '凭据服务不可用' }
      try {
        await credentials.set(KEY_REF, key)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) }
      }
    })

    harness.handle('ds-clear-key', async () => {
      if (!credentials) return { ok: false, error: '凭据服务不可用' }
      try {
        await credentials.unset(KEY_REF)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) }
      }
    })

    harness.handle('ds-fetch-balance', async () => {
      const resolved = await resolveKey()
      if (!resolved) return { configured: false }
      const spec = ctx.shell.resolve({
        command: 'curl -sS -m 15 -w "\\n%{http_code}" -H "Authorization: Bearer $DSH_DS_KEY" ' + BALANCE_URL,
        env: { DSH_DS_KEY: resolved.key },
        timeoutMs: 20000,
        stdoutMaxBytes: 65536,
      })
      let result
      try {
        result = await ctx.shell.run(spec)
      } catch (error) {
        return {
          configured: true,
          source: resolved.source,
          error: '执行失败: ' + (error && error.message ? error.message : String(error)),
        }
      }
      const text = result && result.stdout ? (result.stdout.text || '') : ''
      const lines = text.replace(/\n$/, '').split('\n')
      const httpCode = Number(lines[lines.length - 1]) || 0
      const body = lines.slice(0, lines.length - 1).join('\n')
      let payload = null
      try {
        payload = JSON.parse(body)
      } catch (error) {
        payload = null
      }
      if (!payload) {
        return { configured: true, source: resolved.source, httpStatus: httpCode, error: '响应解析失败 (HTTP ' + httpCode + ')' }
      }
      if (payload.error) {
        return {
          configured: true,
          source: resolved.source,
          httpStatus: httpCode,
          error: payload.error.message || 'API 错误',
        }
      }
      return { configured: true, source: resolved.source, httpStatus: httpCode, balance: payload }
    })
  },
}
