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
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// 房间旁注：只用字库里有的字，保证画布上不会缺字
const DUNGEON_HOOKS = [
  '箱中藏着小宝物。',
  '东侧有一扇重木门。',
  '池底沉着一件铁器。',
  '顶上绘着树纹。',
  '木箱里藏着小宝物。',
  '一只木像，一触便发声。',
  '半身人坐在地上，身边散着宝石。',
  '角落里坐着一个兜面人。',
  '墙上绘着浅色符文。',
  '铁器空立室中，像在等人。',
  '石台上留着已尽的烛。',
  '地板之下有细小动静。',
  '墙上挂着一块绘纹的破布。',
  '深池不见其底，只余回声。',
  '书架散了，书页上结着霜。',
  '铁栏之中空无一人，锁却完好。',
  '壁画上的目像在看着人。',
  '一具石盒，盖移开了一道缝。',
  '楼梯向下，通向更深处。',
  '这里是地牢的后入口。',
  '地上留着一块深色。',
  '墙角放着破碎的木板。',
  '桌上留着残缺的地图。',
  '绳索从顶上垂下。',
  '室中安静，只有水声。',
  '一座小台，供着无名的像。',
  '通道到这里便变窄。',
  '地板上盖着布，下面是陷阱。',
  '宝箱半藏在碎石后。',
  '墙上藏着一道隐门。',
  '墙上的烛已经点尽。',
  '一排空牢，门却都开着。',
  '喷泉已干，池底有小宝物。',
  '盆中水面映出另一张面。',
  '地板松动，下面是空的。',
  '角落里结着密网。',
  '墙缝里有细小的动静。',
  '门上留着字：不可入。',
  '室中央有一个圆池。',
  '北侧有一段楼梯。',
];

// ---------- 单元格类型 ----------
const EMPTY = 0, FLOOR = 1, WALL = 2, DOOR = 3, TRAP = 4, TREASURE = 5;

class Room {
  constructor(id, x, y, w, h) {
    this.id = id; this.x = x; this.y = y; this.w = w; this.h = h;
    this.cx = x + w / 2; this.cy = y + h / 2;
    this.hasTrap = false; this.hasTreasure = false;
    this.shape = 'rect';
    this.hook = '';
    this.hasStairs = false;
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
    this.markEnds();
    this.applyShapeVariety();
    this.placeFeatures();
    this.assignFlavor();
  }

  isWalkable(x, y) {
    const v = this.get(x, y);
    return v === FLOOR || v === DOOR || v === TRAP || v === TREASURE;
  }

  walkableCellInRoom(room) {
    const cx = Math.min(room.x + room.w - 1, Math.max(room.x, Math.floor(room.cx)));
    const cy = Math.min(room.y + room.h - 1, Math.max(room.y, Math.floor(room.cy)));
    if (this.isWalkable(cx, cy)) return [cx, cy];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (this.isWalkable(x, y)) return [x, y];
      }
    }
    return null;
  }

  allRoomsReachable() {
    if (!this.rooms.length) return true;
    const entrance = this.rooms.find(r => r.id === this.entranceId) || this.rooms[0];
    const start = this.walkableCellInRoom(entrance);
    if (!start) return false;
    const seen = new Uint8Array(this.w * this.h);
    const q = [start];
    seen[start[1] * this.w + start[0]] = 1;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const i = ny * this.w + nx;
        if (seen[i] || !this.isWalkable(nx, ny)) continue;
        seen[i] = 1;
        q.push([nx, ny]);
      }
    }
    for (const room of this.rooms) {
      const cell = this.walkableCellInRoom(room);
      if (!cell || !seen[cell[1] * this.w + cell[0]]) return false;
    }
    return true;
  }

  touchesOutsideWalkable(x, y, room) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= room.x && nx < room.x + room.w && ny >= room.y && ny < room.y + room.h) continue;
      if (this.isWalkable(nx, ny)) return true;
    }
    return false;
  }

  // 把近似正方形的房间切成圆室；切完若走不通就还原，不破坏连通
  carveCircle(room) {
    const cx = room.x + room.w / 2;
    const cy = room.y + room.h / 2;
    const rad = Math.min(room.w, room.h) / 2 - 0.08;
    const cleared = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        const v = this.get(x, y);
        if (v !== FLOOR && v !== DOOR) continue;
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad) continue;
        if (this.touchesOutsideWalkable(x, y, room)) continue;
        cleared.push([x, y, v]);
        this.set(x, y, EMPTY);
      }
    }
    return cleared;
  }

  refreshWalls() {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === WALL) this.grid[i] = EMPTY;
    }
    this.addWalls();
  }

  applyShapeVariety() {
    for (const room of this.rooms) room.shape = 'rect';
    for (const room of this.rooms) {
      if (Math.abs(room.w - room.h) > 1 || Math.min(room.w, room.h) < 6) continue;
      if (!chance(48)) continue;
      const cleared = this.carveCircle(room);
      if (!cleared.length) continue;
      this.refreshWalls();
      if (this.allRoomsReachable()) {
        room.shape = 'circle';
      } else {
        for (const [x, y, v] of cleared) this.set(x, y, v);
        this.refreshWalls();
      }
    }
  }

  // 给一部分房间写一句地点注记；入口和出口必定有
  assignFlavor() {
    for (const room of this.rooms) {
      room.hook = '';
      room.hasStairs = room.id === this.entranceId || room.id === this.exitId;
    }
    if (!this.rooms.length) return;

    const chosen = [];
    const add = (room) => {
      if (room && !chosen.includes(room)) chosen.push(room);
    };
    add(this.rooms.find(r => r.id === this.entranceId));
    add(this.rooms.find(r => r.id === this.exitId));

    const pool = this.rooms.filter(r => !chosen.includes(r));
    shuffleInPlace(pool);
    const scored = pool.map((room, i) => ({
      room,
      score: (room.hasTreasure ? 2 : 0) + (room.hasTrap ? 1 : 0),
      i,
    }));
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const cap = Math.min(8, Math.max(chosen.length, Math.round(this.rooms.length * 0.5)));
    for (const item of scored) {
      if (chosen.length >= cap) break;
      add(item.room);
    }

    const hooks = DUNGEON_HOOKS.slice();
    shuffleInPlace(hooks);
    chosen.forEach((room, i) => { room.hook = hooks[i % hooks.length]; });

    let extraStairs = 0;
    for (const room of this.rooms) {
      if (extraStairs >= 2) break;
      if (room.hasStairs) continue;
      const stairRoom = room.shape === 'circle' || (room.w >= 5 && room.h >= 5 && chance(40));
      if (!stairRoom) continue;
      room.hasStairs = true;
      extraStairs++;
    }
  }

  // 不消耗随机数：入口取最靠左上的房间，出口取离入口最远的房间
  markEnds() {
    if (!this.rooms.length) {
      this.entranceId = 0;
      this.exitId = 0;
      return;
    }
    let entrance = this.rooms[0];
    for (const room of this.rooms) {
      if (room.y + room.x * 0.15 < entrance.y + entrance.x * 0.15) entrance = room;
    }
    let exit = entrance;
    let best = -1;
    for (const room of this.rooms) {
      const d = Math.hypot(room.cx - entrance.cx, room.cy - entrance.cy);
      if (room !== entrance && d > best) { best = d; exit = room; }
    }
    this.entranceId = entrance.id;
    this.exitId = exit.id;
  }
}

// ---------- 渲染 ----------
const CELL = 16;
const FEET_PER_CELL = 5;
const CALL_W = 204;
const PAD_X = CALL_W + 22;
const PAD_Y = 16;
const DUNGEON_FONT = '"Noto Serif SC", "Songti SC", "Noto Serif CJK SC", serif';

function walkable(v) {
  return v === FLOOR || v === DOOR || v === TRAP || v === TREASURE;
}

function cellHash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function isRockCell(dungeon, x, y) {
  if (!dungeon.inBounds(x, y)) return false;
  const v = dungeon.get(x, y);
  if (v !== EMPTY && v !== WALL) return false;
  const reach = 2 + (cellHash(x, y) % 4);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > reach) continue;
      if (dungeon.isWalkable(x + dx, y + dy)) return true;
    }
  }
  return false;
}

function drawRockHatch(ctx, dungeon) {
  const mask = new Uint8Array(dungeon.w * dungeon.h);
  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      if (isRockCell(dungeon, x, y)) mask[y * dungeon.w + x] = 1;
    }
  }
  const rockAt = (px, py) => {
    if (px < 0 || py < 0 || px >= dungeon.w * CELL || py >= dungeon.h * CELL) return false;
    const cx = Math.min(dungeon.w - 1, Math.floor(px / CELL));
    const cy = Math.min(dungeon.h - 1, Math.floor(py / CELL));
    return mask[cy * dungeon.w + cx] === 1;
  };
  ctx.save();
  ctx.strokeStyle = 'rgba(48, 36, 24, 0.66)';
  ctx.lineWidth = 0.85;
  ctx.beginPath();
  const w = dungeon.w * CELL;
  const h = dungeon.h * CELL;
  const gap = 3.5;
  const sample = 2;
  const trace = (yAt) => {
    for (let b = -w; b < h + w; b += gap) {
      let pen = false;
      let lastX = 0;
      let lastY = 0;
      for (let x = 0; x <= w; x += sample) {
        const y = yAt(x, b);
        const inside = y >= 0 && y < h && rockAt(Math.min(x, w - 0.5), y);
        if (inside) {
          if (!pen) { ctx.moveTo(x, y); pen = true; }
          lastX = x;
          lastY = y;
        } else if (pen) {
          ctx.lineTo(lastX, lastY);
          pen = false;
        }
      }
      if (pen) ctx.lineTo(lastX, lastY);
    }
  };
  trace((x, b) => x + b);
  trace((x, b) => -x + b);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = 'rgba(42, 30, 18, 0.5)';
  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      if (!mask[y * dungeon.w + x]) continue;
      const hsh = cellHash(x, y);
      if (hsh % 11 !== 0) continue;
      const px = x * CELL + (hsh % 8);
      const py = y * CELL + ((hsh >>> 4) % 8);
      ctx.moveTo(px, py);
      ctx.lineTo(px + 5, py + 1.2);
      ctx.lineTo(px + 1.4, py + 4.5);
      ctx.closePath();
    }
  }
  ctx.fill();
  ctx.restore();
}

function drawFloors(ctx, dungeon) {
  ctx.fillStyle = '#f6efe0';
  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      if (!dungeon.isWalkable(x, y)) continue;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = 'rgba(78, 58, 36, 0.38)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  const edgeOn = (x, y, vertical) => {
    if (vertical) return dungeon.isWalkable(x, y) || dungeon.isWalkable(x - 1, y);
    return dungeon.isWalkable(x, y) || dungeon.isWalkable(x, y - 1);
  };
  for (let x = 0; x <= dungeon.w; x++) {
    let y = 0;
    while (y < dungeon.h) {
      if (!edgeOn(x, y, true)) { y++; continue; }
      const y0 = y;
      while (y < dungeon.h && edgeOn(x, y, true)) y++;
      ctx.moveTo(x * CELL + 0.5, y0 * CELL);
      ctx.lineTo(x * CELL + 0.5, y * CELL);
    }
  }
  for (let y = 0; y <= dungeon.h; y++) {
    let x = 0;
    while (x < dungeon.w) {
      if (!edgeOn(x, y, false)) { x++; continue; }
      const x0 = x;
      while (x < dungeon.w && edgeOn(x, y, false)) x++;
      ctx.moveTo(x0 * CELL, y * CELL + 0.5);
      ctx.lineTo(x * CELL, y * CELL + 0.5);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawInkOutline(ctx, dungeon) {
  ctx.beginPath();
  ctx.lineWidth = 2.3;
  ctx.strokeStyle = '#241910';
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      if (!dungeon.isWalkable(x, y)) continue;
      const px = x * CELL;
      const py = y * CELL;
      if (!dungeon.isWalkable(x, y - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + CELL, py); }
      if (!dungeon.isWalkable(x, y + 1)) { ctx.moveTo(px, py + CELL); ctx.lineTo(px + CELL, py + CELL); }
      if (!dungeon.isWalkable(x - 1, y)) { ctx.moveTo(px, py); ctx.lineTo(px, py + CELL); }
      if (!dungeon.isWalkable(x + 1, y)) { ctx.moveTo(px + CELL, py); ctx.lineTo(px + CELL, py + CELL); }
    }
  }
  ctx.stroke();
}

function drawStairsGlyph(ctx, x, y, vertical, color) {
  ctx.save();
  ctx.translate(x, y);
  if (vertical) ctx.rotate(Math.PI / 2);
  ctx.strokeStyle = color || '#2b2016';
  ctx.lineWidth = 1.45;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-8, i * 3.1);
    ctx.lineTo(8, i * 3.1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawExtraStairs(ctx, dungeon) {
  for (const room of dungeon.rooms) {
    if (!room.hasStairs) continue;
    if (room.id === dungeon.entranceId || room.id === dungeon.exitId) continue;
    const x = room.cx * CELL;
    const y = room.shape === 'circle'
      ? (room.cy + Math.min(room.w, room.h) * 0.22) * CELL
      : (room.y + room.h - 1.15) * CELL;
    drawStairsGlyph(ctx, x, y, false, '#2b2016');
  }
}

function drawPaperGrain(ctx, w, h, seed) {
  const rand = mulberry32(seed || 1);
  ctx.save();
  for (let i = 0; i < 1100; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const a = 0.025 + rand() * 0.045;
    ctx.fillStyle = `rgba(92, 70, 42, ${a})`;
    ctx.fillRect(x, y, rand() > 0.82 ? 1.6 : 1, 1);
  }
  ctx.restore();
}

function dungeonPaintSeed(dungeon) {
  let h = 2166136261;
  h ^= dungeon.w;
  h = Math.imul(h, 16777619);
  h ^= dungeon.h;
  h = Math.imul(h, 16777619);
  for (const room of dungeon.rooms) {
    h ^= room.x + room.y * 131 + room.w * 17 + room.id * 911;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function wrapCjk(text, size) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    if (cur.length >= size) {
      lines.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  if (lines.length >= 2 && lines[lines.length - 1].length <= 1) {
    const prev = lines[lines.length - 2];
    lines[lines.length - 2] = prev.slice(0, -1);
    lines[lines.length - 1] = prev.slice(-1) + lines[lines.length - 1];
  }
  return lines.length ? lines : [''];
}

function layoutCallouts(dungeon, mapW, mapH) {
  const hooked = dungeon.rooms.filter(r => r.hook);
  const left = [];
  const right = [];
  for (const room of hooked) (room.cx < dungeon.w / 2 ? left : right).push(room);
  const moveClosest = (from, to) => {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < from.length; i++) {
      const d = Math.abs(from[i].cx - dungeon.w / 2);
      if (d < best) { best = d; idx = i; }
    }
    to.push(from.splice(idx, 1)[0]);
  };
  while (left.length > right.length + 2) moveClosest(left, right);
  while (right.length > left.length + 2) moveClosest(right, left);

  const placeSide = (rooms, side) => {
    rooms.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    const prepared = rooms.map(room => {
      const lines = wrapCjk(`${room.id}. ${room.hook}`, 14);
      return { room, lines, side, h: lines.length * 16 + 14, w: CALL_W };
    });
    const gap = 8;
    const total = prepared.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, prepared.length - 1);
    let y = PAD_Y + Math.max(0, (mapH - total) / 2);
    if (y < 12) y = 12;
    const x = side === 'left' ? 12 : PAD_X + mapW + 16;
    for (const b of prepared) {
      b.x = x;
      b.y = y;
      y += b.h + gap;
    }
    return prepared;
  };
  return placeSide(left, 'left').concat(placeSide(right, 'right'));
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

function drawCalloutBoxes(ctx, boxes) {
  for (const b of boxes) {
    const edgeX = b.side === 'left'
      ? PAD_X + b.room.x * CELL
      : PAD_X + (b.room.x + b.room.w) * CELL;
    const edgeY = PAD_Y + b.room.cy * CELL;
    const x1 = b.side === 'left' ? b.x + b.w : b.x;
    const y1 = b.y + Math.min(b.h / 2, 18);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(edgeX, edgeY);
    ctx.strokeStyle = 'rgba(36, 28, 20, 0.72)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(edgeX, edgeY, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#241910';
    ctx.fill();
  }
  for (const b of boxes) {
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 2);
    ctx.fillStyle = 'rgba(255, 251, 242, 0.97)';
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = '#2b2016';
    ctx.stroke();
    ctx.font = `13px ${DUNGEON_FONT}`;
    ctx.fillStyle = '#2b2016';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    b.lines.forEach((line, i) => {
      ctx.fillText(line, b.x + 8, b.y + 13 + i * 16);
    });
  }
}

function renderDungeon(dungeon, canvas) {
  const mapW = dungeon.w * CELL;
  const mapH = dungeon.h * CELL;
  const boxes = layoutCallouts(dungeon, mapW, mapH);
  let maxY = PAD_Y + mapH;
  for (const b of boxes) maxY = Math.max(maxY, b.y + b.h);
  canvas.width = PAD_X + mapW + PAD_X;
  canvas.height = maxY + 18 + 36;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f3ead6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawPaperGrain(ctx, canvas.width, canvas.height, dungeonPaintSeed(dungeon));

  ctx.save();
  ctx.translate(PAD_X, PAD_Y);
  drawRockHatch(ctx, dungeon);
  drawFloors(ctx, dungeon);
  drawInkOutline(ctx, dungeon);
  for (let y = 0; y < dungeon.h; y++) {
    for (let x = 0; x < dungeon.w; x++) {
      const v = dungeon.get(x, y);
      if (v === DOOR) drawDoorGlyph(ctx, dungeon, x, y);
      else if (v === TRAP) drawTrapGlyph(ctx, x, y);
      else if (v === TREASURE) drawChestGlyph(ctx, x, y);
    }
  }
  drawExtraStairs(ctx, dungeon);
  for (const room of dungeon.rooms) {
    if (room.id === dungeon.entranceId) drawDungeonEnd(ctx, dungeon, room, '入口', '#2f6b3a');
    else if (room.id === dungeon.exitId) drawDungeonEnd(ctx, dungeon, room, '出口', '#8a2c22');
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const room of dungeon.rooms) {
    const tx = (room.x + (room.w <= 4 ? room.w / 2 : 0.75)) * CELL;
    const ty = (room.y + (room.h <= 4 ? room.h / 2 : 0.75)) * CELL;
    drawDungeonBadge(ctx, tx, ty, String(room.id));
  }
  ctx.restore();

  drawCalloutBoxes(ctx, boxes);
  drawDungeonScale(ctx, canvas.height);
}

function nearestMapSide(dungeon, room) {
  const scores = [
    ['left', room.x],
    ['right', dungeon.w - (room.x + room.w)],
    ['top', room.y],
    ['bottom', dungeon.h - (room.y + room.h)],
  ];
  scores.sort((a, b) => a[1] - b[1]);
  return scores[0][0];
}

function drawDungeonEnd(ctx, dungeon, room, label, color) {
  const side = nearestMapSide(dungeon, room);
  const cx = room.cx * CELL;
  const cy = room.cy * CELL;
  let x1 = cx;
  let y1 = cy;
  let x2 = cx;
  let y2 = cy;
  if (side === 'left') { x1 = 10; x2 = room.x * CELL + 2; y1 = y2 = (room.y + 1.2) * CELL; }
  else if (side === 'right') { x1 = dungeon.w * CELL - 10; x2 = (room.x + room.w) * CELL - 2; y1 = y2 = (room.y + 1.2) * CELL; }
  else if (side === 'top') { y1 = 10; y2 = room.y * CELL + 2; x1 = x2 = (room.x + 1.2) * CELL; }
  else { y1 = dungeon.h * CELL - 8; y2 = (room.y + room.h) * CELL - 2; x1 = x2 = (room.x + 1.2) * CELL; }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(ang - 0.45) * 10, y2 - Math.sin(ang - 0.45) * 10);
  ctx.lineTo(x2 - Math.cos(ang + 0.45) * 10, y2 - Math.sin(ang + 0.45) * 10);
  ctx.closePath();
  ctx.fill();

  // 楼梯画在房间靠外的一侧，和编号错开
  const sx = side === 'left' ? (room.x + 1.4) * CELL : side === 'right' ? (room.x + room.w - 1.4) * CELL : cx;
  const sy = side === 'top' ? (room.y + 1.4) * CELL : side === 'bottom' ? (room.y + room.h - 1.4) * CELL : (room.y + room.h - 1.3) * CELL;
  ctx.translate(sx, sy);
  if (side === 'left' || side === 'right') ctx.rotate(Math.PI / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-7, i * 3.1);
    ctx.lineTo(7, i * 3.1);
    ctx.stroke();
  }

  ctx.restore();

  ctx.save();
  ctx.font = `bold 12px ${DUNGEON_FONT}`;
  const tw = ctx.measureText(label).width;
  let lx = side === 'left' || side === 'right' ? x1 : x2;
  let ly = side === 'top' || side === 'bottom' ? y1 : y2 - 16;
  if (side === 'left') { lx = 8 + tw / 2; ly = y1 - 14; }
  if (side === 'right') { lx = dungeon.w * CELL - 8 - tw / 2; ly = y1 - 14; }
  if (side === 'top') ly = 14;
  if (side === 'bottom') ly = dungeon.h * CELL - 14;
  lx = Math.max(8 + tw / 2, Math.min(dungeon.w * CELL - 8 - tw / 2, lx));
  ly = Math.max(12, Math.min(dungeon.h * CELL - 12, ly));
  ctx.fillStyle = 'rgba(255,248,232,0.96)';
  ctx.fillRect(lx - tw / 2 - 5, ly - 9, tw + 10, 18);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(lx - tw / 2 - 5, ly - 9, tw + 10, 18);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, lx, ly);
  ctx.restore();
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
  const px = x * CELL;
  const py = y * CELL;
  const left = walkable(dungeon.get(x - 1, y));
  const right = walkable(dungeon.get(x + 1, y));
  const acrossHorizontal = left || right;
  ctx.fillStyle = '#f3e6c8';
  ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
  ctx.save();
  ctx.translate(px + CELL / 2, py + CELL / 2);
  if (!acrossHorizontal) ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#3a2616';
  ctx.fillRect(-CELL * 0.5, -2.4, CELL, 4.8);
  ctx.strokeStyle = '#8a5a2b';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-CELL * 0.46, 0);
  ctx.lineTo(-CELL * 0.08, -CELL * 0.72);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(43,32,22,0.7)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-CELL * 0.46, 0);
  ctx.arc(-CELL * 0.46, 0, CELL * 0.72, -Math.PI / 2, -0.15);
  ctx.stroke();
  ctx.fillStyle = '#2b2016';
  ctx.beginPath();
  ctx.arc(-CELL * 0.46, 0, 2.4, 0, Math.PI * 2);
  ctx.fill();
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

function drawDungeonScale(ctx, canvasH) {
  const cells = 4;
  const bar = cells * CELL;
  const x = 28;
  const y = canvasH - 20;
  ctx.fillStyle = 'rgba(255,248,232,0.94)';
  ctx.fillRect(x - 12, y - 14, bar + 86, 26);
  ctx.strokeStyle = '#2b2016';
  ctx.lineWidth = 1.3;
  ctx.strokeRect(x - 12, y - 14, bar + 86, 26);
  ctx.lineWidth = 1.8;
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
    if (room.id === dungeon.entranceId) tags.push('入口');
    if (room.id === dungeon.exitId) tags.push('出口');
    if (room.shape === 'circle') tags.push('圆形');
    if (room.hasStairs) tags.push('楼梯');
    if (room.hasTrap) tags.push('陷阱');
    if (room.hasTreasure) tags.push('宝藏');
    const hook = room.hook ? `　${room.hook}` : '';
    div.textContent = `房间 ${room.id}：${room.w}×${room.h} 格${tags.length ? '　' + tags.join(' ') : ''}${hook}`;
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
  currentDungeon = createDungeon(opts, seedNum);

  const canvas = document.getElementById('dungeonCanvas');
  renderDungeon(currentDungeon, canvas);
  renderRoomInfo(currentDungeon, document.getElementById('roomInfo'));
}

function exportPng() {
  const canvas = document.getElementById('dungeonCanvas');
  const link = document.createElement('a');
  link.download = `地牢_${document.getElementById('seedInput').value || 'random'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function buildDungeonText(dungeon, seedText) {
  let text = `地牢清单（种子：${seedText}）\n`;
  text += `网格：${dungeon.w} × ${dungeon.h}　房间数：${dungeon.rooms.length}\n\n`;
  for (const room of dungeon.rooms) {
    const tags = [];
    if (room.id === dungeon.entranceId) tags.push('入口');
    if (room.id === dungeon.exitId) tags.push('出口');
    if (room.shape === 'circle') tags.push('圆形');
    if (room.hasStairs) tags.push('楼梯');
    if (room.hasTrap) tags.push('陷阱');
    if (room.hasTreasure) tags.push('宝藏');
    text += `房间 ${room.id}：尺寸 ${room.w}×${room.h}，位置 (${room.x}, ${room.y})`;
    if (tags.length) text += '，含：' + tags.join('、');
    if (room.hook) text += `\n    ${room.hook}`;
    text += '\n';
  }
  return text;
}

function createDungeon(opts, seed) {
  rng = mulberry32(seed >>> 0);
  const dungeon = new Dungeon(opts);
  dungeon.generate();
  return dungeon;
}

function exportTxt() {
  if (!currentDungeon) return;
  const text = buildDungeonText(currentDungeon, document.getElementById('seedInput').value || 'random');
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
    DUNGEON_HOOKS,
    createDungeon,
    buildDungeonText,
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
