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

  const PT = 0.3528; // mm per point
  function lh(pt, k = 1.22) { return pt * PT * k; }

  // ---------- text helpers ----------
  function wrap(doc, text, width, size, style = 'normal') {
    doc.setFont('helvetica', style); doc.setFontSize(size);
    const paras = U.pdfText(text).replace(/\r/g, '').split('\n');
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
    // ---- cover ----
    const nd = Math.max(1, Math.min(12, exam.idDigits | 0 || 7));
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

    // ---- MC pages ----
    let page = 1, y = CONTENT.bottom + 1;
    const newPage = (kind) => { page++; L.pages.push({ no: page, kind }); y = CONTENT.top; };
    const mcs = exam.mc || [];
    const STEM_PT = 10.5, CH_PT = 10, STEM_LH = lh(STEM_PT), CH_LH = lh(CH_PT);
    const stemX = 31, stemW = CONTENT.right - stemX;
    const bubX = 34, chX = 39.5, chW = CONTENT.right - chX;
    mcs.forEach((q, qi) => {
      const stemLines = q.stem && q.stem.trim() ? wrap(doc, q.stem, stemW, STEM_PT) : [];
      const nCh = Math.max(2, Math.min(5, (q.choices || []).length || 4));
      const chLines = [];
      for (let i = 0; i < nCh; i++) chLines.push(wrap(doc, (q.choices || [])[i] || '', chW, CH_PT));
      const stemH = Math.max(1, stemLines.length) * STEM_LH + 1.4;
      const rows = chLines.map(ls => Math.max(6.4, Math.max(1, ls.length) * CH_LH + 2.0));
      const h = stemH + rows.reduce((a, b) => a + b, 0) + 3.2;
      if (h > CONTENT.bottom - CONTENT.top) L.issues.push(`MC ${qi + 1} is taller than a full page; shorten its text.`);
      if (y + h > CONTENT.bottom) newPage('mc');
      const top = y;
      const item = { qid: q.id, num: qi + 1, page, r: BUB_R, top, h, stem: { x: stemX, y: top, lines: stemLines }, choices: [], lane: { x0: 11.5, x1: bubX - BUB_R - 0.6 } };
      let cy = top + stemH;
      for (let i = 0; i < nCh; i++) {
        item.choices.push({ label: LETTERS[i], x: bubX, y: cy + 3.2, text: { x: chX, y: cy + 3.2 + 1.25, lines: chLines[i] }, rowTop: cy, rowH: rows[i] });
        cy += rows[i];
      }
      item.block = { x: 11.5, y: top - 1, w: CONTENT.right - 11.5, h: h - 1.5 };
      L.mc.push(item);
      y = top + h;
    });

    // ---- short-answer pages ----
    const sas = exam.sa || [];
    if (sas.length) y = CONTENT.bottom + 1;
    const P_PT = 10.5, P_LH = lh(P_PT);
    sas.forEach((q, qi) => {
      const lines = q.prompt && q.prompt.trim() ? wrap(doc, q.prompt, stemW, P_PT) : [''];
      const boxH = Math.max(1, q.lines || 6) * 8;
      const promptH = Math.max(1, lines.length) * P_LH + 2.0;
      const h = promptH + boxH + 9 + 3;
      if (h > CONTENT.bottom - CONTENT.top) L.issues.push(`Short answer ${qi + 1} box is taller than a page; reduce its lines.`);
      if (y + h > CONTENT.bottom) newPage('sa');
      const top = y;
      const box = { x: stemX, y: top + promptH, w: 180 - stemX, h: boxH };
      const item = {
        qid: q.id, num: mcs.length + qi + 1, label: 'SA' + (qi + 1), page, max: +q.max || 0, top,
        prompt: { x: stemX, y: top, lines }, box,
        scoreBox: { x: 182.5, y: box.y, w: 14.5, h: 12 },
        comment: { x: stemX, y: box.y + boxH + 0.8, w: 196 - stemX, h: 8 },
        region: { x: 11.5, y: top - 1.5, w: 196 - 11.5 + 2, h: h - 1.5 }
      };
      L.sa.push(item);
      y = top + h;
    });
    L.pageCount = page;
    // preflight checks
    preflight(L);
    return L;
  }

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
    L.mc.forEach(q => { for (let i = 1; i < q.choices.length; i++) if (q.choices[i].y - q.choices[i - 1].y < 2 * q.r + 0.8) { bad++; rep.push(`MC ${q.num} bubbles too close`); } });
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

  function textLines(doc, lines, x, y0, size, style, lineH, color = 20) {
    doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(color);
    lines.forEach((ln, i) => { if (ln) doc.text(ln, x, y0 + i * lineH); });
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
      if (p === 1) drawCover(doc, L, exam, key);
      L.mc.filter(q => q.page === p).forEach(q => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
        doc.text(q.num + '.', 29.5, q.stem.y + 3.7, { align: 'right' });
        textLines(doc, q.stem.lines, q.stem.x, q.stem.y + 3.7, 10.5, 'normal', lh(10.5));
        q.choices.forEach(c => {
          bubble(doc, c.x, c.y, q.r, c.label, key && correct[q.qid] === c.label);
          textLines(doc, c.text.lines, c.text.x, c.text.y, 10, 'normal', lh(10), 30);
        });
      });
      L.sa.filter(s => s.page === p).forEach((s, i) => {
        const q = (exam.sa || []).find(z => z.id === s.qid) || {};
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
        doc.text(s.num + '.', 29.5, s.prompt.y + 3.7, { align: 'right' });
        textLines(doc, s.prompt.lines, s.prompt.x, s.prompt.y + 3.7, 10.5, 'normal', lh(10.5));
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
          const kl = wrap(doc, 'Key: ' + q.key, s.box.w - 6, 9.5);
          textLines(doc, kl, s.box.x + 3, s.box.y + 5, 9.5, 'normal', lh(9.5), 60);
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

  function defaultInstructions(exam) {
    return 'Write your name in the box and your student ID in the grid, filling one bubble per digit.\n' +
      'For multiple choice, completely fill the one bubble next to your answer with a dark pencil or pen. Erase changes cleanly.\n' +
      'Write short answers inside the boxes. Work outside the boxes may not be graded.\n' +
      'Keep all pages together and do not fold the pages.';
  }

  // ---------- coordinate utilities ----------
  const mm2px = v => v * PX;
  const px2mm = v => v / PX;

  return { PAGE, DPI, PX, RW, RH, MK, MARKERS, CODE, SAFE, CONTENT, BUB_R, LETTERS, compute, buildPDF, preflight, codeBits, decodeBits, codeCells, examHash, mm2px, px2mm };
})();
