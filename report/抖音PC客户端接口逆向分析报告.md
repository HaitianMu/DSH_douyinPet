# 抖音 PC 客户端 8.7.0 接口逆向分析报告

> 分析对象：`D:\douyin`（抖音 PC 客户端 8.7.0，Build `495279540`，Electron `36.4.0-rs.33.release.pgo.0`）
> 分析方式：静态逆向（ASAR 解包 + JS 源码审计 + 二进制字符串/字节扫描 + 本地运行痕迹取证），**未运行客户端、未抓包、未做线上请求**。
> 结论口径：文中每个接口都给出证据来源（文件 / 偏移 / 常量名），便于复核。

---

## 0. 摘要：这个软件的接口分 5 层

| 层 | 接口类型 | 数量 | 承载者 |
|---|---|---|---|
| L1 | 业务 Web API（`https://www.douyin.com/aweme/v1/web/*`） | **192** 条路径 | WebView / Lynx 内的前端代码 + TTNet |
| L2 | 远程基础设施接口（配置 / 网络调度 / 日志 / 推送 / 更新 / 安全 / CDN） | **25** 个域名、20+ 端点 | `main.dll` 原生层（TTNet、Gecko、AppLog、mcs、Frontier） |
| L3 | Electron IPC + 原生命令总线 | **30** 个 IPC 通道、**12** 个 IPC 常量、**231** 个原生命令、**20** 个原生事件 | `app.asar` 主进程 + `preload.js` |
| L4 | Web↔Native JSBridge（anniex/cans 容器） | **57** 个 JSB 方法（`x.*` 42 / `iesbridge` 13 / `internal` 2） | `node_modules/@annie/electron` |
| L5 | 系统级接口（自定义协议、CLI、COM 提权服务、mDNS、注册表/文件） | **12** 条 `sslocal://` 路由、10 个 CLI 参数、**2** 个 COM 服务 | `main.dll`、`elevation_service.exe`、`LANService.js` |

一句话结论：**这个客户端本身几乎不实现业务接口**——业务（视频、评论、私信、电商、直播）全部由 `www.douyin.com` 的 Web 前端通过 192 条 `/aweme/v1/web/*` 路径完成；客户端只提供 5 类"宿主能力"接口：远程配置下发、网络调度（TNC/HTTPDNS/dispatch）、日志埋点与崩溃上报、推送与 IM 长连接、更新与提权。因此"逆向这个软件的接口"= **逆向宿主能力接口 + 复原它承载的 Web API 清单**。

产物目录：

| 文件 | 内容 |
|---|---|
| [`README.md`](README.md) | 文档总览与阅读路径（先看这个） |
| [`接口总表.csv`](接口总表.csv) | **全部接口一张表**（648 行：层/类型/名称/参数/说明/证据） |
| [`interfaces.json`](interfaces.json) | 全量机器可读清单（命令/事件/JSB/IPC/API/域名） |
| [`web-api-endpoints.md`](web-api-endpoints.md) | 192 条 Web API 路径，按前缀分组 |
| [`hosts.md`](hosts.md) | 25 个远程域名与用途 |
| [`native-commands.tsv`](native-commands.tsv) | 231 个原生命令 |
| [`native-events.tsv`](native-events.tsv) | 20 个原生事件 |

---

## 1. 分析过程与证据链

### 1.1 目标文件结构

```
D:\douyin\
├─ douyin.exe                    2.7 MB   启动器/主进程引导（校验 launcher_config.json → 起 8.7.0\douyin.exe）
├─ douyin_guard.exe              2.9 MB   AppGuard 守护进程（配置：api.toutiaoapi.com/service/settings/v3/?app=1）
├─ launcher_config.json          当前版本指针：{"app_name":"douyin","cur_path":"8.7.0",...}
├─ uninst.exe                    卸载器
├─ app_guard_crash_reporter\     崩溃上报（parfait.dll + tt_crash_reporter.exe）
└─ 8.7.0\                        真正的工作目录
   ├─ douyin.exe                主进程（Electron 壳）+ main.dll(199 MB) = ByteDance Electron fork（Chromium+V8+TTNet+Gecko+Lynx）
   ├─ app_shell_updater.exe     增量/整包更新器（bin_update_config.json、bin_update_local.json）
   ├─ installer_downloader.exe  安装包下载/校验（"verifying installer: %d%%"）
   ├─ elevation_service.exe     提权服务安装器（COM out-of-proc）
   ├─ douyin_doctor.exe         崩溃后自检/修复（reporterUrl=mcs.zijieapi.com）
   ├─ tt_crash_reporter.exe / dump_reporter.exe / parfait*.dll   崩溃上报
   ├─ applogrs.dll / LogTransport.dll                            日志上报（mcs/tea）
   ├─ sscronet.dll                                               Cronet（QUIC/H2）网络栈实现
   ├─ mssdk\metasecml.dll                                        安全 SDK（bdTicket/签名）
   ├─ capture_service_client.dll / bmf_hydra.dll / effect.dll / liveplayer.dll / uniplayer.dll / ttffmpeg.dll   采集与媒体
   ├─ resources\app.asar (15 MB)                                 主进程应用（含 @annie/electron 容器框架源码）
   ├─ resources\app.asar.unpacked\preload.js (41 KB)              渲染进程预加载（能力注册表）
   ├─ resources\app.asar.unpacked\__META-INF__\Common.Build-*.node (14.6 MB)  业务主进程逻辑（加密/打包，见 §12）
   ├─ resources\app-update.yml                                   electron-updater 更新源
   ├─ tray\douyin_tray.exe + pc_push.dll                         托盘进程 + 推送/IM（cloudpush、frontier）
   ├─ game_desktop_widget\                                       游戏小部件（elib.dll = 另一个 Electron）
   └─ resources\edt\                                             vConsole/G2 内嵌调试台
```

### 1.2 用的方法与自研工具（均在 `tools\`）

| 工具 | 作用 |
|---|---|
| `tools\asar.js` / `asar-list-file.js` / `asar-extract-file.js` | 手写 ASAR 解析器（无 npm 依赖）解包 `app.asar`、`lynx-douyin.asar` |
| `tools\strings.js` / `harvest.js` / `scanstr.js` | 二进制 ASCII/UTF-16 字符串提取与按关键词过滤（URL/路径/主机/协议） |
| `tools\findbytes.js` | 字节级 needle 扫描 + 上下文（用于找 `sslocal://`、pipe、COM CLSID） |
| `tools\ipc-scan.js` | 从全部 JS 中提取 `ipcMain/ipcRenderer` 通道名 |
| `tools\bridge-map.js` | 从 `@annie/electron` 各 bridge method 类中提取方法名/权限/参数 |
| `tools\api-scan.js` | 从 29 个前端 bundle 中提取 API 路径 |
| `tools\extract-array.js` / `ctx.js` | 结构化提取 JS 数组、打印上下文片段 |
| `tools\sqldump.py` | 读取 `tt_Cookies` / `douyin_app_config`（SQLite） |

### 1.3 关键突破点

1. **`app.asar` 里 `node_modules/@annie/electron` 是未压缩的编译产物**（TypeScript → CJS），带中文注释、常量名、枚举——容器的全部接口契约都是明文。
2. **`pages/driverUpdater|settings|wallpaper` 三个 bundle 共享一段"宿主配置公共 chunk"**，里面既有 **231 个原生命令的完整数组**，也有 **TTNet 的 dispatch 规则表**和 192 条 API 路径。
3. **`%APPDATA%\douyin` 留有上次启动的落盘配置**：`native_config`（HTTPDNS/TTNet 参数）、`TTNetCache\server.json`（TNC 下发结果）、`tray_setting.json`（远程配置真实响应）、`launch_info\*.json`（真实命令行）。
4. `main.dll` 是 Chromium 的 ByteDance 定制分支（源码路径 `..\electron\shell\bytedance\...`），业务逻辑不在里面；它只暴露原生模块接口（TNC/Gecko/Lynx/elevator/crashpad）。

---

## 2. 目标架构

### 2.1 进程与模块

| 进程 | 角色 | 依赖模块 |
|---|---|---|
| `douyin.exe`（2.7 MB，根目录） | Launcher：读 `launcher_config.json`，校验 `cur_path` 后拉起 `8.7.0\douyin.exe` | — |
| `8.7.0\douyin.exe` | Electron 主进程：BrowserWindow / webview / LynxWindow / IPC / preload 注入 / 加载 `app.asar` 与 `Common.Build-*.node` | `main.dll` |
| `main.dll`（199 MB） | ByteDance Electron fork：Chromium + V8 + Node + TTNet(TNC/HTTPDNS) + Gecko + AppLog + mcs + LynxView(PPAPI) + elevator + crashpad | `mssdk\metasecml.dll`、`sscronet.dll` |
| `douyin_tray.exe`（tray\） | 托盘 + 推送 + IM 落地页（Lynx 渲染），独立资源包 `lynx-douyin.asar` | `pc_push.dll`、`lynx.dll` |
| `douyin_widget.exe` / `douyin_game_widget.exe` | 桌面小组件 / 游戏小部件（又一个 Electron：`elib.dll`） | `lynx.dll` |
| `douyin_guard.exe` | AppGuard：按远程配置守护/拉起/修复 | — |
| `app_shell_updater.exe` | 更新器：安装 guard/性能服务/托盘/提权服务、写 launcher 配置 | `elevation_service.exe` |
| `elevation_service.exe` | 提权 COM 服务（仅安装/卸载） | — |
| `tt_crash_reporter.exe` + `parfait*.dll` / `dump_reporter.exe` | 崩溃捕获与上报 | `crash.snssdk.com`/`mcs` |
| `douyin_doctor.exe` | 崩溃自愈（页面溢出、黑屏、删除坏配置） | — |

### 2.2 渲染架构（三种容器）

```
                      ┌───────────────────────────── douyin.exe (main) ─────────────────────────────┐
                      │ ipcMain 30 通道 / 231 原生命令 / 20 原生事件 / Common.Build（业务主进程）    │
                      │ session("persist:annie-session")  UA+headers 注入 / https 拦截(Gecko 离线包) │
                      └───────▲──────────────────────▲──────────────────────▲───────────────────────┘
             preload(TTE_ENV, │  __internal_invoke)  │ JS2NativeBridge      │ ipcRenderer
                              │                      │ (iframe/postMessage) │
   ┌──────────────────────────┴───────┐  ┌───────────┴──────────────┐  ┌────┴─────────────────────┐
   │ BrowserWindow / webview (CEF)    │  │ LynxView (PPAPI 插件)     │  │ 壳页面 pages/*（React）   │
   │ 主站 www.douyin.com              │  │ lynxview://channel/bundle │  │ 设置/更新/播放器/壁纸/    │
   │ x.* JSBridge (anniex)            │  │ 同一套 JSBridge           │  │ 内部浏览器/调试台         │
   └──────────────────────────────────┘  └───────────────────────────┘  └──────────────────────────┘
```

- **Lynx 容器**通过 PPAPI 插件承载：`app.commandLine.appendSwitch("register-pepper-plugins", ".../ppapi_lynx_headless.dll;application/x-ppapi-lynxview")`（`@annie/electron/dist/lib/main/index.js:91-94`），这是 ByteDance 定制 Electron 的 `LynxWindow` API。
- 壳页面共 13 个：`app`（主壳）、`player`、`settings`、`update2`、`wallpaper`、`wallpaperPreview2`、`internalBrowser`、`gameBrowser`、`driverUpdater`、`debugtool`、`error`、`firstLoading`、`blankPage`。

### 2.3 启动时序 = 接口调用顺序

```
1. douyin.exe(root)      读 launcher_config.json → 拉起 8.7.0\douyin.exe -type=test-launch --start_type=installer
2. 8.7.0\douyin.exe      加载 main.dll → TTNet 初始化：TNC(tnc3-*.zijieapi.com) → HTTPDNS(dig.bdurl.net)
3. main process          session("persist:annie-session") + preload 注入 + 注册 231 命令 / 30 IPC / 57 JSB
4. 拉远程配置            api.toutiaoapi.com/tfe/api/request_combine/v1?api_list=/service/settings/v3/
                         → body.data.settings.douyin_web_pc（壁纸/启动/性能/提示等开关）
5. 开主窗口              MAIN_WINDOW 加载 https://www.douyin.com/，注入 TTE_ENV + global props + geckoChannelMap
6. 前端接口              x.* JSBridge（设备/存储/请求/登录…） + /aweme/v1/web/*（192 条，经 TTNet 按 dispatch 选路）
7. 托盘进程              启动即拉 imapi.douyin.com/v1/message/get_message_by_init
                         + wss://frontier.snssdk.com/ws/v2（长连接） + www.douyin.com/cloudpush/*
8. 周期性                mcs.zijieapi.com（埋点）/ pc-mon.zijieapi.com（性能）/ crash.snssdk.com（网络与崩溃）
```

> 第 1 步的命令行来自 `%APPDATA%\douyin\launch_info\4080-launch_info.json`（真实启动记录）。

---

## 3. 接口全景

```
L1 业务 Web API ── /aweme/v1/web/* ×192 ──────────► www.douyin.com
L2 基础设施   ── 配置/网络/日志/推送/更新/安全 ───► api.toutiaoapi.com, tnc*.zijieapi.com,
                                                    dig.bdurl.net, mcs.zijieapi.com, frontier.snssdk.com,
                                                    imapi.douyin.com, scc.bytedance.com, jsb.snssdk.com ...
L3 主进程总线 ── IPC 30 + 原生命令 231 + 事件 20 ─► 壳页面 / 主站页面 / 托盘
L4 JSBridge   ── 57 方法 + 事件中心 + global props ► Web/Lynx 前端
L5 系统接口   ── sslocal:// / CLI / COM / mDNS ───► 操作系统 & 其它进程
```

---

## 4. L1：业务 Web API（192 条路径）

### 4.1 Base host 与路由

所有 `/aweme/...` 路径的 host 由 TTNet dispatch 规则决定（`pages/driverUpdater/index.4041f79871116072.js` 内 `ttnet_dispatch_actions`）：

| rule_id | act_priority | 条件 | 目标 |
|---|---|---|---|
| — | `0x989681` | host `www-m.douyin.com`，任意路径，`dispatch_strategy:1` | `service_name:"idc_weight_www_multi_hj"` → 改写为 `www-hj.douyin.com` |
| `350696` | `9e6`（9000000） | host=`*`，12 条"东部跳转"前缀（`/aweme/v1/web/seo/`、`/series/*`、`/content_pay/order/submit`、`/api/suggest_words/` …） | `service_name:"jump_east_path"`，`set_req_priority:9000002`，`sign:"93fcfb3c45cac49e4612881eccb0601f"` |
| — | `9000001` | host=`www.douyin.com`，其余全部 API 前缀 | 直连（默认 IDC） |

即：**业务 API 基址 = `https://www.douyin.com`**，另有 IDC 权重改写与"东部机房优先"规则。

### 4.2 路径分布（完整清单见 [`web-api-endpoints.md`](web-api-endpoints.md)）

| 域 | 条数 | 代表接口 |
|---|---|---|
| `aweme/v1/web/*` | 186 | 见下细分 |
| `aweme/v2/web/aweme/stats` | 1 | 播放数据上报 |
| `aweme/v2/shop/promotion/pack[/detail]` | 2 | 电商推广包 |
| `aweme/v1/following/list/item/seen` | 1 | 关注流已读 |
| `aweme/v1/watchlater/count` | 1 | 稍后再看计数 |
| `cloudpush/update_sender` | 1 | 推送 sender 回传 |

`aweme/v1/web/*` 的功能细分（节选，全量见附录文件）：

| 功能域 | 接口 |
|---|---|
| 视频详情/播放 | `/aweme/v1/web/aweme/detail`、`/multi/aweme/detail`、`/aweme/post`、`/aweme/stats`、`/aweme/listcollection`、`/aweme/collect`、`/aweme/cancel/collect/multi` |
| 长视频/剧场 | `/long/video/detail`、`/long/video/meta`、`/lvideo/spring/list`、`/lvideo/theater/banner`、`/lvideo/query/history`、`/lvideo/submit/history` |
| 剧集/合集 | `/series/{list,detail,aweme,card/feed,collect,watched/list,watch/record}`、`/mix/{list,detail,aweme,recommend,collect,listcollection}` |
| 互动 | `/commit/item/digg`、`/comment/{list,list/reply,publish,delete,digg}`、`/commit/follow/user`、`/commit/user`、`/commit/dislike/item` |
| 弹幕 | `/danmaku/{conf/get,conf/set,get_v2,post_v2,digg,list,delete_v2}` |
| 用户/关系 | `/user/profile/{other,scene}`、`/user/following/list`、`/user/follower/list`、`/user/recommend`、`/user/settings`、`/user/set/settings`、`/remove/follower`、`/user/block` |
| 私信 IM | `/im/user/info`、`/im/conversation/info/other`、`/im/user/active/{status,update,config/get}`、`/im/strategy/config`、`/im/resource/*`、`/im/recent/sticker/*`、`/im/spotlight/relation` |
| 搜索/热点 | `/hot/search/list`、`/hot/search/video/list`、`/search/sug`、`/api/suggest_words`、`/challenge/search` |
| 电商 | `/ecom/order/{create,confirm,detail,pay/status,pay/refresh,confirm/edit}`、`/ecom/product/{detail/saas/pc,sku/list}`、`/ecom/warcraft/api/coupon/*`、`/content_pay/order/submit`、`/commerce/order/{getUserAuth,saveUserAuth}` |
| 直播相关 | `/webcast/web/feed/follow`（宿主侧）、`/appoint/{live/list,living/status,write}`、`/watched/anchors` |
| 活动/运营 | `/activity/{banner,task,medal,carnival/main,carnival/billboard,yayun/match}`、`/summer/activity/receive`、`/olympics/data`、`/college/entra`、`/weite` 系列 |
| 收藏/历史 | `/collects/{list,maintain,video/list,video/move}`、`/history/{read,write,clear}`、`/watchlater/{list,remove}` |
| 壁纸/桌面 | `/wallpaper/item`、`/aweme/v1/web/wallpaper/item`（壁纸页专用） |
| 上传/举报/杂项 | `/image/upload/token`、`/report/{submit,upload/auth}`、`/locate/post`、`/ad/{hotspot,report}`、`/client/monitor`、`/ab/params`、`/mobile/ab/params`、`/query/ip/location` |

### 4.3 客户端注入的公共参数（每条 API 都带）

来源：`@annie/electron/dist/lib/main/bridge/utils.js:66-114`（`getAPIParamsFromAppInfo`）：

```
aid=6383, app_name=douyin, app_version/version_name=8.7.0, version_code/build_number=<构建号>,
channel, ac=<网络类型>, device_id, device_platform=pc, device_type=<机型>, os_version,
language, appTheme, screen_width, screen_height, ts=<毫秒时间戳>, (+宿主自定义 apiParams)
```

`x.request` 桥会在 `addCommonParams !== false` 时自动合并上面这组参数（`xbridge/XRequest.js:49-61`）。

### 4.4 签名/风控（重要说明）

- 客户端 ASAR 内**没有** `X-Bogus` / `a_bogus` / `msToken` 的生成代码；这些由 `www.douyin.com` 的前端在页面上下文里生成并附加。
- 原生侧只提供 **bdTicket**（`bdTicketConfig`、`resetBdTicketGuardSecureState`、`signWithCustomPayload`、`mssdk/metasecml.dll`）与 **AppGuard/证书校验**之类的能力接口。
- 本报告只做接口枚举，不提供风控参数绕过方案；实际调用需合法账号 Cookie 与前端生成的签名。

---

## 5. L2：基础设施接口

### 5.1 远程配置（AppSetting / TCC）

配置入口文件 `8.7.0\shell_config.json`：

```json
{ "appId": "6383", "appSettingHost": "https://api.toutiaoapi.com", "updateConfigKey": "douyin_pc_update",
  "appSettingAppId": "430651", "appSettingHostOversea": "https://api.toutiaoapi.com",
  "updateConfigKeyOversea": "windows_update_oversea", "appSettingAppIdOversea": "423531",
  "teaReportHost": "https://mcs.zijieapi.com", "teaReportHostOversea": "https://maliva-mcs.byteoversea.com",
  "teaReportVersion": "1.0.4", "devicePlatform": "pc", "minDiskSpace": 400,
  "installerMutex": "Douyin_Mutex_Install", "binUpdateConfigKey": "windows_update" }
```

实际请求（`main.dll` 字符串，偏移 162497561 附近）：

```
GET https://api.toutiaoapi.com/tfe/api/request_combine/v1/?api_list=/service/settings/v3/&aid=6383&device_id=<did>
    &app_env=<env>&query=<json_path>&...
响应：{ "data": { "settings": { "douyin_web_pc": {...} } } }   ← main.dll 里出现 "body.data.settings.douyin_web_pc"
```

> 参数名/片段证据（`main.dll` 偏移 162497561 附近的连续字符串）：`app_env`、`app_env=`、`query`、`json_path`、`6383`、`/tfe/api/request_combine/v1/`、`api_list=/service/settings/v3/`、`data`、`/service/settings/v3/`、`body.data.settings.douyin_web_pc`。具体拼装顺序由原生代码决定。

其它配置面：

| 接口 | 用法 |
|---|---|
| `GET api.toutiaoapi.com/service/settings/v3/?app=1` | `douyin_guard.exe` 拉 appguard 配置（参数 430651 / 6383 / `appguard_version` / `pc` / `device_id` / `cpu_pr…` → 返回"Download URL / MD5 / Args"） |
| `GET api.toutiaoapi.com/service/settings/v2/?app=1&caller_name=tt_webview` | TTWebView TNC 配置 |
| `GET api.toutiaoapi.com/get_domains/v4/` | 域名列表下发 |
| `GET lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-ies.auc.config-default` | TCC 动态配置（容灾/降级：`channel_whitelist`、`safe_urls`） |
| `GET jsb.snssdk.com/src/server/v2/package` | JSBridge 鉴权/方法分组（`JSBMethodGroupMap`、`JSBSecurityStrategyContent`） |

远程配置的**真实响应样例**（`%APPDATA%\douyin\tray_setting.json`）：

```json
{"data":{"__logid":"...","settings_time":1792983285,"app":{
  "douyin_pc_wallpaper":{"wallpaper_compatibility_mode":false},
  "douyin_pc_app_launch":{"app_launch_log_to_parfait_custom_log_and_event":false},
  "douyin_pc_feedback_tips":{"enable_crash_report":false,"max_tips_count":1,"first_screen_timeout":60000},
  "douyin_pc_performance_service":{"performance_service_warm_up_enabled":true,"performance_service_push_enabled":false}}},"message":"success"}
```

### 5.2 TTNet：TNC + HTTPDNS + dispatch

`%APPDATA%\douyin\native_config`（HTTPDNS 参数）：

```json
{"electron_version":"36.4.0-rs.33.release.pgo.0","byteioAid":6383,"mcsUrl":"https://mcs.zijieapi.com",
 "net_aid":"6383","net_did":"7120169859669001743",
 "net_dns_backup_map":"{\"dig.bdurl.net\":[\"101.36.166.16\",\"101.36.166.19\"]}",
 "net_dns_ttl":0,"net_http_dns_enabled":true,"net_http_dns_fallback_domains":".*",
 "net_http_dns_tt_domains":".*","net_httpdns_timeout":2000,"net_tthttpdns_domain":"dig.bdurl.net",
 "net_dns_ttl":0,"net_dns_proc_task_timeout":500}
```

`%APPDATA%\douyin\TTNetCache\server.json`（TNC 下发结果，字段即接口契约）：

| 字段 | 含义 |
|---|---|
| `send_tnc_host_arrays` | `["tnc0-aliec2.zijieapi.com","tnc0-alisc1.zijieapi.com"]` |
| `ttnet_http_dns_addr` | host→IP 列表（`tnc0-alisc1: 47.106.88.76,...`、`frontier.snssdk.com: 122.14.236.53,...`） |
| `tnc_update_interval` | 180 s |
| `ttnet_h2_enabled` / `ttnet_h2_config.*` | HTTP/2 与 ping keepalive 策略 |
| `ttnet_request_retry_max_attempts` / `_error_list` / `_delay_interval_ms` | 重试策略（错误码 `-21,-109,-126,-324,-101`） |
| `ttnet_url_dispatcher_enabled` / `dispatch_actions` | URL 调度开关与规则 |
| `ttnet_enable_cronet_request_report` | 请求上报 |
| `chromium_open` / `wpad_enabled` / `md5_check` | 网络栈开关 |

主进程侧 `ttnetConfig`（`pages/driverUpdater` 公共 chunk）：

```js
{ enable:true, httpCacheMode:"DISK", enableQUIC:true, enableProxyNativeNetwork:true,
  storeIDCRuleJSON: { update_store_idc_path_list:["/service/*/device_register/","/service/*/device_register_only/","/passport/*"],
                      add_store_idc_host_list:["*.snssdk.com","*.amemv.com"] },
  ttnetParams:{ appID:"6383", tncHostFirst:"tnc3-bjlgy.zijieapi.com", tncHostSecond:"tnc3-alisc1.zijieapi.com",
                tncHostThird:"tnc3-aliec2.zijieapi.com", domainHTTPDNS:"dig.bdurl.net",
                domainNetlog:"crash.snssdk.com", isMainProcess:"1" } }
```

> 注意 `update_store_idc_path_list` 里的 `/service/*/device_register/`、`/service/*/device_register_only/`、`/passport/*`：这是**设备注册与登录态**接口，会做 Store-IDC 就近改写。

### 5.3 日志 / 埋点 / 监控

| 接口 | 说明 |
|---|---|
| `https://mcs.zijieapi.com` | mcs/tea 上报（`byteioAid=6383`，`teaReportVersion=1.0.4`）；海外 `maliva-mcs.byteoversea.com` |
| `https://log.zijieapi.com` / `rtlog.zijieapi.com` / `log-klink.zijieapi.com` / `log.snssdk.com` | `applogrs.dll` 日志通道（含 "get custom domain lock failed!" 即域名锁定） |
| `https://pc-mon.zijieapi.com` | PC 性能监控（`douyin_performance_service.dll` 用 WinHTTP） |
| Slardar（`lf3-short.ibytedapm.com/slardar/...`） | 前端监控，`browserClient.init({bid:"electron_douyin_pc", pid, userId:ttWid, deviceId:guid, release:"<ver>-<buildId>"})` |
| `/aweme/v1/web/client/monitor` | 客户端侧业务监控上报 |
| `data.bytedance.net/byteio/debugger/event/realtime/tool?subAppId=6383&deviceId=` | 埋点实时调试台（debugtool 页外链） |

### 5.4 崩溃上报

| 组件 | 接口/参数 |
|---|---|
| `tt_crash_reporter.exe` / `parfait.dll` / `dump_reporter.exe` | `crash.snssdk.com`（同时也是 TTNet `domainNetlog`）；`douyin_doctor.exe` 配置：`reporterUrl:"mcs.zijieapi.com"`, `reporterAppId:"6383"`, `crashReporterAppId:"330274222"`, `appVersion:"8.7.0"`, `maProcessNames:["douyin.exe"]` |
| `tt_crash_reporter_config.dat` | 加密二进制配置（安装目录 288 B / `%APPDATA%` 1120 B） |
| Crashpad | `\\.\pipe\crashpad_%lu_…` 命名管道（Chromium crashpad 标准） |

### 5.5 推送 / 长连接 / IM

| 接口 | 方法 | 说明 |
|---|---|---|
| `wss://frontier.snssdk.com/ws/v2` | WebSocket | Frontier 长连接推送网关（灰度 `wss://frontier-boe.bytedance.net/ws/v2`） |
| `https://imapi.douyin.com/v1/message/get_message_by_init` | GET（推测） | IM 初始化拉历史消息 |
| `https://www.douyin.com/cloudpush/app_notice_status/?aid=6383` | — | 通知开关状态 |
| `https://www.douyin.com/cloudpush/pull/psort/v2/` | — | 拉取排序后的推送 |
| `https://www.douyin.com/cloudpush/update_token/`、`/cloudpush/update_sender/` | — | 上报推送 token / sender |
| `https://www.douyin.com/cloudpush/callback/client_click/`、`client_show/`、`client_webapp_show/` | — | 推送点击/展示回执（`pc_push.dll` 还有 `client_show`） |
| `https://www.douyin.com/aweme/v1/web/{notice,notice/count,notice/detail,pull/notify,external/notification,im/user/info,watched/anchors}` | — | 通知/私信/关注动态（托盘直接用） |
| `https://www.douyin.com/api/user/registerWebId` | — | 注册 webid（ttwid） |
| `https://www.douyin.com/webcast/web/feed/follow/` | — | 关注页直播流 |
| WNS | — | `douyin_app_config` 表里存 `PushWnsChannelToken`（Windows 推送通道 token） |

> "方法"为 `—` 的条目：只从二进制里取到了 URL 字面量，HTTP 方法需要动态抓包确认（本报告未抓包）。

托盘推送落地路由（`douyin_tray.exe` 内）：`sslocal://activity/{live,aweme,h5}?…`、`sslocal://webcast_room?web_rid=&enter_method=hq_live_push`、`sslocal://chat/center?conv_short_id=&conversation_id=`、`sslocal://notice_list`。

### 5.6 更新

| 接口 | 说明 |
|---|---|
| `https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/douyin-pc-client/releases/` | `app-update.yml`：`provider: generic`, `channel: latest`, `updaterCacheDirName: douyin-updater`（electron-updater 协议：`latest.yml`、`*.exe`、`*.blockmap`） |
| `bin_update_config.json` / `bin_update_local.json` | `app_shell_updater.exe` 的二进制更新清单（键：`windows_update`、`douyin_pc_update`、`windows_update_oversea`） |
| `md5.json`（119 KB） | 安装目录全量文件 MD5 清单（完整性校验） |
| `launcher_config.json` | 版本指针：`{"app_name","cur_path","mid_path","need_update","new_path","installer_path"}` |
| 更新器还会做的事 | 「install performance service / install app guard for douyin / install old elevation service / update launcher config path」——即通过 COM 提权服务安装 guard、性能服务、托盘、崩溃上报器 |

### 5.7 安全类接口

| 接口 | 说明 |
|---|---|
| `https://scc.bytedance.com/scc_sdk/url_scan_v4?scc_mode=core&scc_from=TTWebview` | 打开外链/二维码前的 URL 安全扫描（SCC） |
| `https://jsb.snssdk.com/src/server/v2/package` | JSBridge 鉴权包 |
| `https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-ies.auc.config-default` | 容灾配置（`safe_urls`、`channel_whitelist`） |
| `tosv-boe.byted.org/obj/tcc-config-web-boe/...` | 同上，BOE 环境 |
| Lynx 验签 | `SECURITY_LYNX_VERIFY_MODE{CLOSE:0,REPORT_ONLY:1,ENFORCE:2}`，事件 `lynx-file-load`/`lynx-file-verify-complete`，埋点 `bdx_monitor_bridge_lynx_verify_result` |
| Gecko 资源拦截 | `session.protocol.customInterceptBufferProtocol("https", …)` 按 `geckoHostWhiteList` 把 https 请求重定向到本地离线包 |

### 5.8 Gecko 离线包

- 下发桶：`https://tosv.byted.org/obj/ies.fe.gecko/`（BOE：`tosv-boe.byted.org`）
- scheme 参数：`channel=`、`bundle=`、`group`、`gecko_channel`、`resource_root_paths`、`cdn_multiversion_params`、`initial_props`（`main.dll` 偏移 171114495 处属性表）
- `resolvedUrl` 规则：`lynxview://<channel>/<bundle>`（`common/scheme-parser.js:128-153`）

### 5.9 CDN / 静态资源

`p3-pc.douyinpic.com`、`p3-pc-sign.douyinpic.com`、`p11.douyinpic.com`（图片，签名 URL 形如 `?lk3s=…&x-expires=…&x-signature=…`）、`p6-webcast-game-sign.byteimg.com`（直播图）、`lf3-static.bytednsdoc.com`（许可图片/字体）、`lf3-short.ibytedapm.com`（Slardar）、`lf3-config.bytetcc.com`（TCC）。

---

## 6. L3：主进程本地接口

### 6.1 Electron IPC 通道（30 个）

| 通道 | 方向 | 用途 |
|---|---|---|
| `WEBVIEW_GET_CURRENT_SCHEME` / `WEBVIEW_UPDATE_CURRENT_SCHEME` / `WEBVIEW_GET_GLOBAL_PROPS` / `WEBVIEW_GET_BRIDGE_CONFIG` | renderer→main(handle/send) | 容器 scheme / 全局属性 / 桥配置 |
| `GET_CANS_MAIN_SETTING` / `CANS_OPEN_H5_DEVTOOL` | renderer→main | 容器主设置、打开 H5 devtools |
| `BRIDGE_MAIN_RECEIVE_EVENT` / `BRIDGE_MAIN_RECORD_CONTAINER` / `BRIDGE_RECEIVE_RENDERER_JSB_REGISTER` / `..._UNREGISTER` / `BRIDGE_CONTEXT_CALLBACK_EVENT` / `BRIDGE_CONTEXT_SEND_JS_EVENT` | 双向 | JSBridge 消息总线 |
| `EVENTCENTER_MAIN_RECEIVE_EVENT` / `EVENTCENTER_MAIN_TRIGGER_EVENT` | 双向 | 事件中心 |
| `MAIN_CALL_RENDERER_METHOD`(+`_CALLBACK`) | main→renderer | 主进程反向调用渲染进程方法 |
| `REPORT_STAT` / `switchToRecommend` / `openFolder` | renderer→main(invoke) | 统计上报、切推荐、打开目录 |
| `close` / `minimize` / `maximize` / `unmaximize` / `pin` / `updatePlayStatus` | 播放器窗口控制 | 无边框窗口按钮 |
| `confirm-to-update` / `cancel-to-update` / `quit-and-install-update` / `update-download-{start,progress,success,error}` | 更新页 | 更新流程 UI 事件 |
| `decode-*` / `encode-*` / `pre-decode-*` / `start-{decode,encode,pre-decode}` | `@bytebench/foundation` | 硬件/软件编解码基准测试 |

### 6.2 原生命令总线（231 个）

机制：`preload.js` 把每个命令名注册成 IPC 通道，页面通过暴露的 `__internal_invoke(cmd, payload)` / `__internal_send(cmd, payload)` 调用；主进程（`Common.Build`）注册对应 handler，并可用 `MESSAGE_FROM_MAIN_PROCESS` 事件回推。**完整清单见 [`native-commands.tsv`](native-commands.tsv)**，分类如下：

| 分类 | 代表命令 |
|---|---|
| 窗口/壳 | `WINDOW_{MOVE_TOP,CLOSE,MAX,MIN,SHOW_ABOUT,IS_FULL,SHOW_DEBUGTOOL}`、`MAIN_WINDOW_MOVE_TOP`、`changeMiniWindowHideMode`、`pipParentWinShow`、`mainViewMoveTopByBounds`、`setMinimumSizeInResize`、`setLandingMode`、`showDouyinWindow` |
| 导航/页面 | `CAN_GO_BACK`、`GO_BACK`、`RELOAD`、`PAGE_READY`、`RELOAD_FROM_ID`、`REFRESH_WEBVIEW`、`openInternalBrowser`、`internalBrowserBack`、`openSchema`、`openSiteInOuterBrowser`、`BROWSER_VIEW_READY` |
| 配置/存储 | `GET_SETTINGS`、`GET/SET_APP_CONFIG_ITEM`、`GET_STORE_ITEM`/`SET_STORE_ITEM`、`localStorage.{getItem,setItem,removeItem,setAll}`、`sessionStorage.*`、`setClientMMKV`、`updateSafeMmkv`、`setPreloadNodeConfig`/`getPreloadNodeConfig` |
| 网络/代理 | `POST`、`GET`、`MODIFY_REQUEST_HEADER`、`SWITCH_PROXY`、`UPLOAD_PROXY_CONFIG`、`getEnvHeader`、`getWebId`、`isOnline` |
| Cookie/登录 | `CLEAR_COOKIE`、`cookies.{getItem,registerCookieChange,unRegisterCookieChange}`、`getCookieChangeInfo`、`SYNC_LOGIN_STATE`、`getWebAuthLocalStorage`/`setWebAuthLocalStorage` |
| 设备/系统信息 | `getDeviceInfo`、`getSystemInfo`、`getCsrInitialData`、`getDeviceRegisterInfo`、`getPerformanceInfo`、`getMonitorInfo`、`getBatteryInfo`、`getGPUInfo`、`getGPUFeatureStatus`、`getMemoryInfo`、`getMetrics`、`getAppMetrics`、`getVolumeInfo`、`GET_ALL_DISPLAYS` |
| 频道/身份 | `GET_CHANNEL_ID`、`GET_WID`、`GET_USER_UNIQUE_ID`、`GET_GUID`、`GET_VERSION`/`GET_APP_VERSION`、`GET_BUILD_ID`、`IS_DEV`、`IS_ONLINE`、`GET_IS_MAS` |
| 桌面/壁纸/小组件 | `openWallpaperPreview`/`closeWallpaperPreview`/`readLocalWallpaperInfo`/`wallpaperDelete`/`wallpaperPreviewConfirm`/`DOWNLOAD_WALLPAPER`/`addWallpaperByCustom`/`getInsertWallpaperList`/`setInsertWallpaperList`/`setRightClickWallpaperMenu`、`setDesktop{SelfPage,Widget,Search,Wallpaper,Follow,MiniWindow}*WidgetState`、`canSetDesktop*Widget`、`isDesktop*WidgetAutoAdd` |
| 游戏小部件 | `createGameWindow`、`destroyBigGameWindow`、`createBigGameWindow`、`getGameConfig`、`getIsSupportGameWidget`、`openGameDesktopWidget`、`openMiniWindowFromGameDesktopWidget` |
| 媒体/播放 | `getHardwareDecodeState`/`setHardwareDecodeState`、`getVideoSideBarStatus`/`setVideoSideBarStatus`、`GET/SET_VOLUME_BALANCE_CLOSE`、`printFirstFeedShow`、`switchToRecommend`、`bytebenchTrigger` |
| 下载/文件 | `DOWNLOAD_FILE`、`WRITE_FILE_SYNC`、`USER_FILE_IS_EXIST`、`SHOW_OPEN_DIALOG`、`showItemInFolder`、`getVideoDownloadPath`、`cancelVideoDownload`、`{get,pause,resume}DownloadFile*`、`openDownloadFile`、`downloadURL` |
| 更新/诊断 | `SHOW_UPDATE_MODAL`、`GET_CLIENT_UPDATE_INFO`、`GET_IS_UPDATE_PACKAGE_READY`、`QUIT_UPDATE_TIP`、`checkDriver`/`updateDriver`/`cancelUpdateDriver`、`openDriverCheckWindow`、`hideDriverCheckWindow`、`showErrorPage`、`setCrashInfo`、`UPLOAD_LOG`、`parfaitLog` |
| 安全/风控 | `resetBdTicketGuardSecureState`、`signWithCustomPayload`、`getGuardSwitch`/`guardSwitchChange`、`getIsFrontShow`、`ASK_FOR_MEDIA_ACCESS`/`GET_MEDIA_ACCESS_STATUS` |
| 调试 | `OPEN_DEV_TOOLS`、`addDebugMenu`/`removeDebugMenu`、`destroyRenderProcess`、`GET_ALL_CLIENT_LOG`、`GET_ALL_STAT_INFO`/`CLEAR_STAT_INFO`、`readTrayLogConfig`/`writeTrayLogConfig`/`readTrayLogInfo`/`clearTrayLog` |
| 局域网 | `handleLanMulticast`、`sendMulticastResult`、`showLanMulticastPrompt` |
| 杂项 | `SET_AUTO_START`/`GET_AUTO_START`、`SET_ALWAYS_ON_TOP`/`IS_ALWAYS_ON_TOP`、`GET_IS_FRONT_SHOW`、`appQuit`/`appRelaunch`/`relaunch`、`openIAP`/`getIAPProductPackage`/`isIapReady`、`gotoLandingPage`、`goToHelpPage`、`setExtensionAssociation`/`isExtensionAssociation`/`resetExtensionAssociation`、`createMultitaskingWindow`、`getMultitaskingWindowCount`、`getLynxInfo`/`getIsLynxStart`/`closeLynxWindow`/`showWindowByWebWhenLynx` |

### 6.3 原生事件（20 个，main→renderer）

`THEME_CHANGE`、`PAGE_STORE_CHANGE`、`MESSAGE_FROM_MAIN_PROCESS`、`VIDEO_PLAYER_STATUS_CHANGE`、`LOG_INFO_NOTIFY`、`WEB_CONTENTS_INSTANCE_CHANGE`、`BURIED_INFO_NOTIFY`、`APP_CONFIG_CHANGE`、`UPDATE_DOWNLOAD_SUCCESS`、`VIDEO_DECODE_CATON`（原文拼写）、`ON_MAXIMIZE_CHANGE`、`MAS_IAP_TRACE`、`MAS_IAP_LOG`、`ON_TOP_CHANGE`、`WALLPAPER_PREVIEW_CLOSE`、`UPDATE_VOLUME_BALANCE_CLOSE`、`showLanMulticastPrompt`、`handleLanMulticast`、`showDouyinWindow`、`postMessage`。

### 6.4 preload 注入到页面的全局（22 个）

| 全局 | 说明 |
|---|---|
| `TTE_ENV` | 页面环境对象（`initPageStore`、`layoutInitialProps` 等），页面用它拿 `guid` / `ttWid` / `buildId` |
| `__internal_invoke(channel, payload)` / `__internal_send(channel, payload)` | **直接调用原生命令的通用入口** |
| `JS2NativeBridge` | `{_invokeMethod(jsonString), _registerAnnieWeb()}`，报文见 §7.1 |
| `__internalBridge`、`__containerID`、`__webviewID`、`__globalprops`、`__device` | 容器上下文 |
| `__openNestedWeb` / `__closeNestedWeb` / `__openNestedLynx` / `__closeNestedLynx` / `__drawUI` / `__setWebViewRef` / `__setLynxViewRef` / `__setWebViewIdRef` | 嵌套容器管理（UI 由主容器 iframe 绘制） |
| `__version_check_register` / `__pace_stream_register` | 版本检查 / 流式渲染注册 |
| `LynxRenderAgentFactory` / `defaultLynxRenderAgent` | Lynx 渲染代理 |

---

## 7. L4：Web↔Native JSBridge（anniex / cans 框架）

### 7.1 报文协议

页面侧（`preload.js` 的 `JS2NativeBridge`）：

```js
JS2NativeBridge._invokeMethod(JSON.stringify({
  func: "x.request", params: {...}, JSSDK: "1.0", __msg_type: "invoke",
  namespace: "@annie/electron", __callback_id: "cb_1"
}))
// native 回调：
window["JS2NativeBridge@annie/web"]._invokeMethod(JSON.stringify({
  __callback_id: "cb_1", __msg_type: "callback", __params: { code: 1, data: {...} }
}))
```

主进程（`main/bridge/JSBridgeManager.js`）收到的 payload：`{ _containerID, _bridgeID, _containerType, data, name }`，其中 `_containerType ∈ {LYNXVIEW, WEBVIEW, LYNXWINDOW, MAIN, PROCESS}`。

### 7.2 方法清单（57）

**anniex（`x.*`）42 个** —— `@annie/electron/dist/lib/main/bridge/xbridge/`，方法名即 `x.<file>`：

| 方法 | 参数（从实现反推） | 功能 |
|---|---|---|
| `x.request` | `url, method, header, params, body, timeout, addCommonParams, prefetchKey, isStream` | 通用 HTTP（走宿主网络栈，自动补公共参数） |
| `x.uploadFile` | `url, filePath, header, params, addCommonParams, needCommonParams, shouldUploadRawFile, timeoutInterval` | 上传 |
| `x.downloadFile` | `url, params, header, extension` | 下载 |
| `x.connectSocket` / `x.sendSocketData` / `x.closeSocket` | `url, header, callback` / data / `socketTaskID` | WebSocket 代理 |
| `x.saveDataURL` | `dataURL, filename, extension, saveToAlbum` | 保存 dataURL |
| `x.chooseMedia` | `maxCount` | 选图 |
| `x.getAppInfo` / `x.getAPIParams` / `x.getDebugInfo` / `x.getDeviceStat` / `x.getLocation` / `x.getClipboardData` / `x.copy` | — / — / — / `cpuUsage,memoryAll,memoryUse,memoryRest` / — / — / `content` | 设备与剪贴板 |
| `x.login` / `x.logout` / `x.getUserInfo` | `keepOpen, context(Map)` / — / — | 账号 |
| `x.open` / `x.close` | `schema` / `containerID, containerIDs` | 容器路由 |
| `x.getContainerID` / `x.getMethodList` / `x.getAllJSB` / `x.canIUse` / `x.getPreRender*` / `x.preRender` / `x.isPreRender` | `method` / — | 容器与预渲染 |
| `x.getStorageItem` / `x.setStorageItem` / `x.removeStorageItem` / `x.getStorageInfo` | `biz, key, data` | KV 存储 |
| `x.getUserDomainStorageItem` / `x.setUserDomainStorageItem` / `x.removeUserDomainStorageItem` | `key, data, expiredTime` | 用户维度存储 |
| `x.publishEvent` / `x.subscribeEvent` / `x.unsubscribeEvent` | `eventName, params, timestamp` | 事件中心 |
| `x.showToast` / `x.showModal` | — | UI |
| `x.startGyroscope` / `x.stopGyroscope` | — | 传感器（PC 上为空实现） |

**IES（无前缀）13 个**（`iesbridge/`，兼容头条系旧 JSAPI）：`fetch`（`url, method, headers, data, params, addCommonParams`）、`getStorage`/`setStorage`/`removeStorage`（`key, type, data, value`）、`appInfo`、`userInfo`、`apiParam`、`canIUse`（`method`）、`close`、`showToast`、`connectSocket`/`sendSocketData`/`closeSocket`。

**内部 2 个**：`internal.getGlobalProps(scheme)`、`internal.getEnvData()`。

### 7.3 返回码（`common/ResultHelper.js`）

| code | 含义 |
|---|---|
| `1` | SUCCESS |
| `0` | FAIL |
| `2` | KEY_NOT_FOUND |
| `-1` | UNAUTHORIZED（当前页面 URL 无权调用） |
| `-2` | UNREGISTERED（方法未注册） |
| `-3` | INVALID_PARAM |
| `-4` | UNKNOWN_HOST（不支持的 namespace） |
| `-5` | INVALID_RESULT |
| `-6` | UNAUTHORIZED_ACCESS（相机/麦克风等资源未授权） |

### 7.4 鉴权与安全策略

- 每个方法有 `access` 级别：`E_ACCESS{PUBLIC, PRIVATE, SECURE}`（本次 57 个全部 `PUBLIC`）。
- `JSBridgeManager` 的校验钩子 `auth = () => true`，**由宿主（抖音主进程）覆盖**以做域名/容器白名单；策略内容来自远程 `JSBMethodGroupMap`、`JSBSecurityStrategyContent`、`annieJSBConfig`。
- 未授权时返回 `UNAUTHORIZED(-1)`，副作用在 `security/index.js` 的埋点里（`SECURITY_TRACKING_EVENT_NAME`）。

### 7.5 Global Props（每个容器注入）

静态部分（`global-props/static-globalprops.js`）：`appLang, appName, appTheme(dark|light), appVersion, bulletVersion:"0.4.6", os("Windows"), osVersion, region, lynx_version:"3.0.0", lynxSdkVersion:"3.0.0", isPad, is32, isFoldableDevice, isLandScape, bottomHeight`；
直播容器额外注入：`devicePlatform:"desktop"、networkType:"wifi"、container_name:"annie"、webcast_sdk_version:"0.4.6"、accessible`。
动态部分：`extraGlobalProps`（宿主提供）+ scheme 的 `initialProps`（`initialProps` 参数为 JSON token 数组，服务端与端上约定）。

### 7.6 Session / 请求注入（全局生效）

`main/session/index.js`：
- 分区：`persist:annie-session`
- `webRequest.onBeforeSendHeaders`：合并宿主 `session.headers`（如 UA、Cookie 相关头）
- `webRequest.onBeforeRequest`（当 `channel && env` 配置时）：对 `http(s)` 请求追加 `x-tt-env=<channel>`；`env==="boe"` 追加 `X-USE-BOE=1`，`env==="ppe"` 追加 `x-use-ppe=1`；并强制写入 `app_version=6.9.0&version_name=6.9.0&aid=2048&app_id=2048&device_platform=iphone&gecko_bkt=0`（框架默认灰度标记）
- `setUserAgent(...)`、`setPreloads([preloadPath])`
- Gecko：`customInterceptBufferProtocol("https", …)` + `geckoHostWhiteList`

---

## 8. L5：系统级接口

### 8.1 自定义协议 `sslocal://`

语法（`common/scheme-parser.js`）：

```
sslocal://<path>?url=<encoded target>|surl=<encoded target>
                 &width=&height=&global_props=&initial_data=&should_full_screen=1&trans_status_bar=1
                 &channel=&bundle=&group=&gecko_channel=&resource_root_paths=&cdn_multiversion_params=
```

| path | 含义 |
|---|---|
| `webview` / `webview_popup` | WebView 容器 / 弹窗 |
| `lynxview` / `lynxview_popup` | Lynx 容器 / 弹窗（`resolvedUrl = lynxview://<channel>/<bundle>`） |
| `webcast_webview` / `webcast_lynxview` | 直播容器 |
| `activity/{live,aweme,h5}`、`webcast_room`、`chat/center`、`notice_list`、`notification` | 托盘推送落地页 |

页面侧 JSBridge 的 iframe 回调 scheme 为 `bytedance://`（兼容 `nativeapp://`、`bds://`），iframe id `__JSBridgeIframe_1.0__`。

### 8.2 命令行参数（真实可用的 CLI）

| 参数 | 来源 | 说明 |
|---|---|---|
| `--window-name=<MAIN_WINDOW\|SUB_WINDOW\|LIVE_WINDOW\|MULTI_WINDOW>` | `preload.js` | 标识窗口角色（决定是否初始化 web session） |
| `--webview-id=`、`--container-id=` | `preload.js` | 绑定 webview / 容器 |
| `--global-props=`、`--bridge-config=` | `preload.js` | 注入全局属性 / 桥配置 |
| `--isOpenContextIsolation=` | `preload.js` | 是否开启上下文隔离（决定用 `window.X` 还是 `contextBridge`） |
| `--multi_window_info=<json>` | `preload.js` | 多窗口排序信息 `{multi_window_order:n}` |
| `--getAppUserDataPath=` | `preload.js` | 覆盖 userData 路径 |
| `--driver_update` | 壳页面 | 驱动更新模式 |
| `-type=test-launch --start_type=installer --disable-features=MojoIpcz` | `%APPDATA%\douyin\launch_info\4080-launch_info.json` | 实测启动命令行 |

### 8.3 COM 提权服务（两个）

| 服务 | CLSID / IID | 注册表 | 校验 |
|---|---|---|---|
| `DouyinElevationService`（"Douyin Elevation Service"） | `{021126DF-2B48-41A7-8615-1ECB923010A8}` / `{022AB1B0-7ED5-42AC-84AF-6D927F504381}` | `SOFTWARE\ByteDance\douyin` | `verify_caller_cert:true`, `verify_caller_path:true`，允许签名主体 `Beijing Microlive Vision Technology Co., Ltd.`、`Douyin Vision Co., Ltd.` |
| `AppShellElevationService`（"AppShell Elevation Service"） | `{63C34537-A073-440B-A889-8BFDCCE724F3}` / `{9610CC02-0135-4554-BBA1-BA39A5673F4D}` | `SOFTWARE\ByteDance\AppShell` | 允许 `Beijing Microlive Vision Technology Co., Ltd.`、`Beijing Bytedance Network Technology Co.,Ltd.` |

两者的描述符是 **main.dll 内的明文字段**（`cls_id / iid / service_name / display_name / reg_key / oversea / verify_caller_cert / verify_caller_path / signatures`），由 `[elevator]` 模块解析（`elevation_service_const.cc`）。

### 8.4 局域网接口

- 依赖：`bonjour-service`、`multicast-dns`、`dns-packet`、`app.asar.unpacked\LANService.js`（mDNS 服务发现封装：`publish/unpublishAll/find/findOne`）。
- 桥命令：`handleLanMulticast`、`sendMulticastResult`；事件：`showLanMulticastPrompt`、`handleLanMulticast`；配置键：`lanMulticast`（默认值在宿主加密代码中，未能取出具体地址/端口）。
- 用途：同局域网设备互投（手机投屏/接力）与"局域网多播提示"。

### 8.5 文件 / 注册表 / 存储契约

| 路径 | 内容 |
|---|---|
| `%APPDATA%\douyin\douyin_app_config`（SQLite，表 `app_config(key,value)`） | `TipsFrequencyControl`、`PushWnsChannelToken` |
| `%APPDATA%\douyin\tt_Cookies`（SQLite，表 `cookies`/`temp_cookies`，字段与 Chromium 一致） | 登录态（本次为空，未登录过） |
| `%APPDATA%\douyin\native_config` | TTNet/HTTPDNS 参数（见 §5.2） |
| `%APPDATA%\douyin\TTNetCache\` | `server.json`、`tt_net_config.config`（`device_id&#*…@$*tnc_etag&#*…`）、`dig.bdurl.net_443`（DNS 缓存）、`netlog` |
| `%APPDATA%\douyin\tray_setting.json` | 远程配置真实响应 + `settings_time` |
| `%APPDATA%\douyin\perf_monitor_cfg.json` | 性能采样：`chromium_memory/cpu/fps/gpu/memory/hang(long_task_timeout_seconds, main_task_check_delay_ms)`、`sample_interval_seconds:5` |
| `%APPDATA%\douyin\launch_info\{pid}-launch_info.json`、`launch_log.json` | 启动链路埋点（`exe_main`、时间戳、cmdline） |
| `%APPDATA%\douyin\tt_crash_reporter_config.dat` | 崩溃上报配置（AES 加密） |
| `HKCU\Software\ByteDance\douyin` | `wid`（`wid-9aMJSACsUlp`）、`installerFile`（`douyin-downloader-v8.7.0-win32-ia32-douyin-wid-….exe`） |
| 卸载信息 | `Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\douyin`（guard/doctor 读写） |
| 安装目录 | `md5.json`（全量 MD5）、`launcher_config.json`、`shell_config.json`、`tt_electron_config.json`、`app-update.yml`、`tt_crash_reporter_config.dat` |

### 8.6 其它系统面

- **单实例/互斥**：`installerMutex: "Douyin_Mutex_Install"`；`main.dll` 内 `ServiceMutex.Local\`（`ipc_service_host.cc`）、`IpcServiceClient`（Browser↔Service 的命名 IPC）。
- **命名管道**：Crashpad `\\.\pipe\crashpad_<pid>_<n>`、Chromium Mojo `\\.\pipe\chrome.sync.*`、`\\.\pipe\mojo.*`。
- **提权服务安装**：`elevation_service.exe elevation_service_install|elevation_service_uninstall`（`Missing elevation service config`，配置即上面的 COM 描述符 JSON）。
- **卸载器**：`uninst.exe` + `uninstaller_reg_root` 注册表根（updater 解析）。
- **浏览器扩展关联**：`setExtensionAssociation / isExtensionAssociation / resetExtensionAssociation`。

---

## 9. 数据契约与配置项

### 9.1 配置文件一览

| 文件 | 关键字段 |
|---|---|
| `8.7.0\shell_config.json` | `appId, appSettingHost, updateConfigKey, appSettingAppId, appSettingHostOversea, appSettingAppIdOversea, teaReportHost(teaReportHostOversea), teaReportVersion, devicePlatform, minDiskSpace, installerMutex, binUpdateConfigKey` |
| `8.7.0\tt_electron_config.json` | `byteioAid:6383, mcsUrl, perfMonitor{cpu,gpu,hang,memory,appLaunch}` |
| `8.7.0\resources\app-update.yml` | `provider:generic, channel:latest, url, updaterCacheDirName` |
| `8.7.0\md5.json` | `{files:{<相对路径>:<md5>}}` |
| `launcher_config.json` | `app_name, cur_path, mid_path, need_update, new_path, installer_path` |
| `app.asar\package.json` | `version, buildId, branch, devPort:5005, homepage:https://tron.bytedance.net, deps(@annie/*, @bytebench/*, @byted/*)` |
| `%APPDATA%\douyin\native_config` | 见 §5.2 |
| `%APPDATA%\douyin\TTNetCache\{server.json,tt_net_config.config}` | 见 §5.2 |

### 9.2 应用配置键（28 个，`ConfigKey` 枚举）

`MiddleWareConfig`、`siteConf`、`routerFilterList`、`gameList`、`JSBMethodGroupMap`、`JSBSecurityStrategyContent`、`v8_max_old_space_size_mb`、`energyEfficientConfig`、`notifyMenu`、`htmlRetryFilterUrls`、`wallpaperConfig`、`enableDebugger`、`powerReportConfig`、`aboutInfo`、`driverUpdateConfig`、`renderTimeoutReload`、`checkBlackScreen`、`enableCertificateVerify`、`enableCertificateVerifyHostList`、`closeRightClickWallpaperMenu`、`annieJSBConfig`、`enableAppGuard`、`enableAppDoctor`、`ttnetConfig`、`libraConfig`、`lanMulticast`、`honorHandover`、`bdTicketConfig`。

> `honorHandover: true` 与 `@byted/honor-handover` 依赖说明客户端带"手机↔PC 接力（荣耀/多端）"能力；`libraConfig` 是 A/B 实验（Libra）通道。

### 9.3 容器主设置（`GET_CANS_MAIN_SETTING` 返回）

`appId, packageType, deviceId, slardarWebSdkPath, slardarWebParams, lynxEnableLynxLog, lynxviewMaxMemorySize, lynxviewMaxBlockTimes, lynxEnableVerify, sessionPartition, session(channel/env/headers), showDevtoolTag, geckoAKOnline, geckoAKTest, localConfigPath, appVersion` + `globalProps` + `initialProps` + `geckoChannelMap`（`main-manager.js:159-199`）。

---

## 10. 安全与风控机制观察

| 机制 | 证据 |
|---|---|
| 证书校验钩子 | 配置键 `enableCertificateVerify` + `enableCertificateVerifyHostList`（按 host 白名单开启校验） |
| 调用者校验（提权） | `verify_caller_cert` / `verify_caller_path` + 签名主体白名单 |
| 文件完整性 | `md5.json`、`tt_net_config` 的 `md5_check`、`app_shell_updater` 校验 |
| Lynx 包验签 | `sign_verify_mode(0/1/2)`、`gecko AK`（`geckoAKOnline/Test`）、错误码 `-1/-2/-5/101/2/3/4` |
| JSBridge 鉴权 | `JSBMethodGroupMap` / `JSB_AUTH` 远程策略 + `auth()` 钩子 + `E_ACCESS` 级别 |
| bdTicket / 设备指纹 | `bdTicketConfig`、`resetBdTicketGuardSecureState`、`signWithCustomPayload`、`mssdk\metasecml.dll`、`getDeviceRegisterInfo`、`/service/*/device_register*` |
| 反调试/反注入 | `destroyRenderProcess`、`enableDebugger`、`checkBlackScreen`、`renderTimeoutReload`；devtools 只在 `showDevtoolTag`/`enableDebugger` 时开 |
| 域名锁定 | `applogrs.dll`: "get custom domain lock failed!"（日志域名锁） |
| 推送安全 | `pc_push.dll` 内 cloudpush 回执必须带 sender/token |

**因此**：接口本身可枚举，但**受控调用需要账号 Cookie + 前端签名（X-Bogus/a_bogus/msToken）+ bdTicket 设备态**；本报告不给出任何绕过方法。

---

## 11. 复现步骤

```powershell
# 1) 解包 ASAR（无需 npm）
node tools\asar-list-file.js  D:\douyin\8.7.0\resources\app.asar x\asar_list.txt
node tools\asar-extract-file.js D:\douyin\8.7.0\resources\app.asar D:\douyin\x\asar

# 2) 提取 231 原生命令（数组位于 pages/driverUpdater/index.*.js）
node tools\extract-array.js "x/asar/pages/driverUpdater/index.4041f79871116072.js" '"sendMulticastResult"' x\native_api_array.txt array

# 3) 提取 JSBridge 方法表
node tools\bridge-map.js x\asar\node_modules\@annie\electron\dist\lib\main\bridge\xbridge x\asar\node_modules\@annie\electron\dist\lib\main\bridge\iesbridge x\asar\node_modules\@annie\electron\dist\lib\main\bridge\internal-bridge

# 4) 提取 IPC 通道 / API 路径 / 域名
node tools\ipc-scan.js x\asar 8.7.0\resources\app.asar.unpacked
node tools\api-scan.js x\asar\pages 8.7.0\tray\resources
node tools\harvest.js  x\hits 8.7.0\main.dll 8.7.0\tray\douyin_tray.exe 8.7.0\tray\pc_push.dll ...
node tools\aggregate.js x\hits

# 5) 生成本报告的清单产物
node tools\build-report.js
```

> 环境提示：本机沙箱对"大 stdout 管道"与 `reg.exe` 有拦截，脚本已改为直接写文件（`fs.writeFileSync`）。

---

## 12. 局限与未解部分

1. **`Common.Build-20260917T1141004.node`（14.6 MB）是业务主进程核心**，文件头为伪 ELF + 定制表（`289,A,118,A,...` 形式的长度/标志索引）+ 加密/压缩代码段，字符串提取只得到乱码。231 个命令的**具体实现、参数校验、返回结构**都在这里，静态无法还原（需要运行时 dump 解密后的 JS）。
2. `main.dll` 主体是 Chromium/V8/Node/Electron 的定制分支（含 `electron\shell\bytedance\*` 源码路径），业务逻辑极少；因此"客户端自身"的接口就是 §5~§8 这些。
3. `lanMulticast` 默认配置、`bdTicketConfig` 细节、`scc` 的请求体结构在加密 bundle 内，只能给出接口名与用途。
4. 未做动态验证（未运行客户端、未解密 `.dat` 加密配置、未抓 TLS 流量），文中"实时可调用的接口"均以静态证据为准。

---

## 附录 A：产物与证据索引

| 路径 | 说明 |
|---|---|
| [`README.md`](README.md) | 文档总览、阅读路径、数字来源 |
| [`接口总表.csv`](接口总表.csv) | 648 行扁平化总表（Excel 可直接打开） |
| [`_stats.json`](_stats.json) | 分类统计（总表与 README 的数字来源） |
| [`interfaces.json`](interfaces.json) | 全量结构化清单 |
| [`report/web-api-endpoints.md`](web-api-endpoints.md) | 192 条 Web API |
| [`report/hosts.md`](hosts.md) | 25 个远程域名 |
| [`report/native-commands.tsv`](native-commands.tsv) | 231 原生命令 |
| [`report/native-events.tsv`](native-events.tsv) | 20 原生事件 |
| `x\asar\` | ASAR 解包结果（含 `node_modules/@annie/electron` 源码） |
| `x\asar_list.txt` / `x\lynx_list.txt` | ASAR 文件清单 |
| `x\hits\`、`x\kw\`、`x\kw2\`、`x\kw3\` | 各二进制/资源的关键字符串与聚合表（`_aggregate.txt`） |
| `x\scan_*.txt` | 字节级扫描（scheme / pipe / COM / 域名） |
| `x\api_paths.txt`、`x\ipc_channels.txt`、`x\bridge_map.txt`、`x\native_api_array.txt` | 原始提取结果 |
| `x\cookies.txt`、`x\appconfig.txt` | 本地 SQLite 取证 |
| `x\ctx_*.txt` | 关键代码上下文片段 |
| `tools\*` | 全部自研分析脚本 |

## 附录 B：一句话速查表

```
业务 API      https://www.douyin.com/aweme/v1/web/...            (192 条)
远程配置      https://api.toutiaoapi.com/tfe/api/request_combine/v1?api_list=/service/settings/v3/
TNC           tnc3-bjlgy|alisc1|aliec2.zijieapi.com
HTTPDNS       dig.bdurl.net   (备份 IP 101.36.166.16/19)
日志          mcs.zijieapi.com / log.zijieapi.com / rtlog.zijieapi.com / log-klink.zijieapi.com / log.snssdk.com
监控          pc-mon.zijieapi.com / lf3-short.ibytedapm.com (slardar bid=electron_douyin_pc)
崩溃          crash.snssdk.com  (crashReporterAppId 330274222)
推送          wss://frontier.snssdk.com/ws/v2
IM            https://imapi.douyin.com/v1/message/get_message_by_init
cloudpush     /cloudpush/{app_notice_status,pull/psort/v2,update_token,update_sender,callback/client_*}
更新          https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/douyin-pc-client/releases/
Gecko         https://tosv.byted.org/obj/ies.fe.gecko/
URL 安全      https://scc.bytedance.com/scc_sdk/url_scan_v4?scc_mode=core&scc_from=TTWebview
JSB 鉴权      https://jsb.snssdk.com/src/server/v2/package
容器协议      sslocal://{webview,webview_popup,lynxview,lynxview_popup,webcast_*,activity/*,chat/center,...}
桥调用        window.__internal_invoke(name, payload)  /  window.JS2NativeBridge._invokeMethod(json)
提权服务      DouyinElevationService{021126DF-…} / AppShellElevationService{63C34537-…}
```
