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
    for (const p of body.getElementsByTagNameNS(W, 'p')) {
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
            for (const t of Array.from(c.childNodes)) {
              if (t.namespaceURI !== W) continue;
              if (t.localName === 't') { const s = t.textContent; text += s; const n = s.replace(/\s/g, '').length; allChars += n; if (strong) boldChars += n; }
              else if (t.localName === 'tab') text += '\t';
              else if (t.localName === 'br' || t.localName === 'cr') text += '\n';
            }
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
    return { text: lines.join('\n'), images };
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
        const tpl = files.length === 1 ? await parseTemplateDocx(buf) : null;
        if (tpl) { out.template = tpl; out.figures += tpl.figures; } else out.figures += r.images;
        addText(r.text);
      } else if (/\.pdf$/.test(n) || f.type === 'application/pdf') {
        const r = await pdfExtract(await f.arrayBuffer(), (p, t) => onProgress && onProgress(`Reading ${f.name}: page ${p} of ${t}`));
        out.kinds.push('pdf'); out.figures += r.images;
        r.pages.forEach(p => p.image ? addImg(p.image) : addText(p.text));
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

  function parse(text) {
    const res = { title: '', fields: {}, mc: [], sa: [], warnings: [], skipped: [], keyApplied: 0, source: 'parser' };
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
    function addChoice(t, bold) {
      const m = t.match(RE.choice);
      if (!m) return false;
      let body = m[3], marked = !!m[1];
      if (RE.mark.test(body)) { marked = true; body = body.replace(RE.mark, ''); }
      cur.choices.push(clean(body)); cur.bold.push(!!bold);
      if (marked) { cur.correct = cur.choices.length - 1; cur.marks++; }
      lastField = 'choice';
      return true;
    }
    for (let raw of lines) {
      const bold = raw.startsWith(BOLD);
      raw = raw.replace(new RegExp(BOLD, 'g'), '');
      const t = clean(raw);
      if (!t) continue;
      let m;
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
      if ((m = t.match(RE.sa))) { newSA(+m[1], m[2]); continue; }
      if ((m = t.match(RE.q)) || (m = t.match(RE.qp))) {
        if (mode === 'sa') newSA(+m[1], m[2]); else newMC(+m[1], m[2], bold);
        continue;
      }
      if (!cur) { res.skipped.push({ raw: t, why: started ? 'not attached to a question' : 'before the first question' }); continue; }
      if (cur.type === 'mc') {
        if ((m = t.match(RE.ansLine))) { const i = LET.indexOf(m[1].toUpperCase()); cur.keyLine = i; continue; }
        const cm = t.match(RE.choice);
        if (cm && LET.indexOf(cm[2].toUpperCase()) === cur.choices.length) {
          splitInline(t, cur.choices.length).forEach(x => addChoice(x, bold));
          continue;
        }
        if ((m = t.match(/^points?\s*:\s*(\d+(?:\.\d+)?)/i))) { cur.points = +m[1]; continue; }
        // continuation of the stem or of the last choice
        if (lastField === 'choice') cur.choices[cur.choices.length - 1] = clean(cur.choices[cur.choices.length - 1] + ' ' + t);
        else { const p = takePoints(t); if (p.pts !== null && cur.points === null) cur.points = p.pts; cur.stem = cur.stem ? cur.stem + '\n' + p.s : p.s; }
        continue;
      }
      // written question fields
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
    // questions with no choices in the multiple-choice part become written questions (never dropped)
    res.mc = res.mc.filter(q => {
      if (q.choices.length) return true;
      res.sa.push({ type: 'sa', num: q.num, prompt: q.stem, points: q.points, key: '', rubric: '', lines: null, fromMC: true });
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
      if (seg.text !== undefined) chunkText(seg.text.replace(new RegExp(BOLD, 'g'), '')).forEach(t => reqs.push({ text: t }));
      else for (let i = 0; i < seg.images.length; i += MAX_IMG) reqs.push({ images: seg.images.slice(i, i + MAX_IMG) });
    });
    return reqs;
  }

  // post(payload) -> server JSON; ai = settings.ai; onStatus(msg)
  async function aiRead(src, { post, model, rpm, onStatus, stopped = () => false }) {
    const reqs = requestsFor(src);
    if (!reqs.length) throw new Error('The document has no text or page images to read');
    const res = { title: '', fields: {}, mc: [], sa: [], warnings: [], skipped: [], keyApplied: 0, source: 'ai', requests: reqs.length };
    for (let i = 0; i < reqs.length; i++) {
      let r, tries = 0;
      for (;;) {
        if (stopped()) throw new Error('Stopped');
        await AI.pace(rpm, stopped, w => onStatus && onStatus(`AI reading part ${i + 1} of ${reqs.length}: waiting ${Math.ceil(w / 1000)} s (rate limit)`));
        onStatus && onStatus(`AI reading part ${i + 1} of ${reqs.length}...`);
        r = await post({ action: 'aiExtract', model, text: reqs[i].text || '', images: reqs[i].images || [], part: i + 1, parts: reqs.length });
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
      (x.mc || []).forEach(q => res.mc.push({ type: 'mc', num: res.mc.length + 1, docNum: q.number || '', stem: q.stem || '', choices: (q.choices || []).map(String), correct: (q.correct === null || q.correct === undefined) ? null : q.correct, points: q.points || null, part: i + 1, ai: true }));
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
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
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
  const sdtTag = s => wval(kid(kid(s, 'sdtPr'), 'tag')) || '';
  const normWS = s => String(s || '').replace(/\s+/g, ' ').trim();
  // the template's own instruction text (same as the printed default): kept out of exam.instructions unless the teacher edits it
  const TPL_INSTR = normWS('Write your name in the box and your student ID in the grid, filling one bubble per digit. For multiple choice, completely fill the one bubble next to your answer with a dark pencil or pen. Erase changes cleanly. Write short answers inside the boxes. Work outside the boxes may not be graded. Keep all pages together and do not fold the pages.');
  const MAX_DIGITS = 12, ID_COL = 7.2;
  const twip = v => Math.round(v * 1440 / 25.4);
  function sdtText(s) {
    const pr = kid(s, 'sdtPr');
    if (kid(pr, 'showingPlcHdr')) return '';
    const content = kid(s, 'sdtContent');
    if (!content) return '';
    let out = '';
    const walk = (node, depth) => {
      for (const c of Array.from(node.childNodes)) {
        if (c.namespaceURI !== W) continue;
        const n = c.localName;
        if (n === 't') out += c.textContent;
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

  // Build the Word template for the counts the teacher picked. o = { mc, choices (4|5), sa, idDigits, school, course, teacher, title, date, version }
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
    const num = v => { const m = String(v).replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : null; };
    let cur = null;
    for (const { s, tag } of tagged) {
      if (tag === 'mcq' || tag === 'saq') continue;
      const v = sdtText(s);
      let m;
      if ((m = tag.match(/^hdr_(\w+)$/))) { if (v && !(m[1] === 'instructions' && normWS(v) === TPL_INSTR)) res.fields[m[1]] = v; continue; }
      if (tag === 'mc_stem') { cur = { type: 'mc', num: res.mc.length + 1, stem: v, raw: {}, keyLetter: '', points: null }; res.mc.push(cur); continue; }
      if (tag === 'sa_prompt') { cur = { type: 'sa', num: res.sa.length + 1, prompt: v, points: null, key: '', rubric: '', lines: null }; res.sa.push(cur); continue; }
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
    // unused (empty) blocks are skipped; everything typed is kept
    let emptyMC = 0, emptySA = 0;
    res.mc = res.mc.filter(q => { const any = q.stem || Object.values(q.raw).some(Boolean); if (!any) emptyMC++; return any; });
    res.sa = res.sa.filter(q => { const any = q.prompt || q.key || q.rubric; if (!any) emptySA++; return any; });
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

  // ---------------- import result -> exam fields ----------------
  function toExam(exam, imp) {
    const f = imp.fields || {};
    if (imp.title || f.title) exam.title = imp.title || f.title;
    if (f.school) exam.school = f.school;
    if (f.course) exam.course = f.course;
    if (f.teacher) exam.teacher = f.teacher;
    if (f.version) exam.version = f.version.slice(0, 4);
    if (f.instructions) exam.instructions = f.instructions;
    if (f.date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.date)) exam.date = f.date;
      else { const d = new Date(f.date); if (!isNaN(d)) exam.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    }
    exam.mc = imp.mc.map(q => {
      const choices = q.choices.slice(0, 5).map(c => String(c));
      while (choices.length < 2) choices.push('');
      return { id: U.uid('q_'), stem: q.stem || '', choices, answer: (q.correct !== null && q.correct !== undefined && q.correct < choices.length) ? LET[q.correct] : '', points: q.points || 1 };
    });
    exam.sa = imp.sa.map(q => ({
      id: U.uid('s_'), prompt: q.prompt || '', max: q.points || 5, lines: Math.max(1, Math.min(28, q.lines || 6)), comments: [],
      key: q.key || '', modelAnswer: q.key || '', rubric: q.rubric || ''
    }));
    return exam;
  }

  return { BOLD, CHUNK, MAX_IMG, docxToText, pdfExtract, readFiles, parse, chunkText, requestsFor, aiRead, toExam, finalize, LET, buildWordTemplate, parseTemplateDocx, TPL_BASE };
})();
