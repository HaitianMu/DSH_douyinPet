# 安装

本版本是基于上游1.4.14扩展的2.0.0源码，尚未发布 npm 软件包。需要 DSH ≥0.1.7、支持 node:sqlite 的 Node.js 22.16+ 运行时，以及现成的 Edge 或 Chrome；建议使用24 LTS。

首次使用请看 [完整运行指南](docs/running.md)，包含安装、启动、模型配置、记忆、定时、备份和排错。

本机源码已在 F:\GitProgramManager\dsh-douyin。把 profile 换成实际使用的名称：

~~~powershell
dsh plugin --profile desktop add link:F:\GitProgramManager\dsh-douyin
~~~

重启 DSH 后，在「设置 → 刷抖音」配置、登录。浏览器自检会真实连接抖音，需要你主动点击。基础文本模型由 headless profile 配置；OCR 默认启用，视觉模型需单独配置兼容 API。

从源码仓库直接安装也可以：`dsh plugin --profile desktop add github:TianmuTan/dsh-douyin`。两种安装方式选一种，profile 换成实际名称。

默认不开启定时、自动收藏或自动发言。先用逐条审核，检查生成的日报、草稿和独立记忆。需要每天回顾时设置每日固定时间，并保持 DSH 运行。

在「记忆与成长」设置监护人和独立亲戚；分享目标另外填写精确白名单。人格指导仅接受文字，不读取 B 站路径。不要将 B 站运行目录作为抖音数据目录。

实际数据目录见设置页，通常为 $DSH_HOME/douyin-duty/。升级前停止运行并备份；自定义 duty.md 不覆盖，新章程另存 duty.md.new，手工合并后使用。

离线验证运行 npm test 与 npm run check。遇到 node:sqlite 不支持的提示，需要升级真正执行插件的运行时，仅升级终端 Node 可能不足以改变桌面版宿主。
