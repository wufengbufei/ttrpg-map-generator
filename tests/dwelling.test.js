/* =========================================================
 * 住所生成器 Node 冒烟测试
 * 运行：node tests/dwelling.test.js
 *
 * 覆盖：
 *  1. mulberry32 / hashStringToSeed 与参考实现一致
 *  2. 相同种子（数字 / 字符串）生成结果完全一致
 *  3. 参数矩阵下生成不报错
 *  4. 房间互不重叠、完整覆盖建筑轮廓、每个房间连通
 *  5. 所有房间经门连通，门的坐标确实落在房间边界上
 *  6. 家具不越界、不重叠、不堵门
 *  7. TXT 清单包含房间编号、类型与家具
 *
 * 注意：Canvas 渲染依赖浏览器环境，不在 Node 冒烟测试范围内。
 * ========================================================= */
'use strict';

const assert = require('assert');
const path = require('path');
const D = require(path.join(__dirname, '..', 'generators', 'dwelling', 'dwelling.js'));

const {
  generateDwelling,
  hashStringToSeed,
  mulberry32,
  seedNumberFromInput,
  buildDwellingText,
  FURNITURE_DEFS,
  ROOM_TYPES,
  MIN_ROOM_AREA,
  MIN_ROOM_SIDE,
} = D;

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n【${title}】`);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err && err.message ? err.message : err}`);
  }
}

// ---------- 测试用参考实现（与 dungeon.js 相同算法） ----------
function refMulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function refHash(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------- 校验工具 ----------
function isConnected(cells, w) {
  if (cells.size === 0) return false;
  const first = cells.values().next().value;
  const seen = new Set([first]);
  const queue = [first];
  while (queue.length) {
    const idx = queue.pop();
    const x = idx % w;
    const y = (idx / w) | 0;
    const neighbors = [
      x > 0 && idx - 1,
      x < w - 1 && idx + 1,
      y > 0 && idx - w,
      idx + w,
    ];
    for (const n of neighbors) {
      if (n !== false && n >= 0 && cells.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen.size === cells.size;
}

function adjacentDoorCells(dwell, door) {
  if (door.orient === 'v') {
    return [{ x: door.x - 1, y: door.y }, { x: door.x, y: door.y }];
  }
  return [{ x: door.x, y: door.y - 1 }, { x: door.x, y: door.y }];
}

function cellIdx(dwell, x, y) {
  if (x < 0 || y < 0 || x >= dwell.w || y >= dwell.h) return -1;
  return y * dwell.w + x;
}

const FURNITURE_LABELS = new Set(Object.keys(FURNITURE_DEFS).map(k => FURNITURE_DEFS[k].label));

function validateDwelling(dwell, label) {
  const prefix = label ? `${label}：` : '';
  assert(dwell.rooms.length >= 1, `${prefix}没有生成任何房间`);
  assert(dwell.rooms.length <= dwell.opts.roomCount, `${prefix}房间数超过参数上限`);
  assert.strictEqual(dwell.connected, true, `${prefix}门图不连通`);

  const ownerById = new Map();
  const occupied = new Map();
  let totalRoomCells = 0;

  for (const room of dwell.rooms) {
    assert(room.id >= 1, `${prefix}房间编号非法`);
    assert(!ownerById.has(room.id), `${prefix}房间编号重复：${room.id}`);
    ownerById.set(room.id, room);
    assert(ROOM_TYPES[room.type], `${prefix}未知房间类型：${room.type}`);
    assert.strictEqual(room.area, room.cells.size, `${prefix}房间 ${room.id} area 字段不一致`);
    assert(room.area >= MIN_ROOM_AREA,
      `${prefix}房间 ${room.id} 面积 ${room.area} 小于下限 ${MIN_ROOM_AREA}`);
    assert(room.bbox.w >= MIN_ROOM_SIDE && room.bbox.h >= MIN_ROOM_SIDE,
      `${prefix}房间 ${room.id} 包围盒过窄`);
    assert(room.cells.has(room.labelCell), `${prefix}房间 ${room.id} 标签格不在房间内`);
    assert(isConnected(room.cells, dwell.w), `${prefix}房间 ${room.id} 的格子不连通`);

    // 包围盒必须真实包住房间
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const idx of room.cells) {
      assert(idx >= 0 && idx < dwell.w * dwell.h, `${prefix}房间 ${room.id} 格索引越界`);
      assert(dwell.footprint.has(idx), `${prefix}房间 ${room.id} 占用了轮廓外的格子`);
      assert(!occupied.has(idx),
        `${prefix}房间 ${room.id} 与房间 ${occupied.get(idx)} 重叠于 ${idx}`);
      occupied.set(idx, room.id);
      assert.strictEqual(dwell.owner[idx], room.id,
        `${prefix}owner 映射与房间 ${room.id} 不一致`);
      const x = idx % dwell.w;
      const y = (idx / dwell.w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      totalRoomCells++;
    }
    assert.strictEqual(minX, room.bbox.x0, `${prefix}房间 ${room.id} bbox.x0 不准确`);
    assert.strictEqual(minY, room.bbox.y0, `${prefix}房间 ${room.id} bbox.y0 不准确`);
    assert.strictEqual(maxX, room.bbox.x1, `${prefix}房间 ${room.id} bbox.x1 不准确`);
    assert.strictEqual(maxY, room.bbox.y1, `${prefix}房间 ${room.id} bbox.y1 不准确`);
    assert.strictEqual(room.bbox.w, maxX - minX + 1, `${prefix}房间 ${room.id} bbox 宽度不准确`);
    assert.strictEqual(room.bbox.h, maxY - minY + 1, `${prefix}房间 ${room.id} bbox 高度不准确`);
  }

  assert.strictEqual(totalRoomCells, dwell.footprint.size,
    `${prefix}房间没有完整覆盖建筑轮廓`);
  for (const idx of dwell.footprint) {
    assert(occupied.has(idx), `${prefix}轮廓格 ${idx} 没有归属房间`);
  }
  for (let idx = 0; idx < dwell.w * dwell.h; idx++) {
    if (!dwell.footprint.has(idx)) {
      assert.strictEqual(dwell.owner[idx], -1, `${prefix}轮廓外格 ${idx} 仍被标记 owner`);
    }
  }

  // 门与连通性
  const keySet = new Set();
  const graph = new Map();
  for (const room of dwell.rooms) graph.set(room.id, new Set());
  let interiorDoors = 0;

  for (const door of dwell.doors) {
    assert(!keySet.has(door.key), `${prefix}门 key 重复：${door.key}`);
    keySet.add(door.key);
    const expectedKey = `${door.orient}:${door.x}:${door.y}`;
    assert.strictEqual(door.key, expectedKey, `${prefix}门 key 与坐标不一致`);

    const cells = adjacentDoorCells(dwell, door);
    const inside = cells.filter(c => dwell.hasCell(c.x, c.y));
    assert.strictEqual(inside.length, door.exterior ? 1 : 2,
      `${prefix}门 ${door.key} 两侧轮廓格数量异常`);
    assert(inside.every(c => {
      const idx = cellIdx(dwell, c.x, c.y);
      return idx >= 0 && dwell.owner[idx] >= 1;
    }), `${prefix}门 ${door.key} 两侧存在无主格`);

    if (door.exterior) {
      assert.strictEqual(door.b, null, `${prefix}入口门 b 应为 null`);
      assert.strictEqual(dwell.owner[cellIdx(dwell, inside[0].x, inside[0].y)], door.a,
        `${prefix}入口门没有落在房间 ${door.a} 的外墙上`);
    } else {
      interiorDoors++;
      assert.notStrictEqual(door.a, door.b, `${prefix}内门连接了同一个房间`);
      const owners = inside.map(c => dwell.owner[cellIdx(dwell, c.x, c.y)]).sort((a, b) => a - b);
      const expected = [door.a, door.b].sort((a, b) => a - b);
      assert.deepStrictEqual(owners, expected,
        `${prefix}门 ${door.key} 没有正确连接房间 ${door.a} / ${door.b}`);
      graph.get(door.a).add(door.b);
      graph.get(door.b).add(door.a);
    }
  }

  const seen = new Set([dwell.rooms[0].id]);
  const stack = [dwell.rooms[0].id];
  while (stack.length) {
    const id = stack.pop();
    for (const next of graph.get(id)) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  assert.strictEqual(seen.size, dwell.rooms.length,
    `${prefix}存在无法经门到达的房间`);
  assert(interiorDoors >= dwell.rooms.length - 1,
    `${prefix}内门数量少于房间数 - 1`);
  assert(dwell.doors.filter(d => d.exterior).length === 1,
    `${prefix}入口门数量不是 1`);
  assert(dwell.frontDoor && dwell.frontDoor.exterior,
    `${prefix}frontDoor 未正确记录`);

  // 家具：不越界、不重叠、不挡门
  const furnitureCells = new Map();
  let furnitureCount = 0;
  for (const room of dwell.rooms) {
    for (const item of room.furniture) {
      furnitureCount++;
      assert(FURNITURE_LABELS.has(item.label), `${prefix}未知家具标签：${item.label}`);
      assert(item.w > 0 && item.h > 0, `${prefix}家具尺寸非法`);
      for (let dy = 0; dy < item.h; dy++) {
        for (let dx = 0; dx < item.w; dx++) {
          const x = item.x + dx;
          const y = item.y + dy;
          const idx = cellIdx(dwell, x, y);
          assert(idx >= 0 && dwell.footprint.has(idx),
            `${prefix}家具 ${item.label} 超出建筑轮廓`);
          assert.strictEqual(dwell.owner[idx], room.id,
            `${prefix}家具 ${item.label} 越出房间 ${room.id}`);
          assert(!furnitureCells.has(idx),
            `${prefix}家具重叠于格 ${idx}（${item.label}）`);
          furnitureCells.set(idx, item.label);
        }
      }
    }
  }
  assert.strictEqual(dwell.furnitureCells.size, furnitureCells.size,
    `${prefix}furnitureCells 记录数量与家具实际占用不一致`);

  for (const door of dwell.doors) {
    for (const c of adjacentDoorCells(dwell, door)) {
      const idx = cellIdx(dwell, c.x, c.y);
      if (idx >= 0 && dwell.footprint.has(idx)) {
        assert(!furnitureCells.has(idx),
          `${prefix}家具挡住了门 ${door.key} 的门前格 ${idx}`);
      }
    }
  }

  // 密度为 0 时不能有家具
  if (dwell.opts.furnitureDensity === 0) {
    assert.strictEqual(furnitureCount, 0, `${prefix}家具密度为 0 却生成了家具`);
  }

  return { interiorDoors, furnitureCount };
}

// =========================================================
section('1. PRNG 与种子解析');

test('mulberry32 与 dungeon.js 参考实现逐值一致', () => {
  for (const seed of [0, 1, 42, 123456789, 0xFFFFFFFF]) {
    const actual = mulberry32(seed);
    const expected = refMulberry32(seed);
    for (let i = 0; i < 80; i++) {
      assert.strictEqual(actual(), expected(), `seed=${seed} 第 ${i} 个随机值不一致`);
    }
  }
});

test('hashStringToSeed 与参考实现一致', () => {
  for (const text of ['', 'a', '42', '城堡-01', '地牢与住所', '中文 TTRPG 种子🎲']) {
    assert.strictEqual(hashStringToSeed(text), refHash(text), `字符串 "${text}" 哈希不一致`);
  }
});

test('数字种子按数解析，非数字种子按字符串哈希', () => {
  assert.strictEqual(seedNumberFromInput('42'), 42);
  assert.strictEqual(seedNumberFromInput(' 0042 '), 42);
  assert.strictEqual(seedNumberFromInput('城镇'), hashStringToSeed('城镇'));
  assert.strictEqual(seedNumberFromInput('-1'), hashStringToSeed('-1'));
});

// =========================================================
section('2. 种子复现');

const REPRO_OPTS = { size: 22, roomCount: 6, lShape: 45, furnitureDensity: 60 };

test('相同数字种子生成完全一致的快照', () => {
  const a = generateDwelling(REPRO_OPTS, 20261017);
  const b = generateDwelling(REPRO_OPTS, 20261017);
  assert.deepStrictEqual(a.snapshot(), b.snapshot());
});

test('相同字符串种子生成完全一致的快照', () => {
  const a = generateDwelling(REPRO_OPTS, '城堡-01');
  const b = generateDwelling(REPRO_OPTS, '城堡-01');
  assert.deepStrictEqual(a.snapshot(), b.snapshot());
});

test('字符串种子等价于其 hashStringToSeed 数字种子', () => {
  const stringSeed = generateDwelling(REPRO_OPTS, '城堡-01');
  const numberSeed = generateDwelling(REPRO_OPTS, hashStringToSeed('城堡-01'));
  assert.deepStrictEqual(stringSeed.snapshot(), numberSeed.snapshot());
});

test('不同种子能产生多种布局', () => {
  const snapshots = new Set();
  for (let seed = 1001; seed <= 1010; seed++) {
    snapshots.add(JSON.stringify(generateDwelling(REPRO_OPTS, seed).snapshot()));
  }
  assert(snapshots.size > 1, '10 个不同种子生成了完全相同的布局');
});

test('同一种子重复生成时家具放置顺序稳定', () => {
  const a = generateDwelling(REPRO_OPTS, '家具复现');
  const b = generateDwelling(REPRO_OPTS, '家具复现');
  const aFurniture = a.rooms.flatMap(r => r.furniture.map(f => `${r.id}:${f.label}@${f.x},${f.y}`));
  const bFurniture = b.rooms.flatMap(r => r.furniture.map(f => `${r.id}:${f.label}@${f.x},${f.y}`));
  assert.deepStrictEqual(aFurniture, bFurniture);
});

// =========================================================
section('3. 参数矩阵');

const combos = [];
for (const size of [14, 18, 22, 28]) {
  for (const roomCount of [3, 6, 10]) {
    combos.push({ size, roomCount, lShape: 45, furnitureDensity: 60 });
  }
}
for (const lShape of [0, 30, 100]) {
  for (const furnitureDensity of [0, 60, 100]) {
    combos.push({ size: 22, roomCount: 7, lShape, furnitureDensity });
  }
}
combos.push(
  { size: 14, roomCount: 10, lShape: 100, furnitureDensity: 100 },
  { size: 28, roomCount: 10, lShape: 100, furnitureDensity: 100 },
  { size: 14, roomCount: 3, lShape: 0, furnitureDensity: 0 },
  { size: 28, roomCount: 3, lShape: 50, furnitureDensity: 0 },
  { size: 28, roomCount: 10, lShape: 0, furnitureDensity: 0 },
  { size: 14, roomCount: 3, lShape: 100, furnitureDensity: 100 },
);

test(`参数矩阵共 ${combos.length} 组 × 3 个种子，全部生成并通过结构校验`, () => {
  const seeds = [0, 987654321, '矩阵种子'];
  for (const opts of combos) {
    for (const seed of seeds) {
      const label = `size=${opts.size},rooms=${opts.roomCount},L=${opts.lShape},density=${opts.furnitureDensity},seed=${seed}`;
      const dwell = generateDwelling(opts, seed);
      validateDwelling(dwell, label);
    }
  }
});

// =========================================================
section('4. 多随机种子结构校验');

test('默认参数下 60 个连续种子全部合法', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const dwell = generateDwelling({ size: 22, roomCount: 6, lShape: 45, furnitureDensity: 60 }, seed);
    validateDwelling(dwell, `seed=${seed}`);
  }
});

test('L 形复杂度的极端取值都能正常生成', () => {
  for (const lShape of [0, 1, 50, 99, 100]) {
    for (const size of [14, 20, 28]) {
      const dwell = generateDwelling({ size, roomCount: 8, lShape, furnitureDensity: 80 }, `L-${lShape}-${size}`);
      validateDwelling(dwell, `L=${lShape},size=${size}`);
    }
  }
});

// =========================================================
section('5. 轮廓与房间');

test('lShape=0 时为完整矩形，lShape>0 时切掉一个矩形角', () => {
  const rect = generateDwelling({ size: 18, roomCount: 5, lShape: 0, furnitureDensity: 40 }, 77);
  assert.strictEqual(rect.notch, null);
  assert.strictEqual(rect.footprint.size, rect.w * rect.h);

  const lshape = generateDwelling({ size: 18, roomCount: 5, lShape: 70, furnitureDensity: 40 }, 77);
  assert(lshape.notch, 'L 形缺少 notch 信息');
  assert.strictEqual(lshape.footprint.size, lshape.w * lshape.h - lshape.notch.w * lshape.notch.h);
  for (let y = 0; y < lshape.notch.h; y++) {
    for (let x = 0; x < lshape.notch.w; x++) {
      assert(!lshape.hasCell(lshape.notch.x + x, lshape.notch.y + y), '缺角区域仍属于轮廓');
    }
  }
});

test('每栋建筑都有且仅有一间客厅，房间编号连续', () => {
  const dwell = generateDwelling({ size: 24, roomCount: 8, lShape: 60, furnitureDensity: 50 }, '类型测试');
  const ids = dwell.rooms.map(r => r.id);
  assert.deepStrictEqual(ids, Array.from({ length: dwell.rooms.length }, (_, i) => i + 1));
  assert.strictEqual(dwell.rooms.filter(r => r.type === '客厅').length, 1);
});

test('家具密度 0 与 100 的行为符合预期', () => {
  const none = generateDwelling({ size: 24, roomCount: 6, lShape: 40, furnitureDensity: 0 }, '密度-0');
  assert.strictEqual(none.rooms.reduce((n, r) => n + r.furniture.length, 0), 0);
  const rich = generateDwelling({ size: 24, roomCount: 6, lShape: 40, furnitureDensity: 100 }, '密度-100');
  assert(rich.rooms.reduce((n, r) => n + r.furniture.length, 0) > 0);
  validateDwelling(rich, '密度 100');
});

test('单房间建筑也能生成并带入口', () => {
  const dwell = generateDwelling({ size: 14, roomCount: 1, lShape: 0, furnitureDensity: 30 }, '单间');
  assert.strictEqual(dwell.rooms.length, 1);
  assert.strictEqual(dwell.doors.filter(d => d.exterior).length, 1);
  validateDwelling(dwell, '单房间');
});

// =========================================================
section('6. TXT 清单');

function itemTouchesRoomEdge(dwell, room, item) {
  for (let dy = 0; dy < item.h; dy++) {
    for (let dx = 0; dx < item.w; dx++) {
      const x = item.x + dx;
      const y = item.y + dy;
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of neighbors) {
        if (!dwell.hasCell(nx, ny) || dwell.owner[cellIdx(dwell, nx, ny)] !== room.id) return true;
      }
    }
  }
  return false;
}

test('大房间的家具会进入房间中央，而不是只贴墙', () => {
  let checked = 0;
  for (const seed of [1, 42, 995441513, 7, 2026, 88]) {
    const dwell = generateDwelling(
      { size: 22, roomCount: 6, lShape: 0, furnitureDensity: 75 },
      seed,
    );
    validateDwelling(dwell, `中央家具 seed=${seed}`);
    for (const room of dwell.rooms) {
      if (room.area < 20 || room.bbox.w < 5 || room.bbox.h < 5) continue;
      checked++;
      const interior = room.furniture.filter(item => !itemTouchesRoomEdge(dwell, room, item));
      assert(
        interior.length >= 1,
        `房间 ${room.id}·${room.type}（${room.area} 格）没有摆在中央的家具`,
      );
    }
  }
  assert(checked >= 4, `应检查到多个大房间，实际 ${checked}`);
});

test('清单包含种子、每个房间的编号/类型/家具与入口信息', () => {
  const dwell = generateDwelling({ size: 22, roomCount: 6, lShape: 45, furnitureDensity: 70 }, '清单种子');
  const text = buildDwellingText(dwell, '清单种子');
  assert(text.includes('住所室内清单'));
  assert(text.includes('清单种子'));
  assert(text.includes('入口：'));
  for (const room of dwell.rooms) {
    assert(text.includes(`房间 ${room.id}：${room.type}`),
      `清单缺少房间 ${room.id} 的类型`);
    assert(text.includes('主要家具：'), `清单缺少家具字段`);
    for (const item of room.furniture) {
      assert(text.includes(item.label), `清单缺少家具 ${item.label}`);
    }
  }
});

// =========================================================
console.log(`\n========================================`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log(`========================================`);
if (failed > 0) {
  process.exitCode = 1;
}
