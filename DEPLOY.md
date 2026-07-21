# 外部长期链接部署

`localhost` 和 `192.168.x.x` 都不是外部链接：前者只能本机打开，后者只能同一 Wi-Fi 打开。要分享到微信外部朋友，需要公网 HTTPS 地址。

## 推荐方案：Render 免费 Web Service

适合“电脑关了也能玩”。部署后会得到类似：

```text
https://who-is-undercover-h5.onrender.com
```

使用步骤：

1. 把这个项目上传到 GitHub。
2. 打开 Render，创建 `Web Service`。
3. 连接这个 GitHub 仓库。
4. Render 会自动读取项目里的 `render.yaml`：
   - `plan: free`
   - `buildCommand: pnpm install --frozen-lockfile`
   - `startCommand: pnpm start`
   - `healthCheckPath: /health`
5. 部署完成后，用 Render 给出的 `https://...onrender.com` 打开游戏。
6. 创建房间后，把 `https://...onrender.com/room/房间码` 分享到微信。

免费限制：

- 免费服务空闲 15 分钟会休眠，再次打开会自动唤醒，通常要等约 1 分钟。
- 房间数据存在服务内存里，服务重启或休眠后，当前房间可能会失效。
- 链接本身长期稳定，不会像 Cloudflare Quick Tunnel 那样每次变化。

## 平台要求

- 支持 Node.js。
- 支持 WebSocket 长连接。
- 支持 HTTPS。
- 允许服务端内存保存临时房间状态。

## 备选方案：ngrok 免费开发域名

适合“电脑一直开着也可以”。ngrok 免费版有一个账号固定开发域名，可以外部访问本机服务，但限制更多：

- 电脑必须开着。
- 本地游戏服务和 ngrok 都必须一直运行。
- 免费版有流量和请求数限制。
- 浏览器首次打开可能会看到 ngrok 的提示页。

## 注意

当前版本房间状态保存在服务端内存里。平台重启后房间会消失，但稳定网址不会变。以后如果需要“房间和积分永久保存”，再接数据库。
