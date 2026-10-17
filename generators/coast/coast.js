/* =========================================================
 * 中文 TTRPG 地图生成器 - 海岸生成器
 * 算法：种子化值噪声（Value Noise + 分形叠加）高度图
 *       + 分位数海平面阈值分割海陆
 *       + Marching Squares 等值线追踪海岸线
 *       + 海岸带特征点采样（礁石 / 灯塔 / 洞穴 / 沉船等）
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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 地图常量 ----------
// 高度场 200×200，每个格子约 4.5 像素；矢量海岸线由等值线给出
const COAST_SIZE = 900;
const GRID_W = 200;
const GRID_H = 200;
const GRID_N = GRID_W * GRID_H;
const CELL_W = COAST_SIZE / GRID_W;
const CELL_H = COAST_SIZE / GRID_H;

// ---------- 沿海地形特征类型 ----------
const FEATURE_TYPES = {
  '礁石':     { color: '#5b6a6a', weight: 3, icon: 'reef' },
  '灯塔':     { color: '#a8432f', weight: 1, icon: 'lighthouse' },
  '洞穴入口': { color: '#4a3b2a', weight: 2, icon: 'cave' },
  '沉船残骸': { color: '#7a5230', weight: 2, icon: 'wreck' },
  '渔村':     { color: '#b5544a', weight: 1, icon: 'village' },
  '盐沼':     { color: '#6e7f4a', weight: 1, icon: 'marsh' },
};
const FEATURE_TYPE_NAMES = Object.keys(FEATURE_TYPES);

// ---------- 值噪声 / 分形噪声 ----------
// 使用种子化置换表 + 格点随机值，自行实现，不依赖外部库
function createValueNoise(rand) {
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

  const values = new Float32Array(256);
  for (let i = 0; i < 256; i++) values[i] = rand();

  const at = (x, y) => values[p[(p[x & 255] + (y & 255)) & 255]];

  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const v00 = at(xi, yi);
    const v10 = at(xi + 1, yi);
    const v01 = at(xi, yi + 1);
    const v11 = at(xi + 1, yi + 1);
    const a = v00 + (v10 - v00) * u;
    const b = v01 + (v11 - v01) * u;
    return a + (b - a) * v;
  };
}

function fbm(noise, x, y, octaves) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---------- 海岸模型 ----------
class Coast {
  constructor(opts) {
    opts = opts || {};
    this.opts = {
      landRatio: Number.isFinite(opts.landRatio) ? opts.landRatio : 45,
      complexity: Number.isFinite(opts.complexity) ? opts.complexity : 4,
      featureCount: Number.isFinite(opts.featureCount) ? opts.featureCount : 8,
      seed: opts.seed != null ? (opts.seed >>> 0) : 1,
    };
    this.cols = GRID_W;
    this.rows = GRID_H;
    this.heights = new Float32Array(GRID_N);
    this.land = new Uint8Array(GRID_N);
    this.distToSea = new Int16Array(GRID_N);
    this.threshold = 0;
    this.landCount = 0;
    this.landRatioActual = 0;
    this.targetLandCount = 0;
    this.minH = 0;
    this.maxH = 1;
    this.contours = [];
    this.elevationContours = [];
    this.depthContours = [];
    this.features = [];
  }

  idx(x, y) { return y * GRID_W + x; }

  generate() {
    this.buildHeightField();
    this.computeThreshold();
    this.buildLandMask();
    this.buildCoastline();
    this.computeDistanceToSea();
    this.placeFeatures();
    return this;
  }

  // 分形噪声 + 缓坡：噪声决定海岸细节，缓坡保证地图上有一条主海岸线
  buildHeightField() {
    const noise = createValueNoise(rng);
    const complexity = Math.max(1, Math.min(8, this.opts.complexity));
    const freq = 1.1 + (complexity - 1) * 0.85;
    const octaves = complexity >= 6 ? 5 : 4;

    const angle = rng() * Math.PI * 2;
    const gx = Math.cos(angle);
    const gy = Math.sin(angle);
    const maxProj = Math.abs(gx) + Math.abs(gy) || 1;

    let minH = Infinity;
    let maxH = -Infinity;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const nx = x / (GRID_W - 1);
        const ny = y / (GRID_H - 1);
        const n = fbm(noise, nx * freq, ny * freq, octaves);
        const proj = (nx - 0.5) * gx + (ny - 0.5) * gy;
        const gradient = proj / maxProj; // 约 -0.5 .. 0.5
        const h = n * 0.68 + (0.5 + gradient * 0.9) * 0.32;
        this.heights[this.idx(x, y)] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    this.minH = minH;
    this.maxH = maxH;
  }

  // 用分位数反推海平面阈值，使实际陆地比例贴近滑块设定
  computeThreshold() {
    const ratioPct = Math.max(5, Math.min(95, this.opts.landRatio));
    const target = Math.round((ratioPct / 100) * GRID_N);
    const sorted = Array.from(this.heights).sort((a, b) => a - b);

    if (target <= 0) {
      this.threshold = sorted[sorted.length - 1] + 1e-6;
    } else if (target >= GRID_N) {
      this.threshold = sorted[0] - 1e-6;
    } else {
      // 高于该值的格子数为 target
      this.threshold = sorted[GRID_N - target - 1];
    }
    this.targetLandCount = target;
  }

  buildLandMask() {
    let landCount = 0;
    for (let i = 0; i < GRID_N; i++) {
      const isLand = this.heights[i] > this.threshold ? 1 : 0;
      this.land[i] = isLand;
      landCount += isLand;
    }
    this.landCount = landCount;
    this.landRatioActual = landCount / GRID_N;
  }

  buildCoastline() {
    this.contours = traceContour(this.heights, this.threshold);

    const landRange = Math.max(1e-6, this.maxH - this.threshold);
    this.elevationContours = [
      traceContour(this.heights, this.threshold + landRange * 0.30),
      traceContour(this.heights, this.threshold + landRange * 0.58),
    ];

    const seaRange = Math.max(1e-6, this.threshold - this.minH);
    this.depthContours = [
      traceContour(this.heights, this.threshold - seaRange * 0.45),
    ];
  }

  // 从所有海水格子出发做多源 BFS，得到每个陆地格子离海的格数
  computeDistanceToSea() {
    const dist = this.distToSea;
    dist.fill(-1);
    const queue = new Int32Array(GRID_N);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < GRID_N; i++) {
      if (!this.land[i]) {
        dist[i] = 0;
        queue[tail++] = i;
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const x = i % GRID_W;
      const y = (i / GRID_W) | 0;
      const nd = dist[i] + 1;
      if (x > 0 && dist[i - 1] === -1) { dist[i - 1] = nd; queue[tail++] = i - 1; }
      if (x < GRID_W - 1 && dist[i + 1] === -1) { dist[i + 1] = nd; queue[tail++] = i + 1; }
      if (y > 0 && dist[i - GRID_W] === -1) { dist[i - GRID_W] = nd; queue[tail++] = i - GRID_W; }
      if (y < GRID_H - 1 && dist[i + GRID_W] === -1) { dist[i + GRID_W] = nd; queue[tail++] = i + GRID_W; }
    }
  }

  // 只在陆地一侧、靠近海岸的格子中撒点，先保证间距，再逐级放宽
  placeFeatures() {
    const requested = Number.isFinite(this.opts.featureCount)
      ? Math.round(this.opts.featureCount) : 8;
    const count = Math.max(0, Math.min(30, requested));
    this.features = [];
    if (count === 0) return;

    const margin = 96; // 为图标、标签和边框留白（像素）
    const minX = Math.ceil(margin / CELL_W);
    const maxX = Math.floor((COAST_SIZE - margin) / CELL_W);
    const minY = Math.ceil(margin / CELL_H);
    const maxY = Math.floor((COAST_SIZE - margin) / CELL_H);

    const near = [];
    const anyLand = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = this.idx(x, y);
        if (!this.land[i]) continue;
        const d = this.distToSea[i];
        const cell = { x, y, d };
        anyLand.push(cell);
        if (d >= 1 && d <= 16) near.push(cell);
      }
    }

    const picked = [];
    const pickedKeys = new Set();
    const tryPick = (list, spacing, limit) => {
      for (const cell of list) {
        if (picked.length >= limit) return;
        const key = cell.x + ',' + cell.y;
        if (pickedKeys.has(key)) continue;
        const px = (cell.x + 0.5) * CELL_W;
        const py = (cell.y + 0.5) * CELL_H;
        let ok = true;
        for (const p of picked) {
          if (Math.hypot(px - p.x, py - p.y) < spacing) { ok = false; break; }
        }
        if (!ok) continue;
        picked.push({ x: px, y: py, cellX: cell.x, cellY: cell.y, coastDist: cell.d });
        pickedKeys.add(key);
      }
    };

    const shuffledNear = shuffle(near);
    // 初始间距兼顾图标与中文标签宽度；数量多时逐级放宽
    for (const spacing of [88, 64, 42, 26]) {
      tryPick(shuffledNear, spacing, count);
      if (picked.length >= count) break;
    }

    if (picked.length < count) {
      const shuffledAny = shuffle(anyLand);
      tryPick(shuffledAny, 18, count);
      // 极端参数下仍不足时逐格补齐；仍限制在留白范围内
      for (const cell of shuffledAny) {
        if (picked.length >= count) break;
        const key = cell.x + ',' + cell.y;
        if (pickedKeys.has(key)) continue;
        picked.push({
          x: (cell.x + 0.5) * CELL_W,
          y: (cell.y + 0.5) * CELL_H,
          cellX: cell.x,
          cellY: cell.y,
          coastDist: cell.d,
        });
        pickedKeys.add(key);
      }
    }

    // 加权类型袋：礁石最多，其余类型轮换，避免整张图只有一种特征
    const typeBagAll = [];
    for (const name of FEATURE_TYPE_NAMES) {
      const weight = FEATURE_TYPES[name].weight || 1;
      for (let i = 0; i < weight; i++) typeBagAll.push(name);
    }
    const types = [];
    let bag = [];
    while (types.length < picked.length) {
      if (bag.length === 0) bag = shuffle(typeBagAll);
      types.push(bag.pop());
    }
    picked.forEach((p, i) => { p.type = types[i]; });

    // 按从上到下、从左到右编号，方便清单与地图对照
    picked.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    picked.forEach((p, i) => {
      p.id = i + 1;
      p.direction = directionFromCenter(p.x, p.y);
      p.distanceToCoast = Math.max(1, Math.round(p.coastDist * CELL_W));
    });
    this.features = picked;
  }
}

// ---------- 种子入口：页面和 Node 测试共用 ----------
function generateCoast(opts) {
  opts = opts || {};
  const seed = opts.seed != null ? (opts.seed >>> 0) : 1;
  rng = mulberry32(seed);
  const coast = new Coast(Object.assign({}, opts, { seed }));
  coast.generate();
  return coast;
}

// ---------- 等值线（Marching Squares） ----------
// 返回像素坐标下的线段数组；同一套函数也用于陆地等高线和海深线
function traceContour(heights, threshold) {
  const segs = [];
  const sample = (x, y) => heights[y * GRID_W + x];

  for (let y = 0; y < GRID_H - 1; y++) {
    for (let x = 0; x < GRID_W - 1; x++) {
      const h00 = sample(x, y);
      const h10 = sample(x + 1, y);
      const h11 = sample(x + 1, y + 1);
      const h01 = sample(x, y + 1);

      const code = (h00 > threshold ? 1 : 0) |
                   (h10 > threshold ? 2 : 0) |
                   (h11 > threshold ? 4 : 0) |
                   (h01 > threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const points = {
        top:    { x: x + edgeT(h00, h10, threshold), y },
        right:  { x: x + 1, y: y + edgeT(h10, h11, threshold) },
        bottom: { x: x + edgeT(h01, h11, threshold), y: y + 1 },
        left:   { x, y: y + edgeT(h00, h01, threshold) },
      };
      const centerLand = (h00 + h10 + h11 + h01) / 4 > threshold;
      const pairs = contourPairs(code, centerLand);

      for (const [ea, eb] of pairs) {
        const a = points[ea];
        const b = points[eb];
        segs.push({
          x1: a.x * CELL_W,
          y1: a.y * CELL_H,
          x2: b.x * CELL_W,
          y2: b.y * CELL_H,
        });
      }
    }
  }
  return segs;
}

function edgeT(a, b, threshold) {
  const d = b - a;
  if (Math.abs(d) < 1e-12) return 0.5;
  const t = (threshold - a) / d;
  return t < 0 ? 0 : (t > 1 ? 1 : t);
}

// code 的 4 位依次为：左上、右上、右下、左下（1 = 陆地）
function contourPairs(code, centerLand) {
  switch (code) {
    case 1:  return [['left', 'top']];
    case 2:  return [['top', 'right']];
    case 3:  return [['left', 'right']];
    case 4:  return [['right', 'bottom']];
    case 5:  return centerLand
      ? [['top', 'right'], ['bottom', 'left']]
      : [['left', 'top'], ['right', 'bottom']];
    case 6:  return [['top', 'bottom']];
    case 7:  return [['left', 'bottom']];
    case 8:  return [['left', 'bottom']];
    case 9:  return [['top', 'bottom']];
    case 10: return centerLand
      ? [['top', 'left'], ['right', 'bottom']]
      : [['top', 'right'], ['bottom', 'left']];
    case 11: return [['right', 'bottom']];
    case 12: return [['left', 'right']];
    case 13: return [['top', 'right']];
    case 14: return [['top', 'left']];
    default: return [];
  }
}

// 地图中心视角的八方位，用于生成“东北侧礁石”这类描述
function directionFromCenter(x, y) {
  const names = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  const angle = Math.atan2(y - COAST_SIZE / 2, x - COAST_SIZE / 2);
  const idx = Math.round(angle / (Math.PI / 4));
  return names[((idx % 8) + 8) % 8];
}

// ---------- 渲染 ----------
function lerp(a, b, t) { return a + (b - a) * t; }

// 先把 200×200 高度场画成低分辨率色块，再平滑放大，形成柔和的地形底色
function buildColorField(coast) {
  const field = document.createElement('canvas');
  field.width = GRID_W;
  field.height = GRID_H;
  const fctx = field.getContext('2d');
  const img = fctx.createImageData(GRID_W, GRID_H);
  const data = img.data;

  const th = coast.threshold;
  const landRange = Math.max(1e-6, coast.maxH - th);
  const seaRange = Math.max(1e-6, th - coast.minH);
  const seaShallow = [126, 154, 148];
  const seaDeep = [52, 76, 86];
  const landLow = [216, 198, 155];
  const landHigh = [153, 133, 87];

  for (let i = 0; i < GRID_N; i++) {
    const h = coast.heights[i];
    let r, g, b;
    if (h > th) {
      const t = Math.max(0, Math.min(1, (h - th) / landRange));
      r = lerp(landLow[0], landHigh[0], t);
      g = lerp(landLow[1], landHigh[1], t);
      b = lerp(landLow[2], landHigh[2], t);
    } else {
      const t = Math.max(0, Math.min(1, (th - h) / seaRange));
      r = lerp(seaShallow[0], seaDeep[0], t);
      g = lerp(seaShallow[1], seaDeep[1], t);
      b = lerp(seaShallow[2], seaDeep[2], t);
    }
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }

  fctx.putImageData(img, 0, 0);
  return field;
}

function strokeSegments(ctx, segments, color, width) {
  if (!segments || segments.length === 0) return;
  ctx.beginPath();
  for (const s of segments) {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function renderCoast(coast, canvas) {
  canvas.width = COAST_SIZE;
  canvas.height = COAST_SIZE;
  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#ece0c4';
  ctx.fillRect(0, 0, COAST_SIZE, COAST_SIZE);

  const field = buildColorField(coast);
  ctx.drawImage(field, 0, 0, COAST_SIZE, COAST_SIZE);

  // 装饰纹理使用独立随机序列，不干扰地图生成
  const textureRng = mulberry32((coast.opts.seed ^ 0x9e3779b9) >>> 0);
  drawSeaTexture(ctx, coast, textureRng);
  drawLandTexture(ctx, coast, textureRng);

  // 海深线（浅色）与陆地等高线（褐色细线）
  for (const segs of coast.depthContours) {
    strokeSegments(ctx, segs, 'rgba(214, 230, 218, 0.22)', 1);
  }
  for (const segs of coast.elevationContours) {
    strokeSegments(ctx, segs, 'rgba(74, 58, 40, 0.20)', 1);
  }

  // 海岸线：浅色沙岸打底 + 深色墨线
  strokeSegments(ctx, coast.contours, 'rgba(240, 229, 200, 0.95)', 7);
  strokeSegments(ctx, coast.contours, '#433326', 2.4);

  drawFrame(ctx);

  // 先画全部图标，再统一画标签，避免后画的图标盖住先画的文字
  for (const feature of coast.features) {
    drawFeatureIcon(ctx, feature);
  }
  const labelRects = [];
  for (const feature of coast.features) {
    drawFeatureLabel(ctx, feature, labelRects);
  }
}

function drawSeaTexture(ctx, coast, rand) {
  ctx.save();
  ctx.strokeStyle = 'rgba(222, 236, 226, 0.30)';
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';

  let drawn = 0;
  let tries = 0;
  while (drawn < 120 && tries < 1500) {
    tries++;
    const x = 34 + rand() * (COAST_SIZE - 68);
    const y = 34 + rand() * (COAST_SIZE - 68);
    const gx = Math.min(GRID_W - 1, Math.floor(x / CELL_W));
    const gy = Math.min(GRID_H - 1, Math.floor(y / CELL_H));
    if (coast.land[coast.idx(gx, gy)]) continue;

    const w = 5 + rand() * 8;
    ctx.beginPath();
    ctx.moveTo(x - w, y);
    ctx.quadraticCurveTo(x, y - 3, x + w, y);
    ctx.stroke();
    drawn++;
  }
  ctx.restore();
}

function drawLandTexture(ctx, coast, rand) {
  ctx.save();
  ctx.strokeStyle = 'rgba(92, 107, 62, 0.34)';
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';

  let drawn = 0;
  let tries = 0;
  while (drawn < 100 && tries < 1800) {
    tries++;
    const x = 30 + rand() * (COAST_SIZE - 60);
    const y = 30 + rand() * (COAST_SIZE - 60);
    const gx = Math.min(GRID_W - 1, Math.floor(x / CELL_W));
    const gy = Math.min(GRID_H - 1, Math.floor(y / CELL_H));
    if (!coast.land[coast.idx(gx, gy)]) continue;

    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 3, y + 2);
      ctx.quadraticCurveTo(x + k * 4, y - 2, x + k * 5, y - 5);
      ctx.stroke();
    }
    drawn++;
  }

  // 少量碎石，打破大片纯色
  ctx.fillStyle = 'rgba(74, 58, 40, 0.24)';
  for (let i = 0; i < 70; i++) {
    const x = 30 + rand() * (COAST_SIZE - 60);
    const y = 30 + rand() * (COAST_SIZE - 60);
    const gx = Math.min(GRID_W - 1, Math.floor(x / CELL_W));
    const gy = Math.min(GRID_H - 1, Math.floor(y / CELL_H));
    if (!coast.land[coast.idx(gx, gy)]) continue;
    ctx.beginPath();
    ctx.ellipse(x, y, 1.6 + rand() * 1.4, 1.1 + rand() * 0.9, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFrame(ctx) {
  ctx.save();
  ctx.strokeStyle = 'rgba(43, 32, 22, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(14.5, 14.5, COAST_SIZE - 29, COAST_SIZE - 29);
  ctx.strokeStyle = 'rgba(43, 32, 22, 0.50)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(20, 20, COAST_SIZE - 40, COAST_SIZE - 40);

  // 比例尺：按 1 像素 ≈ 1 尺标注
  const x = 54;
  const y = COAST_SIZE - 46;
  ctx.strokeStyle = 'rgba(43, 32, 22, 0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 180, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.moveTo(x + 90, y - 3);
  ctx.lineTo(x + 90, y + 3);
  ctx.moveTo(x + 180, y - 5);
  ctx.lineTo(x + 180, y + 5);
  ctx.stroke();

  ctx.font = '11px "Noto Serif SC", "Songti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(43, 32, 22, 0.80)';
  ctx.fillText('0', x, y - 7);
  ctx.fillText('90 尺', x + 90, y - 7);
  ctx.fillText('180 尺', x + 180, y - 7);
  ctx.restore();
}

function drawFeatureIcon(ctx, feature) {
  const def = FEATURE_TYPES[feature.type];
  if (!def) return;

  // 徽记底盘，保证图标在深浅地形上都清晰
  ctx.save();
  ctx.beginPath();
  ctx.arc(feature.x, feature.y, 16, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(246, 238, 216, 0.94)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(43, 32, 22, 0.60)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // 底部彩色弧表示类型
  ctx.beginPath();
  ctx.arc(feature.x, feature.y, 16, Math.PI * 0.15, Math.PI * 0.85);
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.translate(feature.x, feature.y);
  drawFeatureGlyph(ctx, feature.type);
  ctx.restore();
}

function drawFeatureLabel(ctx, feature, placedRects) {
  // 中文标签：编号 + 类型，自动避开画布边缘与已放置标签
  placedRects = placedRects || [];
  const label = feature.id + '·' + feature.type;
  ctx.save();
  ctx.font = 'bold 12px "Noto Serif SC", "Songti SC", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const half = ctx.measureText(label).width / 2;
  const lx = Math.max(12 + half, Math.min(COAST_SIZE - 12 - half, feature.x));

  const candidates = [
    feature.y + 27,
    feature.y - 27,
    feature.y + 43,
    feature.y - 43,
  ];
  let ly = feature.y + 27;
  let rect = null;
  for (const y of candidates) {
    if (y < 24 || y > COAST_SIZE - 24) continue;
    const r = { x1: lx - half - 3, x2: lx + half + 3, y1: y - 9, y2: y + 9 };
    let overlap = false;
    for (const other of placedRects) {
      if (r.x1 < other.x2 && r.x2 > other.x1 && r.y1 < other.y2 && r.y2 > other.y1) {
        overlap = true;
        break;
      }
    }
    if (!overlap) {
      ly = y;
      rect = r;
      break;
    }
  }
  if (!rect) {
    rect = { x1: lx - half - 3, x2: lx + half + 3, y1: ly - 9, y2: ly + 9 };
  }
  placedRects.push(rect);

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(236, 224, 196, 0.95)';
  ctx.strokeText(label, lx, ly);
  ctx.fillStyle = '#2b2016';
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

function drawFeatureGlyph(ctx, type) {
  switch (type) {
    case '礁石': {
      ctx.fillStyle = '#5b6a6a';
      ctx.beginPath();
      ctx.moveTo(-10, 7);
      ctx.lineTo(-6, -4);
      ctx.lineTo(-2, 1);
      ctx.lineTo(3, -8);
      ctx.lineTo(10, 7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(246, 238, 216, 0.80)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-9, 8);
      ctx.quadraticCurveTo(0, 11, 9, 8);
      ctx.stroke();
      break;
    }
    case '灯塔': {
      ctx.fillStyle = '#f6eed8';
      ctx.beginPath();
      ctx.moveTo(-5, 8);
      ctx.lineTo(-3, -3);
      ctx.lineTo(3, -3);
      ctx.lineTo(5, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#a8432f';
      ctx.fillRect(-4.5, 3, 9, 2.4);
      ctx.fillRect(-3.7, -1, 7.4, 2);
      ctx.fillStyle = '#4a3b2a';
      ctx.fillRect(-4, -8, 8, 4);
      ctx.fillStyle = '#e8c15c';
      ctx.fillRect(-2.4, -7, 4.8, 2.6);
      ctx.strokeStyle = 'rgba(212, 175, 55, 0.85)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-5, -6);
      ctx.lineTo(-13, -9);
      ctx.moveTo(5, -6);
      ctx.lineTo(13, -9);
      ctx.stroke();
      break;
    }
    case '洞穴入口': {
      ctx.fillStyle = '#7d6a4e';
      ctx.beginPath();
      ctx.moveTo(-12, 8);
      ctx.quadraticCurveTo(-14, -6, 0, -8);
      ctx.quadraticCurveTo(14, -6, 12, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#2b2016';
      ctx.beginPath();
      ctx.moveTo(-6, 8);
      ctx.quadraticCurveTo(-6, -2, 0, -2);
      ctx.quadraticCurveTo(6, -2, 6, 8);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case '沉船残骸': {
      ctx.fillStyle = '#7a5230';
      ctx.beginPath();
      ctx.moveTo(-11, 1);
      ctx.quadraticCurveTo(0, 11, 11, 0);
      ctx.lineTo(8, 5);
      ctx.quadraticCurveTo(0, 11, -8, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#4a3b2a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-2, 2);
      ctx.lineTo(-2, -9);
      ctx.moveTo(-2, -7);
      ctx.lineTo(7, -3);
      ctx.stroke();
      break;
    }
    case '渔村': {
      ctx.fillStyle = '#d8c59a';
      ctx.fillRect(-8, 0, 8, 7);
      ctx.fillStyle = '#b5544a';
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(-4, -6);
      ctx.lineTo(1, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#d8c59a';
      ctx.fillRect(2, 2, 7, 5);
      ctx.fillStyle = '#8a6d3b';
      ctx.beginPath();
      ctx.moveTo(1, 2);
      ctx.lineTo(5.5, -3);
      ctx.lineTo(10, 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case '盐沼': {
      ctx.strokeStyle = '#6e7f4a';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 5, 8);
        ctx.quadraticCurveTo(k * 6 + 2, 1, k * 7, -7);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(126, 154, 148, 0.90)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-10, 9);
      ctx.quadraticCurveTo(0, 12, 10, 9);
      ctx.stroke();
      break;
    }
  }
}

function renderCoastInfo(coast, container) {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = '<strong>陆地 ' + (coast.landRatioActual * 100).toFixed(1) +
    '% · 特征点 ' + coast.features.length + ' 处</strong>';
  container.appendChild(title);
  for (const f of coast.features) {
    const div = document.createElement('div');
    div.textContent = '特征 ' + f.id + '：' + f.direction + '侧' + f.type +
      '（距海岸约 ' + f.distanceToCoast + ' 尺）';
    container.appendChild(div);
  }
}

// ---------- 页面交互 ----------
let currentCoast = null;

function readOpts() {
  return {
    landRatio: parseInt(document.getElementById('landRatio').value, 10),
    complexity: parseInt(document.getElementById('coastComplexity').value, 10),
    featureCount: parseInt(document.getElementById('featureCount').value, 10),
  };
}

function syncLabels() {
  document.getElementById('valLandRatio').textContent =
    document.getElementById('landRatio').value + '%';
  document.getElementById('valComplexity').textContent =
    document.getElementById('coastComplexity').value + ' 级';
  document.getElementById('valFeatures').textContent =
    document.getElementById('featureCount').value + ' 处';
}

function readSeed() {
  const seedText = document.getElementById('seedInput').value.trim();
  let seedNum;
  if (seedText) {
    seedNum = /^\d+$/.test(seedText) ? parseInt(seedText, 10) : hashStringToSeed(seedText);
  } else {
    seedNum = Math.floor(Math.random() * 1e9);
    document.getElementById('seedInput').value = String(seedNum);
  }
  return seedNum;
}

function generate() {
  const opts = readOpts();
  const seedNum = readSeed();

  const coast = generateCoast({
    landRatio: opts.landRatio,
    complexity: opts.complexity,
    featureCount: opts.featureCount,
    seed: seedNum,
  });
  currentCoast = coast;

  renderCoast(coast, document.getElementById('coastCanvas'));
  renderCoastInfo(coast, document.getElementById('coastInfo'));
}

function exportPng() {
  const canvas = document.getElementById('coastCanvas');
  const link = document.createElement('a');
  link.download = '海岸地图_' + (document.getElementById('seedInput').value || 'random') + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function buildCoastListText(coast, seedText) {
  const seed = seedText || 'random';
  let text = '海岸地图清单（种子：' + seed + '）\n';
  text += '陆地比例设定：' + coast.opts.landRatio + '%　实际：' +
    (coast.landRatioActual * 100).toFixed(1) + '%\n';
  text += '海岸线曲折度：' + coast.opts.complexity + ' 级　海平面阈值：' +
    coast.threshold.toFixed(4) + '\n';
  text += '地形特征点：' + coast.features.length + ' 处\n\n';

  if (coast.features.length === 0) {
    text += '（本次生成没有地形特征点）\n';
  } else {
    for (const f of coast.features) {
      text += '特征 ' + f.id + '：' + f.direction + '侧' + f.type +
        '，距海岸约 ' + f.distanceToCoast + ' 尺（坐标 ' +
        Math.round(f.x) + ', ' + Math.round(f.y) + '）\n';
    }
  }
  return text;
}

function exportTxt() {
  if (!currentCoast) return;
  const seed = document.getElementById('seedInput').value || 'random';
  const text = buildCoastListText(currentCoast, seed);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = '海岸清单_' + seed + '.txt';
  link.href = URL.createObjectURL(blob);
  link.click();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    ['landRatio', 'coastComplexity', 'featureCount'].forEach(id => {
      document.getElementById(id).addEventListener('input', syncLabels);
    });
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
}

// Node 冒烟测试入口（浏览器中 module 不存在，不会执行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mulberry32,
    hashStringToSeed,
    createValueNoise,
    fbm,
    directionFromCenter,
    traceContour,
    contourPairs,
    FEATURE_TYPES,
    Coast,
    generateCoast,
    buildCoastListText,
    renderCoast,
    renderCoastInfo,
  };
}
