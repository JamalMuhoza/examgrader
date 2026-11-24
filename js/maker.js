/* Exam Grader - making exams: read a teacher's exam document (.docx, .pdf, .txt, page photos) into questions.
 * Text extraction runs in the browser (JSZip for .docx, pdf.js for .pdf). The deterministic parser reads the
 * Exam template format and common variants; the optional AI reader (Gemini through the teacher's Apps Script server)
 * copies questions verbatim when the parser cannot. Nothing is dropped silently: unread text comes back as warnings. */
'use strict';

const Maker = (() => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const BOLD = '';                 // line marker: the whole Word paragraph was bold, highlighted or underlined
  const CHUNK = 25000;                    // characters of document text per AI request
  const MAX_IMG = 8;                      // page images per AI request
  const LOW_TEXT = 25;                    // a PDF page with fewer characters is treated as a scan (sent as an image)

  // ---------------- .docx -> text lines ----------------
  function romanize(n) {
    const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s;
  }
  function fmtNum(n, f) {
    if (f === 'lowerLetter') return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    if (f === 'upperLetter') return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    if (f === 'lowerRoman') return romanize(n);
    if (f === 'upperRoman') return romanize(n).toUpperCase();
    return String(n);
  }
  const kids = (node, name) => node ? Array.from(node.childNodes).filter(c => c.namespaceURI === W && c.localName === name) : [];
  const kid = (node, name) => kids(node, name)[0] || null;
  const wval = n => n ? n.getAttributeNS(W, 'val') : null;

  // ---- pictures and super/subscripts in Word files ----
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main', NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', NS_V = 'urn:schemas-microsoft-com:vml';
  const IMG_TOKEN = /\u0001IMG(\d+)\u0001/g, TBL_TOKEN = /^\u0001TBL(\d+)\u0001$/;
  const SUPM = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ' };
  const SUBM = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎' };
  // superscript / subscript runs become ^{..} / _{..} (the app prints them raised / lowered)
  function vScript(t, va) {
    if (va !== 'superscript' && va !== 'subscript') return t;
    if (!t.trim()) return t;
    return (va === 'superscript' ? '^{' : '_{') + t.trim() + '}';
  }
  // rId -> picture file of word/document.xml
  async function docxRels(zip) {
    const f = zip.file('word/_rels/document.xml.rels');
    const map = {};
    if (!f) return map;
    const x = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    for (const r of x.getElementsByTagName('Relationship')) map[r.getAttribute('Id')] = 'word/' + r.getAttribute('Target').replace(/^\/?word\//, '').replace(/^\.\//, '');
    return map;
  }
  // a <w:drawing> or <w:pict>: picture reference and its size in points
  function drawingRef(node) {
    const blip = node.getElementsByTagNameNS(NS_A, 'blip')[0];
    let rid = blip ? blip.getAttributeNS(NS_R, 'embed') : null;
    if (!rid) { const im = node.getElementsByTagNameNS(NS_V, 'imagedata')[0]; if (im) rid = im.getAttributeNS(NS_R, 'id'); }
    if (!rid) return null;
    const ext = node.getElementsByTagNameNS(NS_WP, 'extent')[0];
    let wpt = ext ? +ext.getAttribute('cx') / 12700 : 0, hpt = ext ? +ext.getAttribute('cy') / 12700 : 0;
    if (!ext) { const sh = node.getElementsByTagNameNS(NS_V, 'shape')[0]; const st = sh ? sh.getAttribute('style') || '' : ''; const w = st.match(/width:([\d.]+)pt/), h = st.match(/height:([\d.]+)pt/); wpt = w ? +w[1] : 0; hpt = h ? +h[1] : 0; }
    return { rid, wpt, hpt };
  }
  async function mediaData(zip, path) {
    const f = zip.file(path);
    if (!f) return null;
    const ext = path.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext];
    if (!mime) return null;          // EMF / WMF pictures cannot be drawn in the browser
    const b64 = await f.async('base64');
    if (mime === 'image/png' || mime === 'image/jpeg') return 'data:' + mime + ';base64,' + b64;
    try {   // other formats: redraw as PNG for the PDF
      const im = await U.loadImage('data:' + mime + ';base64,' + b64);
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }
  // a Word table drawn as a picture (for a written page): grid lines and cell text
  function tableImage(rows, caption) {
    const K = 2.5, pad = 6, font = 11;
    const nC = Math.max(...rows.map(r => r.length));
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = `${font}px "DejaVu Sans", Arial, sans-serif`;
    const W = 520, colW = W / nC;
    const wrapCell = t => { const out = []; String(t || '').split('\n').forEach(par => { let line = ''; par.split(/\s+/).forEach(w => { const tt = line ? line + ' ' + w : w; if (ctx.measureText(tt).width > colW - 2 * pad && line) { out.push(line); line = w; } else line = tt; }); out.push(line); }); return out; };
    const cells = rows.map(r => Array.from({ length: nC }, (_, k) => wrapCell(r[k])));
    const rowH = cells.map((r, i) => Math.max(i === 0 ? 22 : 70, ...r.map(l => l.length * (font + 3) + 2 * pad)));
    const capH = caption ? 28 : 0;
    const H = capH + rowH.reduce((a, b) => a + b, 0) + 2;
    c.width = Math.round((W + 2) * K); c.height = Math.round(H * K);
    const g = c.getContext('2d'); g.scale(K, K); g.fillStyle = '#fff'; g.fillRect(0, 0, W + 2, H);
    g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 0.8;
    if (caption) { g.font = `bold 12px "DejaVu Sans", Arial, sans-serif`; g.fillText(caption, 1, 16); }
    g.font = `${font}px "DejaVu Sans", Arial, sans-serif`;
    let y = capH + 1;
    cells.forEach((r, i) => {
      r.forEach((ls, k) => { g.strokeRect(1 + k * colW, y, colW, rowH[i]); ls.forEach((l, j) => g.fillText(l, 1 + k * colW + pad, y + pad + font + j * (font + 3))); });
      y += rowH[i];
    });
    return { src: c.toDataURL('image/png'), w: c.width, h: c.height, wpt: (W + 2) * 0.75 * 1.25, hpt: H * 0.75 * 1.25 };
  }

  async function docxToText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const read = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
    const doc = await read('word/document.xml');
    if (!doc) throw new Error('This .docx file has no document body');
    const numbering = await read('word/numbering.xml');
    const styles = await read('word/styles.xml');
    const images = Object.keys(zip.files).filter(n => /^word\/media\//.test(n)).length;

    // numbering definitions: numId -> abstract levels {fmt, text, start}
    const abs = {}, nums = {};
    if (numbering) {
      for (const a of numbering.getElementsByTagNameNS(W, 'abstractNum')) {
        const lv = {};
        for (const l of kids(a, 'lvl')) lv[+l.getAttributeNS(W, 'ilvl')] = { fmt: wval(kid(l, 'numFmt')) || 'decimal', text: wval(kid(l, 'lvlText')) || '', start: +(wval(kid(l, 'start')) || 1) };
        abs[a.getAttributeNS(W, 'abstractNumId')] = lv;
      }
      for (const n of numbering.getElementsByTagNameNS(W, 'num')) nums[n.getAttributeNS(W, 'numId')] = wval(kid(n, 'abstractNumId'));
    }
    // paragraph styles that carry numbering (for example "List Number")
    const styleNum = {};
    if (styles) for (const s of styles.getElementsByTagNameNS(W, 'style')) {
      const np = kid(kid(s, 'pPr'), 'numPr');
      if (np) styleNum[s.getAttributeNS(W, 'styleId')] = { numId: wval(kid(np, 'numId')), ilvl: +(wval(kid(np, 'ilvl')) || 0) };
    }
    const counters = {};
    const lines = [];
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const rels = await docxRels(zip);
    const pics = [], tables = [];
    // block order: paragraphs, tables (a table with 2+ rows and 2+ columns becomes one token line), content controls
    const blocks = [];
    const visit = node => {
      for (const c of Array.from(node.childNodes)) {
        if (c.namespaceURI !== W) continue;
        if (c.localName === 'p') blocks.push(c);
        else if (c.localName === 'tbl') {
          const trs = kids(c, 'tr');
          const nC = Math.max(0, ...trs.map(tr => kids(tr, 'tc').length));
          if (trs.length >= 2 && nC >= 2) blocks.push({ tbl: c, trs });
          else for (const tr of trs) for (const tc of kids(tr, 'tc')) visit(tc);
        } else if (c.localName === 'sdt') { const sc = kid(c, 'sdtContent'); if (sc) visit(sc); }
        else if (c.localName === 'customXml' || c.localName === 'ins' || c.localName === 'smartTag') visit(c);
      }
    };
    visit(body);
    const runText = (r) => {
      const rPr = kid(r, 'rPr');
      if (rPr && kid(rPr, 'vanish') && wval(kid(rPr, 'vanish')) !== '0' && wval(kid(rPr, 'vanish')) !== 'false') return '';   // hidden text
      const va = rPr ? wval(kid(rPr, 'vertAlign')) : null;
      let out = '';
      for (const t of Array.from(r.childNodes)) {
        if (t.namespaceURI !== W) continue;
        if (t.localName === 't') out += vScript(t.textContent, va);
        else if (t.localName === 'tab') out += '\t';
        else if (t.localName === 'br' || t.localName === 'cr') out += '\n';
        else if (t.localName === 'drawing' || t.localName === 'pict') { const d = drawingRef(t); if (d) { pics.push(d); out += '\u0001IMG' + (pics.length - 1) + '\u0001'; } }
      }
      return out;
    };
    const cellText = tc => { let o = []; for (const p of tc.getElementsByTagNameNS(W, 'p')) { let t = ''; for (const r of p.getElementsByTagNameNS(W, 'r')) t += runText(r); o.push(t.replace(IMG_TOKEN, '')); } return o.join('\n').trim(); };
    for (const blk of blocks) {
      if (blk.tbl) { tables.push(blk.trs.map(tr => kids(tr, 'tc').map(cellText))); lines.push('\u0001TBL' + (tables.length - 1) + '\u0001'); continue; }
      const p = blk;
      const pPr = kid(p, 'pPr');
      // runs (including those inside hyperlinks, smart tags and tracked insertions)
      let text = '', boldChars = 0, allChars = 0;
      const walk = node => {
        for (const c of Array.from(node.childNodes)) {
          if (c.namespaceURI !== W) continue;
          if (c.localName === 'r') {
            const rPr = kid(c, 'rPr');
            const strong = !!rPr && ((kid(rPr, 'b') && wval(kid(rPr, 'b')) !== '0' && wval(kid(rPr, 'b')) !== 'false') || (kid(rPr, 'highlight') && wval(kid(rPr, 'highlight')) !== 'none') ||
              (kid(rPr, 'u') && wval(kid(rPr, 'u')) !== 'none') || (kid(rPr, 'shd') && /^[0-9A-F]{6}$/i.test(kid(rPr, 'shd').getAttributeNS(W, 'fill') || '') && !/^FFFFFF$/i.test(kid(rPr, 'shd').getAttributeNS(W, 'fill'))));
            const s = runText(c);
            text += s;
            const n = s.replace(IMG_TOKEN, '').replace(/\s/g, '').length; allChars += n; if (strong) boldChars += n;
          } else if (c.localName === 'del' || c.localName === 'pPr' || c.localName === 'rPr') continue;
          else walk(c);
        }
      };
      walk(p);
      // list numbering written by Word, not typed: rebuild the label ("1.", "a)") so the parser sees it
      let np = kid(pPr, 'numPr'), numId = null, ilvl = 0;
      if (np) { numId = wval(kid(np, 'numId')); ilvl = +(wval(kid(np, 'ilvl')) || 0); }
      else { const ps = wval(kid(pPr, 'pStyle')); if (ps && styleNum[ps]) ({ numId, ilvl } = styleNum[ps]); }
      if (numId && numId !== '0' && abs[nums[numId]]) {
        const lv = abs[nums[numId]];
        const key = nums[numId];
        const c = counters[key] = counters[key] || {};
        c[ilvl] = (c[ilvl] === undefined ? (lv[ilvl] ? lv[ilvl].start : 1) : c[ilvl] + 1);
        for (const k of Object.keys(c)) if (+k > ilvl) delete c[k];
        const L = lv[ilvl];
        if (L && L.fmt !== 'bullet' && L.fmt !== 'none' && L.text) {
          const label = L.text.replace(/%(\d)/g, (m, d) => { const k = +d - 1; const LL = lv[k] || L; return fmtNum(c[k] === undefined ? (LL.start || 1) : c[k], LL.fmt); });
          text = label + ' ' + text;
        }
      }
      const strong = allChars > 0 && boldChars === allChars;
      text.split('\n').forEach(t => lines.push((strong ? BOLD : '') + t));
    }
    // picture data for the tokens
    const media = { images: [], tables };
    for (const d of pics) {
      const src = rels[d.rid] ? await mediaData(zip, rels[d.rid]) : null;
      media.images.push(src ? { src, wpt: d.wpt || 120, hpt: d.hpt || 90 } : null);
    }
    return { text: lines.join('\n'), images, media };
  }

  // ---------------- .pdf -> text pages (+ images of pages without text) ----------------
  async function pdfExtract(buf, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    let images = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      if (onProgress) onProgress(p, pdf.numPages);
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => it.str !== undefined).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || 10, eol: it.hasEOL }));
      // group into lines by baseline (top to bottom), then left to right
      items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const rows = [];
      for (const it of items) {
        if (!it.s.trim() && !it.eol) { const r = rows[rows.length - 1]; if (r) r.push(it); continue; }
        const r = rows.find(rw => Math.abs(rw.y - it.y) <= Math.max(2, it.h * 0.35));
        if (r) r.push(it); else { const nr = [it]; nr.y = it.y; rows.push(nr); }
      }
      rows.sort((a, b) => b.y - a.y);
      const text = rows.map(r => {
        r.sort((a, b) => a.x - b.x);
        let s = '', end = null;
        for (const it of r) {
          if (end !== null && it.x - end > 1.2 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += it.x - end > 18 ? '   ' : ' ';
          s += it.s; end = it.x + it.w;
        }
        return s.replace(/\s+$/, '');
      }).join('\n');
      const chars = text.replace(/\s/g, '').length;
      let hasImg = false;
      try {
        const ops = await page.getOperatorList();
        const O = pdfjsLib.OPS;
        hasImg = ops.fnArray.some(f => f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageMaskXObject);
      } catch (e) { /* ignore */ }
      const entry = { page: p, text, chars };
      if (chars < LOW_TEXT) {
        // a scanned page: render it for the AI reader
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1400 / Math.max(vp0.width, vp0.height));
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        entry.image = c.toDataURL('image/jpeg', 0.8).split(',')[1];
      } else if (hasImg) images++;
      pages.push(entry);
    }
    return { pages, images, text: pages.filter(p => !p.image).map(p => p.text).join('\n') };
  }

  async function imageToJpeg(file) {
    const im = await U.blobToImage(file);
    const w = im.width, h = im.height, k = Math.min(1, 1600 / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82).split(',')[1];
  }

  // Read any supported file into { name, kind, text, segments:[{text}|{images}], images (figure count), scanned (page count) }
  async function readFiles(files, onProgress) {
    files = Array.from(files || []);
    const out = { name: files.map(f => f.name).join(', '), kinds: [], text: '', segments: [], figures: 0, scanned: 0 };
    const addText = t => { if (!t.trim()) return; out.text += (out.text ? '\n' : '') + t; const last = out.segments[out.segments.length - 1]; if (last && last.text !== undefined) last.text += '\n' + t; else out.segments.push({ text: t }); };
    const addImg = b64 => { out.scanned++; const last = out.segments[out.segments.length - 1]; if (last && last.images) last.images.push(b64); else out.segments.push({ images: [b64] }); };
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (onProgress) onProgress('Reading ' + f.name);
      if (/\.docx$/.test(n) || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const buf = await f.arrayBuffer();
        const r = await docxToText(buf); out.kinds.push('docx');
        if (files.length === 1) out.media = r.media;
        else r.text = r.text.replace(IMG_TOKEN, '').replace(/\u0001TBL\d+\u0001/g, '');
        const tpl = files.length === 1 ? await parseTemplateDocx(buf) : null;
        if (tpl) { out.template = tpl; out.figures += tpl.figures; } else out.figures += r.images;
        addText(r.text);
      } else if (/\.pdf$/.test(n) || f.type === 'application/pdf') {
        const r = await pdfExtract(await f.arrayBuffer(), (p, t) => onProgress && onProgress(`Reading ${f.name}: page ${p} of ${t}`));
        out.kinds.push('pdf'); out.figures += r.images;
        r.pages.forEach(p => p.image ? addImg(p.image) : addText(p.text));
        // typed PDF (one file): read questions, choices and figures from the page layout (text layer + pictures)
        if (files.length === 1 && typeof PdfSrc !== 'undefined' && r.pages.some(p => !p.image)) {
          out.pdfBuf = await f.arrayBuffer();
          try { out.pdfLook = await PdfSrc.analyze(await f.arrayBuffer(), { meta: pdfMeta, onProgress: t => onProgress && onProgress(`${f.name}: ${t}`) }); }
          catch (err) { console.error(err); out.pdfLookError = err.message; }
        }
      } else if (/\.(txt|text|md)$/.test(n) || /^text\//.test(f.type)) {
        out.kinds.push('txt'); addText(await f.text());
      } else if (/\.(jpe?g|png|webp|heic)$/.test(n) || /^image\//.test(f.type)) {
        out.kinds.push('image'); addImg(await imageToJpeg(f));
      } else if (/\.doc$/.test(n)) {
        throw new Error(f.name + ' is an old Word .doc file. Open it in Word and use File > Save As > Word Document (.docx), then upload that.');
      } else throw new Error(f.name + ': unsupported file type (use .docx, .pdf, .txt, or JPG/PNG photos)');
    }
    return out;
  }

  // ---------------- deterministic parser ----------------
  const RE = {
    sa: /^(?:SA|S\.A\.|Short\s*answer)\s*#?\s*(\d{1,3})\s*[.):\-]?\s+(.*)$/i,
    q: /^(?:Q(?:uestion)?\s*#?\s*)?(\d{1,3})(?:[.)]|\s*:)(?=\s|$)\s*(.*)$/i,
    qp: /^\((\d{1,3})\)\s*(.*)$/,
    choice: /^(\*\s*)?\(?([A-Ha-h])\s*[.)](?=\s|$)\s*(.*)$/,
    pts: /[(\[]\s*(\d+(?:\.\d+)?)\s*(?:pts?|points?|marks?)\.?(\s+each)?\s*[)\]]/i,
    ansLine: /^(?:correct\s+answer|answer|ans|key)\s*[:=\-]\s*\(?([A-Ha-h])\)?\.?\s*$/i,
    keyHead: /^(?:answer\s*key|answers|key)\b\s*[:.\-]?\s*(.*)$/i,
    section: /^(?:(?:part|section)\s+[\w]+\s*[:.\-–]?\s*)?(multiple[\s-]*choice|short[\s-]*answers?|written(?:[\s-]*responses?)?|free[\s-]*response|essays?|constructed[\s-]*response|open[\s-]*ended|long[\s-]*answers?)(?:\s+questions?)?(?:\s+section)?\s*(\(.*\))?\s*[:.]?\s*$/i,
    field: /^(school|institution|course|class|teacher|instructor|professor|exam\s*title|title|test|exam|date|version|form|instructions|directions)\s*:\s*(.*)$/i,
    mark: /\s*(?:\(correct\)|\[correct\]|\(answer\)|✓|✔|\s\*|<-+|←)\s*$/i
  };
  const LET = 'ABCDEFGH';
  const clean = s => String(s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();

  // "A. x  B. y  C. z" on one line -> ['A. x', 'B. y', 'C. z'] (sequential letters only, same case)
  function splitInline(s, firstIdx) {
    const m0 = s.match(/^\*?\s*\(?([A-Ha-h])\s*[.)]/);
    if (!m0) return [s];
    const upper = m0[1] === m0[1].toUpperCase();
    const parts = []; let rest = s, idx = LET.indexOf(m0[1].toUpperCase());
    if (firstIdx !== undefined && idx !== firstIdx) return [s];
    for (;;) {
      const L = upper ? LET[idx + 1] : LET[idx + 1].toLowerCase();
      if (!L) break;
      const re = new RegExp('\\s(\\*?\\s*\\(?' + L + '\\s*[.)])(?=\\s)');
      const m = rest.slice(2).match(re);
      if (!m) break;
      const cut = m.index + 2 + 1;
      parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut); idx++;
    }
    parts.push(rest.trim());
    return parts;
  }
  // a choice line with one or more labels: after a tab or 2+ spaces any unused letter starts a choice (column layouts);
  // after a single space only the next letter in sequence does ("A. x B. y C. z")
  function splitLabels(s) {
    const m0 = s.match(/^(\*\s*)?\(?([A-Ha-h])\s*[.)](?=\s|$)/);
    if (!m0) return [s];
    const cuts = [{ at: 0, sep: '', L: m0[2] }];
    const re = /(\t|\s{2,}|\s)(\*\s*)?\(?([A-Ha-h])\s*[.)](?=\s)/g;
    let m;
    while ((m = re.exec(s))) { if (m.index > 0) cuts.push({ at: m.index + m[1].length, sep: m[1], L: m[3] }); re.lastIndex = m.index + 1; }
    const acc = [cuts[0]], used = new Set([cuts[0].L.toUpperCase()]);
    for (const c of cuts.slice(1)) {
      const prev = acc[acc.length - 1], U = c.L.toUpperCase();
      if (used.has(U)) continue;
      const strong = c.sep === '\t' || c.sep.length >= 2;
      const seq = LET.indexOf(U) === LET.indexOf(prev.L.toUpperCase()) + 1 && (c.L === U) === (prev.L === prev.L.toUpperCase());
      if (strong || seq) { acc.push(c); used.add(U); }
    }
    return acc.map((c, i) => s.slice(c.at, i + 1 < acc.length ? acc[i + 1].at : s.length).trim());
  }
  // a question line that also holds its choices: "1. Stem? A. x B. y"
  function splitStemChoices(stem) {
    const m = stem.match(/\s(\*?\s*\(?[Aa]\s*[.)])\s/);
    if (!m) return null;
    const tail = stem.slice(m.index + 1);
    const parts = splitInline(tail, 0);
    if (parts.length < 2) return null;
    return { stem: stem.slice(0, m.index).trim(), parts };
  }
  function takePoints(s) {
    const m = s.match(RE.pts);
    if (!m) return { s, pts: null, each: false };
    return { s: clean(s.replace(m[0], ' ')), pts: +m[1], each: !!m[2] };
  }
  function keyPairs(s) {
    const out = [];
    const re = /(?:^|[\s,;|])(\d{1,3})\s*[-.):=|]?\s*\(?([A-Ha-h])\)?(?=$|[\s,;|.])/g;
    let m; while ((m = re.exec(s))) out.push([+m[1], m[2].toUpperCase()]);
    return out;
  }

  function parse(text, media) {
    const res = { title: '', fields: {}, mc: [], sa: [], warnings: [], skipped: [], keyApplied: 0, source: 'parser', pages: [] };
    const IMGS = (media && media.images) || [], TBLS = (media && media.tables) || [];
    let heading = '';
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let mode = 'mc', cur = null, lastField = null, started = false, keyMode = false, defMC = null, defSA = null;
    const keyMap = new Map(), saKeys = new Map();
    let compactKey = '';
    const finishQ = () => { cur = null; lastField = null; };
    const newMC = (num, stem, bold) => {
      const p = takePoints(stem);
      cur = { type: 'mc', num, stem: p.s, choices: [], correct: null, points: p.pts, marks: 0, bold: [], boldStem: !!bold };
      res.mc.push(cur); lastField = 'stem'; started = true;
      const sp = splitStemChoices(cur.stem);
      if (sp) { cur.stem = sp.stem; sp.parts.forEach(x => addChoice(x, false)); }
    };
    const newSA = (num, prompt) => {
      const p = takePoints(prompt);
      cur = { type: 'sa', num, prompt: p.s, points: p.pts, key: '', rubric: '', lines: null };
      res.sa.push(cur); lastField = 'prompt'; started = true;
    };
    // choices are stored by their letter, so "A. x <tab> C. z" then "B. y <tab> D. w" (two columns) land in order
    function addChoice(t, bold) {
      const m = t.match(RE.choice);
      if (!m) return false;
      let body = m[3], marked = !!m[1];
      if (RE.mark.test(body)) { marked = true; body = body.replace(RE.mark, ''); }
      let idx = LET.indexOf(m[2].toUpperCase());
      if (cur.choices[idx] !== undefined) { if (cur.lastIdx !== undefined) cur.choices[cur.lastIdx] = clean(cur.choices[cur.lastIdx] + ' ' + t); return true; }
      cur.choices[idx] = clean(body); cur.bold[idx] = !!bold; cur.lastIdx = idx;
      if (marked) { cur.correct = idx; cur.marks++; }
      lastField = 'choice';
      return true;
    }
    const firstEmpty = q => { for (let k = 0; k < q.choices.length; k++) if (q.choices[k] === undefined) return k; return q.choices.length; };
    for (let raw of lines) {
      const bold = raw.startsWith(BOLD);
      raw = raw.replace(new RegExp(BOLD, 'g'), '');
      let m;
      // a table: a written page (the teacher's table, drawn as a picture, answered on the paper)
      if ((m = raw.trim().match(TBL_TOKEN))) {
        const rows = TBLS[+m[1]];
        finishQ();
        if (rows && typeof document !== 'undefined') {
          const nC = Math.max(...rows.map(r => r.length));
          res.pages.push({ kind: 'ignored', suggest: 'written', page: res.pages.length + 1, caption: heading || 'Table', img: tableImage(rows, heading), rows: rows.length - 1, cols: nC, points: Math.max(1, (rows.length - 1) * (nC - 1)), why: 'a table: not used by default. Choose "Written page" to print it with answer space, or "Reference page" to print it ungraded.' });
        } else res.skipped.push({ raw: '(table)', why: 'table' });
        heading = '';
        continue;
      }
      // pictures: placed with the question part they belong to
      const pics = [];
      raw = raw.replace(IMG_TOKEN, (x, n) => { if (IMGS[+n]) pics.push(IMGS[+n]); return ' '; });
      const t = clean(raw);
      if (pics.length && !t) {
        if (!cur) { res.skipped.push({ raw: '(picture)', why: 'picture outside the questions' }); continue; }
        if (cur.type === 'mc' && lastField === 'choice' && !String(cur.choices[cur.lastIdx]).replace('[picture]', '').trim()) {
          const k = cur.lastIdx; cur.choiceImgs = cur.choiceImgs || []; cur.choiceImgs[k] = (cur.choiceImgs[k] ? cur.choiceImgs[k] : pics[0]); cur.choices[k] = '';
          pics.slice(1).forEach(im => (cur.imgs = cur.imgs || []).push(im));
        } else (cur.imgs = cur.imgs || []).push(...pics);
        continue;
      }
      if (!t) continue;
      // a "Section B: ..." heading (not a question-type heading): ends the question; caption for a table that follows
      if (/^(?:section|part)\s+(?:[A-Z]|\d{1,2}|[IVX]{1,4})\b/i.test(t) && !RE.section.test(t) && t.length < 160 && started) {
        finishQ(); heading = t; res.skipped.push({ raw: t, why: 'section heading' }); continue;
      }
      if (pics.length) res.__pics = pics;
      else delete res.__pics;
      // section headings
      if ((m = t.match(RE.section)) && t.length < 90) {
        keyMode = false; finishQ();
        mode = /multiple/i.test(m[1]) ? 'mc' : 'sa';
        const p = m[2] ? takePoints(m[2]) : null;
        if (p && p.pts !== null) { if (mode === 'mc') defMC = p.pts; else defSA = p.pts; }
        continue;
      }
      // answer key section (or a one-line "Answer key: 1-B 2-C")
      if ((m = t.match(RE.keyHead)) && !(cur && cur.type === 'sa' && m[1].trim() && !keyPairs(m[1]).length && !/^[A-Ea-e]{3,}$/.test(m[1].replace(/[\s,]/g, '')))) {
        const rest = m[1].trim();
        const pairs = keyPairs(rest);
        const compact = rest.replace(/[\s,]/g, '');
        if (!rest || pairs.length || /^[A-Ea-e]{3,}$/.test(compact)) {
          keyMode = true; finishQ();
          if (pairs.length) pairs.forEach(([n, l]) => { if (!keyMap.has(n)) keyMap.set(n, l); });
          else if (rest) compactKey += compact.toUpperCase();
          continue;
        }
      }
      if (keyMode) {
        let mm;
        if ((mm = t.match(/^(?:SA|S\.A\.)\s*(\d{1,3})\s*[.):\-]?\s*(.*)$/i))) { saKeys.set(+mm[1], mm[2]); continue; }
        const pairs = keyPairs(t);
        const compact = t.replace(/[\s,]/g, '');
        if (pairs.length) { pairs.forEach(([n, l]) => { if (!keyMap.has(n)) keyMap.set(n, l); }); continue; }
        if (/^[A-Ea-e]{3,}$/.test(compact)) { compactKey += compact.toUpperCase(); continue; }
        res.skipped.push({ raw: t, why: 'in the answer key section but not an answer' });
        continue;
      }
      // header fields before the first question
      if (!started && (m = t.match(RE.field))) {
        const k = m[1].toLowerCase().replace(/\s+/g, ' ');
        const key = /school|institution/.test(k) ? 'school' : /course|class/.test(k) ? 'course' : /teacher|instructor|professor/.test(k) ? 'teacher'
          : /date/.test(k) ? 'date' : /version|form/.test(k) ? 'version' : /instructions|directions/.test(k) ? 'instructions' : 'title';
        if (m[2].trim() && !/^[_\s.\-]+$/.test(m[2])) res.fields[key] = m[2].trim();
        continue;
      }
      // a new question
      if ((m = t.match(RE.sa))) { newSA(+m[1], m[2]); if (pics.length) cur.imgs = pics.slice(); continue; }
      if ((m = t.match(RE.q)) || (m = t.match(RE.qp))) {
        if (mode === 'sa') newSA(+m[1], m[2]); else newMC(+m[1], m[2], bold);
        if (pics.length) cur.imgs = pics.slice();
        continue;
      }
      if (!cur) { res.skipped.push({ raw: t, why: started ? 'not attached to a question' : 'before the first question' }); continue; }
      if (cur.type === 'mc') {
        if ((m = t.match(RE.ansLine))) { const i = LET.indexOf(m[1].toUpperCase()); cur.keyLine = i; continue; }
        const cm = t.match(RE.choice);
        if (cm && LET.indexOf(cm[2].toUpperCase()) === firstEmpty(cur)) {
          splitLabels(raw.replace(/\u00a0/g, ' ').replace(IMG_TOKEN, ' ').trim()).forEach(x => addChoice(x, bold));
          if (pics.length) { const k = cur.lastIdx; cur.choiceImgs = cur.choiceImgs || []; cur.choiceImgs[k] = pics[0]; if (!cur.choices[k]) cur.choices[k] = ''; pics.slice(1).forEach(im => (cur.imgs = cur.imgs || []).push(im)); }
          continue;
        }
        if (pics.length) (cur.imgs = cur.imgs || []).push(...pics);
        if ((m = t.match(/^points?\s*:\s*(\d+(?:\.\d+)?)/i))) { cur.points = +m[1]; continue; }
        // continuation of the stem or of the last choice
        if (lastField === 'choice') cur.choices[cur.lastIdx] = clean(cur.choices[cur.lastIdx] + ' ' + t);
        else { const p = takePoints(t); if (p.pts !== null && cur.points === null) cur.points = p.pts; cur.stem = cur.stem ? cur.stem + '\n' + p.s : p.s; }
        continue;
      }
      // written question fields
      if (pics.length) (cur.imgs = cur.imgs || []).push(...pics);
      if ((m = t.match(/^(?:key|answer|answer\s*key|model\s*answer|sample\s*answer)\s*:\s*(.*)$/i))) { cur.key = clean((cur.key ? cur.key + ' ' : '') + m[1]); lastField = 'key'; continue; }
      if ((m = t.match(/^rubric\s*:\s*(.*)$/i))) { cur.rubric = (cur.rubric ? cur.rubric + '\n' : '') + clean(m[1]); lastField = 'rubric'; continue; }
      if ((m = t.match(/^(?:lines|box(?:\s*height)?|space)\s*:\s*(\d{1,2})/i))) { cur.lines = +m[1]; lastField = 'lines'; continue; }
      if ((m = t.match(/^points?\s*:\s*(\d+(?:\.\d+)?)/i))) { cur.points = +m[1]; continue; }
      if (lastField === 'key') cur.key += ' ' + t;
      else if (lastField === 'rubric') cur.rubric += '\n' + t;
      else { const p = takePoints(t); if (p.pts !== null && cur.points === null) cur.points = p.pts; cur.prompt = cur.prompt ? cur.prompt + '\n' + p.s : p.s; }
    }

    // ---- post-processing and checks ----
    const W_ = (msg, raw, level = 'warn') => res.warnings.push({ level, msg, raw });
    res.mc.forEach(q => {
      const holes = [];
      for (let k = 0; k < q.choices.length; k++) if (q.choices[k] === undefined) { holes.push(LET[k]); q.choices[k] = ''; q.bold[k] = false; }
      if (holes.length) W_(`Question ${q.num}: choice ${holes.join(', ')} was not found (a later choice letter was). It is left empty; check the question.`, q.stem);
      delete q.lastIdx;
    });
    // questions with no choices in the multiple-choice part become written questions (never dropped)
    res.mc = res.mc.filter(q => {
      if (q.choices.length) return true;
      res.sa.push({ type: 'sa', num: q.num, prompt: q.stem, points: q.points, key: '', rubric: '', lines: null, fromMC: true, imgs: q.imgs });
      W_(`Question ${q.num} has no answer choices, so it was added as a written question. Move it back by adding choices in the editor if needed.`, q.stem);
      return false;
    });
    // bold / highlighted choice as the correct answer when nothing else marks it
    res.mc.forEach(q => {
      const nb = q.bold.filter(Boolean).length;
      if (q.correct === null && q.keyLine === undefined && nb === 1 && q.choices.length > 1) { q.correct = q.bold.indexOf(true); q.fromBold = true; }
      if (q.keyLine !== undefined) {
        if (q.correct !== null && q.correct !== q.keyLine) W_(`Question ${q.num}: the marked choice (${LET[q.correct]}) and the "Answer:" line (${LET[q.keyLine]}) disagree; using ${LET[q.keyLine]}.`);
        q.correct = q.keyLine;
      }
      if (q.marks > 1) W_(`Question ${q.num}: more than one choice is marked correct; using ${LET[q.correct]}. The bubble sheet accepts one answer per question.`);
    });
    // answer key list
    const compact = compactKey.split('');
    if (keyMap.size || compact.length) {
      res.mc.forEach((q, i) => {
        const l = keyMap.has(q.num) ? keyMap.get(q.num) : (compact[i] || null);
        if (!l) return;
        const k = LET.indexOf(l);
        if (q.correct !== null && q.correct !== k) W_(`Question ${q.num}: the answer key says ${l} but the document marks ${LET[q.correct]}; using the answer key (${l}).`);
        if (k >= q.choices.length) { W_(`Question ${q.num}: the answer key says ${l} but the question has only ${q.choices.length} choices.`); return; }
        q.correct = k; res.keyApplied++;
      });
      const nums = new Set(res.mc.map(q => q.num));
      const extra = [...keyMap.keys()].filter(n => !nums.has(n));
      if (extra.length) W_(`The answer key lists question(s) ${extra.join(', ')}, which were not found as multiple-choice questions.`);
    }
    saKeys.forEach((v, n) => { const q = res.sa.find(s => s.num === n); if (q && !q.key) q.key = clean(v); });
    // section default points
    res.mc.forEach(q => { if (q.points === null) q.points = defMC; });
    res.sa.forEach(q => { if (q.points === null) q.points = defSA; });
    res.title = res.fields.title || guessTitle(res.skipped);
    delete res.__pics;
    if (!res.pages.length) delete res.pages;
    return finalize(res);
  }

  function guessTitle(skipped) {
    for (const s of skipped.slice(0, 8)) {
      const t = s.raw;
      if (s.why !== 'before the first question') break;
      if (t.length < 4 || t.length > 80 || /_{3,}|^name\b|^id\b|^date\b|^how to use|^multiple choice:|^written answers:|^instead of|^figures/i.test(t)) continue;
      if (/\b(exam|test|quiz|midterm|final|assessment)\b/i.test(t)) return t;
    }
    return '';
  }

  // shared checks for parser and AI results
  function finalize(res) {
    const W_ = (msg, raw, level = 'warn') => res.warnings.push({ level, msg, raw });
    const noKey = res.mc.filter(q => q.correct === null || q.correct === undefined);
    if (noKey.length) W_(`${noKey.length} multiple-choice question(s) have no correct answer marked: ${noKey.map(q => q.num).join(', ')}. Set them in the editor (or upload a filled key later).`);
    res.mc.forEach(q => {
      if (q.choices.length > 5) W_(`Question ${q.num} has ${q.choices.length} choices; the bubble sheet holds 5 (A to E). Choices ${LET.slice(5, q.choices.length).split('').join(', ')} will not be printed: shorten it in the editor.`, q.choices.slice(5).join(' | '));
      if (q.choices.length === 1) W_(`Question ${q.num} has only one choice.`, q.stem);
      if (res.source !== 'pdf') q.choices.forEach((c, k) => { const m = String(c).match(/(?:^|\s)\(?([A-Ha-h])\s*[.)]\s/); if (m && LET.indexOf(m[1].toUpperCase()) > k) W_(`Question ${q.num}, choice ${LET[k]} contains "${m[1]}." : its choices may not be split correctly. Check this question.`, c); });
      if (!String(q.stem || '').trim()) W_(`Question ${q.num} has no question text.`);
      if (q.fromBold) W_(`Question ${q.num}: correct answer taken from bold/highlighted formatting (${LET[q.correct]}). Check it.`, null, 'info');
    });
    const dup = (arr, label) => {
      const seen = new Map();
      arr.forEach(q => { if (q.num !== null && q.num !== undefined) seen.set(q.num, (seen.get(q.num) || 0) + 1); });
      const d = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
      if (d.length) W_(`${label} number(s) used more than once: ${d.join(', ')}. All copies were kept; delete the extra ones in the editor if needed.`);
      const ns = [...seen.keys()].sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < ns.length; i++) for (let k = ns[i - 1] + 1; k < ns[i] && gaps.length < 20; k++) gaps.push(k);
      if (gaps.length) W_(`${label} number(s) missing from the document: ${gaps.join(', ')}. Check that nothing was skipped.`);
    };
    dup(res.mc, 'Multiple-choice question');
    dup(res.sa.filter(q => !q.fromMC), 'Written question');
    res.sa.forEach(q => { if (!String(q.prompt || '').trim()) W_(`Written question ${q.num} has no prompt text.`); });
    return res;
  }

  // ---------------- AI reader ----------------
  // split text into pieces of at most `max` characters, at a question start when possible
  function chunkText(text, max = CHUNK) {
    const lines = String(text).split('\n');
    const out = []; let buf = [], len = 0;
    const isStart = l => RE.q.test(clean(l.replace(BOLD, ''))) || RE.sa.test(clean(l.replace(BOLD, ''))) || RE.section.test(clean(l));
    for (const l of lines) {
      if (len + l.length + 1 > max && buf.length) {
        // move back to the last question start in this chunk (keeps a question in one piece)
        let cut = buf.length;
        for (let i = buf.length - 1; i > buf.length * 0.5; i--) if (isStart(buf[i])) { cut = i; break; }
        out.push(buf.slice(0, cut).join('\n'));
        buf = buf.slice(cut); len = buf.reduce((a, b) => a + b.length + 1, 0);
      }
      // a single line longer than max (unusual): hard split
      if (l.length > max) { for (let i = 0; i < l.length; i += max) out.push(l.slice(i, i + max)); continue; }
      buf.push(l); len += l.length + 1;
    }
    if (buf.length) out.push(buf.join('\n'));
    return out.filter(s => s.trim());
  }

  function requestsFor(src) {
    const reqs = [];
    src.segments.forEach(seg => {
      if (seg.text !== undefined) chunkText(seg.text.replace(new RegExp(BOLD, 'g'), '').replace(IMG_TOKEN, ' ').replace(/\u0001TBL\d+\u0001/g, '')).forEach(t => reqs.push({ text: t }));
      else for (let i = 0; i < seg.images.length; i += MAX_IMG) reqs.push({ images: seg.images.slice(i, i + MAX_IMG) });
    });
    return reqs;
  }

  // a typed PDF read by the layout reader: page text (with ^{..} / _{..} markup) + page pictures + the figure list, a few pages per request
  async function pdfRequests(src, figures) {
    const pdf = await pdfjsLib.getDocument({ data: src.pdfBuf.slice(0) }).promise;
    const pages = src.pdfLook.pages, reqs = [];
    for (let i = 0; i < pages.length; i += 4) {
      const grp = pages.slice(i, i + 4).filter(p => p.text && p.text.trim());
      if (!grp.length) continue;
      const images = [];
      for (const pg of grp) {
        const page = await pdf.getPage(pg.no);
        const v0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: Math.min(2.2, 1500 / Math.max(v0.width, v0.height)) });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        images.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      }
      const nos = new Set(grp.map(p => p.no));
      reqs.push({ text: grp.map(p => `--- page ${p.no} ---\n` + p.text).join('\n'), images, figures: (figures || []).filter(f => nos.has(f.page)).map(f => ({ id: f.id, where: f.where })) });
    }
    pdf.destroy();
    return reqs;
  }
  // every figure of a layout-reader result, with where the reader placed it (a hint for the AI)
  function figureList(res) {
    const out = [];
    (res.mc || []).forEach(q => {
      (q.imgs || []).forEach(f => out.push({ f, id: f.id, page: f.page, where: `page ${f.page}, ${f.kind || 'picture'} at ${f.box ? Math.round(f.box.x0) + ',' + Math.round(f.box.y0) : '?'} pt, placed with the text of question ${q.num}` }));
      (q.choiceImgs || []).forEach((f, k) => { if (f) out.push({ f, id: f.id, page: f.page, where: `page ${f.page}, ${f.kind || 'picture'} at ${f.box ? Math.round(f.box.x0) + ',' + Math.round(f.box.y0) : '?'} pt, placed as choice ${LET[k]} of question ${q.num}` }); });
    });
    (res.sa || []).forEach(q => (q.imgs || []).forEach(f => out.push({ f, id: f.id, page: f.page, where: `page ${f.page}, placed with written question ${q.num}` })));
    return out.filter(x => x.id);
  }

  // post(payload) -> server JSON; ai = settings.ai; onStatus(msg)
  async function aiRead(src, { post, model, rpm, onStatus, stopped = () => false, layout = null }) {
    const figs = layout ? figureList(layout) : [];
    const byId = new Map(figs.map(x => [x.id, x.f]));
    const reqs = src.pdfLook && src.pdfBuf ? await pdfRequests(src, figs) : requestsFor(src);
    if (!reqs.length) throw new Error('The document has no text or page images to read');
    const res = { title: '', fields: {}, mc: [], sa: [], warnings: [], skipped: [], keyApplied: 0, source: 'ai', requests: reqs.length, fromPdf: !!src.pdfLook };
    if (layout && layout.pages) { res.pages = layout.pages; res.unused = layout.unused; res.srcPages = layout.srcPages; }
    for (let i = 0; i < reqs.length; i++) {
      let r, tries = 0;
      for (;;) {
        if (stopped()) throw new Error('Stopped');
        await AI.pace(rpm, stopped, w => onStatus && onStatus(`AI reading part ${i + 1} of ${reqs.length}: waiting ${Math.ceil(w / 1000)} s (rate limit)`));
        onStatus && onStatus(`AI reading part ${i + 1} of ${reqs.length}...`);
        r = await post({ action: 'aiExtract', model, text: reqs[i].text || '', images: reqs[i].images || [], figures: reqs[i].figures || [], part: i + 1, parts: reqs.length });
        await AI.bump();
        if (r && r.rateLimited && !r.dailyQuota && tries++ < 4) {
          const wait = Math.max(2, +r.retryAfter || 30);
          for (let s = wait; s > 0; s--) { if (stopped()) throw new Error('Stopped'); onStatus && onStatus(`Google rate limit: retrying part ${i + 1} in ${s} s`); await U.sleep(1000); }
          AI.resetPace();
          continue;
        }
        break;
      }
      if (!r || !r.ok) throw new Error((r && r.error) || 'AI reading failed');
      const x = r.result || {};
      if (!res.title && x.title) res.title = x.title;
      (x.mc || []).forEach(q => {
        const o = { type: 'mc', num: src.pdfLook && +q.number ? +q.number : res.mc.length + 1, docNum: q.number || '', stem: q.stem || '', choices: (q.choices || []).map(String), correct: (q.correct === null || q.correct === undefined) ? null : q.correct, points: q.points || null, part: i + 1, ai: true };
        const sf = (q.stemFigures || []).map(id => byId.get(id)).filter(Boolean);
        if (sf.length) o.imgs = sf;
        (q.choiceFigures || []).forEach(cf => { const f = byId.get(cf.figure); if (f && cf.choice < o.choices.length) { o.choiceImgs = o.choiceImgs || []; o.choiceImgs[cf.choice] = f; } });
        res.mc.push(o);
      });
      (x.sa || []).forEach(q => res.sa.push({ type: 'sa', num: res.sa.length + 1, docNum: q.number || '', prompt: q.prompt || '', points: q.points || null, key: q.key || '', rubric: q.rubric || '', lines: q.lines || null, part: i + 1, ai: true }));
    }
    // an answer key listed at the end of a long document reaches the AI separately from its questions: apply it here
    const det = parse(src.text);
    let applied = 0;
    if (det.mc.length || det.keyApplied) {
      const byNum = new Map(det.mc.map(q => [q.num, q]));
      res.mc.forEach(q => {
        if (q.correct !== null) return;
        const d = byNum.get(+q.docNum || q.num);
        if (d && d.correct !== null && d.correct < q.choices.length) { q.correct = d.correct; applied++; }
      });
    }
    if (applied) res.warnings.push({ level: 'info', msg: `${applied} correct answer(s) taken from the answer key list in the document.` });
    // verbatim check: the question text must appear in the document text
    if (src.text.trim()) {
      const norm = s => String(s).toLowerCase().replace(/[\^_]\{([^{}]*)\}/g, '$1').replace(/[^a-z0-9]+/g, '');
      const doc = norm(src.text.replace(new RegExp(BOLD, 'g'), ''));
      const notFound = [];
      res.mc.forEach(q => { const n = norm(q.stem).slice(0, 60); if (n.length > 8 && !doc.includes(n)) notFound.push('MC ' + q.num); });
      res.sa.forEach(q => { const n = norm(q.prompt).slice(0, 60); if (n.length > 8 && !doc.includes(n)) notFound.push('SA ' + q.num); });
      if (notFound.length && !src.scanned) res.warnings.push({ level: 'warn', msg: `The AI text of ${notFound.join(', ')} does not match the document word for word. Compare it with your document before printing.` });
    }
    return finalize(res);
  }

  // ---------------- Word template (content controls) ----------------
  // templates/exam-template-base.docx (built by tools/make_template.py) looks like the printed exam. Every editable part
  // is a content control with a stable tag; question blocks are block-level controls tagged "mcq" / "saq".
  const TPL_BASE = 'templates/exam-template-base.docx';
  const OURS = /^(Bubble [A-E0-9]|Write box|Name box|Score box|Points box|Filled|Check|Cross|Corner square \d|Page code)$/;
  const HINTS = [/^Type (?:written )?question \d+ here$/i, /^Choice [A-E]$/, /^Choose correct answer$/i, /^Type the model answer used for grading$/i,
    /^Points per element, for example:/i, /^(?:School name|Course|Teacher|Exam title|Date)$/];
  const TPL_SIZES = new Set([[5.2, 5.2], [6, 7], [112, 14], [50, 30], [14.5, 12]].map(([w, h]) => Math.round(w * 36000) + 'x' + Math.round(h * 36000)));
  const sdtTag = s => wval(kid(kid(s, 'sdtPr'), 'tag')) || '';
  const normWS = s => String(s || '').replace(/\s+/g, ' ').trim();
  // the template's own instruction text (same as the printed default): kept out of exam.instructions unless the teacher edits it
  const TPL_INSTR = normWS('Write your name in the box and your student ID in the grid, filling one bubble per digit. For multiple choice, completely fill the one bubble next to your answer with a dark pencil or pen. Erase changes cleanly. Write short answers inside the boxes. Work outside the boxes may not be graded. Keep all pages together and do not fold the pages.');
  const MAX_DIGITS = 12, ID_COL = 7.2;
  const twip = v => Math.round(v * 1440 / 25.4);
  function sdtText(s, pics) {
    const pr = kid(s, 'sdtPr');
    if (kid(pr, 'showingPlcHdr')) return '';
    const content = kid(s, 'sdtContent');
    if (!content) return '';
    let out = '', va = null;
    const walk = (node, depth) => {
      for (const c of Array.from(node.childNodes)) {
        if (c.namespaceURI !== W) continue;
        const n = c.localName;
        if (n === 'r') { const rp = kid(c, 'rPr'); const keep = va; va = rp ? wval(kid(rp, 'vertAlign')) : null; walk(c, depth + 1); va = keep; continue; }
        if ((n === 'drawing' || n === 'pict') && pics) {
          // the template's own bubbles and boxes are not the teacher's pictures
          const dp = c.getElementsByTagNameNS(NS_WP, 'docPr')[0], ext = c.getElementsByTagNameNS(NS_WP, 'extent')[0];
          const own = (dp && OURS.test(dp.getAttribute('name') || '')) || (ext && TPL_SIZES.has(Math.round(+ext.getAttribute('cx')) + 'x' + Math.round(+ext.getAttribute('cy'))));
          const d = own ? null : drawingRef(c);
          if (d) { pics.push(d); out += '\u0001IMG' + (pics.length - 1) + '\u0001'; }
          continue;
        }
        if (n === 't') out += vScript(c.textContent, va);
        else if (n === 'tab') out += ' ';
        else if (n === 'br' || n === 'cr') out += '\n';
        else if (n === 'del' || n === 'rPr' || n === 'pPr' || n === 'sdtPr' || n === 'instrText') continue;
        else { walk(c, depth + 1); if (n === 'p') out += '\n'; }
      }
    };
    walk(content, 0);
    const v = out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return HINTS.some(re => re.test(v)) ? '' : v;
  }
  function setSdtText(doc, s, value, asValue) {
    const pr = kid(s, 'sdtPr'), content = kid(s, 'sdtContent');
    const ph = kid(pr, 'showingPlcHdr');
    const runs = Array.from(content.getElementsByTagNameNS(W, 'r'));
    const r0 = runs[0];
    runs.slice(1).forEach(r => r.parentNode.removeChild(r));
    const ts = Array.from(r0.getElementsByTagNameNS(W, 't'));
    ts.slice(1).forEach(t => t.parentNode.removeChild(t));
    Array.from(r0.getElementsByTagNameNS(W, 'br')).forEach(t => t.parentNode.removeChild(t));
    const t = ts[0];
    t.textContent = value;
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    if (asValue) {
      if (ph) pr.removeChild(ph);
      const old = kid(r0, 'rPr'); if (old) r0.removeChild(old);
      const want = kid(pr, 'rPr');
      if (want) r0.insertBefore(want.cloneNode(true), r0.firstChild);
    }
  }

  // Build the Word template for the counts the teacher picked. o = { mc, choices (4|5), sa, idDigits, school, course, teacher, title, date, version, kind }
  async function buildWordTemplate(o = {}) {
    const nMC = Math.max(0, Math.min(100, o.mc | 0)), nSA = Math.max(0, Math.min(30, o.sa | 0));
    if (nMC + nSA < 1) throw new Error('Choose at least one question');
    const nCh = +o.choices === 4 ? 4 : 5;
    const nd = Math.max(1, Math.min(MAX_DIGITS, o.idDigits | 0 || 7));
    const res = await fetch(o.baseUrl || TPL_BASE);
    if (!res.ok) throw new Error('Could not load the Word template (' + res.status + ')');
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const doc = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const sdts = () => Array.from(doc.getElementsByTagNameNS(W, 'sdt'));
    const inner = (block, tag) => Array.from(block.getElementsByTagNameNS(W, 'sdt')).find(s => sdtTag(s) === tag);
    const parentP = n => { while (n && !(n.namespaceURI === W && n.localName === 'p')) n = n.parentNode; return n; };
    const mcq = sdts().find(s => sdtTag(s) === 'mcq'), saq = sdts().find(s => sdtTag(s) === 'saq');
    // section break paragraphs: [after cover, after the multiple-choice pages]
    const breaks = kids(body, 'p').filter(p => kid(kid(p, 'pPr'), 'sectPr'));
    const finalSect = kid(body, 'sectPr');
    // multiple-choice blocks
    for (let i = 1; i <= nMC; i++) {
      const c = mcq.cloneNode(true);
      setSdtText(doc, inner(c, 'mc_stem'), `Type question ${i} here`, false);
      if (nCh === 4) {
        const e = inner(c, 'mc_E'); const p = parentP(e); p.parentNode.removeChild(p);
        const dd = inner(c, 'mc_key');
        Array.from(dd.getElementsByTagNameNS(W, 'listItem')).filter(li => li.getAttributeNS(W, 'value') === 'E').forEach(li => li.parentNode.removeChild(li));
      }
      mcq.parentNode.insertBefore(c, mcq);
    }
    for (let i = 1; i <= nSA; i++) {
      const c = saq.cloneNode(true);
      setSdtText(doc, inner(c, 'sa_prompt'), `Type written question ${i} here`, false);
      saq.parentNode.insertBefore(c, saq);
    }
    mcq.parentNode.removeChild(mcq); saq.parentNode.removeChild(saq);
    // one question type only: drop the page break between the two sections (the last section keeps the question-page header)
    if (!nMC || !nSA) {
      const b = breaks[1], sp = kid(kid(b, 'pPr'), 'sectPr');
      kids(sp, 'headerReference').concat(kids(sp, 'footerReference')).reverse().forEach(r => finalSect.insertBefore(r.cloneNode(true), finalSect.firstChild));
      b.parentNode.removeChild(b);
    }
    // header fields from Settings
    const fields = { hdr_school: o.school, hdr_course: o.course, hdr_teacher: o.teacher, hdr_title: o.title, hdr_date: o.date, hdr_version: o.version };
    sdts().forEach(s => { const v = fields[sdtTag(s)]; if (v !== undefined && v !== null && String(v).trim()) setSdtText(doc, s, String(v).trim(), true); });
    // Student ID grid: keep nd columns
    const tbls = Array.from(doc.getElementsByTagNameNS(W, 'tbl'));
    const cap = t => wval(kid(kid(t, 'tblPr'), 'tblCaption'));
    const grid = tbls.find(t => cap(t) === 'idgrid'), row = tbls.find(t => cap(t) === 'idrow');
    const gw = nd * ID_COL + 8;
    Array.from(grid.getElementsByTagNameNS(W, 'p')).forEach(p => {
      const tabs = kid(kid(p, 'pPr'), 'tabs');
      if (!tabs) return;
      kids(tabs, 'tab').slice(nd).forEach(t => tabs.removeChild(t));
      kids(p, 'r').slice(2 * nd).forEach(r => p.removeChild(r));
    });
    const setW = (node, mmv) => node.setAttributeNS(W, 'w:w', String(twip(mmv)));
    setW(kid(kid(grid, 'tblPr'), 'tblW'), gw);
    setW(kids(kid(grid, 'tblGrid'), 'gridCol')[0], gw);
    setW(kid(kid(grid.getElementsByTagNameNS(W, 'tc')[0], 'tcPr'), 'tcW'), gw);
    const widths = [gw, 8, 172 - gw - 8];
    kids(kid(row, 'tblGrid'), 'gridCol').forEach((g, i) => setW(g, widths[i]));
    kids(kids(row, 'tr')[0], 'tc').forEach((tc, i) => setW(kid(kid(tc, 'tcPr'), 'tcW'), widths[i]));
    // unique ids for content controls and pictures
    let sid = 1;
    sdts().forEach(s => { const id = kid(kid(s, 'sdtPr'), 'id'); if (id) id.setAttributeNS(W, 'w:val', String(sid++)); });
    let pid = 5000;
    const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    Array.from(doc.getElementsByTagNameNS(WP, 'docPr')).forEach(d => {
      pid++; d.setAttribute('id', String(pid));
      const g = d.parentNode.getElementsByTagNameNS(PIC, 'cNvPr')[0]; if (g) g.setAttribute('id', String(pid));
    });
    let xml = new XMLSerializer().serializeToString(doc);
    if (!/^<\?xml/.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tot = { NMC: nMC, MCPTS: nMC, NSA: nSA, SAPTS: nSA * 5, TOTAL: nMC + nSA * 5 };
    xml = xml.replace(/\{(NMC|MCPTS|NSA|SAPTS|TOTAL)\}/g, (m, k) => String(tot[k]));
    zip.file('word/document.xml', xml);
    // the assignment type travels in the document properties (Category) and is read back on upload
    const core = zip.file('docProps/core.xml');
    if (core && o.kind && o.kind !== 'exam') zip.file('docProps/core.xml', (await core.async('string')).replace(/<cp:category\/>|<cp:category>[^<]*<\/cp:category>/, `<cp:category>examgrader-kind:${o.kind}</cp:category>`));
    const hdrLine = esc([o.title || 'Exam title', o.course].filter(x => x && String(x).trim()).join('  |  '));
    for (const n of Object.keys(zip.files).filter(n => /^word\/header\d+\.xml$/.test(n))) {
      const s = await zip.file(n).async('string');
      if (s.includes('{HDRLINE}')) zip.file(n, s.replace('{HDRLINE}', hdrLine));
    }
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // Read a filled Word template deterministically (no AI). Returns null when the file is not the Exam Grader template.
  async function parseTemplateDocx(buf) {
    const zip = buf instanceof JSZip ? buf : await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) return null;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    const tagged = Array.from(doc.getElementsByTagNameNS(W, 'sdt')).map(s => ({ s, tag: sdtTag(s).trim() })).filter(x => x.tag);
    if (!tagged.some(x => x.tag === 'mc_stem' || x.tag === 'sa_prompt')) return null;
    const res = { title: '', fields: {}, mc: [], sa: [], warnings: [], skipped: [], keyApplied: 0, source: 'template' };
    const core = zip.file('docProps/core.xml');
    const km = core ? (await core.async('string')).match(/<cp:category>examgrader-kind:(\w+)<\/cp:category>/) : null;
    if (km && ['quiz', 'homework'].includes(km[1])) res.kind = km[1];
    const num = v => { const m = String(v).replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : null; };
    let cur = null;
    const pics = [];
    const takePics = v => { const out = []; return { t: String(v).replace(IMG_TOKEN, (x, n) => { out.push(+n); return ''; }).trim(), ids: out }; };
    for (const { s, tag } of tagged) {
      if (tag === 'mcq' || tag === 'saq') continue;
      let v = sdtText(s, pics);
      let ids = [];
      if (IMG_TOKEN.test(v)) { IMG_TOKEN.lastIndex = 0; const tp = takePics(v); v = tp.t; ids = tp.ids; }
      IMG_TOKEN.lastIndex = 0;
      if (ids.length && cur && /^mc_[A-E]$/.test(tag) && cur.type === 'mc') { cur.picIds = cur.picIds || {}; cur.picIds[tag.slice(3)] = ids[0];  }
      else if (ids.length && (tag === 'mc_stem' || tag === 'sa_prompt')) { /* attached below once the block exists */ }
      let m;
      if ((m = tag.match(/^hdr_(\w+)$/))) { if (v && !(m[1] === 'instructions' && normWS(v) === TPL_INSTR)) res.fields[m[1]] = v; continue; }
      if (tag === 'mc_stem') { cur = { type: 'mc', num: res.mc.length + 1, stem: v, raw: {}, keyLetter: '', points: null, stemPics: ids }; res.mc.push(cur); continue; }
      if (tag === 'sa_prompt') { cur = { type: 'sa', num: res.sa.length + 1, prompt: v, points: null, key: '', rubric: '', lines: null, stemPics: ids }; res.sa.push(cur); continue; }
      if (!cur) continue;
      if ((m = tag.match(/^mc_([A-E])$/)) && cur.type === 'mc') { if (!(m[1] in cur.raw)) cur.raw[m[1]] = v; continue; }
      if (tag === 'mc_key' && cur.type === 'mc') { cur.keyLetter = v; continue; }
      if (tag === 'mc_points' && cur.type === 'mc') { cur.points = num(v); continue; }
      if (cur.type !== 'sa') continue;
      if (tag === 'sa_key') cur.key = v;
      else if (tag === 'sa_rubric') cur.rubric = v;
      else if (tag === 'sa_lines') cur.lines = num(v);
      else if (tag === 'sa_points') cur.points = num(v);
    }
    const W_ = (msg, raw, level = 'warn') => res.warnings.push({ level, msg, raw });
    // pictures pasted into the question and choice boxes
    if (pics.length) {
      const rels = await docxRels(zip);
      const data = [];
      for (const d of pics) { const src = rels[d.rid] ? await mediaData(zip, rels[d.rid]) : null; data.push(src ? { src, wpt: d.wpt || 120, hpt: d.hpt || 90 } : null); }
      [...res.mc, ...res.sa].forEach(q => {
        const sp = (q.stemPics || []).map(i => data[i]).filter(Boolean);
        if (sp.length) q.imgs = sp;
        if (q.picIds) { q.choiceImgs = []; Object.entries(q.picIds).forEach(([L, i]) => { q.choiceImgs[LET.indexOf(L)] = data[i] || null; }); }
      });
    }
    [...res.mc, ...res.sa].forEach(q => { delete q.stemPics; delete q.picIds; });
    // unused (empty) blocks are skipped; everything typed is kept
    let emptyMC = 0, emptySA = 0;
    res.mc = res.mc.filter(q => { const any = q.stem || Object.values(q.raw).some(Boolean) || (q.imgs || []).length; if (!any) emptyMC++; return any; });
    res.sa = res.sa.filter(q => { const any = q.prompt || q.key || q.rubric || (q.imgs || []).length; if (!any) emptySA++; return any; });
    res.mc.forEach((q, i) => {
      q.num = i + 1;
      let last = -1;
      LET.slice(0, 5).split('').forEach((L, k) => { if (q.raw[L]) last = k; });
      q.choices = LET.slice(0, last + 1).split('').map(L => q.raw[L] || '');
      const gaps = q.choices.map((c, k) => c ? null : LET[k]).filter(Boolean);
      if (gaps.length) W_(`Question ${q.num}: choice ${gaps.join(', ')} is empty but a later choice is filled. Empty choices are printed as blank bubbles; fill or remove them in the editor.`, q.stem);
      q.correct = null;
      const k = String(q.keyLetter || '').trim().toUpperCase().match(/^\(?([A-E])\)?$/);
      if (k) {
        const idx = LET.indexOf(k[1]);
        if (idx >= q.choices.length || !q.choices[idx]) W_(`Question ${q.num}: the correct answer is set to ${k[1]}, but choice ${k[1]} is empty.`, q.stem);
        else q.correct = idx;
      } else if (q.keyLetter) W_(`Question ${q.num}: the correct answer "${q.keyLetter}" is not a letter A to E.`, q.stem);
      if (!(q.points > 0)) q.points = 1;
      delete q.raw; delete q.keyLetter;
    });
    res.sa.forEach((q, i) => {
      q.num = i + 1;
      if (!(q.points > 0)) q.points = 5;
      if (q.lines !== null) q.lines = Math.max(1, Math.min(28, Math.round(q.lines)));
    });
    if (emptyMC || emptySA) W_(`${[emptyMC ? emptyMC + ' empty multiple-choice block(s)' : '', emptySA ? emptySA + ' empty written block(s)' : ''].filter(Boolean).join(' and ')} in the template were left out.`, null, 'info');
    res.title = res.fields.title || '';
    // pictures the teacher pasted (not the template's own bubbles and boxes)
    const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    // (Word may rename pasted pictures, so the template's own ones are also recognised by their exact size)
    const SIZES = new Set([[5.2, 5.2], [6, 7], [112, 14], [50, 30], [14.5, 12]].map(([w, h]) => Math.round(w * 36000) + 'x' + Math.round(h * 36000)));
    res.figures = Array.from(doc.getElementsByTagNameNS(WP, 'docPr')).filter(d => {
      if (OURS.test(d.getAttribute('name') || '')) return false;
      const ext = d.parentNode && Array.from(d.parentNode.childNodes).find(c => c.localName === 'extent');
      return !(ext && SIZES.has(Math.round(+ext.getAttribute('cx')) + 'x' + Math.round(+ext.getAttribute('cy'))));
    }).length;
    return finalize(res);
  }

  // ---------------- PDF layout reader merged with the text parser ----------------
  // lines the layout reader must not glue onto a question: answer lines, answer keys, written questions, section titles
  function pdfMeta(t) {
    t = clean(t);
    if (RE.ansLine.test(t) || /^points?\s*:\s*\d/i.test(t)) return 'meta';
    const k = t.match(RE.keyHead);
    if (k && (!k[1].trim() || keyPairs(k[1]).length || /^[A-Ea-e]{3,}$/.test(k[1].replace(/[\s,]/g, '')) || /^key\s*:/i.test(t))) return 'stop';
    if (RE.sa.test(t) || (RE.section.test(t) && t.length < 90)) return 'stop';
    return null;
  }
  // det = text parser result (answers, points, keys, written questions); ps = PdfSrc result (questions, crops, pages)
  function mergeLook(det, ps) {
    const res = { title: det.title, fields: det.fields, mc: [], sa: [], warnings: [], skipped: [], keyApplied: det.keyApplied, source: 'pdf',
      pages: ps.pageItems.map(p => ({ ...p })), unused: ps.unused, srcPages: ps.pages };
    const W_ = (msg, raw, level = 'warn') => res.warnings.push({ level, msg, raw });
    const byNum = new Map();
    det.mc.forEach(q => { if (!byNum.has(q.num)) byNum.set(q.num, []); byNum.get(q.num).push(q); });
    const saByNum = new Map(det.sa.filter(q => q.fromMC).map(q => [q.num, q]));
    (ps.warnings || []).forEach(w => typeof w === 'string' ? W_(w, null, 'info') : W_(w.msg, w.raw || null, w.level || 'warn'));
    ps.mc.forEach((p, i) => {
      const d = (byNum.get(p.num) || []).shift();
      if (p.odd === 'repeated') W_(`The document numbers two questions ${p.num} (the second one is on page ${p.page}). Both are kept and printed as ${p.num}, as in your document; in the gradebook and the scan review they are Q${i} and Q${i + 1} (questions are counted in order there).`, p.stem);
      if (p.odd === 'skipped') W_(`The document skips from question ${ps.mc[i - 1] ? ps.mc[i - 1].num : '?'} to ${p.num}; it is printed as ${p.num}, as in your document, and counted as Q${i + 1} in the gradebook.`, p.stem);
      const tp = takePoints(p.stem);
      let correct = d && d.choices.length === p.choices.length ? d.correct : null;
      const marks = p.choices.map(c => RE.mark.test(c));
      const choices = p.choices.map(c => clean(c.replace(RE.mark, '')));
      if (p.markedChoice >= 0) correct = p.markedChoice;
      else if (correct === null && marks.filter(Boolean).length === 1) correct = marks.indexOf(true);
      const points = tp.pts !== null ? tp.pts : d ? d.points : (saByNum.get(p.num) || {}).points || null;
      const imgs = (p.stemFigs || []).slice();
      if (!choices.length) {
        res.sa.push({ type: 'sa', num: p.num, prompt: tp.s, points, key: '', rubric: '', lines: null, fromMC: true, imgs });
        W_(`Question ${p.num} has no answer choices, so it was added as a written question.`, tp.s);
        return;
      }
      const q = { type: 'mc', num: p.num, page: p.page, stem: tp.s, choices, correct, points, kind: 'mc' };
      if (imgs.length) q.imgs = imgs;
      if ((p.choiceFigs || []).some(Boolean)) q.choiceImgs = p.choiceFigs.slice();
      q.choices.forEach((c, k) => { if (!c && !(q.choiceImgs && q.choiceImgs[k])) W_(`Question ${p.num}: choice ${LET[k]} is empty.`, p.stem); });
      res.mc.push(q);
    });
    // figure ids (for the AI reader and the review screen)
    let fid = 0;
    res.mc.forEach(q => { (q.imgs || []).forEach(f => { f.id = 'F' + (++fid); }); (q.choiceImgs || []).forEach(f => { if (f) f.id = 'F' + (++fid); }); });
    res.sa.forEach(q => (q.imgs || []).forEach(f => { f.id = 'F' + (++fid); }));
    const have = new Set(ps.mc.map(q => q.num));
    det.mc.filter(q => !have.has(q.num) && q.choices.length).forEach(q => { res.mc.push({ ...q, kind: 'mc' }); W_(`Question ${q.num} was found in the text but not on the page layout; it is printed as typed text.`, q.stem); });
    det.sa.filter(q => !(q.fromMC && have.has(q.num))).forEach(q => res.sa.push(q));
    finalize(res);
    res.warnings = res.warnings.filter(w => !/number\(s\) used more than once/.test(w.msg));
    const nX = res.pages.filter(p => p.kind === 'ignored').length;
    const nF = fid;
    W_(`Questions and choices were read as text (superscripts and subscripts written as ^{..} and _{..}); ${nF} figure(s) were copied as pictures.` +
      (nX ? ` ${nX} page(s) or section(s) without numbered questions (tables, pictures) are not used; you can include each one as a written or reference page below.` : ''), null, 'info');
    return res;
  }

  // ---------------- import result -> exam fields ----------------
  function toExam(exam, imp) {
    const f = imp.fields || {};
    if (imp.title || f.title) exam.title = imp.title || f.title;
    if (imp.kind) exam.kind = imp.kind;
    if (f.school) exam.school = f.school;
    if (f.course) exam.course = f.course;
    if (f.teacher) exam.teacher = f.teacher;
    if (f.version) exam.version = f.version.slice(0, 4);
    if (f.instructions) exam.instructions = f.instructions;
    if (f.date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.date)) exam.date = f.date;
      else { const d = new Date(f.date); if (!isNaN(d)) exam.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    }
    const kindOf = q => q.kind || 'mc';
    exam.mc = imp.mc.filter(q => kindOf(q) === 'mc').map(q => {
      const choices = q.choices.slice(0, 5).map(c => String(c));
      while (choices.length < 2) choices.push('');
      const o = { id: U.uid('q_'), ...((imp.source === 'pdf' || imp.fromPdf) && q.num ? { label: String(q.num) } : {}), stem: q.stem || '', choices, answer: (q.correct !== null && q.correct !== undefined && q.correct < choices.length) ? LET[q.correct] : '', points: q.points || 1 };
      if (q.look) { o.look = { stem: q.look.stem || null, choices: q.look.choices.slice(0, 5) }; while (o.look.choices.length < choices.length) o.look.choices.push(null); o.useText = !!q.useText; }
      if (q.imgs) o.imgs = q.imgs;
      if (q.choiceImgs) o.choiceImgs = q.choiceImgs.slice(0, 5);
      return o;
    });
    const saOf = q => {
      const o = { id: U.uid('s_'), prompt: q.prompt || '', max: q.points || 5, lines: Math.max(1, Math.min(28, q.lines || 6)), comments: [], key: q.key || '', modelAnswer: q.key || '', rubric: q.rubric || '' };
      if (q.img) o.img = q.img;
      if (q.imgs) o.imgs = q.imgs;
      return o;
    };
    exam.sa = imp.sa.map(saOf);
    // multiple-choice questions the teacher turned into written questions: the original question becomes the prompt picture
    imp.mc.filter(q => kindOf(q) === 'written').forEach(q => exam.sa.push(saOf({ prompt: [q.stem, ...q.choices.map((c, k) => LET[k] + '. ' + c)].join('\n'), points: q.points || 5, imgs: q.imgs || [] })));
    const pages = (imp.pages || []).filter(p => p.img);
    pages.filter(p => p.kind === 'written').forEach(p => exam.sa.push({ id: U.uid('s_'), kind: 'page', prompt: p.caption || 'Written page', img: p.img, max: +p.points > 0 ? +p.points : 10, lines: 0, comments: [], key: '', modelAnswer: '', rubric: '', srcPage: p.page }));
    exam.refPages = pages.filter(p => p.kind === 'reference').map(p => ({ id: U.uid('r_'), img: p.img, caption: p.caption || '', srcPage: p.page }));
    exam.frontPages = pages.filter(p => p.kind === 'extra').map(p => ({ id: U.uid('f_'), img: p.img, caption: p.caption || '', srcPage: p.page }));
    return exam;
  }

  // one picture from a question's stem and choice crops (used when a question becomes a written question)
  function stackLook(look) { return look.stem || null; }

  return { BOLD, CHUNK, MAX_IMG, docxToText, pdfExtract, readFiles, parse, chunkText, requestsFor, aiRead, toExam, finalize, LET, buildWordTemplate, parseTemplateDocx, TPL_BASE, RE, pdfMeta, mergeLook };
})();
