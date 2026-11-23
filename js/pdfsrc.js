/* Exam Grader - "original look" reader for PDF exams.
 * Finds the questions, choice labels, figures and non-question pages of a typed PDF from its text layer and its image
 * positions (pdf.js), then cuts each question stem and each choice out of a 200 dpi render of the page, so the printed
 * exam shows the teacher's own typesetting (superscripts, subscripts, symbols, drawings) next to the app's bubbles.
 * A reflowed text version (with Unicode super/subscripts) is kept for the editor, the answer key and AI grading.
 * Nothing is dropped silently: every line or picture that is not part of a question or page item is returned in `unused`. */
'use strict';

const PdfSrc = (() => {
  const DPI = 200, K = DPI / 72;          // render pixels per PDF point
  const INK = 200;                        // gray below this counts as ink
  const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', ' ': '' };
  const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', ' ': '' };
  const blank = s => !String(s || '').replace(/[\s ​]/g, '');

  function script(s, map, mark) {
    const t = s.trim();
    if (!t) return '';
    if (t.split('').every(c => map[c] !== undefined)) return t.split('').map(c => map[c]).join('');
    return mark + '(' + t + ')';
  }

  // ---------------- page reading: text items, images, lines ----------------
  async function readPage(page, no) {
    const vp = page.getViewport({ scale: 1 });
    const T = pdfjsLib.Util.transform;
    const tc = await page.getTextContent();
    const items = [], seen = [];
    for (const it of tc.items) {
      if (it.str === undefined || blank(it.str)) continue;
      const tx = T(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 10;
      const rot = Math.abs(tx[1]) > Math.abs(tx[0]) * 0.2;
      const x = tx[4], y = tx[5];
      const w = rot ? h * it.str.length * 0.5 : Math.abs(it.width * vp.scale) || h * it.str.length * 0.5;
      // the same text drawn twice at the same place (hidden duplicate text layers): keep one
      if (seen.some(o => o.str === it.str && Math.abs(o.x - x) < 2 && Math.abs(o.y - y) < 2)) continue;
      const o = { str: it.str, x, y, w, h, rot, page: no };
      seen.push(o);
      items.push(o);
    }
    // text drawn in white or hidden behind the page (a second copy of a question, for example) is not on the paper: drop it
    let hidden = 0;
    try {
      const lv = page.getViewport({ scale: 1.5 });
      const c = document.createElement('canvas'); c.width = Math.round(lv.width); c.height = Math.round(lv.height);
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: lv }).promise;
      const d = cx.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
      const inked = o => {
        const x0 = Math.max(0, Math.floor(o.x * 1.5)), x1 = Math.min(W - 1, Math.ceil((o.x + o.w) * 1.5));
        const y0 = Math.max(0, Math.floor((o.y - o.h * 0.85) * 1.5)), y1 = Math.min(H - 1, Math.ceil((o.y + o.h * 0.2) * 1.5));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W + x) * 4; if (d[i] + d[i + 1] + d[i + 2] < 3 * 225) return true; }
        return false;
      };
      for (let i = items.length - 1; i >= 0; i--) if (!items[i].rot && !inked(items[i])) { items.splice(i, 1); hidden++; }
      c.width = c.height = 1;
    } catch (e) { /* keep everything */ }
    // images: follow the transformation matrix through the operator list
    const images = [];
    try {
      const ops = await page.getOperatorList(), O = pdfjsLib.OPS;
      let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
      const IMG = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject, O.paintImageXObjectRepeat, O.paintImageMaskXObjectRepeat].filter(v => v !== undefined));
      for (let i = 0; i < ops.fnArray.length; i++) {
        const f = ops.fnArray[i], a = ops.argsArray[i];
        if (f === O.save) stack.push(ctm.slice());
        else if (f === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (f === O.transform) ctm = T(ctm, a);
        else if (f === O.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a && a[0]) ctm = T(ctm, a[0]); }
        else if (f === O.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (IMG.has(f)) {
          const m = T(vp.transform, ctm);
          const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), page: no, img: true };
          if (b.x1 - b.x0 > 2 && b.y1 - b.y0 > 2 && !images.some(o => Math.abs(o.x0 - b.x0) < 1 && Math.abs(o.y0 - b.y0) < 1 && Math.abs(o.x1 - b.x1) < 1)) images.push(b);
        }
      }
    } catch (e) { /* no image positions: pictures are still kept inside page crops */ }
    // lines: by baseline; super/subscripts join the line they overlap
    const flat = items.filter(i => !i.rot).sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const lines = [];
    for (const it of flat) {
      let best = null, bd = 1e9;
      for (const ln of lines) {
        const d = Math.abs(ln.base - it.y);
        if (d <= Math.max(2, 0.45 * Math.max(ln.size, it.h)) && d < bd) { best = ln; bd = d; }
      }
      if (best) { best.items.push(it); if (it.h > best.size) { best.size = it.h; best.base = it.y; } }
      else lines.push({ page: no, items: [it], base: it.y, size: it.h, images: [] });
    }
    lines.forEach(ln => {
      ln.items.sort((a, b) => a.x - b.x);
      // a second text layer drawn over the first (scanner OCR text, copy-pasted layers): the same words at the same place once
      const kept = [];
      for (const it of ln.items) {
        const t = it.str.trim();
        const dup = kept.find(o => Math.abs(o.y - it.y) < 2.5 && Math.min(o.x + o.w, it.x + it.w) - Math.max(o.x, it.x) > 0.6 * Math.min(o.w, it.w) &&
          (o.str.trim() === t || (t.length >= 3 && o.str.includes(t)) || (o.str.trim().length >= 3 && t.includes(o.str.trim()))));
        if (!dup) { kept.push(it); continue; }
        if (t.length > dup.str.trim().length) kept[kept.indexOf(dup)] = it;
        ln.dups = (ln.dups || 0) + 1;
      }
      ln.items = kept;
      // main baseline = baseline of the largest share of characters
      const byBase = new Map();
      ln.items.forEach(i => { const k = Math.round(i.y * 2) / 2; byBase.set(k, (byBase.get(k) || 0) + i.str.length * i.h); });
      let mb = ln.base, mv = -1; byBase.forEach((v, k) => { if (v > mv) { mv = v; mb = k; } });
      ln.base = mb;
      ln.size = Math.max(...ln.items.filter(i => Math.abs(i.y - mb) < 1).map(i => i.h), 6);
      ln.x0 = Math.min(...ln.items.map(i => i.x));
      ln.x1 = Math.max(...ln.items.map(i => i.x + i.w));
      ln.top = Math.min(...ln.items.map(i => i.y - i.h * 0.9));
      ln.bottom = Math.max(...ln.items.map(i => i.y + i.h * 0.25));
      ln.text = lineText(ln.items, ln);
    });
    lines.sort((a, b) => a.base - b.base);
    // pictures that sit on a text line (Word inline pictures: bottom on the baseline, next to the text) belong to that line
    const floats = [];
    images.forEach(im => {
      let host = null;
      for (const ln of lines) {
        if (Math.abs(im.y1 - ln.base) > 3.5 && !(im.y0 < ln.base && im.y1 > ln.base - ln.size * 0.3 && im.y1 - im.y0 < ln.size * 2.2)) continue;
        const near = ln.items.some(i => (im.x0 >= i.x + i.w - 1 && im.x0 - (i.x + i.w) < 40) || (i.x >= im.x1 - 1 && i.x - im.x1 < 40));
        if (near) { host = ln; break; }
      }
      if (host) { host.images.push(im); host.top = Math.min(host.top, im.y0); host.bottom = Math.max(host.bottom, im.y1); host.x1 = Math.max(host.x1, im.x1); }
      else floats.push(im);
    });
    const inLines = new Set(lines.flatMap(l => l.items));
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].rot && !inLines.has(items[i])) { items.splice(i, 1); hidden++; }
    const rotChars = items.filter(i => i.rot).reduce((a, i) => a + i.str.replace(/\s/g, '').length, 0);
    const chars = items.reduce((a, i) => a + i.str.replace(/\s/g, '').length, 0);
    return { no, w: vp.width, h: vp.height, items, images, lines, floats, chars, rotChars, hidden };
  }

  // text of a run of items with spaces from gaps and super/subscripts from size and baseline
  function lineText(items, ln) {
    let s = '', end = null;
    for (const it of items) {
      const gap = end === null ? 0 : it.x - end;
      if (end !== null && gap > Math.max(1, it.h * 0.15) && !/\s$/.test(s) && !/^\s/.test(it.str)) s += gap > 24 ? '   ' : ' ';
      let t = it.str;
      if (ln && it.h < ln.size * 0.85) {
        if (ln.base - it.y > ln.size * 0.12) t = script(t, SUP, '^');
        else if (it.y - ln.base > ln.size * 0.04) t = script(t, SUB, '_');
      }
      s += t; end = it.x + it.w;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---------------- structure ----------------
  const RE_HEAD = /^(?:section|part)\s+(?:[A-Z]|\d{1,2}|[IVX]{1,4})\b/i;
  // question numbers: 1.  1)  (1)  Q1.  Q1)  Question 1:  (the number must be followed by a space)
  const RE_QNUM = /^\s*(?:Q(?:uestion)?\s*#?\s*)?\(?(\d{1,3})\s*[.):](?=\s|$)/i;
  const RE_QNUM_PIECE = /^\s*(?:Q(?:uestion)?\s*#?\s*)?\(?\d{1,3}\s*[.):]/i;
  const LETTERS = 'ABCDEFGH';

  function qStart(ln) {
    const m = ln.text.match(RE_QNUM);
    return m ? +m[1] : null;
  }

  // split a question's lines into parts: number, stem, labels, choice contents (with estimated x of each piece)
  function findLabels(q) {
    // every "A." / "b)" / "(c)" that could be a choice label, with how sure we are that it is one
    const cands = [];
    q.lines.forEach((ln, li) => {
      let prevEnd = null;
      ln.items.forEach((it, ii) => {
        const str = it.str, cpw = it.w / Math.max(1, str.length);
        const re = /(^|\s)(\*\s*)?\(?([A-Ha-h])\s*[.)](?=\s|$)/g;
        let m;
        while ((m = re.exec(str))) {
          const at = m.index + m[1].length, len = m[0].length - m[1].length;
          const lead = str.slice(0, at).trim() === '';
          const gap = lead ? (prevEnd === null ? 99 : it.x - prevEnd) : 0;
          cands.push({ letter: m[3].toUpperCase(), up: m[3] === m[3].toUpperCase(), line: li, item: ii, at, end: at + len, x: it.x + at * cpw, xe: it.x + (at + len) * cpw, marked: !!m[2],
            strong: (lead && (ii === 0 || gap >= 8)) || (!lead && /\s{2,}$/.test(str.slice(0, at))), ord: li * 1e5 + it.x + at * cpw });
          re.lastIndex = at + 1;
        }
        prevEnd = it.x + it.w;
      });
    });
    const onLine = (c, letter, up) => cands.some(o => o !== c && o.line === c.line && o.letter === letter && o.up === up);
    const okA = c => c.letter === 'A' && (c.strong || onLine(c, 'B', c.up));
    const first = cands.filter(okA).sort((a, b) => a.ord - b.ord)[0];
    if (!first) return [];
    const labels = [first];
    for (let k = 1; k < LETTERS.length; k++) {
      const prev = labels[labels.length - 1], L = LETTERS[k];
      const ok = o => o.letter === L && o.ord > first.ord && (o.strong || o.line === prev.line || onLine(o, LETTERS[k + 1], o.up));
      // same letter case as label A; the other case only when it clearly starts a line or column (mixed "A. b. C." typing)
      const c = cands.filter(o => ok(o) && o.up === first.up).sort((a, b) => a.ord - b.ord)[0] || cands.filter(o => ok(o) && o.up !== first.up && o.strong).sort((a, b) => a.ord - b.ord)[0];
      if (!c) break;
      labels.push(c);
    }
    labels.forEach((l, i) => { l.letter = LETTERS[i]; });
    return labels;
  }

  // running headers and footers (same text at the same height on several pages, or a bare page number): not content
  function markFurniture(pages) {
    const key = ln => ln.text.replace(/\d+/g, '#').toLowerCase();
    const edge = (ln, p) => ln.base < p.h * 0.09 || ln.base > p.h * 0.93;
    const counts = new Map();
    pages.forEach(p => p.lines.forEach(ln => { if (edge(ln, p)) { const k = key(ln) + '|' + Math.round(ln.base / 10); counts.set(k, (counts.get(k) || 0) + 1); } }));
    pages.forEach(p => p.lines.forEach(ln => {
      if (!edge(ln, p) || !ln.text) return;
      const k = key(ln);
      if ((pages.length > 1 && counts.get(k + '|' + Math.round(ln.base / 10)) >= 2 && !/^#\s*[.)]\s/.test(k)) || /^(page\s*)?#(\s*(of|\/)\s*#)?$/.test(k)) ln.furniture = true;
    }));
  }

  function analyzeStructure(pages, opts) {
    const meta = opts.meta || (() => null);
    const questions = [], sections = [];
    let section = null, q = null, expected = null, qx = null, cur = null;
    const all = [];
    pages.forEach(p => p.lines.forEach(ln => all.push(ln)));
    all.forEach((ln, ai) => {
      ln.role = 'unused';
      const t = ln.text;
      if (!t) { ln.role = 'blank'; return; }
      if (ln.furniture) { ln.role = 'furniture'; return; }
      const n = qStart(ln);
      // choices (label A) right below this line, within a few lines
      const nextLbl = () => { for (let k = ai + 1; k < all.length && k < ai + 7; k++) { if (!all[k].text || all[k].furniture) continue; if (/^\(?[Aa]\s*[.)]\s/.test(all[k].text)) return true; if (qStart(all[k]) !== null) return false; } return /\s\(?[Aa]\s*[.)]\s.*\s\(?[Bb]\s*[.)]\s/.test(t); };
      if (n === null && RE_HEAD.test(t) && t.length < 160) {
        q = null;
        const mc = /multiple[\s-]*choice/i.test(t);
        section = mc ? 'mc' : 'other';
        ln.role = 'heading';
        if (!mc) { cur = { heading: ln, lines: [ln], title: t, pages: new Set([ln.page]) }; sections.push(cur); ln.owner = cur; }
        else cur = null;
        return;
      }
      const margin = qx === null || Math.abs(ln.x0 - qx) < 30;
      let okNum = n !== null && margin && (expected === null ? (section !== 'other' || nextLbl()) : n === expected);
      let odd = null;
      // a number used twice, skipped, or restarted after a heading: still a new question when it looks like one (number at
      // the question margin, choices labelled A right below)
      if (!okNum && n !== null && expected !== null && qx !== null && Math.abs(ln.x0 - qx) < 4 && nextLbl()) {
        if (n >= expected - 1 && n <= expected + 2) { okNum = true; odd = n < expected ? 'repeated' : 'skipped'; }
        else if (n === 1 && (section === 'other' || !q)) { okNum = true; odd = 'restart'; }
      }
      if (okNum) {
        q = { num: n, lines: [ln], page: ln.page, odd };
        questions.push(q); expected = n + 1; if (qx === null) qx = ln.x0;
        ln.role = 'q'; section = section === 'other' ? 'mc' : section; cur = null;
        return;
      }
      const mk = meta(t);
      if (mk) { ln.role = 'meta'; ln.meta = mk; if (mk === 'stop') q = null; return; }
      if (section === 'other' && cur && (cur.pages.has(ln.page) || pages[ln.page - 1].chars - pages[ln.page - 1].rotChars >= 40)) { cur.lines.push(ln); cur.pages.add(ln.page); ln.role = 'written'; ln.owner = cur; return; }
      if (q) { q.lines.push(ln); ln.role = 'q'; return; }
    });
    // a heading with nothing under it (for example "Section 2" between questions) is not a page of its own
    const keep = sections.filter(sec => {
      if (sec.lines.length > 1) { sec.heading.role = 'written'; return true; }
      sec.heading.role = 'unused'; delete sec.heading.owner; return false;
    });
    return { questions, sections: keep };
  }

  // lines glued after a question's last choice that do not belong to it (a table, a far-away block, text left of the
  // choice column) are cut off and listed as not used
  function trimTail(q, labels) {
    if (!labels.length) return [];
    const last = Math.max(...labels.map(l => l.line));
    const minLX = Math.min(...labels.map(l => l.x));
    let prev = q.lines[last];
    for (let li = last + 1; li < q.lines.length; li++) {
      const ln = q.lines[li];
      const same = ln.page === prev.page;
      const gap = same ? ln.top - prev.bottom : 0;
      const tableLike = clusterX(ln.items).length >= 3;
      if ((same && gap > 1.25 * Math.max(ln.size, prev.size)) || ln.x0 < minLX - 6 || tableLike) {
        const cut = q.lines.splice(li);
        cut.forEach(l => { l.role = 'unused'; l.trimmedFrom = q.num; });
        return cut;
      }
      prev = ln;
    }
    return [];
  }

  // ---------------- pixels ----------------
  function grayOf(ctx, x, y, w, h) {
    const d = ctx.getImageData(x, y, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  }
  // a frame drawn around the whole page (Word page border): the content area is inside it
  function innerArea(ctx, W, H) {
    const g = grayOf(ctx, 0, 0, W, H);
    const colInk = x => { let n = 0; for (let y = 0; y < H; y += 2) if (g[y * W + x] < 160) n++; return n / (H / 2); };
    const rowInk = y => { let n = 0; for (let x = 0; x < W; x += 2) if (g[y * W + x] < 160) n++; return n / (W / 2); };
    let x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1;
    // only the outermost line (and its thickness) is the page frame; table lines further in are content
    const scan = (from, to, step, ink) => { let found = -1; for (let v = from; step > 0 ? v < to : v > to; v += step) { const hi = ink(v) > 0.55; if (hi) found = v; else if (found >= 0) break; } return found; };
    let v;
    if ((v = scan(0, W * 0.06, 1, colInk)) >= 0) x0 = v + 1;
    if ((v = scan(W - 1, W * 0.94, -1, colInk)) >= 0) x1 = v - 1;
    if ((v = scan(0, H * 0.06, 1, rowInk)) >= 0) y0 = v + 1;
    if ((v = scan(H - 1, H * 0.94, -1, rowInk)) >= 0) y1 = v - 1;
    const pad = Math.round(K * 2.5);
    return { x0: (x0 ? x0 + pad : 0) / K, y0: (y0 ? y0 + pad : 0) / K, x1: (x1 < W - 1 ? x1 - pad : W) / K, y1: (y1 < H - 1 ? y1 - pad : H) / K, g, W, H };
  }
  // split x of "A) text" style items: the blank column run nearest the estimate
  function refineSplit(g, W, H, xe, base, size, lo, hi) {
    const y0 = Math.max(0, Math.round((base - size * 0.75) * K)), y1 = Math.min(H - 1, Math.round((base + size * 0.15) * K));
    const a = Math.max(0, Math.round(Math.max(lo, xe - size * 0.6) * K)), b = Math.min(W - 1, Math.round(Math.min(hi, xe + size * 0.6) * K));
    const blankCol = x => { for (let y = y0; y <= y1; y++) if (g[y * W + x] < 170) return false; return true; };
    const runs = []; let s = null;
    for (let x = a; x <= b; x++) { if (blankCol(x)) { if (s === null) s = x; } else if (s !== null) { runs.push([s, x - 1]); s = null; } }
    if (s !== null) runs.push([s, b]);
    const minRun = Math.max(2, size * 0.17 * K);
    xe += size * 0.1;
    let best = null, bd = 1e9;
    runs.filter(r => r[1] - r[0] + 1 >= minRun).forEach(r => { const c = (r[0] + r[1]) / 2 / K, d = Math.abs(c - xe); if (d < bd) { bd = d; best = c; } });
    return best === null ? xe : best;
  }

  // crop rect (pt) out of the page canvas; boxes of other owners are painted white, own boxes restored, then trimmed to ink
  function cutOut(src, rect, own, others, opt = {}) {
    const x = Math.max(0, Math.floor(rect.x0 * K)), y = Math.max(0, Math.floor(rect.y0 * K));
    const w = Math.min(src.width - x, Math.ceil((rect.x1 - rect.x0) * K)), h = Math.min(src.height - y, Math.ceil((rect.y1 - rect.y0) * K));
    if (w < 2 || h < 2) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    ctx.fillStyle = '#fff';
    const px = b => [b.x0 * K - x - 1, b.y0 * K - y - 1, (b.x1 - b.x0) * K + 2, (b.y1 - b.y0) * K + 2];
    others.forEach(b => { if (b.x1 > rect.x0 && b.x0 < rect.x1 && b.y1 > rect.y0 && b.y0 < rect.y1) ctx.fillRect(...px(b)); });
    own.forEach(b => { const [bx, by, bw, bh] = px(b); const sx = Math.max(0, bx), sy = Math.max(0, by); const ex = Math.min(w, bx + bw), ey = Math.min(h, by + bh); if (ex > sx && ey > sy) ctx.drawImage(src, sx + x, sy + y, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy); });
    // pictures of other owners stay white even where an own text box overlaps them
    others.filter(b => b.img).forEach(b => { if (b.x1 > rect.x0 && b.x0 < rect.x1 && b.y1 > rect.y0 && b.y0 < rect.y1) ctx.fillRect(...px(b)); });
    (opt.wipe || []).forEach(b => ctx.fillRect(...px(b)));
    // trim to ink
    const g = grayOf(ctx, 0, 0, w, h);
    let mx0 = w, my0 = h, mx1 = -1, my1 = -1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (g[yy * w + xx] < INK) { if (xx < mx0) mx0 = xx; if (xx > mx1) mx1 = xx; if (yy < my0) my0 = yy; if (yy > my1) my1 = yy; }
    if (mx1 < 0) return null;
    const pad = 3;
    mx0 = Math.max(0, mx0 - pad); my0 = Math.max(0, my0 - pad); mx1 = Math.min(w - 1, mx1 + pad); my1 = Math.min(h - 1, my1 + pad);
    const out = document.createElement('canvas'); out.width = mx1 - mx0 + 1; out.height = my1 - my0 + 1;
    out.getContext('2d').drawImage(c, mx0, my0, out.width, out.height, 0, 0, out.width, out.height);
    return { canvas: out, top: (y + my0) / K, left: (x + mx0) / K };
  }

  function encode(canvas) {
    const big = canvas.width * canvas.height > 600000;
    if (!big) return canvas.toDataURL('image/png');
    const j = canvas.toDataURL('image/jpeg', 0.9), p = canvas.toDataURL('image/png');
    return p.length < j.length * 1.3 ? p : j;
  }
  // several pieces (a question that runs onto the next page) stacked into one picture
  function finishCrop(parts, base, center) {
    parts = parts.filter(Boolean);
    if (!parts.length) return null;
    const gap = Math.round(K * 3);
    const W = Math.max(...parts.map(p => p.canvas.width)), H = parts.reduce((a, p) => a + p.canvas.height, 0) + gap * (parts.length - 1);
    let c = parts[0].canvas;
    if (parts.length > 1) {
      c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      let y = 0; parts.forEach(p => { ctx.drawImage(p.canvas, 0, y); y += p.canvas.height + gap; });
    }
    return { src: encode(c), w: c.width, h: c.height, wpt: c.width / K, hpt: c.height / K, base: base === null || base === undefined ? null : Math.max(0, base - parts[0].top), center: !!center };
  }

  // ---------------- main ----------------
  // opts.meta(text) -> null | 'meta' | 'stop' (answer lines, answer keys, written-question starts that end a question)
  async function analyze(buf, opts = {}) {
    const say = opts.onProgress || (() => { });
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) { say(`Reading page ${p} of ${pdf.numPages}`); pages.push(await readPage(await pdf.getPage(p), p)); }
    markFurniture(pages);
    const { questions, sections } = analyzeStructure(pages, opts);
    const warnings = [];
    // ---- per question: labels, owners, regions ----
    const Q = questions.map(q => {
      const labels = findLabels(q);
      q.trimmed = trimTail(q, labels);
      const R = { num: q.num, q, labels, stem: { boxes: [], imgs: [], lines: new Set(), text: [] }, choices: labels.map(l => ({ label: l, boxes: [], imgs: [], text: [], lines: new Set(), marked: l.marked })), wipe: [], pieces: [] };
      const firstLbl = labels[0];
      // columns of labels on each page
      const colsOf = pg => {
        const xs = labels.filter(l => q.lines[l.line].page === pg).map(l => l.x).sort((a, b) => a - b);
        const cols = []; xs.forEach(x => { if (!cols.length || x - cols[cols.length - 1] > 15) cols.push(x); });
        return cols;
      };
      const colIdx = (cols, x) => { let k = 0; cols.forEach((c, i) => { if (x >= c - 4) k = i; }); return k; };
      q.lines.forEach((ln, li) => {
        const cols = colsOf(ln.page);
        ln.items.forEach((it, ii) => {
          // pieces of this item: [from char, to char, owner]
          const cuts = labels.filter(l => l.line === li && l.item === ii);
          const cpw = it.w / Math.max(1, it.str.length);
          const pieces = [];
          let pos = 0;
          cuts.forEach(l => { if (l.at > pos) pieces.push({ a: pos, b: l.at }); pieces.push({ a: l.at, b: l.end, label: l }); pos = l.end; });
          if (pos < it.str.length) pieces.push({ a: pos, b: it.str.length });
          pieces.forEach(pc => {
            const s = it.str.slice(pc.a, pc.b);
            const piece = { it, s, a: pc.a, b: pc.b, x0: it.x + pc.a * cpw, x1: it.x + pc.b * cpw, line: ln, li };
            if (pc.label) { piece.owner = 'label'; pc.label.piece = piece; R.pieces.push(piece); return; }
            if (blank(s)) return;
            // number of the question (first piece of the first line)
            if (li === 0 && !R.numDone) {
              const m = s.match(RE_QNUM_PIECE);
              if (m) {
                R.numDone = true;
                const numPiece = { ...piece, b: pc.a + m[0].length, x1: it.x + (pc.a + m[0].length) * cpw, owner: 'num', s: m[0] };
                R.pieces.push(numPiece);
                const rest = s.slice(m[0].length);
                if (blank(rest)) return;
                Object.assign(piece, { a: pc.a + m[0].length, x0: numPiece.x1, s: rest, splitFrom: numPiece });
              } else R.numDone = true;
            }
            // owner: stem before the first label, else the latest label in this column
            let owner = null;
            if (firstLbl && (li > firstLbl.line || (li === firstLbl.line && piece.x0 >= firstLbl.x - 1))) {
              const k = colIdx(cols, piece.x0);
              const cand = labels.filter(l => (l.line < li || (l.line === li && l.x <= piece.x0 + 1)) && q.lines[l.line].page === ln.page && colIdx(cols, l.x) === k);
              const lab = cand.length ? cand[cand.length - 1] : labels.filter(l => l.line < li || (l.line === li && l.x <= piece.x0 + 1)).pop();
              owner = lab ? R.choices[labels.indexOf(lab)] : R.stem;
            } else owner = R.stem;
            piece.owner = owner;
            if (pc.label === undefined && cuts.length && pc.a === cuts[cuts.length - 1].end) piece.afterLabel = cuts[cuts.length - 1];
            R.pieces.push(piece);
          });
        });
        // inline pictures on this line
        ln.images.forEach(im => {
          let owner = R.stem;
          if (firstLbl && (li > firstLbl.line || (li === firstLbl.line && im.x0 >= firstLbl.x - 1))) {
            const k = colIdx(cols, im.x0);
            const cand = labels.filter(l => (l.line < li || (l.line === li && l.x <= im.x0 + 1)) && q.lines[l.line].page === ln.page && colIdx(cols, l.x) === k);
            const lab = cand.pop();
            if (lab) owner = R.choices[labels.indexOf(lab)];
          }
          owner.imgs.push(im); im.owner = owner; im.inline = true;
        });
      });
      return R;
    });
    // floating pictures: inside the question whose vertical span holds the picture's centre
    pages.forEach(p => p.floats.forEach(im => {
      const cy = (im.y0 + im.y1) / 2, cx = (im.x0 + im.x1) / 2;
      const onPage = Q.filter(R => R.q.lines.some(l => l.page === p.no));
      let host = null;
      onPage.forEach(R => {
        const ls = R.q.lines.filter(l => l.page === p.no);
        const top = Math.min(...ls.map(l => l.top)) - 4;
        const nxt = Q[Q.indexOf(R) + 1];
        const nl = nxt ? nxt.q.lines.filter(l => l.page === p.no) : [];
        const end = nl.length ? Math.min(...nl.map(l => l.top)) : Math.max(...ls.map(l => l.bottom)) + 30;
        if (cy >= top && cy < end) host = R;
      });
      if (!host) return;
      const lbls = host.labels.filter(l => host.q.lines[l.line].page === p.no);
      const firstTop = lbls.length ? host.q.lines[lbls[0].line].top : 1e9;
      let owner = host.stem;
      if (cy > firstTop) {
        const before = lbls.filter(l => host.q.lines[l.line].top <= cy);
        const xs = lbls.map(l => l.x).sort((a, b) => a - b);
        const inCol = before.filter(l => { const nxt = xs.find(x => x > l.x + 15); return cx >= l.x - 4 && (nxt === undefined || cx < nxt); });
        const lab = inCol.pop() || before.pop();
        if (lab) owner = host.choices[host.labels.indexOf(lab)];
      }
      owner.imgs.push(im); im.owner = owner;
    }));

    // ---- render each page, refine label splits, cut the crops ----
    const pageInfo = [], pageItems = [], unused = [];
    const crops = new Map();          // region -> [part]
    const regionBase = new Map();
    const addPart = (reg, part, base, center) => { if (!part) return; if (!crops.has(reg)) crops.set(reg, []); crops.get(reg).push(part); if (!regionBase.has(reg)) regionBase.set(reg, { base, center }); };
    let firstQPage = Q.length ? Math.min(...Q.map(R => R.q.page)) : null;
    for (const p of pages) {
      say(`Cutting out page ${p.no} of ${pages.length}`);
      const page = await pdf.getPage(p.no);
      const vp = page.getViewport({ scale: K });
      const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const inner = innerArea(ctx, cv.width, cv.height);
      const g = inner.g, GW = inner.W, GH = inner.H;
      // thumbnail
      const tw = 300, th = Math.round(300 * cv.height / cv.width);
      const tc = document.createElement('canvas'); tc.width = tw; tc.height = th; tc.getContext('2d').drawImage(cv, 0, 0, tw, th);
      const info = { no: p.no, w: p.w, h: p.h, thumb: tc.toDataURL('image/jpeg', 0.75), chars: p.chars, kind: null };
      pageInfo.push(info);
      const regs = Q.filter(R => R.q.lines.some(l => l.page === p.no));
      // refine "A) text" splits with the pixels
      regs.forEach(R => R.pieces.filter(pc => pc.line.page === p.no && (pc.owner === 'label' || pc.owner === 'num')).forEach(pc => {
        if (pc.b >= pc.it.str.length) { pc.x1 = pc.it.x + pc.it.w; return; }
        const sx = refineSplit(g, GW, GH, pc.x1, pc.line.base, pc.it.h, pc.x0 + pc.it.h * 0.3, pc.it.x + pc.it.w);
        pc.x1 = sx;
        R.pieces.filter(o => o.it === pc.it && o.a === pc.b && o !== pc).forEach(o => { o.x0 = sx; });
      }));
      const boxOf = pc => ({ x0: pc.x0, x1: pc.x1, y0: pc.it.y - pc.it.h * 0.8, y1: pc.it.y + pc.it.h * 0.3 });
      // every text box on the page with its owner
      const all = [];
      regs.forEach(R => R.pieces.filter(pc => pc.line.page === p.no).forEach(pc => all.push({ b: boxOf(pc), owner: pc.owner })));
      const ownedItems = new Set(); regs.forEach(R => R.pieces.forEach(pc => ownedItems.add(pc.it)));
      p.items.forEach(it => { if (!ownedItems.has(it)) all.push({ b: { x0: it.x, x1: it.x + it.w, y0: it.y - it.h * 0.8, y1: it.y + it.h * 0.3 }, owner: it.ownerSection || 'other' }); });
      p.images.forEach(im => all.push({ b: im, owner: im.owner || 'other', img: true }));
      const textX0 = Math.max(inner.x0, Math.min(...p.lines.map(l => l.x0), ...p.images.map(i => i.x0)) - 3);
      const textX1 = Math.min(inner.x1, Math.max(...p.lines.map(l => l.x1), ...p.images.map(i => i.x1)) + 6);
      regs.forEach((R, ri) => {
        const ls = R.q.lines.filter(l => l.page === p.no);
        const nextR = Q[Q.indexOf(R) + 1];
        const nls = nextR ? nextR.q.lines.filter(l => l.page === p.no) : [];
        const qEnd = nls.length ? Math.min(...nls.map(l => l.top)) - 1 : Math.min(inner.y1, Math.max(...ls.map(l => l.bottom), ...[R.stem, ...R.choices].flatMap(r => r.imgs.filter(i => i.page === p.no).map(i => i.y1))) + 6);
        const regions = [R.stem, ...R.choices];
        const ownBoxes = reg => R.pieces.filter(pc => pc.owner === reg && pc.line.page === p.no).map(boxOf).concat(reg.imgs.filter(i => i.page === p.no));
        const lblLines = R.choices.map(c => c.label).filter(l => R.q.lines[l.line].page === p.no);
        const xs = lblLines.map(l => l.x).sort((a, b) => a - b);
        const cols = []; xs.forEach(x => { if (!cols.length || x - cols[cols.length - 1] > 15) cols.push(x); });
        regions.forEach(reg => {
          const own = ownBoxes(reg);
          if (!own.length) return;
          const ox0 = Math.min(...own.map(b => b.x0)), oy0 = Math.min(...own.map(b => b.y0)), oy1 = Math.max(...own.map(b => b.y1));
          let x0 = ox0 - 2, x1 = textX1, y0 = oy0 - 1, y1;
          if (reg === R.stem) {
            // a drawing under the stem may reach down beside the first choice: the band ends at the first choice's letters, not its line box
            const firstChoiceTop = lblLines.length ? Math.min(...R.choices.filter(c => R.q.lines[c.label.line].page === p.no).map(c => { const ln = R.q.lines[c.label.line]; return Math.min(ln.base - ln.size * 0.55, ...c.imgs.filter(i => i.page === p.no).map(i => i.y0)); })) : qEnd;
            y1 = Math.max(oy1 + 1, Math.min(firstChoiceTop, qEnd));
            if (lblLines.length && R.q.lines[R.choices[0].label.line].page === p.no && R.choices[0].label.line === R.q.lines.indexOf(ls[ls.length - 1]) && false) y1 = oy1 + 1;
          } else {
            const lab = reg.label, ci = cols.findIndex(c => Math.abs(c - lab.x) <= 15);
            x0 = Math.min(x0, (lab.piece ? lab.piece.x1 : lab.xe) - 1);
            if (ci >= 0 && ci + 1 < cols.length) x1 = cols[ci + 1] - 3;
            // a choice is as wide as its own text and pictures (keeps a neighbouring drawing out of it)
            x1 = Math.min(x1, Math.max(...own.map(b => b.x1)) + 8);
            const sameCol = R.choices.filter(c => c !== reg && R.q.lines[c.label.line].page === p.no && Math.abs(c.label.x - lab.x) <= 15 && (c.label.line > lab.line));
            const nextTop = sameCol.length ? Math.min(...sameCol.map(c => Math.min(R.q.lines[c.label.line].top, ...c.imgs.filter(i => i.page === p.no).map(i => i.y0)))) : qEnd;
            y1 = Math.max(oy1 + 1, nextTop);
            y0 = Math.min(y0, R.q.lines[lab.line].page === p.no ? R.q.lines[lab.line].top - 1 : y0);
          }
          const others = all.filter(a => a.owner !== reg).map(a => a.b);
          const part = cutOut(cv, { x0, y0, x1, y1 }, own.filter(b => !b.img), others, {});
          // baseline of the first own text line (for aligning the number or bubble)
          const tl = R.pieces.filter(pc => pc.owner === reg && pc.line.page === p.no).map(pc => pc.line);
          const base = tl.length ? Math.min(...tl.map(l => l.base)) : null;
          const center = reg !== R.stem && reg.imgs.length > 0;
          addPart(reg, part, base, center);
        });
      });
      // ---- non-question content on this page: listed under "Not used" by default (the teacher can opt in) ----
      const qLines = new Set(regs.flatMap(R => R.q.lines.filter(l => l.page === p.no)));
      const secs = sections.filter(s => s.pages.has(p.no));
      const textual = p.chars - p.rotChars;
      const secLines = new Set();
      const qTops = regs.flatMap(R => R.q.lines.filter(l => l.page === p.no).map(l => l.top));
      secs.forEach(sec => {
        const ls = sec.lines.filter(l => l.page === p.no);
        ls.forEach(l => secLines.add(l));
        const top = ls.includes(sec.heading) ? sec.heading.top - 3 : inner.y0;
        const nextQ = qTops.filter(t => t > top + 1);
        const bottom = nextQ.length ? Math.min(...nextQ) - 2 : inner.y1;
        const otherBoxes = all.filter(a => typeof a.owner === 'object').map(a => a.b);
        const part = cutOut(cv, { x0: inner.x0, y0: top, x1: inner.x1, y1: bottom }, [], otherBoxes, {});
        if (!part) return;
        const grid = tableShape(ls.filter(l => l !== sec.heading));
        pageItems.push({ kind: 'ignored', suggest: 'written', page: p.no, img: finishCrop([part]), caption: sec.title + (sec.pages.size > 1 ? ` (page ${p.no})` : ''), rows: grid.rows, cols: grid.cols,
          points: grid.rows && grid.cols > 1 ? grid.rows * (grid.cols - 1) : 10, why: (grid.cols >= 3 ? 'a table' : 'a section without numbered questions') + ': not used by default. Choose "Written page" to print it with answer space, or "Reference page" to print it ungraded.' });
      });
      if (!regs.length && !secs.length) {
        const part = cutOut(cv, { x0: inner.x0, y0: inner.y0, x1: inner.x1, y1: inner.y1 }, [], [], {});
        const crop = part ? finishCrop([part]) : null;
        let kind = 'ignored', why = '', suggest = 'reference';
        if (firstQPage !== null && p.no < firstQPage && p.no === 1) { kind = 'cover'; why = 'cover page: replaced by the app cover (name and ID bubbles); you can keep it as an extra page'; }
        else if (firstQPage !== null && p.no < firstQPage) why = 'before the first question: not used by default';
        else {
          const sheet = looksLikeBubbleSheet(cv, g, GW, GH, opts.debug ? warnings : null, p.no);
          if (sheet) { why = 'looks like a separate bubble answer sheet; the printed exam has its own bubbles'; suggest = null; }
          else why = (textual < 40 ? 'a page without text (a picture or chart, for example a periodic table)' : 'a page without numbered questions') + ': not used by default. Choose "Reference page" to print it ungraded.';
          if (!sheet && tableShape(p.lines).cols >= 3) suggest = 'written';
        }
        if (crop) pageItems.push({ kind, suggest, page: p.no, img: crop, caption: `Page ${p.no}`, why, points: 10 });
        info.kind = kind;
      } else info.kind = regs.length ? 'mc' : 'section';
      // lines on this page that are in no question and no page item
      const loose = p.lines.filter(l => !qLines.has(l) && !secLines.has(l) && l.role !== 'blank' && l.role !== 'meta' && (regs.length || secs.length));
      const blocks = [];
      loose.forEach(l => { const b = blocks[blocks.length - 1]; if (b && l.top - b.y1 < l.size * 1.2 && !!b.lines[0].trimmedFrom === !!l.trimmedFrom) { b.lines.push(l); b.y1 = l.bottom; } else blocks.push({ lines: [l], y0: l.top, y1: l.bottom }); });
      blocks.forEach(b => {
        const own = b.lines.flatMap(l => l.items.map(it => ({ x0: it.x, x1: it.x + it.w, y0: it.y - it.h * 0.8, y1: it.y + it.h * 0.3 })));
        const part = cutOut(cv, { x0: textX0, y0: b.y0 - 2, x1: textX1, y1: b.y1 + 2 }, own, all.filter(a => typeof a.owner === 'object').map(a => a.b), {});
        const l0 = b.lines[0];
        const why = l0.role === 'furniture' ? 'page header or footer' : RE_HEAD.test(l0.text) ? 'section heading (the printed exam uses its own headings)'
          : l0.trimmedFrom !== undefined ? `found after question ${l0.trimmedFrom} but not part of its choices` : 'not part of a question';
        unused.push({ page: p.no, text: b.lines.map(l => l.text).join(' '), img: part ? finishCrop([part]) : null, why, warn: l0.role !== 'furniture' && !RE_HEAD.test(l0.text) });
      });
      p.floats.filter(im => !im.owner && (regs.length || secs.length)).forEach(im => {
        const part = cutOut(cv, { x0: im.x0 - 1, y0: im.y0 - 1, x1: im.x1 + 1, y1: im.y1 + 1 }, [im], [], {});
        unused.push({ page: p.no, text: '(picture)', img: part ? finishCrop([part]) : null, why: 'picture outside the questions', warn: true });
      });
      page.cleanup();
      cv.width = cv.height = 1;
    }
    pdf.destroy();

    // ---- questions out ----
    const mc = Q.map(R => {
      const fin = reg => { const parts = crops.get(reg) || []; const rb = regionBase.get(reg) || {}; return finishCrop(parts, rb.base, rb.center); };
      const textOf = reg => {
        const byLine = new Map();
        R.pieces.filter(pc => pc.owner === reg).forEach(pc => { if (!byLine.has(pc.line)) byLine.set(pc.line, []); byLine.get(pc.line).push(pc); });
        const out = [];
        byLine.forEach((pcs, ln) => {
          const items = pcs.map(pc => ({ ...pc.it, str: pc.it.str.slice(pc.a, pc.b), x: pc.x0, w: pc.x1 - pc.x0 }));
          out.push(lineText(items, ln));
        });
        return out.reduce((s, t) => !s ? t : /[A-Za-z]-$/.test(s) ? s + t : s + ' ' + t, '').replace(/\s+/g, ' ').trim();
      };
      const look = { stem: fin(R.stem), choices: R.choices.map(fin) };
      const hasImg = R.stem.imgs.length > 0;
      return {
        num: R.num, page: R.q.page, odd: R.q.odd, stem: textOf(R.stem), choices: R.choices.map(c => textOf(c) || (c.imgs.length ? '[picture]' : '')), look,
        imgChoices: R.choices.map(c => c.imgs.length > 0), stemImg: hasImg, markedChoice: R.choices.findIndex(c => c.marked)
      };
    });
    const hid = pages.reduce((a, p) => a + p.hidden, 0);
    if (hid) warnings.push({ level: 'info', msg: `${hid} piece(s) of hidden text (white, invisible or covered, not on the paper) were ignored.` });
    // never fail silently: choices that look unsplit, missing choices, text that could not be placed
    const LBL = /(?:^|\s)\(?([A-Ha-h])\s*[.)]\s/;
    mc.forEach(q => {
      if (!q.choices.length) warnings.push({ level: 'warn', msg: `Question ${q.num}: no answer choices were found (labels like A. or a) at the start of a line). Check it on the page images.`, raw: q.stem });
      else if (q.choices.length === 1) warnings.push({ level: 'warn', msg: `Question ${q.num}: only choice A was found. Check whether its other choices were missed.`, raw: q.choices[0] });
      q.choices.forEach((c, k) => { const m = c.match(LBL); if (m && 'ABCDEFGH'.indexOf(m[1].toUpperCase()) > k) warnings.push({ level: 'warn', msg: `Question ${q.num}, choice ${'ABCDEFGH'[k]} contains "${m[1]}${c.slice(m.index).trim()[1] || '.'}": its choices may not be split correctly. Check this question.`, raw: c }); });
      const sm = q.stem.match(/\s\(?([Aa])\s*[.)]\s.*\s\(?[Bb]\s*[.)]\s/);
      if (sm && q.choices.length) warnings.push({ level: 'warn', msg: `Question ${q.num}: the question text contains what look like choice labels. Check this question.`, raw: q.stem });
    });
    unused.filter(u => u.warn).forEach(u => warnings.push({ level: 'warn', msg: `Page ${u.page}: text that is in no question (${u.why}) is listed under Not used.`, raw: u.text.slice(0, 200) }));
    if (opts.debug) return { pages: pageInfo, mc, pageItems, unused, warnings, dpi: DPI, debug: pages.map(p => p.lines.map(l => [Math.round(l.x0), Math.round(l.base), l.text, l.role])) };
    return { pages: pageInfo, mc, pageItems, unused, warnings, dpi: DPI };
  }

  // rows x columns of a table from its text: header line with several columns, row labels at the left
  function tableShape(lines) {
    const vis = lines.filter(l => l.text).sort((a, b) => a.base - b.base);
    if (!vis.length) return { rows: 0, cols: 0 };
    const head = vis.find(l => clusterX(l.items).length >= 3);
    if (!head) return { rows: 0, cols: 0 };
    // the header block: neighbouring lines in the same (small) type above and below
    const hi = vis.indexOf(head), band = [head];
    const fits = (l, ref) => l.size <= head.size * 1.15 && Math.abs(l.base - ref.base) <= head.size * 2;
    for (let k = hi - 1; k >= 0 && fits(vis[k], band[0]); k--) band.unshift(vis[k]);
    for (let k = hi + 1; k < vis.length && fits(vis[k], band[band.length - 1]); k++) band.push(vis[k]);
    const hx = clusterX(band.flatMap(l => l.items));
    const firstColEnd = hx.length > 1 ? hx[1] - 4 : 1e9;
    const bottom = Math.max(...band.map(b => b.base));
    const below = vis.filter(l => l.base > bottom + 1 && l.x0 < firstColEnd);
    let rows = 0, last = -1e9;
    below.forEach(l => { if (l.top - last > l.size * 1.6) rows++; last = l.bottom; });
    return { rows, cols: hx.length };
  }
  // column starts from item centres (headers are often centred in their cells)
  function clusterX(items) {
    const cs = items.filter(i => !blank(i.str)).map(i => ({ c: i.x + i.w / 2, x: i.x })).sort((a, b) => a.c - b.c);
    const out = []; let last = -1e9;
    cs.forEach(o => { if (o.c - last > 22) out.push(o.x); else out[out.length - 1] = Math.min(out[out.length - 1], o.x); last = o.c; });
    return out;
  }
  // another bubble sheet (four solid corner squares like the app's own pages)
  function looksLikeBubbleSheet(cv, g, W, H, dbg, no) {
    try {
      const d = CV.grayScaled(cv, cv.width, cv.height, 1100);
      const mk = !!CV.detectMarkers(d.g, d.w, d.h).found, rings = mk ? ringCount(g, W, H, DPI) : 0;
      if (dbg) dbg.push({ level: 'info', msg: `debug page ${no}: markers ${mk}, rings ${rings}` });
      return mk && rings >= 150;
    } catch (e) { return false; }
  }
  // small hollow circles (answer bubbles) on a gray image; ppi = pixels per inch
  function ringCount(g, w, h, ppi) {
    const bin = new Uint8Array(w * h); for (let i = 0; i < g.length; i++) bin[i] = g[i] < 170 ? 1 : 0;
    const seen = new Uint8Array(w * h), st = new Int32Array(w * h);
    const lo = ppi * 0.07, hi = ppi * 0.3;
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!bin[i] || seen[i]) continue;
      let sp = 0, cnt = 0, x0 = w, x1 = 0, y0 = h, y1 = 0; st[sp++] = i; seen[i] = 1;
      while (sp) {
        const p = st[--sp], x = p % w, y = (p - x) / w; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && bin[q] && !seen[q] && Math.abs((q % w) - x) <= 1) { seen[q] = 1; st[sp++] = q; }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw >= lo && bw <= hi && bh >= lo && bh <= hi && bw / bh > 0.75 && bw / bh < 1.33 && cnt / (bw * bh) < 0.45) n++;
    }
    return n;
  }

  return { analyze, DPI, lineText, script, SUP, SUB };
})();
