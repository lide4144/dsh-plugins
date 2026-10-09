# dsh-quota-readout

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 Web GUI 输入框下方实时显示**当前默认模型所属 provider 的 API 余额 / 订阅额度**。

![kind](https://img.shields.io/badge/dsh-dual--face--plugin-blue) ![platform](https://img.shields.io/badge/platform-web-green)

## 功能

- 读取 `agent-default-model` 的当前默认模型选择，按其 provider 匹配对应的额度接口
- 输入框下方一行紧凑读数（与自带 stats 行并列），状态点按用量变色：≥70% 黄、≥90% 红
- 点击该行强制刷新；平时每 60 秒轮询一次（Host 侧 60 秒缓存 + 3 分钟后台刷新）
- 悬停查看明细（套餐名、各项额度、具体数值、重置倒计时、更新时间）
- 凭证零配置：复用 `llm-pi-ai` 设置里每个 provider 的 `apiKeyEnv` 引用，经 DSH `credentials` 服务按次解析，轮换 key 无需动插件

## 支持的 provider

| provider（按 id 子串匹配） | 接口 | 展示内容 |
| --- | --- | --- |
| `deepseek` | `GET https://api.deepseek.com/user/balance` | 各币种余额（赠送 / 充值明细） |
| `opencode`（OpenCode Go 订阅） | `GET https://opencode.ai/zen/go/v1/usage` | 5 小时 / 每周 / 每月用量百分比 |
| `kimi`（Kimi Code 订阅） | `GET https://api.kimi.com/coding/v1/usages` | 每周额度 + 5 小时速率窗口（百分比 + 进度） |

凭证默认从 `llm-pi-ai` 设置的 `providers.<id>.apiKeyEnv` 读取；缺失时回退到下表的环境变量名：

| provider | 回退凭证引用 |
| --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `opencode` | `OPENCODE_GO_API_KEY` |
| `kimi` | `KIMI_CODING_API_KEY` |

## 安装（本地 `file:` / `link:` 依赖）

DSH 的 profile 组合锚定在 profile 目录（如 `~/.dsh/profiles/web`），插件作为该 profile 的依赖安装：

1. 在 profile 的 `package.json` 中加入依赖（路径按实际调整）：

   ```json
   {
     "dependencies": {
       "dsh-quota-readout": "file:C:/Users/<you>/path/to/dsh-quotas"
     }
   }
   ```

   开发期想改动即生效（重启后）可用 `link:` 代替 `file:`。

2. 在 profile 的 `cordis.patch.yml` 中插入一行组合记录：

   ```yaml
   - insert:
       - id: quota-readout
         name: 'dsh-quota-readout'
   ```

3. 在 profile 目录执行 `pnpm install`，然后重启 DSH。

## 架构

双面（dual-face）插件，无构建步骤：

- **Host 半**（`lib/index.js`，命名导出 `name` / `inject` / `apply`）：通过 `shell` 服务以 curl 发出带 Bearer 的 HTTPS 请求（key 经逐次执行的环境变量传递，不出现在命令行；执行携带会话沙箱策略与工作目录），把最新快照以 JSON 暴露在 `webServer` 路由 `/dsh-quotas/quota`（`?force=1` 绕过缓存）。
- **Client 半**（`lib/client.js`，`window.__ModuleLoader__` 模块表格式）：注册到 `conversation.composer.dock` Slot，每 60 秒 `fetch` 该路由并渲染。

包内 `package.json` 的 `dsh.client` 声明（`platform: web` + inject 边）让 `dsh-client-modules` 把它扫进 `window.__DSH_BOOT__` 启动图。

## 扩展新 provider

在 `lib/index.js` 的 `FETCHERS` 数组中增加一项：

```js
{ match: '<provider id 子串>', env: '<凭证引用名>', url: '<额度接口>', parse: (body) => ({ plan, items }) }
```

`items` 每项形如 `{ label, text, detail, percent, resetAt }`；`percent` 为 `null` 时不参与变色。

## License

MIT
