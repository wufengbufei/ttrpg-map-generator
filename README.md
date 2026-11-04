# 中文版 TTRPG 地图生成器

参考 [watabou.github.io](https://watabou.github.io/)（Procgen Arcana）做的中文界面 TTRPG 地图/场景生成器。纯前端静态站（HTML/CSS/JS + Canvas），无需后端。

**在线试用**：https://wufengbufei.github.io/ttrpg-map-generator/

## 生成器

| 生成器 | 路径 | 说明 |
|---|---|---|
| 地牢 | `generators/dungeon/` | 房间+走廊+陷阱/宝藏，种子可复现，导出 PNG/TXT |
| 村庄 | `generators/village/` | 建筑地块+道路网+围栏+树木 |
| 城市 | `generators/city/` | 街区+城墙+地标 |
| 洞穴/林间 | `generators/cave/` | 洞穴或林间两种风格 |
| 海岸 | `generators/coast/` | 海岸线+特征点（灯塔/渔村等） |
| 住所 | `generators/dwelling/` | 单栋建筑房间布局 |

## 本地预览

```bash
cd ttrpg-map-generator
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

冒烟测试（不依赖浏览器，覆盖种子复现与几何约束）：

```bash
node tests/cave.smoke.test.js
node tests/dwelling.test.js
node tests/coast-smoke.js
node generators/city/city.smoke.test.js
```

页面上的中文使用自托管的 Noto Serif SC 子集（`assets/fonts/`）。地图绘制在 Canvas 里，需要用上面的本地预览看村庄围栏、洞穴/林间边缘、城市屋顶和地牢比例尺。

## 部署

纯静态文件，可挂 GitHub Pages / 腾讯云 COS+CDN 等，无需 Node/数据库。

## 技术栈

原生 JavaScript + Canvas，无框架、无构建步骤。
