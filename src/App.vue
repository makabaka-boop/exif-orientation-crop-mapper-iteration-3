<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ORIENTATIONS,
  Orientation,
  PixelImage,
  Rect,
  buildOriented,
  orientedSize,
} from './core/orientation';
import {
  buildCropMetadata,
  exportCrop,
  isValidRect,
  mapRectToOriginal,
  rectFromBounds,
} from './core/crop';

const ORIENTATION_LABELS: Record<Orientation, string> = {
  1: '1 · 原样',
  2: '2 · 水平镜像',
  3: '3 · 旋转 180°',
  4: '4 · 垂直镜像',
  5: '5 · 主对角翻转（转置）',
  6: '6 · 顺时针 90°',
  7: '7 · 副对角翻转',
  8: '8 · 逆时针 90°',
};

const rawImage = ref<PixelImage | null>(null);
const fileInfo = ref<{ name: string; type: string } | null>(null);
const orientation = ref<Orientation>(1);
const cropRect = ref<Rect | null>(null);
const dragRect = ref<Rect | null>(null);
const status = ref('请选择本地 PNG/JPEG 图片。');

/**
 * 代际令牌：图片或方向每次变更都 +1。
 * 异步解码 / 异步导出完成后比对令牌，不一致即丢弃结果，
 * 保证旧解码与旧导出不会覆盖当前状态。
 */
let generation = 0;
let currentFile: File | null = null;

const previewCanvas = ref<HTMLCanvasElement | null>(null);
let dragging = false;
let dragAnchor = { x: 0, y: 0 };

const displaySize = computed(() =>
  rawImage.value ? orientedSize(rawImage.value, orientation.value) : null,
);

const validCrop = computed(
  () =>
    rawImage.value !== null &&
    cropRect.value !== null &&
    isValidRect(cropRect.value, orientedSize(rawImage.value, orientation.value)),
);

const originalRect = computed(() =>
  validCrop.value && rawImage.value && cropRect.value
    ? mapRectToOriginal(cropRect.value, rawImage.value, orientation.value)
    : null,
);

const metadataJson = computed(() => {
  if (!validCrop.value || !rawImage.value || !cropRect.value || !fileInfo.value) return '';
  return JSON.stringify(
    buildCropMetadata(rawImage.value, fileInfo.value, orientation.value, cropRect.value),
    null,
    2,
  );
});

const overlayStyle = computed(() => {
  const rect = dragRect.value ?? (validCrop.value ? cropRect.value : null);
  const canvas = previewCanvas.value;
  if (!rect || !canvas || rect.width <= 0 || rect.height <= 0) return { display: 'none' };
  const box = canvas.getBoundingClientRect();
  const sx = box.width / canvas.width;
  const sy = box.height / canvas.height;
  return {
    display: 'block',
    left: `${rect.x * sx}px`,
    top: `${rect.y * sy}px`,
    width: `${rect.width * sx}px`,
    height: `${rect.height * sy}px`,
  };
});

function invalidatePending(): void {
  generation++;
  cropRect.value = null;
  dragRect.value = null;
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  currentFile = file;
  await loadFile(file);
}

async function loadFile(file: File): Promise<void> {
  const gen = ++generation;
  cropRect.value = null;
  dragRect.value = null;
  rawImage.value = null;
  fileInfo.value = null;
  status.value = '解码中…';

  try {
    const pixels = await decodeFile(file);
    if (gen !== generation) {
      // 结果已过期，必须丢弃。若当前文件未变（仅是方向变更触发了
      // 失效），用新代际重新解码，避免图片卡在未加载状态。
      if (currentFile === file) await loadFile(file);
      return;
    }
    rawImage.value = pixels;
    fileInfo.value = { name: file.name, type: file.type };
    status.value = '在预览上拖动以框选裁切区域。';
  } catch (err) {
    if (gen !== generation) return;
    status.value = `解码失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 解码为「存储方向」的原始像素（不让浏览器自动套用 EXIF）。 */
async function decodeFile(file: File): Promise<PixelImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 2D 上下文');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: imageData.width, height: imageData.height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

function selectOrientation(value: Orientation): void {
  if (value === orientation.value) return;
  orientation.value = value;
  invalidatePending(); // 方向变更：旧裁切、旧导出全部失效
  if (rawImage.value) status.value = '方向已变更，请重新框选裁切区域。';
}

function imageBoundary(event: PointerEvent): { x: number; y: number } {
  const canvas = previewCanvas.value!;
  const box = canvas.getBoundingClientRect();
  const x = Math.round(((event.clientX - box.left) / box.width) * canvas.width);
  const y = Math.round(((event.clientY - box.top) / box.height) * canvas.height);
  return {
    x: Math.min(Math.max(x, 0), canvas.width),
    y: Math.min(Math.max(y, 0), canvas.height),
  };
}

function onPointerDown(event: PointerEvent): void {
  if (!rawImage.value || !previewCanvas.value) return;
  dragging = true;
  previewCanvas.value.setPointerCapture(event.pointerId);
  dragAnchor = imageBoundary(event);
  dragRect.value = rectFromBounds(dragAnchor.x, dragAnchor.y, dragAnchor.x, dragAnchor.y);
  cropRect.value = null;
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return;
  const p = imageBoundary(event);
  dragRect.value = rectFromBounds(dragAnchor.x, dragAnchor.y, p.x, p.y);
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  const p = imageBoundary(event);
  const rect = rectFromBounds(dragAnchor.x, dragAnchor.y, p.x, p.y);
  dragRect.value = null;
  cropRect.value = rect;
  if (!rawImage.value || !isValidRect(rect, orientedSize(rawImage.value, orientation.value))) {
    status.value = '裁切矩形无效（面积为 0 或越界），图片保持不变，导出不可用。';
  } else {
    status.value = '裁切区域有效，可以导出。';
  }
}

watch([rawImage, orientation], async () => {
  await nextTick();
  renderPreview();
});

function renderPreview(): void {
  const canvas = previewCanvas.value;
  const img = rawImage.value;
  if (!canvas || !img) return;
  const oriented = buildOriented(img, orientation.value);
  canvas.width = oriented.width;
  canvas.height = oriented.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(new ImageData(oriented.data, oriented.width, oriented.height), 0, 0);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function baseName(): string {
  return (fileInfo.value?.name ?? 'image').replace(/\.[^.]+$/, '');
}

async function exportPng(): Promise<void> {
  const img = rawImage.value;
  const rect = cropRect.value;
  const o = orientation.value;
  if (!img || !rect || !isValidRect(rect, orientedSize(img, o))) return;

  const gen = generation;
  const out = exportCrop(img, rect, o);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext('2d')!.putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (gen !== generation) return; // 等待期间图片或方向已变更，旧导出作废
  if (!blob) return;
  triggerDownload(blob, `${baseName()}-crop-o${o}.png`);
  status.value = '已导出正向 PNG（原始像素，无缩放）。';
}

async function exportJson(): Promise<void> {
  const img = rawImage.value;
  const rect = cropRect.value;
  const info = fileInfo.value;
  const o = orientation.value;
  if (!img || !rect || !info || !isValidRect(rect, orientedSize(img, o))) return;

  const gen = generation;
  const json = JSON.stringify(buildCropMetadata(img, info, o, rect), null, 2);
  await Promise.resolve();
  if (gen !== generation) return;
  triggerDownload(new Blob([json], { type: 'application/json' }), `${baseName()}-crop-o${o}.json`);
  status.value = '已导出包含原图坐标的 JSON。';
}
</script>

<template>
  <main class="app">
    <h1>EXIF 方向裁切工具</h1>
    <p class="hint">
      本地处理，零后端。选择图片与 EXIF 方向（含镜像），在正向预览上拖动整像素边界的半开矩形，
      导出时四角会逆变换回原图坐标。
    </p>

    <section class="controls">
      <label class="file-label">
        图片（PNG/JPEG）
        <input
          data-testid="file-input"
          type="file"
          accept="image/png,image/jpeg"
          @change="onFileChange"
        />
      </label>

      <fieldset class="orientations">
        <legend>EXIF 方向</legend>
        <label v-for="o in ORIENTATIONS" :key="o" class="orientation-option">
          <input
            type="radio"
            name="orientation"
            :data-testid="`orientation-${o}`"
            :checked="orientation === o"
            @change="selectOrientation(o)"
          />
          {{ ORIENTATION_LABELS[o] }}
        </label>
      </fieldset>
    </section>

    <p data-testid="status" class="status">{{ status }}</p>

    <section v-if="rawImage && displaySize" class="stage">
      <p data-testid="display-size">
        原图 {{ rawImage.width }}×{{ rawImage.height }} → 显示 {{ displaySize.width }}×{{
          displaySize.height
        }}
      </p>
      <div class="canvas-wrap">
        <canvas
          ref="previewCanvas"
          data-testid="preview-canvas"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="dragging = false"
        ></canvas>
        <div class="overlay" :style="overlayStyle"></div>
      </div>

      <div class="panels">
        <div class="panel">
          <h2>裁切矩形</h2>
          <p v-if="!cropRect">尚未框选。</p>
          <template v-else>
            <p data-testid="display-rect">
              显示坐标：x={{ cropRect.x }}, y={{ cropRect.y }}, w={{ cropRect.width }}, h={{
                cropRect.height
              }}
            </p>
            <p v-if="originalRect" data-testid="original-rect">
              原图坐标：x={{ originalRect.x }}, y={{ originalRect.y }}, w={{ originalRect.width }},
              h={{ originalRect.height }}
            </p>
            <p v-if="!validCrop" class="invalid">矩形无效：保留当前图片，导出不可用。</p>
          </template>
          <div class="actions">
            <button data-testid="export-png" :disabled="!validCrop" @click="exportPng">
              导出 PNG
            </button>
            <button data-testid="export-json" :disabled="!validCrop" @click="exportJson">
              导出 JSON
            </button>
          </div>
        </div>
        <div class="panel">
          <h2>JSON 预览</h2>
          <pre data-testid="json-preview">{{ metadataJson || '（无有效裁切）' }}</pre>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.app {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  font-family: system-ui, sans-serif;
}
.hint {
  color: #555;
}
.controls {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.file-label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-weight: 600;
}
.orientations {
  display: grid;
  grid-template-columns: repeat(2, auto);
  gap: 4px 16px;
  border: 1px solid #ccc;
  border-radius: 6px;
  padding: 8px 12px;
}
.orientation-option {
  white-space: nowrap;
  cursor: pointer;
}
.status {
  padding: 8px 12px;
  background: #f0f4ff;
  border-radius: 6px;
}
.canvas-wrap {
  position: relative;
  display: inline-block;
  border: 1px solid #999;
  line-height: 0;
  touch-action: none;
}
canvas {
  image-rendering: pixelated;
  cursor: crosshair;
}
.overlay {
  position: absolute;
  border: 1px dashed #ff2d55;
  background: rgba(255, 45, 85, 0.15);
  pointer-events: none;
  display: none;
}
.panels {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.panel {
  min-width: 280px;
}
.invalid {
  color: #c00;
}
.actions {
  display: flex;
  gap: 8px;
}
button {
  padding: 6px 14px;
}
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
pre {
  background: #f6f6f6;
  padding: 8px;
  font-size: 12px;
  max-height: 260px;
  overflow: auto;
}
</style>
