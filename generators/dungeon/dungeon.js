/* =========================================================
 * 中文 TTRPG 地图生成器 - 地牢生成器
 * 算法：随机房间放置 + 最小生成树走廊 + 环形走廊加成
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
function chance(pct) { return rng() * 100 < pct; }
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---------- 单元格类型 ----------
const EMPTY = 0, FLOOR = 1, WALL = 2, DOOR = 3, TRAP = 4, TREASURE = 5;

class Room {
  constructor(id, x, y, w, h) {
    this.id = id; this.x = x; this.y = y; this.w = w; this.h = h;
    this.cx = x + w / 2; this.cy = y + h / 2;
    this.hasTrap = false; this.hasTreasure = false;
  }
  intersects(other, pad = 1) {
    return !(this.x - pad > other.x + other.w ||
             this.x + this.w + pad < other.x ||
             this.y - pad > other.y + other.h ||
             this.y + this.h + pad < other.y);
  }
}

class Dungeon {
  constructor(opts) {
    this.w = opts.w; this.h = opts.h;
    this.opts = opts;
    this.grid = new Array(this.w * this.h).fill(EMPTY);
    this.rooms = [];
  }
  idx(x, y) { return y * this.w + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  get(x, y) { return this.inBounds(x, y) ? this.grid[this.idx(x, y)] : EMPTY; }
  set(x, y, v) { if (this.inBounds(x, y)) this.grid[this.idx(x, y)] = v; }

  carveRoom(room) {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        this.set(x, y, FLOOR);
      }
    }
  }

  placeRooms() {
    const { roomCount, roomMin, roomMax } = this.opts;
    let attempts = 0;
    const maxAttempts = roomCount * 40;
    let id = 1;
    while (this.rooms.length < roomCount && attempts < maxAttempts) {
      attempts++;
      const rw = randInt(roomMin, roomMax);
      const rh = randInt(roomMin, roomMax);
      const rx = randInt(1, this.w - rw - 2);
      const ry = randInt(1, this.h - rh - 2);
      const candidate = new Room(id, rx, ry, rw, rh);
      let overlaps = false;
      for (const r of this.rooms) {
        if (candidate.intersects(r, 1)) { overlaps = true; break; }
      }
      if (!overlaps) {
        this.rooms.push(candidate);
        this.carveRoom(candidate);
        id++;
      }
    }
  }

  // 最小生成树（Prim）连接所有房间中心，保证全连通
  connectRoomsMST() {
    const rooms = this.rooms;
    if (rooms.length <= 1) return [];
    const inTree = new Set([0]);
    const edges = [];
    while (inTree.size < rooms.length) {
      let best = null;
      for (const i of inTree) {
        for (let j = 0; j < rooms.length; j++) {
          if (inTree.has(j)) continue;
          const d = this.dist(rooms[i], rooms[j]);
          if (!best || d < best.d) best = { i, j, d };
        }
      }
      inTree.add(best.j);
      edges.push([best.i, best.j]);
    }
    return edges;
  }

  dist(a, b) {
    return Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
  }

  // 额外环形连接：按距离排序挑一些非树边，增加环路
  extraLoopEdges(treeEdges) {
    const rooms = this.rooms;
    const treeSet = new Set(treeEdges.map(([a, b]) => `${Math.min(a,b)}_${Math.max(a,b)}`));
    const all = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const key = `${i}_${j}`;
        if (treeSet.has(key)) continue;
        all.push([i, j, this.dist(rooms[i], rooms[j])]);
      }
    }
    all.sort((a, b) => a[2] - b[2]);
    const loopCount = Math.round((this.opts.loopiness / 100) * rooms.length);
    return all.slice(0, loopCount).map(e => [e[0], e[1]]);
  }

  carveCorridor(a, b) {
    // L 形走廊：先水平后垂直，或反之（随机决定，视觉更自然）
    let x1 = Math.round(a.cx), y1 = Math.round(a.cy);
    let x2 = Math.round(b.cx), y2 = Math.round(b.cy);
    const horizFirst = chance(50);
    const path = [];
    if (horizFirst) {
      path.push(...this.hLine(x1, x2, y1));
      path.push(...this.vLine(y1, y2, x2));
    } else {
      path.push(...this.vLine(y1, y2, x1));
      path.push(...this.hLine(x1, x2, y2));
    }
    for (let i = 0; i < path.length; i++) {
      const [x, y] = path[i];
      if (this.get(x, y) === EMPTY) this.set(x, y, FLOOR);
      let horizontal = true;
      if (i + 1 < path.length) horizontal = path[i + 1][1] === y;
      else if (i > 0) horizontal = path[i - 1][1] === y;
      if (horizontal) {
        this.tryWiden(x, y - 1, a, b);
        this.tryWiden(x, y + 1, a, b);
      } else {
        this.tryWiden(x - 1, y, a, b);
        this.tryWiden(x + 1, y, a, b);
      }
    }
    // 门：走廊与房间交界处
    this.placeDoorsAlongPath(path, a);
    this.placeDoorsAlongPath(path, b);
  }

  cellInRoom(x, y, room) {
    return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  }

  // 只在不会打穿第三间房的地方把走廊加宽到 2–3 格
  tryWiden(x, y, roomA, roomB) {
    if (!this.inBounds(x, y) || this.get(x, y) !== EMPTY) return;
    const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of near) {
      const nx = x + dx;
      const ny = y + dy;
      for (const room of this.rooms) {
        if (room === roomA || room === roomB) continue;
        if (this.cellInRoom(nx, ny, room)) return;
      }
    }
    this.set(x, y, FLOOR);
  }

  hLine(x1, x2, y) {
    const pts = [];
    const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let x = lo; x <= hi; x++) pts.push([x, y]);
    return pts;
  }
  vLine(y1, y2, x) {
    const pts = [];
    const [lo, hi] = y1 < y2 ? [y1, y2] : [y2, y1];
    for (let y = lo; y <= hi; y++) pts.push([x, y]);
    return pts;
  }

  placeDoorsAlongPath(path, room) {
    for (const [x, y] of path) {
      const onBorder = x === room.x - 1 || x === room.x + room.w ||
                        y === room.y - 1 || y === room.y + room.h;
      if (onBorder) continue;
      const insideRoom = x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
      if (!insideRoom) continue;
    }
    // 简化：在房间边界与走廊的首个交点放门
    for (const [x, y] of path) {
      const edgeX = x === room.x || x === room.x + room.w - 1;
      const edgeY = y === room.y || y === room.y + room.h - 1;
      const insideRoom = x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
      if (insideRoom && (edgeX || edgeY)) {
        if (this.get(x, y) === FLOOR) this.set(x, y, DOOR);
        break;
      }
    }
  }

  addWalls() {
    const dirs = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y) !== EMPTY) continue;
        let adjacentFloor = false;
        for (const [dx, dy] of dirs) {
          const v = this.get(x + dx, y + dy);
          if (v === FLOOR || v === DOOR) { adjacentFloor = true; break; }
        }
        if (adjacentFloor) this.set(x, y, WALL);
      }
    }
  }

  placeFeatures() {
    const { trapChance, treasureChance } = this.opts;
    for (const room of this.rooms) {
      if (chance(trapChance)) {
        const [x, y] = this.randomFloorInRoom(room);
        if (x !== null) { this.set(x, y, TRAP); room.hasTrap = true; }
      }
      if (chance(treasureChance)) {
        const [x, y] = this.randomFloorInRoom(room);
        if (x !== null) { this.set(x, y, TREASURE); room.hasTreasure = true; }
      }
    }
  }

  randomFloorInRoom(room) {
    for (let tries = 0; tries < 20; tries++) {
      const x = randInt(room.x, room.x + room.w - 1);
      const y = randInt(room.y, room.y + room.h - 1);
      if (this.get(x, y) === FLOOR) return [x, y];
    }
    return [null, null];
  }

  generate() {
    this.placeRooms();
    this.rooms.sort((a, b) => a.x - b.x);
    this.rooms.forEach((r, i) => r.id = i + 1);
    const treeEdges = this.connectRoomsMST();
    const loopEdges = this.extraLoopEdges(treeEdges);
    for (const [i, j] of [...treeEdges, ...loopEdges]) {
      this.carveCorridor(this.rooms[i], this.rooms[j]);
    }
    this.addWalls();
    this.placeFeatures();
  }
}

// ---------- 渲染 ----------
const CELL = 16;
const SCALE_PAD = 40;
const FEET_PER_CELL = 5;
const DUNGEON_FONT = '"Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif';

function walkable(v) {
  return v === FLOOR || v === DOOR || v === TRAP || v === TREASURE;
}

function renderDungeon(dungeon, canvas) {
  const mapH = dungeon.h * CELL;
  canvas.width = dungeon.w * CELL;
  canvas.height = mapH + SCALE_PAD;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1b140d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const inRoom = (x, y) => dungeon.rooms.some(r =>
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      const v = dungeon.get(x, y);
      if (v === EMPTY) continue;
      const px = x * CELL;
      const py = y * CELL;
      if (v === WALL) {
        ctx.fillStyle = '#4a3522';
        ctx.fillRect(px, py, CELL, CELL);
        ctx.fillStyle = '#62503a';
        ctx.fillRect(px + 1, py + 1, CELL - 2, 3);
        ctx.fillStyle = 'rgba(20,12,6,0.35)';
        ctx.fillRect(px, py + CELL - 2, CELL, 2);
        continue;
      }
      ctx.fillStyle = inRoom(x, y) ? '#e6d5ad' : '#cbb892';
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = 'rgba(90,69,48,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1.5, py + 1.5, CELL - 3, CELL - 3);
    }
  }

  ctx.strokeStyle = 'rgba(43,32,22,0.45)';
  ctx.lineWidth = 2;
  for (const room of dungeon.rooms) {
    ctx.strokeRect(room.x * CELL + 1, room.y * CELL + 1, room.w * CELL - 2, room.h * CELL - 2);
  }

  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      const v = dungeon.get(x, y);
      if (v === DOOR) drawDoorGlyph(ctx, dungeon, x, y);
      else if (v === TRAP) drawTrapGlyph(ctx, x, y);
      else if (v === TREASURE) drawChestGlyph(ctx, x, y);
    }
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const room of dungeon.rooms) {
    const tx = (room.x + 0.5) * CELL;
    const ty = (room.y + 0.5) * CELL;
    drawDungeonBadge(ctx, tx, ty, String(room.id));
  }

  drawDungeonScale(ctx, mapH);
}

function drawDungeonBadge(ctx, x, y, text) {
  ctx.font = `bold 12px ${DUNGEON_FONT}`;
  const tw = ctx.measureText(text).width;
  const w = Math.max(16, tw + 8);
  const h = 16;
  ctx.fillStyle = 'rgba(255,248,232,0.94)';
  ctx.beginPath();
  ctx.roundRect
    ? ctx.roundRect(x - w / 2, y - h / 2, w, h, 8)
    : ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(43,32,22,0.45)';
  ctx.stroke();
  ctx.fillStyle = '#2b2016';
  ctx.fillText(text, x, y + 0.5);
}

function drawDoorGlyph(ctx, dungeon, x, y) {
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;
  const left = walkable(dungeon.get(x - 1, y));
  const right = walkable(dungeon.get(x + 1, y));
  const up = walkable(dungeon.get(x, y - 1));
  const down = walkable(dungeon.get(x, y + 1));
  const verticalPlank = (left || right) && !(up && down && !left && !right);
  ctx.save();
  ctx.translate(cx, cy);
  if (!verticalPlank) ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#6b4423';
  ctx.fillRect(-3.5, -CELL * 0.62, 7, CELL * 1.24);
  ctx.strokeStyle = '#3a2616';
  ctx.lineWidth = 1;
  ctx.strokeRect(-3.5, -CELL * 0.62, 7, CELL * 1.24);
  ctx.strokeStyle = 'rgba(90,58,32,0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(0, CELL * 0.15, CELL * 0.78, Math.PI * 1.05, Math.PI * 1.85);
  ctx.stroke();
  ctx.restore();
}

function drawTrapGlyph(ctx, x, y) {
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;
  const r = CELL * 0.95;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f8e7cf';
  ctx.fill();
  ctx.strokeStyle = '#8a2c22';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.5);
  ctx.lineTo(cx - r * 0.48, cy + r * 0.38);
  ctx.lineTo(cx + r * 0.48, cy + r * 0.38);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.16, 1.3, 0, Math.PI * 2);
  ctx.fillStyle = '#8a2c22';
  ctx.fill();
}

function drawChestGlyph(ctx, x, y) {
  const cx = x * CELL + CELL / 2;
  const cy = y * CELL + CELL / 2;
  const r = CELL * 0.98;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#f8e7cf';
  ctx.fill();
  ctx.strokeStyle = '#8a6a2f';
  ctx.lineWidth = 2;
  ctx.stroke();
  const w = r * 1.15;
  const h = r * 0.78;
  ctx.fillStyle = '#a9743a';
  ctx.fillRect(cx - w / 2, cy - h / 2 + 1, w, h);
  ctx.strokeStyle = '#5c3d1e';
  ctx.lineWidth = 1.3;
  ctx.strokeRect(cx - w / 2, cy - h / 2 + 1, w, h);
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy);
  ctx.lineTo(cx + w / 2, cy);
  ctx.stroke();
  ctx.fillStyle = '#e6c35c';
  ctx.fillRect(cx - 2, cy - 2, 4, 5);
}

function drawDungeonScale(ctx, mapH) {
  const cells = 4;
  const bar = cells * CELL;
  const x = 16;
  const y = mapH + 24;
  ctx.fillStyle = 'rgba(243,233,207,0.95)';
  ctx.fillRect(8, mapH + 8, bar + 108, 26);
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
  ctx.font = `12px ${DUNGEON_FONT}`;
  ctx.fillStyle = '#2b2016';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${cells * FEET_PER_CELL} 尺`, x + bar + 8, y);
}

function renderRoomInfo(dungeon, container) {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.innerHTML = `<strong>共 ${dungeon.rooms.length} 个房间 · 1 格 = 5 尺</strong>`;
  container.appendChild(title);
  for (const room of dungeon.rooms) {
    const div = document.createElement('div');
    const tags = [];
    if (room.hasTrap) tags.push('⚠ 陷阱');
    if (room.hasTreasure) tags.push('💰 宝藏');
    div.textContent = `房间 ${room.id}：${room.w}×${room.h} 格${tags.length ? '　' + tags.join(' ') : ''}`;
    container.appendChild(div);
  }
}

// ---------- 页面交互 ----------
let currentDungeon = null;

function readOpts() {
  return {
    w: parseInt(document.getElementById('gridW').value, 10),
    h: parseInt(document.getElementById('gridH').value, 10),
    roomCount: parseInt(document.getElementById('roomCount').value, 10),
    roomMin: parseInt(document.getElementById('roomMin').value, 10),
    roomMax: parseInt(document.getElementById('roomMax').value, 10),
    loopiness: parseInt(document.getElementById('loopiness').value, 10),
    trapChance: parseInt(document.getElementById('trapChance').value, 10),
    treasureChance: parseInt(document.getElementById('treasureChance').value, 10),
  };
}

function syncLabels() {
  document.getElementById('valW').textContent = document.getElementById('gridW').value;
  document.getElementById('valH').textContent = document.getElementById('gridH').value;
  document.getElementById('valRooms').textContent = document.getElementById('roomCount').value;
  document.getElementById('valMin').textContent = document.getElementById('roomMin').value;
  document.getElementById('valMax').textContent = document.getElementById('roomMax').value;
  document.getElementById('valLoop').textContent = document.getElementById('loopiness').value + '%';
  document.getElementById('valTrap').textContent = document.getElementById('trapChance').value + '%';
  document.getElementById('valTreasure').textContent = document.getElementById('treasureChance').value + '%';
}

function generate() {
  const opts = readOpts();
  if (opts.roomMin > opts.roomMax) opts.roomMax = opts.roomMin;

  const seedText = document.getElementById('seedInput').value.trim();
  let seedNum;
  if (seedText) {
    seedNum = /^\d+$/.test(seedText) ? parseInt(seedText, 10) : hashStringToSeed(seedText);
  } else {
    seedNum = Math.floor(Math.random() * 1e9);
    document.getElementById('seedInput').value = String(seedNum);
  }
  rng = mulberry32(seedNum);

  const dungeon = new Dungeon(opts);
  dungeon.generate();
  currentDungeon = dungeon;

  const canvas = document.getElementById('dungeonCanvas');
  renderDungeon(dungeon, canvas);
  renderRoomInfo(dungeon, document.getElementById('roomInfo'));
}

function exportPng() {
  const canvas = document.getElementById('dungeonCanvas');
  const link = document.createElement('a');
  link.download = `地牢_${document.getElementById('seedInput').value || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportTxt() {
  if (!currentDungeon) return;
  let text = `地牢清单（种子：${document.getElementById('seedInput').value}）\n`;
  text += `网格：${currentDungeon.w} × ${currentDungeon.h}　房间数：${currentDungeon.rooms.length}\n\n`;
  for (const room of currentDungeon.rooms) {
    const tags = [];
    if (room.hasTrap) tags.push('陷阱');
    if (room.hasTreasure) tags.push('宝藏');
    text += `房间 ${room.id}：尺寸 ${room.w}×${room.h}，位置 (${room.x}, ${room.y})${tags.length ? '，含：' + tags.join('、') : ''}\n`;
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.download = `地牢清单_${document.getElementById('seedInput').value || 'random'}.txt`;
  link.href = URL.createObjectURL(blob);
  link.click();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Dungeon,
    mulberry32,
    hashStringToSeed,
    EMPTY,
    FLOOR,
    WALL,
    DOOR,
    TRAP,
    TREASURE,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
window.addEventListener('DOMContentLoaded', () => {
  const sliderIds = ['gridW','gridH','roomCount','roomMin','roomMax','loopiness','trapChance','treasureChance'];
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
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (currentDungeon) renderDungeon(currentDungeon, document.getElementById('dungeonCanvas'));
    });
  }
});
}
