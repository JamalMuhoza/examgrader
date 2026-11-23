/* Exam Grader - deterministic computer vision (no AI): markers, homography, warp, page code, OMR */
'use strict';

const CV = (() => {
  // ---------- image access ----------
  function grayOf(imgData) {
    const d = imgData.data, n = imgData.width * imgData.height, g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  }
  function canvasOf(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  // draw source (image/canvas/video/bitmap) scaled so that max side <= maxDim; returns gray
  function grayScaled(src, sw, sh, maxDim) {
    const s = Math.min(1, maxDim / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const c = canvasOf(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return { g: grayOf(ctx.getImageData(0, 0, w, h)), w, h, scale: sw / w };
  }

  // ---------- adaptive threshold + connected components ----------
  function adaptive(g, w, h, win, k) {
    const W = w + 1, I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
    }
    const r = win >> 1, bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
        const m = s / ((x1 - x0) * (y1 - y0));
        bin[y * w + x] = g[y * w + x] < m * (1 - k) && g[y * w + x] < 200 ? 1 : 0;
      }
    }
    return bin;
  }

  function components(bin, w, h, minArea, maxArea) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const out = [];
    let next = 1;
    for (let i = 0; i < w * h; i++) {
      if (!bin[i] || lab[i]) continue;
      let sp = 0, n = 0; stack[sp++] = i; lab[i] = next;
      let minx = w, maxx = 0, miny = h, maxy = 0, sx = 0, sy = 0;
      const start = out.length;
      const pix = [];
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        n++; sx += x; sy += y;
        if (n <= maxArea) pix.push(p);
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && bin[p - 1] && !lab[p - 1]) { lab[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && bin[p + 1] && !lab[p + 1]) { lab[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && bin[p - w] && !lab[p - w]) { lab[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && bin[p + w] && !lab[p + w]) { lab[p + w] = next; stack[sp++] = p + w; }
      }
      next++;
      if (n < minArea || n > maxArea) continue;
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (minx === 0 || miny === 0 || maxx === w - 1 || maxy === h - 1) continue;
      const cx = sx / n, cy = sy / n;
      let md = 0;
      for (const p of pix) { const x = p % w, y = (p - x) / w; const d = (x - cx) * (x - cx) + (y - cy) * (y - cy); if (d > md) md = d; }
      out.push({ area: n, bw, bh, cx: cx + 0.5, cy: cy + 0.5, fill: n / (bw * bh), ext: Math.sqrt(md) / Math.sqrt(n) });
    }
    return out;
  }

  // ---------- marker detection ----------
  function detectMarkers(g, w, h) {
    const md = Math.max(w, h);
    let win = Math.round(md / 14) | 1; if (win < 15) win = 15;
    const bin = adaptive(g, w, h, win, 0.18);
    const minA = Math.max(16, Math.pow(md * 0.006, 2));
    const maxA = Math.pow(md * 0.08, 2);
    const comps = components(bin, w, h, minA, maxA);
    const cands = comps.filter(c => {
      const asp = c.bw / c.bh;
      return asp > 0.5 && asp < 2 && c.fill > 0.5 && c.ext > 0.615;
    }).sort((a, b) => b.area - a.area);
    const tried = new Set();
    for (let k = 0; k < Math.min(8, cands.length); k++) {
      const ref = cands[k].area;
      const group = cands.filter(c => c.area > ref * 0.35 && c.area < ref * 2.9);
      if (group.length < 4) continue;
      const key = group.map(c => c.cx | 0).join(',');
      if (tried.has(key)) continue; tried.add(key);
      const q = extremal(group);
      const v = validQuad(q);
      if (v) return v;
    }
    return { found: false, cands: cands.length };
  }

  function extremal(group) {
    let tl, tr, br, bl;
    for (const c of group) {
      if (!tl || c.cx + c.cy < tl.cx + tl.cy) tl = c;
      if (!br || c.cx + c.cy > br.cx + br.cy) br = c;
      if (!tr || c.cx - c.cy > tr.cx - tr.cy) tr = c;
      if (!bl || c.cx - c.cy < bl.cx - bl.cy) bl = c;
    }
    return [tl, tr, br, bl];
  }
  const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
  function validQuad(q) {
    if (new Set(q).size !== 4) return null;
    // convexity / consistent winding
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.cx - a.cx) * (c.cy - b.cy) - (b.cy - a.cy) * (c.cx - b.cx);
      if (Math.abs(cr) < 1e-6) return null;
      const s = Math.sign(cr);
      if (!sign) sign = s; else if (s !== sign) return null;
    }
    let order = q.slice();
    let wdt = (dist(order[0], order[1]) + dist(order[3], order[2])) / 2;
    let hgt = (dist(order[0], order[3]) + dist(order[1], order[2])) / 2;
    if (wdt > hgt) { order = [q[3], q[0], q[1], q[2]]; [wdt, hgt] = [hgt, wdt]; }
    const asp = wdt / hgt; // expected 187.9 / 251.4 = 0.747
    if (asp < 0.5 || asp > 1.0) return null;
    const areas = order.map(c => c.area);
    if (Math.max(...areas) / Math.min(...areas) > 3.5) return null;
    const side = Math.sqrt(areas.reduce((a, b) => a + b, 0) / 4);
    const rel = side / wdt; // expected 8 / 187.9 = 0.0426
    if (rel < 0.018 || rel > 0.09) return null;
    // opposite sides should be roughly parallel-ish in length
    const t = dist(order[0], order[1]), b = dist(order[3], order[2]), l = dist(order[0], order[3]), r = dist(order[1], order[2]);
    if (t / b > 1.8 || b / t > 1.8 || l / r > 1.8 || r / l > 1.8) return null;
    const pts = order.map(c => ({ x: c.cx, y: c.cy }));
    // a rough score for UI feedback
    const score = 1 - Math.min(1, Math.abs(asp - 0.747) / 0.3);
    return { found: true, pts, side, score };
  }

  // refine a marker centre on the full-resolution gray image
  function refineMarker(g, w, h, p, side) {
    const R = Math.round(side * 1.25);
    const x0 = Math.max(0, Math.round(p.x - R)), x1 = Math.min(w, Math.round(p.x + R));
    const y0 = Math.max(0, Math.round(p.y - R)), y1 = Math.min(h, Math.round(p.y + R));
    const ww = x1 - x0, hh = y1 - y0;
    if (ww < 6 || hh < 6) return p;
    const hist = new Float64Array(256);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[g[y * w + x]]++;
    const thr = otsu(hist, ww * hh);
    // flood from the pixel nearest the centre that is dark
    const cx = Math.round(p.x), cy = Math.round(p.y);
    let seed = -1;
    for (let r = 0; r < R && seed < 0; r++) {
      for (let dy = -r; dy <= r && seed < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
        if (g[y * w + x] <= thr) { seed = y * w + x; break; }
      }
    }
    if (seed < 0) return p;
    const seen = new Uint8Array(ww * hh), st = [seed];
    seen[(Math.floor(seed / w) - y0) * ww + (seed % w - x0)] = 1;
    let n = 0, sx = 0, sy = 0;
    while (st.length) {
      const q = st.pop(); const x = q % w, y = (q - x) / w;
      n++; sx += x; sy += y;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of nb) {
        if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
        const li = (ny - y0) * ww + (nx - x0);
        if (seen[li]) continue;
        if (g[ny * w + nx] <= thr) { seen[li] = 1; st.push(ny * w + nx); }
      }
    }
    const exp = side * side;
    if (n < exp * 0.4 || n > exp * 2.5) return p;
    return { x: sx / n + 0.5, y: sy / n + 0.5 };
  }
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // ---------- homography ----------
  // returns H (9 array) mapping p -> q for 4 point pairs
  function homography(p, q) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = p[i], X = q[i].x, Y = q[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const h = solve(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function apply(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
  }

  // inverse warp with bilinear interpolation; H maps destination px -> source px
  function warp(src, sw, sh, H, dw, dh) {
    const out = new ImageData(dw, dh), o = out.data;
    for (let v = 0; v < dh; v++) {
      let nx = H[1] * v + H[2], ny = H[4] * v + H[5], dd = H[7] * v + H[8];
      for (let u = 0; u < dw; u++) {
        const z = H[6] * u + dd, x = (H[0] * u + nx) / z, y = (H[3] * u + ny) / z;
        const oi = (v * dw + u) * 4;
        if (x < 0 || y < 0 || x >= sw - 1 || y >= sh - 1) { o[oi] = o[oi + 1] = o[oi + 2] = 255; o[oi + 3] = 255; continue; }
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        o[oi] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
        o[oi + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        o[oi + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
        o[oi + 3] = 255;
      }
    }
    return out;
  }

  function sampleGray(g, w, h, x, y) {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 255;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return g[i] * (1 - fx) * (1 - fy) + g[i + 1] * fx * (1 - fy) + g[i + w] * (1 - fx) * fy + g[i + w + 1] * fx * fy;
  }

  // ---------- page code reading (in source coordinates via H) ----------
  function readCode(g, w, h, H) {
    const PX = Layout.PX, C = Layout.CODE;
    const meanAt = (xmm, ymm, half) => {
      let s = 0, n = 0;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const p = apply(H, (xmm + i * half / 2) * PX, (ymm + j * half / 2) * PX);
        s += sampleGray(g, w, h, p.x, p.y); n++;
      }
      return s / n;
    };
    const black = Layout.MARKERS.reduce((a, m) => a + meanAt(m.x, m.y, 2.5), 0) / 4;
    let white = 0; const wpts = [];
    for (let i = 0; i < 8; i++) wpts.push(meanAt(C.x0 + 4 + i * 10.5, 18.2, 0.8));
    wpts.sort((a, b) => b - a); white = (wpts[1] + wpts[2] + wpts[3]) / 3;
    const cells = Layout.codeCells();
    const vals = cells.map(c => meanAt(c.x, c.y, C.cell * 0.3));
    const thr = (white + black) / 2;
    const bits = vals.map(v => v < thr ? 1 : 0);
    const margin = Math.min(...vals.map(v => Math.abs(v - thr))) / Math.max(1, white - black);
    return { bits, decoded: Layout.decodeBits(bits), contrast: white - black, margin };
  }

  // ---------- full page processing ----------
  // src: drawable (canvas/image/bitmap/video); returns rectified result or failure
  function processSource(src, sw, sh, opts = {}) {
    const t0 = performance.now();
    const det = grayScaled(src, sw, sh, opts.detectDim || 1100);
    const m = detectMarkers(det.g, det.w, det.h);
    if (!m.found) return { ok: false, reason: 'Corner markers not found', ms: performance.now() - t0 };
    // full resolution data
    const fc = canvasOf(sw, sh), fctx = fc.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(src, 0, 0, sw, sh);
    const full = fctx.getImageData(0, 0, sw, sh);
    const fg = grayOf(full);
    const side = m.side * det.scale;
    const pts = m.pts.map(p => refineMarker(fg, sw, sh, { x: p.x * det.scale, y: p.y * det.scale }, side));
    const dst = Layout.MARKERS.map(p => ({ x: p.x * Layout.PX, y: p.y * Layout.PX }));
    // two orientation candidates (0 and 180 degrees); the page code decides
    const orders = [[0, 1, 2, 3], [2, 3, 0, 1]];
    let best = null;
    for (const o of orders) {
      const sp = o.map(i => pts[i]);
      const H = homography(dst, sp);
      if (!H) continue;
      const code = readCode(fg, sw, sh, H);
      const cand = { H, code, sp };
      if (code.decoded) { best = cand; break; }
      if (!best) best = cand;
    }
    if (!best) return { ok: false, reason: 'Geometry could not be solved' };
    const RW = Layout.RW, RH = Layout.RH;
    const rect = warp(full.data, sw, sh, best.H, RW, RH);
    const rg = grayOf(rect);
    const blur = sharpness(rg, RW, RH);
    // marker reprojection sanity: page size in source pixels -> resolution
    const pxPerMm = Math.hypot(best.sp[1].x - best.sp[0].x, best.sp[1].y - best.sp[0].y) / (Layout.MARKERS[1].x - Layout.MARKERS[0].x);
    return {
      ok: true, rect, rg, code: best.code, page: best.code.decoded ? best.code.decoded.page : null,
      hash: best.code.decoded ? best.code.decoded.hash : null,
      quality: { blur, pxPerMm, contrast: best.code.contrast, codeMargin: best.code.margin },
      corners: best.sp, ms: performance.now() - t0
    };
  }

  // fast check for the live camera preview (downscaled frame only)
  function quickDetect(src, sw, sh, dim = 640) {
    const det = grayScaled(src, sw, sh, dim);
    const m = detectMarkers(det.g, det.w, det.h);
    if (!m.found) return { found: false };
    return { found: true, pts: m.pts.map(p => ({ x: p.x * det.scale, y: p.y * det.scale })), side: m.side * det.scale };
  }

  // variance of a Laplacian on a central band (higher = sharper)
  function sharpness(g, w, h) {
    let s = 0, s2 = 0, n = 0;
    for (let y = 40; y < h - 40; y += 2) for (let x = 40; x < w - 40; x += 2) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += l; s2 += l * l; n++;
    }
    const m = s / n; return s2 / n - m * m;
  }

  // ---------- OMR ----------
  // background (paper) estimate: max of 8px cell means within a window, smoothed
  function background(g, w, h) {
    const C = 8, gw = Math.ceil(w / C), gh = Math.ceil(h / C);
    const cm = new Float32Array(gw * gh);
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      let s = 0, n = 0;
      for (let y = cy * C; y < Math.min(h, cy * C + C); y++) for (let x = cx * C; x < Math.min(w, cx * C + C); x++) { s += g[y * w + x]; n++; }
      cm[cy * gw + cx] = s / n;
    }
    const R = 5, mx = new Float32Array(gw * gh), tmp = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0; for (let k = Math.max(0, x - R); k <= Math.min(gw - 1, x + R); k++) m = Math.max(m, cm[y * gw + k]);
      tmp[y * gw + x] = m;
    }
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0; for (let k = Math.max(0, y - R); k <= Math.min(gh - 1, y + R); k++) m = Math.max(m, tmp[k * gw + x]);
      mx[y * gw + x] = m;
    }
    const bg = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, n = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        s += mx[yy * gw + xx]; n++;
      }
      bg[y * gw + x] = Math.max(40, s / n);
    }
    return { at(x, y) { const gx = Math.min(gw - 1, Math.max(0, Math.round(x / C - 0.5))), gy = Math.min(gh - 1, Math.max(0, Math.round(y / C - 0.5))); return bg[gy * gw + gx]; } };
  }

  function discDark(g, w, h, bg, cx, cy, rad) {
    const b = bg.at(cx, cy);
    let s = 0, n = 0;
    const r2 = rad * rad;
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      s += Math.max(0, Math.min(1, 1 - g[y * w + x] / b)); n++;
    }
    return n ? s / n : 0;
  }
  function ringDark(g, w, h, cx, cy, rad) {
    let s = 0;
    for (let k = 0; k < 32; k++) { const a = k * Math.PI / 16; s += 255 - sampleGray(g, w, h, cx + rad * Math.cos(a), cy + rad * Math.sin(a)); }
    return s / 32;
  }
  // find a small offset that best aligns the printed bubble outlines of one group
  function alignGroup(g, w, h, centers, r) {
    let best = { dx: 0, dy: 0, v: -1e9 };
    for (let dy = -6; dy <= 6; dy += 1) for (let dx = -6; dx <= 6; dx += 1) {
      let v = 0;
      for (const c of centers) v += ringDark(g, w, h, c.x + dx, c.y + dy, r) - ringDark(g, w, h, c.x + dx, c.y + dy, r + 4);
      v -= 0.6 * (Math.abs(dx) + Math.abs(dy)); // prefer small shifts
      if (v > best.v) best = { dx, dy, v };
    }
    return best;
  }

  function classify(ds, labels, th) {
    const idx = ds.map((d, i) => i).sort((a, b) => ds[b] - ds[a]);
    const t1 = ds[idx[0]], t2 = ds.length > 1 ? ds[idx[1]] : 0;
    const hi = th.hi, lo = th.lo;
    const marked = idx.filter(i => ds[i] >= hi);
    if (t1 < lo) return { status: 'blank', choice: null, marked: [] };
    if (marked.length >= 2) {
      if (t1 - t2 >= th.erase) return { status: 'single', choice: labels[idx[0]], marked: [labels[idx[0]]], note: 'lighter second mark ignored' };
      return { status: 'multiple', choice: null, marked: marked.map(i => labels[i]) };
    }
    if (marked.length === 1) {
      if (t2 < lo) return { status: 'single', choice: labels[idx[0]], marked: [labels[idx[0]]] };
      if (t1 - t2 >= th.erase) return { status: 'single', choice: labels[idx[0]], marked: [labels[idx[0]]], note: 'possible erasure ignored' };
      return { status: 'ambiguous', choice: null, marked: [labels[idx[0]], labels[idx[1]]], reason: 'second mark' };
    }
    return { status: 'ambiguous', choice: null, marked: [labels[idx[0]]], reason: 'light mark' };
  }

  const DEFAULT_TH = { hi: 0.42, lo: 0.2, erase: 0.3 };

  // analyse one rectified page against the layout manifest
  function analyzePage(rg, L, pageNo, th = DEFAULT_TH) {
    const W = Layout.RW, Hh = Layout.RH, PX = Layout.PX;
    const bg = background(rg, W, Hh);
    const black = Layout.MARKERS.reduce((a, m) => a + discDark(rg, W, Hh, bg, m.x * PX, m.y * PX, 2.5 * PX), 0) / 4;
    const norm = Math.max(0.35, black);
    const res = { mc: {}, id: null, black };
    const rr = Layout.BUB_R * PX;
    for (const q of L.mc.filter(q => q.page === pageNo)) {
      const centers = q.choices.map(c => ({ x: c.x * PX, y: c.y * PX }));
      const al = alignGroup(rg, W, Hh, centers, rr);
      const ds = centers.map(c => discDark(rg, W, Hh, bg, c.x + al.dx, c.y + al.dy, rr * 0.62) / norm);
      const cl = classify(ds, q.choices.map(c => c.label), th);
      res.mc[q.qid] = { ...cl, ds: ds.map(v => Math.round(v * 1000) / 1000), off: [al.dx, al.dy] };
    }
    if (pageNo === 1 && L.cover) {
      const r = L.cover.id.r * PX;
      const digits = L.cover.id.cols.map(col => {
        const centers = col.bubbles.map(b => ({ x: b.x * PX, y: b.y * PX }));
        const al = alignGroup(rg, W, Hh, centers, r);
        const ds = centers.map(c => discDark(rg, W, Hh, bg, c.x + al.dx, c.y + al.dy, r * 0.62) / norm);
        const cl = classify(ds, col.bubbles.map(b => String(b.d)), th);
        return { ...cl, ds: ds.map(v => Math.round(v * 1000) / 1000) };
      });
      const ok = digits.every(d => d.status === 'single');
      res.id = { digits, value: digits.map(d => d.status === 'single' ? d.choice : '?').join(''), ok };
    }
    return res;
  }

  return { readCode, grayOf, grayScaled, canvasOf, detectMarkers, homography, apply, warp, processSource, quickDetect, analyzePage, classify, DEFAULT_TH, sharpness };
})();
