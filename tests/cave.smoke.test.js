#!/usr/bin/env node
'use strict';

/* =========================================================
 * 洞穴 / 林间生成器 - Node 冒烟测试
 * 运行：node tests/cave.smoke.test.js
 * 覆盖：参数矩阵、种子复现、连通性清理、装饰物、参数钳制、TXT 摘要
 * 说明：Canvas 渲染与浏览器下载行为依赖 DOM，不在 Node 冒烟测试范围内
 * ========================================================= */

const assert = require('assert');
const {
  mulberry32,
  hashStringToSeed,
  seedToNumber,
  ROCK,
  FLOOR,
  clampInt,
  normalizeOptions,
  createCave,
  buildCaveSummary,
} = require('../generators/cave/cave.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
  }
}

function describe(opts) {
  return `w=${opts.w},h=${opts.h},fill=${opts.rockFill},smooth=${opts.smoothing},decor=${opts.decorationDensity},style=${opts.style}`;
}

// 测试侧独立实现的 4-邻接洪泛，避免用被测代码验证自己
function independentRegionSizes(cave) {
  const { w, h, grid } = cave;
  const seen = new Uint8Array(w * h);
  const sizes = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (grid[start] !== FLOOR || seen[start]) continue;

      let size = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const cur = stack.pop();
        size++;
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
      sizes.push(size);
    }
  }
  sizes.sort((a, b) => b - a);
  return sizes;
}

function assertBorderRock(cave, label) {
  const { w, h, grid } = cave;
  for (let x = 0; x < w; x++) {
    assert.strictEqual(grid[x], ROCK, `${label}: 上边界 (${x},0) 应为岩石`);
    assert.strictEqual(grid[(h - 1) * w + x], ROCK, `${label}: 下边界 (${x},${h - 1}) 应为岩石`);
  }
  for (let y = 0; y < h; y++) {
    assert.strictEqual(grid[y * w], ROCK, `${label}: 左边界 (0,${y}) 应为岩石`);
    assert.strictEqual(grid[y * w + w - 1], ROCK, `${label}: 右边界 (${w - 1},${y}) 应为岩石`);
  }
}

function assertSingleConnectedRegion(cave, label) {
  assert(cave.stats.floorCells > 0, `${label}: 应存在可通行地面`);
  const sizes = independentRegionSizes(cave);
  assert.strictEqual(sizes.length, 1, `${label}: 连通清理后应只剩 1 个区域，实际 ${sizes.length} 个`);
  assert.strictEqual(sizes[0], cave.stats.floorCells, `${label}: 最大区域应覆盖全部地面`);
  assert.strictEqual(cave.stats.largestRegionSize, sizes[0], `${label}: 统计的最大连通区域不一致`);
  assert(
    sizes[0] >= cave.minimumCaveArea(),
    `${label}: 主区域 ${sizes[0]} 格小于最小可玩面积 ${cave.minimumCaveArea()} 格`
  );
}

function assertDecorations(cave, label) {
  const counts = { tree: 0, bush: 0, rubble: 0 };
  const occupied = new Set();

  for (const d of cave.decorations) {
    assert(d.x >= 0 && d.x < cave.w && d.y >= 0 && d.y < cave.h, `${label}: 装饰物越界 (${d.x},${d.y})`);
    assert.strictEqual(
      cave.grid[d.y * cave.w + d.x],
      FLOOR,
      `${label}: 装饰物位于岩石上 (${d.x},${d.y})`
    );
    const key = `${d.x},${d.y}`;
    assert(!occupied.has(key), `${label}: 同一格出现多个装饰物 (${key})`);
    occupied.add(key);
    assert(counts[d.type] !== undefined, `${label}: 未知装饰物类型 ${d.type}`);
    counts[d.type]++;
  }

  assert.deepStrictEqual(cave.stats.decorationCounts, counts, `${label}: 装饰物统计不一致`);
  assert.strictEqual(cave.stats.decorationTotal, cave.decorations.length, `${label}: 装饰物总数不一致`);
  if (cave.opts.decorationDensity === 0) {
    assert.strictEqual(cave.decorations.length, 0, `${label}: 密度为 0 时不应有装饰物`);
  }
  if (cave.opts.style === 'cave') {
    assert.strictEqual(counts.tree, 0, `${label}: 洞穴风格不应生成树木`);
  }
}

// ---------- 1. PRNG 与种子工具 ----------
test('mulberry32 同种子产生完全相同的序列，且输出在 [0,1)', () => {
  const a = mulberry32(hashStringToSeed('洞穴种子'));
  const b = mulberry32(hashStringToSeed('洞穴种子'));
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 128; i++) {
    const va = a();
    const vb = b();
    assert(Number.isFinite(va) && va >= 0 && va < 1, `第 ${i} 个随机数越界: ${va}`);
    seqA.push(va);
    seqB.push(vb);
  }
  assert.deepStrictEqual(seqA, seqB);
});

test('hashStringToSeed / seedToNumber 行为与 dungeon.js 一致', () => {
  assert.strictEqual(hashStringToSeed('abc'), hashStringToSeed('abc'));
  assert.notStrictEqual(hashStringToSeed('abc'), hashStringToSeed('abd'));
  assert.strictEqual(seedToNumber('12345'), 12345);
  assert.strictEqual(seedToNumber('0012345'), 12345);
  assert.strictEqual(seedToNumber('  '), null);
  assert.strictEqual(seedToNumber('霜落洞穴'), hashStringToSeed('霜落洞穴'));
  assert.strictEqual(seedToNumber('12abc'), hashStringToSeed('12abc'));
  assert.strictEqual(seedToNumber(null), null);
});

// ---------- 2. 参数矩阵 ----------
test('参数矩阵：多种尺寸/填充率/平滑轮数/密度/风格均能生成单连通地图', () => {
  const widths = [[24, 20], [40, 30], [50, 38], [80, 60], [100, 80]];
  const fills = [35, 47, 65];
  const smoothings = [0, 4, 8];
  const densities = [0, 12, 40];
  const styles = ['cave', 'forest'];
  let combinations = 0;

  for (const [w, h] of widths) {
    for (const rockFill of fills) {
      for (const smoothing of smoothings) {
        for (const decorationDensity of densities) {
          for (const style of styles) {
            combinations++;
            const opts = { w, h, rockFill, smoothing, decorationDensity, style };
            const label = describe(opts);
            const cave = createCave(opts, 1000 + combinations);

            assert.strictEqual(cave.grid.length, w * h, `${label}: 网格大小错误`);
            assert.strictEqual(cave.w, w, `${label}: 宽度错误`);
            assert.strictEqual(cave.h, h, `${label}: 高度错误`);
            assertBorderRock(cave, label);
            assertSingleConnectedRegion(cave, label);
            assertDecorations(cave, label);
          }
        }
      }
    }
  }

  console.log(`  已覆盖 ${combinations} 组参数组合`);
});

// ---------- 3. 种子复现 ----------
test('相同数字种子 = 相同地形、装饰物与统计', () => {
  const cases = [
    { w: 50, h: 38, rockFill: 47, smoothing: 4, decorationDensity: 12, style: 'forest' },
    { w: 24, h: 20, rockFill: 65, smoothing: 8, decorationDensity: 40, style: 'cave' },
    { w: 80, h: 60, rockFill: 35, smoothing: 0, decorationDensity: 0, style: 'forest' },
  ];
  const seeds = [20261017, 1, 4294967295];

  for (let i = 0; i < cases.length; i++) {
    const opts = cases[i];
    const seed = seeds[i];
    const a = createCave(opts, seed);
    const b = createCave(opts, seed);
    assert.deepStrictEqual(a.grid, b.grid, `${describe(opts)}: 相同种子地形不一致`);
    assert.deepStrictEqual(a.decorations, b.decorations, `${describe(opts)}: 相同种子装饰物不一致`);
    assert.deepStrictEqual(a.stats, b.stats, `${describe(opts)}: 相同种子统计不一致`);
  }
});

test('文字种子经 hashStringToSeed 后同样可复现', () => {
  const opts = { w: 56, h: 42, rockFill: 47, smoothing: 5, decorationDensity: 18, style: 'forest' };
  const textSeed = '霜落洞穴-2026';
  const seed = seedToNumber(textSeed);
  assert.strictEqual(seed, hashStringToSeed(textSeed));

  const a = createCave(opts, seed);
  const b = createCave(opts, seed);
  assert.deepStrictEqual(a.grid, b.grid);
  assert.deepStrictEqual(a.decorations, b.decorations);
});

test('不同种子生成不同地图', () => {
  const opts = { w: 50, h: 38, rockFill: 47, smoothing: 4, decorationDensity: 12, style: 'forest' };
  let differences = 0;
  for (const [seedA, seedB] of [[1, 2], [42, 43], [20261017, 20261018]]) {
    const a = createCave(opts, seedA);
    const b = createCave(opts, seedB);
    // 同时比较地形与装饰物，避免极端参数下地形恰好相同时误报
    const stateA = JSON.stringify({ grid: Array.from(a.grid), decorations: a.decorations });
    const stateB = JSON.stringify({ grid: Array.from(b.grid), decorations: b.decorations });
    if (stateA !== stateB) differences++;
  }
  assert.strictEqual(differences, 3, '不同种子应生成不同地图');
});

test('数字字符串种子与等价数字种子生成同一地图', () => {
  const opts = { w: 40, h: 30, rockFill: 55, smoothing: 3, decorationDensity: 20, style: 'cave' };
  const a = createCave(opts, seedToNumber('20261017'));
  const b = createCave(opts, 20261017);
  assert.deepStrictEqual(a.grid, b.grid);
  assert.deepStrictEqual(a.decorations, b.decorations);
});

// ---------- 4. 极端参数与连通性兜底 ----------
test('极端高填充率会触发保底开凿，且仍为单连通区域', () => {
  const cave = createCave(
    { w: 16, h: 12, rockFill: 85, smoothing: 12, decorationDensity: 60, style: 'forest' },
    99
  );
  assert.strictEqual(cave.stats.fallbackUsed, true, '极端参数应触发保底开凿');
  assertBorderRock(cave, '极端高填充率');
  assertSingleConnectedRegion(cave, '极端高填充率');
});

test('极端低填充率/零平滑也能清理成单连通区域', () => {
  const cave = createCave(
    { w: 100, h: 80, rockFill: 10, smoothing: 0, decorationDensity: 40, style: 'cave' },
    7
  );
  assertBorderRock(cave, '极端低填充率');
  assertSingleConnectedRegion(cave, '极端低填充率');
});

test('默认参数既保留洞穴岩壁，也保留足够可通行地面', () => {
  const cave = createCave(
    { w: 50, h: 38, rockFill: 47, smoothing: 4, decorationDensity: 12, style: 'cave' },
    20261017
  );
  const floorPercent = (cave.stats.floorCells / cave.stats.totalCells) * 100;
  assert(floorPercent > 5, `默认地图地面过少：${floorPercent.toFixed(1)}%`);
  assert(floorPercent < 95, `默认地图岩壁过少：地面占 ${floorPercent.toFixed(1)}%`);
});

test('参数越界会被安全钳制', () => {
  assert.strictEqual(clampInt('abc', 0, 10, 5), 5);
  assert.strictEqual(clampInt(999, 0, 10, 5), 10);
  assert.strictEqual(clampInt(-3, 0, 10, 5), 0);

  const opts = normalizeOptions({
    w: 1,
    h: 9999,
    rockFill: 999,
    smoothing: -2,
    decorationDensity: 500,
    style: '未知风格',
  });
  assert.strictEqual(opts.w, 16);
  assert.strictEqual(opts.h, 120);
  assert.strictEqual(opts.rockFill, 85);
  assert.strictEqual(opts.smoothing, 0);
  assert.strictEqual(opts.decorationDensity, 60);
  assert.strictEqual(opts.style, 'cave');

  const defaults = normalizeOptions({});
  assert.deepStrictEqual(defaults, {
    w: 50,
    h: 38,
    rockFill: 47,
    smoothing: 4,
    decorationDensity: 12,
    style: 'cave',
  });
});

// ---------- 5. 装饰物行为 ----------
test('林间风格会生成树木/灌木，洞穴风格只生成碎石/灌木', () => {
  const base = { w: 60, h: 45, rockFill: 45, smoothing: 4, decorationDensity: 35 };
  const forest = createCave({ ...base, style: 'forest' }, 2468);
  const cave = createCave({ ...base, style: 'cave' }, 2468);

  assert(forest.stats.decorationTotal > 0, '林间地图应有装饰物');
  assert(forest.stats.decorationCounts.tree > 0, '林间地图应生成树木');
  assert(forest.stats.decorationCounts.bush > 0, '林间地图应生成灌木');

  assert(cave.stats.decorationTotal > 0, '洞穴地图应有装饰物');
  assert.strictEqual(cave.stats.decorationCounts.tree, 0, '洞穴地图不应生成树木');
  assert(cave.stats.decorationCounts.rubble > 0, '洞穴地图应生成碎石');
});

// ---------- 6. TXT 摘要 ----------
test('TXT 摘要包含地形规模、连通区域、装饰物与种子信息', () => {
  const opts = { w: 50, h: 38, rockFill: 47, smoothing: 4, decorationDensity: 12, style: 'forest' };
  const cave = createCave(opts, 424242);
  const text = buildCaveSummary(cave, '测试种子');

  assert(text.includes('地形规模：50 × 38 格'), '摘要缺少地形规模');
  assert(text.includes('最大连通区域'), '摘要缺少连通区域大小');
  assert(text.includes(`最大连通区域 ${cave.stats.largestRegionSize} 格`), '连通区域数值不一致');
  assert(
    text.includes(`树木 ${cave.stats.decorationCounts.tree} · 灌木 ${cave.stats.decorationCounts.bush} · 碎石 ${cave.stats.decorationCounts.rubble}`),
    '装饰物数量不一致'
  );
  assert(text.includes('种子：测试种子'), '摘要缺少种子');
  assert(text.includes('可通行地面：'), '摘要缺少地面统计');
  assert(text.includes('孤立碎块：'), '摘要缺少孤立碎块统计');
});

// ---------- 汇总 ----------
console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  process.exitCode = 1;
}
