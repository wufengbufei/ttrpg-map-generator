# 中文版 TTRPG 地图生成器

参考 [watabou.github.io](https://watabou.github.io/)（Procgen Arcana）做的中文界面 TTRPG 地图/场景生成器。纯前端静态站（HTML/CSS/JS + Canvas），无需后端。

**在线试用**：https://wufengbufei.github.io/ttrpg-map-generator/

## 生成器

| 生成器 | 路径 | 说明 |
|---|---|---|
| 地牢 | `generators/dungeon/` | 羊皮纸底图、岩层交叉排线、虚线地板、地点注记，偶有圆室与楼梯；种子可复现，导出 PNG/TXT |
| 村庄 | `generators/village/` | 村名与人口、种地与果林、扇贝形树丛、土路与围栏 |
| 城市 | `generators/city/` | 街区名、灰瓦排线屋顶、加厚城墙与圆塔、指北针和比例尺；城外有种地，约一半种子带水面 |
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
node generators/dungeon/dungeon.smoke.test.js
node generators/city/city.smoke.test.js
node generators/village/village.smoke.test.js
```

页面上的中文使用自托管的 Noto Serif SC 子集（`assets/fonts/`）。地图绘制在 Canvas 里。本地预览时可以核对：地牢岩层排线与地点注记、城市街区名 / 指北针 / 比例尺、村庄村名人口和种地。同一数字种子再点一次「生成」，地图（含注记、街区名、村名和地块）应保持不变。

## 部署

纯静态文件，可挂 GitHub Pages / 腾讯云 COS+CDN 等，无需 Node/数据库。

## 技术栈

原生 JavaScript + Canvas，无框架、无构建步骤。
