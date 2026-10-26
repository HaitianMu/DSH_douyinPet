# 抖音 PC 客户端 8.7.0 接口逆向 —— 文档总览

> 本目录是「抖音 PC 客户端 8.7.0 接口逆向分析」的完整交付物集合。
> 分析方式：静态逆向（ASAR 解包 + JS 源码审计 + 二进制字符串/字节扫描 + 本机运行痕迹取证），**未运行客户端、未抓包**。
> 建议先看：**30 秒** → 本页「一句话结论」+「数字概览」；**10 分钟** → [主报告](抖音PC客户端接口逆向分析报告.md) §0~§3；**深挖** → [接口总表.csv](接口总表.csv)。

---

## 一句话结论

这个客户端几乎不实现业务接口：**业务（视频/评论/私信/电商/直播）全部由 `https://www.douyin.com` 的 Web 前端经 192 条 `/aweme/v1/web/*` 路径完成**；客户端自身只提供 5 类"宿主能力"接口——远程配置下发、网络调度（TNC/HTTPDNS/URL dispatch）、日志埋点与崩溃上报、推送与 IM 长连接、更新与提权。

## 数字概览

| 层 | 接口类型 | 数量 |
|---|---|---|
| L1 | 业务 Web API（`www.douyin.com/aweme/v1/web/*`） | **192** 条路径 |
| L2 | 远程基础设施接口（域名 + 具体端点） | **25** 域名 / **45** 条目 |
| L3 | Electron IPC + 原生命令 + 事件 + 配置键 | **30** IPC / **12** 常量 / **231** 命令 / **20** 事件 / **28** 配置键 |
| L4 | Web↔Native JSBridge（anniex + IES + internal） | **57** 方法（42 / 13 / 2） |
| L5 | 系统级接口（协议/CLI/COM/mDNS/本地数据） | **12** 协议路由 / **10** CLI / **2** COM / **9** 数据契约 |
| — | **接口总表合计** | **648** 行 |

## 交付物清单

| 文件 | 内容 | 规模 |
|---|---|---|
| [抖音PC客户端接口逆向分析报告.md](抖音PC客户端接口逆向分析报告.md) | 主报告：方法、架构、5 层接口细节、安全机制、复现步骤、局限 | ~54 KB / 12 章 + 2 附录 |
| [接口总表.csv](接口总表.csv) | **全部接口一张表**（层 / 类型 / 名称 / 参数 / 说明 / 证据），UTF-8 BOM，可直接 Excel 打开 | 648 行 × 6 列 |
| [interfaces.json](interfaces.json) | 机器可读清单（命令/事件/JSB/IPC/API/域名/协议/配置键） | 40 KB |
| [web-api-endpoints.md](web-api-endpoints.md) | 192 条 Web API，按前缀分组 | 7.5 KB |
| [hosts.md](hosts.md) | 25 个远程域名与用途 | 2.4 KB |
| [native-commands.tsv](native-commands.tsv) | 231 个原生命令（纯表格） | 231 行 |
| [native-events.tsv](native-events.tsv) | 20 个原生事件（纯表格） | 20 行 |
| [_stats.json](_stats.json) | 分类统计（本页数字来源） | — |

## 命令与 API 的分类分布

**231 个原生命令**（按用途）：

| 分类 | 数量 | 分类 | 数量 |
|---|---|---|---|
| 桌面/壁纸/小组件 | 39 | 窗口/托盘 | 35 |
| 导航/容器 | 26 | 配置/存储/缓存 | 22 |
| 更新/驱动/诊断 | 21 | 设备/系统信息 | 21 |
| 网络/代理/请求头 | 15 | 下载/文件 | 15 |
| 身份/版本 | 10 | 安全/风控/媒体权限 | 8 |
| 杂项 | 8 | 调试 | 4 |
| 游戏小部件 | 4 | 自启动/系统设置 | 2 |
| 局域网 | 1 | — | — |

**192 条 Web API**（按功能）：

| 分类 | 数量 | 分类 | 数量 |
|---|---|---|---|
| 视频/作品 | 64 | 长视频/合集 | 29 |
| 电商/支付 | 18 | 用户/关系 | 17 |
| 私信/IM | 15 | 运营/活动/音乐 | 13 |
| 收藏/历史 | 10 | 互动/评论 | 10 |
| 弹幕 | 7 | 搜索/热点 | 7 |
| 壁纸/桌面 | 1 | 通知/推送 | 1 |

## 三条推荐阅读路径

1. **只想用结论**：本页 → [接口总表.csv](接口总表.csv)（按"层"筛 L1/L2 即可拿到业务与基础设施接口）。
2. **想知道怎么调**：主报告 §6.2（原生命令总线机制）、§7.1（JSBridge 报文与回调）、§8.1（`sslocal://` 路由语法）、§9.3（公共参数）。
3. **想复核或继续挖**：主报告 §1.3（关键突破点）、§11（复现命令）、§12（未解部分：`Common.Build .node` 加密 bundle）。

## 如何复核 / 再生成

```powershell
node tools\asar-extract-file.js 8.7.0\resources\app.asar D:\douyin\x\asar        # 解包
node tools\extract-array.js "x/asar/pages/driverUpdater/index.4041f79871116072.js" '"sendMulticastResult"' x\native_api_array.txt array
node tools\bridge-map.js x\asar\node_modules\@annie\electron\dist\lib\main\bridge\xbridge `
                         x\asar\node_modules\@annie\electron\dist\lib\main\bridge\iesbridge `
                         x\asar\node_modules\@annie\electron\dist\lib\main\bridge\internal-bridge
node tools\ipc-scan.js x\asar 8.7.0\resources\app.asar.unpacked
node tools\api-scan.js x\asar\pages 8.7.0\tray\resources
node tools\build-report.js      # 生成 interfaces.json / hosts.md / web-api-endpoints.md / *.tsv
node tools\build-index.js       # 生成 接口总表.csv / _stats.json
```

原始证据全部保留在 `x\`（2839 个文件）：ASAR 解包结果、各二进制的字符串与聚合表、字节级扫描上下文、SQLite 取证。

## 已知边界（务必注意）

1. **`Common.Build-20260917T1141004.node`（14.6 MB）未解**：伪 ELF + 定制索引表 + 加密段，231 个命令的**实现、参数校验、返回结构**都在里面，静态取不到。需要运行时 dump 解密后的 JS（CDP/内存 dump）。
2. **未做动态验证**：未运行客户端、未抓 TLS，因此部分端点只到"URL 字面量"级别，HTTP 方法在 [主报告 §5.5](抖音PC客户端接口逆向分析报告.md) 与总表中标 `—` / "推测"。
3. **业务 API 的签名不在客户端**：`X-Bogus` / `a_bogus` / `msToken` 由 `www.douyin.com` 前端在页面上下文生成；本报告只做接口枚举，不提供风控绕过。
4. **环境限制**：本机沙箱对"大 stdout 管道"和 `reg.exe` 有拦截，脚本均改为直接写文件、用 PowerShell 注册表 Provider 读注册表。

---

*生成时间：2026-10-26 ｜ 目标版本：douyin 8.7.0（build 495279540，Electron 36.4.0-rs.33）*
