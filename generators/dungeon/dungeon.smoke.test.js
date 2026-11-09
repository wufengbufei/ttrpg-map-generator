/* =========================================================
 * 地牢生成器 Node 冒烟测试
 * 运行：node generators/dungeon/dungeon.smoke.test.js
 *
 * 覆盖：种子复现、连通、入口出口、门、地点注记、圆形房间
 * ========================================================= */

const {
  createDungeon,
  hashStringToSeed,
  buildDungeonText,
  DUNGEON_HOOKS,
  FLOOR,
  DOOR,
  TRAP,
  TREASURE,
} = require('./dungeon.js');

let checkCount = 0;
let failureCount = 0;

function check(condition, message) {
  checkCount++;
  if (!condition) throw new Error(message);
}

const DEFAULTS = {
  w: 50,
  h: 36,
  roomCount: 14,
  roomMin: 4,
  roomMax: 9,
  loopiness: 15,
  trapChance: 12,
  treasureChance: 18,
};

function walkable(v) {
  return v === FLOOR || v === DOOR || v === TRAP || v === TREASURE;
}

function snapshot(dungeon) {
  return JSON.stringify({
    entranceId: dungeon.entranceId,
    exitId: dungeon.exitId,
    grid: dungeon.grid,
    rooms: dungeon.rooms.map(r => ({
      id: r.id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      shape: r.shape,
      hook: r.hook,
      hasStairs: r.hasStairs,
      hasTrap: r.hasTrap,
      hasTreasure: r.hasTreasure,
    })),
  });
}

function assertConnected(dungeon, label) {
  check(dungeon.allRoomsReachable(), `${label} 有房间从入口走不到`);
  if (dungeon.rooms.length > 1) {
    check(dungeon.entranceId !== dungeon.exitId, `${label} 入口和出口是同一间`);
  }
  let doors = 0;
  for (let i = 0; i < dungeon.grid.length; i++) if (dungeon.grid[i] === DOOR) doors++;
  if (dungeon.rooms.length >= 2) check(doors >= 1, `${label} 没有门`);
  const hooks = dungeon.rooms.filter(r => r.hook);
  check(hooks.length >= 1, `${label} 没有地点注记`);
  for (const room of hooks) {
    check(room.hook.length > 0, `${label} 房间 ${room.id} 注记为空`);
    check(DUNGEON_HOOKS.includes(room.hook), `${label} 房间 ${room.id} 注记不在词库中`);
  }
  for (const room of dungeon.rooms) {
    check(room.shape === 'rect' || room.shape === 'circle', `${label} 房间形状异常`);
    if (room.shape !== 'circle') continue;
    const cell = dungeon.walkableCellInRoom(room);
    check(cell && walkable(dungeon.get(cell[0], cell[1])), `${label} 圆室 ${room.id} 中心不可走`);
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

console.log('\n[1] 默认参数与连通');
runCase('默认种子可生成、全连通、有注记', () => {
  const dungeon = createDungeon(DEFAULTS, 95850142);
  assertConnected(dungeon, '默认');
  const text = buildDungeonText(dungeon, '95850142');
  const hooked = dungeon.rooms.filter(r => r.hook);
  check(text.includes(hooked[0].hook), '清单未写入地点注记');
  check(text.includes('入口'), '清单未标入口');
  return `房间 ${dungeon.rooms.length}、注记 ${hooked.length}、圆室 ${dungeon.rooms.filter(r => r.shape === 'circle').length}`;
});

const combos = [
  { w: 24, h: 18, roomCount: 6, roomMin: 4, roomMax: 7, loopiness: 0, trapChance: 0, treasureChance: 0 },
  { w: 40, h: 28, roomCount: 20, roomMin: 3, roomMax: 8, loopiness: 30, trapChance: 20, treasureChance: 25 },
  { w: 60, h: 40, roomCount: 12, roomMin: 5, roomMax: 12, loopiness: 10, trapChance: 5, treasureChance: 10 },
];
combos.forEach((opts, i) => {
  runCase(`组合 ${i + 1} 连通且有注记`, () => {
    const dungeon = createDungeon(opts, 7000 + i * 17);
    assertConnected(dungeon, `组合 ${i + 1}`);
    return `房间 ${dungeon.rooms.length}`;
  });
});

console.log('\n[2] 种子复现');
runCase('相同种子两次完全一致', () => {
  const a = snapshot(createDungeon(DEFAULTS, 424242));
  const b = snapshot(createDungeon(DEFAULTS, 424242));
  check(a === b, '相同种子快照不一致');
  return `快照 ${a.length} 字符`;
});
runCase('不同种子结果不同', () => {
  const a = snapshot(createDungeon(DEFAULTS, 424242));
  const b = snapshot(createDungeon(DEFAULTS, 424243));
  check(a !== b, '不同种子生成了相同结果');
});
runCase('文字种子稳定', () => {
  const s1 = hashStringToSeed('月王地牢');
  const s2 = hashStringToSeed('月王地牢');
  check(s1 === s2, '文字种子哈希不稳定');
  check(snapshot(createDungeon(DEFAULTS, s1)) === snapshot(createDungeon(DEFAULTS, s2)), '文字种子地图不一致');
});
runCase('生成过程不调用 Math.random', () => {
  const original = Math.random;
  let called = false;
  Math.random = () => { called = true; return 0.5; };
  try {
    createDungeon(DEFAULTS, 987654321);
  } finally {
    Math.random = original;
  }
  check(!called, '生成过程中调用了 Math.random');
});

console.log('\n[3] 圆形房间会出现');
runCase('若干种子里至少有一间圆室', () => {
  let circles = 0;
  for (let s = 1; s <= 24; s++) {
    const dungeon = createDungeon(DEFAULTS, 3000 + s * 13);
    assertConnected(dungeon, `圆室扫描 ${s}`);
    circles += dungeon.rooms.filter(r => r.shape === 'circle').length;
  }
  check(circles >= 1, '24 个种子都没有圆形房间');
  return `共 ${circles} 间`;
});

console.log('\n' + '='.repeat(56));
if (failureCount === 0) {
  console.log(`冒烟测试全部通过：${checkCount} 项断言，0 失败`);
} else {
  console.error(`冒烟测试失败：${checkCount} 项断言，${failureCount} 个用例失败`);
  process.exitCode = 1;
}
console.log('='.repeat(56) + '\n');
