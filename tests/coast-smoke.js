/* =========================================================
 * 海岸生成器 Node 冒烟测试
 * 运行：node tests/coast-smoke.js
 *
 * 覆盖：
 *   1. 不同参数组合生成不报错、数据自洽
 *   2. 同种子复现一致、不同种子结果不同
 *   3. 实际陆地比例符合滑块设定
 *   4. 特征点数量、编号、类型与方位描述
 *   5. 特征点均位于陆地海岸带
 *   6. 导出 TXT 清单内容完整
 *   7. 边界参数与特殊种子
 *   8. 参数确实改变噪声高度场
 *   9. hashStringToSeed 稳定且可区分
 *
 * 说明：PNG 导出依赖浏览器 Canvas，不在 Node 冒烟范围内。
 * ========================================================= */
'use strict';

const assert = require('assert');
const path = require('path');

const coastMod = require(path.join(__dirname, '..', 'generators', 'coast', 'coast.js'));
const {
  generateCoast,
  hashStringToSeed,
  FEATURE_TYPES,
  directionFromCenter,
  buildCoastListText,
} = coastMod;

let passed = 0;
const failures = [];
const startedAt = Date.now();

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.error('  ✗ ' + name);
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : String(err);
    console.error('    ' + detail);
  }
}

function heightsChecksum(coast) {
  const bytes = Buffer.from(
    coast.heights.buffer,
    coast.heights.byteOffset,
    coast.heights.byteLength
  );
  let h = 1779033703;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function snapshot(coast) {
  return {
    threshold: coast.threshold,
    landCount: coast.landCount,
    landRatioActual: coast.landRatioActual,
    heightsChecksum: heightsChecksum(coast),
    contourCount: coast.contours.length,
    features: coast.features,
  };
}

const VALID_DIRECTIONS = new Set(['东', '东南', '南', '西南', '西', '西北', '北', '东北']);
const BASE = { landRatio: 45, complexity: 4, featureCount: 8, seed: 20261017 };

console.log('海岸生成器冒烟测试');
console.log('模块加载：成功（未依赖 window / document）\n');

test('不同参数组合均可生成，且基础数据自洽', () => {
  const combos = [];
  for (const landRatio of [20, 35, 45, 60, 80]) {
    for (const complexity of [1, 4, 8]) {
      combos.push({
        landRatio,
        complexity,
        featureCount: (landRatio + complexity) % 21,
        seed: 9000 + landRatio * 10 + complexity,
      });
    }
  }

  for (const combo of combos) {
    const coast = generateCoast(combo);
    assert.strictEqual(coast.heights.length, 200 * 200);
    assert.ok(coast.features.length <= combo.featureCount);
    assert.ok(coast.landRatioActual > 0.15 && coast.landRatioActual < 0.85);
    assert.ok(Number.isFinite(coast.threshold));
    assert.ok(Array.isArray(coast.contours));
    assert.ok(Array.isArray(coast.elevationContours));
    assert.ok(Array.isArray(coast.depthContours));
  }
});

test('同种子复现一致，不同种子结果不同', () => {
  const a1 = generateCoast(BASE);
  const a2 = generateCoast(BASE);
  assert.deepStrictEqual(snapshot(a1), snapshot(a2));

  const b = generateCoast(Object.assign({}, BASE, { seed: BASE.seed + 1 }));
  assert.notStrictEqual(heightsChecksum(a1), heightsChecksum(b));

  const seed = hashStringToSeed('东北海岸');
  const c = generateCoast(Object.assign({}, BASE, { seed }));
  const d = generateCoast(Object.assign({}, BASE, { seed }));
  assert.deepStrictEqual(snapshot(c), snapshot(d));
});

test('实际陆地比例符合滑块设定（误差 ≤ 1%）', () => {
  for (const landRatio of [20, 30, 45, 60, 80]) {
    const coast = generateCoast(Object.assign({}, BASE, {
      landRatio,
      seed: 3000 + landRatio,
    }));
    const actualPct = coast.landRatioActual * 100;
    assert.ok(
      Math.abs(actualPct - landRatio) <= 1,
      '设定 ' + landRatio + '%，实际 ' + actualPct.toFixed(2) + '%'
    );
    const maskSum = coast.land.reduce((s, v) => s + v, 0);
    assert.strictEqual(coast.landCount, maskSum);
  }
});

test('特征点数量准确、编号连续、方位与类型合法', () => {
  for (const featureCount of [0, 1, 5, 12, 20]) {
    const coast = generateCoast(Object.assign({}, BASE, {
      featureCount,
      seed: 4000 + featureCount,
    }));
    assert.strictEqual(coast.features.length, featureCount,
      '特征数应为 ' + featureCount + '，实际 ' + coast.features.length);

    const ids = coast.features.map(f => f.id);
    assert.deepStrictEqual(ids, Array.from({ length: featureCount }, (_, i) => i + 1));

    for (let i = 1; i < coast.features.length; i++) {
      assert.ok(coast.features[i].y >= coast.features[i - 1].y - 1e-9,
        '特征应按从上到下编号');
    }

    for (const f of coast.features) {
      assert.ok(FEATURE_TYPES[f.type], '未知类型：' + f.type);
      assert.ok(VALID_DIRECTIONS.has(f.direction), '非法方位：' + f.direction);
      assert.ok(f.distanceToCoast >= 1);
      assert.strictEqual(f.direction, directionFromCenter(f.x, f.y));
    }
  }
});

test('特征点均位于陆地一侧的海岸带内', () => {
  const coast = generateCoast(Object.assign({}, BASE, {
    featureCount: 12,
    seed: 5050,
  }));
  assert.strictEqual(coast.features.length, 12);
  for (const f of coast.features) {
    const idx = f.cellY * 200 + f.cellX;
    assert.strictEqual(coast.land[idx], 1, '特征 ' + f.id + ' 落在海里');
    const d = coast.distToSea[idx];
    assert.ok(d >= 1 && d <= 16, '特征 ' + f.id + ' 离海岸过远：' + d + ' 格');
  }
});

test('导出 TXT 清单包含种子、参数与全部特征', () => {
  const coast = generateCoast(Object.assign({}, BASE, { featureCount: 9, seed: 777 }));
  const text = buildCoastListText(coast, '港口测试');

  assert.ok(text.includes('种子：港口测试'));
  assert.ok(text.includes('陆地比例设定：45%'));
  assert.strictEqual((text.match(/^特征 \d+：/gm) || []).length, 9);
  for (const f of coast.features) {
    assert.ok(text.includes(f.direction + '侧' + f.type),
      '清单缺少：' + f.direction + '侧' + f.type);
  }

  const empty = generateCoast(Object.assign({}, BASE, { featureCount: 0 }));
  assert.ok(buildCoastListText(empty, '空海岸').includes('没有地形特征点'));
});

test('边界参数与特殊种子不报错', () => {
  const cases = [
    { landRatio: 20, complexity: 1, featureCount: 0, seed: 0 },
    { landRatio: 20, complexity: 8, featureCount: 20, seed: 0xFFFFFFFF },
    { landRatio: 80, complexity: 1, featureCount: 20, seed: 1 },
    { landRatio: 80, complexity: 8, featureCount: 0, seed: 4294967295 },
    { landRatio: 50, complexity: 8, featureCount: 20, seed: hashStringToSeed('中文种子-🌊') },
  ];

  for (const c of cases) {
    const coast = generateCoast(c);
    assert.ok(coast.landCount > 0 && coast.landCount < 40000);
    assert.ok(coast.contours.length > 0, '海岸线应产生等值线分段');
    if (c.featureCount > 0) {
      assert.ok(coast.features.length > 0);
    }
  }
});

test('曲折度参数确实改变噪声高度场', () => {
  const smooth = generateCoast(Object.assign({}, BASE, { complexity: 1, seed: 8080 }));
  const rough = generateCoast(Object.assign({}, BASE, { complexity: 8, seed: 8080 }));
  assert.notStrictEqual(heightsChecksum(smooth), heightsChecksum(rough));
});

test('hashStringToSeed 稳定且可区分输入', () => {
  assert.strictEqual(hashStringToSeed('灯塔'), hashStringToSeed('灯塔'));
  assert.notStrictEqual(hashStringToSeed('灯塔'), hashStringToSeed('礁石'));
  assert.strictEqual(hashStringToSeed(''), hashStringToSeed(''));
  const h = hashStringToSeed('海岸');
  assert.ok(h >= 0 && h <= 4294967295);
});

const elapsed = Date.now() - startedAt;
console.log('\n结果：' + passed + ' 通过，' + failures.length + ' 失败（' + elapsed + ' ms）');
if (failures.length > 0) {
  console.error('失败用例：' + failures.map(f => f.name).join('、'));
  process.exitCode = 1;
} else {
  console.log('全部通过。');
  console.log('注意：PNG 导出与画布渲染需在浏览器页面中人工验证。');
}
