# PokéSurvivor 部署说明

## 当前站点结构

- 西班牙语主站：`/`
- 英语游戏入口：`/en/`
- 繁体中文游戏入口：`/zh-hant/`
- 英语 SEO 落地页：`/en/pokemon-survivor-play-free-online-in-your-browser/`
- 西语 SEO 落地页：`/juego-supervivencia-pokemon-gratis-online/`
- 繁中 SEO 落地页：`/zh-hant/pokemon-survivor/`

## GitHub 与 Cloudflare Pages

GitHub fork `daidai-ctrl/pokesurvivor` 保存源代码和发布历史；正式站点使用
Cloudflare Pages 托管，避免把域名再指向原作者或 GitHub Pages。

在 Cloudflare Dashboard → Workers & Pages 中创建 Pages 项目并连接该 GitHub
仓库。这个项目是静态站点，构建设置为：

- Framework preset：`None`
- Build command：留空
- Build output directory：`/`（仓库根目录）
- Production branch：`main`

部署完成后，在 Pages 项目的 Custom domains 中添加 `pokesurvivor.xyz` 和
`www.pokesurvivor.xyz`。域名已经由 Cloudflare 管理时，按面板提示确认 DNS；
不要同时配置指向旧 GitHub Pages 的 A/AAAA/CNAME 记录。

仓库根目录的 `CNAME` 文件保留作兼容和来源记录，但 Cloudflare Pages 的自定义
域名设置才是正式生效的绑定。

## Firebase 与多人功能

`js/core/firebase-config.js` 当前是 `null`，因此公开测试版默认使用本地模式，不会占用原作者的 Firebase 项目。若需要账号、云存档、排行榜和在线合作，请创建自己的 Firebase 项目，将自己的 Web 配置写入该文件，并把 `pokesurvivor.xyz` 加入 Firebase Authorized domains。

Cloudflare TURN 是可选项。需要多人连接中继时，再部署 `cloudflare/turn-worker.js`，并在 Worker 中配置 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN` 两个 Secret。

## 重新生成发布文件

```text
node tools/export_data.js
node tools/build.js
python tools/make_seo_pages.py
```

SEO 文案是新增内容，没有复制原站 SEO 文本；原项目的 `LICENSE` 和 `CREDITS.md` 请与代码一起保留。
