# dsh-tidewatch 🌊

DeepSeek Harness 插件：在页面右上角显示 **DeepSeek API 高峰/低谷时段**、倒计时与 **账户余额** 的悬浮卡片。

提供两种形态，按需要选一种（**推荐 A**）：

| | A. 常驻插件（bundle） | B. 动态插件 |
| --- | --- | --- |
| 生效范围 | 开机即在，所有会话 | 仅当前会话，进程内 |
| 生命周期 | 随 DSH profile 启动/重启 | 重启即消失，需重新 define |
| 安装 | 装进 profile（见下） | 会话内 `cordis_define` + `cordis_run` |

## 功能

- 🟢🔴 **实时时段状态灯**：按 DeepSeek 官方计价规则判定当前是高峰期还是低谷期。
  - 高峰：北京时间 周一至周五 09:00–12:00、14:00–18:00
  - 低谷：其余全部时段（夜间、午间、周末均为低谷），**价格减半**
- ⏱️ **北京时钟 + 倒计时**：显示距下一时段切换还有多久，每秒更新。
- 💰 **账户余额**：配置 API Key 后查询 `GET https://api.deepseek.com/user/balance`，显示账户可用性、总余额、充值余额与赠送余额；每 5 分钟自动刷新。
- 🖱️ **可拖拽、可折叠**：标题栏拖动定位，点「－」收起。

## A. 安装为常驻插件

插件目录本身就是 DSH 的一个 bundle（`dsh.bundle.patch` + `dsh.client`）。

```sh
# 1. 装进 profile（web 示例），会写入 package.json 的 dsh.profile.bundles
dsh plugin --profile web add /path/to/dsh-tidewatch

# 2. 重启该 profile 使其生效
```

也可以只挂载而不改 bundle 列表——把 `cordis.patch.yml` 里的 insert 行追加到
`${DSH_HOME}/profiles/<profile>/cordis.patch.yml`，并在该 profile 的
`node_modules/` 下建一个指向本目录的软链接；patch 层默认 `patchReload: live`，
保存后即时生效，**无需重启**。

> ⚠️ 两种方式**二选一**：bundle 装载会自动应用包内的 `cordis.patch.yml`，
> 若同时又手工追加了同一行，会出现重复插入。另外手工软链接会被该 profile 的
> `pnpm install` 清理，长期使用建议走 bundle 装载。

改完客户端半边（`lib/client.js`）后刷新页面即可，无构建步骤。

## B. 安装为动态插件（单会话）

在 DSH 会话中用 `cordis_define` 定义：

1. `code.host` ← `dynamic/host.js` 文件头注释之后的全部内容；
2. `code.client` ← `dynamic/client.js` 文件头注释之后的全部内容；
3. `cordis_run` 激活并在运行卡片上批准。

> 动态插件只存在于当前进程内存，DSH 重启即消失；需要长期可用请用方案 A。

## API Key 从哪来（无需手动填写）

监视器**默认直接复用 harness 已经配置好的模型凭据**，解析顺序：

1. **当前生效模型所属 provider 的凭据引用** —— 由
   `agentDefaultModel.currentSelection()` 得到 provider id，再用
   `llm.listConfigurableProviders()` 给出的 `settingsNs` + `settingsPath`
   定位该 provider 的配置对象，读其 `apiKeyEnv`（credential-ref 字段），
   最后经 `credentials` 服务解析出 Key。
2. 用户在面板里**手动保存**的 Key（credentials ref `DSH_PLUGIN_DEEPSEEK_KEY`）。
3. 兜底环境变量 `DEEPSEEK_API_KEY`。

面板顶部会显示当前模型与 provider（如 `模型 deepseek-v4.1-flash · deepseek-official`），
并提供数据源下拉框：列出所有**能解析出凭据的** provider（llm-pi-ai 声明的几十个
休眠路由不会出现在列表里），选中即切换数据源。

### 安全

- **Key 永不回传浏览器**：前端只拿到凭据引用名、来源与可用性，以及余额数值。
- 余额请求由 Host 执行 `curl`，Key 经**环境变量**传递，不出现在命令行、不写入日志。
- 余额接口只有 DeepSeek 系提供（`<baseURL>/user/balance`）；其余 provider 会被标记为
  不支持并给出明确提示，而不是发一次注定失败的请求。
- 点「清除」只删除手动保存的 Key，不影响 provider 配置与环境变量来源。

## 生效方式（常驻插件）

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js`（浏览器半边） | **刷新页面**即可 |
| `lib/index.js` / `lib/tide.js`（宿主半边） | 需**重启 DSH profile** |
| `cordis.patch.yml` | 实时（`patchReload: live`，配置级热重载） |

宿主半边不会随文件改动或 patch 热重载更新：loader 经 ESM `import()` 装载模块，
缓存按 URL 命中；`patchReload: live` 只重放配置、不替换已加载的模块，
而 `dsh-base` 的 `hmr` 行默认 `disabled`（"Module reload is opt-in per profile"）。
实测：改动 `lib/index.js` 后 `entry.fiber` 仍是原实例，新路由不会出现。

## 传输层（为什么不用 `connection.rpc`）

宿主通过 `connection.fetch.register` 注册一条位于共享 API 通道之下的精确路由：

```
POST /api/dsh-tidewatch
body: { "endpoint": "status" | "providers" | "save-key" | "clear-key" | "fetch-balance",
        "payload": { ... } }
resp: { "ok": true, "value": { ... } }      // 业务失败也放在 value.error 内
```

该路径由 `/api` 载体统一施加 Host/Origin 校验与浏览器会话鉴权，浏览器侧同源
`fetch` 自动携带 cookie。

**未使用 `connection.rpc.handle` 的原因（本构建的宿主缺陷）**：
`HostConnectionService` 以插件自身 ctx 构造，而该 ctx 的 `inject` 只有
`['credentials']`，因此 `rpc.handle` 内部访问 `owner.webServer` 时必然抛
`cannot get property "webServer" without inject`，路由永远注册不上
（HTTP 表现为落到 `frontend-static` 兜底的 405）。
`connection.fetch` 的注册路径不经过 `owner.webServer`，故不受影响。
若宿主将来修复该注入，`lib/index.js` 的 rpc 回退分支会自动接管。

## 测试

```sh
node tests/tide.test.mjs        # provider 发现、凭据解析优先级、余额端点推导、降级路径
node tests/transport.test.mjs   # 路由注册、端点分发、Key 不外泄、rpc 回退与异常容纳
```

## 时段规则出处

[DeepSeek API 官方文档：模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) —— 「空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）」。

## 文件结构

```
package.json          # 包声明：dsh.bundle.patch + dsh.client(platform: web)
cordis.patch.yml      # bundle 层：把宿主行插入 composition
lib/index.js          # 宿主半边：loopback RPC 通道注册（/dsh-tidewatch）
lib/tide.js           # 宿主半边业务：凭据解析、Key 存取、余额查询
lib/client.js         # 浏览器半边：__ModuleLoader__ bundle，悬浮卡片 UI
dynamic/host.js       # 动态插件版宿主半边（方案 B）
dynamic/client.js     # 动态插件版浏览器半边（方案 B）
```

## License

MIT
