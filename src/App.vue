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
import {
  MAX_CROPS,
  SavedCrop,
  addCrop,
  cropNameError,
  mapRectToDisplay,
  normalizeCropName,
  removeCrop,
} from './core/batch';
import { MANIFEST_FILE_NAME, buildManifest } from './core/delivery';
import { ZipEntry, buildZip } from './core/zip';

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

/** 多裁片工作区：已保存裁片（身份 + 原图坐标），与输入框中的候选名称。 */
const savedCrops = ref<SavedCrop[]>([]);
const cropNameInput = ref('');
const packaging = ref(false);

/**
 * 代际令牌：图片或方向每次变更都 +1。
 * 异步解码 / 异步导出完成后比对令牌，不一致即丢弃结果，
 * 保证旧解码与旧导出不会覆盖当前状态。
 */
let generation = 0;
/**
 * 裁片列表版本：每次增删/清空裁片都 +1。
 * 打包跨越多个异步编码，期间任何裁片变更都必须让整包作废。
 */
let cropVersion = 0;
let cropSeq = 0;
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

/** 画布像素 → CSS 像素的缩放换算，当前框选与已保存裁片共用。 */
function rectOverlayStyle(rect: Rect): Record<string, string> {
  const canvas = previewCanvas.value;
  if (!canvas || rect.width <= 0 || rect.height <= 0) return { display: 'none' };
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
}

const overlayStyle = computed(() => {
  const rect = dragRect.value ?? (validCrop.value ? cropRect.value : null);
  if (!rect) return { display: 'none' };
  return rectOverlayStyle(rect);
});

/**
 * 已保存裁片的当前投影：每次渲染都按当前方向从原图坐标重新计算，
 * 与打包清单用的是同一个 mapRectToDisplay，保证预览与交付一致。
 */
const savedCropViews = computed(() => {
  const img = rawImage.value;
  if (!img) return [];
  return savedCrops.value.map((crop) => ({
    crop,
    displayRect: mapRectToDisplay(crop.originalRect, img, orientation.value),
  }));
});

const normalizedCropName = computed(() => normalizeCropName(cropNameInput.value));

const cropNameProblem = computed(() =>
  cropNameError(normalizedCropName.value, savedCrops.value),
);

const canSaveCrop = computed(
  () =>
    validCrop.value &&
    cropNameProblem.value === null &&
    savedCrops.value.length < MAX_CROPS,
);

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
  savedCrops.value = []; // 换图：旧裁片（原图坐标）对新图毫无意义，全部清空
  cropVersion++;
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
  if (rawImage.value) {
    status.value = '方向已变更：当前框选已清除，已保存裁片按新方向重新投影。';
  }
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

/** 把正向像素编码为 PNG（无缩放、无插值），单裁片导出与打包共用。 */
function encodePng(img: PixelImage): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * 测试钩子：若页面注入了 window.__exifCropEncodeHook，打包时
 * 每个裁片编码前都会等待它——用于在 e2e 中制造「迟到的编码」。
 */
async function runEncodeHook(file: string): Promise<void> {
  const hook = (
    window as unknown as { __exifCropEncodeHook?: (file: string) => unknown }
  ).__exifCropEncodeHook;
  if (hook) await hook(file);
}

async function exportPng(): Promise<void> {
  const img = rawImage.value;
  const rect = cropRect.value;
  const o = orientation.value;
  if (!img || !rect || !isValidRect(rect, orientedSize(img, o))) return;

  const gen = generation;
  const out = exportCrop(img, rect, o);
  const blob = await encodePng(out);
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

/** 把当前有效框选保存为裁片：立即换算成原图坐标固化下来。 */
function saveCrop(): void {
  const img = rawImage.value;
  const rect = cropRect.value;
  if (!img || !rect || !validCrop.value) return;
  const name = normalizedCropName.value;
  const problem = cropNameProblem.value;
  if (problem !== null) {
    status.value = `无法保存裁片：${problem}。`;
    return;
  }
  if (savedCrops.value.length >= MAX_CROPS) {
    status.value = `最多保存 ${MAX_CROPS} 个裁片。`;
    return;
  }
  const originalRect = mapRectToOriginal(rect, img, orientation.value);
  const crop: SavedCrop = { id: `crop-${++cropSeq}`, name, originalRect };
  try {
    savedCrops.value = addCrop(savedCrops.value, crop, img);
  } catch (err) {
    status.value = `无法保存裁片：${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  cropVersion++;
  cropNameInput.value = '';
  status.value =
    `已保存裁片「${name}」：原图坐标 x=${originalRect.x}, y=${originalRect.y}, ` +
    `w=${originalRect.width}, h=${originalRect.height}。`;
}

function removeCropById(id: string): void {
  const target = savedCrops.value.find((c) => c.id === id);
  if (!target) return;
  savedCrops.value = removeCrop(savedCrops.value, id);
  cropVersion++;
  status.value = `已删除裁片「${target.name}」。`;
}

/**
 * 交付 ZIP：从同一图片、方向与裁片列表的快照生成。
 * 任一裁片编码失败，或生成期间换图 / 改方向 / 改裁片，
 * 整包立即作废，绝不下载残缺或过期内容。
 */
async function exportZip(): Promise<void> {
  const img = rawImage.value;
  const info = fileInfo.value;
  const o = orientation.value;
  if (!img || !info || savedCrops.value.length === 0 || packaging.value) return;

  // 快照：深拷贝裁片列表，之后的编码全部基于这份冻结数据
  const crops = savedCrops.value.map((c) => ({ ...c, originalRect: { ...c.originalRect } }));
  const gen = generation;
  const cropVer = cropVersion;
  const stillCurrent = () => gen === generation && cropVer === cropVersion;
  const abort = (reason: string) => {
    status.value = `${reason}，整包未下载。`;
  };

  packaging.value = true;
  status.value = '打包中…';
  try {
    const manifest = buildManifest({
      image: { name: info.name, type: info.type, width: img.width, height: img.height },
      orientation: o,
      crops,
    });
    const entries: ZipEntry[] = [];
    for (const entry of manifest.crops) {
      await runEncodeHook(entry.file);
      if (!stillCurrent()) return abort('打包期间图片、方向或裁片已变更');
      const pixels = exportCrop(img, entry.display.rect, o);
      const blob = await encodePng(pixels);
      if (!stillCurrent()) return abort('打包期间图片、方向或裁片已变更');
      if (!blob) return abort(`裁片「${entry.name}」PNG 编码失败`);
      entries.push({ name: entry.file, data: new Uint8Array(await blob.arrayBuffer()) });
      if (!stillCurrent()) return abort('打包期间图片、方向或裁片已变更');
    }
    entries.push({
      name: MANIFEST_FILE_NAME,
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    const zip = buildZip(entries);
    await Promise.resolve(); // 最后让出一次事件循环，复核快照仍然有效
    if (!stillCurrent()) return abort('打包期间图片、方向或裁片已变更');
    triggerDownload(new Blob([zip], { type: 'application/zip' }), `${baseName()}-crops-o${o}.zip`);
    status.value = `已导出 ZIP：${crops.length} 个裁片 + ${MANIFEST_FILE_NAME}。`;
  } catch (err) {
    abort(`打包失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    packaging.value = false;
  }
}
</script>

<template>
  <main class="app">
    <h1>EXIF 方向裁切工具</h1>
    <p class="hint">
      本地处理，零后端。选择图片与 EXIF 方向（含镜像），在正向预览上拖动整像素边界的半开矩形，
      导出时四角会逆变换回原图坐标。也可以把框选保存为裁片（至多 {{ MAX_CROPS }} 个，
      以原图坐标记录），切换方向自动重投影，最后一键导出含清单的 ZIP。
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
        <div
          v-for="view in savedCropViews"
          :key="view.crop.id"
          class="saved-overlay"
          :data-testid="`saved-overlay-${view.crop.id}`"
          :style="rectOverlayStyle(view.displayRect)"
        >
          <span class="saved-label">{{ view.crop.name }}</span>
        </div>
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
        <div class="panel">
          <h2>裁片工作区（{{ savedCrops.length }}/{{ MAX_CROPS }}）</h2>
          <div class="save-row">
            <input
              v-model="cropNameInput"
              data-testid="crop-name"
              type="text"
              placeholder="裁片名称（唯一）"
            />
            <button data-testid="save-crop" :disabled="!canSaveCrop" @click="saveCrop">
              保存当前框选为裁片
            </button>
          </div>
          <p v-if="cropNameInput && cropNameProblem" class="invalid">{{ cropNameProblem }}</p>
          <p v-if="!savedCrops.length" class="hint">暂无已保存裁片；保存后切换方向会自动重投影。</p>
          <ul v-else class="crop-list">
            <li
              v-for="view in savedCropViews"
              :key="view.crop.id"
              :data-testid="`saved-crop-${view.crop.id}`"
            >
              <strong>{{ view.crop.name }}</strong>
              <span>
                显示 x={{ view.displayRect.x }}, y={{ view.displayRect.y }}, w={{
                  view.displayRect.width
                }}, h={{ view.displayRect.height }}
              </span>
              <span>
                原图 x={{ view.crop.originalRect.x }}, y={{ view.crop.originalRect.y }}, w={{
                  view.crop.originalRect.width
                }}, h={{ view.crop.originalRect.height }}
              </span>
              <button
                :data-testid="`remove-crop-${view.crop.id}`"
                @click="removeCropById(view.crop.id)"
              >
                删除
              </button>
            </li>
          </ul>
          <button
            data-testid="export-zip"
            :disabled="!savedCrops.length || packaging"
            @click="exportZip"
          >
            {{ packaging ? '打包中…' : `导出 ZIP（${savedCrops.length} 个裁片 + 清单）` }}
          </button>
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
  box-sizing: border-box;
  border: 1px dashed #ff2d55;
  background: rgba(255, 45, 85, 0.15);
  pointer-events: none;
  display: none;
}
.saved-overlay {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid #0a7ea4;
  background: rgba(10, 126, 164, 0.12);
  pointer-events: none;
}
.saved-label {
  position: absolute;
  top: -18px;
  left: -1px;
  font-size: 11px;
  line-height: 16px;
  padding: 0 4px;
  color: #fff;
  background: #0a7ea4;
  border-radius: 3px;
  white-space: nowrap;
}
.save-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.save-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
}
.crop-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.crop-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid #dde3ea;
  border-radius: 6px;
  font-size: 13px;
}
.crop-list li span {
  color: #444;
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
