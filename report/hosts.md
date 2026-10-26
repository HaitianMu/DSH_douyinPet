# 远程接口域名清单

| 域名 | 协议 | 用途 / 证据 |
| --- | --- | --- |
| `www.douyin.com` | HTTPS | 业务主站 / WebView 页面 + /aweme/v1/web/* API 主入口（dispatch host_group） |
| `www-m.douyin.com -> www-hj.douyin.com` | HTTPS | TTNet dispatch：mobile-web 域名按 IDC 权重改写 |
| `api.toutiaoapi.com` | HTTPS | 远程配置：/tfe/api/request_combine/v1、/service/settings/v3、/get_domains/v4 |
| `imapi.douyin.com` | HTTPS | IM 初始化：/v1/message/get_message_by_init |
| `frontier.snssdk.com` | WSS | Frontier 长连接推送网关：/ws/v2（灰度 frontier-boe.bytedance.net） |
| `frontier-boe.bytedance.net` | WSS | Frontier BOE 测试环境 |
| `dig.bdurl.net` | HTTPS/DNS | TTNet HTTPDNS 解析入口（net_dns_backup_map 固定 IP） |
| `tnc0-*/tnc3-*.zijieapi.com` | HTTPS | TNC 下发 ttnet 配置 |
| `mcs.zijieapi.com` | HTTPS | mcs/tea 埋点上报（byteioAid=6383）；海外 maliva-mcs.byteoversea.com |
| `log.zijieapi.com / rtlog.zijieapi.com / log-klink.zijieapi.com / log.snssdk.com` | HTTPS | applogrs.dll 日志上报域名 |
| `crash.snssdk.com` | HTTPS | 网络诊断 netlog 上传（domainNetlog） |
| `pc-mon.zijieapi.com` | HTTPS | PC 性能/监控上报 |
| `scc.bytedance.com` | HTTPS | URL 安全扫描：/scc_sdk/url_scan_v4?scc_mode=core&scc_from=TTWebview |
| `jsb.snssdk.com` | HTTPS | JSBridge 鉴权/分组配置：/src/server/v2/package |
| `lf3-config.bytetcc.com` | HTTPS | TCC 动态配置（容灾/降级） |
| `tosv.byted.org / tosv-boe.byted.org` | HTTPS | Gecko 离线包：/obj/ies.fe.gecko/ |
| `lf-douyin-pc-web.douyinstatic.com` | HTTPS | electron-updater 更新源：/obj/douyin-pc-web/douyin-pc-client/releases/ |
| `lf3-static.bytednsdoc.com` | HTTPS | 静态资源 CDN（许可图、引导图、字体） |
| `lf3-short.ibytedapm.com` | HTTPS | Slardar 前端监控 SDK |
| `p3-pc.douyinpic.com / p3-pc-sign / p11.douyinpic.com` | HTTPS | 图片 CDN（签名 URL） |
| `p6-webcast-game-sign.byteimg.com` | HTTPS | 直播/游戏图片 CDN |
| `ecom.douyin.com` | HTTPS | 电商交易 H5（透传 aid=6383） |
| `webcast.amemv.com` | HTTPS | 直播 Web API 域名 |
| `data.bytedance.net` | HTTPS | 埋点实时调试台（debugtool 页引用） |
| `tron/anniex/argus.bytedance.net` | HTTPS | 内网文档与框架主页（仅字符串引用，运行时不可达） |
