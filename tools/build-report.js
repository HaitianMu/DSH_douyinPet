// Build the structured interface inventory (JSON + TSV appendix files) from extracted evidence.
const fs = require('fs');
const path = require('path');
const OUT = 'report';
fs.mkdirSync(OUT, { recursive: true });

function readLines(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

// 1) native commands + events from the app bundle array
const nativeCommands = JSON.parse(fs.readFileSync('x/native_api_array.txt', 'utf8'));
const pageSrc = fs.readFileSync('x/asar/pages/driverUpdater/index.4041f79871116072.js', 'utf8');
const evStart = pageSrc.indexOf('["THEME_CHANGE"');
const evEnd = pageSrc.indexOf('].forEach', evStart);
const nativeEvents = JSON.parse(pageSrc.slice(evStart, evEnd + 1));

// 2) JSBridge methods
const bridgeRows = readLines('x/bridge_map.txt').filter((l) => l.split('\t')[0]);
const jsbridge = bridgeRows.map((l) => {
  const [name, access, file, params] = l.split('\t');
  const layer = file.startsWith('xbridge') ? 'xbridge(anniex)' : file.startsWith('iesbridge') ? 'iesbridge(IES)' : 'internal';
  return { name, layer, access, params: params || '', impl: file };
});

// 3) IPC channels
const ipc = readLines('x/ipc_channels.txt').filter((l) => l.split('\t')[0]).map((l) => {
  const [channel, dirs, files] = l.split('\t');
  return { channel, direction: dirs, files: files.split(';').map((f) => f.replace('x/asar/', '').replace('8.7.0/', '')) };
});

// 4) IPC_EVENTS constants from @annie
const ipcEvents = [
  'BRIDGE_CONTEXT_CALLBACK_EVENT', 'BRIDGE_CONTEXT_SEND_JS_EVENT', 'BRIDGE_MAIN_RECEIVE_EVENT',
  'BRIDGE_RECEIVE_RENDERER_JSB_REGISTER', 'BRIDGE_RECEIVE_RENDERER_JSB_UNREGISTER',
  'MAIN_CALL_RENDERER_METHOD', 'MAIN_CALL_RENDERER_METHOD_CALLBACK', 'EVENTCENTER_MAIN_RECEIVE_EVENT',
  'BRIDGE_MAIN_RECORD_CONTAINER', 'GET_CANS_MAIN_SETTING', 'CANS_OPEN_H5_DEVTOOL', 'EVENTCENTER_MAIN_TRIGGER_EVENT',
];

// 5) web api paths grouped
const apiPaths = readLines('x/api_paths.txt').map((l) => l.split('\t')[0]);
const groups = {};
for (const p of apiPaths) {
  const seg = p.split('/').filter(Boolean);
  const key = seg.slice(0, 3).join('/');
  (groups[key] = groups[key] || []).push(p);
}
let webApiMd = '# 客户端内置 Web API 清单\n\n';
webApiMd += '来源：`8.7.0/resources/app.asar` -> `pages/{driverUpdater,settings,wallpaper}/index.*.js` 公共 chunk\n';
webApiMd += '（与 `ttnet_dispatch_actions` 的 `prefixes_group` 同源）。\nBase host：`https://www.douyin.com`（dispatch 规则 host_group）。\n\n';
webApiMd += `总计 ${apiPaths.length} 个路径。\n\n`;
for (const k of Object.keys(groups).sort()) {
  webApiMd += `## ${k}  (${groups[k].length})\n\n`;
  for (const p of groups[k].sort()) webApiMd += `- \`${p}\`\n`;
  webApiMd += '\n';
}
fs.writeFileSync(path.join(OUT, 'web-api-endpoints.md'), webApiMd);

// 6) hosts with roles
const hosts = [
  ['www.douyin.com', 'HTTPS', '业务主站 / WebView 页面 + /aweme/v1/web/* API 主入口（dispatch host_group）'],
  ['www-m.douyin.com -> www-hj.douyin.com', 'HTTPS', 'TTNet dispatch：mobile-web 域名按 IDC 权重改写'],
  ['api.toutiaoapi.com', 'HTTPS', '远程配置：/tfe/api/request_combine/v1、/service/settings/v3、/get_domains/v4'],
  ['imapi.douyin.com', 'HTTPS', 'IM 初始化：/v1/message/get_message_by_init'],
  ['frontier.snssdk.com', 'WSS', 'Frontier 长连接推送网关：/ws/v2（灰度 frontier-boe.bytedance.net）'],
  ['frontier-boe.bytedance.net', 'WSS', 'Frontier BOE 测试环境'],
  ['dig.bdurl.net', 'HTTPS/DNS', 'TTNet HTTPDNS 解析入口（net_dns_backup_map 固定 IP）'],
  ['tnc0-*/tnc3-*.zijieapi.com', 'HTTPS', 'TNC 下发 ttnet 配置'],
  ['mcs.zijieapi.com', 'HTTPS', 'mcs/tea 埋点上报（byteioAid=6383）；海外 maliva-mcs.byteoversea.com'],
  ['log.zijieapi.com / rtlog.zijieapi.com / log-klink.zijieapi.com / log.snssdk.com', 'HTTPS', 'applogrs.dll 日志上报域名'],
  ['crash.snssdk.com', 'HTTPS', '网络诊断 netlog 上传（domainNetlog）'],
  ['pc-mon.zijieapi.com', 'HTTPS', 'PC 性能/监控上报'],
  ['scc.bytedance.com', 'HTTPS', 'URL 安全扫描：/scc_sdk/url_scan_v4?scc_mode=core&scc_from=TTWebview'],
  ['jsb.snssdk.com', 'HTTPS', 'JSBridge 鉴权/分组配置：/src/server/v2/package'],
  ['lf3-config.bytetcc.com', 'HTTPS', 'TCC 动态配置（容灾/降级）'],
  ['tosv.byted.org / tosv-boe.byted.org', 'HTTPS', 'Gecko 离线包：/obj/ies.fe.gecko/'],
  ['lf-douyin-pc-web.douyinstatic.com', 'HTTPS', 'electron-updater 更新源：/obj/douyin-pc-web/douyin-pc-client/releases/'],
  ['lf3-static.bytednsdoc.com', 'HTTPS', '静态资源 CDN（许可图、引导图、字体）'],
  ['lf3-short.ibytedapm.com', 'HTTPS', 'Slardar 前端监控 SDK'],
  ['p3-pc.douyinpic.com / p3-pc-sign / p11.douyinpic.com', 'HTTPS', '图片 CDN（签名 URL）'],
  ['p6-webcast-game-sign.byteimg.com', 'HTTPS', '直播/游戏图片 CDN'],
  ['ecom.douyin.com', 'HTTPS', '电商交易 H5（透传 aid=6383）'],
  ['webcast.amemv.com', 'HTTPS', '直播 Web API 域名'],
  ['data.bytedance.net', 'HTTPS', '埋点实时调试台（debugtool 页引用）'],
  ['tron/anniex/argus.bytedance.net', 'HTTPS', '内网文档与框架主页（仅字符串引用，运行时不可达）'],
];
let hostsMd = '# 远程接口域名清单\n\n| 域名 | 协议 | 用途 / 证据 |\n| --- | --- | --- |\n';
for (const [h, p, u] of hosts) hostsMd += `| \`${h}\` | ${p} | ${u} |\n`;
fs.writeFileSync(path.join(OUT, 'hosts.md'), hostsMd);

// 7) native command TSV
fs.writeFileSync(path.join(OUT, 'native-commands.tsv'), ['#command', ...nativeCommands].join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'native-events.tsv'), ['#event', ...nativeEvents].join('\n') + '\n');

const inventory = {
  product: {
    name: 'douyin (抖音 PC 客户端)',
    version: '8.7.0',
    buildId: '495279540',
    electron: '36.4.0-rs.33.release.pgo.0',
    aid: 6383,
    appSettingAppId: 430651,
    appSettingAppIdOversea: 423531,
  },
  counts: {
    nativeCommands: nativeCommands.length,
    nativeEvents: nativeEvents.length,
    jsbridgeMethods: jsbridge.length,
    ipcChannels: ipc.length,
    ipcEventConstants: ipcEvents.length,
    webApiPaths: apiPaths.length,
    hosts: hosts.length,
  },
  nativeCommands,
  nativeEvents,
  jsbridge,
  ipcChannels: ipc,
  ipcEventConstants: ipcEvents,
  webApiPaths: apiPaths,
  hosts: hosts.map(([host, protocol, usage]) => ({ host, protocol, usage })),
  schemes: [
    { scheme: 'sslocal://webview?url=', usage: '内部路由：打开 WebView 容器' },
    { scheme: 'sslocal://webview_popup?url=', usage: '弹窗 WebView' },
    { scheme: 'sslocal://lynxview?url=|channel=&bundle=', usage: '打开 Lynx 容器（Gecko 离线包）' },
    { scheme: 'sslocal://lynxview_popup?...', usage: '弹窗 Lynx 容器' },
    { scheme: 'sslocal://webcast_webview?url=', usage: '直播 WebView 容器' },
    { scheme: 'sslocal://webcast_lynxview?url=', usage: '直播 Lynx 容器' },
    { scheme: 'sslocal://activity/{live,aweme,h5}?...', usage: 'tray 推送落地路由' },
    { scheme: 'sslocal://webcast_room?web_rid=&enter_method=', usage: '直接进直播间' },
    { scheme: 'sslocal://chat/center?conv_short_id=&conversation_id=', usage: '打开私信会话' },
    { scheme: 'sslocal://notice_list | sslocal://notification', usage: '通知中心' },
    { scheme: 'bytedance:// | nativeapp:// | bds://', usage: 'JSBridge iframe 回调 scheme（页面侧）' },
    { scheme: 'aweme://', usage: '壁纸/本地视频资源引用前缀' },
  ],
  configKeys: [
    'MiddleWareConfig', 'siteConf', 'routerFilterList', 'gameList', 'JSBMethodGroupMap', 'JSBSecurityStrategyContent',
    'v8_max_old_space_size_mb', 'energyEfficientConfig', 'notifyMenu', 'htmlRetryFilterUrls', 'wallpaperConfig',
    'enableDebugger', 'powerReportConfig', 'aboutInfo', 'driverUpdateConfig', 'renderTimeoutReload', 'checkBlackScreen',
    'enableCertificateVerify', 'enableCertificateVerifyHostList', 'closeRightClickWallpaperMenu', 'annieJSBConfig',
    'enableAppGuard', 'enableAppDoctor', 'ttnetConfig', 'libraConfig', 'lanMulticast', 'honorHandover', 'bdTicketConfig',
  ],
};
fs.writeFileSync(path.join(OUT, 'interfaces.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify(inventory.counts));
