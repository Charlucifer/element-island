# 元素岛：反应工坊（网页版）

2–4 人化学资源转化桌游的可玩网页版：同屏轮流，另含房间码联机。

## 两种部署方式

**A. GitHub Pages（纯静态，免费、地址永久）**

- 仓库 Settings → Pages → Source 选 `Deploy from a branch` → `main` / `(root)`；
- 地址形如 `https://<用户名>.github.io/<仓库名>/`；
- 局限：**没有联机服务器**，只能同屏轮流（页面里点“联机对战”会提示）。

**B. Render（Node 服务，免费、地址永久、可联机）**

- 打开 <https://render.com>，用 GitHub 登录 → New → Web Service → 选本仓库；
- 仓库里已经带了 `render.yaml`，Build Command `npm install`、Start Command `npm start` 会自动识别；
- 首次部署约 2 分钟，得到 `https://<名字>.onrender.com`；
- 免费实例 15 分钟无访问会休眠，下一次打开需等 30–60 秒冷启动。

## 本地运行

```bash
npm install
npm start        # http://127.0.0.1:8765/
```

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` / `ui.js` | 界面与交互 |
| `game.js` | 规则引擎（浏览器与 Node 共用） |
| `game-data.js` | 由卡表数据生成，勿手改 |
| `server.js` | 静态服务 + WebSocket 联机（房间码） |
| `rules.html` | 规则速查 |

