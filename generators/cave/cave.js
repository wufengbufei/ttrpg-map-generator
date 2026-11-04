/* =========================================================
 * 中文 TTRPG 地图生成器 - 洞穴 / 林间生成器
 * 算法：元胞自动机（随机噪声 + 邻居计数/密度约束平滑）
 *      → 4-邻接洪泛连通清理 → 种子化树木/灌木/碎石装饰
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

// 数字种子原样使用；文字种子走 hashStringToSeed；空字符串返回 null
function seedToNumber(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? (parseInt(s, 10) >>> 0) : hashStringToSeed(s);
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ---------- 单元格类型 ----------
const ROCK = 0;
const FLOOR = 1;

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeOptions(opts) {
  const raw = opts || {};
  return {
    w: clampInt(raw.w, 16, 160, 50),
    h: clampInt(raw.h, 12, 120, 38),
    rockFill: clampInt(raw.rockFill, 10, 85, 47),
    smoothing: clampInt(raw.smoothing, 0, 12, 4),
    decorationDensity: clampInt(raw.decorationDensity, 0, 60, 12),
    style: raw.style === 'forest' ? 'forest' : 'cave',
  };
}

class CaveMap {
  constructor(opts, seed) {
    this.opts = normalizeOptions(opts);
    this.w = this.opts.w;
    this.h = this.opts.h;
    this.rockFill = this.opts.rockFill;
    this.smoothing = this.opts.smoothing;
    this.seed = (typeof seed === 'number' && Number.isFinite(seed)) ? (seed >>> 0) : 0;
    this.rng = mulberry32(this.seed);

    this.grid = new Uint8Array(this.w * this.h); // 默认 0 = ROCK
    this.decorations = [];
    this.regions = [];
    this.stats = {};
    this._cleanupStats = {
      regionCountBeforeCleanup: 0,
      removedRegions: 0,
      removedCells: 0,
      largestRegionSize: 0,
    };
    this._fallbackUsed = false;
  }

  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inBounds(x, y) ? this.grid[this.idx(x, y)] : ROCK; }
  set(x, y, value) { if (this.inBounds(x, y)) this.grid[this.idx(x, y)] = value; }
  isFloor(x, y) { return this.get(x, y) === FLOOR; }

  minimumCaveArea() {
    return Math.max(24, Math.floor(this.w * this.h * 0.015));
  }

  // 初始噪声：边界保持岩石，内部按填充率随机撒岩石
  seedNoise() {
    const { w, h, rockFill } = this;
    this.grid.fill(ROCK);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        this.grid[this.idx(x, y)] = this.rng() * 100 < rockFill ? ROCK : FLOOR;
      }
    }
  }

  countRockNeighbors(x, y) {
    let rocks = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.get(x + dx, y + dy) === ROCK) rocks++;
      }
    }
    return rocks;
  }

  countFloorNeighbors(x, y) {
    let floors = 0;
    if (this.isFloor(x - 1, y)) floors++;
    if (this.isFloor(x + 1, y)) floors++;
    if (this.isFloor(x, y - 1)) floors++;
    if (this.isFloor(x, y + 1)) floors++;
    return floors;
  }

  // 每轮统计 3×3 邻域中的岩石数量，再按岩石密度目标保留得分最高的格子。
  // 这仍然是元胞自动机的邻域计数平滑，但额外加了全局密度约束，
  // 避免纯 4/5 阈值规则在多次迭代后坍缩成“全岩石”或“全空地”。
  smooth() {
    const { w, h, smoothing, rockFill } = this;
    const interiorCells = (w - 2) * (h - 2);
    const targetRock = Math.max(0, Math.min(
      interiorCells,
      Math.round(interiorCells * rockFill / 100)
    ));

    for (let iteration = 0; iteration < smoothing; iteration++) {
      const candidates = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const rocks = this.countRockNeighbors(x, y);
          const selfBonus = this.get(x, y) === ROCK ? 1 : 0;
          // 邻居数权重最高；自身状态用于保持结构；微小抖动稳定打破平局
          const score = rocks * 2 + selfBonus + this.rng();
          candidates.push({ x, y, score });
        }
      }

      candidates.sort((a, b) => b.score - a.score);

      const next = new Uint8Array(w * h).fill(FLOOR);
      for (let x = 0; x < w; x++) {
        next[x] = ROCK;
        next[(h - 1) * w + x] = ROCK;
      }
      for (let y = 0; y < h; y++) {
        next[y * w] = ROCK;
        next[y * w + w - 1] = ROCK;
      }
      for (let i = 0; i < targetRock; i++) {
        const c = candidates[i];
        next[this.idx(c.x, c.y)] = ROCK;
      }
      this.grid = next;
    }
  }

  // 4-邻接洪泛，返回所有地面连通区域（按面积从大到小）
  findRegions() {
    const { w, h, grid } = this;
    const seen = new Uint8Array(w * h);
    const regions = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const start = this.idx(x, y);
        if (grid[start] !== FLOOR || seen[start]) continue;

        const cells = [];
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const cur = stack.pop();
          cells.push(cur);
          const cx = cur % w;
          const cy = (cur / w) | 0;
          for (const [dx, dy] of dirs) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!seen[ni] && grid[ni] === FLOOR) {
              seen[ni] = 1;
              stack.push(ni);
            }
          }
        }
        regions.push({ cells, size: cells.length });
      }
    }

    regions.sort((a, b) => b.size - a.size);
    this.regions = regions;
    return regions;
  }

  // 只保留最大连通区域，其余孤立小洞填回岩石
  removeIsolatedRegions() {
    const regions = this.findRegions();
    this._cleanupStats = {
      regionCountBeforeCleanup: regions.length,
      removedRegions: 0,
      removedCells: 0,
      largestRegionSize: regions.length ? regions[0].size : 0,
    };

    for (let i = 1; i < regions.length; i++) {
      for (const idx of regions[i].cells) this.grid[idx] = ROCK;
      this._cleanupStats.removedRegions++;
      this._cleanupStats.removedCells += regions[i].size;
    }
    this.regions = regions.slice(0, 1);
  }

  // 参数过于极端时，自动开凿一处主洞穴，保证地图始终可玩
  carveFallbackCave() {
    const { w, h } = this;
    const rx = Math.max(3, Math.min(Math.round(w * 0.11), Math.floor((w - 4) / 2)));
    const ry = Math.max(3, Math.min(Math.round(h * 0.11), Math.floor((h - 4) / 2)));
    const cx = randInt(this.rng, rx + 1, Math.max(rx + 1, w - rx - 2));
    const cy = randInt(this.rng, ry + 1, Math.max(ry + 1, h - ry - 2));

    const wobble = 0.08 + this.rng() * 0.18;
    const phase = this.rng() * Math.PI * 2;
    const frequency = randInt(this.rng, 2, 4);

    for (let y = cy - ry - 2; y <= cy + ry + 2; y++) {
      for (let x = cx - rx - 2; x <= cx + rx + 2; x++) {
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const angle = Math.atan2(ny, nx);
        // 带轻微起伏的椭圆，避免出现机械的完美圆形
        const limit = 1 + wobble * Math.sin(angle * frequency + phase);
        if (nx * nx + ny * ny <= limit) this.grid[this.idx(x, y)] = FLOOR;
      }
    }

    // 极小尺寸或边界裁剪情况下的最终保底：方形开凿
    const regions = this.findRegions();
    const largest = regions.length ? regions[0].size : 0;
    if (largest < this.minimumCaveArea()) {
      const half = Math.max(2, Math.ceil(Math.sqrt(this.minimumCaveArea()) / 2));
      for (let y = cy - half; y <= cy + half; y++) {
        for (let x = cx - half; x <= cx + half; x++) {
          if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
            this.grid[this.idx(x, y)] = FLOOR;
          }
        }
      }
    }
  }

  // 在可通行地面上按密度散点布置装饰物
  placeDecorations() {
    this.decorations = [];
    const density = this.opts.decorationDensity;
    if (density <= 0) return;

    const forest = this.opts.style === 'forest';
    for (let y = 1; y < this.h - 1; y++) {
      for (let x = 1; x < this.w - 1; x++) {
        if (!this.isFloor(x, y)) continue;
        if (this.rng() * 100 >= density) continue;

        const roll = this.rng();
        let type;
        if (forest) {
          type = roll < 0.58 ? 'tree' : roll < 0.85 ? 'bush' : 'rubble';
        } else {
          type = roll < 0.72 ? 'rubble' : 'bush';
        }

        // 树木需要至少两个相邻地面，避免长在单格石缝里
        if (type === 'tree' && this.countFloorNeighbors(x, y) < 2) type = 'bush';

        let variant = 'stone';
        if (type === 'tree') variant = this.rng() < 0.5 ? 'pine' : 'round';
        else if (type === 'bush') variant = 'leafy';

        this.decorations.push({
          x,
          y,
          type,
          variant,
          size: 0.62 + this.rng() * 0.38,
          tone: this.rng(),
          rotation: this.rng() * Math.PI * 2,
        });
      }
    }
  }

  buildStats(regionCountBeforeCleanup, removedRegions, removedCells) {
    const totalCells = this.w * this.h;
    let floorCells = 0;
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === FLOOR) floorCells++;
    }

    const counts = { tree: 0, bush: 0, rubble: 0 };
    for (const d of this.decorations) {
      if (counts[d.type] !== undefined) counts[d.type]++;
    }

    this.stats = {
      width: this.w,
      height: this.h,
      totalCells,
      floorCells,
      rockCells: totalCells - floorCells,
      floorPercent: totalCells ? (floorCells / totalCells) * 100 : 0,
      largestRegionSize: this._cleanupStats.largestRegionSize || 0,
      connectedRegions: floorCells > 0 ? 1 : 0,
      regionCountBeforeCleanup,
      removedRegions,
      removedCells,
      decorationCounts: counts,
      decorationTotal: this.decorations.length,
      fallbackUsed: this._fallbackUsed,
      seed: this.seed,
    };
  }

  generate() {
    this.seedNoise();
    this.smooth();
    this.removeIsolatedRegions();

    let regionCountBeforeCleanup = this._cleanupStats.regionCountBeforeCleanup;
    let removedRegions = this._cleanupStats.removedRegions;
    let removedCells = this._cleanupStats.removedCells;

    this._fallbackUsed = false;
    if ((this._cleanupStats.largestRegionSize || 0) < this.minimumCaveArea()) {
      this._fallbackUsed = true;
      this.carveFallbackCave();
      this.removeIsolatedRegions();
      regionCountBeforeCleanup = Math.max(regionCountBeforeCleanup, this._cleanupStats.regionCountBeforeCleanup);
      removedRegions += this._cleanupStats.removedRegions;
      removedCells += this._cleanupStats.removedCells;
    }

    this.placeDecorations();
    this.buildStats(regionCountBeforeCleanup, removedRegions, removedCells);
    return this;
  }
}

function createCave(opts, seed) {
  return new CaveMap(opts, seed).generate();
}

// ---------- 渲染 ----------
const CELL = 16;
const SCALE_PAD = 36;
const FEET_PER_CELL = 5;
const CAVE_FONT = '"Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif';

const CAVE_THEME = {
  background: '#140e09',
  rock: ['#3c2d20', '#2a1e14', '#4d3b28', '#24180f', '#5a4532'],
  floor: ['#d2bf96', '#c6b184', '#e0cba6', '#bba67a'],
  shadow: 'rgba(8,5,3,0.42)',
  grass: null,
};

const FOREST_THEME = {
  background: '#14210f',
  rock: ['#1d3a16', '#24501c', '#163212', '#2c5a22', '#1a4018'],
  floor: ['#d9c48a', '#cbb67a', '#e6d7a4', '#b7a56c'],
  shadow: 'rgba(8,16,6,0.4)',
  grass: '#3f6b32',
};

// 与种子无关的稳定噪声，用于地面纹理/岩石色块
function tileNoise(x, y, salt) {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + salt, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function fillBlob(ctx, cx, cy, radius, x, y, salt) {
  ctx.beginPath();
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 0.86 + tileNoise(x * 5 + i, y * 3 + salt, salt + 11) * 0.28;
    const px = cx + Math.cos(a) * radius * wobble;
    const py = cy + Math.sin(a) * radius * (0.86 + tileNoise(y * 4 + i, x + salt, salt + 29) * 0.28);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function touchesFloor(cave, x, y) {
  return cave.isFloor(x - 1, y) || cave.isFloor(x + 1, y) ||
    cave.isFloor(x, y - 1) || cave.isFloor(x, y + 1);
}

// 可玩区域以外是斜线虚空，贴着地面的一圈才是实心墙/密林边界
function drawVoidField(ctx, w, h, forest) {
  ctx.fillStyle = forest ? '#0c120b' : '#100e0c';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.strokeStyle = forest ? 'rgba(186, 198, 140, 0.16)' : 'rgba(210, 190, 150, 0.14)';
  ctx.lineWidth = 1;
  for (let i = -h; i < w; i += 11) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.stroke();
  }
  ctx.restore();
}

function renderCave(cave, canvas) {
  const forest = cave.opts.style === 'forest';
  const theme = forest ? FOREST_THEME : CAVE_THEME;
  const mapW = cave.w * CELL;
  const mapH = cave.h * CELL;
  canvas.width = mapW;
  canvas.height = mapH + SCALE_PAD;
  const ctx = canvas.getContext('2d');

  drawVoidField(ctx, mapW, mapH + SCALE_PAD, forest);

  for (let y = 0; y < cave.h; y++) {
    for (let x = 0; x < cave.w; x++) {
      if (cave.isFloor(x, y) || !touchesFloor(cave, x, y)) continue;
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = forest ? '#143016' : '#3a2e24';
      ctx.fillRect(px, py, CELL, CELL);
      ctx.fillStyle = forest ? '#2d5a30' : '#6d5a44';
      if (cave.isFloor(x, y + 1)) ctx.fillRect(px, py + CELL - 4, CELL, 4);
      if (cave.isFloor(x, y - 1)) ctx.fillRect(px, py, CELL, 4);
      if (cave.isFloor(x + 1, y)) ctx.fillRect(px + CELL - 4, py, 4, CELL);
      if (cave.isFloor(x - 1, y)) ctx.fillRect(px, py, 4, CELL);
      ctx.strokeStyle = forest ? '#0a1a0c' : '#1a140e';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
    }
  }

  for (let y = 0; y < cave.h; y++) {
    for (let x = 0; x < cave.w; x++) {
      if (!cave.isFloor(x, y)) continue;
      const cx = (x + 0.5) * CELL;
      const cy = (y + 0.5) * CELL;
      ctx.fillStyle = forest ? '#c4b07a' : '#cbb892';
      fillBlob(ctx, cx, cy, CELL * 0.92, x, y, 6);
    }
  }

  if (forest) {
    ctx.strokeStyle = theme.grass;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    for (let y = 0; y < cave.h; y++) {
      for (let x = 0; x < cave.w; x++) {
        if (!cave.isFloor(x, y) || tileNoise(x, y, 41) < 0.42) continue;
        const px = x * CELL;
        const py = y * CELL;
        ctx.beginPath();
        ctx.moveTo(px + CELL * 0.28, py + CELL * 0.72);
        ctx.quadraticCurveTo(px + CELL * 0.2, py + CELL * 0.4, px + CELL * 0.34, py + CELL * 0.28);
        ctx.moveTo(px + CELL * 0.62, py + CELL * 0.7);
        ctx.quadraticCurveTo(px + CELL * 0.7, py + CELL * 0.42, px + CELL * 0.55, py + CELL * 0.3);
        ctx.stroke();
      }
    }
  } else {
    for (let y = 0; y < cave.h; y++) {
      for (let x = 0; x < cave.w; x++) {
        if (!cave.isFloor(x, y) || tileNoise(x, y, 31) < 0.8) continue;
        ctx.fillStyle = 'rgba(90,70,45,0.28)';
        const sx = (x + 0.2 + tileNoise(x, y, 33) * 0.6) * CELL;
        const sy = (y + 0.2 + tileNoise(x, y, 37) * 0.6) * CELL;
        ctx.beginPath();
        ctx.ellipse(sx, sy, 1.6, 1.1, tileNoise(x, y, 39) * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const propScale = forest ? 2.15 : 1.4;
  const sorted = cave.decorations.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const d of sorted) {
    const cx = (d.x + 0.5) * CELL;
    const cy = (d.y + 0.5) * CELL;
    if (d.type === 'tree') drawTree(ctx, d, cx, cy, propScale);
    else if (d.type === 'bush') drawBush(ctx, d, cx, cy, forest ? 1.85 : 1.35);
    else drawRubble(ctx, d, cx, cy, forest ? 1.2 : 1.55);
  }

  drawEntrance(ctx, cave);
  drawCaveScale(ctx, mapW, mapH);
  ctx.font = `12px ${CAVE_FONT}`;
  ctx.fillStyle = '#e6d7b4';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(forest ? '斜线区域不可通行' : '斜线区域不可通行', mapW - 12, mapH + 22);
}

function findEntrance(cave) {
  let best = null;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < cave.h; y++) {
    for (let x = 0; x < cave.w; x++) {
      if (!cave.isFloor(x, y)) continue;
      for (const [dx, dy] of dirs) {
        const rx = x + dx;
        const ry = y + dy;
        if (!cave.inBounds(rx, ry) || cave.isFloor(rx, ry)) continue;
        const edge = Math.min(Math.max(rx, 0), Math.max(ry, 0), cave.w - 1 - rx, cave.h - 1 - ry);
        if (!best || edge < best.edge || (edge === best.edge && (ry < best.ry || (ry === best.ry && rx < best.rx)))) {
          best = { fx: x, fy: y, rx, ry, edge };
        }
      }
    }
  }
  return best;
}

function drawEntrance(ctx, cave) {
  const ent = findEntrance(cave);
  if (!ent) return;
  const fx = (ent.fx + 0.5) * CELL;
  const fy = (ent.fy + 0.5) * CELL;
  const rx = (ent.rx + 0.5) * CELL;
  const ry = (ent.ry + 0.5) * CELL;

  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(Math.atan2(fy - ry, fx - rx));
  ctx.fillStyle = '#120d09';
  ctx.beginPath();
  ctx.moveTo(-8, 12);
  ctx.lineTo(-8, -1);
  ctx.quadraticCurveTo(-8, -15, 0, -15);
  ctx.quadraticCurveTo(8, -15, 8, -1);
  ctx.lineTo(8, 12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f3e6c8';
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.restore();

  let lx = rx + (rx - fx) * 1.15;
  let ly = ry + (ry - fy) * 1.15;
  ctx.font = `bold 13px ${CAVE_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = '入口';
  const tw = ctx.measureText(text).width;
  lx = Math.max(8 + tw / 2, Math.min(cave.w * CELL - 8 - tw / 2, lx));
  ly = Math.max(12, Math.min(cave.h * CELL - 12, ly));
  ctx.fillStyle = 'rgba(246,237,212,0.95)';
  roundCaveLabel(ctx, lx - tw / 2 - 6, ly - 10, tw + 12, 20, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(43,32,22,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#8a2c22';
  ctx.fillText(text, lx, ly + 0.5);
}

function roundCaveLabel(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCaveScale(ctx, mapW, mapH) {
  const cells = 4;
  const bar = cells * CELL;
  const x = 14;
  const y = mapH + 22;
  ctx.fillStyle = 'rgba(243,233,207,0.95)';
  roundCaveLabel(ctx, 8, mapH + 6, Math.min(mapW - 16, bar + 108), 26, 6);
  ctx.fill();
  ctx.strokeStyle = '#2b2016';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + bar, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + bar, y - 4);
  ctx.lineTo(x + bar, y + 4);
  ctx.stroke();
  ctx.font = `12px ${CAVE_FONT}`;
  ctx.fillStyle = '#2b2016';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${cells * FEET_PER_CELL} 尺`, x + bar + 8, y);
}

function drawTree(ctx, d, cx, cy, scale) {
  const s = CELL * d.size * (scale || 1);
  const pine = d.variant === 'pine';
  const greens = pine
    ? ['#3d5a35', '#4b6c3f', '#31502f']
    : ['#526b3a', '#637c45', '#435c33'];

  ctx.fillStyle = 'rgba(20,14,8,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx + s * 0.18, cy + s * 0.56, s * 0.72, s * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#4a3520';
  ctx.lineWidth = Math.max(1.2, s * 0.15);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.58);
  ctx.lineTo(cx, cy + s * 0.02);
  ctx.stroke();

  if (pine) {
    for (let i = 0; i < 3; i++) {
      const baseY = cy + s * 0.34 - i * s * 0.22;
      const half = s * (0.62 - i * 0.13);
      ctx.fillStyle = greens[i % greens.length];
      ctx.beginPath();
      ctx.moveTo(cx, baseY - s * 0.62);
      ctx.lineTo(cx - half, baseY);
      ctx.lineTo(cx + half, baseY);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const blobs = [
      [0, -s * 0.15, s * 0.55],
      [-s * 0.38, s * 0.05, s * 0.40],
      [s * 0.38, s * 0.04, s * 0.42],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const [ox, oy, radius] = blobs[i];
      ctx.fillStyle = greens[(i + (d.tone > 0.5 ? 1 : 0)) % greens.length];
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBush(ctx, d, cx, cy, scale) {
  const s = CELL * d.size * 0.72 * (scale || 1);
  ctx.fillStyle = 'rgba(20,14,8,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx + 1, cy + s * 0.45, s * 0.85, s * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();

  const tones = d.tone > 0.5
    ? ['#5c703e', '#6d8149', '#4d6034']
    : ['#637542', '#74864e', '#52643a'];
  const blobs = [
    [-s * 0.35, 0, s * 0.52],
    [s * 0.32, s * 0.05, s * 0.48],
    [0, -s * 0.22, s * 0.44],
  ];
  for (let i = 0; i < blobs.length; i++) {
    const [ox, oy, radius] = blobs[i];
    ctx.fillStyle = tones[i];
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRubble(ctx, d, cx, cy, scale) {
  const s = CELL * d.size * 0.58 * (scale || 1);
  const tones = ['#6b6252', '#7c7260', '#5b5344'];
  for (let i = 0; i < 3; i++) {
    const angle = d.rotation + i * 2.1;
    const ox = Math.cos(angle) * s * 0.55;
    const oy = Math.sin(angle) * s * 0.4;
    const radius = s * (i === 0 ? 0.55 : 0.38);
    ctx.fillStyle = tones[i];
    ctx.beginPath();
    ctx.ellipse(cx + ox, cy + oy, radius, radius * 0.68, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(222,208,171,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx - s * 0.12, cy - s * 0.16, s * 0.28, s * 0.16, -0.4, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- 文本摘要（导出 TXT 与测试共用） ----------
function buildCaveSummary(cave, seedText) {
  const s = cave.stats;
  const styleName = cave.opts.style === 'forest' ? '林间' : '洞穴';
  const seed = seedText || String(cave.seed);

  let text = `洞穴 / 林间地图描述（种子：${seed}）\n`;
  text += `地形规模：${cave.w} × ${cave.h} 格（共 ${s.totalCells} 格）\n`;
  text += `生成参数：初始岩石填充 ${cave.opts.rockFill}% · 平滑 ${cave.opts.smoothing} 轮 · 场景风格 ${styleName} · 装饰密度 ${cave.opts.decorationDensity}%\n`;
  text += `可通行地面：${s.floorCells} 格（${s.floorPercent.toFixed(1)}%）\n`;
  text += `连通区域：最大连通区域 ${s.largestRegionSize} 格（处理后 ${s.connectedRegions} 个连通区域）\n`;
  text += `孤立碎块：移除 ${s.removedRegions} 个区域，共 ${s.removedCells} 格\n`;
  text += `装饰物：树木 ${s.decorationCounts.tree} · 灌木 ${s.decorationCounts.bush} · 碎石 ${s.decorationCounts.rubble}（共 ${s.decorationTotal}）\n`;
  if (s.fallbackUsed) {
    text += `备注：初始地形过于破碎，已自动开凿主洞穴以保证地图连通与可玩性。\n`;
  }
  return text;
}

// ---------- 页面交互 ----------
let currentCave = null;
let currentSeedText = '';

function readOpts() {
  return {
    w: parseInt(document.getElementById('gridW').value, 10),
    h: parseInt(document.getElementById('gridH').value, 10),
    rockFill: parseInt(document.getElementById('rockFill').value, 10),
    smoothing: parseInt(document.getElementById('smoothing').value, 10),
    decorationDensity: parseInt(document.getElementById('decorDensity').value, 10),
    style: document.getElementById('sceneStyle').value,
  };
}

function syncStyleCopy() {
  const forest = document.getElementById('sceneStyle').value === 'forest';
  document.getElementById('generateBtn').textContent = forest ? '生成林间' : '生成洞穴';
  document.getElementById('styleHint').textContent = forest
    ? '林间只在空地内可通行。密林边界是实心墙，墙外斜线区域不可进入。'
    : '洞穴只在沙土地面内可通行。贴地一圈是实心岩壁，岩壁外斜线区域不可进入。';
  document.getElementById('fillLabel').textContent = forest ? '初始树冠填充率' : '初始岩石填充率';
  document.getElementById('decorLabel').textContent = forest ? '装饰物密度（树木 / 灌木）' : '装饰物密度（碎石 / 灌木）';
}

function syncLabels() {
  document.getElementById('valW').textContent = document.getElementById('gridW').value;
  document.getElementById('valH').textContent = document.getElementById('gridH').value;
  document.getElementById('valFill').textContent = document.getElementById('rockFill').value + '%';
  document.getElementById('valSmooth').textContent = document.getElementById('smoothing').value + ' 轮';
  document.getElementById('valDecor').textContent = document.getElementById('decorDensity').value + '%';
  syncStyleCopy();
}

function generate() {
  syncStyleCopy();
  const opts = readOpts();
  const seedInput = document.getElementById('seedInput');
  const seedText = seedInput.value.trim();
  let seedNum;

  if (seedText) {
    seedNum = seedToNumber(seedText);
    currentSeedText = seedText;
  } else {
    seedNum = Math.floor(Math.random() * 1000000000);
    seedInput.value = String(seedNum);
    currentSeedText = String(seedNum);
  }

  currentCave = createCave(opts, seedNum);
  renderCave(currentCave, document.getElementById('caveCanvas'));
  renderCaveInfo(currentCave, document.getElementById('caveInfo'));
}

function renderCaveInfo(cave, container) {
  const s = cave.stats;
  const rows = [
    ['地形规模', `${cave.w} × ${cave.h} 格（共 ${s.totalCells} 格）`],
    ['可通行地面', `${s.floorCells} 格（${s.floorPercent.toFixed(1)}%）`],
    ['连通区域', `最大 ${s.largestRegionSize} 格 · 处理后 ${s.connectedRegions} 个`],
    ['孤立碎块', `已移除 ${s.removedRegions} 个（共 ${s.removedCells} 格）`],
    ['装饰物', `树木 ${s.decorationCounts.tree} · 灌木 ${s.decorationCounts.bush} · 碎石 ${s.decorationCounts.rubble}（共 ${s.decorationTotal}）`],
  ];
  if (s.fallbackUsed) rows.push(['提示', '参数导致初始地形过碎，已自动开凿主洞穴']);

  container.innerHTML = '';
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const key = document.createElement('strong');
    key.textContent = label + '：';
    row.appendChild(key);
    row.appendChild(document.createTextNode(value));
    container.appendChild(row);
  }
}

function styleFileStem() {
  return currentCave && currentCave.opts.style === 'forest' ? '林间' : '洞穴';
}

function exportPng() {
  const canvas = document.getElementById('caveCanvas');
  const link = document.createElement('a');
  link.download = `${styleFileStem()}_${currentSeedText || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportTxt() {
  if (!currentCave) return;
  const text = buildCaveSummary(currentCave, currentSeedText);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `${styleFileStem()}描述_${currentSeedText || 'random'}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

function initCavePage() {
  const sliderIds = ['gridW', 'gridH', 'rockFill', 'smoothing', 'decorDensity'];
  sliderIds.forEach(id => document.getElementById(id).addEventListener('input', syncLabels));

  document.getElementById('sceneStyle').addEventListener('change', generate);
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
      if (currentCave) renderCave(currentCave, document.getElementById('caveCanvas'));
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initCavePage);
}

// Node 冒烟测试可通过 require 直接使用核心算法
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mulberry32,
    hashStringToSeed,
    seedToNumber,
    ROCK,
    FLOOR,
    clampInt,
    normalizeOptions,
    CaveMap,
    createCave,
    renderCave,
    renderCaveInfo,
    buildCaveSummary,
  };
}
if (typeof window !== 'undefined') {
  window.CaveGenerator = {
    mulberry32,
    hashStringToSeed,
    seedToNumber,
    ROCK,
    FLOOR,
    normalizeOptions,
    CaveMap,
    createCave,
    renderCave,
    renderCaveInfo,
    buildCaveSummary,
  };
}
