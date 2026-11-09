/* =========================================================
 * 村庄生成器 Node 冒烟测试
 * 运行：node generators/village/village.smoke.test.js
 * ========================================================= */

const { createVillage, hashStringToSeed, buildVillageText } = require('./village.js');

let checkCount = 0;
let failureCount = 0;

function check(condition, message) {
  checkCount++;
  if (!condition) throw new Error(message);
}

const DEFAULTS = {
  buildingCount: 16,
  villageRadius: 280,
  roadCurve: 40,
  roadDensity: 30,
  fenceEnabled: true,
};

function snapshot(village) {
  return JSON.stringify({
    name: village.name,
    population: village.population,
    buildings: village.buildings.map(b => ({
      id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, type: b.type, angle: b.angle,
    })),
    roads: village.roads,
    fields: village.fields,
    trees: village.trees,
    fence: village.fence,
  });
}

function assertVillage(village, label) {
  check(village.buildings.length === village.opts.buildingCount, `${label} 建筑数量不符`);
  check(village.name && village.name.length > 0, `${label} 没有村名`);
  check(village.population > 0, `${label} 人口不是正数`);
  check(village.fields.length >= 1, `${label} 没有地块`);
  for (const field of village.fields) {
    check(field.kind === 'field' || field.kind === 'orchard', `${label} 地块类型异常`);
    check(field.w > 0 && field.h > 0, `${label} 地块尺寸异常`);
  }
  check(village.trees.length >= 1, `${label} 没有树丛`);
  for (const tree of village.trees) {
    check(tree.lobes && tree.lobes.length >= 3, `${label} 树丛叶片不足`);
  }
  if (village.opts.fenceEnabled) check(village.fence && village.fence.length >= 3, `${label} 围栏缺失`);
  else check(village.fence === null || village.fence === undefined, `${label} 关闭围栏后仍有围栏`);
  if (village.buildings.length >= 2) {
    check(village.roads.length >= village.buildings.length - 1, `${label} 道路不足以连通`);
  }
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

console.log('\n[1] 默认参数');
runCase('默认种子有村名、人口和地块', () => {
  const village = createVillage(DEFAULTS, 15335300);
  assertVillage(village, '默认');
  const text = buildVillageText(village, '15335300');
  check(text.includes(village.name), '清单缺少村名');
  check(text.includes(String(village.population)), '清单缺少人口');
  check(text.includes('地块'), '清单缺少地块');
  return `${village.name}，约 ${village.population} 人，地块 ${village.fields.length}，树丛 ${village.trees.length}`;
});

const combos = [
  { buildingCount: 5, villageRadius: 160, roadCurve: 0, roadDensity: 0, fenceEnabled: false },
  { buildingCount: 16, villageRadius: 280, roadCurve: 40, roadDensity: 30, fenceEnabled: true },
  { buildingCount: 28, villageRadius: 320, roadCurve: 80, roadDensity: 50, fenceEnabled: true },
  { buildingCount: 40, villageRadius: 360, roadCurve: 20, roadDensity: 10, fenceEnabled: false },
];
combos.forEach((opts, i) => {
  runCase(`组合 ${i + 1} 地块不少于 1`, () => {
    const village = createVillage(opts, 9000 + i * 19);
    assertVillage(village, `组合 ${i + 1}`);
    return `${village.name} / 地块 ${village.fields.length}`;
  });
});

console.log('\n[2] 种子复现');
runCase('相同种子两次完全一致', () => {
  const a = snapshot(createVillage(DEFAULTS, 424242));
  const b = snapshot(createVillage(DEFAULTS, 424242));
  check(a === b, '相同种子快照不一致');
  return `快照 ${a.length} 字符`;
});
runCase('不同种子结果不同', () => {
  const a = snapshot(createVillage(DEFAULTS, 424242));
  const b = snapshot(createVillage(DEFAULTS, 424243));
  check(a !== b, '不同种子生成了相同结果');
});
runCase('文字种子稳定', () => {
  const s = hashStringToSeed('柳湾外的村子');
  check(snapshot(createVillage(DEFAULTS, s)) === snapshot(createVillage(DEFAULTS, hashStringToSeed('柳湾外的村子'))), '文字种子不一致');
});
runCase('生成过程不调用 Math.random', () => {
  const original = Math.random;
  let called = false;
  Math.random = () => { called = true; return 0.5; };
  try {
    createVillage(DEFAULTS, 987654321);
  } finally {
    Math.random = original;
  }
  check(!called, '生成过程中调用了 Math.random');
});

console.log('\n' + '='.repeat(56));
if (failureCount === 0) {
  console.log(`冒烟测试全部通过：${checkCount} 项断言，0 失败`);
} else {
  console.error(`冒烟测试失败：${checkCount} 项断言，${failureCount} 个用例失败`);
  process.exitCode = 1;
}
console.log('='.repeat(56) + '\n');
