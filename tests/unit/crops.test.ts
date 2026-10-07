import { describe, expect, it } from 'vitest';
import { Orientation, Rect } from '../../src/core/orientation';
import { mapRectToDisplay, mapRectToOriginal } from '../../src/core/crop';
import {
  CropItem,
  MAX_CROPS,
  addCropItem,
  canAddCrop,
  createCropItem,
  displayRectForCrop,
  removeCropItem,
  validateCropName,
} from '../../src/core/crops';
import { ALL_ORIENTATIONS, EXPECTED, RAW_SIZE } from '../helpers/matrix';

const item = (id: string, name: string, rect: Rect): CropItem => ({ id, name, rect });

describe('裁片身份：保存时以原图坐标记录', () => {
  it.each(ALL_ORIENTATIONS)('方向 %i：createCropItem 记录的矩形等于 mapRectToOriginal', (o) => {
    const [w, h] = EXPECTED[o].size;
    const displayRect: Rect = { x: w - 1, y: 0, width: 1, height: h };
    const saved = createCropItem('crop-1', 'alpha', displayRect, RAW_SIZE, o);
    expect(saved.id).toBe('crop-1');
    expect(saved.name).toBe('alpha');
    expect(saved.rect).toEqual(mapRectToOriginal(displayRect, RAW_SIZE, o));
  });

  it('名称首尾空白被裁剪', () => {
    const saved = createCropItem('crop-1', '  alpha  ', { x: 0, y: 0, width: 1, height: 1 }, RAW_SIZE, 1);
    expect(saved.name).toBe('alpha');
  });

  it('非法显示矩形不能产生裁片', () => {
    expect(() =>
      createCropItem('crop-1', 'a', { x: 0, y: 0, width: 0, height: 0 }, RAW_SIZE, 1),
    ).toThrow();
    expect(() =>
      createCropItem('crop-1', 'a', { x: 2, y: 1, width: 2, height: 2 }, RAW_SIZE, 1),
    ).toThrow();
  });
});

describe('重投影：切换方向后由原图坐标重新计算显示矩形', () => {
  // 手工推导（与 orientation.test.ts 中 CASES 互为反向）：
  // 原图边缘条带在镜像/旋转后落到显示图的正确一侧。
  const CASES: Array<[Orientation, Rect, Rect]> = [
    [1, { x: 1, y: 0, width: 2, height: 2 }, { x: 1, y: 0, width: 2, height: 2 }],
    // 水平镜像：原图右列 ↔ 显示图左列
    [2, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 1, height: 2 }],
    // 旋转 180°：原图右下角像素 ↔ 显示图左上角像素
    [3, { x: 2, y: 1, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }],
    // 垂直镜像：原图底行 ↔ 显示图顶行
    [4, { x: 0, y: 1, width: 3, height: 1 }, { x: 0, y: 0, width: 3, height: 1 }],
    // 转置：原图顶行（横条）↔ 显示图左列（竖条）
    [5, { x: 0, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 1, height: 2 }],
    // 顺时针 90°：原图左列 ↔ 显示图顶行
    [6, { x: 0, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
    // 副对角翻转：原图右列 ↔ 显示图顶行
    [7, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
    // 逆时针 90°：原图右列 ↔ 显示图顶行
    [8, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
  ];

  it.each(CASES)('方向 %i：原图矩形 %j → 显示矩形 %j', (o, original, display) => {
    expect(mapRectToDisplay(original, RAW_SIZE, o)).toEqual(display);
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：显示 → 原图 → 显示 往返一致', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rects: Rect[] = [
      { x: 0, y: 0, width: w, height: h },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: w - 1, y: h - 1, width: 1, height: 1 },
      { x: 0, y: h - 1, width: w, height: 1 },
      { x: w - 1, y: 0, width: 1, height: h },
    ];
    for (const rect of rects) {
      const saved = createCropItem('c', 'n', rect, RAW_SIZE, o);
      expect(displayRectForCrop(saved, RAW_SIZE, o)).toEqual(rect);
    }
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：原图 → 显示 → 原图 往返一致', (o) => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: RAW_SIZE.width, height: RAW_SIZE.height },
      { x: 2, y: 0, width: 1, height: 2 },
      { x: 0, y: 1, width: 3, height: 1 },
      { x: 1, y: 0, width: 1, height: 1 },
    ];
    for (const rect of rects) {
      expect(mapRectToOriginal(mapRectToDisplay(rect, RAW_SIZE, o), RAW_SIZE, o)).toEqual(rect);
    }
  });

  it('切换方向必须重投影：旧显示坐标直接套到新方向会错位', () => {
    // 在方向 1 下框选左列竖条（显示 3×2）
    const saved = createCropItem('c', 'n', { x: 0, y: 0, width: 1, height: 2 }, RAW_SIZE, 1);
    expect(saved.rect).toEqual({ x: 0, y: 0, width: 1, height: 2 }); // 原图左列
    // 切到方向 2（水平镜像）：同一区域应重投影到显示图右列
    expect(displayRectForCrop(saved, RAW_SIZE, 2)).toEqual({ x: 2, y: 0, width: 1, height: 2 });
    // 切到方向 6（顺时针 90°，显示 2×3）：应重投影到显示图顶行
    expect(displayRectForCrop(saved, RAW_SIZE, 6)).toEqual({ x: 0, y: 0, width: 2, height: 1 });
    // 若错误地把旧显示坐标 (0,0,1,2) 直接套到方向 6，逆映射会指向原图底行右侧
    const naive = mapRectToOriginal({ x: 0, y: 0, width: 1, height: 2 }, RAW_SIZE, 6);
    expect(naive).not.toEqual(saved.rect);
  });

  it('非法原图矩形拒绝重投影', () => {
    expect(() => mapRectToDisplay({ x: 0, y: 0, width: 0, height: 1 }, RAW_SIZE, 1)).toThrow();
    expect(() => mapRectToDisplay({ x: 2, y: 1, width: 2, height: 2 }, RAW_SIZE, 1)).toThrow();
  });
});

describe('批次规则：至多八个、唯一命名', () => {
  it('空批次可添加，满 8 个后不可再添加', () => {
    let items: CropItem[] = [];
    expect(canAddCrop(items)).toBe(true);
    for (let i = 1; i <= MAX_CROPS; i++) {
      items = addCropItem(items, item(`crop-${i}`, `n${i}`, { x: 0, y: 0, width: 1, height: 1 }));
    }
    expect(items).toHaveLength(8);
    expect(canAddCrop(items)).toBe(false);
    expect(() =>
      addCropItem(items, item('crop-9', 'n9', { x: 0, y: 0, width: 1, height: 1 })),
    ).toThrow(/最多/);
  });

  it('名称校验：空、过长、非法字符、重复（大小写不敏感）', () => {
    const items = [item('crop-1', 'Alpha', { x: 0, y: 0, width: 1, height: 1 })];
    expect(validateCropName('   ', items)).toMatch(/空/);
    expect(validateCropName('x'.repeat(65), items)).toMatch(/过长/);
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(validateCropName(bad, items)).toMatch(/非法/);
    }
    expect(validateCropName('alpha', items)).toMatch(/已存在/);
    expect(validateCropName('ALPHA', items)).toMatch(/已存在/);
    expect(validateCropName('beta', items)).toBeNull();
    expect(validateCropName('裁片-甲_01', items)).toBeNull();
  });

  it('addCropItem 拒绝重复名称与重复 id', () => {
    const items = [item('crop-1', 'alpha', { x: 0, y: 0, width: 1, height: 1 })];
    expect(() =>
      addCropItem(items, item('crop-2', 'ALPHA', { x: 1, y: 0, width: 1, height: 1 })),
    ).toThrow(/已存在/);
    expect(() =>
      addCropItem(items, item('crop-1', 'beta', { x: 1, y: 0, width: 1, height: 1 })),
    ).toThrow(/id/);
  });

  it('removeCropItem 按 id 移除且不改原数组', () => {
    const items = [
      item('crop-1', 'a', { x: 0, y: 0, width: 1, height: 1 }),
      item('crop-2', 'b', { x: 1, y: 0, width: 1, height: 1 }),
    ];
    const next = removeCropItem(items, 'crop-1');
    expect(next.map((it) => it.id)).toEqual(['crop-2']);
    expect(items).toHaveLength(2); // 不可变
    expect(removeCropItem(items, 'missing')).toHaveLength(2);
  });
});
