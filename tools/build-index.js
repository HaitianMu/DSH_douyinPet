// Consolidate the reverse-engineering inventory into:
//   report/接口总表.csv   - one flat table of every interface
//   report/README.md      - navigation + key numbers for the whole report set
const fs = require('fs');
const path = require('path');
const inv = require('./../report/interfaces.json');

const OUT = 'report';

// ---------- 1. native command classification (ordered rules) ----------
const CMD_RULES = [
  ['窗口/托盘', /^(WINDOW_|MAIN_WINDOW_|THEME_CHANGE|CHANGE_THEME|GET_ALL_WINDOW_DATA|SWITCH_PROXY$|SET_CLOSE_TO_TRAY|SET_MINIMIZE_TO_TRAY|GET_MINIMIZE_INFO|CHANGE_TO_SMALL_MODE|CHANGE_TO_ORIGINAL_MODE|SET_ALWAYS_ON_TOP|IS_ALWAYS_ON_TOP|changeMiniWindow|isMiniWindow|pipParent|mainViewMoveTop|mainWindowShowView|setMinimumSize|setLandingMode|showDouyinWindow|setFullScreen|SET_FULL_SCREEN|IS_WINDOW_FULLSCREEN|GET_IS_FRONT_SHOW|GET_ALL_DISPLAYS|GET_PRIMARY_DISPLAY|updateWinWithoutTransparent|destroyRenderProcess)/],
  ['导航/容器', /^(CAN_GO_BACK|NAVIGATION_GO_BACK|GO_BACK|RELOAD|PAGE_READY|RELOAD_FROM_ID|REFRESH_WEBVIEW|isTopWebview|openInternalBrowser|internalBrowserBack|openSchema|openSiteInOuterBrowser|BROWSER_VIEW_READY|RSC_STREAM_CHUNK|PREFETCH_FALLBACK_SSR|CLOSE_PARENT|EXEC_BY_CLIENT|openLynx|getLynxInfo|getIsLynxStart|closeLynxWindow|showWindowByWebWhenLynx|createMultitaskingWindow|getMultitaskingWindowCount|showErrorPage|gotoLandingPage|goToHelpPage)/],
  ['调试', /(DEV_TOOLS|DevTools|DevTool|Debug|debug|GET_ALL_CLIENT_LOG)/],
  ['配置/存储/缓存', /(STORAGE|STORE_ITEM|APP_CONFIG_ITEM|GET_SETTINGS|getSettingByKey|MMKV|MMkv|localStorage|sessionStorage|PreloadNodeConfig|GET_PAGE_STORE|getPageStoreSync|initPageStore|Cache|cache)/],
  ['网络/代理/请求头', /(^POST$|^GET$|MODIFY_REQUEST_HEADER|SWITCH_PROXY|UPLOAD_PROXY_CONFIG|getEnvHeader|isOnline|IS_ONLINE|getWebId|getCookieChangeInfo|^cookies\.|CLEAR_COOKIE|SYNC_LOGIN_STATE|getWebAuthLocalStorage|setWebAuthLocalStorage)/i],
  ['设备/系统信息', /(getDeviceInfo|getSystemInfo|getCsrInitialData|getDeviceRegisterInfo|getPerformanceInfo|getMonitorInfo|getBatteryInfo|getGPU|getMemoryInfo|getMetrics|getAppMetrics|getVolumeInfo|getVideoSideBar|setVideoSideBar|getHardwareDecode|setHardwareDecode|SET_VOLUME_BALANCE_CLOSE|GET_VOLUME_BALANCE_CLOSE|isWin7orOlder|getAppInstallPath)/i],
  ['自启动/系统设置', /^(SET_AUTO_START|GET_AUTO_START|SET_ALWAYS_ON_TOP|IS_ALWAYS_ON_TOP)/],
  ['身份/版本', /^(GET_CHANNEL_ID|GET_WID|GET_USER_UNIQUE_ID|GET_GUID|GET_VERSION|GET_APP_VERSION|GET_BUILD_ID|IS_DEV|GET_IS_MAS|getVersion)/],
  ['桌面/壁纸/小组件', /(Wallpaper|wallpaper|WALLPAPER|Desktop|desktop|WIDGET|Widget|TrayLog|trayLog|moveAboveWidget|InsertWallpaper)/],
  ['游戏小部件', /(Game|game)/],
  ['下载/文件', /(DOWNLOAD|download|WRITE_FILE|USER_FILE_IS_EXIST|SHOW_OPEN_DIALOG|showItemInFolder|openFolder|openBaseFolder|getVideoDownloadPath|cancelVideoDownload|openDownloadFile|pauseDownloadFile|resumeDownloadFile|getDownloadFileStatus|getDownloadFileIsExist)/],
  ['更新/驱动/诊断', /(UPDATE|update|Driver|driver|Crash|crash|UPLOAD_LOG|parfaitLog|STAT|stat|printFirstFeedShow|switchToRecommend)/],
  ['安全/风控/媒体权限', /(bdTicket|Guard|guard|MediaAccess|MEDIA_ACCESS|getIsFrontShow|ExtensionAssociation|extensionAssociation|signWithCustomPayload)/i],
  ['局域网', /(Lan|LAN|Multicast|multicast)/],
  ['杂项', /(IAP|iap|Quit|Relaunch|relaunch|bytebench|setCrashInfo|postMessage|sendMulticastResult)/i],
];
function classifyCommand(name) {
  for (const [cat, re] of CMD_RULES) if (re.test(name)) return cat;
  return '其它';
}

// ---------- 2. web api classification ----------
function classifyApi(p) {
  const s = p.toLowerCase();
  if (s.includes('/im/')) return '私信/IM';
  if (s.includes('/ecom/') || s.includes('/shop/') || s.includes('/content_pay/') || s.includes('/commerce/')) return '电商/支付';
  if (s.includes('/danmaku/')) return '弹幕';
  if (s.includes('/comment/') || s.includes('/commit/')) return '互动/评论';
  if (s.includes('/user/') || s.includes('follow')) return '用户/关系';
  if (s.includes('/series/') || s.includes('/mix/') || s.includes('/long/video') || s.includes('/lvideo/') || s.includes('/show/')) return '长视频/合集';
  if (s.includes('/hot/search') || s.includes('/search') || s.includes('suggest') || s.includes('/challenge/')) return '搜索/热点';
  if (s.includes('/activity/') || s.includes('/summer/') || s.includes('/olympics/') || s.includes('/college/') || s.includes('/music/')) return '运营/活动/音乐';
  if (s.includes('/collects/') || s.includes('/history/') || s.includes('/watchlater/')) return '收藏/历史';
  if (s.includes('/wallpaper/')) return '壁纸/桌面';
  if (s.includes('/order/') || s.includes('/pay/')) return '电商/支付';
  if (s.includes('/aweme/')) return '视频/作品';
  if (s.includes('/cloudpush/') || s.includes('/notice') || s.includes('/pull/notify') || s.includes('/notification')) return '通知/推送';
  return '其它';
}

// ---------- 3. build rows ----------
const rows = [];
const esc = (v) => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function add(layer, type, name, detail, note, evidence) {
  rows.push([layer, type, name, detail, note, evidence].map(esc));
}

// hosts
for (const h of inv.hosts) add('L2 远程', 'HTTP/WSS 域名', h.host, h.protocol, h.usage, 'report/hosts.md');

// specific remote endpoints
const ENDPOINTS = [
  ['远程配置', 'GET api.toutiaoapi.com/tfe/api/request_combine/v1/?api_list=/service/settings/v3/', 'aid=6383 / appSettingAppId=430651；响应 body.data.settings.douyin_web_pc', 'main.dll@162497561'],
  ['远程配置', 'GET api.toutiaoapi.com/service/settings/v3/?app=1', 'app guard 配置（430651/6383/appguard_version…）→ Download URL / MD5 / Args', 'douyin_guard.exe'],
  ['远程配置', 'GET api.toutiaoapi.com/service/settings/v2/?app=1&caller_name=tt_webview', 'TTWebView TNC 配置', 'main.dll@162630641'],
  ['远程配置', 'GET api.toutiaoapi.com/get_domains/v4/', '域名列表下发', 'main.dll@185474545'],
  ['远程配置', 'GET lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-ies.auc.config-default', 'TCC 容灾/降级配置（safe_urls、channel_whitelist）', 'security/constants.js:41'],
  ['远程配置', 'GET jsb.snssdk.com/src/server/v2/package', 'JSBridge 鉴权/方法分组包', 'security/constants.js:43'],
  ['网络', 'TNC 下发 tnc0/tnc3-*.zijieapi.com', 'server.json：send_tnc_host_arrays、ttnet_http_dns_addr、dispatch_actions', 'TTNetCache/server.json'],
  ['网络', 'HTTPDNS dig.bdurl.net', 'net_dns_backup_map → 101.36.166.16 / 101.36.166.19', '%APPDATA%/douyin/native_config'],
  ['网络', 'URL dispatch 规则（rule_id 350696 / service_name jump_east_path / sign 93fcfb3c…）', '按 host+path 前缀选路，含 /service/*/device_register*、/passport/*', 'pages/driverUpdater chunk'],
  ['日志', 'POST mcs.zijieapi.com', 'tea/mcs 埋点（byteioAid=6383，teaReportVersion=1.0.4）', 'shell_config.json / tt_electron_config.json'],
  ['日志', 'log.zijieapi.com / rtlog.zijieapi.com / log-klink.zijieapi.com / log.snssdk.com', 'applogrs.dll 日志通道（域名锁）', 'applogrs.dll@1231008'],
  ['监控', 'pc-mon.zijieapi.com', 'PC 性能监控上报', 'douyin_performance_service.dll'],
  ['监控', 'lf3-short.ibytedapm.com/slardar/… (bid=electron_douyin_pc)', '前端监控 Slardar', 'pages chunk'],
  ['崩溃', 'crash.snssdk.com', 'netlog 上传 + 崩溃上报（crashReporterAppId 330274222）', 'main.dll / douyin_doctor.exe'],
  ['推送', 'WSS wss://frontier.snssdk.com/ws/v2', '长连接推送网关（BOE: frontier-boe.bytedance.net）', 'douyin_tray.exe'],
  ['推送', 'GET imapi.douyin.com/v1/message/get_message_by_init', 'IM 初始化', 'douyin_tray.exe'],
  ['推送', 'www.douyin.com/cloudpush/{app_notice_status,pull/psort/v2,update_token,update_sender,callback/client_*}', '推送拉取与回执', 'douyin_tray.exe / pc_push.dll'],
  ['更新', 'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/douyin-pc-client/releases/', 'electron-updater generic feed（latest.yml/blockmap）', 'resources/app-update.yml'],
  ['安全', 'GET scc.bytedance.com/scc_sdk/url_scan_v4?scc_mode=core&scc_from=TTWebview', 'URL 安全扫描', 'main.dll'],
  ['离线包', 'tosv.byted.org/obj/ies.fe.gecko/', 'Gecko 离线包下发桶', 'douyin_tray.exe'],
];
for (const [t, n, d, e] of ENDPOINTS) add('L2 远程', t + ' 端点', n, '', d, e);

// web api
for (const p of inv.webApiPaths) add('L1 业务 API', classifyApi(p), p, '', '基址 https://www.douyin.com', 'app.asar pages chunk');

// native commands
for (const c of inv.nativeCommands) add('L3 主进程', '原生命令 ' + classifyCommand(c), c, '', 'ipcRenderer.invoke/send 通道；preload 暴露 __internal_invoke', 'pages/driverUpdater chunk');

// native events
for (const e of inv.nativeEvents) add('L3 主进程', '原生事件', e, '', 'main → renderer 事件', 'pages/driverUpdater chunk');

// ipc channels
for (const c of inv.ipcChannels) add('L3 主进程', 'Electron IPC', c.channel, c.direction, '', c.files.join('; '));
for (const c of inv.ipcEventConstants) add('L3 主进程', 'IPC 常量', c, '', 'IPC_EVENTS 常量（anniex 容器）', '@annie/electron common/constanst.js');

// jsbridge
for (const m of inv.jsbridge) add('L4 JSBridge', m.layer, m.name, m.params, 'access=' + m.access, m.impl);

// schemes
for (const s of inv.schemes) add('L5 系统', '自定义协议', s.scheme, '', s.usage, 'common/constanst.js + tray');

// cli args
const CLI = [
  ['--window-name=', 'MAIN_WINDOW/SUB_WINDOW/LIVE_WINDOW/MULTI_WINDOW'],
  ['--webview-id=', '绑定 webview'],
  ['--container-id=', '绑定容器'],
  ['--global-props=', '注入全局属性'],
  ['--bridge-config=', '注入桥配置'],
  ['--isOpenContextIsolation=', '上下文隔离开关'],
  ['--multi_window_info=', '多窗口排序 JSON'],
  ['--getAppUserDataPath=', '覆盖 userData 路径'],
  ['--driver_update', '驱动更新模式'],
  ['-type= / --start_type=', '启动类型（installer 等）'],
];
for (const [a, d] of CLI) add('L5 系统', '命令行参数', a, '', d, 'preload.js / launch_info');

// COM
add('L5 系统', 'COM 提权服务', 'DouyinElevationService', '{021126DF-2B48-41A7-8615-1ECB923010A8} / {022AB1B0-7ED5-42AC-84AF-6D927F504381}', 'reg SOFTWARE\\ByteDance\\douyin；verify_caller_cert+path', 'main.dll @198404740');
add('L5 系统', 'COM 提权服务', 'AppShellElevationService', '{63C34537-A073-440B-A889-8BFDCCE724F3} / {9610CC02-0135-4554-BBA1-BA39A5673F4D}', 'reg SOFTWARE\\ByteDance\\AppShell', 'app_shell_updater.exe / douyin_doctor.exe');

// config keys
for (const k of inv.configKeys) add('L3 主进程', '应用配置键', k, '', 'ConfigKey 枚举（config 下发/读写）', 'pages/driverUpdater chunk');

// local files
const FILES = [
  ['%APPDATA%\\douyin\\douyin_app_config', 'SQLite app_config：TipsFrequencyControl / PushWnsChannelToken'],
  ['%APPDATA%\\douyin\\tt_Cookies', 'SQLite cookies（Chromium 结构）'],
  ['%APPDATA%\\douyin\\native_config', 'TTNet / HTTPDNS 参数'],
  ['%APPDATA%\\douyin\\TTNetCache\\{server.json,tt_net_config.config,dig.bdurl.net_443}', 'TNC / DNS 缓存'],
  ['%APPDATA%\\douyin\\tray_setting.json', '远程配置真实响应'],
  ['%APPDATA%\\douyin\\launch_info\\*.json', '启动链路埋点（含真实 cmdline）'],
  ['HKCU\\Software\\ByteDance\\douyin', 'wid / installerFile'],
  ['安装目录\\md5.json', '全量文件 MD5 清单'],
  ['安装目录\\launcher_config.json', '版本指针'],
];
for (const [f, d] of FILES) add('L5 系统', '本地数据契约', f, '', d, '本机取证');

// ---------- 4. write csv ----------
const header = ['层', '类型', '名称/路径', '参数/标识', '说明', '证据来源'];
const csv = '\ufeff' + [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
fs.writeFileSync(path.join(OUT, '接口总表.csv'), csv);

// ---------- 5. stats for README ----------
const byLayer = {};
for (const r of rows) byLayer[r[0]] = (byLayer[r[0]] || 0) + 1;
const nativeCats = {};
for (const c of inv.nativeCommands) {
  const k = classifyCommand(c);
  nativeCats[k] = (nativeCats[k] || 0) + 1;
}
const apiCats = {};
for (const p of inv.webApiPaths) {
  const k = classifyApi(p);
  apiCats[k] = (apiCats[k] || 0) + 1;
}
const unclassified = inv.nativeCommands.filter((c) => classifyCommand(c) === '其它');

fs.writeFileSync(path.join(OUT, '_stats.json'), JSON.stringify({ byLayer, nativeCats, apiCats, unclassified }, null, 2) + '\n');
console.log('rows=' + rows.length);
console.log(JSON.stringify({ byLayer, nativeCats, apiCats, unclassified }, null, 2));
