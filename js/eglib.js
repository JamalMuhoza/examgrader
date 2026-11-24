/* Exam Grader - small library entry for other pages on the same origin (class sites). See CLASS_SITE_API.md.
   Load after jsPDF, js/util.js, js/layout.js, js/cv.js and js/grade.js. Exposes window.EGLib; reuses the app's own modules. */
'use strict';

(() => {
  // base URL of the app (".../examgrader/"), from this script's own URL
  const me = document.currentScript && document.currentScript.src;
  const BASE = me ? new URL('../', me).href : new URL('./', location.href).href;
  let ready = null;

  // The Unicode font changes text measurement, so it must be loaded before any layout is computed (as the app does).
  function init() {
    if (!ready) ready = Layout.loadFont(BASE + 'fonts/DejaVuSans.ttf');
    return ready;
  }

  function layoutOf(exam, layout) { return layout || Layout.compute(exam); }

  const MC_VALUE = r => r.status === 'single' ? r.choice : r.status === 'blank' ? '' : r.status === 'multiple' ? 'multi' : '?';

  // Read one photo or scan of a printed page. image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | HTMLVideoElement.
  function readPage(image, exam, layout, opts = {}) {
    const L = layoutOf(exam, layout);
    const w = image.naturalWidth || image.videoWidth || image.width, h = image.naturalHeight || image.videoHeight || image.height;
    const res = CV.processSource(image, w, h);
    if (!res.ok) return { ok: false, reason: res.reason, pageNo: null, examHashOk: false, id: null, mc: {}, saBoxes: [] };
    const out = { ok: true, pageNo: res.page, examHashOk: res.hash === L.hash, id: null, idOk: false, mc: {}, saBoxes: [], omr: {}, idRead: null, quality: res.quality, warnings: [] };
    if (!res.page) { out.warnings.push('Page code unreadable'); return out; }
    if (!out.examHashOk) out.warnings.push('Page belongs to a different exam or version');
    if (res.page > L.pageCount) { out.warnings.push('Page number beyond this exam'); return out; }
    const canvas = CV.canvasOf(Layout.RW, Layout.RH);
    canvas.getContext('2d').putImageData(res.rect, 0, 0);
    out.canvas = canvas;
    const a = CV.analyzePage(res.rg, L, res.page, opts.th || CV.DEFAULT_TH);
    out.omr = a.mc; out.idRead = a.id;
    for (const [qid, r] of Object.entries(a.mc)) out.mc[qid] = MC_VALUE(r);
    if (a.id) { out.id = a.id.value; out.idOk = a.id.ok; }
    L.sa.filter(s => s.page === res.page).forEach(lq => {
      const c = CV.boxCrop(canvas, lq, opts.maxW || 900);
      out.saBoxes.push({ qid: lq.qid, crop: c.b64, w: c.w, h: c.h });
    });
    return out;
  }

  // Score the multiple choice of one student from the readPage results of that student's pages (any order).
  function gradeMC(exam, readings, layout) {
    const L = layoutOf(exam, layout);
    const stu = { id: 'eglib', mcOverride: {}, sa: {} };
    const scans = (readings || []).filter(r => r && r.ok && r.pageNo && r.examHashOk)
      .map((r, i) => ({ studentId: 'eglib', page: r.pageNo, omr: r.omr, idRead: r.idRead, batchSeq: 0, seq: i }));
    const g = Grade.compute({ ...exam, sa: [] }, L, stu, scans, []);
    const mc = {};
    (exam.mc || []).forEach(q => { const r = g.mc[q.id]; mc[q.id] = { answer: r.answer, state: r.state, pts: r.pts, key: r.key }; });
    const need = [...new Set([1, ...L.mc.map(q => q.page)])].sort((a, b) => a - b);
    return { id: g.id, idOk: g.idOk, mc, score: g.mcTotal, max: g.mcMax, missingPages: need.filter(p => !g.pages[p]), flags: g.flags };
  }

  // The printable PDF (opts.key: answer key) as a Blob.
  async function buildPDF(exam, opts = {}) {
    await init();
    const L = Layout.compute(exam);
    return Layout.buildPDF(exam, L, opts).output('blob');
  }

  // Layout after the font is loaded (always use this, or call init() first, before Layout.compute).
  async function layout(exam) { await init(); return Layout.compute(exam); }

  window.EGLib = { Layout, CV, Grade, U, version: 1, base: BASE, init, layout, readPage, gradeMC, buildPDF };
})();
