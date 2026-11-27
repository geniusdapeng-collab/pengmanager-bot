# 自托管云浏览器

适用于一个鹏经理实例、一个登记工位及一个浏览器账号资料目录。本人在管理员工作台选择用途，领取十分钟独占租约。画面网关仅接受同源 POST 提交的一次性票据，45 秒内兑换，通过 HTTPS/WSS 传画面和输入。停用、交还、登出或权限失效之后，网关关闭输入流，旧票据无法恢复。远端桌面闲置五分钟会断开，绝对时限仍按原租约计。工作台显示配置状态、租约和审计。远端未部署时，委托、任务及回执照常访问。

## 拓扑与账号

```text
HTTPS nginx ── /bot/ 和 /api/bot/v1/ ── 原有鹏经理应用及 BOT 路由
            └─ /bot-browser/ ───────── 127.0.0.1:18760 限权网关
                                        └─ 受组权限保护的 Unix RFB socket
                                           └─ 专属 TigerVNC / Chromium 账号工位
```

- 对外只有原 HTTPS 入口。示例把网关和 RFB 放在同一台主机。网关监听 loopback，TigerVNC 关闭 TCP 监听。Nginx 为网关只转发专属 HttpOnly Cookie，过滤应用管理员 Cookie 和访问令牌，并对外拦截服务间路由。
- 工位与网关以不同的 Unix 用户运行，共享仅用于 RFB 的组权限。加密持久卷上可建立每账号一个浏览器资料目录。本样例只绑定一个账号，另一个账号需要另一份隔离部署。浏览器资料目录禁止纳入安装包和普通日志。首次登录由本人在得到平台允许的正常网页中操作。
- 保留 Chromium 沙箱。工位禁用调试端口、自动化控制、屏幕录制、剪贴板同步及访客旁观。按既有运维边界限制工位出站目的地，禁止访问实例元数据及其他私网应用。实际平台要求本机设备身份或者显式确认时，按官方人类流程处理。该画面授权不产生内容发布权限。
- 应用控制面与网关共用一个只供此连接的高熵密钥，由运行时读取。票据及浏览器连接 Cookie 只在会话期间使用。审计保存工作区、操作者、目标、理由枚举、时限和连接状态。

## 安装示例

本样例面向 Debian 13，应用和网关使用 Node 24 或以上。先安装 Node 与项目运行时，部署鹏经理应用，再针对独占工位安装桌面包和锁定的网关依赖。Node 可执行文件路径如有不同，按实际安装调整网关 unit。

```sh
sudo apt-get install chromium fluxbox tigervnc-standalone-server novnc xauth x11-utils fonts-noto-cjk
sudo groupadd --system pengmanager-browser-rfb
sudo useradd --system --gid pengmanager-browser-rfb --no-create-home --shell /usr/sbin/nologin pengmanager-browser
sudo useradd --system --gid pengmanager-browser-rfb --no-create-home --shell /usr/sbin/nologin pengmanager-browser-gateway
cd /opt/pengmanager-bot/deploy/bot-browser
pnpm install --frozen-lockfile --ignore-scripts --prod
```

通过服务器的秘密配置机制生成共享密钥。`/etc/pengmanager/browser-gateway.env` 由 root 管理，mode 0600。填写下表变量的实际值，再按主部署说明把相同的服务密钥和目标 ID 配给 BOT 服务。

| 变量 | 来源 |
| --- | --- |
| `BOT_BROWSER_PUBLIC_ORIGIN` | 浏览器实际访问的完整 HTTPS origin。 |
| `BOT_BROWSER_AUTHORITY_ORIGIN` | 主应用尚未通过公网反向代理的 loopback HTTP origin。 |
| `BOT_BROWSER_GATEWAY_SECRET` | 当前部署专用的 43–128 位 base64url 随机密钥。 |
| `BOT_BROWSER_TARGET_ID` | 主应用已登记的唯一工位 ID，绑定真实 workspace、owner、account 及适用任务。 |
| `BOT_BROWSER_GATEWAY_PORT` | 默认 18760。变更时同步更新 Nginx 和主应用网关地址。 |

把两个 systemd unit 安装到系统的 unit 目录，确认实例有持久数据磁盘及其访问权限。按照 Nginx 注释，把两个片段分别放在实际 http 和已有 HTTPS server 块内。验证 Nginx 后再重载。保持已有 TLS、管理登录和主应用路由在同一站点。

```sh
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now pengmanager-browser-gateway.service
sudo systemctl reload nginx
```

安装后用一个获准的隔离目标验证。先确认匿名请求、错误来源和重复票据被拒绝，再分别用桌面和手机申请接管，测试接通、交还、停止、重新连接及审计。用端口检查对照 RFB 无 TCP 监听、网关只在 loopback。随后才能在对应的平台授权下手动登录。安全状态以工作台审计与现场连接、停止结果为依据。

## 文件与运行证据

- `../../src/bot/browser-service.mjs` 管理租约、单次票据、停用和工作区审计。主应用只有一个状态写入进程。恢复时旧租约撤销，旧票据和网关 Cookie 不可复用。
- `../../src/bot/browser-gateway.mjs` 管理 HTTP 会话、WSS 到私有 RFB 的转发及停权。主动停止向网关发出关流请求。该请求失败时，持续策略复核会关闭失权连接。有状态网关单实例部署。
- `worker.sh` 启动专属图形环境及持久 Chromium 资料目录。工位服务可独立停机，其他 BOT 工作可继续。

相关官方合同见 [noVNC RFB API](https://github.com/novnc/noVNC/blob/master/docs/API.md) · [TigerVNC Unix RFB 选项](https://tigervnc.org/doc/Xvnc.html) · [Debian noVNC 路径](https://packages.debian.org/trixie/all/novnc/filelist) · [Node ws 网关接口](https://github.com/websockets/ws/blob/master/doc/ws.md)。
