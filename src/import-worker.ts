/// <reference lib="webworker" />
// SPDX-License-Identifier: GPL-3.0-only
// Imports PLY and LAS files into the same cell format the E57 path produces,
// so the rest of the app cannot tell the difference. Also the landing spot for
// scans exported by phone LiDAR apps.
import init, { PointSink, LazReader, set_window_size } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';
import { sniff, parsePly, parseLas, parseAscii, parsePtx } from '../shared/importers.mjs';

const post = (m: any, t?: Transferable[]) => (self as any).postMessage(m, t ?? []);
let ready: Promise<unknown> | null = null;

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type !== 'open') return;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    set_window_size(32 * 1024 * 1024);
    const file: File = m.file;
    const remoteUrl: string | undefined = m.remoteUrl;
    const fileSize: number = m.remoteSize ?? file.size;
    let bytesPulled = 0;
    const fr = new FileReaderSync();
    const readRange = (offset: number, length: number) => {
      const end = Math.min(offset + length, fileSize);
      if (end <= offset) return new Uint8Array(0);
      if (remoteUrl) {
        if (end <= file.size) {
          const buf = fr.readAsArrayBuffer(file.slice(offset, end));
          bytesPulled += buf.byteLength;
          return new Uint8Array(buf);
        }
        const xhr = new XMLHttpRequest();
        xhr.open('GET', remoteUrl, false);
        xhr.responseType = 'arraybuffer';
        xhr.withCredentials = true;
        xhr.setRequestHeader('Range', `bytes=${offset}-${end - 1}`);
        xhr.send();
        if (xhr.status !== 200 && xhr.status !== 206) {
          throw new Error(`Range request failed (${xhr.status})`);
        }
        const buf = xhr.response as ArrayBuffer;
        bytesPulled += buf.byteLength;
        return new Uint8Array(buf);
      }
      const buf = fr.readAsArrayBuffer(file.slice(offset, end));
      bytesPulled += buf.byteLength;
      return new Uint8Array(buf);
    };
    const kind = m.kind ?? sniff(file.name, readRange);
    if (!['ply', 'las', 'laz', 'ascii', 'ptx'].includes(kind)) throw new Error(`Unrecognised file type: ${file.name}`);

    const userStride = Math.max(1, m.stride | 0);
    let stride = userStride;
    const t0 = performance.now();
    let sink: PointSink | null = null;
    let total = 0, lastProgress = 0;
    let previewBatches = 0;
    let targetPerLaterBatch = 50_000;
    const preview = (rec: Uint8Array, count: number, pm: Float64Array) => {
      const cubeMeta = { origin: [pm[0], pm[1], pm[2]], size: pm[3], bmin: [pm[0], pm[1], pm[2]], bmax: [pm[0] + pm[3], pm[1] + pm[3], pm[2] + pm[3]] };
      previewBatches++;
      if (previewBatches <= 2 || count <= targetPerLaterBatch) {
        post({ type: 'preview', block: rec.buffer, count, meta: cubeMeta }, [rec.buffer]);
        return;
      }
      const subStride = Math.max(1, Math.floor(count / targetPerLaterBatch));
      const kept = Math.ceil(count / subStride);
      const out = new Uint8Array(kept * 14);
      for (let i = 0, j = 0; i < count; i += subStride, j++) {
        out.set(rec.subarray(i * 14, i * 14 + 14), j * 14);
      }
      post({ type: 'preview', block: out.buffer, count: kept, meta: cubeMeta }, [out.buffer]);
    };

    const onMeta = (im: any) => {
      total = im.points;
      const memLimit = m.memLimit ?? 3e9;
      const bytesPerPoint = 14 * 1.25;
      let autoAdjusted = false;

      if (im.points > 0) {
        if ((im.points / stride) * bytesPerPoint > memLimit * 0.9) {
          stride = Math.max(stride, Math.ceil((im.points * bytesPerPoint) / (memLimit * 0.88)));
          autoAdjusted = stride !== userStride;
        }
      }

      const meta = {
        guid: null, library: `import:${im.format}`, images: 0, stations: im.stations ?? [],
        scans: [{ name: im.name, points: im.points, bounds: im.bounds, translation: im.translation,
                  sensorVendor: im.format.toUpperCase() + (im.version ? ' ' + im.version : ''), sensorModel: im.pointFormat !== undefined ? `point format ${im.pointFormat}` : null,
                  hasColor: im.hasColor, hasIntensity: im.hasIntensity, hasNormals: im.hasNormals, hasClassification: !!im.hasClassification,
                  cartesian: true, spherical: false, fields: 0 }],
      };
      const willKeep = Math.max(1, Math.floor(im.points / stride));
      post({ type: 'meta', meta, openMs: performance.now() - t0, bytesPulled });
      post({ type: 'plan', stride, willKeep, autoAdjusted });
      const b = im.bounds;
      const wasmPreviewTarget = Math.max(2_400_000, willKeep);
      const expectedBatches = Math.max(1, Math.ceil(wasmPreviewTarget / 200_000));
      targetPerLaterBatch = Math.max(4_000, Math.min(200_000, Math.ceil(2_000_000 / expectedBatches)));
      sink = new PointSink(new Float64Array([b[0], b[2], b[4], b[1], b[3], b[5]]), willKeep, memLimit, wasmPreviewTarget);
    };
    const onBatch = (bt: any) => {
      if (!sink) return;
      if (stride > 1) {
        // keep 1 in `stride` — cheap decimation before binning
        const n = Math.ceil(bt.n / stride);
        const xyz = new Float64Array(n * 3), rgb = new Uint8Array(n * 3), inten = new Uint8Array(n), nrm = new Int8Array(n * 3);
        let j = 0;
        for (let i = 0; i < bt.n; i += stride, j++) {
          xyz[j * 3] = bt.xyz[i * 3]; xyz[j * 3 + 1] = bt.xyz[i * 3 + 1]; xyz[j * 3 + 2] = bt.xyz[i * 3 + 2];
          rgb[j * 3] = bt.rgb[i * 3]; rgb[j * 3 + 1] = bt.rgb[i * 3 + 1]; rgb[j * 3 + 2] = bt.rgb[i * 3 + 2];
          inten[j] = bt.inten[i]; nrm[j * 3] = bt.nrm[i * 3]; nrm[j * 3 + 1] = bt.nrm[i * 3 + 1]; nrm[j * 3 + 2] = bt.nrm[i * 3 + 2];
        }
        const cls = bt.cls ? new Uint8Array(n) : new Uint8Array(0);
        if (bt.cls) for (let i = 0, k = 0; i < bt.n; i += stride, k++) cls[k] = bt.cls[i];
        sink.push(xyz, rgb, inten, nrm, cls, j, preview);
      } else sink.push(bt.xyz, bt.rgb, bt.inten, bt.nrm, bt.cls ?? new Uint8Array(0), bt.n, preview);
    };
    const onProgress = (read: number, count: number) => {
      const now = performance.now();
      if (now - lastProgress > 80) { lastProgress = now; post({ type: 'progress', phase: 0, done: read, total: count, elapsed: now - t0, bytesPulled, fileSize }); }
    };
    if (kind === 'ply') parsePly(readRange, fileSize, file.name, onMeta, onBatch, onProgress);
    else if (kind === 'ptx') parsePtx(readRange, fileSize, file.name, onMeta, onBatch, onProgress);
    else if (kind === 'ascii') parseAscii(readRange, fileSize, file.name, m.map, m.delim, m.skip ?? 0, onMeta, onBatch, onProgress);
    else {
      // The laszip decompressor reads through the same ranged shim, a chunk at a time, so a
      // multi-gigabyte LAZ never enters wasm memory whole.
      let laz: LazReader | null = null;
      const makeLaz = (vlr: Uint8Array, offset: number, recLen: number) => {
        laz = new LazReader(readRange as any, fileSize, vlr, offset, recLen);
        return { read: (n: number) => laz!.read(n) };
      };
      try { parseLas(readRange, fileSize, file.name, onMeta, onBatch, onProgress, { makeLaz }); }
      finally { try { (laz as LazReader | null)?.free(); } catch {} }
    }
    if (!sink) throw new Error('nothing to import');

    const s = sink as PointSink;
    const stats: any = s.finish(preview,
      (phase: number, done: number, tot: number) => { post({ type: 'progress', phase, done, total: tot, elapsed: performance.now() - t0, bytesPulled, fileSize }); return false; },
      (blocks: Uint8Array[], count: number, pm: Float64Array) => {
        const bufs = blocks.map(b => b.buffer as ArrayBuffer);
        post({ type: 'leaf', blocks: bufs, count, meta: { origin: [pm[0], pm[1], pm[2]], size: pm[3], bmin: [pm[4], pm[5], pm[6]], bmax: [pm[7], pm[8], pm[9]] } }, bufs);
      });
    post({ type: 'done', ms: performance.now() - t0, bytesPulled: fileSize, stats: { read: total, kept: stats.kept, droppedInvalid: 0, leaves: stats.leaves, nodes: stats.leaves } });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
