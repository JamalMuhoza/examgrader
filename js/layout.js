/* Exam Grader - layout manifest (mm) and print-ready template PDF (jsPDF) */
'use strict';

const Layout = (() => {
  // Physical page: US Letter, all geometry in millimetres, origin top-left.
  const PAGE = { w: 215.9, h: 279.4 };
  const DPI = 150;
  const PX = DPI / 25.4;                 // px per mm on the rectified canvas
  const RW = Math.round(PAGE.w * PX);   // 1275
  const RH = Math.round(PAGE.h * PX);   // 1650
  const MK = { size: 8, inset: 10 };
  const MKC = MK.inset + MK.size / 2;   // marker centre offset from the page edge
  const MARKERS = [                      // TL, TR, BR, BL centres
    { x: MKC, y: MKC }, { x: PAGE.w - MKC, y: MKC },
    { x: PAGE.w - MKC, y: PAGE.h - MKC }, { x: MKC, y: PAGE.h - MKC }
  ];
  // Page code: 20 small squares on the top edge between the markers.
  const CODE = { n: 20, cell: 3.0, pitch: 4.2, y: 11.5 };
  CODE.x0 = (PAGE.w - ((CODE.n - 1) * CODE.pitch + CODE.cell)) / 2;
  const SAFE = { x0: 11, x1: 204.9, y0: 26, y1: 258 };
  const CONTENT = { top: 29, bottom: 256, left: 24, right: 196 };
  const BUB_R = 2.4;
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];

  function codeBits(hash, page) {
    const bits = [1, 0];
    for (let i = 7; i >= 0; i--) bits.push((hash >> i) & 1);
    for (let i = 5; i >= 0; i--) bits.push((page >> i) & 1);
    const chk = (hash * 3 + page * 5 + 7) & 15;
    for (let i = 3; i >= 0; i--) bits.push((chk >> i) & 1);
    return bits;
  }
  function decodeBits(bits) {
    if (bits.length !== CODE.n || bits[0] !== 1 || bits[1] !== 0) return null;
    let hash = 0, page = 0, chk = 0;
    for (let i = 2; i < 10; i++) hash = (hash << 1) | bits[i];
    for (let i = 10; i < 16; i++) page = (page << 1) | bits[i];
    for (let i = 16; i < 20; i++) chk = (chk << 1) | bits[i];
    if (((hash * 3 + page * 5 + 7) & 15) !== chk || page < 1) return null;
    return { hash, page };
  }
  function codeCells() {
    const out = [];
    for (let i = 0; i < CODE.n; i++) out.push({ x: CODE.x0 + i * CODE.pitch + CODE.cell / 2, y: CODE.y + CODE.cell / 2 });
    return out;
  }
  function examHash(exam) { return U.hash8(exam.id + '|' + (exam.version || '')); }

  const PTMM = 0.3528; // mm per point
  function lh(pt, k = 1.22) { return pt * PTMM * k; }

  // ---------- Unicode font (DejaVu Sans) for typed text with symbols the standard PDF fonts lack (⁻ ² ₂ × − →) ----------
  let UNI = null, uniLoading = null;
  function loadFont(url = 'fonts/DejaVuSans.ttf') {
    if (UNI) return Promise.resolve(true);
    if (!uniLoading) uniLoading = fetch(url).then(r => { if (!r.ok) throw new Error('font ' + r.status); return r.arrayBuffer(); }).then(buf => {
      const b = new Uint8Array(buf); let bin = '';
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      UNI = btoa(bin); return true;
    }).catch(() => { uniLoading = null; return false; });
    return uniLoading;
  }
  const NONLATIN = /[^\x00-\xff]/;
  function needsUni(...texts) { return !!UNI && texts.some(t => NONLATIN.test(String(t || ''))); }
  function uniFont(doc) {
    if (!doc.__uni) { doc.addFileToVFS('DejaVuSans.ttf', UNI); doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal'); doc.__uni = true; }
    return 'DejaVu';
  }
  function setF(doc, style, uni) { if (uni) doc.setFont(uniFont(doc), 'normal'); else doc.setFont('helvetica', style); }
  const imgFmt = src => /^data:image\/png/.test(src) ? 'PNG' : 'JPEG';

  // ---------- rich text: ^{..} superscript, _{..} subscript ----------
  const MARK = /\^\{([^{}]*)\}|_\{([^{}]*)\}/g;
  const hasMarkup = t => /\^\{[^{}]*\}|_\{[^{}]*\}/.test(String(t || ''));
  const SCRIPT = 0.68;
  function runsOf(text) {
    const out = []; let last = 0, m;
    text = String(text || ''); MARK.lastIndex = 0;
    while ((m = MARK.exec(text))) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), k: 0 });
      out.push({ t: m[1] !== undefined ? m[1] : m[2], k: m[1] !== undefined ? 1 : -1 });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), k: 0 });
    return out;
  }
  function runW(doc, r, size) { doc.setFontSize(r.k ? size * SCRIPT : size); return doc.getTextWidth(r.t); }
  // greedy word wrap of runs; a word may hold several runs ("H_{2}O"); lines are { runs: [...] }
  function richWrap(doc, text, width, size, style, uni) {
    setF(doc, style, uni);
    const lines = [];
    String(text || '').replace(/\r/g, '').split('\n').forEach(par => {
      if (!par.trim()) { lines.push(''); return; }
      const words = []; let cur = [];
      runsOf(par).forEach(r => {
        const t = uni ? r.t : U.pdfText(r.t);
        if (r.k) { cur.push({ t, k: r.k }); return; }
        t.split(/(\s+)/).forEach(seg => {
          if (!seg) return;
          if (/^\s+$/.test(seg)) { if (cur.length) words.push(cur); cur = []; }
          else cur.push({ t: seg, k: 0 });
        });
      });
      if (cur.length) words.push(cur);
      doc.setFontSize(size); const sp = doc.getTextWidth(' ');
      let line = [], lw = 0;
      const wOf = rs => rs.reduce((a, r) => a + runW(doc, r, size), 0);
      words.forEach(wd => {
        const ww = wOf(wd);
        // a word wider than the line is broken (after ')' or before '(' when possible); its pieces join without a space
        (ww > width ? breakWord(doc, wd, width, size) : [wd]).forEach((pc, pi) => {
          const pw = pi ? wOf(pc) : (pc === wd ? ww : wOf(pc)), sep = pi ? 0 : sp;
          if (line.length && lw + sep + pw > width) { lines.push({ runs: line }); line = []; lw = 0; }
          if (line.length && sep) { line.push({ t: ' ', k: 0 }); lw += sp; }
          line.push(...pc); lw += pw;
        });
      });
      if (line.length) lines.push({ runs: line });
    });
    doc.setFontSize(size);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  // split one over-long word (array of runs) into pieces no wider than width: breaks after ')' or before '(' first, then anywhere
  function breakWord(doc, wd, width, size) {
    const segs = []; let cur = [];
    wd.forEach(r => {
      if (r.k) { cur.push(r); return; }
      r.t.split(/(?<=\))|(?=\()/).forEach((f, i) => { if (!f) return; if (i && cur.length) { segs.push(cur); cur = []; } cur.push({ t: f, k: 0 }); });
    });
    if (cur.length) segs.push(cur);
    const wOf = rs => rs.reduce((a, r) => a + runW(doc, r, size), 0);
    const pieces = []; let pc = [], pw = 0;
    const flush = () => { if (pc.length) pieces.push(pc); pc = []; pw = 0; };
    segs.forEach(sg => {
      const w = wOf(sg);
      if (pw + w <= width) { pc.push(...sg); pw += w; return; }
      flush();
      if (w <= width) { pc.push(...sg); pw = w; return; }
      sg.forEach(r => [...r.t].forEach(ch => {   // a segment wider than the line: break between characters
        const c = { t: ch, k: r.k }, cw = runW(doc, c, size);
        if (pw + cw > width && pc.length) flush();
        const last = pc[pc.length - 1];
        if (last && last.k === c.k) last.t += ch; else pc.push(c);
        pw += cw;
      }));
    });
    flush();
    return pieces;
  }
  function drawRuns(doc, runs, x, y, size) {
    runs.forEach(r => {
      doc.setFontSize(r.k ? size * SCRIPT : size);
      const dy = r.k === 1 ? -size * 0.36 * PTMM : r.k === -1 ? size * 0.2 * PTMM : 0;
      doc.text(r.t, x, y + dy);
      x += doc.getTextWidth(r.t);
    });
    doc.setFontSize(size);
  }

  // ---------- text helpers ----------
  // width of one line of (rich) text in mm
  function textW(doc, text, size, uni) {
    if (!String(text || '').trim()) return 0;
    if (hasMarkup(text)) { setF(doc, 'normal', uni); const ln = richWrap(doc, text, 1e5, size, 'normal', uni)[0]; return ln && ln.runs ? ln.runs.reduce((a, r) => a + runW(doc, r, size), 0) : 0; }
    setF(doc, 'normal', uni); doc.setFontSize(size);
    return doc.getTextWidth(uni ? String(text) : U.pdfText(text));
  }
  function wrap(doc, text, width, size, style = 'normal', uni = false) {
    if (hasMarkup(text)) return richWrap(doc, text, width, size, style, uni);
    setF(doc, style, uni); doc.setFontSize(size);
    // a token wider than the line: the rich wrapper breaks it at a sensible place (never past the column edge)
    if ((uni ? String(text || '') : U.pdfText(text)).split(/\s+/).some(t => t && doc.getTextWidth(t) > width)) return richWrap(doc, text, width, size, style, uni);
    const paras = (uni ? String(text || '') : U.pdfText(text)).replace(/\r/g, '').split('\n');
    const lines = [];
    for (const p of paras) {
      if (!p.trim()) { lines.push(''); continue; }
      lines.push(...doc.splitTextToSize(p, width));
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  // ---------- layout computation ----------
  function compute(exam) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const L = {
      version: 2, page: PAGE, dpi: DPI, markers: MARKERS, markerSize: MK.size, code: CODE,
      hash: examHash(exam), pages: [], mc: [], sa: [], cover: null, texts: [], issues: []
    };
    const PT = 25.4 / 72;   // mm per PDF point (pictures cut from the teacher's PDF)
    // ---- cover (exam) or a compact header strip on page 1 (homework, quiz) ----
    const nd = Math.max(1, Math.min(12, exam.idDigits | 0 || 7));
    const compact = isCompact(exam);
    L.kind = kindOf(exam);
    let headEnd = null;
    if (compact) {
      const cover = { page: 1, compact: true };
      cover.name = { x: CONTENT.left, y: 37.4, w: 110, h: 8 };       // writing area; the Name line is its bottom edge
      cover.score = { x: 146, y: 36.6, w: 50, h: 9.6 };
      // flat student ID: one horizontal row of bubbles 0-9 per digit, rows stacked in up to two blocks side by side
      const idTop = 52.4, rowH = 6.2, pitch = 6.0, blockW = 86;
      const per = nd <= 3 ? nd : Math.ceil(nd / 2);
      cover.idBox = { x: CONTENT.left, y: idTop, w: CONTENT.right - CONTENT.left, h: per * rowH + 1.6 };
      cover.id = { r: BUB_R, cols: [], flat: true };
      for (let c = 0; c < nd; c++) {
        const bx = CONTENT.left + Math.floor(c / per) * blockW, cy = idTop + 0.8 + rowH / 2 + (c % per) * rowH;
        const write = { x: bx + 6, y: cy - 2.9, w: 6, h: 5.8 };
        const bubbles = [];
        for (let d = 0; d < 10; d++) bubbles.push({ d, x: bx + 17.5 + d * pitch, y: cy });
        cover.id.cols.push({ c, x: write.x + write.w / 2, y: cy, label: { x: bx + 2.6, y: cy }, write, bubbles });
      }
      cover.end = cover.idBox.y + cover.idBox.h + 2.6;   // separator line under the strip
      L.cover = cover;
      L.pages.push({ no: 1, kind: 'head' });
      headEnd = cover.end + 3.4;
    } else {
      const cover = { page: 1 };
      cover.name = { x: CONTENT.left, y: 74, w: 112, h: 14 };
      cover.score = { x: 146, y: 74, w: 50, h: 30 };
      const idTop = 110;
      const colW = 7.2;
      const idX0 = CONTENT.left + 4;
      cover.idBox = { x: CONTENT.left, y: idTop, w: nd * colW + 8, h: 0 };
      cover.id = { r: BUB_R, cols: [] };
      for (let c = 0; c < nd; c++) {
        const x = idX0 + c * colW + colW / 2;
        const write = { x: x - 3, y: idTop + 7, w: 6, h: 7 };
        const bubbles = [];
        for (let d = 0; d < 10; d++) bubbles.push({ d, x, y: idTop + 19 + d * 6.2 });
        cover.id.cols.push({ c, x, write, bubbles });
      }
      cover.idBox.h = 19 + 10 * 6.2 + 1;
      cover.instr = { x: cover.idBox.x + cover.idBox.w + 8, y: idTop, w: CONTENT.right - (cover.idBox.x + cover.idBox.w + 8) };
      L.cover = cover;
      L.pages.push({ no: 1, kind: 'cover' });
    }

    // ---- pages kept from the teacher's document in front of the questions (for example the original cover) ----
    let page = 1, y = CONTENT.bottom + 1;
    const newPage = (kind) => { page++; L.pages.push({ no: page, kind }); y = CONTENT.top; };
    const fitBox = (img, maxW, maxH) => { const w0 = img.wpt * PT, h0 = img.hpt * PT, k = Math.min(1, maxW / w0, maxH / h0); return { w: w0 * k, h: h0 * k }; };
    L.extra = [];
    // homework / quiz: the questions start under the header strip; pages kept from the teacher's document go after the questions
    const frontPages = () => (exam.frontPages || []).forEach(fp => {
      newPage('extra');
      const f = fitBox(fp.img, CONTENT.right - CONTENT.left, CONTENT.bottom - CONTENT.top);
      L.extra.push({ id: fp.id, page, kind: 'extra', img: { x: CONTENT.left + (CONTENT.right - CONTENT.left - f.w) / 2, y: CONTENT.top, w: f.w, h: f.h } });
      y = CONTENT.bottom + 1;
    });
    if (compact) y = headEnd; else frontPages();

    // ---- MC pages ----
    const mcs = exam.mc || [];
    const STEM_PT = 10.5, CH_PT = 10, STEM_LH = lh(STEM_PT), CH_LH = lh(CH_PT);
    // homework / quiz: two columns filled column by column (a question never splits); exam: one column
    const stemX = 31, bubX = 34, chX = 39.5;
    const COLDX = 89, COL2_X0 = 108.5;
    const FLAT_TXT = BUB_R + (chX - bubX), FLAT_GAP = 5.2;  // side-by-side choices: bubble edge to text, text end to the next bubble edge (room for marks)                     // column 2 offset; left edge of column 2's mark lane
    const stemW = compact ? 76 : CONTENT.right - stemX, chW = stemW - (chX - stemX);
    // original look: one scale for every cut-out so the type size stays even (shrunk only when the widest piece needs it)
    const lookOn = q => exam.keepLook !== false && q.look && !q.useText && (q.look.stem || (q.look.choices || []).some(Boolean));
    let maxS = 0, maxC = 0;
    mcs.filter(lookOn).forEach(q => { if (q.look.stem) maxS = Math.max(maxS, q.look.stem.wpt * PT); (q.look.choices || []).forEach(c => { if (c) maxC = Math.max(maxC, c.wpt * PT); }); });
    const LS = Math.min(1, maxS ? stemW / maxS : 1, maxC ? chW / maxC : 1);
    L.lookScale = LS;
    const imgsH = (imgs, w) => (imgs || []).filter(Boolean).reduce((a, im) => a + fitBox(im, w, 70).h + 1.2, 0);
    const placed = [];
    mcs.forEach((q, qi) => {
      const look = lookOn(q);
      const uni = !look && exam.uniText === true && !!UNI;   // one font for every question (symbols and scripts print the same everywhere)
      const nCh = Math.max(2, Math.min(5, (q.choices || []).length || 4));
      let stemLines = [], stemH, stemImg = null, numY = null;
      const sc = look ? q.look.stem : null;
      if (sc) {
        const f = { w: sc.wpt * PT * LS, h: sc.hpt * PT * LS };
        const k = Math.min(1, stemW / f.w); f.w *= k; f.h *= k;
        const base = sc.base !== null && sc.base !== undefined ? sc.base * PT * LS * k : Math.min(f.h, 3.4);
        const off = Math.max(0.3, 3.7 - base);
        stemImg = { dy: off, w: f.w, h: f.h }; numY = off + base;
        stemH = off + f.h + 1.6;
      } else {
        stemLines = q.stem && q.stem.trim() ? wrap(doc, q.stem, stemW, STEM_PT, 'normal', uni) : [];
        stemH = Math.max(1, stemLines.length) * STEM_LH + 1.4;
      }
      const sImgs = (!look ? (q.imgs || []) : []).filter(Boolean).map(im => fitBox(im, stemW, 70));
      stemH += sImgs.reduce((a, f) => a + f.h + 1.2, 0);
      const rows = [], chs = [];
      // homework / quiz: short one-line choices side by side (A B C / D E), each bubble beside its choice
      let flat = null;
      if (compact && !look && !(q.choiceImgs || []).some(Boolean)) {
        const texts = Array.from({ length: nCh }, (_, i) => String((q.choices || [])[i] || ''));
        const avail = stemX + stemW - (bubX - BUB_R) + FLAT_GAP;
        const cell = FLAT_TXT + Math.max(...texts.map(t => textW(doc, t, CH_PT, uni))) + FLAT_GAP;
        let per = Math.min(nCh, Math.floor(avail / cell));
        if (per >= 2 && !texts.some(t => /\n/.test(t))) {
          const nRows = Math.ceil(nCh / per); per = Math.ceil(nCh / nRows);
          flat = { per, nRows, cw: avail / per, lines: texts.map(t => wrap(doc, t, 1000, CH_PT, 'normal', uni)) };
        }
      }
      for (let i = 0; i < nCh && !flat; i++) {
        const cc = look ? (q.look.choices || [])[i] : null;
        if (cc) {
          let w = cc.wpt * PT * LS, h = cc.hpt * PT * LS; const k = Math.min(1, chW / w); w *= k; h *= k;
          let dy, by;
          if (cc.center || cc.base === null || cc.base === undefined) { dy = 0.6; by = Math.max(3.2, dy + h / 2); }
          else { const base = cc.base * PT * LS * k; dy = Math.max(0.3, 4.45 - base); by = Math.max(3.2, dy + base - 1.25); }
          chs.push({ img: { dy, w, h }, by, lines: [] });
          rows.push(Math.max(6.4, dy + h + 1.6, by + BUB_R + 1));
        } else {
          const ci = !look && q.choiceImgs && q.choiceImgs[i] ? fitBox(q.choiceImgs[i], chW, 50) : null;
          const ctext = (q.choices || [])[i] || '';
          const ls = ci && ctext === '[picture]' ? [] : wrap(doc, ctext, chW, CH_PT, 'normal', uni);
          chs.push({ lines: ls, by: ci && !ls.length ? Math.max(3.2, 1.0 + ci.h / 2) : 3.2, cimg: ci });
          rows.push(Math.max(6.4, ci && !ls.length ? ci.h + 2.6 : Math.max(1, ls.length) * CH_LH + 2.0 + (ci ? ci.h + 1.2 : 0)));
        }
      }
      const h = stemH + (flat ? flat.nRows * 6.4 : rows.reduce((a, b) => a + b, 0)) + 3.2;
      if (h > CONTENT.bottom - CONTENT.top) L.issues.push(`MC ${qi + 1} is taller than a full page; shorten its text.`);
      placed.push({ h, make: (top, page, col) => {
        const ox = col * COLDX, sx = stemX + ox;
        const item = { qid: q.id, num: qi + 1, label: q.label || String(qi + 1), page, r: BUB_R, top, h, stem: { x: sx, y: top, lines: stemLines }, choices: [], lane: { x0: col ? COL2_X0 : 11.5, x1: bubX + ox - BUB_R - 0.6 }, uni, look };
        if (compact) { item.col = col; item.numX = 29.5 + ox; }
        if (stemImg) { item.stem.img = { x: sx, y: top + stemImg.dy, w: stemImg.w, h: stemImg.h }; item.stem.numY = top + numY; }
        let iy = top + (stemImg ? stemImg.dy + stemImg.h + 0.6 : Math.max(1, stemLines.length) * STEM_LH + 0.6);
        if (sImgs.length) item.stem.imgs = sImgs.map(f => { const r = { x: sx, y: iy, w: f.w, h: f.h }; iy += f.h + 1.2; return r; });
        let cy = top + stemH;
        if (flat) {
          item.flat = true;
          for (let i = 0; i < nCh; i++) {
            const rt = top + stemH + Math.floor(i / flat.per) * 6.4, bx = bubX + ox + (i % flat.per) * flat.cw;
            item.choices.push({ label: LETTERS[i], x: bx, y: rt + 3.2, text: { x: bx + (chX - bubX), y: rt + 3.2 + 1.25, lines: flat.lines[i] }, rowTop: rt, rowH: 6.4 });
          }
        }
        for (let i = 0; i < nCh && !flat; i++) {
          const c = chs[i];
          const ch = { label: LETTERS[i], x: bubX + ox, y: cy + c.by, text: { x: chX + ox, y: cy + 3.2 + 1.25, lines: c.lines }, rowTop: cy, rowH: rows[i] };
          if (c.img) ch.img = { x: chX + ox, y: cy + c.img.dy, w: c.img.w, h: c.img.h };
          if (c.cimg) ch.cimg = { x: chX + ox, y: cy + (c.lines.length ? c.lines.length * CH_LH + 1.6 : 1.0), w: c.cimg.w, h: c.cimg.h };
          item.choices.push(ch);
          cy += rows[i];
        }
        item.block = col ? { x: COL2_X0, y: top - 1, w: CONTENT.right - COL2_X0, h: h - 1.5 } : { x: 11.5, y: top - 1, w: (compact ? stemX + stemW : CONTENT.right) - 11.5, h: h - 1.5 };
        return item;
      } });
    });
    // place the measured questions: one column (exam) or two columns filled column by column (homework, quiz)
    let col = 0, colTop = y;
    const spots = placed.map(m => {
      if (y + m.h > CONTENT.bottom) {
        if (compact && col === 0 && colTop + m.h <= CONTENT.bottom) { col = 1; y = colTop; }
        else { newPage('mc'); col = 0; colTop = y; }
      }
      const sp = { m, page, col, top: y, colTop };
      y += m.h;
      return sp;
    });
    let mcEnd = y;
    if (compact && spots.length) {
      // last page: balance the two columns (order kept: the first k questions left) so the written answers can follow below
      const last = spots.filter(sp => sp.page === page), top0 = last[0].colTop, avail = CONTENT.bottom - top0;
      const hs = last.map(sp => sp.m.h), tot = hs.reduce((a, b) => a + b, 0);
      let best = null, left = 0;
      for (let k = 1; k <= hs.length; k++) {
        left += hs[k - 1];
        if (left > avail + 1e-6 || tot - left > avail + 1e-6) continue;
        const v = Math.max(left, tot - left);
        if (!best || v < best.v - 1e-6) best = { k, v };
      }
      if (best) {
        let yl = top0, yr = top0;
        last.forEach((sp, i) => { if (i < best.k) { sp.col = 0; sp.top = yl; yl += sp.m.h; } else { sp.col = 1; sp.top = yr; yr += sp.m.h; } });
        mcEnd = top0 + best.v;
      } else mcEnd = Math.max(...last.map(sp => sp.top + sp.m.h));
    }
    spots.forEach(sp => L.mc.push(sp.m.make(sp.top, sp.page, sp.col)));
    y = mcEnd;

    // ---- short-answer pages ----
    const sas = exam.sa || [];
    if (sas.length && !compact) y = CONTENT.bottom + 1;
    else if (sas.length && mcs.length) y = mcEnd + 2;   // homework / quiz: written answers follow the questions on the same page
    const P_PT = 10.5, P_LH = lh(P_PT);
    sas.forEach((q, qi) => {
      if (q.kind === 'page' && q.img) {
        // a written page from the teacher's document (for example a table to fill in): the page picture is the answer area
        newPage('wpage');
        const f = fitBox(q.img, CONTENT.right - CONTENT.left, 238 - CONTENT.top);
        const box = { x: CONTENT.left + (CONTENT.right - CONTENT.left - f.w) / 2, y: CONTENT.top, w: f.w, h: f.h };
        const bot = box.y + box.h;
        L.sa.push({
          qid: q.id, num: mcs.length + qi + 1, label: 'SA' + (qi + 1), page, max: +q.max || 0, top: CONTENT.top, kind: 'page',
          prompt: { x: stemX, y: CONTENT.top, lines: [] }, box, img: box,
          scoreBox: { x: 181.5, y: bot + 1.5, w: 14.5, h: 12 },
          comment: { x: CONTENT.left, y: bot + 1.5, w: 150, h: 8 },
          region: { x: 11.5, y: CONTENT.top - 1.5, w: 196 - 11.5 + 2, h: bot + 17 - CONTENT.top }
        });
        y = CONTENT.bottom + 1;
        return;
      }
      const uni = exam.uniText === true && !!UNI;
      const lines = q.prompt && q.prompt.trim() && !q.img ? wrap(doc, q.prompt, CONTENT.right - stemX, P_PT, 'normal', uni) : (q.img ? [] : ['']);
      const pImgs = [q.img, ...(q.imgs || [])].filter(Boolean).map(im => fitBox(im, CONTENT.right - stemX, 90));
      const boxH = Math.max(1, q.lines || 6) * 8;
      const promptH = (lines.length ? lines.length * P_LH : 0) + pImgs.reduce((a, f) => a + f.h + 1.2, 0) + 2.0;
      const h = promptH + boxH + 9 + 3;
      if (h > CONTENT.bottom - CONTENT.top) L.issues.push(`Short answer ${qi + 1} box is taller than a page; reduce its lines.`);
      if (y + h > CONTENT.bottom) newPage('sa');
      const top = y;
      const box = { x: stemX, y: top + promptH, w: 180 - stemX, h: boxH };
      const item = {
        qid: q.id, num: mcs.length + qi + 1, label: 'SA' + (qi + 1), page, max: +q.max || 0, top, uni,
        prompt: { x: stemX, y: top, lines }, box,
        scoreBox: { x: 182.5, y: box.y, w: 14.5, h: 12 },
        comment: { x: stemX, y: box.y + boxH + 0.8, w: 196 - stemX, h: 8 },
        region: { x: 11.5, y: top - 1.5, w: 196 - 11.5 + 2, h: h - 1.5 }
      };
      if (pImgs.length) { let iy = top + lines.length * P_LH + 0.4; item.prompt.imgs = pImgs.map(f => { const r = { x: stemX, y: iy, w: f.w, h: f.h }; iy += f.h + 1.2; return r; }); }
      L.sa.push(item);
      y = top + h;
    });
    // homework / quiz: the free space at the bottom of each written-answer page goes to its answer boxes
    if (compact) {
      const byPage = {};
      L.sa.filter(s => s.kind !== 'page').forEach(s => (byPage[s.page] = byPage[s.page] || []).push(s));
      Object.values(byPage).forEach(items => {
        const free = CONTENT.bottom - Math.max(...items.map(s => s.region.y + s.region.h)) - 0.5;
        if (free < 1) return;
        const add = free / items.length;
        let dy = 0;
        items.forEach(s => {
          s.top += dy; s.prompt.y += dy; (s.prompt.imgs || []).forEach(r => { r.y += dy; });
          s.box.y += dy; s.box.h += add; s.scoreBox.y += dy; s.comment.y += dy + add;
          s.region.y += dy; s.region.h += add;
          dy += add;
        });
      });
      frontPages();
    }
    // ---- reference pages (printed, never graded) ----
    (exam.refPages || []).forEach(rp => {
      newPage('ref');
      const f = fitBox(rp.img, CONTENT.right - CONTENT.left, CONTENT.bottom - CONTENT.top);
      L.extra.push({ id: rp.id, page, kind: 'ref', img: { x: CONTENT.left + (CONTENT.right - CONTENT.left - f.w) / 2, y: CONTENT.top, w: f.w, h: f.h } });
    });
    L.pageCount = page;
    // preflight checks
    preflight(L);
    return L;
  }

  // assignment type: 'exam' (cover page) | 'homework' | 'quiz' (compact header on page 1); old exams have no kind
  const KINDS = ['exam', 'quiz', 'homework'];
  function kindOf(exam) { return exam && KINDS.includes(exam.kind) ? exam.kind : 'exam'; }
  function isCompact(exam) { return kindOf(exam) !== 'exam'; }

  function inSafe(x, y) { return x >= SAFE.x0 && x <= SAFE.x1 && y >= SAFE.y0 && y <= SAFE.y1; }
  function preflight(L) {
    const rep = [];
    let nb = 0, bad = 0;
    const chk = (x, y, r, what) => {
      nb++;
      if (!inSafe(x - r, y - r) || !inSafe(x + r, y + r)) { bad++; rep.push(`${what} is outside the safe area`); }
    };
    L.cover.id.cols.forEach(c => c.bubbles.forEach(b => chk(b.x, b.y, L.cover.id.r, `ID bubble col ${c.c + 1} digit ${b.d}`)));
    L.mc.forEach(q => q.choices.forEach(c => {
      chk(c.x, c.y, q.r, `MC ${q.num}${c.label}`);
      // text must start to the right of the bubble
      if (c.text.x < c.x + q.r + 1.5) { bad++; rep.push(`MC ${q.num}${c.label} text overlaps its bubble`); }
    }));
    // bubbles of one question must not overlap each other
    L.mc.forEach(q => { for (let i = 1; i < q.choices.length; i++) if (Math.hypot(q.choices[i].x - q.choices[i - 1].x, q.choices[i].y - q.choices[i - 1].y) < 2 * q.r + 0.8) { bad++; rep.push(`MC ${q.num} bubbles too close`); } });
    L.sa.forEach(s => {
      const b = s.box;
      if (!inSafe(b.x, b.y) || !inSafe(b.x + b.w, b.y + b.h)) { bad++; rep.push(`SA ${s.label} box outside the safe area`); }
    });
    // marker/code regions must stay clear of content
    L.mc.forEach(q => { if (q.top < CONTENT.top - 0.01 || q.top + q.h > CONTENT.bottom + 0.01) { bad++; rep.push(`MC ${q.num} crosses the page edge zone`); } });
    L.preflight = { ok: bad === 0 && L.issues.length === 0, bubbles: nb, problems: bad + L.issues.length, messages: [...L.issues, ...rep], pageCount: L.pageCount };
    return L.preflight;
  }

  // ---------- PDF drawing ----------
  function drawFrame(doc, L, exam, pageNo) {
    doc.setFillColor(0, 0, 0);
    L.markers.forEach(m => doc.rect(m.x - MK.size / 2, m.y - MK.size / 2, MK.size, MK.size, 'F'));
    const bits = codeBits(L.hash, pageNo);
    codeCells().forEach((c, i) => { if (bits[i]) doc.rect(c.x - CODE.cell / 2, c.y - CODE.cell / 2, CODE.cell, CODE.cell, 'F'); });
    doc.setTextColor(90); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(`Page ${pageNo} of ${L.pageCount}`, CONTENT.left, PAGE.h - 13.2);
    if (pageNo > 1) {
      doc.setTextColor(40); doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      const head = U.pdfText([exam.title, exam.course].filter(Boolean).join('  |  ')).slice(0, 80);
      doc.text(head, CONTENT.left, 23.2);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text('Name', 128, 23.2);
      doc.setDrawColor(120); doc.setLineWidth(0.25); doc.line(138, 23.8, CONTENT.right, 23.8);
      doc.setDrawColor(190); doc.line(CONTENT.left, 25.6, CONTENT.right, 25.6);
    }
  }

  function bubble(doc, x, y, r, label, filled) {
    doc.setLineWidth(0.28); doc.setDrawColor(70);
    if (filled) { doc.setFillColor(25, 25, 25); doc.circle(x, y, r, 'FD'); }
    else doc.circle(x, y, r, 'S');
    if (!filled) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.6); doc.setTextColor(135);
      doc.text(String(label), x, y + 0.85, { align: 'center' });
    }
  }

  function textLines(doc, lines, x, y0, size, style, lineH, color = 20, uni = false) {
    setF(doc, style, uni); doc.setFontSize(size); doc.setTextColor(color);
    lines.forEach((ln, i) => { if (!ln) return; if (typeof ln === 'string') doc.text(ln, x, y0 + i * lineH); else drawRuns(doc, ln.runs, x, y0 + i * lineH, size); });
  }

  function buildPDF(exam, L, opts = {}) {
    const { jsPDF } = window.jspdf;
    const key = !!opts.key;
    const doc = new jsPDF({ unit: 'mm', format: 'letter', compress: true });
    doc.setProperties({ title: (exam.title || 'Exam') + (key ? ' - Answer Key' : ''), creator: 'Exam Grader' });
    const correct = {};
    (exam.mc || []).forEach(q => { correct[q.id] = q.answer; });
    for (let p = 1; p <= L.pageCount; p++) {
      if (p > 1) doc.addPage('letter', 'portrait');
      drawFrame(doc, L, exam, p);
      if (p === 1) { if (L.cover.compact) drawHead(doc, L, exam, key); else drawCover(doc, L, exam, key); }
      const mcById = {}; (exam.mc || []).forEach(q => { mcById[q.id] = q; });
      const pic = (im, r, alias) => { if (im && im.src && r) { try { doc.addImage(im.src, imgFmt(im.src), r.x, r.y, r.w, r.h, alias); } catch (e) { console.error('image', alias, e); } } };
      L.mc.filter(q => q.page === p).forEach(q => {
        const src = mcById[q.qid] || {};
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
        doc.text((q.label || q.num) + '.', q.numX || 29.5, q.stem.numY || q.stem.y + 3.7, { align: 'right' });
        if (q.stem.img) pic(src.look && src.look.stem, q.stem.img, q.qid + ':s');
        else textLines(doc, q.stem.lines, q.stem.x, q.stem.y + 3.7, 10.5, 'normal', lh(10.5), 20, q.uni);
        (q.stem.imgs || []).forEach((r, k) => pic((src.imgs || [])[k], r, q.qid + ':si' + k));
        q.choices.forEach((c, k) => {
          bubble(doc, c.x, c.y, q.r, c.label, key && correct[q.qid] === c.label);
          if (c.img) pic(src.look && src.look.choices[k], c.img, q.qid + ':c' + k);
          else textLines(doc, c.text.lines, c.text.x, c.text.y, 10, 'normal', lh(10), 30, q.uni);
          if (c.cimg) pic((src.choiceImgs || [])[k], c.cimg, q.qid + ':ci' + k);
        });
      });
      (L.extra || []).filter(x => x.page === p).forEach(x => {
        const src = x.kind === 'ref' ? (exam.refPages || []).find(r => r.id === x.id) : (exam.frontPages || []).find(r => r.id === x.id);
        if (src) pic(src.img, x.img, x.id);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
        doc.text(x.kind === 'ref' ? 'Reference page: not graded' : 'From the original exam: not graded', CONTENT.right, PAGE.h - 13.2, { align: 'right' });
      });
      L.sa.filter(s => s.page === p).forEach((s, i) => {
        const q = (exam.sa || []).find(z => z.id === s.qid) || {};
        if (s.kind === 'page') {
          pic(q.img, s.img, s.qid + ':p');
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90);
          doc.setDrawColor(130); doc.setLineWidth(0.22);
          doc.rect(s.scoreBox.x, s.scoreBox.y, s.scoreBox.w, s.scoreBox.h, 'S');
          doc.setFontSize(6.5); doc.text('pts', s.scoreBox.x + 1.2, s.scoreBox.y + 2.6);
          doc.setFontSize(7.5); doc.text('max ' + U.fmt(s.max), s.scoreBox.x + s.scoreBox.w / 2, s.scoreBox.y + s.scoreBox.h + 3.2, { align: 'center' });
          if (key && q.key) { doc.setTextColor(0, 85, 58); doc.setFontSize(9); textLines(doc, wrap(doc, 'Key: ' + q.key, 150, 9, 'normal', needsUni(q.key)), s.comment.x, s.comment.y + 4, 9, 'normal', lh(9), 60, needsUni(q.key)); }
          return;
        }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
        doc.text(s.num + '.', 29.5, s.prompt.y + 3.7, { align: 'right' });
        textLines(doc, s.prompt.lines, s.prompt.x, s.prompt.y + 3.7, 10.5, 'normal', lh(10.5), 20, s.uni);
        (s.prompt.imgs || []).forEach((r, k) => pic([q.img, ...(q.imgs || [])].filter(Boolean)[k], r, s.qid + ':pi' + k));
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90);
        doc.setDrawColor(60); doc.setLineWidth(0.3);
        doc.rect(s.box.x, s.box.y, s.box.w, s.box.h, 'S');
        const sb = s.scoreBox;
        doc.setDrawColor(130); doc.setLineWidth(0.22);
        doc.rect(sb.x, sb.y, sb.w, sb.h, 'S');
        doc.setFontSize(6.5);
        doc.text('pts', sb.x + 1.2, sb.y + 2.6);
        doc.setFontSize(7.5);
        doc.text('max ' + U.fmt(s.max), sb.x + sb.w / 2, sb.y + sb.h + 3.2, { align: 'center' });
        if (key && q.key) {
          doc.setTextColor(0, 85, 58); doc.setFontSize(9.5);
          const ku = needsUni(q.key);
          const kl = wrap(doc, 'Key: ' + q.key, s.box.w - 6, 9.5, 'normal', ku);
          textLines(doc, kl, s.box.x + 3, s.box.y + 5, 9.5, 'normal', lh(9.5), 60, ku);
        }
      });
    }
    return doc;
  }

  function drawCover(doc, L, exam, key) {
    const C = L.cover;
    doc.setTextColor(0, 85, 58);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(U.pdfText(exam.school || ''), PAGE.w / 2, 31, { align: 'center', maxWidth: 170 });
    doc.setTextColor(30); doc.setFont('helvetica', 'normal'); doc.setFontSize(11.5);
    const sub = [exam.course, exam.teacher].filter(Boolean).join('   |   ');
    doc.text(U.pdfText(sub), PAGE.w / 2, 38.5, { align: 'center', maxWidth: 170 });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(15);
    doc.text(U.pdfText(exam.title || 'Exam') + (key ? '  (ANSWER KEY)' : ''), PAGE.w / 2, 50, { align: 'center', maxWidth: 175 });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(60);
    const meta = [exam.date ? 'Date: ' + exam.date : '', exam.version ? 'Version ' + exam.version : '', `${L.pageCount} pages`].filter(Boolean).join('     ');
    doc.text(U.pdfText(meta), PAGE.w / 2, 58, { align: 'center' });
    doc.setDrawColor(0, 85, 58); doc.setLineWidth(0.5); doc.line(CONTENT.left, 63, CONTENT.right, 63);
    // name box
    doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Name', C.name.x, C.name.y - 1.6);
    doc.setDrawColor(60); doc.setLineWidth(0.35); doc.rect(C.name.x, C.name.y, C.name.w, C.name.h, 'S');
    // score box
    doc.text('Score', C.score.x, C.score.y - 1.6);
    doc.rect(C.score.x, C.score.y, C.score.w, C.score.h, 'S');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120);
    doc.text('For instructor use', C.score.x + C.score.w - 1.5, C.score.y + C.score.h - 1.5, { align: 'right' });
    // ID grid
    doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Student ID', C.idBox.x, C.idBox.y - 1.6);
    doc.setDrawColor(150); doc.setLineWidth(0.25); doc.rect(C.idBox.x, C.idBox.y, C.idBox.w, C.idBox.h, 'S');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110);
    doc.text('Write digits, then fill one bubble per column', C.idBox.x + 1.5, C.idBox.y + 4.2);
    C.id.cols.forEach(col => {
      doc.setDrawColor(110); doc.setLineWidth(0.25);
      doc.rect(col.write.x, col.write.y, col.write.w, col.write.h, 'S');
      col.bubbles.forEach(b => bubble(doc, b.x, b.y, C.id.r, b.d, false));
    });
    // instructions
    doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Instructions', C.instr.x, C.instr.y - 1.6);
    const instr = exam.instructions || defaultInstructions(exam);
    const lines = wrap(doc, instr, C.instr.w, 9.5);
    textLines(doc, lines, C.instr.x, C.instr.y + 4, 9.5, 'normal', lh(9.5, 1.3), 40);
    // example of correct fill
    const ey = C.idBox.y + C.idBox.h + 10;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(30);
    doc.text('Fill bubbles like this:', CONTENT.left, ey);
    doc.setFillColor(25, 25, 25); doc.setDrawColor(70); doc.circle(CONTENT.left + 40, ey - 1.2, 2.2, 'FD');
    doc.setFont('helvetica', 'normal'); doc.text('Not like this:', CONTENT.left + 50, ey);
    doc.setDrawColor(70); doc.setLineWidth(0.28); doc.circle(CONTENT.left + 76, ey - 1.2, 2.2, 'S');
    doc.setLineWidth(0.5); doc.line(CONTENT.left + 74.6, ey - 1.2, CONTENT.left + 75.6, ey); doc.line(CONTENT.left + 75.6, ey, CONTENT.left + 77.6, ey - 2.6);
    doc.setLineWidth(0.28); doc.circle(CONTENT.left + 84, ey - 1.2, 2.2, 'S');
    doc.setLineWidth(0.5); doc.line(CONTENT.left + 82.4, ey - 2.8, CONTENT.left + 85.6, ey + 0.4); doc.line(CONTENT.left + 85.6, ey - 2.8, CONTENT.left + 82.4, ey + 0.4);
    // summary of sections
    const nMC = (exam.mc || []).length, nSA = (exam.sa || []).length;
    const mcPts = (exam.mc || []).reduce((a, q) => a + (+q.points || 0), 0);
    const saPts = (exam.sa || []).reduce((a, q) => a + (+q.max || 0), 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(50);
    const sy = ey + 9;
    if (nMC) doc.text(`Multiple choice: ${nMC} questions, ${U.fmt(mcPts)} points`, CONTENT.left, sy);
    if (nSA) doc.text(`Written response: ${nSA} questions, ${U.fmt(saPts)} points`, CONTENT.left, sy + 5.5);
    doc.text(`Total: ${U.fmt(mcPts + saPts)} points`, CONTENT.left, sy + 11);
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text('Do not write on the black squares or the small code squares at the top of each page.', CONTENT.left, 252);
  }

  // homework / quiz page 1: title, date, version; name and score; flat student ID grid
  function drawHead(doc, L, exam, key) {
    const C = L.cover;
    doc.setTextColor(15); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    const meta = [exam.date ? 'Date: ' + exam.date : 'Date ____________', exam.version ? 'Version ' + exam.version : ''].filter(Boolean).join('     ');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const metaW = meta ? doc.getTextWidth(U.pdfText(meta)) + 6 : 0;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    const title = U.pdfText(exam.title || (L.kind === 'quiz' ? 'Quiz' : 'Homework')) + (key ? '  (ANSWER KEY)' : '');
    doc.text(doc.splitTextToSize(title, CONTENT.right - CONTENT.left - metaW)[0] || '', CONTENT.left, 33.4);
    if (meta) { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(50); doc.text(U.pdfText(meta), CONTENT.right, 33.4, { align: 'right' }); }
    // name line
    const n = C.name;
    doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Name', n.x, n.y + n.h - 1.2);
    doc.setDrawColor(60); doc.setLineWidth(0.3); doc.line(n.x + 11, n.y + n.h - 0.6, n.x + n.w, n.y + n.h - 0.6);
    // score box: Score ____ / total
    const sb = C.score;
    const total = (exam.mc || []).reduce((a, q) => a + (+q.points || 0), 0) + (exam.sa || []).reduce((a, q) => a + (+q.max || 0), 0);
    doc.setDrawColor(60); doc.setLineWidth(0.35); doc.rect(sb.x, sb.y, sb.w, sb.h, 'S');
    doc.text('Score', sb.x + 2, sb.y + 6.4);
    doc.setLineWidth(0.25); doc.line(sb.x + 15, sb.y + 7.2, sb.x + 31, sb.y + 7.2);
    doc.setFont('helvetica', 'normal'); doc.text('/ ' + U.fmt(total), sb.x + 32.5, sb.y + 6.4);
    // student ID: one row of bubbles per digit
    const B = C.idBox;
    doc.setTextColor(30); doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    doc.text('Student ID', B.x, B.y - 1.6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
    doc.text('Write each digit in its box, then fill the bubble for that digit in the same row (row 1 = first digit).', B.x + 20, B.y - 1.6);
    doc.setDrawColor(150); doc.setLineWidth(0.25); doc.rect(B.x, B.y, B.w, B.h, 'S');
    C.id.cols.forEach(col => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90);
      doc.text(String(col.c + 1), col.label.x, col.label.y + 1, { align: 'center' });
      doc.setDrawColor(110); doc.setLineWidth(0.25);
      doc.rect(col.write.x, col.write.y, col.write.w, col.write.h, 'S');
      col.bubbles.forEach(b => bubble(doc, b.x, b.y, C.id.r, b.d, false));
    });
    doc.setDrawColor(190); doc.setLineWidth(0.25); doc.line(CONTENT.left, C.end, CONTENT.right, C.end);
  }

  function defaultInstructions(exam) {
    return 'Write your name in the box and your student ID in the grid, filling one bubble per digit.\n' +
      'For multiple choice, completely fill the one bubble next to your answer with a dark pencil or pen. Erase changes cleanly.\n' +
      'Write short answers inside the boxes. Work outside the boxes may not be graded.\n' +
      'Keep all pages together and do not fold the pages.';
  }

  // ---------- coordinate utilities ----------
  const mm2px = v => v * PX;
  const px2mm = v => v / PX;

  // pages that are printed but never graded (kept cover art, reference pages): a student may hand them in or not
  function ungradedPage(L, p) { const pg = (L.pages || []).find(x => x.no === p); return !!pg && (pg.kind === 'ref' || pg.kind === 'extra'); }

  return { PAGE, DPI, PX, RW, RH, MK, MARKERS, CODE, SAFE, CONTENT, BUB_R, LETTERS, compute, buildPDF, preflight, codeBits, decodeBits, codeCells, examHash, mm2px, px2mm, loadFont, needsUni, ungradedPage, kindOf, isCompact, KINDS, fontReady: () => !!UNI, runsOf, hasMarkup };
})();
