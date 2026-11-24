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
      const o = { str: it.str, x, y, w, h, rot, page: no, font: it.fontName };
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
      // ink colour of each text item (a key written in blue or red) and a coloured background behind it (highlighter)
      items.forEach(o => {
        if (o.rot) return;
        const x0 = Math.max(0, Math.floor(o.x * 1.5)), x1 = Math.min(W - 1, Math.ceil((o.x + o.w) * 1.5));
        const y0 = Math.max(0, Math.floor((o.y - o.h * 0.75) * 1.5)), y1 = Math.min(H - 1, Math.ceil((o.y + o.h * 0.15) * 1.5));
        let n = 0, r = 0, gg = 0, b = 0, bgN = 0, bgC = 0, tot = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2], sum = R + G + B; tot++;
          if (sum < 3 * 170) { n++; r += R; gg += G; b += B; }
          else if (sum < 3 * 248) { bgN++; if (Math.max(R, G, B) - Math.min(R, G, B) > 40) bgC++; }
        }
        if (n >= 3) { r /= n; gg /= n; b /= n; o.rgb = [Math.round(r), Math.round(gg), Math.round(b)]; o.colored = Math.max(r, gg, b) - Math.min(r, gg, b) > 60; }
        o.hl = tot > 20 && bgC > 0.35 * tot;
      });
      // bold type (a key marked in bold): the font's own name, known once the page is rendered
      items.forEach(o => { try { const f = o.font && page.commonObjs.has(o.font) ? page.commonObjs.get(o.font) : null; o.bold = !!(f && /bold|black|heavy|semibold|demi/i.test(f.name || '')); } catch (e) { o.bold = false; } });
      c.width = c.height = 1;
    } catch (e) { /* keep everything */ }
    // images: follow the transformation matrix through the operator list
    const images = [], ellipses = [], rules = [];
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
        else if (f === O.constructPath && a && a[0]) {
          // small closed curves (a circled answer letter) and thin horizontal strokes (an underlined answer)
          const ops = a[0], args = a[1] || [], P = [];
          let k = 0, nC = 0, nM = 0, nL = 0, nR = 0;
          for (const o of ops) {
            if (o === O.moveTo) { nM++; P.push([args[k], args[k + 1]]); k += 2; }
            else if (o === O.lineTo) { nL++; P.push([args[k], args[k + 1]]); k += 2; }
            else if (o === O.curveTo) { nC++; P.push([args[k], args[k + 1]], [args[k + 2], args[k + 3]], [args[k + 4], args[k + 5]]); k += 6; }
            else if (o === O.curveTo2 || o === O.curveTo3) { nC++; P.push([args[k], args[k + 1]], [args[k + 2], args[k + 3]]); k += 4; }
            else if (o === O.rectangle) { nR++; const [x, y, w, h] = args.slice(k, k + 4); P.push([x, y], [x + w, y + h]); k += 4; }
          }
          if (P.length) {
            const m = T(vp.transform, ctm);
            const tp = P.map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
            const xs = tp.map(q => q[0]), ys = tp.map(q => q[1]);
            const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), page: no };
            const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
            // control points of a circle drawn with Bezier curves lie on its bounding box
            if (nC >= 2 && nM === 1 && nL <= 1 && !nR && bw >= 5 && bh >= 5 && bw <= 60 && bh <= 30 && bw / bh > 0.4 && bw / bh < 3) ellipses.push(b);
            else if (!nC && (nL || nR) && bh <= 1.6 && bw >= 6) rules.push(b);
          }
        }
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
    return { no, w: vp.width, h: vp.height, items, images, lines, floats, chars, rotChars, hidden, ellipses, rules };
  }

  // text of a run of items with spaces from gaps and super/subscripts from size and baseline
  function lineText(items, ln) {
    let s = '', end = null;
    for (const it of items) {
      const gap = end === null ? 0 : it.x - end;
      if (end !== null && gap > Math.max(1, it.h * 0.15) && !/\s$/.test(s) && !/^\s/.test(it.str)) s += gap > 24 ? '   ' : ' ';
      let t = it.str;
      if (ln && it.h < ln.size * 0.85) {
        if (ln.base - it.y > ln.size * 0.12) t = t.trim() ? '^{' + t.trim() + '}' : t;
        else if (it.y - ln.base > ln.size * 0.04) t = t.trim() ? '_{' + t.trim() + '}' : t;
      }
      s += t; end = it.x + it.w;
    }
    // neighbouring raised (or lowered) pieces are one superscript: 10^{-}^{2} -> 10^{-2}
    for (let k = 0; k < 4; k++) s = s.replace(/\^\{([^{}]*)\}\^\{([^{}]*)\}/g, '^{$1$2}').replace(/_\{([^{}]*)\}_\{([^{}]*)\}/g, '_{$1$2}');
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

  const area_ = b => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const overlap = (a, b) => area_({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const near = (a, b, d) => a.x0 - d < b.x1 && b.x0 - d < a.x1 && a.y0 - d < b.y1 && b.y0 - d < a.y1;
  const union = (...bs) => ({ x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) });
  // groups of ink in an area (pt) once all text and pictures are painted white: the drawings
  function vectorClusters(src, rect, whites) {
    const x = Math.max(0, Math.floor(rect.x0 * K)), y = Math.max(0, Math.floor(rect.y0 * K));
    const w = Math.min(src.width - x, Math.ceil((rect.x1 - rect.x0) * K)), h = Math.min(src.height - y, Math.ceil((rect.y1 - rect.y0) * K));
    if (w < 4 || h < 4) return [];
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    ctx.fillStyle = '#fff';
    whites.forEach(b => ctx.fillRect(b.x0 * K - x - 2, b.y0 * K - y - 2, (b.x1 - b.x0) * K + 4, (b.y1 - b.y0) * K + 4));
    const g = grayOf(ctx, 0, 0, w, h);
    const S = 3, mw = Math.ceil(w / S), mh = Math.ceil(h / S), m = new Uint8Array(mw * mh);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (g[yy * w + xx] < 170) m[((yy / S) | 0) * mw + ((xx / S) | 0)] = 1;
    const seen = new Uint8Array(mw * mh), boxes = [];
    for (let i = 0; i < mw * mh; i++) {
      if (!m[i] || seen[i]) continue;
      const st = [i]; seen[i] = 1; let x0 = mw, x1 = 0, y0 = mh, y1 = 0, n = 0;
      while (st.length) {
        const q = st.pop(), qx = q % mw, qy = (q - qx) / mw; n++;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy; if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          const k = ny * mw + nx; if (m[k] && !seen[k]) { seen[k] = 1; st.push(k); }
        }
      }
      if (n < 2) continue;
      boxes.push({ x0: (x + x0 * S) / K, y0: (y + y0 * S) / K, x1: (x + (x1 + 1) * S) / K, y1: (y + (y1 + 1) * S) / K });
    }
    // drawings are often several strokes: merge pieces that are close
    let merged = true;
    while (merged) {
      merged = false;
      for (let a = 0; a < boxes.length && !merged; a++) for (let b = a + 1; b < boxes.length; b++) if (near(boxes[a], boxes[b], 5)) { boxes[a] = union(boxes[a], boxes[b]); boxes.splice(b, 1); merged = true; break; }
    }
    return boxes.filter(b => b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2);
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

  // several figures of one choice: one picture
  function stackFigs(list) {
    return Object.assign({}, list[0], { more: list.slice(1) });
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
    // the key colour: the most used non-black text colour (a key typed in blue or red); null when the text is all black
    const keyRGB = (() => {
      const bins = new Map();
      pages.forEach(p => p.items.forEach(it => { if (!it.colored) return; const k = it.rgb.map(v => v >> 5).join(','); const b = bins.get(k) || { n: 0, rgb: [0, 0, 0] }; const n = it.str.replace(/\s/g, '').length; b.n += n; b.rgb = b.rgb.map((v, i) => v + it.rgb[i] * n); bins.set(k, b); }));
      let best = null; bins.forEach(b => { if (!best || b.n > best.n) best = b; });
      return best && best.n >= 8 ? best.rgb.map(v => v / best.n) : null;
    })();
    const nearKey = rgb => !!(keyRGB && rgb && Math.hypot(rgb[0] - keyRGB[0], rgb[1] - keyRGB[1], rgb[2] - keyRGB[2]) < 90 && Math.max(...rgb) - Math.min(...rgb) > 50);
    const keyItem = it => !!(it && it.colored && nearKey(it.rgb));
    // average ink colour of a cut-out (drawings in the key colour are part of the answer key)
    const inkRGB = cnv => {
      const d = cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height).data; let n = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 16) { if (Math.min(d[i], d[i + 1], d[i + 2]) < 200) { n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; } }
      return n ? [r / n, g / n, b / n] : null;
    };
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
        const end = nl.length ? Math.min(...nl.map(l => l.top)) : p.h;   // the last question on a page owns the pictures below it
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
    const figOut = new Map();         // region -> [figure crop]
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
      const info = { no: p.no, w: p.w, h: p.h, thumb: tc.toDataURL('image/jpeg', 0.75), chars: p.chars, kind: null, text: p.lines.filter(l => !l.furniture && l.text).map(l => l.text).join('\n') };
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
      // ---- figures: pictures, drawings and stacked glyph arrangements; everything else stays text ----
      const textBoxes = p.items.filter(it => !it.rot).map(it => ({ x0: it.x, x1: it.x + it.w, y0: it.y - it.h * 0.8, y1: it.y + it.h * 0.3 }));
      regs.forEach(R => {
        const ls = R.q.lines.filter(l => l.page === p.no);
        if (!ls.length) return;
        const nextR = Q[Q.indexOf(R) + 1];
        const nls = nextR ? nextR.q.lines.filter(l => l.page === p.no) : [];
        const qTop = Math.min(...ls.map(l => l.top)) - 2;
        const qEnd = nls.length ? Math.min(...nls.map(l => l.top)) - 1 : Math.min(inner.y1, Math.max(...ls.map(l => l.bottom), ...[R.stem, ...R.choices].flatMap(r => r.imgs.filter(i => i.page === p.no).map(i => i.y1))) + 24);
        const regions = [R.stem, ...R.choices];
        const piecesOf = reg => R.pieces.filter(pc => pc.owner === reg && pc.line.page === p.no);
        const lbls = R.choices.map(c => c.label).filter(l => R.q.lines[l.line].page === p.no);
        const firstChoiceTop = lbls.length ? Math.min(...lbls.map(l => { const ln = R.q.lines[l.line]; return ln.base - ln.size * 0.75; })) : 1e9;
        const regionAt = (cx, cy) => {
          if (cy < firstChoiceTop) return R.stem;
          const xs = lbls.map(l => l.x).sort((a, b) => a - b);
          const before = lbls.filter(l => R.q.lines[l.line].base - R.q.lines[l.line].size <= cy);
          const inCol = before.filter(l => { const nx = xs.find(x => x > l.x + 15); return cx >= l.x - 6 && (nx === undefined || cx < nx - 3); });
          const lab = inCol.pop() || before.pop();
          return lab ? R.choices[R.labels.indexOf(lab)] : R.stem;
        };
        const figs = new Map();   // region -> [{ box, absorb: [pieces], img }]
        const addFig = (reg, f) => { if (!figs.has(reg)) figs.set(reg, []); figs.get(reg).push(f); };
        // 1) pictures (raster images) that belong to a region
        regions.forEach(reg => reg.imgs.filter(i => i.page === p.no).forEach(im => addFig(reg, { box: { x0: im.x0, y0: im.y0, x1: im.x1, y1: im.y1 }, absorb: [], raster: true })));
        // 2) glyph arrangements: two or more stacked short non-prose lines inside one region (structures typed with letters, dots, dashes)
        regions.forEach(reg => {
          const byLine = new Map();
          piecesOf(reg).forEach(pc => { if (!byLine.has(pc.line)) byLine.set(pc.line, []); byLine.get(pc.line).push(pc); });
          const rows = [...byLine.entries()].sort((a, b) => a[0].base - b[0].base);
          const isGlyph = pcs => { const t = pcs.map(pc => pc.s).join(' ').replace(/\s+/g, ' ').trim(); return t.replace(/\s/g, '').length <= 14 && !/[a-z]{4,}/.test(t) && !/^\d{1,3}\s*[.)]/.test(t) && !/[?]$/.test(t); };
          let run = [];
          const flush = () => {
            if (run.length >= 2) {
              const ab = run.flatMap(r => r[1]);
              addFig(reg, { box: { x0: Math.min(...ab.map(pc => pc.x0)), x1: Math.max(...ab.map(pc => pc.x1)), y0: Math.min(...ab.map(pc => pc.it.y - pc.it.h * 0.8)), y1: Math.max(...ab.map(pc => pc.it.y + pc.it.h * 0.3)) }, absorb: ab, glyph: true });
            }
            run = [];
          };
          rows.forEach(r => { if (isGlyph(r[1]) && (!run.length || r[0].top - run[run.length - 1][0].bottom < r[0].size * 1.6)) run.push(r); else { flush(); if (isGlyph(r[1])) run.push(r); } });
          flush();
        });
        // 3) drawings: ink that is not text and not a picture
        const area = { x0: textX0, y0: qTop, x1: textX1, y1: qEnd };
        const taken = [...figs.values()].flat().map(f => f.box);
        const clusters = vectorClusters(cv, area, textBoxes.concat(p.images.map(im => ({ x0: im.x0, y0: im.y0, x1: im.x1, y1: im.y1 }))));
        clusters.forEach(cb => {
          if (taken.some(t => overlap(t, cb) > 0.5 * area_(cb))) return;
          // part of a glyph arrangement (bond lines between letters)
          const gf = [...figs.values()].flat().find(f => f.glyph && near(f.box, cb, 6));
          if (gf) { gf.box = union(gf.box, cb); return; }
          if (cb.x1 - cb.x0 < 8 || cb.y1 - cb.y0 < 8) return;
          const reg = regionAt((cb.x0 + cb.x1) / 2, (cb.y0 + cb.y1) / 2);
          const inside = piecesOf(reg).filter(pc => { const cx = (pc.x0 + pc.x1) / 2, cy = pc.it.y - pc.it.h * 0.3; return cx > cb.x0 - 3 && cx < cb.x1 + 3 && cy > cb.y0 - 3 && cy < cb.y1 + 3; });
          const all_ = piecesOf(reg).reduce((a, pc) => a + pc.s.trim().length, 0), inn = inside.reduce((a, pc) => a + pc.s.trim().length, 0);
          if (inn > 0.3 * all_ && inn > 12) return;      // a frame around the question text, not a figure
          addFig(reg, { box: inside.length ? union(cb, ...inside.map(pc => ({ x0: pc.x0, x1: pc.x1, y0: pc.it.y - pc.it.h * 0.8, y1: pc.it.y + pc.it.h * 0.3 }))) : cb, absorb: inside, drawing: true });
        });
        // cut each figure out at full resolution (text of other parts painted white)
        figs.forEach((list, reg) => {
          list.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
          list.forEach(f => {
            f.absorb.forEach(pc => { pc.figure = true; });
            const ownB = f.absorb.map(boxOf);
            const others = all.filter(a => !a.img && !f.absorb.some(pc => boxOf(pc).x0 === a.b.x0 && boxOf(pc).y0 === a.b.y0)).map(a => a.b)
              .concat(p.images.filter(im => !(Math.abs(im.x0 - f.box.x0) < 0.5 && Math.abs(im.y0 - f.box.y0) < 0.5) && !(im.x0 >= f.box.x0 - 1 && im.x1 <= f.box.x1 + 1 && im.y0 >= f.box.y0 - 1 && im.y1 <= f.box.y1 + 1)).map(im => ({ ...im, img: true })));
            const b = f.box, pad = f.raster ? 0.5 : 2;
            const part = cutOut(cv, { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, ownB, f.raster ? [] : others, {});
            if (!part) return;
            f.part = part;
          });
          // a choice gets one picture (several pieces stacked); the stem keeps each figure
          const done = list.filter(f => f.part);
          const groups = reg === R.stem ? done.map(f => [f]) : (done.length ? [done] : []);
          groups.forEach(gr => {
            const crop = finishCrop(gr.map(f => f.part));
            const f = gr[0], b = union(...gr.map(x => x.box));
            // a drawing or typed structure in the key colour is part of the answer key, never part of the question
            crop.key = !!keyRGB && gr.every(x => !x.raster && (x.glyph ? x.absorb.filter(pc => keyItem(pc.it)).length >= 0.6 * Math.max(1, x.absorb.length) : nearKey(inkRGB(x.part.canvas))));
            crop.parts = gr.map(x => x.part);
            crop.kind = f.raster ? 'picture' : f.glyph ? 'glyphs' : 'drawing';
            crop.page = p.no; crop.box = { x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) };
            if (!figOut.has(reg)) figOut.set(reg, []);
            figOut.get(reg).push(crop);
          });
        });
        // answer drawings in the key colour (a structure the student must draw): one key picture with the key-coloured
        // labels around them (CH2OH, OH, ...); those labels then stay out of the typed key text
        const keyDraw = [...figs.values()].flat().filter(f => f.part && !f.raster && keyRGB && (f.glyph ? f.absorb.filter(pc => keyItem(pc.it)).length >= 0.6 * Math.max(1, f.absorb.length) : nearKey(inkRGB(f.part.canvas))));
        // typed key layouts (a reaction set out in columns) count as drawings too; key prose stays typed text
        const kp = R.pieces.filter(pc => pc.line.page === p.no && keyItem(pc.it) && !blank(pc.s));
        const prose = pc => (pc.line.text.match(/[a-z]{4,}/g) || []).length >= 3 && !/\s{3}/.test(pc.line.text);
        const spread = kp.filter(pc => { const ks = pc.line.items.filter(keyItem).sort((x, y) => x.x - y.x); return ks.some((it, i) => i && it.x - (ks[i - 1].x + ks[i - 1].w) > 24) || /\S\s{6,}\S/.test(pc.it.str); });
        if (keyDraw.length || spread.length) {
          let U = union(...keyDraw.map(f => f.box), ...spread.map(boxOf));
          const inc = new Set([...keyDraw.flatMap(f => f.absorb), ...spread]);
          for (let grow = true; grow;) { grow = false; kp.forEach(pc => { if (!inc.has(pc) && !prose(pc) && near(boxOf(pc), U, 14)) { inc.add(pc); U = union(U, boxOf(pc)); grow = true; } }); }
          const own = [...inc].map(boxOf);
          const others = all.filter(a => !a.img && !own.some(b => b.x0 === a.b.x0 && b.y0 === a.b.y0)).map(a => a.b);
          const part = cutOut(cv, { x0: U.x0 - 2, y0: U.y0 - 2, x1: U.x1 + 2, y1: U.y1 + 2 }, own, others, {});
          if (part) { (R.keyParts = R.keyParts || []).push(part); inc.forEach(pc => { pc.keyFig = true; }); }
        }
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
          else if (textual < 40 && firstQPage !== null && p.no > Math.max(...Q.map(R => R.q.page))) { kind = 'reference'; why = 'a picture or chart after the questions (for example a table of structures): printed as a reference page, not graded. Choose "Not used" to leave it out.'; }
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

    // ---- answer key marks and written questions ----
    const charsOf = pcs => pcs.reduce((a, pc) => a + pc.s.replace(/\s/g, '').length, 0);
    const ownPieces = (R, reg) => R.pieces.filter(pc => pc.owner === reg);
    // a piece is answer-key text: in the key colour, and either most of its line is key text or it is written on a blank (____)
    const lineKeyFrac = ln => { const all = ln.items.reduce((a, it) => a + it.str.replace(/\s/g, '').length, 0); const k = ln.items.filter(keyItem).reduce((a, it) => a + it.str.replace(/\s/g, '').length, 0); return all ? k / all : 0; };
    const onBlank = pc => pc.line.items.some(it => { if (it === pc.it) return false; const m = it.str.match(/_{3,}/); if (!m) return false; const cpw = it.w / Math.max(1, it.str.length), bx0 = it.x + m.index * cpw, bx1 = bx0 + m[0].length * cpw; return Math.min(bx1, pc.x1) - Math.max(bx0, pc.x0) > 0.5 * Math.min(pc.x1 - pc.x0, bx1 - bx0); });
    const isKeyPc = pc => keyItem(pc.it) && (lineKeyFrac(pc.line) >= 0.5 || onBlank(pc));
    // the marked choice of a multiple-choice question: a circled letter (or circled choice), else one choice set apart by
    // the key colour, bold type, a highlighter or an underline
    function keyMark(R) {
      const n = R.choices.length; if (n < 2) return null;
      const circ = R.choices.map(c => {
        const l = c.label, ln = R.q.lines[l.line], pg = pages[ln.page - 1];
        const cx = (l.x + (l.piece ? l.piece.x1 : l.xe)) / 2, cy = ln.base - ln.size * 0.35;
        return pg.ellipses.some(e => cx > e.x0 - 1.5 && cx < e.x1 + 1.5 && cy > e.y0 - 1.5 && cy < e.y1 + 1.5);
      });
      if (circ.filter(Boolean).length === 1) return { idx: circ.indexOf(true), by: 'circle' };
      const feats = {
        colour: pc => keyItem(pc.it) || !!pc.it.colored, bold: pc => !!pc.it.bold, highlight: pc => !!pc.it.hl,
        underline: pc => pages[pc.line.page - 1].rules.some(r => r.y0 > pc.line.base - 1.5 && r.y0 < pc.line.base + 4 && Math.min(r.x1, pc.x1) - Math.max(r.x0, pc.x0) > 0.5 * (pc.x1 - pc.x0))
      };
      for (const [by, f] of Object.entries(feats)) {
        const fr = R.choices.map(c => { const pcs = ownPieces(R, c).filter(pc => !blank(pc.s)); const all = charsOf(pcs); return all ? charsOf(pcs.filter(f)) / all : 0; });
        const on = fr.map(v => v >= 0.6), off = fr.filter(v => v <= 0.2).length;
        if (on.filter(Boolean).length === 1 && off === n - 1) return { idx: on.indexOf(true), by };
      }
      return null;
    }
    // a numbered question without choices, or whose a./b./c. parts hold the answers (key-coloured answer lines, or large
    // answer spaces between the parts) is a written question
    function isWritten(R) {
      if (!R.choices.length) return true;
      const keyLines = R.choices.map(c => { const pcs = ownPieces(R, c).filter(pc => !blank(pc.s)); const all = charsOf(pcs), k = charsOf(pcs.filter(isKeyPc)); return { all, k, sepLine: pcs.some(pc => isKeyPc(pc) && pc.line !== R.q.lines[c.label.line]) }; });
      if (keyLines.some(x => x.sepLine && x.k >= 8)) return true;
      if (keyMark(R)) return false;
      if (keyLines.filter(x => x.all && x.k / x.all >= 0.6).length >= 2) return true;
      if (R.choices.some(c => c.imgs.length || (figOut.get(c) || []).length)) return false;
      const ls = R.choices.map(c => R.q.lines[c.label.line]);
      return ls.length >= 2 && ls.every((ln, i) => !i || (ln.page === ls[i - 1].page && ln.base - ls[i - 1].base > 4 * ln.size));
    }
    // prompt (what the student sees) and key (model answer) of a written question; key-coloured drawings go to the key picture
    function writtenOf(R, textOf) {
      const LIST = /^(_{2,}|•|·|▪|[-–]\s|\(?[a-zA-Z0-9]{1,2}[.)]\s)/;
      const linesOf = (reg, keep) => {
        const byLine = new Map();
        R.pieces.filter(pc => pc.owner === reg && !pc.figure && keep(pc)).forEach(pc => { if (!byLine.has(pc.line)) byLine.set(pc.line, []); byLine.get(pc.line).push(pc); });
        return [...byLine.entries()].map(([ln, pcs]) => ({ ln, t: lineText(pcs.map(pc => ({ ...pc.it, str: pc.it.str.slice(pc.a, pc.b), x: pc.x0, w: pc.x1 - pc.x0 })), ln) })).filter(x => x.t);
      };
      const join = ls => ls.reduce((s, x) => !s ? x.t : (LIST.test(x.t) ? s + '\n' + x.t : /[A-Za-z]-$/.test(s) ? s + x.t : s + ' ' + x.t), '');
      const bare = t => t.replace(/_{2,}/g, ' ').replace(/^\s*\(?[a-zA-Z0-9]{1,2}[.)]\s*/, '').replace(/\s+/g, ' ').trim();
      const keyLines = (reg, head) => {
        const ks = linesOf(reg, pc => isKeyPc(pc) && !pc.keyFig), out = [];
        ks.forEach((x, i) => {
          const rest = bare(linesOf(reg, pc => !isKeyPc(pc)).filter(y => y.ln === x.ln).map(y => y.t).join(' '));
          const t = x.t.replace(/^[_^]\{([^{}]*)\}$/, '$1');   // a letter written on a blank sits lower or higher than the line
          if (rest) out.push({ t: rest + ': ' + t, nl: true });
          else if (i === 0 && head) out.push({ t: head + (/[.)]$/.test(head) ? ' ' : ': ') + t, nl: true });
          else out.push({ t });
        });
        return out.reduce((s, x) => !s ? x.t : (x.nl || LIST.test(x.t) ? s + '\n' + x.t : /[A-Za-z]-$/.test(s) ? s + x.t : s + ' ' + x.t), '');
      };
      let prompt = join(linesOf(R.stem, pc => !isKeyPc(pc)));
      const key = [keyLines(R.stem, '')];
      R.choices.forEach(c => {
        const lbl = (c.label.piece ? c.label.piece.s : c.label.letter + '.').trim();
        const title = join(linesOf(c, pc => !isKeyPc(pc)));
        prompt += '\n' + (lbl + ' ' + title).trim();
        key.push(keyLines(c, (lbl + ' ' + bare(title)).trim()));
      });
      const figsOf = regs => regs.flatMap(r => figOut.get(r) || []);
      const allFigs = figsOf([R.stem, ...R.choices]);
      const keyFigs = allFigs.filter(f => f.key), promptFigs = allFigs.filter(f => !f.key);
      const kc = (R.keyParts || []).length ? finishCrop(R.keyParts) : null;
      const keyFig = kc ? Object.assign(kc, { kind: 'key', page: R.q.page }) : null;
      return { prompt: prompt.trim(), key: key.filter(Boolean).join('\n').trim(), promptFigs, keyFig };
    }

    // ---- questions out ----
    const mc = Q.map(R => {
      const fin = reg => { const parts = crops.get(reg) || []; const rb = regionBase.get(reg) || {}; return finishCrop(parts, rb.base, rb.center); };
      const textOf = reg => {
        const byLine = new Map();
        R.pieces.filter(pc => pc.owner === reg && !pc.figure).forEach(pc => { if (!byLine.has(pc.line)) byLine.set(pc.line, []); byLine.get(pc.line).push(pc); });
        const out = [];
        byLine.forEach((pcs, ln) => {
          const items = pcs.map(pc => ({ ...pc.it, str: pc.it.str.slice(pc.a, pc.b), x: pc.x0, w: pc.x1 - pc.x0 }));
          out.push(lineText(items, ln));
        });
        return out.reduce((s, t) => !s ? t : /[A-Za-z]-$/.test(s) ? s + t : s + ' ' + t, '').replace(/\s+/g, ' ').trim();
      };
      const stemFigs = (figOut.get(R.stem) || []).filter(f => !f.key);
      const chFigs = R.choices.map(c => (figOut.get(c) || []).filter(f => !f.key)[0] || null);
      const out = { num: R.num, page: R.q.page, odd: R.q.odd, stem: textOf(R.stem), choices: R.choices.map(textOf), stemFigs, choiceFigs: chFigs, markedChoice: R.choices.findIndex(c => c.marked) };
      if (isWritten(R)) Object.assign(out, writtenOf(R, textOf), { written: true, choices: [], choiceFigs: [] });
      else {
        const mk = keyMark(R);
        if (out.markedChoice < 0 && mk) { out.markedChoice = mk.idx; out.markedBy = mk.by; }
      }
      [...stemFigs, ...chFigs, ...(out.keyFigs || []), ...(out.promptFigs || [])].forEach(f => { if (f) delete f.parts; });
      return out;
    });
    mc.filter(q => q.written).forEach(q => { if (q.keyFig) delete q.keyFig.parts; });
    const hid = pages.reduce((a, p) => a + p.hidden, 0);
    if (hid) warnings.push({ level: 'info', msg: `${hid} piece(s) of hidden text (white, invisible or covered, not on the paper) were ignored.` });
    // never fail silently: choices that look unsplit, missing choices, text that could not be placed
    const LBL = /(?:^|\s)\(?([A-Ha-h])\s*[.)]\s/;
    mc.forEach(q => {
      if (q.written) return;
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
