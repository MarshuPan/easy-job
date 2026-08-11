# Security Policy

## Reporting A Vulnerability

请优先使用 GitHub 的 Private vulnerability reporting 功能提交安全问题，不要在公开 Issue 中发布漏洞细节、API Key、Cookie、简历或账号标识。

报告中请包含受影响版本、复现条件和最小必要日志。提交前请删除与问题无关的个人数据。

## Secrets And Personal Data

- 不要提交真实模型密钥、招聘平台 Cookie、简历或个人配置导出文件。
- 不要将 `.output/`、运行日志、浏览器存储导出或本地调试截图加入仓库。
- 如果密钥曾进入公开提交或 Release，请立即撤销并重新生成；仅从后续提交中删除不能使旧密钥恢复安全。

## Supported Versions

安全修复以最新 GitHub Release 为准。
