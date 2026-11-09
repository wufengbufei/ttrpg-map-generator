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
    this.fields = [];
    this.name = '';
    this.population = 0;
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
    this.fields = this.buildFields(villageRadius);
    this.assignIdentity();
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

  // 村庄外围的树丛：几团圆叶叠成扇贝边
  buildTrees(radius) {
    const trees = [];
    const target = 11;
    let tries = 0;
    while (trees.length < target && tries < target * 50) {
      tries++;
      const a = rng() * Math.PI * 2;
      const r = randFloat(radius + 36, radius + 130);
      const x = CX + Math.cos(a) * r;
      const y = CY + Math.sin(a) * r;
      if (x < 28 || x > CANVAS_SIZE - 28 || y < 28 || y > CANVAS_SIZE - 28) continue;
      if (x < 210 && y < 96) continue;
      let ok = true;
      for (const t of trees) {
        if (Math.hypot(x - t.x, y - t.y) < 46) { ok = false; break; }
      }
      if (!ok) continue;
      const s = randFloat(16, 28);
      const lobes = [];
      const n = randInt(5, 7);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + randFloat(-0.25, 0.25);
        const dist = randFloat(s * 0.15, s * 0.55);
        lobes.push({
          dx: Math.cos(ang) * dist,
          dy: Math.sin(ang) * dist,
          r: randFloat(s * 0.48, s * 0.82),
        });
      }
      trees.push({ x, y, s, lobes });
    }
    return trees;
  }

  buildFields(radius) {
    const fields = [];
    const target = Math.max(4, Math.round(radius / 60));
    let tries = 0;
    while (fields.length < target && tries < target * 50) {
      tries++;
      const ang = rng() * Math.PI * 2;
      const dist = randFloat(radius * 0.58, Math.min(radius + 72, CANVAS_SIZE * 0.46));
      const x = CX + Math.cos(ang) * dist;
      const y = CY + Math.sin(ang) * dist;
      const field = {
        x,
        y,
        w: randInt(40, 72),
        h: randInt(30, 54),
        angle: ang + Math.PI / 2 + randFloat(-0.4, 0.4),
        kind: rng() < 0.62 ? 'field' : 'orchard',
        rows: randInt(4, 7),
      };
      if (!this.fieldFits(field, fields)) continue;
      fields.push(field);
    }
    if (!fields.length) {
      let best = null;
      let bestD = -1;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = CX + Math.cos(a) * (radius * 0.72);
        const y = CY + Math.sin(a) * (radius * 0.72);
        let dmin = Infinity;
        for (const b of this.buildings) dmin = Math.min(dmin, Math.hypot(b.x - x, b.y - y));
        if (dmin > bestD) { bestD = dmin; best = { x, y }; }
      }
      fields.push({
        x: best ? best.x : 80,
        y: best ? best.y : 80,
        w: 40,
        h: 30,
        angle: 0.35,
        kind: 'field',
        rows: 5,
      });
    }
    return fields;
  }

  fieldCorners(f) {
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const pts = [];
    for (const [sx, sy] of [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2]]) {
      pts.push({ x: f.x + sx * c - sy * s, y: f.y + sx * s + sy * c });
    }
    return pts;
  }

  fieldFits(field, others) {
    const corners = this.fieldCorners(field);
    const pts = corners.concat([{ x: field.x, y: field.y }]);
    for (const p of pts) {
      if (p.x < 16 || p.y < 16 || p.x > CANVAS_SIZE - 16 || p.y > CANVAS_SIZE - 16) return false;
      if (p.x < 200 && p.y < 92) return false;
    }
    for (const b of this.buildings) {
      if (pointInPolygon({ x: b.x, y: b.y }, corners)) return false;
      if (buildingContains(b, field.x, field.y, 8)) return false;
      for (const c of corners) {
        if (buildingContains(b, c.x, c.y, 2)) return false;
      }
    }
    for (const other of others) {
      if (Math.hypot(other.x - field.x, other.y - field.y) < (field.w + other.w) * 0.42) return false;
    }
    for (const tree of this.trees) {
      if (Math.hypot(tree.x - field.x, tree.y - field.y) < tree.s + 18) return false;
    }
    return true;
  }

  assignIdentity() {
    const family = ['林', '何', '石', '白', '海', '高', '方', '文', '安', '松'];
    const place = ['石', '海', '林', '原', '港', '岸', '坡', '门', '地', '泉'];
    const suffix = rng() < 0.5 ? '村' : '庄';
    if (rng() < 0.55) this.name = pick(family) + '家' + suffix;
    else this.name = pick(family) + pick(place) + suffix;
    const people = this.buildings.length * (8 + Math.floor(rng() * 8)) + 18 + Math.floor(rng() * 24);
    this.population = Math.max(40, Math.round(people / 10) * 10);
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

  ctx.fillStyle = '#e7e0c8';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  if (village.ground) drawPolygon(ctx, village.ground, '#e4efd4', 'rgba(70,90,50,0.2)', 2);
  drawStipple(ctx, village.ground);
  for (const field of village.fields || []) drawField(ctx, field);
  for (const t of village.trees) drawTree(ctx, t);
  for (const road of village.roads) drawRoad(ctx, village, road);
  if (village.fence) drawFence(ctx, village.fence);
  drawBuildings(ctx, village.buildings);
  drawLabels(ctx, village.buildings);
  drawVillageTitle(ctx, village);
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
  const lobes = t.lobes && t.lobes.length ? t.lobes : [{ dx: 0, dy: 0, r: t.s }];
  ctx.save();
  ctx.fillStyle = 'rgba(43,32,22,0.18)';
  ctx.beginPath();
  ctx.ellipse(t.x + 3, t.y + t.s * 0.55, t.s * 1.15, t.s * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'rgba(43,32,22,0.2)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  for (let i = 0; i < lobes.length; i++) {
    const lobe = lobes[i];
    ctx.beginPath();
    ctx.arc(t.x + lobe.dx, t.y + lobe.dy, lobe.r, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? '#5d7344' : '#3f562e';
    ctx.fill();
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#2f4524';
  ctx.lineWidth = 1.15;
  for (const lobe of lobes) {
    ctx.beginPath();
    ctx.arc(t.x + lobe.dx, t.y + lobe.dy, lobe.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStipple(ctx, ground) {
  if (!ground || ground.length < 3) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ground[0].x, ground[0].y);
  for (let i = 1; i < ground.length; i++) ctx.lineTo(ground[i].x, ground[i].y);
  ctx.closePath();
  ctx.clip();
  let h = 2166136261;
  for (const p of ground) {
    h ^= Math.round(p.x);
    h = Math.imul(h, 16777619);
    h ^= Math.round(p.y);
    h = Math.imul(h, 16777619);
  }
  const rand = mulberry32(h >>> 0);
  for (let i = 0; i < 980; i++) {
    const x = rand() * CANVAS_SIZE;
    const y = rand() * CANVAS_SIZE;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(74, 102, 48, 0.24)' : 'rgba(98, 120, 62, 0.15)';
    ctx.fillRect(x, y, 1.6, 1.6);
  }
  ctx.restore();
}

function drawField(ctx, f) {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.angle);
  ctx.shadowColor = 'rgba(43,32,22,0.16)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = f.kind === 'orchard' ? '#d7e4c4' : '#d2be96';
  ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(70,50,30,0.55)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-f.w / 2 + 2, -f.h / 2 + 2, f.w - 4, f.h - 4);
  ctx.clip();
  if (f.kind === 'orchard') {
    const cols = Math.max(2, Math.round(f.w / 16));
    const rows = Math.max(2, Math.round(f.h / 16));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = -f.w / 2 + ((c + 0.5) * f.w) / cols;
        const py = -f.h / 2 + ((r + 0.5) * f.h) / rows;
        ctx.fillStyle = '#3f562e';
        ctx.beginPath();
        ctx.arc(px, py, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#6d8a48';
        ctx.beginPath();
        ctx.arc(px - 1.2, py - 1.1, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    ctx.strokeStyle = 'rgba(96, 68, 36, 0.5)';
    ctx.lineWidth = 1;
    const rows = f.rows || 5;
    for (let r = 1; r < rows; r++) {
      const py = -f.h / 2 + (f.h * r) / rows;
      ctx.beginPath();
      ctx.moveTo(-f.w / 2 + 3, py);
      ctx.lineTo(f.w / 2 - 3, py);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.restore();
}

const LABEL_FONT = '"Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif';

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const hit = (a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

function buildingContains(b, x, y, pad) {
  const dx = x - b.x;
  const dy = y - b.y;
  const cos = Math.cos(-b.angle);
  const sin = Math.sin(-b.angle);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad;
}

function quadPoint(a, b, ctrl, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
  };
}

function curveHitsObstacle(a, b, ctrl, buildings, fence) {
  for (let k = 1; k < 18; k++) {
    const p = quadPoint(a, b, ctrl, k / 18);
    if (fence && !pointInPolygon(p, fence)) return true;
    for (const other of buildings) {
      if (other === a || other === b) continue;
      if (buildingContains(other, p.x, p.y, 1)) return true;
    }
  }
  return false;
}

// 渲染时把道路弯出建筑与围栏，不改生成数据，种子结果保持不变
function clearRoadControl(a, b, authored, buildings, fence) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const authoredOff = (authored.x - mx) * nx + (authored.y - my) * ny;
  const candidates = [authoredOff, 0];
  for (let mag = 12; mag <= Math.min(90, len * 0.45); mag += 12) {
    candidates.push(authoredOff + mag, authoredOff - mag, mag, -mag);
  }
  for (const off of candidates) {
    const ctrl = { x: mx + nx * off, y: my + ny * off };
    if (!curveHitsObstacle(a, b, ctrl, buildings, fence)) return ctrl;
  }
  return { x: mx, y: my };
}

function roadPolylines(a, b, ctrl, buildings) {
  const segments = [];
  let current = [];
  for (let k = 0; k <= 32; k++) {
    const p = quadPoint(a, b, ctrl, k / 32);
    const blocked = buildings.some(o => {
      const pad = (o === a || o === b) ? -1.5 : 0.5;
      return buildingContains(o, p.x, p.y, pad);
    });
    if (blocked) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(p);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function strokePolyline(ctx, pts, color, width) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawRoad(ctx, village, road) {
  const a = village.buildings[road.i];
  const b = village.buildings[road.j];
  const ctrl = clearRoadControl(a, b, road.ctrl, village.buildings, village.fence);
  const segments = roadPolylines(a, b, ctrl, village.buildings);
  for (const pts of segments) {
    strokePolyline(ctx, pts, '#6a4b32', road.width + 2.2);
    strokePolyline(ctx, pts, '#a67c52', road.width);
    strokePolyline(ctx, pts, 'rgba(214, 176, 122, 0.8)', Math.max(2, road.width * 0.28));
  }
}

function sampleFence(pts, spacing) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.001) continue;
    const steps = Math.max(1, Math.round(len / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      let nx = x - CX;
      let ny = y - CY;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      out.push({ x, y, nx, ny });
    }
  }
  return out;
}

function drawFence(ctx, pts) {
  const samples = sampleFence(pts, 6.2);
  if (samples.length < 8) return;
  let gate = samples[0];
  for (const p of samples) if (p.y > gate.y) gate = p;
  const gap = 18;

  function inGap(p) {
    return Math.hypot(p.x - gate.x, p.y - gate.y) < gap;
  }

  // 一根绑绳，把木桩连成栅栏，而不是两条平行轨
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const p of samples) {
    if (inGap(p)) { started = false; continue; }
    const x = p.x + p.nx * 1.5;
    const y = p.y + p.ny * 1.5;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#8a6848';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  samples.forEach((p, i) => {
    if (inGap(p)) return;
    const tx = -p.ny;
    const ty = p.nx;
    const len = 8 + (i % 3);
    const x0 = p.x + p.nx * -1.5;
    const y0 = p.y + p.ny * -1.5;
    const x1 = p.x + p.nx * len;
    const y1 = p.y + p.ny * len;
    const half = 1.7;
    ctx.beginPath();
    ctx.moveTo(x0 + tx * half, y0 + ty * half);
    ctx.lineTo(x0 - tx * half, y0 - ty * half);
    ctx.lineTo(x1, y1);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? '#5a3f2a' : '#6d5138';
    ctx.fill();
  });

  // 南侧缺口做成门：两根更高的门柱
  for (const sign of [-1, 1]) {
    let best = null;
    let bestD = Infinity;
    for (const p of samples) {
      const along = (p.x - gate.x) * (-gate.ny) + (p.y - gate.y) * gate.nx;
      const d = Math.hypot(p.x - gate.x, p.y - gate.y);
      if (Math.sign(along) !== sign || d < gap - 3 || d > gap + 12) continue;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) continue;
    const tx = -best.ny;
    const ty = best.nx;
    const x0 = best.x + best.nx * -3;
    const y0 = best.y + best.ny * -3;
    const x1 = best.x + best.nx * 14;
    const y1 = best.y + best.ny * 14;
    ctx.beginPath();
    ctx.moveTo(x0 + tx * 2.4, y0 + ty * 2.4);
    ctx.lineTo(x0 - tx * 2.4, y0 - ty * 2.4);
    ctx.lineTo(x1, y1);
    ctx.closePath();
    ctx.fillStyle = '#3d2b1c';
    ctx.fill();
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawHouse(ctx, b) {
  const w = b.w;
  const h = b.h;
  const hw = w / 2;
  const hh = h / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(43,32,22,0.30)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = '#f3e6c8';
  roundRectPath(ctx, -hw, -hh, w, h, 1.5);
  ctx.fill();
  ctx.restore();
  roundRectPath(ctx, -hw, -hh, w, h, 1.5);
  ctx.strokeStyle = '#3a2b1d';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  if (b.type === '市场') {
    const stripes = 5;
    const innerH = h - 8;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#b5544a' : '#f6edd8';
      ctx.fillRect(-hw + 3, -hh + 4 + (innerH / stripes) * i, w - 6, innerH / stripes - 0.8);
    }
    ctx.strokeStyle = 'rgba(43,32,22,0.45)';
    ctx.strokeRect(-hw + 3, -hh + 4, w - 6, innerH);
    return;
  }

  const doorW = b.type === '仓库' ? Math.min(14, w * 0.34) : Math.min(8, w * 0.22);
  const doorH = Math.min(12, h * 0.32);
  ctx.fillStyle = '#6b4428';
  ctx.fillRect(-doorW / 2, hh - doorH - 1.2, doorW, doorH);
  if (b.type === '仓库') {
    ctx.strokeStyle = '#3a2b1d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hh - doorH - 1.2);
    ctx.lineTo(0, hh - 1.2);
    ctx.stroke();
  }

  if (w > 34 && b.type !== '教堂') {
    ctx.fillStyle = '#8faba6';
    const win = Math.min(5.5, w * 0.14);
    ctx.fillRect(-hw + w * 0.16, -2, win, win * 0.75);
    ctx.fillRect(hw - w * 0.16 - win, -2, win, win * 0.75);
  }

  const peak = b.type === '仓库' ? hh * 0.15 : hh + 4;
  const roofBottom = b.type === '仓库' ? -hh * 0.05 : hh * 0.22;
  ctx.beginPath();
  ctx.moveTo(-hw - 3, roofBottom);
  ctx.lineTo(0, -peak);
  ctx.lineTo(hw + 3, roofBottom);
  ctx.closePath();
  ctx.fillStyle = b.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(43,32,22,0.72)';
  ctx.lineWidth = 1.25;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-hw - 3, roofBottom);
  ctx.lineTo(0, -peak);
  ctx.lineTo(0, roofBottom);
  ctx.closePath();
  ctx.fillStyle = 'rgba(43,32,22,0.18)';
  ctx.fill();

  if (b.type !== '教堂') {
    ctx.fillStyle = '#5c4636';
    ctx.fillRect(hw * 0.32, -peak + 2, 4.2, 8);
    if (b.type === '铁匠铺') {
      ctx.strokeStyle = 'rgba(90,90,90,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hw * 0.32 + 6, -peak, 3.2, Math.PI, 0);
      ctx.stroke();
    }
  }

  if (b.type === '教堂') {
    ctx.fillStyle = '#6e6258';
    ctx.fillRect(-4, -peak - 7, 8, 8);
    ctx.strokeStyle = '#3a2b1d';
    ctx.lineWidth = 1;
    ctx.strokeRect(-4, -peak - 7, 8, 8);
    ctx.strokeStyle = '#f4e7c8';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(0, -peak - 7);
    ctx.lineTo(0, -peak - 15);
    ctx.moveTo(-3.5, -peak - 12);
    ctx.lineTo(3.5, -peak - 12);
    ctx.stroke();
  } else if (b.type === '磨坊') {
    ctx.beginPath();
    ctx.arc(hw * 0.15, hh * 0.05, Math.min(8, h * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = '#c8b48a';
    ctx.fill();
    ctx.strokeStyle = '#3a2b1d';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hw * 0.15 - 6, hh * 0.05);
    ctx.lineTo(hw * 0.15 + 6, hh * 0.05);
    ctx.moveTo(hw * 0.15, hh * 0.05 - 6);
    ctx.lineTo(hw * 0.15, hh * 0.05 + 6);
    ctx.stroke();
  } else if (b.type === '旅店') {
    ctx.fillStyle = '#8a2c22';
    ctx.fillRect(-hw - 1, -6, 9, 7);
    ctx.fillStyle = '#f6edd4';
    ctx.font = `bold 7px ${LABEL_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('酒', -hw + 3.5, -2.5);
  }
}

function drawBuildings(ctx, buildings) {
  for (const b of buildings) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    drawHouse(ctx, b);
    ctx.restore();
  }
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function drawLabels(ctx, buildings) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of buildings) {
    const num = String(b.id);
    ctx.font = `bold 13px ${LABEL_FONT}`;
    const nw = ctx.measureText(num).width;
    ctx.font = `bold 12px ${LABEL_FONT}`;
    const tw = ctx.measureText(b.type).width;
    const w = Math.max(36, nw + 12, tw + 14);
    const h = 32;
    const x = b.x - w / 2;
    const y = b.y - h / 2;
    roundRectPath(ctx, x, y, w, h, 7);
    ctx.fillStyle = 'rgba(255,248,232,0.96)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = b.color;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(43,32,22,0.55)';
    ctx.stroke();
    ctx.fillStyle = '#2b2016';
    ctx.font = `bold 13px ${LABEL_FONT}`;
    ctx.fillText(num, b.x, b.y - 7);
    ctx.font = `bold 12px ${LABEL_FONT}`;
    ctx.fillStyle = '#4a241c';
    ctx.fillText(b.type, b.x, b.y + 8);
  }
}

function drawVillageTitle(ctx, village) {
  const name = village.name || '村庄';
  const pop = `约 ${village.population || 0} 人`;
  ctx.save();
  ctx.font = `bold 28px ${LABEL_FONT}`;
  const nw = ctx.measureText(name).width;
  ctx.font = `16px ${LABEL_FONT}`;
  const pw = ctx.measureText(pop).width;
  const w = Math.max(nw, pw) + 28;
  roundRectPath(ctx, 16, 14, w, 70, 6);
  ctx.fillStyle = 'rgba(247, 242, 226, 0.92)';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(43,32,22,0.35)';
  ctx.stroke();
  ctx.fillStyle = '#2b2016';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold 28px ${LABEL_FONT}`;
  ctx.fillText(name, 28, 22);
  ctx.font = `16px ${LABEL_FONT}`;
  ctx.fillText(pop, 28, 56);
  ctx.restore();
}

function renderBuildingInfo(village, container) {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = `<strong>${village.name} · 约 ${village.population} 人 · 共 ${village.buildings.length} 栋建筑</strong>`;
  container.appendChild(title);
  for (const b of village.buildings) {
    const div = document.createElement('div');
    div.textContent = `建筑 ${b.id}：${b.type}（约 ${b.w}×${b.h} 尺）`;
    container.appendChild(div);
  }
  for (let i = 0; i < (village.fields || []).length; i++) {
    const field = village.fields[i];
    const div = document.createElement('div');
    div.textContent = `地块 ${i + 1}：${field.kind === 'orchard' ? '果林' : '种地'}`;
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
  currentVillage = createVillage(opts, seedNum);

  const canvas = document.getElementById('villageCanvas');
  renderVillage(currentVillage, canvas);
  renderBuildingInfo(currentVillage, document.getElementById('buildingInfo'));
}

function exportPng() {
  const canvas = document.getElementById('villageCanvas');
  const link = document.createElement('a');
  link.download = `村庄_${document.getElementById('seedInput').value || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function buildVillageText(village, seed) {
  let text = `村庄建筑清单（种子：${seed}）\n`;
  text += `村名：${village.name}　人口：约 ${village.population} 人\n`;
  text += `建筑数量：${village.buildings.length}　村庄半径：${village.opts.villageRadius}　围栏：${village.opts.fenceEnabled ? '有' : '无'}　地块：${village.fields.length}\n\n`;
  for (const b of village.buildings) {
    text += `建筑 ${b.id}：${b.type}\n`;
  }
  text += '\n';
  village.fields.forEach((f, i) => {
    text += `地块 ${i + 1}：${f.kind === 'orchard' ? '果林' : '种地'}\n`;
  });
  return text;
}

function createVillage(opts, seed) {
  rng = mulberry32(seed >>> 0);
  const village = new Village(opts);
  village.generate();
  return village;
}

function exportTxt() {
  if (!currentVillage) return;
  const seed = document.getElementById('seedInput').value || 'random';
  const text = buildVillageText(currentVillage, seed);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `村庄清单_${seed}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Village,
    createVillage,
    buildVillageText,
    mulberry32,
    hashStringToSeed,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
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
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (currentVillage) renderVillage(currentVillage, document.getElementById('villageCanvas'));
    });
  }
});
}
