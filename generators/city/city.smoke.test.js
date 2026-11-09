/* =========================================================
 * 城市生成器 Node 冒烟测试
 * 运行：node generators/city/city.smoke.test.js
 *
 * 覆盖：
 *  1. 多种参数组合生成不报错
 *  2. 相同种子生成结果完全一致，不同种子结果不同
 *  3. 生成过程不依赖 Math.random
 *  4. 街区/建筑/道路/城墙不越出画布，建筑在本街区内部
 *  5. 街区之间、建筑之间无明显重叠；建筑不压道路
 *  6. 城墙开关、城门数量、中央广场、TXT 清单格式
 * ========================================================= */

const {
  createCity,
  hashStringToSeed,
  normalizeCityOptions,
  buildCityText,
  buildScenery,
  CANVAS_SIZE,
} = require('./city.js');

let checkCount = 0;
let failureCount = 0;

function check(condition, message) {
  checkCount++;
  if (!condition) throw new Error(message);
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : String(n);
}

// ---------- 测试内独立实现的几何检查 ----------
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

function pointSegDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegDistance(a, c, d),
    pointSegDistance(b, c, d),
    pointSegDistance(c, a, b),
    pointSegDistance(d, a, b)
  );
}

// 两个凸多边形的最小 SAT 重叠深度；<= 0 表示分离或仅共边
function overlapDepth(a, b) {
  let minDepth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      let ax = -(p2.y - p1.y);
      let ay = p2.x - p1.x;
      const len = Math.hypot(ax, ay);
      if (len < 1e-9) continue;
      ax /= len;
      ay /= len;

      let minA = Infinity, maxA = -Infinity;
      let minB = Infinity, maxB = -Infinity;
      for (const p of a) {
        const d = p.x * ax + p.y * ay;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const p of b) {
        const d = p.x * ax + p.y * ay;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      const depth = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (depth <= 0) return 0;
      minDepth = Math.min(minDepth, depth);
    }
  }
  return Number.isFinite(minDepth) ? minDepth : 0;
}

function roadSegments(road) {
  const out = [];
  const pts = road.points;
  const count = road.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) out.push([pts[i], pts[(i + 1) % pts.length]]);
  return out;
}

// ---------- 单项校验 ----------
function checkPolygonBounds(poly, label) {
  for (const p of poly) {
    check(Number.isFinite(p.x) && Number.isFinite(p.y), `${label} 含非有限坐标`);
    check(p.x >= -0.01 && p.x <= CANVAS_SIZE + 0.01, `${label} x 越界：${fmt(p.x)}`);
    check(p.y >= -0.01 && p.y <= CANVAS_SIZE + 0.01, `${label} y 越界：${fmt(p.y)}`);
  }
}

function checkCity(city, combo, label) {
  const blockById = new Map();
  const buildingByBlock = new Map();

  check(city.blocks.length > 0, `${label} 没有生成街区`);
  check(city.buildings.length > 0, `${label} 没有生成建筑`);
  check(city.blocks.length >= Math.max(1, combo.blockCount - 2),
    `${label} 街区数量异常：目标 ${combo.blockCount}，实际 ${city.blocks.length}`);
  check(city.blocks.length <= combo.blockCount,
    `${label} 街区数量超过目标：目标 ${combo.blockCount}，实际 ${city.blocks.length}`);
  check(city.stats.blockCount === city.blocks.length, `${label} stats.blockCount 不一致`);
  check(city.stats.buildingCount === city.buildings.length, `${label} stats.buildingCount 不一致`);

  // 街区编号、类型、内部一致性
  let lastId = 0;
  for (const block of city.blocks) {
    check(Number.isInteger(block.id) && block.id > lastId, `${label} 街区编号未递增：${block.id}`);
    lastId = block.id;
    check(typeof block.name === 'string' && block.name.length > 0, `${label} 街区 ${block.id} 没有名字`);
    check(block.polygon.length >= 3, `${label} 街区 ${block.id} 顶点不足`);
    check(block.area > 0, `${label} 街区 ${block.id} 面积为 0`);
    checkPolygonBounds(block.polygon, `${label} 街区 ${block.id}`);
    blockById.set(block.id, block);
    buildingByBlock.set(block.id, 0);
  }
  check(city.centralBlock && city.centralBlock.type === '中央广场',
    `${label} 缺少中央广场街区`);
  const names = city.blocks.map(b => b.name);
  check(new Set(names).size === names.length, `${label} 街区名有重复`);

  // 建筑归属与数量
  for (const b of city.buildings) {
    check(blockById.has(b.blockId), `${label} 建筑 ${b.id} 指向不存在的街区 ${b.blockId}`);
    check(b.polygon.length >= 3, `${label} 建筑 ${b.id} 顶点不足`);
    check(b.area > 0, `${label} 建筑 ${b.id} 面积为 0`);
    checkPolygonBounds(b.polygon, `${label} 建筑 ${b.id}`);
    buildingByBlock.set(b.blockId, buildingByBlock.get(b.blockId) + 1);
  }
  for (const block of city.blocks) {
    check(block.buildingCount === buildingByBlock.get(block.id),
      `${label} 街区 ${block.id} buildingCount 不一致`);
    check(block.buildingCount === block.buildings.length,
      `${label} 街区 ${block.id} buildings 数组长度不一致`);
  }

  // 街区在城界内、建筑在本街区多边形内
  for (const block of city.blocks) {
    for (const p of block.polygon) {
      check(pointInPoly(city.boundary, p), `${label} 街区 ${block.id} 越出城界`);
    }
    for (const b of block.buildings) {
      for (const p of b.polygon) {
        check(pointInPoly(block.polygon, p),
          `${label} 建筑 ${b.id} 越出街区 ${block.id}（${fmt(p.x)},${fmt(p.y)}）`);
      }
    }
  }

  // 城墙与城门
  if (combo.wallEnabled) {
    check(city.wall && city.wall.polygon.length >= 3, `${label} 开启城墙但未生成墙体`);
    check(city.wall.gates.length === combo.roadCount,
      `${label} 城门数量异常：期望 ${combo.roadCount}，实际 ${city.wall.gates.length}`);
    check(city.wall.towers && city.wall.towers.length >= 6,
      `${label} 城墙圆塔过少：${city.wall.towers ? city.wall.towers.length : 0}`);
    checkPolygonBounds(city.wall.polygon, `${label} 城墙`);
  } else {
    check(city.wall === null, `${label} 关闭城墙但仍有墙体`);
    check(city.stats.gateCount === 0, `${label} 关闭城墙但统计了城门`);
  }

  // 道路点越界
  check(city.roads.length >= combo.roadCount, `${label} 道路数量不足`);
  for (const road of city.roads) {
    for (const p of road.points) {
      check(p.x >= -0.01 && p.x <= CANVAS_SIZE + 0.01, `${label} 道路 x 越界：${fmt(p.x)}`);
      check(p.y >= -0.01 && p.y <= CANVAS_SIZE + 0.01, `${label} 道路 y 越界：${fmt(p.y)}`);
    }
  }

  // 街区两两不重叠（允许共边）
  for (let i = 0; i < city.blocks.length; i++) {
    for (let j = i + 1; j < city.blocks.length; j++) {
      const depth = overlapDepth(city.blocks[i].polygon, city.blocks[j].polygon);
      check(depth <= 0.75,
        `${label} 街区 ${city.blocks[i].id} 与 ${city.blocks[j].id} 重叠 ${fmt(depth)}px`);
    }
  }

  // 建筑两两不重叠
  for (let i = 0; i < city.buildings.length; i++) {
    for (let j = i + 1; j < city.buildings.length; j++) {
      const depth = overlapDepth(city.buildings[i].polygon, city.buildings[j].polygon);
      check(depth <= 0.5,
        `${label} 建筑 ${city.buildings[i].id} 与 ${city.buildings[j].id} 重叠 ${fmt(depth)}px`);
    }
  }

  // 建筑不压道路
  for (const b of city.buildings) {
    for (const road of city.roads) {
      const clearance = road.width / 2;
      for (let i = 0; i < b.polygon.length; i++) {
        const p1 = b.polygon[i];
        const p2 = b.polygon[(i + 1) % b.polygon.length];
        for (const [r1, r2] of roadSegments(road)) {
          const d = segmentDistance(p1, p2, r1, r2);
          check(d >= clearance - 0.01,
            `${label} 建筑 ${b.id} 压到${road.kind === 'radial' ? '主干道' : '环路'}：距离 ${fmt(d)} < ${fmt(clearance)}`);
        }
      }
    }
  }
}

// 简单的点在多边形内判断（允许边界附近微小误差）
function pointInPoly(poly, pt) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x) {
      inside = !inside;
    }
    // 边界附近也视为内部
    const d = pointSegDistance(pt, a, b);
    if (d < 1e-6) return true;
  }
  return inside;
}

function snapshot(city) {
  return JSON.stringify({
    R: city.R,
    boundary: city.boundary,
    blocks: city.blocks.map(b => ({
      id: b.id,
      type: b.type,
      name: b.name,
      polygon: b.polygon,
      landmarkPolygon: b.landmarkPolygon,
      buildingCount: b.buildingCount,
    })),
    buildings: city.buildings.map(b => ({
      id: b.id,
      blockId: b.blockId,
      type: b.type,
      color: b.color,
      polygon: b.polygon,
    })),
    roads: city.roads.map(r => ({
      kind: r.kind,
      width: r.width,
      closed: r.closed,
      points: r.points,
    })),
    wall: city.wall,
  });
}

function runCase(name, fn) {
  try {
    const detail = fn();
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    failureCount++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ---------- 1. 参数组合 ----------
console.log('\n[1] 多参数组合生成与几何校验');
const combos = [
  { blockCount: 12, roadCount: 3, subdivision: 1, wallEnabled: true },
  { blockCount: 12, roadCount: 12, subdivision: 10, wallEnabled: false },
  { blockCount: 16, roadCount: 10, subdivision: 10, wallEnabled: true },
  { blockCount: 24, roadCount: 4, subdivision: 3, wallEnabled: false },
  { blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true },
  { blockCount: 48, roadCount: 7, subdivision: 6, wallEnabled: true },
  { blockCount: 60, roadCount: 8, subdivision: 8, wallEnabled: false },
  { blockCount: 72, roadCount: 5, subdivision: 2, wallEnabled: true },
  { blockCount: 88, roadCount: 11, subdivision: 9, wallEnabled: false },
  { blockCount: 100, roadCount: 3, subdivision: 1, wallEnabled: true },
  { blockCount: 100, roadCount: 12, subdivision: 10, wallEnabled: true },
  { blockCount: 100, roadCount: 12, subdivision: 10, wallEnabled: false },
];

combos.forEach((combo, index) => {
  runCase(`组合 ${index + 1}: 街区 ${combo.blockCount} / 主干道 ${combo.roadCount} / 密度 ${combo.subdivision} / 城墙 ${combo.wallEnabled ? '开' : '关'}`, () => {
    const seed = 20261017 + index * 131;
    const started = Date.now();
    const city = createCity(combo, seed);
    checkCity(city, combo, `组合 ${index + 1}`);
    return `街区 ${city.blocks.length}、建筑 ${city.buildings.length}、地标 ${city.stats.landmarkCount}、耗时 ${Date.now() - started}ms`;
  });
});

// ---------- 2. 种子复现 ----------
console.log('\n[2] 种子复现与随机性');
const reproOpts = { blockCount: 48, roadCount: 7, subdivision: 6, wallEnabled: true };
runCase('相同种子两次生成完全一致', () => {
  const a = createCity(reproOpts, 424242);
  const b = createCity(reproOpts, 424242);
  const snapA = snapshot(a);
  const snapB = snapshot(b);
  check(snapA === snapB, '相同种子的快照不一致');
  return `快照长度 ${snapA.length} 字符`;
});
runCase('不同种子生成不同结果', () => {
  const a = createCity(reproOpts, 424242);
  const b = createCity(reproOpts, 424243);
  check(snapshot(a) !== snapshot(b), '不同种子生成了相同结果');
  return '结果不同';
});
runCase('文字种子 hashStringToSeed 稳定', () => {
  const s1 = hashStringToSeed('跑团城市·测试');
  const s2 = hashStringToSeed('跑团城市·测试');
  const s3 = hashStringToSeed('跑团城市·测');
  check(s1 === s2, '同一文字种子的哈希不一致');
  check(s1 !== s3, '不同文字种子得到相同哈希');
  const a = createCity(reproOpts, s1);
  const b = createCity(reproOpts, hashStringToSeed('跑团城市·测试'));
  check(snapshot(a) === snapshot(b), '文字种子生成结果不一致');
  return `哈希 ${s1}`;
});
runCase('生成过程不调用 Math.random', () => {
  const original = Math.random;
  let called = false;
  Math.random = () => { called = true; return 0.5; };
  try {
    createCity(reproOpts, 987654321);
  } finally {
    Math.random = original;
  }
  check(!called, '生成过程中调用了 Math.random');
  return '仅使用 mulberry32';
});

// ---------- 3. 参数归一化与清单 ----------
console.log('\n[3] 参数归一化与 TXT 清单');
runCase('参数越界时自动钳制', () => {
  const o = normalizeCityOptions({ blockCount: 999, roadCount: -5, subdivision: 99, wallEnabled: false });
  check(o.blockCount === 100, 'blockCount 未钳制到 100');
  check(o.roadCount === 3, 'roadCount 未钳制到 3');
  check(o.subdivision === 10, 'subdivision 未钳制到 10');
  check(o.wallEnabled === false, 'wallEnabled 被意外修改');
  const d = normalizeCityOptions({});
  check(d.blockCount === 36 && d.roadCount === 6 && d.subdivision === 5 && d.wallEnabled === true,
    '默认参数不正确');
  return '钳制与默认值正常';
});
runCase('TXT 清单包含全部街区与建筑数', () => {
  const city = createCity({ blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true }, 13579);
  const text = buildCityText(city, '清单测试');
  check(text.includes('种子：清单测试'), '清单缺少种子');
  check(text.includes(`实际街区：${city.blocks.length}`), '清单缺少实际街区数');
  for (const block of city.blocks) {
    check(text.includes(`街区 ${block.id}（${block.type}）：约 ${block.buildingCount} 栋建筑`),
      `清单缺少街区 ${block.id} 的信息`);
  }
  check((text.match(/约 \d+ 栋建筑/g) || []).length === city.blocks.length,
    '清单街区行数不一致');
  for (const block of city.blocks) {
    check(text.includes(block.name), `清单缺少街区名 ${block.name}`);
  }
  return `${text.split('\n').length} 行`;
});
runCase('街区名与城外景物随种子稳定', () => {
  const a = createCity({ blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true }, 13579);
  const b = createCity({ blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true }, 13579);
  check(a.blocks.every(block => block.name && block.name.length > 0), '存在空街区名');
  check(a.blocks.map(block => block.name).join('|') === b.blocks.map(block => block.name).join('|'), '同一种子街区名不一致');
  const scA = buildScenery(a);
  const scB = buildScenery(b);
  check(scA.plots.length >= 1, '城外没有地块');
  check(typeof scA.water === 'boolean', '水面标记不是布尔值');
  check(JSON.stringify(scA) === JSON.stringify(scB), '同一种子的城外景物不一致');
  const other = buildScenery(createCity({ blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true }, 13580));
  check(JSON.stringify(scA) !== JSON.stringify(other) || a.blocks[0].name !== createCity({ blockCount: 36, roadCount: 6, subdivision: 5, wallEnabled: true }, 13580).blocks[0].name,
    '不同种子的街区名和景物都相同');
  return `${a.blocks.length} 个名字，水面 ${scA.water ? '有' : '无'}`;
});

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(56));
if (failureCount === 0) {
  console.log(`冒烟测试全部通过：${checkCount} 项断言，0 失败`);
} else {
  console.error(`冒烟测试失败：${checkCount} 项断言，${failureCount} 个用例失败`);
  process.exitCode = 1;
}
console.log('='.repeat(56) + '\n');
