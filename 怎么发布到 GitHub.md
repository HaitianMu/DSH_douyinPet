# 推送源码与发布软件包

本项目源码仓库为 [TianmuTan/dsh-douyin](https://github.com/TianmuTan/dsh-douyin)，本机 `origin` 指向 `https://github.com/TianmuTan/dsh-douyin.git`，主分支为 `main`。保留上游 MIT 许可证和 NOTICE.md 署名。

## 更新源码仓库

先完成改动和验证：

```powershell
npm test
npm run check
npm pack --dry-run
git status --short
git diff
```

检查新增文件、暂存内容，确认没有运行目录、数据库、登录态、密钥、原始 ZIP、解压副本、现场 proof 或私人截图。示例数据需明确标记为合成示例。然后选择具体改动暂存、提交并推送：

```powershell
git add -- README.md docs/running.md
git diff --cached
git commit -m "docs: update running guide"
git push origin main
```

上述只举例暂存两个文档；实际提交按改动选择文件。首次推送可以用 `git push -u origin main` 建立跟踪关系。远程已有新提交时先检查并合并，不使用强制推送覆盖。没有执行权限或 GitHub 登录失效时，完成正常身份验证后再推送，不把访问令牌写进远程 URL、文档或命令记录。

## npm 与 Release

推送 GitHub 源码不等于发布 npm 包，也不自动创建版本标签或 GitHub Release。当前 package.json 保留兼容包名 `dsh-douyin-scroll`；如需发布 npm，先确认名称所有权，fork 通常需要自己的 scope 并同步 bundle 声明。

`npm pack --dry-run` 只检查打包内容，`npm pack` 生成本地包，`npm publish` 才上传 npm。Release 或软件包说明应列明验证结果，以及真实 DSH/抖音页面尚未验证、没有图文日记发布等限制。日常运行按 [运行指南](docs/running.md) 使用，无需发布 npm。
