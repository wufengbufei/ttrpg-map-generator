/* =========================================================
 * 中文 TTRPG 地图生成器 - 住所生成器
 * 算法：矩形 / L 形轮廓 + 递归二分（BSP）切分房间
 *       + 房间邻接图最小生成树开门 + 家具沿墙排布
 * 纯前端实现，无依赖；核心生成逻辑可直接在 Node 中测试
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

// ---------- 常量 ----------
const MIN_ROOM_AREA = 9;   // 最小房间格数，保证能放下 3×3 家具布局
const MIN_ROOM_SIDE = 3;   // 房间最小边宽（格）
const CELL = 28;           // 渲染时每格像素
const CANVAS_W = 880;
const CANVAS_H = 660;

// ---------- 家具定义 ----------
// w/h 为占用的格数；靠近墙摆放时由渲染函数画成简单平面图标
const FURNITURE_DEFS = {
  bed:        { icon: 'bed',        label: '床',   w: 2, h: 2 },
  singleBed:  { icon: 'bed',        label: '床',   w: 1, h: 2 },
  sofa:       { icon: 'sofa',       label: '沙发', w: 2, h: 1 },
  fireplace:  { icon: 'fireplace',  label: '壁炉', w: 2, h: 1 },
  lowTable:   { icon: 'table',      label: '桌',   w: 2, h: 1 },
  table:      { icon: 'table',      label: '桌',   w: 2, h: 1 },
  chair:      { icon: 'chair',      label: '椅',   w: 1, h: 1 },
  wardrobe:   { icon: 'wardrobe',   label: '衣柜', w: 2, h: 1 },
  nightstand: { icon: 'nightstand', label: '柜',   w: 1, h: 1 },
  shelf:      { icon: 'shelf',      label: '书架', w: 2, h: 1 },
  stove:      { icon: 'stove',      label: '灶台', w: 2, h: 1 },
  crate:      { icon: 'crate',      label: '箱',   w: 1, h: 1 },
  barrel:     { icon: 'barrel',     label: '桶',   w: 1, h: 1 },
  tub:        { icon: 'tub',        label: '浴桶', w: 1, h: 1 },
  basin:      { icon: 'basin',      label: '水盆', w: 1, h: 1 },
  desk:       { icon: 'desk',       label: '书桌', w: 2, h: 1 },
  cabinet:    { icon: 'cabinet',    label: '鞋柜', w: 2, h: 1 },
  coatrack:   { icon: 'coatrack',   label: '衣架', w: 1, h: 1 },
  rug:        { icon: 'rug',        label: '地毯', w: 2, h: 2 },
};

// ---------- 房间类型与候选家具 ----------
// 家具列表按优先级排列；密度决定实际尝试摆放的数量
const ROOM_TYPES = {
  '客厅':   { tint: '#e2cda2', furniture: ['sofa', 'fireplace', 'lowTable', 'chair', 'shelf', 'rug'] },
  '主卧':   { tint: '#d8c5a8', furniture: ['bed', 'wardrobe', 'nightstand', 'rug'] },
  '次卧':   { tint: '#d4c1a6', furniture: ['singleBed', 'wardrobe', 'nightstand'] },
  '厨房':   { tint: '#d9c39a', furniture: ['stove', 'table', 'shelf', 'crate', 'barrel'] },
  '储藏室': { tint: '#c9b791', furniture: ['crate', 'shelf', 'barrel', 'crate'] },
  '浴室':   { tint: '#cdd1c2', furniture: ['tub', 'basin', 'shelf'] },
  '书房':   { tint: '#d5c3a4', furniture: ['desk', 'shelf', 'chair', 'rug'] },
  '餐厅':   { tint: '#dfc8a4', furniture: ['table', 'chair', 'chair', 'shelf'] },
  '门厅':   { tint: '#dcc9a7', furniture: ['cabinet', 'coatrack', 'rug'] },
};
const EXTRA_ROOM_TYPES = ['次卧', '书房', '浴室', '储藏室', '餐厅', '门厅', '次卧', '储藏室'];

// ---------- 小工具 ----------
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function cellIndex(x, y, w) { return y * w + x; }

// 一组格子的包围盒（坐标闭区间）
function bboxOfCells(cells, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const idx of cells) {
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 4 邻接连通性检查（房间不可被轮廓缺角切成两截）
function isCellsConnected(cells, w) {
  if (cells.size === 0) return false;
  const first = cells.values().next().value;
  const seen = new Set([first]);
  const queue = [first];
  while (queue.length) {
    const idx = queue.pop();
    const x = idx % w;
    const y = (idx / w) | 0;
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < w - 1 ? idx + 1 : -1,
      y > 0 ? idx - w : -1,
      idx + w,
    ];
    for (const n of neighbors) {
      if (n >= 0 && cells.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen.size === cells.size;
}

// 从种子输入解析数字；UI 留空时才使用 Math.random
function seedNumberFromInput(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return Math.floor(Math.random() * 1e9);
  return /^\d+$/.test(s) ? parseInt(s, 10) : hashStringToSeed(s);
}

// ---------- 住所 ----------
class Dwelling {
  constructor(opts, seedNum) {
    const o = opts || {};
    this.opts = {
      size: clamp(Math.round(o.size == null ? 22 : o.size), 14, 28),
      roomCount: clamp(Math.round(o.roomCount == null ? 6 : o.roomCount), 1, 10),
      lShape: clamp(Math.round(o.lShape == null ? 45 : o.lShape), 0, 100),
      furnitureDensity: clamp(Math.round(o.furnitureDensity == null ? 60 : o.furnitureDensity), 0, 100),
    };
    this.seed = (seedNum == null ? 1 : seedNum) >>> 0;
    this.rng = mulberry32(this.seed);

    this.w = this.opts.size;
    this.h = clamp(Math.round(this.w * 0.72), 10, 20);
    this.footprint = new Set();
    this.owner = new Array(this.w * this.h).fill(-1);
    this.notch = null;
    this.rooms = [];
    this.doorEdges = new Set();
    this.doors = [];
    this.frontDoor = null;
    this.connected = false;
  }

  // ---------- 随机辅助 ----------
  randFloat(min, max) { return this.rng() * (max - min) + min; }
  randInt(min, max) { return Math.floor(this.rng() * (max - min + 1)) + min; }
  chance(pct) { return this.rng() * 100 < pct; }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  hasCell(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.footprint.has(cellIndex(x, y, this.w));
  }

  // ---------- 建筑轮廓：矩形，或切掉一角的 L 形 ----------
  buildFootprint() {
    this.footprint = new Set();
    this.owner.fill(-1);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        this.footprint.add(cellIndex(x, y, this.w));
      }
    }

    const c = this.opts.lShape / 100;
    if (c <= 0) return;

    // 缺角大小随复杂度增长；限制上限，保证 L 形的两翼都能放房间
    const nw = Math.min(
      Math.max(2, Math.round(this.w * (0.16 + 0.24 * c))),
      this.w - 6,
    );
    const nh = Math.min(
      Math.max(2, Math.round(this.h * (0.18 + 0.27 * c))),
      this.h - 5,
    );
    const corners = [
      { nx: this.w - nw, ny: 0 },  // 右上
      { nx: 0, ny: 0 },            // 左上
      { nx: this.w - nw, ny: this.h - nh }, // 右下
      { nx: 0, ny: this.h - nh },  // 左下
    ];
    const corner = corners[this.randInt(0, corners.length - 1)];

    for (let y = corner.ny; y < corner.ny + nh; y++) {
      for (let x = corner.nx; x < corner.nx + nw; x++) {
        this.footprint.delete(cellIndex(x, y, this.w));
      }
    }
    this.notch = { x: corner.nx, y: corner.ny, w: nw, h: nh };
  }

  // ---------- BSP: 递归二分轮廓，直到达到目标房间数 ----------
  splitIntoRooms() {
    let regions = [{
      cells: new Set(this.footprint),
      bbox: { x0: 0, y0: 0, x1: this.w - 1, y1: this.h - 1, w: this.w, h: this.h },
    }];
    const target = this.opts.roomCount;

    while (regions.length < target) {
      const candidates = [];
      for (const region of regions) {
        const splits = this.validSplits(region);
        if (splits.length) candidates.push({ region, splits });
      }
      if (!candidates.length) break;

      // 优先切较大的区域，但保留随机性，避免大房间总是先被切碎
      candidates.sort((a, b) => b.region.cells.size - a.region.cells.size);
      const top = candidates.slice(0, Math.min(3, candidates.length));
      const chosen = this.pick(top);
      const split = this.pick(chosen.splits);
      const idx = regions.indexOf(chosen.region);
      regions.splice(idx, 1, ...this.applySplit(chosen.region, split));
    }

    this.rooms = regions.map((region, i) => {
      const cells = region.cells;
      const bbox = region.bbox;
      let sx = 0, sy = 0;
      for (const idx of cells) { sx += idx % this.w; sy += (idx / this.w) | 0; }
      const cx = sx / cells.size;
      const cy = sy / cells.size;
      let labelCell = null, best = Infinity;
      for (const idx of cells) {
        const x = idx % this.w;
        const y = (idx / this.w) | 0;
        const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d < best) { best = d; labelCell = idx; }
      }
      return {
        id: 0,
        cells,
        bbox,
        area: cells.size,
        labelCell,
        type: '',
        tint: '#e7d8b4',
        furniture: [],
      };
    });

    // 先按面积分配类型，再按阅读顺序编号（方便对照清单）
    this.assignRoomTypes();
    this.rooms.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
    this.rooms.forEach((room, i) => {
      room.id = i + 1;
      room.tint = ROOM_TYPES[room.type].tint;
      for (const idx of room.cells) this.owner[idx] = room.id;
    });
  }

  // 找出一个区域所有合法的直线切法（两侧连通、面积/边宽达标）
  validSplits(region) {
    const bbox = region.bbox;
    const axes = [];
    if (bbox.w > bbox.h * 1.18) axes.push('v', 'h');
    else if (bbox.h > bbox.w * 1.18) axes.push('h', 'v');
    else {
      const first = this.chance(50) ? 'v' : 'h';
      axes.push(first, first === 'v' ? 'h' : 'v');
    }
    const uniqueAxes = axes.filter((axis, i) => axes.indexOf(axis) === i);

    for (const axis of uniqueAxes) {
      const splits = this.collectSplits(region, axis);
      if (splits.length) return splits;
    }
    return [];
  }

  collectSplits(region, axis) {
    const { cells, bbox } = region;
    const splits = [];
    if (axis === 'v') {
      for (let cut = bbox.x0 + MIN_ROOM_SIDE - 1; cut <= bbox.x1 - MIN_ROOM_SIDE; cut++) {
        const left = new Set();
        const right = new Set();
        for (const idx of cells) {
          if (idx % this.w <= cut) left.add(idx); else right.add(idx);
        }
        if (left.size < MIN_ROOM_AREA || right.size < MIN_ROOM_AREA) continue;
        const lb = bboxOfCells(left, this.w);
        const rb = bboxOfCells(right, this.w);
        if (lb.w < MIN_ROOM_SIDE || lb.h < MIN_ROOM_SIDE) continue;
        if (rb.w < MIN_ROOM_SIDE || rb.h < MIN_ROOM_SIDE) continue;
        const balance = Math.min(left.size, right.size) / Math.max(left.size, right.size);
        if (balance < 0.35) continue;
        if (!isCellsConnected(left, this.w) || !isCellsConnected(right, this.w)) continue;
        splits.push({ axis, cut });
      }
    } else {
      for (let cut = bbox.y0 + MIN_ROOM_SIDE - 1; cut <= bbox.y1 - MIN_ROOM_SIDE; cut++) {
        const top = new Set();
        const bottom = new Set();
        for (const idx of cells) {
          if (((idx / this.w) | 0) <= cut) top.add(idx); else bottom.add(idx);
        }
        if (top.size < MIN_ROOM_AREA || bottom.size < MIN_ROOM_AREA) continue;
        const tb = bboxOfCells(top, this.w);
        const bb = bboxOfCells(bottom, this.w);
        if (tb.w < MIN_ROOM_SIDE || tb.h < MIN_ROOM_SIDE) continue;
        if (bb.w < MIN_ROOM_SIDE || bb.h < MIN_ROOM_SIDE) continue;
        const balance = Math.min(top.size, bottom.size) / Math.max(top.size, bottom.size);
        if (balance < 0.35) continue;
        if (!isCellsConnected(top, this.w) || !isCellsConnected(bottom, this.w)) continue;
        splits.push({ axis, cut });
      }
    }
    return splits;
  }

  applySplit(region, split) {
    const a = new Set();
    const b = new Set();
    for (const idx of region.cells) {
      const onFirst = split.axis === 'v'
        ? (idx % this.w) <= split.cut
        : ((idx / this.w) | 0) <= split.cut;
      if (onFirst) a.add(idx); else b.add(idx);
    }
    return [
      { cells: a, bbox: bboxOfCells(a, this.w) },
      { cells: b, bbox: bboxOfCells(b, this.w) },
    ];
  }

  // 房间类型：最大间作客厅，其次厨房/主卧，余下从候选池抽取
  assignRoomTypes() {
    if (!this.rooms.length) return;
    const byArea = this.rooms.slice().sort((a, b) => b.area - a.area);
    const types = [];
    types.push('客厅');
    if (byArea.length >= 2) types.push(byArea.length === 2 ? '主卧' : '厨房');
    if (byArea.length >= 3) types.push('主卧');

    const pool = this.shuffle(EXTRA_ROOM_TYPES);
    let poolIdx = 0;
    while (types.length < byArea.length) {
      types.push(pool[poolIdx % pool.length]);
      poolIdx++;
    }

    byArea.forEach((room, i) => {
      let type = types[i];
      // 过小的房间改成储藏室/浴室，避免家具一个都放不下
      if (i > 0 && room.area < 12 && (type === '主卧' || type === '厨房')) {
        type = this.chance(60) ? '储藏室' : '浴室';
      }
      room.type = type;
    });
  }

  // ---------- 门：房间邻接图 + 最小生成树 ----------
  buildDoors() {
    if (!this.rooms.length) return;
    this.doorEdges = new Set();
    this.doors = [];
    this.frontDoor = null;

    const pairs = new Map(); // "小id_大id" -> { a, b, edges: [] }
    for (const room of this.rooms) {
      for (const idx of room.cells) {
        const x = idx % this.w;
        const y = (idx / this.w) | 0;
        // 向右、向下的共享边只统计一次
        if (this.hasCell(x + 1, y)) {
          const other = this.owner[cellIndex(x + 1, y, this.w)];
          if (other !== room.id) this.addPairEdge(pairs, room.id, other, {
            key: `v:${x + 1}:${y}`,
            orient: 'v', x: x + 1, y,
            a: Math.min(room.id, other), b: Math.max(room.id, other),
          });
        }
        if (this.hasCell(x, y + 1)) {
          const other = this.owner[cellIndex(x, y + 1, this.w)];
          if (other !== room.id) this.addPairEdge(pairs, room.id, other, {
            key: `h:${x}:${y + 1}`,
            orient: 'h', x, y: y + 1,
            a: Math.min(room.id, other), b: Math.max(room.id, other),
          });
        }
      }
    }

    // 共享墙越长，越优先作为连通边，门的位置更自然
    const ordered = Array.from(pairs.values())
      .sort((p, q) => (q.edges.length - p.edges.length) || (p.a - q.a) || (p.b - q.b));

    const parent = new Array(this.rooms.length + 1).fill(0).map((_, i) => i);
    const find = (v) => {
      while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
      return v;
    };
    const union = (x, y) => {
      const rx = find(x), ry = find(y);
      if (rx === ry) return false;
      parent[ry] = rx;
      return true;
    };

    const extras = [];
    for (const pair of ordered) {
      const edge = this.pickDoorEdge(pair.edges);
      if (union(pair.a, pair.b)) {
        this.addDoor(edge);
      } else {
        extras.push({ pair, edge });
      }
    }

    // 少量额外门形成环路，但不能多到破坏户型感
    const extraLimit = Math.min(2, Math.floor(this.rooms.length / 4));
    for (const item of extras) {
      if (this.doors.filter(d => !d.exterior).length >= this.rooms.length - 1 + extraLimit) break;
      if (this.chance(18)) this.addDoor(item.edge);
    }

    this.addFrontDoor();
  }

  addPairEdge(pairs, idA, idB, edge) {
    const key = `${Math.min(idA, idB)}_${Math.max(idA, idB)}`;
    if (!pairs.has(key)) {
      pairs.set(key, { a: Math.min(idA, idB), b: Math.max(idA, idB), edges: [] });
    }
    pairs.get(key).edges.push(edge);
  }

  // 在共享墙的连续段中选一段，并尽量取段中点，门的落位更规整
  pickDoorEdge(edges) {
    if (edges.length === 1) return edges[0];
    const groups = new Map();
    for (const e of edges) {
      const gk = e.orient === 'v' ? `v:${e.x}` : `h:${e.y}`;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(e);
    }

    const segments = [];
    for (const arr of groups.values()) {
      arr.sort((p, q) => (p.orient === 'v' ? p.y - q.y : p.x - q.x));
      let run = [arr[0]];
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1];
        const cur = arr[i];
        const adjacent = cur.orient === 'v' ? cur.y === prev.y + 1 : cur.x === prev.x + 1;
        if (adjacent) run.push(cur);
        else { segments.push(run); run = [cur]; }
      }
      segments.push(run);
    }

    const total = segments.reduce((sum, seg) => sum + seg.length, 0);
    let roll = this.randFloat(0, total);
    let chosen = segments[0];
    for (const seg of segments) {
      roll -= seg.length;
      if (roll <= 0) { chosen = seg; break; }
    }
    const mid = Math.floor(chosen.length / 2) + this.randInt(-1, 1);
    return chosen[clamp(mid, 0, chosen.length - 1)];
  }

  addDoor(edge) {
    if (this.doorEdges.has(edge.key)) return;
    this.doorEdges.add(edge.key);
    this.doors.push({
      key: edge.key,
      orient: edge.orient,
      x: edge.x,
      y: edge.y,
      a: edge.a,
      b: edge.b,
      swingRoom: this.chance(50) ? edge.a : edge.b,
      exterior: false,
    });
  }

  // 在原建筑外墙上开一个入口，优先选择客厅
  addFrontDoor() {
    const edges = [];
    const seen = new Set();
    for (const room of this.rooms) {
      for (const idx of room.cells) {
        const x = idx % this.w;
        const y = (idx / this.w) | 0;
        const candidates = [
          !this.hasCell(x - 1, y) && { key: `v:${x}:${y}`, orient: 'v', x, y, outside: 'left' },
          !this.hasCell(x + 1, y) && { key: `v:${x + 1}:${y}`, orient: 'v', x: x + 1, y, outside: 'right' },
          !this.hasCell(x, y - 1) && { key: `h:${x}:${y}`, orient: 'h', x, y, outside: 'top' },
          !this.hasCell(x, y + 1) && { key: `h:${x}:${y + 1}`, orient: 'h', x, y: y + 1, outside: 'bottom' },
        ];
        for (const c of candidates) {
          if (!c || seen.has(c.key)) continue;
          seen.add(c.key);
          edges.push({ ...c, a: room.id, b: null });
        }
      }
    }
    if (!edges.length) return;

    const living = this.rooms.find(r => r.type === '客厅') || this.rooms[0];
    let pool = edges.filter(e => e.a === living.id);
    if (!pool.length) pool = edges;
    const edge = this.pickDoorEdge(pool);
    if (this.doorEdges.has(edge.key)) return;
    this.doorEdges.add(edge.key);
    const door = {
      key: edge.key,
      orient: edge.orient,
      x: edge.x,
      y: edge.y,
      a: edge.a,
      b: null,
      swingRoom: edge.a,
      exterior: true,
      outside: edge.outside,
    };
    this.doors.push(door);
    this.frontDoor = door;
  }

  // 门图中除入口外，所有房间必须互相可达
  checkRoomConnectivity() {
    if (this.rooms.length <= 1) return true;
    const graph = new Map();
    for (const room of this.rooms) graph.set(room.id, new Set());
    for (const door of this.doors) {
      if (door.exterior || door.b == null) continue;
      graph.get(door.a).add(door.b);
      graph.get(door.b).add(door.a);
    }
    const seen = new Set([this.rooms[0].id]);
    const queue = [this.rooms[0].id];
    while (queue.length) {
      const id = queue.pop();
      for (const next of graph.get(id)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen.size === this.rooms.length;
  }

  // ---------- 家具：沿墙优先，避开门口与房间标签 ----------
  placeFurniture() {
    this.furnitureCells = new Set();
    const blocked = new Set();

    // 门口两侧各留出一格，避免家具挡住门
    for (const door of this.doors) {
      const around = this.doorCells(door);
      for (const idx of around) {
        if (idx >= 0 && this.footprint.has(idx)) blocked.add(idx);
      }
    }

    for (const room of this.rooms) {
      const lx = room.labelCell % this.w;
      const ly = (room.labelCell / this.w) | 0;
      const labelCells = [
        room.labelCell,
        this.hasCell(lx - 1, ly) ? cellIndex(lx - 1, ly, this.w) : -1,
        this.hasCell(lx + 1, ly) ? cellIndex(lx + 1, ly, this.w) : -1,
      ];
      for (const idx of labelCells) if (idx >= 0) blocked.add(idx);

      const density = this.opts.furnitureDensity / 100;
      if (density <= 0) continue;
      const target = Math.max(1, Math.round(density * (2 + room.area / 26)));
      const defs = ROOM_TYPES[room.type].furniture;
      let placed = 0;

      for (const defKey of defs) {
        if (placed >= target) break;
        const def = FURNITURE_DEFS[defKey];
        if (!def) continue;
        if (this.tryPlaceFurniture(room, def, blocked)) placed++;
      }
    }
  }

  doorCells(door) {
    if (door.orient === 'v') {
      return [
        door.x - 1 >= 0 ? cellIndex(door.x - 1, door.y, this.w) : -1,
        door.x < this.w ? cellIndex(door.x, door.y, this.w) : -1,
      ];
    }
    return [
      door.y - 1 >= 0 ? cellIndex(door.x, door.y - 1, this.w) : -1,
      door.y < this.h ? cellIndex(door.x, door.y, this.w) : -1,
    ];
  }

  tryPlaceFurniture(room, def, blocked) {
    const orientations = def.w === def.h
      ? [[def.w, def.h]]
      : [[def.w, def.h], [def.h, def.w]];

    const candidates = [];
    for (const [fw, fh] of orientations) {
      if (fw > room.bbox.w || fh > room.bbox.h) continue;
      for (let y = room.bbox.y0; y + fh <= room.bbox.y1 + 1; y++) {
        for (let x = room.bbox.x0; x + fw <= room.bbox.x1 + 1; x++) {
          let ok = true;
          let wallScore = 0;
          for (let dy = 0; dy < fh && ok; dy++) {
            for (let dx = 0; dx < fw; dx++) {
              const cx = x + dx;
              const cy = y + dy;
              const idx = cellIndex(cx, cy, this.w);
              if (!this.hasCell(cx, cy) || this.owner[idx] !== room.id) { ok = false; break; }
              if (blocked.has(idx) || this.furnitureCells.has(idx)) { ok = false; break; }
            }
          }
          if (!ok) continue;

          // 统计家具矩形与墙/其它房间贴近的边数，靠墙的更优先
          for (let dx = 0; dx < fw; dx++) {
            if (!this.hasCell(x + dx, y - 1) ||
                this.owner[cellIndex(x + dx, y - 1, this.w)] !== room.id) wallScore++;
            if (!this.hasCell(x + dx, y + fh) ||
                this.owner[cellIndex(x + dx, y + fh, this.w)] !== room.id) wallScore++;
          }
          for (let dy = 0; dy < fh; dy++) {
            if (!this.hasCell(x - 1, y + dy) ||
                this.owner[cellIndex(x - 1, y + dy, this.w)] !== room.id) wallScore++;
            if (!this.hasCell(x + fw, y + dy) ||
                this.owner[cellIndex(x + fw, y + dy, this.w)] !== room.id) wallScore++;
          }
          candidates.push({ x, y, w: fw, h: fh, wallScore });
        }
      }
    }
    if (!candidates.length) return false;

    const maxScore = candidates.reduce((m, c) => Math.max(m, c.wallScore), 0);
    const best = candidates.filter(c => c.wallScore >= maxScore - 1);
    const choice = this.pick(best);

    for (let dy = 0; dy < choice.h; dy++) {
      for (let dx = 0; dx < choice.w; dx++) {
        this.furnitureCells.add(cellIndex(choice.x + dx, choice.y + dy, this.w));
      }
    }
    room.furniture.push({
      icon: def.icon,
      label: def.label,
      x: choice.x,
      y: choice.y,
      w: choice.w,
      h: choice.h,
    });
    return true;
  }

  // ---------- 生成入口 ----------
  generate() {
    this.buildFootprint();
    this.splitIntoRooms();
    this.buildDoors();
    this.placeFurniture();
    this.connected = this.checkRoomConnectivity();
    return this;
  }

  // 供测试与调试使用的纯数据快照
  snapshot() {
    return {
      seed: this.seed,
      w: this.w,
      h: this.h,
      notch: this.notch,
      connected: this.connected,
      rooms: this.rooms.map(r => ({
        id: r.id,
        type: r.type,
        area: r.area,
        bbox: r.bbox,
        labelCell: r.labelCell,
        furniture: r.furniture.map(f => ({
          icon: f.icon, label: f.label, x: f.x, y: f.y, w: f.w, h: f.h,
        })),
      })),
      doors: this.doors.map(d => ({
        key: d.key, orient: d.orient, x: d.x, y: d.y,
        a: d.a, b: d.b, exterior: d.exterior,
      })),
    };
  }
}

// ---------- 对外工厂 ----------
function generateDwelling(opts, seed) {
  const seedNum = typeof seed === 'number' ? (seed >>> 0) : seedNumberFromInput(seed);
  const dwelling = new Dwelling(opts, seedNum);
  dwelling.generate();
  return dwelling;
}

// ---------- 渲染 ----------
const SERIF_FONT = '"Noto Serif SC", "Songti SC", "STSong", serif';

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, fill) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function renderDwelling(dwelling, canvas) {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  const ox = Math.round((CANVAS_W - dwelling.w * CELL) / 2);
  const oy = Math.round((CANVAS_H - dwelling.h * CELL) / 2 + 18);

  // 羊皮纸底 + 轻微纸纹
  ctx.fillStyle = '#ece0c4';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = 'rgba(90,69,48,0.045)';
  for (let i = 0; i < 220; i++) {
    const x = (i * 137 + 53) % CANVAS_W;
    const y = (i * 223 + 91) % CANVAS_H;
    ctx.fillRect(x, y, 1.5, 1.5);
  }

  drawDwellingTitle(ctx, dwelling);

  // 建筑投影（先铺一层错位的地块剪影）
  ctx.fillStyle = 'rgba(43,32,22,0.16)';
  for (const idx of dwelling.footprint) {
    const x = idx % dwelling.w;
    const y = (idx / dwelling.w) | 0;
    ctx.fillRect(ox + x * CELL + 5, oy + y * CELL + 6, CELL, CELL);
  }

  // 地板：按房间类型着色，轻微棋盘纹理
  for (const room of dwelling.rooms) {
    for (const idx of room.cells) {
      const x = idx % dwelling.w;
      const y = (idx / dwelling.w) | 0;
      ctx.fillStyle = room.tint;
      ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL, CELL);
      if ((x + y) % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.055)';
        ctx.fillRect(ox + x * CELL, oy + y * CELL, CELL, CELL);
      }
    }
  }

  // 家具先画，房间标签与墙体后画，保证边界清晰
  for (const room of dwelling.rooms) {
    for (const item of room.furniture) {
      drawFurniture(ctx, item, ox + item.x * CELL, oy + item.y * CELL);
    }
  }

  drawRoomLabels(ctx, dwelling, ox, oy);
  drawWalls(ctx, dwelling, ox, oy);
  drawDoors(ctx, dwelling, ox, oy);
  drawCompass(ctx, CANVAS_W - 50, 38);

  ctx.font = `12px ${SERIF_FONT}`;
  ctx.fillStyle = 'rgba(90,74,56,0.8)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('房间编号对照下方清单', 24, CANVAS_H - 18);
  ctx.textAlign = 'right';
  ctx.fillText('1 格 ≈ 1 尺', CANVAS_W - 24, CANVAS_H - 18);
}

function drawDwellingTitle(ctx, dwelling) {
  const shape = dwelling.notch ? 'L 形' : '矩形';
  const seedLabel = String(dwelling.seedText || dwelling.seed).slice(0, 24);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#2b2016';
  ctx.font = `bold 23px ${SERIF_FONT}`;
  ctx.fillText('住所平面图', 28, 42);
  ctx.font = `12.5px ${SERIF_FONT}`;
  ctx.fillStyle = '#5a4a38';
  ctx.fillText(`${dwelling.w} × ${dwelling.h} 格 · ${shape} · ${dwelling.rooms.length} 间房 · 种子 ${seedLabel}`, 30, 64);
}

function drawRoomLabels(ctx, dwelling, ox, oy) {
  for (const room of dwelling.rooms) {
    const lx = room.labelCell % dwelling.w;
    const ly = (room.labelCell / dwelling.w) | 0;
    const cx = ox + lx * CELL + CELL / 2;
    const cy = oy + ly * CELL + CELL / 2;
    const text = `${room.id} ${room.type}`;
    ctx.font = `bold 11px ${SERIF_FONT}`;
    const w = ctx.measureText(text).width + 14;
    const h = 19;
    fillRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, 5, 'rgba(245,236,214,0.93)');
    roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, 5);
    ctx.strokeStyle = 'rgba(90,69,48,0.38)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2b2016';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 0.5);
  }
}

// 墙：外轮廓 6px，内隔墙 3px；有门的位置留缺口
function drawWalls(ctx, dwelling, ox, oy) {
  ctx.lineCap = 'round';
  for (const room of dwelling.rooms) {
    for (const idx of room.cells) {
      const x = idx % dwelling.w;
      const y = (idx / dwelling.w) | 0;
      drawWallSegments(ctx, dwelling, ox, oy, x, y);
    }
  }
}

function drawWallSegments(ctx, dwelling, ox, oy, x, y) {
  const edges = [];
  // 西侧墙
  if (!dwelling.hasCell(x - 1, y)) {
    edges.push({ key: `v:${x}:${y}`, orient: 'v', gx: x, gy: y, outer: true });
  } else if (dwelling.owner[cellIndex(x - 1, y, dwelling.w)] !== dwelling.owner[cellIndex(x, y, dwelling.w)]) {
    edges.push({ key: `v:${x}:${y}`, orient: 'v', gx: x, gy: y, outer: false });
  }
  // 北侧墙
  if (!dwelling.hasCell(x, y - 1)) {
    edges.push({ key: `h:${x}:${y}`, orient: 'h', gx: x, gy: y, outer: true });
  } else if (dwelling.owner[cellIndex(x, y - 1, dwelling.w)] !== dwelling.owner[cellIndex(x, y, dwelling.w)]) {
    edges.push({ key: `h:${x}:${y}`, orient: 'h', gx: x, gy: y, outer: false });
  }
  // 东、南只在外轮廓时补一次，避免内部墙重复绘制
  if (!dwelling.hasCell(x + 1, y)) {
    edges.push({ key: `v:${x + 1}:${y}`, orient: 'v', gx: x + 1, gy: y, outer: true });
  }
  if (!dwelling.hasCell(x, y + 1)) {
    edges.push({ key: `h:${x}:${y + 1}`, orient: 'h', gx: x, gy: y + 1, outer: true });
  }

  for (const edge of edges) {
    if (dwelling.doorEdges.has(edge.key)) continue;
    strokeGridEdge(ctx, edge.orient, edge.gx, edge.gy, ox, oy,
      edge.outer ? 6 : 3,
      edge.outer ? '#3a2b1d' : '#5a4530');
  }
}

function strokeGridEdge(ctx, orient, gx, gy, ox, oy, width, color) {
  const x = ox + gx * CELL;
  const y = oy + gy * CELL;
  ctx.beginPath();
  if (orient === 'v') {
    ctx.moveTo(x, y + 1);
    ctx.lineTo(x, y + CELL - 1);
  } else {
    ctx.moveTo(x + 1, y);
    ctx.lineTo(x + CELL - 1, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function ownerOfCell(dwelling, x, y) {
  if (!dwelling.hasCell(x, y)) return -1;
  return dwelling.owner[cellIndex(x, y, dwelling.w)];
}

function drawDoors(ctx, dwelling, ox, oy) {
  for (const door of dwelling.doors) {
    const isV = door.orient === 'v';
    const px = ox + door.x * CELL;
    const py = oy + door.y * CELL;

    // 门槛
    ctx.beginPath();
    if (isV) {
      ctx.moveTo(px, py + 1);
      ctx.lineTo(px, py + CELL - 1);
    } else {
      ctx.moveTo(px + 1, py);
      ctx.lineTo(px + CELL - 1, py);
    }
    ctx.strokeStyle = '#8a5a2b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 门扇开向哪一侧（-1 / +1）
    let dir;
    if (isV) {
      const left = ownerOfCell(dwelling, door.x - 1, door.y);
      dir = left === door.swingRoom ? -1 : 1;
    } else {
      const above = ownerOfCell(dwelling, door.x, door.y - 1);
      dir = above === door.swingRoom ? -1 : 1;
    }

    const leaf = CELL * 0.8;
    ctx.strokeStyle = 'rgba(90,58,32,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (isV) {
      ctx.moveTo(px, py);
      ctx.lineTo(px + dir * leaf, py);
      ctx.stroke();
      ctx.beginPath();
      if (dir > 0) ctx.arc(px, py, leaf, Math.PI / 2, 0, true);
      else ctx.arc(px, py, leaf, Math.PI / 2, Math.PI, false);
    } else {
      ctx.moveTo(px, py);
      ctx.lineTo(px, py + dir * leaf);
      ctx.stroke();
      ctx.beginPath();
      if (dir > 0) ctx.arc(px, py, leaf, 0, Math.PI / 2, false);
      else ctx.arc(px, py, leaf, 0, -Math.PI / 2, true);
    }
    ctx.strokeStyle = 'rgba(90,58,32,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (door.exterior) drawEntranceLabel(ctx, door, ox, oy);
  }
}

function drawEntranceLabel(ctx, door, ox, oy) {
  const midX = ox + door.x * CELL + (door.orient === 'h' ? CELL / 2 : 0);
  const midY = oy + door.y * CELL + (door.orient === 'v' ? CELL / 2 : 0);
  let tx = midX, ty = midY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (door.outside === 'left') { tx -= 16; ctx.textAlign = 'right'; }
  if (door.outside === 'right') { tx += 16; ctx.textAlign = 'left'; }
  if (door.outside === 'top') { ty -= 12; ctx.textBaseline = 'bottom'; }
  if (door.outside === 'bottom') { ty += 14; ctx.textBaseline = 'top'; }

  ctx.font = `bold 11px ${SERIF_FONT}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(236,224,196,0.95)';
  ctx.strokeText('入口', tx, ty);
  ctx.fillStyle = '#8a2c22';
  ctx.fillText('入口', tx, ty);
}

function drawCompass(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(90,74,56,0.65)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, 16);
  ctx.lineTo(0, -16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(-5, -3);
  ctx.lineTo(5, -3);
  ctx.closePath();
  ctx.fillStyle = '#8a2c22';
  ctx.fill();
  ctx.font = `bold 10px ${SERIF_FONT}`;
  ctx.fillStyle = '#5a4a38';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('北', 0, -24);
  ctx.restore();
}

// 家具图标：用简单的俯视平面图形表示，并叠加文字标签
function drawFurniture(ctx, item, px, py) {
  const w = item.w * CELL;
  const h = item.h * CELL;

  ctx.save();
  ctx.fillStyle = 'rgba(43,32,22,0.10)';
  ctx.fillRect(px + 3, py + 4, w - 6, h - 6);

  switch (item.icon) {
    case 'bed': {
      fillRoundRect(ctx, px + 4, py + 4, w - 8, h - 8, 3, '#a88663');
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 1.2;
      roundRectPath(ctx, px + 4, py + 4, w - 8, h - 8, 3);
      ctx.stroke();
      fillRoundRect(ctx, px + w * 0.2, py + 7, w * 0.6, Math.min(12, h * 0.2), 2, '#f1e8d2');
      ctx.fillStyle = '#8d5f47';
      ctx.fillRect(px + 6, py + h * 0.38, w - 12, h * 0.46);
      ctx.strokeStyle = 'rgba(70,44,28,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 6, py + h * 0.38);
      ctx.lineTo(px + w - 6, py + h * 0.38);
      ctx.stroke();
      break;
    }
    case 'sofa': {
      fillRoundRect(ctx, px + 4, py + 6, w - 8, h - 12, 4, '#9a6b4f');
      ctx.fillStyle = '#7d543d';
      fillRoundRect(ctx, px + 4, py + 5, 5, h - 10, 2, '#7d543d');
      fillRoundRect(ctx, px + w - 9, py + 5, 5, h - 10, 2, '#7d543d');
      ctx.strokeStyle = 'rgba(70,44,28,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + w / 2, py + 8);
      ctx.lineTo(px + w / 2, py + h - 8);
      ctx.stroke();
      break;
    }
    case 'table': {
      ctx.beginPath();
      ctx.ellipse(px + w / 2, py + h / 2, w / 2 - 4, h / 2 - 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#a88663';
      ctx.fill();
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(px + w / 2, py + h / 2, w / 2 - 9, h / 2 - 9, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(70,44,28,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
    case 'fireplace': {
      fillRoundRect(ctx, px + 4, py + 4, w - 8, h - 8, 2, '#6f6254');
      ctx.strokeStyle = '#4b4137';
      ctx.lineWidth = 1.2;
      roundRectPath(ctx, px + 4, py + 4, w - 8, h - 8, 2);
      ctx.stroke();
      fillRoundRect(ctx, px + 10, py + 7, w - 20, h - 13, 3, '#33261c');
      ctx.beginPath();
      ctx.moveTo(px + w / 2, py + h - 10);
      ctx.lineTo(px + w / 2 - 5, py + h * 0.55);
      ctx.quadraticCurveTo(px + w / 2, py + h * 0.38, px + w / 2 + 5, py + h * 0.55);
      ctx.closePath();
      ctx.fillStyle = '#d07a2c';
      ctx.fill();
      break;
    }
    case 'chair': {
      fillRoundRect(ctx, px + 8, py + 10, w - 16, h - 18, 2, '#a88663');
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px + 8, py + 8);
      ctx.lineTo(px + w - 8, py + 8);
      ctx.stroke();
      break;
    }
    case 'wardrobe': {
      fillRoundRect(ctx, px + 4, py + 4, w - 8, h - 8, 2, '#8a6547');
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1.2;
      roundRectPath(ctx, px + 4, py + 4, w - 8, h - 8, 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + w / 2, py + 5);
      ctx.lineTo(px + w / 2, py + h - 5);
      ctx.stroke();
      ctx.fillStyle = '#e8d8b8';
      ctx.beginPath();
      ctx.arc(px + w / 2 - 4, py + h / 2, 1.5, 0, Math.PI * 2);
      ctx.arc(px + w / 2 + 4, py + h / 2, 1.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'nightstand': {
      fillRoundRect(ctx, px + 7, py + 7, w - 14, h - 14, 2, '#a88663');
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 1;
      roundRectPath(ctx, px + 7, py + 7, w - 14, h - 14, 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + 7, py + h / 2);
      ctx.lineTo(px + w - 7, py + h / 2);
      ctx.stroke();
      break;
    }
    case 'shelf': {
      fillRoundRect(ctx, px + 4, py + 5, w - 8, h - 10, 2, '#8a6547');
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 4, py + 5, w - 8, h - 10);
      ctx.beginPath();
      ctx.moveTo(px + 5, py + h / 2);
      ctx.lineTo(px + w - 5, py + h / 2);
      ctx.stroke();
      const bookColors = ['#8a2c22', '#6e7f4a', '#b08a3e', '#5d6f7a'];
      const bookCount = Math.max(1, Math.min(4, Math.floor((w - 16) / 6)));
      for (let i = 0; i < bookCount; i++) {
        ctx.fillStyle = bookColors[i];
        ctx.fillRect(px + 8 + i * 6, py + 8, 3.5, 6);
        ctx.fillRect(px + 8 + i * 6, py + h / 2 + 3, 3.5, 5);
      }
      break;
    }
    case 'stove': {
      fillRoundRect(ctx, px + 5, py + 5, w - 10, h - 10, 2, '#5f5a50');
      ctx.fillStyle = '#3f3a33';
      ctx.beginPath();
      ctx.arc(px + w * 0.36, py + h * 0.5, Math.min(w, h) * 0.13, 0, Math.PI * 2);
      ctx.arc(px + w * 0.64, py + h * 0.5, Math.min(w, h) * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c9b888';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px + w * 0.36, py + h * 0.5, Math.min(w, h) * 0.13, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'crate': {
      fillRoundRect(ctx, px + 7, py + 7, w - 14, h - 14, 2, '#a88663');
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px + 7, py + 7, w - 14, h - 14);
      ctx.beginPath();
      ctx.moveTo(px + 7, py + 7);
      ctx.lineTo(px + w - 7, py + h - 7);
      ctx.moveTo(px + w - 7, py + 7);
      ctx.lineTo(px + 7, py + h - 7);
      ctx.stroke();
      break;
    }
    case 'barrel': {
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, Math.min(w, h) / 2 - 6, 0, Math.PI * 2);
      ctx.fillStyle = '#8a6547';
      ctx.fill();
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + w / 2 - 6, py + h * 0.36);
      ctx.lineTo(px + w / 2 + 6, py + h * 0.36);
      ctx.moveTo(px + w / 2 - 6, py + h * 0.64);
      ctx.lineTo(px + w / 2 + 6, py + h * 0.64);
      ctx.stroke();
      break;
    }
    case 'tub': {
      fillRoundRect(ctx, px + 4, py + 6, w - 8, h - 12, 8, '#8a6547');
      ctx.beginPath();
      ctx.ellipse(px + w / 2, py + h / 2, w / 2 - 8, h / 2 - 9, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#9bb7b0';
      ctx.fill();
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
    case 'basin': {
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, Math.min(w, h) / 2 - 7, 0, Math.PI * 2);
      ctx.fillStyle = '#e8e0cc';
      ctx.fill();
      ctx.strokeStyle = '#8a7a5c';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px + w / 2, py + h / 2, Math.min(w, h) / 2 - 11, 0, Math.PI * 2);
      ctx.fillStyle = '#9bb7b0';
      ctx.fill();
      break;
    }
    case 'desk': {
      fillRoundRect(ctx, px + 4, py + 6, w - 8, h - 12, 2, '#a88663');
      ctx.strokeStyle = '#6b4d33';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px + 4, py + 6, w - 8, h - 12);
      fillRoundRect(ctx, px + w * 0.2, py + h * 0.3, w * 0.28, h * 0.28, 1, '#efe6cf');
      ctx.beginPath();
      ctx.moveTo(px + 4, py + h - 8);
      ctx.lineTo(px + w - 4, py + h - 8);
      ctx.strokeStyle = 'rgba(70,44,28,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      break;
    }
    case 'cabinet': {
      fillRoundRect(ctx, px + 4, py + 5, w - 8, h - 10, 2, '#8a6547');
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px + 4, py + 5, w - 8, h - 10);
      ctx.beginPath();
      ctx.moveTo(px + w / 2, py + 6);
      ctx.lineTo(px + w / 2, py + h - 6);
      ctx.stroke();
      ctx.fillStyle = '#e8d8b8';
      ctx.beginPath();
      ctx.arc(px + w / 2 - 4, py + h / 2, 1.4, 0, Math.PI * 2);
      ctx.arc(px + w / 2 + 4, py + h / 2, 1.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'coatrack': {
      ctx.strokeStyle = '#5e422e';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px + w / 2, py + h - 7);
      ctx.lineTo(px + w / 2, py + 8);
      ctx.moveTo(px + w / 2, py + 11);
      ctx.lineTo(px + w / 2 - 7, py + 16);
      ctx.moveTo(px + w / 2, py + 11);
      ctx.lineTo(px + w / 2 + 7, py + 16);
      ctx.stroke();
      ctx.fillStyle = '#8a2c22';
      ctx.fillRect(px + w / 2 - 9, py + 16, 5, 8);
      break;
    }
    case 'rug': {
      ctx.fillStyle = 'rgba(138,44,34,0.18)';
      ctx.fillRect(px + 5, py + 5, w - 10, h - 10);
      ctx.strokeStyle = 'rgba(138,44,34,0.45)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(px + 8, py + 8, w - 16, h - 16);
      ctx.beginPath();
      ctx.moveTo(px + 12, py + 12);
      ctx.lineTo(px + w - 12, py + h - 12);
      ctx.moveTo(px + w - 12, py + 12);
      ctx.lineTo(px + 12, py + h - 12);
      ctx.strokeStyle = 'rgba(138,44,34,0.22)';
      ctx.stroke();
      break;
    }
  }

  // 家具文字标注（带羊皮纸描边，压在图标下缘）
  ctx.font = `${CELL * 0.31}px ${SERIF_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(236,224,196,0.92)';
  ctx.strokeText(item.label, px + w / 2, py + h - 3);
  ctx.fillStyle = '#3b2c1e';
  ctx.fillText(item.label, px + w / 2, py + h - 3);
  ctx.restore();
}

// ---------- 清单 ----------
function furnitureSummary(room) {
  const counts = new Map();
  for (const item of room.furniture) {
    counts.set(item.label, (counts.get(item.label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, n]) => (n > 1 ? `${label}×${n}` : label))
    .join('、');
}

function entrySideName(side) {
  return ({ left: '西侧', right: '东侧', top: '北侧', bottom: '南侧' })[side] || '外墙';
}

function renderRoomInfo(dwelling, container) {
  container.innerHTML = '';
  const interiorDoors = dwelling.doors.filter(d => !d.exterior).length;
  const head = document.createElement('div');
  head.className = 'info-head';
  head.innerHTML = `<strong>共 ${dwelling.rooms.length} 间房 · ${interiorDoors} 扇内门${dwelling.frontDoor ? ' · 1 个入口' : ''}</strong>`;
  container.appendChild(head);

  for (const room of dwelling.rooms) {
    const div = document.createElement('div');
    div.className = 'info-room';
    const summary = furnitureSummary(room);
    div.innerHTML = `<b>房间 ${room.id} · ${room.type}</b>（${room.bbox.w}×${room.bbox.h} 格）<br>` +
      `<span class="info-furn">家具：${summary || '无（可调高家具密度）'}</span>`;
    container.appendChild(div);
  }
}

function buildDwellingText(dwelling, seedText) {
  const shape = dwelling.notch ? 'L 形' : '矩形';
  const interiorDoors = dwelling.doors.filter(d => !d.exterior).length;
  let text = `住所室内清单（种子：${seedText}）\n`;
  text += `建筑：${dwelling.w} × ${dwelling.h} 格，${shape}，实际 ${dwelling.rooms.length} 间房\n`;
  text += `门：${interiorDoors} 扇内门${dwelling.frontDoor ? '，另有 1 个入口' : ''}\n\n`;
  for (const room of dwelling.rooms) {
    const summary = furnitureSummary(room);
    text += `房间 ${room.id}：${room.type}\n`;
    text += `  尺寸：${room.bbox.w}×${room.bbox.h} 格，面积 ${room.area} 格，位置（第 ${room.bbox.x0 + 1} 列，第 ${room.bbox.y0 + 1} 行）\n`;
    text += `  主要家具：${summary || '无'}\n`;
  }
  if (dwelling.frontDoor) {
    text += `\n入口：${entrySideName(dwelling.frontDoor.outside)}（房间 ${dwelling.frontDoor.a}）\n`;
  }
  return text;
}

// ---------- 页面交互 ----------
let currentDwelling = null;

function readOpts() {
  return {
    size: parseInt(document.getElementById('buildingSize').value, 10),
    roomCount: parseInt(document.getElementById('roomCount').value, 10),
    lShape: parseInt(document.getElementById('lShape').value, 10),
    furnitureDensity: parseInt(document.getElementById('furnitureDensity').value, 10),
  };
}

function syncLabels() {
  document.getElementById('valSize').textContent = document.getElementById('buildingSize').value + ' 格';
  document.getElementById('valRooms').textContent = document.getElementById('roomCount').value;
  document.getElementById('valShape').textContent =
    document.getElementById('lShape').value === '0'
      ? '0%（矩形）'
      : document.getElementById('lShape').value + '%';
  document.getElementById('valFurniture').textContent = document.getElementById('furnitureDensity').value + '%';
}

function generate() {
  const opts = readOpts();
  const seedInput = document.getElementById('seedInput');
  const seedText = seedInput.value.trim();
  let seedNum;
  if (seedText) {
    seedNum = seedNumberFromInput(seedText);
  } else {
    seedNum = Math.floor(Math.random() * 1e9);
    seedInput.value = String(seedNum);
  }

  const dwelling = new Dwelling(opts, seedNum);
  dwelling.generate();
  currentDwelling = dwelling;
  dwelling.seedText = seedInput.value.trim();

  renderDwelling(dwelling, document.getElementById('dwellingCanvas'));
  renderRoomInfo(dwelling, document.getElementById('roomInfo'));
}

function exportPng() {
  const canvas = document.getElementById('dwellingCanvas');
  const link = document.createElement('a');
  link.download = `住所_${document.getElementById('seedInput').value || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportTxt() {
  if (!currentDwelling) return;
  const seed = document.getElementById('seedInput').value || String(currentDwelling.seed);
  const text = buildDwellingText(currentDwelling, seed);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `住所清单_${seed}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const sliderIds = ['buildingSize', 'roomCount', 'lShape', 'furnitureDensity'];
    sliderIds.forEach(id => document.getElementById(id).addEventListener('input', syncLabels));
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

// ---------- Node 测试导出 ----------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mulberry32,
    hashStringToSeed,
    seedNumberFromInput,
    Dwelling,
    generateDwelling,
    buildDwellingText,
    furnitureSummary,
    FURNITURE_DEFS,
    ROOM_TYPES,
    MIN_ROOM_AREA,
    MIN_ROOM_SIDE,
    CELL,
  };
}
