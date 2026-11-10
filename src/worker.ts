/// <reference lib="webworker" />
// SPDX-License-Identifier: GPL-3.0-only
import init, { E57Handle, set_window_size } from './wasm/e57_wasm.js';
import wasmUrl from './wasm/e57_wasm_bg.wasm?url';

let ready: Promise<unknown> | null = null;
const post = (m: any, t?: Transferable[]) => (self as any).postMessage(m, t ?? []);

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (!ready) ready = init({ module_or_path: wasmUrl });
    await ready;
    if (msg.type !== 'open') return;

    const file: File = msg.file;
    const remoteUrl: string | undefined = msg.remoteUrl;
    const fileSize: number = msg.remoteSize ?? file.size;
    let bytesPulled = 0;
    const fr = new FileReaderSync();

    const readRange = (offset: number, length: number): Uint8Array => {
      const end = Math.min(offset + length, fileSize);
      if (end <= offset) return new Uint8Array(0);

      if (remoteUrl) {
        if (offset === 0 && end <= file.size) {
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

    // Small window for opening the 48-byte header + trailing XML metadata quickly
    set_window_size(256 * 1024);
    const t0 = performance.now();
    const h = new E57Handle(readRange, fileSize);
    const meta = JSON.parse(h.meta());
    post({ type: 'meta', meta, openMs: performance.now() - t0, bytesPulled });

    // Large sequential read window (32 MB local / 16 MB remote) to minimize syscall & HTTP overhead during streaming
    set_window_size(remoteUrl ? 16 * 1024 * 1024 : 32 * 1024 * 1024);

    const scanIndex: number = msg.scanIndex ?? 0;
    const userStride: number = Math.max(1, msg.stride | 0);
    const memLimit: number = msg.memLimit ?? 3.0e9;
    const scan = meta.scans[scanIndex];

    // Auto-calculate safe load fraction if requested stride exceeds device memory limit
    const bytesPerPoint = 14 * 1.25;
    const totalPoints = scan?.points ?? 0;
    let stride = userStride;
    let autoAdjusted = false;

    if (totalPoints > 0) {
      const estimatedBytes = (totalPoints / stride) * bytesPerPoint;
      if (estimatedBytes > memLimit * 0.9) {
        const candidateStrides = [1, 2, 4, 10, 30];
        const safe = candidateStrides.find((s) => (totalPoints / s) * bytesPerPoint <= memLimit * 0.85);
        stride = safe ?? Math.max(userStride, Math.ceil((totalPoints * bytesPerPoint) / (memLimit * 0.85)));
        autoAdjusted = stride !== userStride;
      }
    }

    const willKeep = Math.max(1, Math.floor((scan?.points ?? 0) / stride));
    post({ type: 'plan', stride, willKeep, autoAdjusted });

    // Request a high preview_target from WASM so its internal preview_every is <= 4,
    // flushing 200k-point preview batches every ~800k decoded points (~50ms) instead of waiting for 25M+ points.
    const wasmPreviewTarget = Math.max(2_400_000, Math.ceil(willKeep / 4));
    const expectedBatches = Math.max(1, Math.ceil(wasmPreviewTarget / 200_000));
    const targetPerLaterBatch = Math.max(10_000, Math.min(200_000, Math.ceil(2_000_000 / expectedBatches)));
    let previewBatches = 0;

    const tD = performance.now();
    let lastProgress = 0;
    const stats = h.stream(scanIndex, stride, wasmPreviewTarget, memLimit,
      // preview: sparse points quantised to the root cube, streamed progressively during decode
      (rec: Uint8Array, count: number, m: Float64Array) => {
        const cubeMeta = {
          origin: [m[0], m[1], m[2]], size: m[3],
          bmin: [m[0], m[1], m[2]], bmax: [m[0] + m[3], m[1] + m[3], m[2] + m[3]],
        };
        previewBatches++;

        // Send the first 2 batches in full so points appear on screen immediately at high density
        if (previewBatches <= 2 || count <= targetPerLaterBatch) {
          post({ type: 'preview', block: rec.buffer, count, meta: cubeMeta }, [rec.buffer]);
          return;
        }

        // Subsample later batches in JS so points keep streaming onto the screen across the whole file
        // while keeping total preview VRAM around ~2.2M points
        const subStride = Math.max(1, Math.floor(count / targetPerLaterBatch));
        const kept = Math.ceil(count / subStride);
        const out = new Uint8Array(kept * 14);
        for (let i = 0, j = 0; i < count; i += subStride, j++) {
          const srcOff = i * 14;
          const dstOff = j * 14;
          out.set(rec.subarray(srcOff, srcOff + 14), dstOff);
        }
        post({ type: 'preview', block: out.buffer, count: kept, meta: cubeMeta }, [out.buffer]);
      },
      // progress: phase 0 = decoding records, phase 1 = finalising leaves
      (phase: number, done: number, total: number) => {
        const now = performance.now();
        if (now - lastProgress > 80 || done >= total) {
          lastProgress = now;
          post({ type: 'progress', phase, done, total, elapsed: now - tD, bytesPulled, fileSize });
        }
        return false;
      },
      // leaf: shuffled 14-byte records in blocks, origin/size cube, tight bounds
      (blocks: Uint8Array[], count: number, m: Float64Array) => {
        const bufs = blocks.map(b => b.buffer as ArrayBuffer);
        post({ type: 'leaf', blocks: bufs, count,
               meta: { origin: [m[0], m[1], m[2]], size: m[3],
                       bmin: [m[4], m[5], m[6]], bmax: [m[7], m[8], m[9]] } }, bufs);
      },
    );
    post({ type: 'done', ms: performance.now() - tD, bytesPulled, stats });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
};
