# 页流（slide-flow）

<p align="center">
  <img src="./app/static/img/logo.svg" height="112" alt="SlideFlow 图标" />
</p>

<p align="center">
  把 PPT 拆成单页素材，重新编目、授权、组合与放映
</p>

<p align="center">
  中文 ·
  <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

## 简介

宣讲材料通常以「一整份 PPT」为单位管理，但真正被反复使用的往往只是其中的几页。整份文件级别的复用会带来版本混乱、权限过宽和重复制作。

SlideFlow 把单页作为最小管理单元：每页独立编目、独立授权、独立版本，再由放映库按场景重新组合成一份可全屏、可离线播放的放映。上传的 PPT 会先做字体检测和高清渲染，确认后才落库，图片按需在对象存储侧生成。

交付形态是一个 Web 服务（前台素材/模板/字体/放映库 + 管理页与系统后台），后端 FastAPI + SQLite，前端 React + Vite + TypeScript。

## 功能

- 单页素材库：上传后异步完成字体检测与图片渲染，确认导入，任务可关闭页面后继续维护。
- 放映库：把单页素材组合成放映，支持编辑、版本迭代、下载与水印。
- 模板与字体：模板按主体或系列分组、多维筛选；字体库支持上传、预览、嵌入与缺失检测。
- 权限控制：角色叠加作用域，可见、可下载、可管理是三条独立边界。
- 受控分享：素材有独立详情 URL，分享链接可设有效期、可撤销，且不含下载权限。
- PWA 离线放映：在同一浏览器和账号中下载授权缓存，断网也能全屏与双屏放映。
- 飞书 SSO：可与本地账号体系并存。
- Windows WPS 渲染：图片渲染由独立标准件完成，Windows Worker 主动领取任务。
- 任务与运维：任务全过程可视，后台提供配置、日志与系统操作，支持一键启停与 systemd 托管。

## 快速开始

环境要求：Python 3.10+、Node.js 20+、macOS 或 Linux。

1. 执行 `./run.sh` 启动生产模式（自动构建前端）；开发模式执行 `./run.sh --dev`，停止执行 `./stop.sh`。
2. 首次启动会生成配置文件并创建待初始化的系统管理员，一次性令牌写入 `.secrets/`。用本机地址打开 `/setup` 完成初始化，系统不预设任何账号密码。
3. 打开 `http://127.0.0.1:8088` 上传 PPT、维护素材与放映；系统后台在 `/admin/config` 等页面。

PPT 与图片的持久化存储使用阿里云 OSS，需要先在配置中填好 Bucket 与 Endpoint，AccessKey 通过环境变量注入。

## 配置

配置集中在项目根目录的 `slide_flow.properties`，首次启动自动生成并补齐缺失项，默认值声明在 `app/config.py`。日常改配置建议直接在系统后台的配置管理页操作，页面上带有每项的说明、默认值和是否支持热更新；该文件包含敏感凭据，不要提交到 Git。

对象存储、Windows 渲染节点、反向代理上传限制等部署场景需要额外调整少数配置项，同样以配置管理页的说明为准，Nginx 可参考 [`deploy/nginx/slide-flow.conf`](deploy/nginx/slide-flow.conf)，渲染节点见 [`services/wps-renderer`](services/wps-renderer/README.md)。

## 常见问题

- **启动失败**：检查端口占用、Python 与 Node 版本、配置文件格式，`run.sh` 会打印检测到的环境问题。
- **看不到素材或不能下载**：可见、可下载、可管理是三条独立边界，检查角色与素材的可见范围。
- **提示字体缺失或渲染任务卡住**：在素材详情查看缺失字体并上传，或在任务管理页查看状态与日志；渲染依赖 Windows Worker 在线领取任务。

## 开发

```bash
python3.10 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088 --reload

cd web && npm install && npm run dev
```

后端测试 `pytest tests`，前端测试与类型检查见 `web/package.json` 的 scripts。后端路由变更需要重启服务才生效。

## 安全说明

- 不要提交 `slide_flow.properties`、`.secrets/`、`data/`、日志和私有模板。
- 对象存储 AccessKey 只通过运行环境注入，不要写入配置文件、前端或日志；凭证一旦暴露应立即轮换。
- 系统不配置、生成或复用全局默认密码；未指定密码的新用户拿到的是只展示一次、限期有效的临时密码，首次登录必须修改。
- 渲染节点只监听本机回环地址，不要把转换端口暴露到公网，Windows 侧也不持有对象存储凭证。
- 系统后台暴露了配置、日志、用户与系统操作能力，部署到公网前务必完成安全初始化并放在可信网络或反向代理鉴权之后。
- WPS 本身不包含在本项目中，使用者需自行确认其许可与使用条款；本项目仅供内部素材管理与归档场景使用。

## License

本项目依据 [Apache License 2.0](./LICENSE) 发布。
