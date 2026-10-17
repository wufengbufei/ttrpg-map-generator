/* =========================================================
 * 中文 TTRPG 地图生成器 - 村庄生成器
 * 算法：随机点分布 + 最小生成树道路 + 环形道路加成 + 凸包围栏
 * 纯前端实现，无依赖
 * ========================================================= */

// ---------- 可复现随机数 (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

let rng = Math.random;
function randInt(min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
function randFloat(min, max) { return rng() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---------- 常量 ----------
const CANVAS_SIZE = 900;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2;

// ---------- 建筑类型定义 ----------
// w/h 为绘制尺寸范围（像素），民居偏小，功能建筑稍大
const BUILDING_TYPES = {
  '民居': { color: '#d8c59a', w: [28, 38], h: [24, 32] },
  '铁匠铺': { color: '#6f5846', w: [44, 56], h: [36, 44] },
  '旅店': { color: '#c47b45', w: [48, 60], h: [38, 46] },
  '磨坊': { color: '#a6a05f', w: [42, 54], h: [36, 44] },
  '教堂': { color: '#8d8396', w: [46, 58], h: [40, 50] },
  '市场': { color: '#b5544a', w: [52, 66], h: [40, 50] },
  '仓库': { color: '#9c8455', w: [42, 54], h: [36, 44] },
};
const TYPE_ORDER = ['民居', '铁匠铺', '旅店', '磨坊', '教堂', '市场', '仓库'];

// 按村庄规模解锁功能建筑，其余以民居为主
function assignTypes(count) {
  const specials = [];
  if (count >= 6) specials.push('教堂');
  if (count >= 8) specials.push('市场');
  if (count >= 9) specials.push('磨坊');
  if (count >= 11) specials.push('旅店');
  if (count >= 13) specials.push('铁匠铺');
  if (count >= 15) specials.push('仓库');
  if (count >= 22) specials.push('磨坊');
  if (count >= 28) specials.push('铁匠铺');
  if (count >= 34) specials.push('旅店');

  // 其余地块均为民居，保证功能建筑数量合理、民居占多数
  const rest = [];
  while (rest.length < count - specials.length) rest.push('民居');

  return shuffle(specials.concat(rest));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 村庄类 ----------
class Village {
  constructor(opts) {
    this.opts = opts;
    this.buildings = [];
    this.roads = [];
    this.fence = null;
    this.ground = null;
    this.trees = [];
  }

  generate() {
    const { buildingCount, villageRadius, roadCurve, roadDensity, fenceEnabled } = this.opts;
    const positions = this.placePoints(buildingCount, villageRadius);
    const types = assignTypes(buildingCount);

    this.buildings = positions.map((p, i) => this.makeBuilding(p, types[i]));
    this.centerSpecialBuildings();
    this.relaxBuildings();

    // 按从上到下、从左到右编号，方便对照清单
    this.buildings.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    this.buildings.forEach((b, i) => { b.id = i + 1; });

    this.roads = this.buildRoads(roadCurve, roadDensity);
    this.ground = this.buildGround(villageRadius);
    if (fenceEnabled) this.fence = this.buildFence(villageRadius);
    this.trees = this.buildTrees(villageRadius);
  }

  // 随机点分布：极坐标 + 最小间距拒绝采样，近似均匀散开
  placePoints(count, radius) {
    const pts = [];
    const minDist = radius * Math.sqrt(Math.PI / Math.max(count, 1)) * 0.8;
    let attempts = 0;
    const maxAttempts = count * 400;
    while (pts.length < count && attempts < maxAttempts) {
      attempts++;
      const ang = rng() * Math.PI * 2;
      const r = radius * Math.sqrt(rng());
      const x = CX + Math.cos(ang) * r;
      const y = CY + Math.sin(ang) * r;
      let ok = true;
      for (const p of pts) {
        if (Math.hypot(x - p.x, y - p.y) < minDist) { ok = false; break; }
      }
      if (ok) pts.push({ x, y });
    }

    // 高密度时放宽间距兜底补点
    while (pts.length < count) {
      const ang = rng() * Math.PI * 2;
      const r = radius * Math.sqrt(rng());
      const x = CX + Math.cos(ang) * r;
      const y = CY + Math.sin(ang) * r;
      let ok = true;
      for (const p of pts) {
        if (Math.hypot(x - p.x, y - p.y) < minDist * 0.55) { ok = false; break; }
      }
      if (ok) pts.push({ x, y });
    }
    return pts;
  }

  makeBuilding(p, type) {
    const def = BUILDING_TYPES[type];
    const w = randInt(def.w[0], def.w[1]);
    const h = randInt(def.h[0], def.h[1]);
    return {
      x: p.x,
      y: p.y,
      type,
      w,
      h,
      angle: randFloat(-0.28, 0.28),
      color: def.color,
      radius: Math.max(w, h) / 2 + 5,
      id: 0,
    };
  }

  // 教堂/市场等核心建筑尽量靠近村子中心
  centerSpecialBuildings() {
    this.moveSpecialToCenter('教堂', 0);
    this.moveSpecialToCenter('市场', 1);
  }

  moveSpecialToCenter(type, rank) {
    const idx = this.buildings.findIndex(b => b.type === type);
    if (idx === -1) return;
    const order = this.buildings
      .map((b, i) => ({ i, d: Math.hypot(b.x - CX, b.y - CY) }))
      .sort((a, b) => a.d - b.d);
    const target = order[Math.min(rank, order.length - 1)].i;
    [this.buildings[idx], this.buildings[target]] = [this.buildings[target], this.buildings[idx]];
  }

  // 分离重叠的建筑地块（保持数量，轻微推挤）
  relaxBuildings() {
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (let i = 0; i < this.buildings.length; i++) {
        for (let j = i + 1; j < this.buildings.length; j++) {
          const a = this.buildings[i];
          const b = this.buildings[j];
          const minD = a.radius + b.radius + 6;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d < minD && d > 0.001) {
            const push = (minD - d) / 2;
            const ux = dx / d;
            const uy = dy / d;
            a.x -= ux * push;
            a.y -= uy * push;
            b.x += ux * push;
            b.y += uy * push;
            this.clampBuilding(a);
            this.clampBuilding(b);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  clampBuilding(b) {
    const m = b.radius + 6;
    b.x = Math.max(m, Math.min(CANVAS_SIZE - m, b.x));
    b.y = Math.max(m, Math.min(CANVAS_SIZE - m, b.y));
  }

  // 最小生成树保证全连通，再按密度补环形道路
  buildRoads(curvePct, densityPct) {
    const n = this.buildings.length;
    if (n <= 1) return [];
    const tree = this.connectMST();
    const extra = this.extraEdges(tree, densityPct);
    return tree.concat(extra).map(([i, j]) => {
      const a = this.buildings[i];
      const b = this.buildings[j];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const offset = (curvePct / 100) * len * 0.30 * randFloat(-1, 1);
      const ctrl = { x: mx + nx * offset, y: my + ny * offset };
      const main = a.type === '市场' || b.type === '市场' ||
                   a.type === '教堂' || b.type === '教堂' ||
                   a.type === '旅店' || b.type === '旅店';
      const width = main ? randInt(11, 13) : randInt(8, 10);
      return { i, j, ctrl, width };
    });
  }

  connectMST() {
    const n = this.buildings.length;
    const inTree = new Set([0]);
    const edges = [];
    while (inTree.size < n) {
      let best = null;
      for (const i of inTree) {
        for (let j = 0; j < n; j++) {
          if (inTree.has(j)) continue;
          const dx = this.buildings[i].x - this.buildings[j].x;
          const dy = this.buildings[i].y - this.buildings[j].y;
          const d = dx * dx + dy * dy;
          if (!best || d < best.d) best = { i, j, d };
        }
      }
      inTree.add(best.j);
      edges.push([best.i, best.j]);
    }
    return edges;
  }

  extraEdges(tree, densityPct) {
    const n = this.buildings.length;
    const treeSet = new Set(tree.map(([a, b]) => `${Math.min(a, b)}_${Math.max(a, b)}`));
    const all = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (treeSet.has(`${i}_${j}`)) continue;
        const dx = this.buildings[i].x - this.buildings[j].x;
        const dy = this.buildings[i].y - this.buildings[j].y;
        all.push({ i, j, d: dx * dx + dy * dy });
      }
    }
    all.sort((a, b) => a.d - b.d);
    const cnt = Math.round((densityPct / 100) * n);
    return all.slice(0, cnt).map(e => [e.i, e.j]);
  }

  // 地面：带轻微起伏的圆形空地
  buildGround(radius) {
    const n = 40;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = radius + 18 + randFloat(-8, 10);
      pts.push({ x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r });
    }
    return chaikin(pts, 1);
  }

  // 围栏：建筑角点凸包 + 外扩 + Chaikin 平滑
  buildFence(radius) {
    const corners = [];
    for (const b of this.buildings) corners.push(...this.buildingCorners(b));
    let hull = convexHull(corners);
    if (hull.length < 3) {
      hull = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        hull.push({ x: CX + Math.cos(a) * (radius + 30), y: CY + Math.sin(a) * (radius + 30) });
      }
    }
    const margin = 24 + radius * 0.03;
    hull = hull.map(v => {
      const dx = v.x - CX;
      const dy = v.y - CY;
      const d = Math.hypot(dx, dy) || 1;
      const off = margin + randFloat(-5, 8);
      return { x: v.x + (dx / d) * off, y: v.y + (dy / d) * off };
    });
    return chaikin(hull, 2);
  }

  buildingCorners(b) {
    const cos = Math.cos(b.angle);
    const sin = Math.sin(b.angle);
    const corners = [];
    for (const [sx, sy] of [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2]]) {
      corners.push({ x: b.x + sx * cos - sy * sin, y: b.y + sx * sin + sy * cos });
    }
    return corners;
  }

  // 村庄外围点缀树木
  buildTrees(radius) {
    const trees = [];
    const target = 26;
    let tries = 0;
    while (trees.length < target && tries < target * 40) {
      tries++;
      const a = rng() * Math.PI * 2;
      const r = randFloat(radius + 42, radius + 128);
      const x = CX + Math.cos(a) * r;
      const y = CY + Math.sin(a) * r;
      if (x < 30 || x > CANVAS_SIZE - 30 || y < 30 || y > CANVAS_SIZE - 30) continue;
      let ok = true;
      for (const t of trees) {
        if (Math.hypot(x - t.x, y - t.y) < 28) { ok = false; break; }
      }
      if (ok) trees.push({ x, y, s: randFloat(7, 13) });
    }
    return trees;
  }
}

// ---------- 几何工具 ----------
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function chaikin(points, iterations) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    pts = next;
  }
  return pts;
}

// ---------- 渲染 ----------
function renderVillage(village, canvas) {
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');

  // 羊皮纸底色
  ctx.fillStyle = '#ece0c4';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // 地面空地
  drawPolygon(ctx, village.ground, '#dfcd9d', 'rgba(43,32,22,0.12)', 2);

  // 树木
  for (const t of village.trees) drawTree(ctx, t);

  // 道路
  for (const road of village.roads) {
    drawRoad(ctx, village.buildings[road.i], village.buildings[road.j], road);
  }

  // 围栏
  if (village.fence) drawFence(ctx, village.fence);

  // 建筑
  drawBuildings(ctx, village.buildings);

  // 图例字号 / 编号 / 类型标注
  drawLabels(ctx, village.buildings);
}

function drawPolygon(ctx, pts, fill, stroke, lineWidth) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length];
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function drawTree(ctx, t) {
  ctx.fillStyle = 'rgba(43,32,22,0.20)';
  ctx.beginPath();
  ctx.ellipse(t.x + 2, t.y + 3, t.s * 0.9, t.s * 0.65, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6e7f4a';
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5c6b3e';
  ctx.beginPath();
  ctx.arc(t.x - t.s * 0.25, t.y - t.s * 0.25, t.s * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoad(ctx, a, b, road) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(road.ctrl.x, road.ctrl.y, b.x, b.y);
  ctx.strokeStyle = '#8a6d4a';
  ctx.lineWidth = road.width + 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.strokeStyle = '#c9a97a';
  ctx.lineWidth = road.width;
  ctx.stroke();
}

function drawFence(ctx, pts) {
  // 横杆
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length];
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = '#7a5a3e';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 等距栅栏桩
  const step = 22;
  ctx.fillStyle = '#5a422e';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;
    const ux = dx / len;
    const uy = dy / len;
    for (let d = 0; d < len; d += step) {
      ctx.fillRect(a.x + ux * d - 1.7, a.y + uy * d - 1.7, 3.4, 3.4);
    }
  }
}

function drawBuildings(ctx, buildings) {
  for (const b of buildings) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);

    // 阴影
    ctx.fillStyle = 'rgba(43,32,22,0.22)';
    ctx.fillRect(-b.w / 2 + 3, -b.h / 2 + 3, b.w, b.h);

    // 屋顶
    ctx.fillStyle = b.color;
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);

    // 边框
    ctx.strokeStyle = 'rgba(43,32,22,0.7)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);

    // 屋脊线
    ctx.strokeStyle = 'rgba(43,32,22,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (b.w >= b.h) {
      ctx.moveTo(-b.w / 2, 0);
      ctx.lineTo(b.w / 2, 0);
    } else {
      ctx.moveTo(0, -b.h / 2);
      ctx.lineTo(0, b.h / 2);
    }
    ctx.stroke();

    ctx.restore();
  }
}

function drawLabels(ctx, buildings) {
  for (const b of buildings) {
    // 编号（建筑内部，白字深描边，保证深色屋顶上可读）
    ctx.font = 'bold 11px "Noto Serif SC", "Songti SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(43,32,22,0.85)';
    ctx.fillStyle = '#fff8e8';
    ctx.strokeText(String(b.id), b.x, b.y - 1);
    ctx.fillText(String(b.id), b.x, b.y - 1);

    // 类型中文标注（建筑下方，带羊皮纸描边）
    ctx.font = '11px "Noto Serif SC", "Songti SC", serif';
    const ty = b.y + Math.max(b.w, b.h) / 2 + 12;
    ctx.strokeStyle = 'rgba(236,224,196,0.95)';
    ctx.lineWidth = 3;
    ctx.strokeText(b.type, b.x, ty);
    ctx.fillStyle = '#2b2016';
    ctx.fillText(b.type, b.x, ty);
  }
}

function renderBuildingInfo(village, container) {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = `<strong>共 ${village.buildings.length} 栋建筑</strong>`;
  container.appendChild(title);
  for (const b of village.buildings) {
    const div = document.createElement('div');
    div.textContent = `建筑 ${b.id}：${b.type}（约 ${b.w}×${b.h} 尺）`;
    container.appendChild(div);
  }
}

// ---------- 页面交互 ----------
let currentVillage = null;

function readOpts() {
  return {
    buildingCount: parseInt(document.getElementById('buildingCount').value, 10),
    villageRadius: parseInt(document.getElementById('villageRadius').value, 10),
    roadCurve: parseInt(document.getElementById('roadCurve').value, 10),
    roadDensity: parseInt(document.getElementById('roadDensity').value, 10),
    fenceEnabled: document.getElementById('fenceToggle').checked,
  };
}

function syncLabels() {
  document.getElementById('valCount').textContent = document.getElementById('buildingCount').value;
  document.getElementById('valRadius').textContent = document.getElementById('villageRadius').value;
  document.getElementById('valCurve').textContent = document.getElementById('roadCurve').value + '%';
  document.getElementById('valDensity').textContent = document.getElementById('roadDensity').value + '%';
}

function generate() {
  const opts = readOpts();

  const seedText = document.getElementById('seedInput').value.trim();
  let seedNum;
  if (seedText) {
    seedNum = /^\d+$/.test(seedText) ? parseInt(seedText, 10) : hashStringToSeed(seedText);
  } else {
    seedNum = Math.floor(Math.random() * 1e9);
    document.getElementById('seedInput').value = String(seedNum);
  }
  rng = mulberry32(seedNum);

  const village = new Village(opts);
  village.generate();
  currentVillage = village;

  const canvas = document.getElementById('villageCanvas');
  renderVillage(village, canvas);
  renderBuildingInfo(village, document.getElementById('buildingInfo'));
}

function exportPng() {
  const canvas = document.getElementById('villageCanvas');
  const link = document.createElement('a');
  link.download = `村庄_${document.getElementById('seedInput').value || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportTxt() {
  if (!currentVillage) return;
  const seed = document.getElementById('seedInput').value || 'random';
  let text = `村庄建筑清单（种子：${seed}）\n`;
  text += `建筑数量：${currentVillage.buildings.length}　村庄半径：${currentVillage.opts.villageRadius}　围栏：${currentVillage.opts.fenceEnabled ? '有' : '无'}\n\n`;
  for (const b of currentVillage.buildings) {
    text += `建筑 ${b.id}：${b.type}\n`;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `村庄清单_${seed}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

window.addEventListener('DOMContentLoaded', () => {
  const sliderIds = ['buildingCount', 'villageRadius', 'roadCurve', 'roadDensity'];
  sliderIds.forEach(id => document.getElementById(id).addEventListener('input', syncLabels));
  document.getElementById('fenceToggle').addEventListener('change', generate);
  document.getElementById('generateBtn').addEventListener('click', generate);
  document.getElementById('exportPngBtn').addEventListener('click', exportPng);
  document.getElementById('exportTxtBtn').addEventListener('click', exportTxt);
  document.getElementById('randomSeedBtn').addEventListener('click', () => {
    document.getElementById('seedInput').value = '';
    generate();
  });
  syncLabels();
  generate();
});
