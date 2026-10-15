# 中文版 TTRPG 地图生成器

参考 watabou.github.io（Procgen Arcana）做的中文界面 TTRPG 地图生成器网站。
纯前端静态站（HTML/CSS/JS + Canvas），无需后端，可直接部署到任意静态托管。

## 当前进度

- [x] 地牢生成器（`generators/dungeon/`）
- [ ] 城市生成器
- [ ] 村庄生成器
- [ ] 洞穴/林间生成器
- [ ] 海岸生成器
- [ ] 住所生成器

## 本地预览

```bash
cd ttrpg-map-generator
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

## 部署

纯静态文件，整个目录上传到任意静态托管（腾讯云 COS+CDN、Nginx 静态目录等）即可，无需 Node/数据库。

## 技术栈

原生 JavaScript + Canvas，无框架、无构建步骤，直接双击/用静态服务器打开即可运行。
