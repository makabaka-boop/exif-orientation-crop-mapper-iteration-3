# EXIF 方向裁切工具

零后端的本地图片裁切页面：Vue 3 + TypeScript + Canvas，处理本地 PNG/JPEG，
不上传任何数据。核心难点是 **EXIF 方向 1～8 中包含镜像（2/4/5/7）而非单纯旋转**：
用户在「正向预览」上框出的裁切矩形，必须逐角逆变换回原始（存储方向）像素坐标，
否则会截到错误的角。

## 功能

- 选择本地 PNG/JPEG，解码为**存储方向**的原始像素（不让浏览器自动套用 EXIF）。
- 手动选择 EXIF 方向值 1～8，预览即时渲染为正向图像。
- 在预览上拖动出**整像素边界**的**半开**裁切矩形 `[x, x+w) × [y, y+h)`。
- 导出正向 PNG：从原始像素逐像素拷贝，**无缩放、无插值**，与预览逐像素一致。
- 导出 JSON：由同一映射生成，包含原图坐标（矩形 + 四角）与显示坐标。
- 方向或图片变更会使旧的异步解码与旧导出失效（代际令牌）；非法矩形
  （零面积/越界）保留当前图片，但导出按钮不可用。

## 方向映射（原图 W×H → 显示图）

| 值 | 含义 | 原图 (x,y) → 显示 (u,v) | 显示尺寸 |
|---|------|------------------------|----------|
| 1 | 原样 | (x, y) | W×H |
| 2 | 水平镜像 | (W-1-x, y) | W×H |
| 3 | 旋转 180° | (W-1-x, H-1-y) | W×H |
| 4 | 垂直镜像 | (x, H-1-y) | W×H |
| 5 | 主对角翻转 | (y, x) | H×W |
| 6 | 顺时针 90° | (H-1-y, x) | H×W |
| 7 | 副对角翻转 | (H-1-y, W-1-x) | H×W |
| 8 | 逆时针 90° | (y, W-1-x) | H×W |

裁切矩形的四角经**逆映射**回到原图坐标，取轴对齐包围盒得到原图矩形；
导出时输出像素 `(i,j)` 取自原图 `inverseMap(rect.x+i, rect.y+j)`，
因此镜像方向下显示图左侧的条带会正确映射到原图右侧。

纯函数核心在 `src/core/orientation.ts` 与 `src/core/crop.ts`，不依赖 DOM。

## 开发

```bash
npm install
npm run dev          # 开发服务器
npm run test:unit    # Vitest：2×3 非对称彩色矩阵逐项验证 8 种方向/逆变换/边界
npm run test:e2e     # Playwright：选图→裁切→导出，比对预览与下载文件逐像素一致
npm run typecheck    # vue-tsc
npm run build        # 类型检查 + 产出 dist/
```

首次运行 e2e 前需安装浏览器：`npx playwright install chromium`
（Linux 上还需系统依赖：`npx playwright install-deps chromium`，或把等价
`.deb` 解包后以 `LD_LIBRARY_PATH` 指向其 lib 目录）。

## Docker 托管

```bash
docker compose up --build
# 打开 http://localhost:8080
```

多阶段构建：Node 构建静态文件，nginx 托管，无任何后端服务。

## 说明

- JPEG 解码依赖 `createImageBitmap(..., { imageOrientation: 'none' })`
  以获得存储方向像素；不支持的浏览器回退到默认解码（可能自动套用 EXIF）。
- PNG 无 EXIF 方向，始终按存储像素处理。
