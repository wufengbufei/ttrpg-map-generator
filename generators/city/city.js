/* =========================================================
 * 中文 TTRPG 地图生成器 - 城市生成器
 * 算法：凸包城墙 → 放射主干道 + 环路 → Voronoi 街区
 *      → 凸多边形递归切分建筑地块 → 城门/地标渲染
 * 纯前端实现，无依赖；核心算法可在 Node 中 require 做冒烟测试
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
function randFloat(min, max) { return rng() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------- 常量 ----------
const CANVAS_SIZE = 900;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2;
const PLAZA_RADIUS = 30;

const ROOF_COLORS = ['#c9a97a', '#b98f63', '#a8795a', '#d0b285', '#9c7a55', '#b58a6c', '#c7a07a', '#a77a56'];
const ROAD_CASING = '#7a5a3e';
const ROAD_FILL = '#c9a97a';
const BLOCK_FILL = '#e4d5af';
const BLOCK_LINE = 'rgba(122,90,62,0.55)';

const CITY_OPTIONS = {
  blockCount: 36,
  roadCount: 6,
  subdivision: 5,
  wallEnabled: true,
};

function normalizeCityOptions(opts) {
  const raw = opts || {};
  return {
    blockCount: clampInt(raw.blockCount, 12, 100, CITY_OPTIONS.blockCount),
    roadCount: clampInt(raw.roadCount, 3, 12, CITY_OPTIONS.roadCount),
    subdivision: clampInt(raw.subdivision, 1, 10, CITY_OPTIONS.subdivision),
    wallEnabled: raw.wallEnabled !== false,
  };
}

// ---------- 基础几何 ----------
function signedArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonArea(poly) {
  return poly && poly.length >= 3 ? Math.abs(signedArea(poly)) : 0;
}

function polygonCentroid(poly) {
  if (!poly || poly.length === 0) return { x: NaN, y: NaN };
  let crossSum = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = a.x * b.y - b.x * a.y;
    crossSum += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(crossSum) < 1e-9) {
    const avg = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: avg.x / poly.length, y: avg.y / poly.length };
  }
  return { x: cx / (3 * crossSum), y: cy / (3 * crossSum) };
}

function dedupePolygon(poly) {
  const out = [];
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) {
    out.pop();
  }
  return out;
}

// 用半平面裁剪凸多边形：保留 dot(p - 点, 法线) >= 0 的一侧
function clipHalfPlane(poly, px, py, nx, ny) {
  if (!poly || poly.length < 3) return [];
  const out = [];
  const EPS = 1e-7;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = (a.x - px) * nx + (a.y - py) * ny;
    const db = (b.x - px) * nx + (b.y - py) * ny;
    const aIn = da >= -EPS;
    const bIn = db >= -EPS;
    if (aIn) out.push({ x: a.x, y: a.y });
    if (aIn !== bIn) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return dedupePolygon(out);
}

// 凸多边形内缩（dist > 0）或外扩（dist < 0）
function insetPolygon(poly, dist) {
  if (!poly || poly.length < 3) return [];
  if (Math.abs(dist) < 1e-9) return poly.map(p => ({ x: p.x, y: p.y }));
  const orient = signedArea(poly) >= 0 ? 1 : -1;
  let out = poly.map(p => ({ x: p.x, y: p.y }));
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    dx /= len;
    dy /= len;
    // 逆时针时内法线为左法线；顺时针时取右法线
    const nx = orient > 0 ? -dy : dy;
    const ny = orient > 0 ? dx : -dx;
    out = clipHalfPlane(out, a.x + nx * dist, a.y + ny * dist, nx, ny);
    if (out.length < 3) return [];
  }
  return out;
}

function scalePolygon(poly, factor, center) {
  const c = center || polygonCentroid(poly);
  return poly.map(p => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor }));
}

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

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersects = (a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distPointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function segmentSegmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPointSegment(a.x, a.y, c.x, c.y, d.x, d.y),
    distPointSegment(b.x, b.y, c.x, c.y, d.x, d.y),
    distPointSegment(c.x, c.y, a.x, a.y, b.x, b.y),
    distPointSegment(d.x, d.y, a.x, a.y, b.x, b.y)
  );
}

function rayPolygonIntersection(ox, oy, angle, poly) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const qpx = a.x - ox;
    const qpy = a.y - oy;
    const t = (qpx * ey - qpy * ex) / denom;
    const u = (qpx * dy - qpy * dx) / denom;
    if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6) {
      if (!best || t < best.t) {
        best = { t, x: ox + dx * t, y: oy + dy * t };
      }
    }
  }
  return best;
}

function polygonBounds(poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function polygonIntersectsCircle(poly, cx, cy, radius) {
  if (pointInPolygon({ x: cx, y: cy }, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (distPointSegment(cx, cy, a.x, a.y, b.x, b.y) < radius) return true;
  }
  return false;
}

function polygonRoadClear(poly, roads, extraClearance) {
  for (const road of roads) {
    const pts = road.points;
    const count = road.closed ? pts.length : pts.length - 1;
    const clearance = road.width / 2 + extraClearance;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      for (let j = 0; j < poly.length; j++) {
        const c = poly[j];
        const d = poly[(j + 1) % poly.length];
        if (segmentSegmentDistance(c, d, a, b) < clearance) return false;
      }
    }
  }
  return true;
}

// Voronoi 单元：凸边界依次被所有中垂线裁剪
function voronoiCell(site, sites, boundary) {
  let cell = boundary.map(p => ({ x: p.x, y: p.y }));
  for (const other of sites) {
    if (other === site) continue;
    const nx = other.x - site.x;
    const ny = other.y - site.y;
    if (nx * nx + ny * ny < 1e-12) continue;
    const mx = (site.x + other.x) / 2;
    const my = (site.y + other.y) / 2;
    // 保留距离 site 更近的一侧：dot(p - m, other - site) <= 0
    cell = clipHalfPlane(cell, mx, my, -nx, -ny);
    if (cell.length < 3) return [];
  }
  return cell;
}

function normalizeAngle(a) {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

// 用一条过质心的随机直线把凸多边形切成两块
function splitPolygonInTwo(poly) {
  const c = polygonCentroid(poly);
  const bounds = polygonBounds(poly);
  const wide = bounds.width >= bounds.height;
  const baseNx = wide ? 1 : 0;
  const baseNy = wide ? 0 : 1;
  const span = wide ? bounds.width : bounds.height;
  const baseArea = polygonArea(poly);

  for (let attempt = 0; attempt < 6; attempt++) {
    const rot = randFloat(-0.6, 0.6);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const nx = baseNx * cos - baseNy * sin;
    const ny = baseNx * sin + baseNy * cos;
    const offset = randFloat(-0.16, 0.16) * span;
    const px = c.x + nx * offset;
    const py = c.y + ny * offset;

    const a = clipHalfPlane(poly, px, py, nx, ny);
    const b = clipHalfPlane(poly, px, py, -nx, -ny);
    if (a.length < 3 || b.length < 3) continue;
    const aa = polygonArea(a);
    const ab = polygonArea(b);
    if (aa < 35 || ab < 35) continue;
    if (aa + ab < baseArea * 0.9) continue;
    return [a, b];
  }
  return null;
}

// 每次切分当前面积最大的地块，直到达到目标数量
function subdividePolygon(poly, target) {
  const pieces = [poly];
  if (target <= 1) return pieces;
  let guard = 0;
  while (pieces.length < target && guard < target * 8) {
    guard++;
    let index = 0;
    let maxArea = -1;
    for (let i = 0; i < pieces.length; i++) {
      const area = polygonArea(pieces[i]);
      if (area > maxArea) {
        maxArea = area;
        index = i;
      }
    }
    if (maxArea < 180) break;
    const split = splitPolygonInTwo(pieces[index]);
    if (!split) break;
    pieces.splice(index, 1, split[0], split[1]);
  }
  return pieces;
}

// ---------- 城市 ----------
class City {
  constructor(opts) {
    this.opts = normalizeCityOptions(opts);
    this.R = 0;
    this.boundary = [];
    this.innerBoundary = [];
    this.wallPolygon = null;
    this.plaza = { x: CX, y: CY, radius: PLAZA_RADIUS };
    this.roadAngles = [];
    this.gates = [];
    this.roads = [];
    this.sites = [];
    this.blocks = [];
    this.buildings = [];
    this.centralBlock = null;
    this.wall = null;
    this.stats = {};
  }

  generate() {
    this.R = clamp(200 + Math.sqrt(this.opts.blockCount) * 17, 250, 368);

    this.boundary = this.buildCityBoundary();
    let inner = insetPolygon(this.boundary, this.opts.wallEnabled ? 16 : 7);
    if (inner.length < 3) inner = scalePolygon(this.boundary, 0.93);
    this.innerBoundary = inner;

    if (this.opts.wallEnabled) {
      let wall = insetPolygon(this.boundary, -8);
      if (wall.length < 3) wall = scalePolygon(this.boundary, 1.025);
      this.wallPolygon = wall;
    } else {
      this.wallPolygon = null;
    }

    this.roadAngles = this.makeRoadAngles();
    const gatePoly = this.wallPolygon || this.boundary;
    this.gates = this.roadAngles.map(angle => {
      const hit = rayPolygonIntersection(CX, CY, angle, gatePoly);
      return hit || {
        x: CX + Math.cos(angle) * this.R,
        y: CY + Math.sin(angle) * this.R,
      };
    });

    this.roads = this.buildRoads();
    this.sites = this.placeSites();
    this.relaxSites();
    this.blocks = this.buildBlocks();
    this.assignBlockTypes();
    this.buildBuildings();
    this.buildWall();

    this.stats = {
      blockCount: this.blocks.length,
      buildingCount: this.buildings.length,
      roadCount: this.roads.length,
      gateCount: this.wall ? this.wall.gates.length : 0,
      landmarkCount: this.blocks.filter(b => b.isLandmark).length,
    };
    return this;
  }

  // 带轻微起伏的凸多边形城界（凸包保证后续裁剪稳定）
  buildCityBoundary() {
    const R = this.R;
    const raw = [];
    const n = 56;
    const p1 = randFloat(0, Math.PI * 2);
    const p2 = randFloat(0, Math.PI * 2);
    const p3 = randFloat(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = R * (
        1 +
        0.030 * Math.sin(3 * a + p1) +
        0.018 * Math.sin(5 * a + p2) +
        0.012 * Math.sin(9 * a + p3) +
        randFloat(-0.006, 0.006)
      );
      raw.push({ x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r });
    }
    let hull = convexHull(raw);
    if (hull.length < 3) {
      hull = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        hull.push({ x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R });
      }
    }
    return hull;
  }

  makeRoadAngles() {
    const n = this.opts.roadCount;
    const step = (Math.PI * 2) / n;
    const offset = randFloat(0, step);
    const angles = [];
    for (let i = 0; i < n; i++) {
      angles.push(normalizeAngle(offset + i * step + randFloat(-step * 0.16, step * 0.16)));
    }
    angles.sort((a, b) => a - b);
    return angles;
  }

  buildRoads() {
    const roads = [];
    const plaza = this.plaza;

    // 放射主干道：从中央广场边缘通到城门
    for (let i = 0; i < this.roadAngles.length; i++) {
      const angle = this.roadAngles[i];
      const end = this.gates[i];
      const dist = Math.hypot(end.x - CX, end.y - CY);
      const startR = plaza.radius + 2;
      if (dist <= startR + 4) continue;

      const points = [];
      const count = 7;
      const phase = randFloat(0, Math.PI * 2);
      const wobble = randFloat(2.5, 5.5);
      const tangentX = -Math.sin(angle);
      const tangentY = Math.cos(angle);

      for (let k = 0; k < count; k++) {
        const t = k / (count - 1);
        const r = startR + (dist - startR) * t;
        const lateral = Math.sin(t * Math.PI) * Math.sin(t * Math.PI * 1.7 + phase) * wobble;
        let x = CX + Math.cos(angle) * r + tangentX * lateral;
        let y = CY + Math.sin(angle) * r + tangentY * lateral;
        if (k > 0 && k < count - 1 && !pointInPolygon({ x, y }, this.boundary)) {
          x = CX + Math.cos(angle) * r;
          y = CY + Math.sin(angle) * r;
        }
        points.push({ x, y });
      }
      points[points.length - 1] = { x: end.x, y: end.y };
      roads.push({ kind: 'radial', points, closed: false, width: randFloat(9.5, 11) });
    }

    // 环路：小城市一条，大中城市两条
    const ringFractions = this.opts.blockCount < 20 ? [0.58] : [0.42, 0.72];
    for (const fraction of ringFractions) {
      const baseR = this.R * fraction * randFloat(0.985, 1.015);
      const phase1 = randFloat(0, Math.PI * 2);
      const phase2 = randFloat(0, Math.PI * 2);
      const points = [];
      const count = 64;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const r = baseR * (1 + 0.022 * Math.sin(3 * a + phase1) + 0.012 * Math.sin(7 * a + phase2));
        points.push({ x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r });
      }
      roads.push({ kind: 'ring', points, closed: true, width: 7.5 });
    }
    return roads;
  }

  // 城内均匀撒点（中心固定一点），作为 Voronoi 站点
  placeSites() {
    const count = this.opts.blockCount;
    const sites = [{ x: CX, y: CY }];
    const area = Math.max(polygonArea(this.innerBoundary), 1);
    const minDist = Math.sqrt(area / count) * 0.38;

    let guard = 0;
    while (sites.length < count && guard < count * 300) {
      guard++;
      const a = randFloat(0, Math.PI * 2);
      const r = this.R * 0.88 * Math.sqrt(rng());
      const x = CX + Math.cos(a) * r;
      const y = CY + Math.sin(a) * r;
      if (!pointInPolygon({ x, y }, this.innerBoundary)) continue;
      let ok = true;
      for (const s of sites) {
        if (Math.hypot(s.x - x, s.y - y) < minDist) { ok = false; break; }
      }
      if (ok) sites.push({ x, y });
    }

    // 放宽最小间距兜底
    guard = 0;
    while (sites.length < count && guard < count * 300) {
      guard++;
      const a = randFloat(0, Math.PI * 2);
      const r = this.R * 0.88 * Math.sqrt(rng());
      const x = CX + Math.cos(a) * r;
      const y = CY + Math.sin(a) * r;
      if (!pointInPolygon({ x, y }, this.innerBoundary)) continue;
      let ok = true;
      for (const s of sites) {
        if (Math.hypot(s.x - x, s.y - y) < minDist * 0.35) { ok = false; break; }
      }
      if (ok) sites.push({ x, y });
    }

    // 极端情况下用螺旋点补齐，保证街区数量
    let k = 0;
    while (sites.length < count) {
      const a = k * 2.399963 + randFloat(0, 0.2);
      const r = this.R * 0.8 * Math.sqrt((k + 1) / count);
      sites.push({ x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r });
      k++;
    }
    return sites;
  }

  // Lloyd 松弛两轮，让街区大小更均匀；中心点保持不动
  relaxSites() {
    for (let iter = 0; iter < 2; iter++) {
      const cells = this.sites.map(s => voronoiCell(s, this.sites, this.innerBoundary));
      const next = this.sites.map((site, i) => {
        if (i === 0) return { x: CX, y: CY };
        const cell = cells[i];
        if (!cell || cell.length < 3) return site;
        const c = polygonCentroid(cell);
        if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return site;
        const nx = site.x + (c.x - site.x) * 0.65;
        const ny = site.y + (c.y - site.y) * 0.65;
        if (!pointInPolygon({ x: nx, y: ny }, this.innerBoundary)) return site;
        return { x: nx, y: ny };
      });
      this.sites = next;
    }
  }

  buildBlocks() {
    const blocks = [];
    this.sites.forEach(site => {
      const polygon = voronoiCell(site, this.sites, this.innerBoundary);
      if (!polygon || polygon.length < 3) return;
      const area = polygonArea(polygon);
      if (area < 2) return;
      blocks.push({
        id: 0,
        polygon,
        area,
        centroid: polygonCentroid(polygon),
        type: '居住区',
        isLandmark: false,
        landmarkPolygon: null,
        buildingCount: 0,
        buildings: [],
      });
    });

    blocks.sort((a, b) => (a.centroid.y - b.centroid.y) || (a.centroid.x - b.centroid.x));
    blocks.forEach((b, i) => { b.id = i + 1; });
    return blocks;
  }

  assignBlockTypes() {
    const center = { x: CX, y: CY };
    let central = this.blocks.find(b => pointInPolygon(center, b.polygon));
    if (!central) {
      let best = Infinity;
      for (const b of this.blocks) {
        const d = Math.hypot(b.centroid.x - CX, b.centroid.y - CY);
        if (d < best) { best = d; central = b; }
      }
    }
    if (central) {
      central.type = '中央广场';
      this.centralBlock = central;
    }

    const landmarkTypes = ['大教堂', '领主城堡'];
    const candidates = this.blocks
      .filter(b => b !== central && b.area > 450)
      .sort((a, b) => b.area - a.area);

    let found = 0;
    for (const block of candidates) {
      if (found >= landmarkTypes.length) break;
      const footprint = this.makeLandmarkFootprint(block);
      if (!footprint) continue;
      block.type = landmarkTypes[found];
      block.isLandmark = true;
      block.landmarkPolygon = footprint;
      found++;
    }
  }

  makeLandmarkFootprint(block) {
    let buildable = insetPolygon(block.polygon, 4);
    if (buildable.length < 3) buildable = scalePolygon(block.polygon, 0.85);
    if (polygonArea(buildable) < 500) return null;

    for (const factor of [0.66, 0.52, 0.40]) {
      const footprint = scalePolygon(buildable, factor);
      if (polygonArea(footprint) < 320) continue;
      if (!polygonRoadClear(footprint, this.roads, 2.5)) continue;
      if (polygonIntersectsCircle(footprint, this.plaza.x, this.plaza.y, this.plaza.radius + 2)) continue;
      return footprint;
    }
    return null;
  }

  targetBuildingCount(block, buildable) {
    const area = polygonArea(buildable);
    const perBuilding = 2600 - ((this.opts.subdivision - 1) / 9) * 1700;
    let target = Math.round(area / perBuilding);
    if (block.type === '中央广场') target = Math.round(target * 0.6);
    target = clamp(target, 1, 16);
    target = Math.min(target, Math.max(1, Math.floor(area / 150)));
    return target;
  }

  // 建筑必须避开道路与中央广场，冲突时先缩小再放弃
  fitBuilding(poly) {
    for (const factor of [1, 0.70, 0.52]) {
      const fp = factor === 1 ? poly : scalePolygon(poly, factor);
      if (polygonArea(fp) < 40) continue;
      if (!polygonRoadClear(fp, this.roads, 2.2)) continue;
      if (polygonIntersectsCircle(fp, this.plaza.x, this.plaza.y, this.plaza.radius + 1.5)) continue;
      return fp;
    }
    return null;
  }

  buildBuildings() {
    this.buildings = [];
    for (const block of this.blocks) {
      let buildable = insetPolygon(block.polygon, 3 + randFloat(0, 1.5));
      if (buildable.length < 3) buildable = scalePolygon(block.polygon, 0.9);

      if (block.isLandmark && block.landmarkPolygon) {
        const building = {
          id: 0,
          blockId: block.id,
          type: block.type,
          color: block.type === '大教堂' ? '#8d8396' : '#6f5846',
          polygon: block.landmarkPolygon,
          area: polygonArea(block.landmarkPolygon),
          isLandmark: true,
        };
        block.buildings.push(building);
        this.buildings.push(building);
        block.buildingCount = 1;
        continue;
      }

      const target = this.targetBuildingCount(block, buildable);
      const pieces = subdividePolygon(buildable, target);
      for (let i = 0; i < pieces.length; i++) {
        if (pieces.length > 2 && rng() < 0.05) continue;
        const raw = scalePolygon(pieces[i], randFloat(0.79, 0.87));
        const footprint = this.fitBuilding(raw);
        if (!footprint) continue;
        const building = {
          id: 0,
          blockId: block.id,
          type: '民居',
          color: pick(ROOF_COLORS),
          polygon: footprint,
          area: polygonArea(footprint),
          isLandmark: false,
        };
        block.buildings.push(building);
        this.buildings.push(building);
      }
      block.buildingCount = block.buildings.length;
    }

    this.buildings.forEach((b, i) => { b.id = i + 1; });
  }

  buildWall() {
    if (!this.opts.wallEnabled || !this.wallPolygon) {
      this.wall = null;
      return;
    }
    const gates = this.gates.map((g, i) => ({
      x: g.x,
      y: g.y,
      angle: this.roadAngles[i],
    }));

    // 在相邻城门之间放置少量瞭望塔
    const towers = [];
    const n = gates.length;
    const stepPairs = Math.max(1, Math.ceil(n / 4));
    for (let i = 0; i < n; i += stepPairs) {
      const a1 = this.roadAngles[i];
      const a2 = this.roadAngles[(i + stepPairs) % n];
      let mid = normalizeAngle(a1 + normalizeAngle(a2 - a1) / 2);
      if (mid === a1) mid = a1 + 0.1;
      const hit = rayPolygonIntersection(CX, CY, mid, this.wallPolygon);
      if (!hit) continue;
      let clear = true;
      for (const g of gates) {
        if (Math.hypot(hit.x - g.x, hit.y - g.y) < 24) { clear = false; break; }
      }
      if (clear) towers.push({ x: hit.x, y: hit.y });
    }

    this.wall = { polygon: this.wallPolygon, gates, towers };
  }
}

function createCity(opts, seed) {
  rng = mulberry32(seed >>> 0);
  return new City(opts).generate();
}

// ---------- 渲染 ----------
function tracePolygon(ctx, poly) {
  if (!poly || poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

function drawBlocks(ctx, blocks) {
  for (const block of blocks) {
    tracePolygon(ctx, block.polygon);
    ctx.fillStyle = BLOCK_FILL;
    ctx.fill();
    ctx.strokeStyle = BLOCK_LINE;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
}

function drawRoads(ctx, roads) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 先画深色基层，再画浅色路面，交叉处更自然
  for (const road of roads) {
    const pts = road.points;
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (road.closed) ctx.closePath();
    ctx.strokeStyle = ROAD_CASING;
    ctx.lineWidth = road.width + 3.5;
    ctx.stroke();
  }
  for (const road of roads) {
    const pts = road.points;
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (road.closed) ctx.closePath();
    ctx.strokeStyle = ROAD_FILL;
    ctx.lineWidth = road.width;
    ctx.stroke();
  }
}

function drawPlaza(ctx, plaza) {
  ctx.beginPath();
  ctx.arc(plaza.x, plaza.y, plaza.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#dfcd9d';
  ctx.fill();
  ctx.strokeStyle = 'rgba(43,32,22,0.30)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 广场铺装环
  ctx.beginPath();
  ctx.arc(plaza.x, plaza.y, plaza.radius * 0.72, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(122,90,62,0.35)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 中央喷泉
  ctx.beginPath();
  ctx.arc(plaza.x, plaza.y, 8.5, 0, Math.PI * 2);
  ctx.fillStyle = '#9fb6b2';
  ctx.fill();
  ctx.strokeStyle = 'rgba(43,32,22,0.45)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(plaza.x, plaza.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#6e8a86';
  ctx.fill();
}

function longestEdgeAngle(poly) {
  let best = 0;
  let ang = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > best) {
      best = len;
      ang = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return ang;
}

function drawBuildings(ctx, buildings) {
  for (const b of buildings) {
    const poly = b.polygon;
    if (!poly || poly.length < 3) continue;

    ctx.save();
    ctx.translate(2.4, 3);
    tracePolygon(ctx, poly);
    ctx.fillStyle = 'rgba(43,32,22,0.20)';
    ctx.fill();
    ctx.restore();

    // 墙体
    tracePolygon(ctx, poly);
    ctx.fillStyle = b.type === '领主城堡' ? '#d9c7a4' : '#f4e7c8';
    ctx.fill();
    ctx.strokeStyle = '#3a2b1d';
    ctx.lineWidth = b.isLandmark ? 2.2 : 1.35;
    ctx.stroke();

    const roof = scalePolygon(poly, b.isLandmark ? 0.9 : 0.82);
    if (roof.length < 3) continue;
    tracePolygon(ctx, roof);
    ctx.fillStyle = b.color;
    ctx.fill();

    const center = polygonCentroid(roof);
    ctx.save();
    tracePolygon(ctx, roof);
    ctx.clip();
    ctx.translate(center.x, center.y);
    ctx.rotate(longestEdgeAngle(poly));
    ctx.fillStyle = 'rgba(43,32,22,0.16)';
    ctx.fillRect(-500, 0, 1000, 500);
    ctx.strokeStyle = 'rgba(255,248,232,0.38)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-500, 0);
    ctx.lineTo(500, 0);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(43,32,22,0.12)';
    ctx.beginPath();
    for (let row = -36; row <= 36; row += 6) {
      ctx.moveTo(-500, row);
      ctx.lineTo(500, row);
    }
    ctx.stroke();
    ctx.restore();

    tracePolygon(ctx, roof);
    ctx.strokeStyle = 'rgba(43,32,22,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (b.type === '大教堂') {
      ctx.strokeStyle = '#f6edd4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y - 9);
      ctx.lineTo(center.x, center.y + 7);
      ctx.moveTo(center.x - 6, center.y - 3);
      ctx.lineTo(center.x + 6, center.y - 3);
      ctx.stroke();
    } else if (b.type === '领主城堡') {
      ctx.fillStyle = '#4a3a2a';
      for (let i = 0; i < roof.length; i += 2) {
        const p = roof[i];
        ctx.fillRect(p.x - 2.2, p.y - 2.2, 4.4, 4.4);
      }
    } else if (b.area > 280) {
      ctx.fillStyle = '#5c4636';
      ctx.fillRect(center.x + 4, center.y - 8, 4, 7);
    }
  }
}

// 把城墙边拆成小段，便于在城门外留出缺口
function samplePolygonEdges(poly, step) {
  const segments = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const count = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < count; k++) {
      const t1 = k / count;
      const t2 = (k + 1) / count;
      segments.push([
        { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
        { x: a.x + (b.x - a.x) * t2, y: a.y + (b.y - a.y) * t2 },
      ]);
    }
  }
  return segments;
}

function strokeSegments(ctx, segments, color, width) {
  if (segments.length === 0) return;
  ctx.beginPath();
  for (const [a, b] of segments) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawWall(ctx, wall) {
  const gateHalf = 13;
  const segments = samplePolygonEdges(wall.polygon, 4.5).filter(([a, b]) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return wall.gates.every(g => Math.hypot(mx - g.x, my - g.y) > gateHalf);
  });

  strokeSegments(ctx, segments, '#4a3a2a', 10);
  strokeSegments(ctx, segments, '#b7a077', 6.2);

  // 城垛：沿墙外侧间隔点出深色小方块
  for (let i = 0; i < segments.length; i += 4) {
    const [a, b] = segments[i];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = mx - CX;
    const dy = my - CY;
    const len = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = 'rgba(43,32,22,0.55)';
    ctx.fillRect(mx + (dx / len) * 4.5 - 1.5, my + (dy / len) * 4.5 - 1.5, 3, 3);
  }

  // 瞭望塔
  for (const t of wall.towers || []) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4a3a2a';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(t.x, t.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#b7a077';
    ctx.fill();
  }

  // 城门两侧门楼
  for (const g of wall.gates) {
    const tx = -Math.sin(g.angle);
    const ty = Math.cos(g.angle);
    for (const sign of [-1, 1]) {
      const x = g.x + tx * sign * (gateHalf + 4);
      const y = g.y + ty * sign * (gateHalf + 4);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#4a3a2a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#c9a97a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(43,32,22,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

const CITY_FONT = '"Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif';

function pointEdgeDistance(poly, x, y) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    best = Math.min(best, distPointSegment(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

function roadClearanceAt(city, x, y) {
  let best = Infinity;
  for (const road of city.roads) {
    const pts = road.points;
    if (!pts || pts.length < 2) continue;
    const count = road.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = distPointSegment(x, y, a.x, a.y, b.x, b.y) - road.width / 2;
      if (d < best) best = d;
    }
  }
  return best;
}

// 在街区内部挑一个尽量远离道路的落点，避免编号压在路面上
function labelAnchor(poly, city) {
  const bounds = polygonBounds(poly);
  const span = Math.max(bounds.width, bounds.height);
  const step = span > 80 ? 8 : 5;
  const seeds = [polygonCentroid(poly)];
  for (let y = bounds.minY + 2; y <= bounds.maxY - 2; y += step) {
    for (let x = bounds.minX + 2; x <= bounds.maxX - 2; x += step) seeds.push({ x, y });
  }
  let best = null;
  let bestScore = -Infinity;
  let fallback = null;
  let fallbackScore = -Infinity;
  for (const p of seeds) {
    if (!Number.isFinite(p.x) || !pointInPolygon(p, poly)) continue;
    const edge = pointEdgeDistance(poly, p.x, p.y);
    const road = roadClearanceAt(city, p.x, p.y);
    const relaxed = Math.min(edge, Math.max(road, 0)) + edge * 0.1;
    if (relaxed > fallbackScore) { fallbackScore = relaxed; fallback = p; }
    if (road < 9) continue;
    const score = Math.min(edge, road) + edge * 0.15;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best || fallback || polygonCentroid(poly);
}

function drawNumberBadge(ctx, x, y, text, fontSize) {
  ctx.font = `bold ${fontSize}px ${CITY_FONT}`;
  const tw = ctx.measureText(text).width;
  const w = Math.max(fontSize + 6, tw + 8);
  const h = fontSize + 6;
  ctx.beginPath();
  const r = h / 2;
  ctx.moveTo(x - w / 2 + r, y - h / 2);
  ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r);
  ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
  ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r);
  ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,248,232,0.94)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(43,32,22,0.45)';
  ctx.stroke();
  ctx.fillStyle = '#2b2016';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  return { x: x - w / 2, y: y - h / 2, w, h };
}

function rectsOverlap(a, b, pad = 0) {
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
}

function drawBlockLabels(ctx, city) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badges = [];
  const placed = [];

  for (const block of city.blocks) {
    const anchor = block.type === '中央广场'
      ? { x: city.plaza.x, y: city.plaza.y }
      : labelAnchor(block.polygon, city);
    const clearance = roadClearanceAt(city, anchor.x, anchor.y);
    const fontSize = clearance < 11 || block.area < 420 ? 10 : 12;
    const badge = drawNumberBadge(ctx, anchor.x, anchor.y, String(block.id), fontSize);
    badges.push(badge);
    placed.push(badge);

    if (block.type === '居住区') continue;

    ctx.font = `bold 12px ${CITY_FONT}`;
    const text = block.type;
    const tw = ctx.measureText(text).width;
    const th = 16;
    const candidates = [];
    if (block.type === '中央广场') {
      for (let i = 0; i < 12; i++) {
        const a = Math.PI / 2 + i * (Math.PI / 6);
        candidates.push({
          x: city.plaza.x + Math.cos(a) * (city.plaza.radius + 18),
          y: city.plaza.y + Math.sin(a) * (city.plaza.radius + 18),
        });
      }
    } else {
      candidates.push(
        { x: anchor.x, y: anchor.y + badge.h / 2 + 12 },
        { x: anchor.x, y: anchor.y - badge.h / 2 - 12 },
        { x: anchor.x + badge.w / 2 + tw / 2 + 8, y: anchor.y },
        { x: anchor.x - badge.w / 2 - tw / 2 - 8, y: anchor.y }
      );
    }
    for (const c of candidates) {
      const rect = { x: c.x - tw / 2 - 2, y: c.y - th / 2, w: tw + 4, h: th };
      if (rect.x < 6 || rect.y < 8 || rect.x + rect.w > CANVAS_SIZE - 6 || rect.y + rect.h > CANVAS_SIZE - 8) continue;
      if (block.type !== '中央广场' && !pointInPolygon(c, block.polygon)) continue;
      if (roadClearanceAt(city, c.x, c.y) < 8) continue;
      if (placed.some(p => rectsOverlap(rect, p, 2))) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(236,224,196,0.95)';
      ctx.strokeText(text, c.x, c.y);
      ctx.fillStyle = '#4a241c';
      ctx.fillText(text, c.x, c.y);
      placed.push(rect);
      break;
    }
  }
}

function renderCity(city, canvas) {
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');

  // 羊皮纸底色
  ctx.fillStyle = '#ece0c4';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  drawBlocks(ctx, city.blocks);
  drawRoads(ctx, city.roads);
  drawPlaza(ctx, city.plaza);
  drawBuildings(ctx, city.buildings);
  if (city.wall) drawWall(ctx, city.wall);
  drawBlockLabels(ctx, city);
}

function renderBlockInfo(city, container) {
  container.innerHTML = '';
  const summary = document.createElement('div');
  const gateInfo = city.wall ? `　城门 ${city.wall.gates.length} 座` : '　无城墙';
  summary.innerHTML = `<strong>共 ${city.blocks.length} 个街区 · ${city.buildings.length} 栋建筑</strong><br>` +
    `<span>地标 ${city.stats.landmarkCount} 处${gateInfo}</span>`;
  container.appendChild(summary);

  for (const block of city.blocks) {
    const div = document.createElement('div');
    div.textContent = `街区 ${block.id}：${block.type} · 约 ${block.buildingCount} 栋建筑`;
    container.appendChild(div);
  }
}

// ---------- 清单导出 ----------
function buildCityText(city, seedText) {
  let text = `城市街区清单（种子：${seedText}）\n`;
  text += `参数：目标街区 ${city.opts.blockCount}　放射主干道 ${city.opts.roadCount} 条　` +
    `街区细分密度 ${city.opts.subdivision}　城墙：${city.opts.wallEnabled ? '有' : '无'}\n`;
  text += `实际街区：${city.blocks.length} 个　建筑总数：${city.buildings.length} 栋　` +
    `城门：${city.wall ? city.wall.gates.length : 0} 座\n\n`;
  for (const block of city.blocks) {
    text += `街区 ${block.id}（${block.type}）：约 ${block.buildingCount} 栋建筑\n`;
  }
  return text;
}

// ---------- 页面交互 ----------
let currentCity = null;
let currentSeedText = '';

function readCityOptions() {
  return {
    blockCount: parseInt(document.getElementById('blockCount').value, 10),
    roadCount: parseInt(document.getElementById('roadCount').value, 10),
    subdivision: parseInt(document.getElementById('subdivision').value, 10),
    wallEnabled: document.getElementById('wallToggle').checked,
  };
}

function syncCityLabels() {
  document.getElementById('valScale').textContent = document.getElementById('blockCount').value + ' 个';
  document.getElementById('valRoads').textContent = document.getElementById('roadCount').value + ' 条';
  document.getElementById('valSubdiv').textContent = document.getElementById('subdivision').value + ' 级';
}

function generateCityPage() {
  const opts = readCityOptions();
  const seedInput = document.getElementById('seedInput');
  const seedText = seedInput.value.trim();
  let seedNum;

  if (seedText) {
    seedNum = /^\d+$/.test(seedText)
      ? (parseInt(seedText, 10) >>> 0)
      : hashStringToSeed(seedText);
    currentSeedText = seedText;
  } else {
    seedNum = Math.floor(Math.random() * 1000000000);
    seedInput.value = String(seedNum);
    currentSeedText = String(seedNum);
  }

  currentCity = createCity(opts, seedNum);
  renderCity(currentCity, document.getElementById('cityCanvas'));
  renderBlockInfo(currentCity, document.getElementById('blockInfo'));
}

function safeFileName(text) {
  return String(text || 'random').replace(/[\\/:*?"<>|\s]+/g, '_');
}

function exportCityPng() {
  if (!currentCity) return;
  const canvas = document.getElementById('cityCanvas');
  const link = document.createElement('a');
  link.download = `城市_${safeFileName(currentSeedText)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportCityTxt() {
  if (!currentCity) return;
  const text = buildCityText(currentCity, currentSeedText || 'random');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `城市清单_${safeFileName(currentSeedText)}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function initCityPage() {
  const sliderIds = ['blockCount', 'roadCount', 'subdivision'];
  sliderIds.forEach(id => document.getElementById(id).addEventListener('input', syncCityLabels));
  document.getElementById('wallToggle').addEventListener('change', generateCityPage);
  document.getElementById('generateBtn').addEventListener('click', generateCityPage);
  document.getElementById('exportPngBtn').addEventListener('click', exportCityPng);
  document.getElementById('exportTxtBtn').addEventListener('click', exportCityTxt);
  document.getElementById('randomSeedBtn').addEventListener('click', () => {
    document.getElementById('seedInput').value = '';
    generateCityPage();
  });

  syncCityLabels();
  generateCityPage();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (currentCity) renderCity(currentCity, document.getElementById('cityCanvas'));
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initCityPage);
}

// ---------- 导出（Node 冒烟测试 / 浏览器控制台） ----------
const CityGeneratorAPI = {
  mulberry32,
  hashStringToSeed,
  normalizeCityOptions,
  City,
  createCity,
  renderCity,
  renderBlockInfo,
  buildCityText,
  CANVAS_SIZE,
  CX,
  CY,
  geometry: {
    signedArea,
    polygonArea,
    polygonCentroid,
    clipHalfPlane,
    insetPolygon,
    scalePolygon,
    convexHull,
    pointInPolygon,
    distPointSegment,
    segmentsIntersect,
    segmentSegmentDistance,
    rayPolygonIntersection,
    polygonBounds,
    polygonIntersectsCircle,
    polygonRoadClear,
    voronoiCell,
    splitPolygonInTwo,
    subdividePolygon,
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CityGeneratorAPI;
}
if (typeof window !== 'undefined') {
  window.CityGenerator = CityGeneratorAPI;
}
