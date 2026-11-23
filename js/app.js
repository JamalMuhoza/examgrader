/* Exam Grader - application UI */
'use strict';

(() => {
  const { $, $$, el, uid, toast, esc } = U;
  const S = { settings: null, exams: [], exam: null, scans: [], students: [], view: 'exams', imgCache: new Map(), cam: null, session: { studentId: null } };
  const DEFAULT_SETTINGS = {
    school: '', course: '', teacher: '', idDigits: 7,
    omr: { ...CV.DEFAULT_TH }, blurMin: 12, cloudUrl: '', cloudToken: '', comments: ['Good work', 'Show your work', 'Check units', 'Incomplete answer', 'Sign error']
  };
  const VIEWS = [
    ['exams', 'Exams'], ['setup', 'Setup'], ['print', 'Print'], ['scan', 'Scan'], ['review', 'Review'],
    ['grade', 'Grade'], ['results', 'Results'], ['settings', 'Settings'], ['help', 'Help']
  ];

  // ---------------- boot ----------------
  async function boot() {
    S.settings = Object.assign({}, DEFAULT_SETTINGS, await DB.getKV('settings', {}));
    S.settings.omr = Object.assign({}, CV.DEFAULT_TH, S.settings.omr || {});
    S.settings.ai = Object.assign({}, AI.DEFAULTS, S.settings.ai || {});
    S.exams = (await DB.all('exams')).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const last = await DB.getKV('currentExam', null);
    if (last && S.exams.find(e => e.id === last)) await selectExam(last, false);
    buildNav();
    const hv = location.hash.replace('#', '');
    go(VIEWS.some(v => v[0] === hv) ? hv : (S.exam ? 'scan' : 'exams'));
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.__NO_SW) {
      navigator.serviceWorker.register('sw.js').catch(() => { });
    }
    Annot.ensureFont();
  }

  function buildNav() {
    const nav = $('#nav'); nav.innerHTML = '';
    VIEWS.forEach(([k, label]) => nav.appendChild(el('button', { class: 'navbtn', 'data-view': k, onclick: () => go(k) }, label)));
    const sel = $('#examPick'); sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, S.exams.length ? 'Select an exam' : 'No exams yet'));
    S.exams.forEach(e => sel.appendChild(el('option', { value: e.id, selected: S.exam && S.exam.id === e.id }, e.title || 'Untitled')));
    sel.onchange = async () => { if (sel.value) { await selectExam(sel.value); go(S.view === 'exams' ? 'setup' : S.view); } };
  }

  async function selectExam(id, render = true) {
    S.exam = await DB.get('exams', id);
    if (!S.exam) return;
    if (!S.exam.layout) { S.exam.layout = Layout.compute(S.exam); await saveExam(false); }
    S.scans = await DB.byExam('scans', id);
    S.students = await DB.byExam('students', id);
    S.session.studentId = null;
    S.imgCache.clear();
    await DB.setKV('currentExam', id);
    if (render) buildNav();
  }

  function go(view) {
    if (S.cam && view !== 'scan') stopCamera();
    if (AIR.running) AIR.stop = true;
    S.view = view;
    history.replaceState(null, '', '#' + view);
    $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const v = $('#view'); v.innerHTML = '';
    const needExam = !['exams', 'settings', 'help'].includes(view);
    if (needExam && !S.exam) {
      v.appendChild(el('div', { class: 'card' }, el('h2', {}, 'No exam selected'), el('p', {}, 'Create or open an exam first.'), el('button', { class: 'btn primary', onclick: () => go('exams') }, 'Go to Exams')));
      return;
    }
    const fn = { exams: viewExams, setup: viewSetup, print: viewPrint, scan: viewScan, review: viewReview, grade: viewGrade, results: viewResults, settings: viewSettings, help: viewHelp }[view];
    Promise.resolve(fn(v)).catch(err => { console.error(err); v.appendChild(el('div', { class: 'card warn' }, 'Error: ' + err.message)); });
  }

  // ---------------- data helpers ----------------
  function geomSig(L) {
    return U.fnv(JSON.stringify([L.pageCount, L.hash, L.mc.map(q => [q.page, q.choices.map(c => [c.x.toFixed(2), c.y.toFixed(2)])]), L.sa.map(s => [s.page, s.box]), L.cover.id.cols.length]));
  }
  async function saveExam(relayout = true) {
    const e = S.exam;
    e.updated = Date.now();
    if (relayout) e.layout = Layout.compute(e);
    e.layoutSig = geomSig(e.layout);
    await DB.put('exams', e);
    const i = S.exams.findIndex(x => x.id === e.id);
    if (i >= 0) S.exams[i] = e; else S.exams.unshift(e);
  }
  const saveSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(async () => { await saveExam(); markSaved(); }, 350); }; })();
  function markSaved() { const s = $('#saveState'); if (s) { s.textContent = 'Saved ' + new Date().toLocaleTimeString(); } }
  async function saveStudent(stu) { await DB.put('students', stu); }
  async function saveSettings() { await DB.setKV('settings', S.settings); }

  function newExam() {
    const st = S.settings;
    return {
      id: uid('ex_'), created: Date.now(), updated: Date.now(),
      school: st.school, course: st.course, teacher: st.teacher, title: 'New Exam', date: new Date().toISOString().slice(0, 10), version: 'A',
      idDigits: st.idDigits || 7, instructions: '', mc: [], sa: [], roster: [], comments: [...(st.comments || [])]
    };
  }
  function L() { return S.exam.layout; }
  function rosterOf() { return S.exam.roster || []; }
  function gradeOf(stu) { return Grade.compute(S.exam, L(), stu, S.scans, rosterOf()); }
  async function imgOf(scan) {
    if (!scan || !scan.blob) return null;
    if (S.imgCache.has(scan.id)) return S.imgCache.get(scan.id);
    const im = await U.blobToImage(scan.blob);
    S.imgCache.set(scan.id, im);
    if (S.imgCache.size > 60) S.imgCache.delete(S.imgCache.keys().next().value);
    return im;
  }

  // ---------------- Exams list ----------------
  function viewExams(v) {
    v.appendChild(el('div', { class: 'row between' },
      el('h2', {}, 'Exams'),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', id: 'btnNewExam', onclick: async () => { S.exam = newExam(); S.exam.layout = Layout.compute(S.exam); await saveExam(false); await selectExam(S.exam.id); go('setup'); } }, 'New exam'),
        el('label', { class: 'btn' }, 'Import backup', el('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: e => importBackup(e.target.files[0]) })))));
    if (!S.exams.length) v.appendChild(el('div', { class: 'card' }, el('p', {}, 'No exams yet. Use "New exam" to start, or import a backup file.')));
    S.exams.forEach(e => {
      const nMC = (e.mc || []).length, nSA = (e.sa || []).length;
      v.appendChild(el('div', { class: 'card examcard' + (S.exam && S.exam.id === e.id ? ' current' : '') },
        el('div', {},
          el('div', { class: 'title' }, e.title || 'Untitled'),
          el('div', { class: 'muted' }, [e.school, e.course, e.date, e.version ? 'Version ' + e.version : ''].filter(Boolean).join(' | ')),
          el('div', { class: 'muted small' }, `${nMC} multiple choice, ${nSA} written, ${e.layout ? e.layout.pageCount : '?'} pages`)),
        el('div', { class: 'row wrap' },
          el('button', { class: 'btn primary', onclick: async () => { await selectExam(e.id); go('setup'); } }, 'Open'),
          el('button', { class: 'btn', onclick: () => duplicateExam(e) }, 'Duplicate'),
          el('button', { class: 'btn danger', onclick: () => deleteExam(e) }, 'Delete'))));
    });
  }
  async function duplicateExam(e) {
    const c = JSON.parse(JSON.stringify(e));
    c.id = uid('ex_'); c.title = (e.title || 'Exam') + ' (copy)'; c.created = c.updated = Date.now();
    c.mc.forEach(q => q.id = uid('q_')); c.sa.forEach(q => q.id = uid('s_'));
    S.exam = c; await saveExam(); S.exam = null; await selectExam(c.id); buildNav(); go('exams');
  }
  async function deleteExam(e) {
    if (!confirm(`Delete the exam "${e.title}" with all of its scans and grades? This cannot be undone. Export a backup first if needed.`)) return;
    await DB.deleteExam(e.id);
    S.exams = S.exams.filter(x => x.id !== e.id);
    if (S.exam && S.exam.id === e.id) { S.exam = null; S.scans = []; S.students = []; }
    buildNav(); go('exams'); toast('Exam deleted');
  }

  // ---------------- Setup ----------------
  function field(label, input, hint) {
    return el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', { class: 'muted' }, hint) : null);
  }
  function inp(obj, key, attrs = {}, after) {
    const i = el(attrs.multiline ? 'textarea' : 'input', { ...attrs, multiline: null });
    i.value = obj[key] ?? '';
    i.addEventListener('input', () => { obj[key] = attrs.type === 'number' ? (i.value === '' ? '' : +i.value) : i.value; saveSoon(); if (after) after(); });
    return i;
  }

  function viewSetup(v) {
    const e = S.exam;
    const changed = S.scans.length && e.printedSig && e.printedSig !== geomSig(e.layout);
    v.appendChild(el('div', { class: 'row between' }, el('h2', {}, 'Exam setup'), el('span', { id: 'saveState', class: 'muted small' }, 'Changes save automatically')));
    if (changed) v.appendChild(el('div', { class: 'card warn' }, 'The layout changed after this exam was printed and scanned. Bubbles may have moved. Reprint, or use "Re-read all scans" on the Scan screen only if the printed papers match the new layout.'));
    const meta = el('div', { class: 'card grid2' },
      field('School / institution', inp(e, 'school', { id: 'f_school' })),
      field('Course', inp(e, 'course', { id: 'f_course' })),
      field('Teacher', inp(e, 'teacher', { id: 'f_teacher' })),
      field('Exam title', inp(e, 'title', { id: 'f_title' }, () => buildNavSoon())),
      field('Date', inp(e, 'date', { id: 'f_date', type: 'date' })),
      field('Version', inp(e, 'version', { id: 'f_version', maxlength: 4 })),
      field('Student ID digits', inp(e, 'idDigits', { id: 'f_digits', type: 'number', min: 1, max: 12 }), 'Each digit is a column of bubbles 0-9'),
      field('Cover instructions (optional)', inp(e, 'instructions', { id: 'f_instr', multiline: true, rows: 3, placeholder: 'Leave empty for standard instructions' })));
    v.appendChild(meta);

    // multiple choice
    const mcBox = el('div', { class: 'card' });
    v.appendChild(mcBox);
    const renderMC = () => {
      mcBox.innerHTML = '';
      const pts = e.mc.reduce((a, q) => a + (+q.points || 0), 0);
      mcBox.appendChild(el('div', { class: 'row between' }, el('h3', {}, `Multiple choice (${e.mc.length} questions, ${U.fmt(pts)} points)`),
        el('div', { class: 'row wrap' },
          el('button', { class: 'btn', id: 'btnAddMC', onclick: () => { e.mc.push({ id: uid('q_'), stem: '', choices: ['', '', '', ''], answer: '', points: 1 }); saveSoon(); renderMC(); } }, 'Add question'),
          el('button', { class: 'btn', onclick: () => bulk.classList.toggle('hidden') }, 'Bulk paste'))));
      const bulk = el('div', { class: 'bulk hidden', id: 'bulkBox' },
        el('p', { class: 'small muted' }, 'Paste questions. Start each question with its number ("1." or "1)"), each choice with a letter ("A." or "B)"). Put * before the correct choice. Optional answer key string (for example ABDCE...) overrides the stars.'),
        el('textarea', { id: 'bulkText', rows: 10, placeholder: '1. Which element has the highest electronegativity?\nA. Oxygen\n*B. Fluorine\nC. Chlorine\nD. Nitrogen' }),
        el('div', { class: 'row wrap' },
          el('input', { id: 'bulkKey', placeholder: 'Answer key string, e.g. ABDCE (optional)' }),
          el('label', { class: 'small' }, el('input', { type: 'checkbox', id: 'bulkReplace' }), ' Replace existing questions'),
          el('button', { class: 'btn primary', id: 'btnBulkAdd', onclick: () => {
            const qs = parseBulk($('#bulkText').value, $('#bulkKey').value);
            if (!qs.length) { toast('No questions recognised', 'bad'); return; }
            if ($('#bulkReplace').checked) e.mc = qs; else e.mc.push(...qs);
            saveSoon(); renderMC(); toast(qs.length + ' questions added');
          } }, 'Add questions')),
        el('div', { class: 'row wrap' },
          el('input', { id: 'keyOnly', placeholder: 'Apply key string to existing questions, e.g. ABDCEA...' }),
          el('button', { class: 'btn', id: 'btnApplyKey', onclick: () => {
            const k = $('#keyOnly').value.toUpperCase().replace(/[^A-E]/g, '');
            k.split('').forEach((c, i) => { if (e.mc[i]) e.mc[i].answer = c; });
            saveSoon(); renderMC(); toast('Key applied to ' + Math.min(k.length, e.mc.length) + ' questions');
          } }, 'Apply key')));
      mcBox.appendChild(bulk);
      e.mc.forEach((q, i) => mcBox.appendChild(mcRow(q, i, renderMC)));
    };
    renderMC();

    // short answers
    const saBox = el('div', { class: 'card' });
    v.appendChild(saBox);
    const renderSA = () => {
      saBox.innerHTML = '';
      saBox.appendChild(el('div', { class: 'row between' }, el('h3', {}, `Written response (${e.sa.length})`),
        el('button', { class: 'btn', id: 'btnAddSA', onclick: () => { e.sa.push({ id: uid('s_'), prompt: '', max: 5, lines: 6, comments: [], key: '', modelAnswer: '', rubric: '' }); saveSoon(); renderSA(); } }, 'Add written question')));
      e.sa.forEach((q, i) => {
        saBox.appendChild(el('div', { class: 'qrow' },
          el('div', { class: 'qnum' }, 'SA' + (i + 1)),
          el('div', { class: 'qbody' },
            field('Prompt', inp(q, 'prompt', { multiline: true, rows: 2, class: 'sa-prompt' })),
            el('div', { class: 'row wrap' },
              field('Max points', inp(q, 'max', { type: 'number', min: 0, step: 0.5, class: 'sa-max narrow' })),
              field('Box height (lines)', inp(q, 'lines', { type: 'number', min: 1, max: 28, class: 'sa-lines narrow' })),
              field('Preset comments (comma separated)', (() => { const t = el('input', { class: 'sa-comments' }); t.value = (q.comments || []).join(', '); t.oninput = () => { q.comments = t.value.split(',').map(s => s.trim()).filter(Boolean); saveSoon(); }; return t; })()),
              field('Answer key note (key PDF only)', inp(q, 'key', { class: 'sa-key' }))),
            el('div', { class: 'grid2' },
              field('Answer key / model answer', inp(q, 'modelAnswer', { multiline: true, rows: 3, class: 'sa-model', placeholder: 'What a full-credit answer contains' }), 'Used by AI suggestions'),
              field('Rubric', inp(q, 'rubric', { multiline: true, rows: 3, class: 'sa-rubric', placeholder: '2 pts correct product; 1 pt balanced; 1 pt units' }), 'Points per element, one per line or separated by ;'))),
          el('div', { class: 'qtools' },
            el('button', { class: 'btn small', title: 'Move up', onclick: () => { if (i) { [e.sa[i - 1], e.sa[i]] = [e.sa[i], e.sa[i - 1]]; saveSoon(); renderSA(); } } }, 'Up'),
            el('button', { class: 'btn small danger', onclick: () => { if (confirm('Remove this question?')) { e.sa.splice(i, 1); saveSoon(); renderSA(); } } }, 'Remove'))));
      });
    };
    renderSA();

    // roster
    const ro = el('textarea', { id: 'rosterText', rows: 5, placeholder: 'ID,Name\n1234567,Jane Doe' });
    ro.value = (e.roster || []).map(r => `${r.id},${r.name}`).join('\n');
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Roster (optional)'),
      el('p', { class: 'small muted' }, 'Paste ID,Name lines (CSV). Scanned IDs are matched to names.'), ro,
      el('div', { class: 'row' }, el('button', { class: 'btn', id: 'btnSaveRoster', onclick: async () => { e.roster = Grade.parseRoster(ro.value); await saveExam(false); toast(e.roster.length + ' roster entries saved'); } }, 'Save roster'))));
    v.appendChild(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { await saveExam(); go('print'); } }, 'Continue to Print')));
  }
  const buildNavSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(buildNav, 600); }; })();

  function mcRow(q, i, rerender) {
    const e = S.exam;
    const choicesBox = el('div', { class: 'choices' });
    const ansSel = el('select', { class: 'mc-answer' });
    const nSel = el('select', { class: 'mc-n' }, [2, 3, 4, 5].map(n => el('option', { value: n, selected: q.choices.length === n }, n + ' choices')));
    const drawChoices = () => {
      choicesBox.innerHTML = '';
      q.choices.forEach((c, k) => {
        const t = el('input', { class: 'mc-choice', placeholder: 'Choice ' + Layout.LETTERS[k] });
        t.value = c; t.oninput = () => { q.choices[k] = t.value; saveSoon(); };
        choicesBox.appendChild(el('div', { class: 'choice' }, el('span', { class: 'bub' }, Layout.LETTERS[k]), t));
      });
      ansSel.innerHTML = '';
      ansSel.appendChild(el('option', { value: '' }, 'Key?'));
      q.choices.forEach((c, k) => ansSel.appendChild(el('option', { value: Layout.LETTERS[k], selected: q.answer === Layout.LETTERS[k] }, Layout.LETTERS[k])));
    };
    nSel.onchange = () => { const n = +nSel.value; while (q.choices.length < n) q.choices.push(''); q.choices.length = n; if (q.answer && Layout.LETTERS.indexOf(q.answer) >= n) q.answer = ''; drawChoices(); saveSoon(); };
    ansSel.onchange = () => { q.answer = ansSel.value; saveSoon(); };
    drawChoices();
    return el('div', { class: 'qrow mcrow', 'data-i': i },
      el('div', { class: 'qnum' }, (i + 1) + '.'),
      el('div', { class: 'qbody' },
        inp(q, 'stem', { multiline: true, rows: 2, class: 'mc-stem', placeholder: 'Question text (optional)' }),
        choicesBox,
        el('div', { class: 'row wrap' }, nSel, field('Correct', ansSel), field('Points', inp(q, 'points', { type: 'number', min: 0, step: 0.5, class: 'narrow mc-points' })))),
      el('div', { class: 'qtools' },
        el('button', { class: 'btn small', onclick: () => { if (i) { [e.mc[i - 1], e.mc[i]] = [e.mc[i], e.mc[i - 1]]; saveSoon(); rerender(); } } }, 'Up'),
        el('button', { class: 'btn small', onclick: () => { if (i < e.mc.length - 1) { [e.mc[i + 1], e.mc[i]] = [e.mc[i], e.mc[i + 1]]; saveSoon(); rerender(); } } }, 'Down'),
        el('button', { class: 'btn small danger', onclick: () => { if (confirm('Remove question ' + (i + 1) + '?')) { e.mc.splice(i, 1); saveSoon(); rerender(); } } }, 'Remove')));
  }

  function parseBulk(text, keyStr) {
    const qs = []; let cur = null, lastChoice = -1;
    String(text || '').replace(/\r/g, '').split('\n').forEach(line => {
      const t = line.trim();
      let m;
      if ((m = t.match(/^(\d+)\s*[.)]\s*(.*)$/))) {
        cur = { id: uid('q_'), stem: m[2], choices: [], answer: '', points: 1 }; qs.push(cur); lastChoice = -1;
      } else if (cur && (m = t.match(/^(\*?)\s*\(?([A-Ea-e])[.)]\s*(.*)$/)) && cur.choices.length < 5 && 'ABCDE'.indexOf(m[2].toUpperCase()) === cur.choices.length) {
        cur.choices.push(m[3].replace(/\s*\*$/, '')); lastChoice = cur.choices.length - 1;
        if (m[1] === '*' || /\s\*$/.test(m[3])) cur.answer = Layout.LETTERS[lastChoice];
      } else if (cur && t) {
        if (lastChoice >= 0) cur.choices[lastChoice] += ' ' + t; else cur.stem += (cur.stem ? '\n' : '') + t;
      }
    });
    qs.forEach(q => { while (q.choices.length < 2) q.choices.push(''); });
    const k = String(keyStr || '').toUpperCase().replace(/[^A-E]/g, '');
    k.split('').forEach((c, i) => { if (qs[i]) qs[i].answer = c; });
    return qs;
  }

  // ---------------- Print ----------------
  async function viewPrint(v) {
    const e = S.exam;
    await saveExam();
    const lay = L();
    const pf = lay.preflight;
    v.appendChild(el('h2', {}, 'Print template'));
    const missingKey = e.mc.filter(q => !q.answer).length;
    v.appendChild(el('div', { class: 'card ' + (pf.ok ? 'ok' : 'warn'), id: 'preflight' },
      el('h3', {}, pf.ok ? 'Preflight passed' : 'Preflight found problems'),
      el('p', {}, `${lay.pageCount} pages (cover, ${new Set(lay.mc.map(q => q.page)).size} multiple-choice page(s), ${new Set(lay.sa.map(q => q.page)).size} written page(s)). ${pf.bubbles} bubbles checked; all bubbles and boxes inside the safe area: ${pf.problems ? 'no' : 'yes'}.`),
      missingKey ? el('p', { class: 'warntext' }, `${missingKey} multiple-choice question(s) have no correct answer set.`) : null,
      pf.messages.length ? el('ul', {}, pf.messages.slice(0, 20).map(m => el('li', {}, m))) : null,
      el('p', { class: 'small muted' }, 'Print at 100% / "Actual size" on US Letter paper. Do not use "Fit to page" if your printer offers it; small scaling is tolerated.')));
    v.appendChild(el('div', { class: 'row wrap' },
      el('button', { class: 'btn primary', id: 'btnTemplatePdf', onclick: async () => {
        const doc = Layout.buildPDF(e, lay, {});
        e.printedSig = geomSig(lay); await saveExam(false);
        U.download(doc.output('blob'), U.safeName(e.title) + ' - exam.pdf');
      } }, 'Download exam PDF'),
      el('button', { class: 'btn', id: 'btnKeyPdf', onclick: () => { const doc = Layout.buildPDF(e, lay, { key: true }); U.download(doc.output('blob'), U.safeName(e.title) + ' - answer key.pdf'); } }, 'Download answer key PDF'),
      el('button', { class: 'btn', id: 'btnLayoutJson', onclick: () => U.download(new Blob([JSON.stringify({ exam: e.id, layout: lay }, null, 1)], { type: 'application/json' }), U.safeName(e.title) + ' - layout.json') }, 'Download layout manifest')));
    const prev = el('div', { class: 'thumbs', id: 'printPreview' }, el('p', { class: 'muted' }, 'Rendering preview...'));
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Preview'), prev));
    try {
      const doc = Layout.buildPDF(e, lay, {});
      const pdf = await pdfjsLib.getDocument({ data: doc.output('arraybuffer') }).promise;
      prev.innerHTML = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale: 0.55 });
        const c = CV.canvasOf(Math.round(vp.width), Math.round(vp.height));
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        prev.appendChild(el('figure', { class: 'thumb' }, c, el('figcaption', {}, 'Page ' + p)));
      }
    } catch (err) { prev.innerHTML = ''; prev.appendChild(el('p', { class: 'warntext' }, 'Preview unavailable: ' + err.message)); }
  }

  // ---------------- Scan ----------------
  function viewScan(v) {
    const lay = L();
    v.appendChild(el('div', { class: 'row between' }, el('h2', {}, 'Scan pages'), el('span', { class: 'muted small' }, `${lay.pageCount} pages per student`)));
    const camCard = el('div', { class: 'card' },
      el('h3', {}, 'Camera'),
      el('div', { class: 'camwrap hidden', id: 'camWrap' },
        el('video', { id: 'camVideo', playsinline: true, muted: true, autoplay: true }),
        el('canvas', { id: 'camOverlay' })),
      el('div', { class: 'camstatus', id: 'camStatus' }, 'Hold the page flat so all four black corner squares are visible.'),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnCam', onclick: () => S.cam ? stopCamera() : startCamera() }, 'Start camera'),
        el('button', { class: 'btn', id: 'btnCapture', disabled: true, onclick: () => captureNow(true) }, 'Capture now'),
        el('label', { class: 'small' }, el('input', { type: 'checkbox', id: 'autoCap', checked: true }), ' Auto-capture'),
        el('button', { class: 'btn', id: 'btnNextStudent', onclick: () => { S.session.studentId = null; updateCamStatus('Next page should be a cover (new student).'); } }, 'Next student')),
      el('div', { class: 'lastcap', id: 'lastCap' }));
    const upCard = el('div', { class: 'card' },
      el('h3', {}, 'Upload scans'),
      el('p', { class: 'small muted' }, 'PDF files from a scanner or photos of pages. Each file may hold one student or a whole class; a cover page starts a new student.'),
      el('label', { class: 'btn' }, 'Choose PDF or image files', el('input', { type: 'file', id: 'fileInput', multiple: true, accept: 'application/pdf,image/*', class: 'hidden', onchange: ev => { ingestFiles(Array.from(ev.target.files)).catch(err => { console.error(err); const pr = $('#progress'); if (pr) pr.textContent = 'Error: ' + err.message; toast('Error: ' + err.message, 'bad'); }); ev.target.value = ''; } })),
      el('div', { id: 'progress', class: 'small muted' }));
    v.appendChild(el('div', { class: 'grid2 top' }, camCard, upCard));
    const tools = el('div', { class: 'row wrap' },
      el('button', { class: 'btn', id: 'btnReread', onclick: rereadAll }, 'Re-read all scans'),
      el('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete all scans and grades for this exam?')) return;
        for (const s of S.scans) await DB.del('scans', s.id);
        for (const s of S.students) await DB.del('students', s.id);
        S.scans = []; S.students = []; go('scan');
      } }, 'Delete all scans'));
    v.appendChild(tools);
    v.appendChild(el('div', { id: 'groups' }));
    renderGroups();
  }

  function renderGroups() {
    const box = $('#groups'); if (!box) return;
    box.innerHTML = '';
    const lay = L();
    const warnings = [];
    const studs = S.students.slice().sort((a, b) => a.key - b.key);
    const ids = {};
    studs.forEach(stu => { const g = gradeOf(stu); if (g.id) (ids[g.id] = ids[g.id] || []).push(stu); });
    Object.entries(ids).forEach(([id, arr]) => { if (arr.length > 1 && !/\?/.test(id)) warnings.push(`Student ID ${id} appears ${arr.length} times.`); });
    const unassigned = S.scans.filter(s => !s.studentId);
    box.appendChild(el('div', { class: 'row between' }, el('h3', {}, `Students (${studs.length}) and pages (${S.scans.length})`)));
    const summary = el('div', { class: 'card', id: 'scanSummary' });
    box.appendChild(summary);
    studs.forEach((stu, idx) => {
      const g = gradeOf(stu);
      const P = Grade.pagesOf(stu, S.scans);
      if (g.missing.length) warnings.push(`Student ${idx + 1} (${g.id || 'no ID'}): missing page ${g.missing.join(', ')}.`);
      if (P.dups.length) warnings.push(`Student ${idx + 1} (${g.id || 'no ID'}): duplicate page ${P.dups.map(d => d.page).join(', ')}.`);
      if (!g.idOk) warnings.push(`Student ${idx + 1}: ID needs checking (${g.id || 'unread'}).`);
      if (g.id && rosterOf().length && !g.inRoster) warnings.push(`Student ${idx + 1}: ID ${g.id} not in roster.`);
      const cover = P.pages[1];
      const idIn = el('input', { class: 'idfix narrow', value: g.id, title: 'Student ID (edit to correct)' });
      idIn.onchange = async () => { stu.idOverride = idIn.value.trim(); await saveStudent(stu); renderGroups(); };
      const card = el('div', { class: 'card stucard', 'data-stu': stu.id },
        el('div', { class: 'row between wrap' },
          el('div', { class: 'row wrap' },
            el('strong', {}, `Student ${idx + 1}`),
            cover && cover.nameCrop ? el('img', { class: 'namecrop', src: cover.nameCrop, alt: 'Handwritten name' }) : el('span', { class: 'muted small' }, 'no cover'),
            field('ID', idIn),
            el('span', { class: 'muted' }, g.name || ''),
            g.idOk ? null : el('span', { class: 'badge bad' }, 'ID?')),
          el('div', { class: 'row' },
            el('button', { class: 'btn small', onclick: () => { S.session.studentId = stu.id; toast('Camera will add pages to student ' + (idx + 1)); } }, 'Scan into'),
            el('button', { class: 'btn small danger', onclick: () => removeStudent(stu) }, 'Remove'))),
        el('div', { class: 'pagestrip' }, P.all.map(s => pageChip(s, P, studs))));
      card.addEventListener('dragover', ev => { ev.preventDefault(); card.classList.add('drop'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop'));
      card.addEventListener('drop', async ev => { ev.preventDefault(); card.classList.remove('drop'); const id = ev.dataTransfer.getData('text/plain'); const sc = S.scans.find(s => s.id === id); if (sc) { sc.studentId = stu.id; await DB.put('scans', sc); renderGroups(); } });
      box.appendChild(card);
    });
    if (unassigned.length) {
      box.appendChild(el('div', { class: 'card warn' }, el('h3', {}, `Unassigned pages (${unassigned.length})`),
        el('div', { class: 'pagestrip' }, unassigned.map(s => pageChip(s, null, studs)))));
      warnings.push(`${unassigned.length} page(s) are not assigned to a student.`);
    }
    S.scans.forEach(s => (s.warnings || []).forEach(w => warnings.push(`Scan ${s.seq + 1} of batch ${s.batchSeq + 1}: ${w}`)));
    summary.appendChild(el('div', {}, `${studs.length} students, ${S.scans.length} pages, ${warnings.length} warning(s).`));
    if (warnings.length) summary.appendChild(el('ul', { class: 'warnlist' }, warnings.slice(0, 60).map(w => el('li', {}, w))));
    summary.classList.toggle('warn', warnings.length > 0);
  }

  function pageChip(s, P, studs) {
    const lay = L();
    const isDup = P && P.dups.includes(s);
    const pageSel = el('select', { class: 'pagesel', title: 'Page number' },
      el('option', { value: '' }, 'p?'), Array.from({ length: lay.pageCount }, (_, i) => el('option', { value: i + 1, selected: s.page === i + 1 }, 'p' + (i + 1))));
    pageSel.onchange = async () => { s.page = pageSel.value ? +pageSel.value : null; s.pageManual = true; await reanalyze(s); await DB.put('scans', s); renderGroups(); };
    const stuSel = el('select', { class: 'stusel', title: 'Move to student' },
      el('option', { value: '' }, 'Move to...'),
      studs.map((st, i) => el('option', { value: st.id, selected: st.id === s.studentId }, 'Student ' + (i + 1))),
      el('option', { value: '__new' }, 'New student'));
    stuSel.onchange = async () => {
      let id = stuSel.value;
      if (id === '__new') { const st = Grade.newStudent(S.exam.id, nextKey()); S.students.push(st); await saveStudent(st); id = st.id; }
      s.studentId = id || null; await DB.put('scans', s); renderGroups();
    };
    const cls = 'pagechip' + (isDup ? ' dup' : '') + (!s.page ? ' unknown' : '') + ((s.warnings || []).length ? ' warnchip' : '');
    const chip = el('div', { class: cls, draggable: 'true', 'data-scan': s.id, 'data-page': s.page || '' },
      s.thumb ? el('img', { src: s.thumb, alt: 'page', onclick: () => showScan(s) }) : el('div', { class: 'nothumb' }, 'no image'),
      el('div', { class: 'row tight' }, pageSel, isDup ? el('span', { class: 'badge bad' }, 'dup') : null),
      stuSel,
      el('button', { class: 'linkbtn', onclick: async () => { if (confirm('Delete this scanned page?')) { await DB.del('scans', s.id); S.scans = S.scans.filter(x => x !== s); renderGroups(); } } }, 'delete'));
    chip.addEventListener('dragstart', ev => ev.dataTransfer.setData('text/plain', s.id));
    return chip;
  }

  async function showScan(s) {
    const im = await imgOf(s);
    const dlg = el('div', { class: 'modal', onclick: ev => { if (ev.target === dlg) dlg.remove(); } },
      el('div', { class: 'modalbox' },
        el('div', { class: 'row between' }, el('strong', {}, `Page ${s.page || '?'}${(s.warnings || []).length ? ' - ' + s.warnings.join('; ') : ''}`), el('button', { class: 'btn small', onclick: () => dlg.remove() }, 'Close')),
        im ? (() => { const c = CV.canvasOf(im.width, im.height); c.getContext('2d').drawImage(im, 0, 0); c.className = 'fullimg'; return c; })() : el('p', {}, 'No image')));
    document.body.appendChild(dlg);
  }

  async function removeStudent(stu) {
    if (!confirm('Remove this student? Their pages become unassigned.')) return;
    S.scans.filter(s => s.studentId === stu.id).forEach(s => { s.studentId = null; });
    await DB.putMany('scans', S.scans.filter(s => !s.studentId));
    await DB.del('students', stu.id);
    S.students = S.students.filter(s => s !== stu);
    renderGroups();
  }
  function nextKey() { return S.students.reduce((m, s) => Math.max(m, s.key || 0), 0) + 1; }
  function nextBatch() { return S.scans.reduce((m, s) => Math.max(m, s.batchSeq ?? -1), -1) + 1; }

  // decode a page source -> scan record (not yet saved)
  async function makeScan(src, w, h, batchSeq, seq, origin) {
    const lay = L();
    const res = CV.processSource(src, w, h);
    const scan = { id: uid('sc_'), examId: S.exam.id, batchSeq, seq, origin, created: Date.now(), studentId: null, warnings: [] };
    if (!res.ok) {
      const sc = Math.min(1, 1275 / Math.max(w, h));
      const c = CV.canvasOf(Math.round(w * sc), Math.round(h * sc)); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      scan.blob = await U.canvasToBlob(c, 'image/jpeg', 0.8);
      scan.thumb = thumbOf(c);
      scan.ok = false; scan.page = null; scan.warnings.push(res.reason + ' - rescan this page');
      return scan;
    }
    const c = CV.canvasOf(Layout.RW, Layout.RH);
    c.getContext('2d').putImageData(res.rect, 0, 0);
    scan.ok = true;
    scan.blob = await U.canvasToBlob(c, 'image/jpeg', 0.88);
    scan.thumb = thumbOf(c);
    scan.quality = res.quality;
    scan.page = res.page;
    scan.hash = res.hash;
    scan.codeBits = res.code.bits.join('');
    if (!res.page) scan.warnings.push('Page code unreadable - set the page number');
    else if (res.hash !== lay.hash) { scan.warnings.push('Page belongs to a different exam or version'); scan.foreign = true; }
    else if (res.page > lay.pageCount) scan.warnings.push('Page number beyond this exam');
    if (res.quality.blur < S.settings.blurMin) scan.warnings.push('Image looks blurry');
    if (res.quality.pxPerMm < 2.6) scan.warnings.push('Low resolution capture');
    if (res.quality.contrast < 60) scan.warnings.push('Low contrast / poor lighting');
    if (scan.page) analyzeInto(scan, res.rg, c);
    return scan;
  }
  function thumbOf(c) {
    const t = CV.canvasOf(150, Math.round(150 * c.height / c.width));
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  }
  function analyzeInto(scan, rg, canvas) {
    const lay = L();
    const a = CV.analyzePage(rg, lay, scan.page, S.settings.omr);
    scan.omr = a.mc; scan.idRead = a.id; scan.black = a.black;
    if (scan.page === 1 && canvas) {
      const n = lay.cover.name, PX = Layout.PX;
      const x = (n.x - 2) * PX, y = (n.y - 6) * PX, w = (n.w + 4) * PX, h = (n.h + 8) * PX;
      const cc = CV.canvasOf(Math.round(w * 0.6), Math.round(h * 0.6));
      cc.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, cc.width, cc.height);
      scan.nameCrop = cc.toDataURL('image/jpeg', 0.8);
    }
  }
  async function reanalyze(scan) {
    if (!scan.ok || !scan.page) { scan.omr = null; scan.idRead = null; return; }
    const im = await imgOf(scan);
    const c = CV.canvasOf(Layout.RW, Layout.RH); const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    analyzeInto(scan, CV.grayOf(ctx.getImageData(0, 0, c.width, c.height)), c);
  }
  async function rereadAll() {
    const p = $('#progress');
    for (let i = 0; i < S.scans.length; i++) {
      if (p) p.textContent = `Re-reading ${i + 1} / ${S.scans.length}`;
      await reanalyze(S.scans[i]); await DB.put('scans', S.scans[i]);
      await U.sleep(0);
    }
    if (p) p.textContent = 'Re-read complete';
    renderGroups(); toast('All scans re-read');
  }

  async function ingestFiles(files) {
    const p = $('#progress');
    let total = 0;
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const images = files.filter(f => !pdfs.includes(f));
    const groups = pdfs.map(f => [f]);
    if (images.length) groups.push(images);   // photos chosen together are one scan session, in selection order
    for (const grp of groups) {
      const batchSeq = nextBatch();
      const batch = [];
      for (const f of grp) {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          if (p) p.textContent = `${f.name}: page ${i} / ${pdf.numPages}`;
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(200 / 72, 2600 / Math.max(base.width, base.height));
          const vp = page.getViewport({ scale });
          const c = CV.canvasOf(Math.round(vp.width), Math.round(vp.height));
          const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          batch.push(await makeScan(c, c.width, c.height, batchSeq, i - 1, f.name + ' p' + i));
          page.cleanup();
          await U.sleep(0);
        }
        pdf.destroy();
      } else {
        if (p) p.textContent = `${f.name}`;
        const bm = await U.blobToImage(f);
        batch.push(await makeScan(bm, bm.width, bm.height, batchSeq, batch.length, f.name));
        if (bm.close) bm.close();
      }
      }
      await commitBatch(batch, true);
      total += batch.length;
    }
    if (p) p.textContent = `Processed ${total} page(s).`;
    toast(`Processed ${total} page(s)`);
    renderGroups();
  }

  async function commitBatch(batch, fileMode) {
    const good = batch.filter(s => s.ok && s.page && !s.foreign);
    const last = S.students.slice().sort((a, b) => b.key - a.key)[0];
    const created = Grade.group(good, S.students, fileMode ? (last && last.id) : (S.session.studentId || (last && last.id)), S.exam.id, nextKey());
    for (const st of created) { S.students.push(st); await saveStudent(st); }
    for (const s of batch) { S.scans.push(s); await DB.put('scans', s); }
    return created;
  }

  // ---------------- camera ----------------
  async function startCamera() {
    const st = $('#camStatus');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      const video = $('#camVideo');
      video.srcObject = stream;
      await video.play().catch(() => { });
      $('#camWrap').classList.remove('hidden');
      $('#btnCam').textContent = 'Stop camera';
      $('#btnCapture').disabled = false;
      S.cam = { stream, video, stableSince: 0, lastPts: null, armed: true, busy: false, count: 0, timer: null };
      S.cam.timer = setInterval(camTick, 140);
      updateCamStatus('Looking for the four corner squares...');
    } catch (err) {
      st.textContent = 'Camera unavailable: ' + err.message + '. Use HTTPS (or localhost) and allow camera access, or upload images instead.';
    }
  }
  function stopCamera() {
    if (!S.cam) return;
    clearInterval(S.cam.timer);
    S.cam.stream.getTracks().forEach(t => t.stop());
    S.cam = null;
    const w = $('#camWrap'); if (w) w.classList.add('hidden');
    const b = $('#btnCam'); if (b) b.textContent = 'Start camera';
    const c = $('#btnCapture'); if (c) c.disabled = true;
  }
  function updateCamStatus(msg) {
    const st = $('#camStatus'); if (!st) return;
    const lay = L();
    const stu = S.students.find(s => s.id === S.session.studentId);
    let prog = '';
    if (stu) {
      const P = Grade.pagesOf(stu, S.scans);
      const idx = S.students.slice().sort((a, b) => a.key - b.key).indexOf(stu) + 1;
      prog = `Student ${String(idx).padStart(2, '0')} / ${S.students.length} - ${Object.keys(P.pages).length} of ${lay.pageCount} pages. `;
    }
    st.textContent = prog + msg + (S.cam ? `  Captured this session: ${S.cam.count}` : '');
  }
  function camTick() {
    const cam = S.cam; if (!cam || cam.busy) return;
    const v = cam.video; if (!v.videoWidth) return;
    const ov = $('#camOverlay'); if (!ov) return;
    ov.width = v.videoWidth; ov.height = v.videoHeight;
    const ctx = ov.getContext('2d'); ctx.clearRect(0, 0, ov.width, ov.height);
    const d = CV.quickDetect(v, v.videoWidth, v.videoHeight, 640);
    const now = performance.now();
    if (!d.found) {
      cam.stableSince = 0; cam.lastPts = null;
      if (!cam.armed) { cam.armed = true; }
      updateCamStatus('Looking for the four corner squares...');
      return;
    }
    const pts = d.pts;
    let moved = Infinity;
    if (cam.lastPts) moved = Math.max(...pts.map((p, i) => Math.hypot(p.x - cam.lastPts[i].x, p.y - cam.lastPts[i].y)));
    const tol = Math.max(6, d.side * 0.35);
    if (moved > tol) cam.stableSince = now;
    cam.lastPts = pts;
    const stableMs = now - cam.stableSince;
    if (cam.armedFor && cam.lastCapPts) {
      // re-arm after the page moved away noticeably from the last capture
      const dd = Math.max(...pts.map((p, i) => Math.hypot(p.x - cam.lastCapPts[i].x, p.y - cam.lastCapPts[i].y)));
      if (dd > d.side * 2) cam.armed = true;
    }
    const ready = stableMs > 800;
    ctx.lineWidth = Math.max(3, ov.width / 220);
    ctx.strokeStyle = ready && cam.armed ? '#1fa463' : '#f0a020';
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
    pts.forEach(p => { ctx.strokeRect(p.x - d.side / 2, p.y - d.side / 2, d.side, d.side); });
    if (!cam.armed) { updateCamStatus('Captured. Turn to the next page.'); return; }
    updateCamStatus(ready ? 'Capturing...' : 'Hold still...');
    if (ready && $('#autoCap') && $('#autoCap').checked) captureNow(false);
  }
  async function captureNow(manual) {
    const cam = S.cam; if (!cam || cam.busy) return;
    cam.busy = true;
    try {
      const v = cam.video;
      const c = CV.canvasOf(v.videoWidth, v.videoHeight);
      c.getContext('2d').drawImage(v, 0, 0);
      const scan = await makeScan(c, c.width, c.height, nextBatch(), 0, 'camera');
      const last = $('#lastCap');
      if (!scan.ok || !scan.page) {
        flash('bad');
        if (last) { last.innerHTML = ''; last.appendChild(el('p', { class: 'warntext' }, 'Not accepted: ' + scan.warnings.join('; ') + '. Try again.')); }
        cam.stableSince = performance.now();
        return;
      }
      // same page as the last capture and not re-armed: skip
      if (!manual && cam.lastCode === scan.codeBits) { cam.armed = false; cam.lastCapPts = cam.lastPts; updateCamStatus('Same page as the last capture. Turn to the next page.'); return; }
      if (scan.page !== 1 && !S.session.studentId && !S.students.length) scan.warnings.push('No cover scanned yet for this student');
      const created = await commitBatch([scan], false);
      if (scan.page === 1 && created.length) S.session.studentId = created[0].id;
      else if (!S.session.studentId && scan.studentId) S.session.studentId = scan.studentId;
      cam.count++; cam.lastCode = scan.codeBits; cam.armed = false; cam.armedFor = true; cam.lastCapPts = cam.lastPts;
      flash('good');
      if (last) {
        last.innerHTML = '';
        last.appendChild(el('div', { class: 'row' }, el('img', { src: scan.thumb, class: 'capthumb', alt: 'last capture' }),
          el('div', {}, el('div', {}, `Captured page ${scan.page}` + (scan.warnings.length ? ' - ' + scan.warnings.join('; ') : '')),
            el('button', { class: 'btn small', onclick: async () => { await DB.del('scans', scan.id); S.scans = S.scans.filter(x => x !== scan); last.innerHTML = 'Removed. Capture the page again.'; cam.armed = true; renderGroups(); } }, 'Retake'))));
      }
      updateCamStatus('Captured page ' + scan.page + '. Turn to the next page.');
      renderGroups();
    } finally { if (S.cam) S.cam.busy = false; }
  }
  function flash(kind) {
    const w = $('#camWrap'); if (!w) return;
    w.classList.add('flash-' + kind); setTimeout(() => w.classList.remove('flash-' + kind), 350);
  }

  // ---------------- Review ----------------
  async function viewReview(v) {
    v.appendChild(el('h2', {}, 'Review flagged answers'));
    const showMulti = el('input', { type: 'checkbox', id: 'showMulti' });
    v.appendChild(el('label', { class: 'small' }, showMulti, ' Also show multiple-mark and blank answers'));
    const list = el('div', { id: 'reviewList' });
    v.appendChild(list);
    let token = 0;
    const render = async () => {
      const my = ++token;
      const frag = document.createDocumentFragment();
      const studs = S.students.slice().sort((a, b) => a.key - b.key);
      let n = 0;
      // ID problems first
      for (const stu of studs) {
        const g = gradeOf(stu);
        if (!g.idOk && g.pages[1]) {
          n++;
          const cover = g.pages[1];
          const im = await imgOf(cover);
          const lay = L(); const b = lay.cover.idBox;
          const crop = cropCanvas(im, b.x - 2, b.y - 2, b.w + 4, b.h + 4, 1);
          const idIn = el('input', { class: 'narrow', value: g.id });
          frag.appendChild(el('div', { class: 'card review' }, el('div', {}, el('strong', {}, `Student ${studs.indexOf(stu) + 1}: student ID`), ' read as ', el('code', {}, g.id)),
            crop, el('div', { class: 'row' }, idIn, el('button', { class: 'btn primary', onclick: async () => { stu.idOverride = idIn.value.trim(); await saveStudent(stu); render(); } }, 'Confirm ID'))));
        }
      }
      for (const stu of studs) {
        const g = gradeOf(stu);
        for (const [qi, q] of S.exam.mc.entries()) {
          const r = g.mc[q.id];
          const need = r.state === 'review' || (showMulti.checked && (r.state === 'multiple' || r.state === 'blank'));
          if (!need || (r.override && !showMulti.checked)) continue;
          n++;
          const lq = L().mc.find(m => m.qid === q.id);
          const scan = g.pages[lq.page];
          const im = await imgOf(scan);
          const crop = cropCanvas(im, 11, lq.top - 1.5, 196 - 11, lq.h + 1, 1);
          const read = scan.omr[q.id];
          const btns = el('div', { class: 'row wrap' },
            q.choices.map((c, k) => el('button', { class: 'btn choicebtn' + (r.answer === Layout.LETTERS[k] ? ' primary' : ''), 'data-choice': Layout.LETTERS[k], onclick: async () => { stu.mcOverride[q.id] = Layout.LETTERS[k]; await saveStudent(stu); render(); } }, Layout.LETTERS[k])),
            el('button', { class: 'btn', 'data-choice': 'BLANK', onclick: async () => { stu.mcOverride[q.id] = 'BLANK'; await saveStudent(stu); render(); } }, 'Blank'),
            el('button', { class: 'btn', 'data-choice': 'MULTI', onclick: async () => { stu.mcOverride[q.id] = 'MULTI'; await saveStudent(stu); render(); } }, 'Multiple (wrong)'));
          frag.appendChild(el('div', { class: 'card review', 'data-stu': stu.id, 'data-q': qi + 1 },
            el('div', {}, el('strong', {}, `Student ${studs.indexOf(stu) + 1} (${g.id || 'no ID'}), question ${qi + 1}`), ` - read: ${read.status}${read.reason ? ' (' + read.reason + ')' : ''}, fill levels ${read.ds.map((d, k) => Layout.LETTERS[k] + ' ' + Math.round(d * 100) + '%').join(', ')}`),
            crop, btns));
        }
      }
      if (!n) frag.appendChild(el('div', { class: 'card ok', id: 'reviewEmpty' }, 'Nothing to review.'));
      if (my !== token) return;
      list.innerHTML = '';
      list.appendChild(frag);
    };
    showMulti.onchange = render;
    await render();
  }
  function cropCanvas(im, xmm, ymm, wmm, hmm, scale) {
    const PX = Layout.PX;
    const c = CV.canvasOf(Math.round(wmm * PX * scale), Math.round(hmm * PX * scale));
    c.className = 'crop';
    if (im) c.getContext('2d').drawImage(im, xmm * PX, ymm * PX, wmm * PX, hmm * PX, 0, 0, c.width, c.height);
    return c;
  }

  // ---------------- Grade (written answers) ----------------
  const GS = { mode: 'question', q: 0, stu: 0, tool: 'pen' };
  async function viewGrade(v) {
    const e = S.exam;
    v.appendChild(el('h2', {}, 'Grade written answers'));
    if (!e.sa.length) { v.appendChild(el('div', { class: 'card' }, 'This exam has no written-response questions.')); return; }
    const studs = S.students.slice().sort((a, b) => a.key - b.key);
    if (!studs.length) { v.appendChild(el('div', { class: 'card' }, 'Scan some exams first.')); return; }
    const modeSel = el('select', { id: 'gradeMode' }, el('option', { value: 'question', selected: GS.mode === 'question' }, 'By question'), el('option', { value: 'student', selected: GS.mode === 'student' }, 'By student'));
    const pick = el('select', { id: 'gradePick' });
    const fill = () => {
      pick.innerHTML = '';
      if (GS.mode === 'question') e.sa.forEach((q, i) => pick.appendChild(el('option', { value: i, selected: i === GS.q }, `SA${i + 1} (${U.fmt(q.max)} pts) ${(q.prompt || '').slice(0, 40)}`)));
      else studs.forEach((s, i) => { const g = gradeOf(s); pick.appendChild(el('option', { value: i, selected: i === GS.stu }, `Student ${i + 1} ${g.id} ${g.name}`)); });
    };
    fill();
    const tools = el('div', { class: 'row wrap tools', id: 'inkTools' },
      ['pen', 'check', 'cross'].map(t => el('button', { class: 'btn toolbtn' + (GS.tool === t ? ' primary' : ''), 'data-tool': t, onclick: ev => { GS.tool = t; $$('.toolbtn').forEach(b => b.classList.toggle('primary', b.dataset.tool === t)); } }, { pen: 'Pen', check: 'Check stamp', cross: 'Cross stamp' }[t])));
    v.appendChild(el('div', { class: 'card row wrap stickybar' }, field('Mode', modeSel), field(GS.mode === 'question' ? 'Question' : 'Student', pick), tools, el('span', { id: 'saveState', class: 'muted small' }, 'Autosave on')));
    const aiBox = el('div', { id: 'aiBox' }); v.appendChild(aiBox);
    const list = el('div', { id: 'gradeList' }); v.appendChild(list);
    modeSel.onchange = () => { if (AIR.running) AIR.stop = true; GS.mode = modeSel.value; go('grade'); };
    pick.onchange = () => { if (AIR.running) AIR.stop = true; if (GS.mode === 'question') GS.q = +pick.value; else GS.stu = +pick.value; renderList(); };
    let token = 0;
    const renderList = async () => {
      const my = ++token;
      list.innerHTML = '';
      aiBox.innerHTML = '';
      if (GS.mode === 'question' && S.settings.ai.enabled) aiBox.appendChild(aiBar(e.sa[GS.q], studs, list));
      const pairs = GS.mode === 'question' ? studs.map(s => [s, e.sa[GS.q]]) : e.sa.map(q => [studs[GS.stu], q]);
      for (const [stu, q] of pairs) {
        const item = await gradeItem(stu, q, studs);
        if (my !== token) return;
        list.appendChild(item);
      }
    };
    await renderList();
  }

  async function gradeItem(stu, q, studs, opts = {}) {
    const e = S.exam, lay = L();
    const lq = lay.sa.find(s => s.qid === q.id);
    const qi = e.sa.indexOf(q);
    const g0 = gradeOf(stu);
    const scan = g0.pages[lq.page];
    const card = el('div', { class: 'card gradeitem', 'data-stu': stu.id, 'data-sa': qi + 1 });
    card.appendChild(el('div', { class: 'row between wrap' }, el('strong', {}, `Student ${studs.indexOf(stu) + 1} ${g0.id ? '(' + g0.id + ')' : ''} ${g0.name || ''} - SA${qi + 1}`), el('span', { class: 'ptsnow muted' }, '')));
    if (!scan) { card.appendChild(el('p', { class: 'warntext' }, `Page ${lq.page} has not been scanned for this student.`)); return card; }
    const im = await imgOf(scan);
    const PX = Layout.PX, R = lq.region;
    const cv = CV.canvasOf(Math.round(R.w * PX), Math.round(R.h * PX));
    cv.className = 'inkcanvas';
    card.appendChild(cv);
    stu.sa = stu.sa || {}; stu.ink = stu.ink || {};
    const sa = stu.sa[q.id] = stu.sa[q.id] || { pts: null, comments: [], note: '' };
    const pend = stu.aiPending && stu.aiPending[q.id];
    if (pend) card.classList.add('aipending');
    const redraw = async () => {
      const full = CV.canvasOf(Layout.RW, Layout.RH);
      const g = gradeOf(stu);
      await Annot.renderPage(im, e, lay, g, stu, lq.page, { canvas: full });
      cv.getContext('2d').drawImage(full, R.x * PX, R.y * PX, cv.width, cv.height, 0, 0, cv.width, cv.height);
      if (stu.aiPending && stu.aiPending[q.id]) AI.drawPending(cv.getContext('2d'), stu.aiPending[q.id].marks, lq, R.x * PX, R.y * PX);
      card.querySelector('.ptsnow').textContent = sa.pts === null || sa.pts === undefined ? 'not graded' : `${U.fmt(sa.pts)} / ${U.fmt(q.max)}`;
    };
    const save = async () => { await saveStudent(stu); markSaved(); await redraw(); };
    // pen input
    let cur = null;
    const toPage = ev => {
      const r = cv.getBoundingClientRect();
      return [R.x * PX + (ev.clientX - r.left) / r.width * cv.width, R.y * PX + (ev.clientY - r.top) / r.height * cv.height];
    };
    cv.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const p = toPage(ev);
      const ink = stu.ink[lq.page] = stu.ink[lq.page] || [];
      if (GS.tool === 'check' || GS.tool === 'cross') { ink.push({ id: uid('k'), type: GS.tool, x: p[0], y: p[1], q: q.id }); save(); return; }
      cv.setPointerCapture(ev.pointerId);
      cur = { id: uid('k'), type: 'pen', pts: [p], w: 3, q: q.id };
    });
    cv.addEventListener('pointermove', ev => {
      if (!cur) return;
      const p = toPage(ev); const lp = cur.pts[cur.pts.length - 1];
      if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) < 1.2) return;
      cur.pts.push(p);
      const ctx = cv.getContext('2d');
      ctx.strokeStyle = Annot.INK; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lp[0] - R.x * PX, lp[1] - R.y * PX); ctx.lineTo(p[0] - R.x * PX, p[1] - R.y * PX); ctx.stroke();
    });
    const end = () => { if (!cur) return; const ink = stu.ink[lq.page] = stu.ink[lq.page] || []; if (cur.pts.length) ink.push({ ...cur, pts: cur.pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) }); cur = null; save(); };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.style.touchAction = 'none';
    // points
    const ptsRow = el('div', { class: 'row wrap ptsrow' });
    const steps = [];
    for (let x = 0; x <= (+q.max || 0) + 1e-9; x += 0.5) steps.push(Math.round(x * 2) / 2);
    const drawPts = () => {
      ptsRow.innerHTML = '';
      steps.forEach(x => ptsRow.appendChild(el('button', { class: 'btn ptbtn' + (sa.pts === x ? ' primary' : '') + (x % 1 ? ' half' : ''), 'data-pts': x, onclick: async () => { sa.pts = x; drawPts(); await save(); } }, U.fmt(x))));
      ptsRow.appendChild(el('button', { class: 'btn small', onclick: async () => { sa.pts = null; drawPts(); await save(); } }, 'Clear'));
    };
    drawPts();
    // comments
    const chips = el('div', { class: 'row wrap chips' });
    const presets = () => Array.from(new Set([...(q.comments || []), ...(e.comments || [])]));
    const drawChips = () => {
      chips.innerHTML = '';
      presets().forEach(c => chips.appendChild(el('button', { class: 'chip' + (sa.comments.includes(c) ? ' on' : ''), onclick: async () => {
        sa.comments = sa.comments.includes(c) ? sa.comments.filter(x => x !== c) : [...sa.comments, c]; drawChips(); await save();
      } }, c)));
      const add = el('input', { class: 'narrow newchip', placeholder: 'New comment' });
      chips.appendChild(add);
      chips.appendChild(el('button', { class: 'btn small', onclick: async () => { const t = add.value.trim(); if (!t) return; e.comments = Array.from(new Set([...(e.comments || []), t])); await saveExam(false); sa.comments.push(t); drawChips(); await save(); } }, 'Add'));
    };
    drawChips();
    const note = el('input', { class: 'note', placeholder: 'Typed comment written on the page' });
    note.value = sa.note || '';
    let nt; note.oninput = () => { sa.note = note.value; clearTimeout(nt); nt = setTimeout(save, 400); };
    const inkTools = el('div', { class: 'row wrap' },
      el('button', { class: 'btn small', onclick: async () => { const ink = stu.ink[lq.page] || []; for (let i = ink.length - 1; i >= 0; i--) if (ink[i].q === q.id) { ink.splice(i, 1); break; } await save(); } }, 'Undo ink'),
      el('button', { class: 'btn small', onclick: async () => { if (!confirm('Clear all ink on this answer?')) return; stu.ink[lq.page] = (stu.ink[lq.page] || []).filter(k => k.q !== q.id); await save(); } }, 'Clear ink'));
    if (pend) card.appendChild(pendingPanel(stu, q, pend, card, studs));
    if (opts.edited) card.appendChild(el('p', { class: 'small muted aieditnote' }, 'AI suggestion applied. Adjust the points, comments or ink below.'));
    card.appendChild(el('div', { class: 'label small muted' }, 'Points'));
    card.appendChild(ptsRow);
    card.appendChild(chips);
    card.appendChild(note);
    card.appendChild(inkTools);
    await redraw();
    return card;
  }

  // ---------------- AI suggestions (Gemini through the Apps Script server) ----------------
  const AIR = { running: false, stop: false };
  function aiReady() { const st = S.settings; return !!(st.cloudUrl && st.cloudToken); }
  function presetsOf(q) { return Array.from(new Set([...(q.comments || []), ...(S.exam.comments || [])])); }
  function saPage(stu, q) { const lq = L().sa.find(s => s.qid === q.id); return { lq, scan: lq ? gradeOf(stu).pages[lq.page] : null }; }
  async function rerenderCard(stu, q, studs, opts = {}) {
    const old = document.querySelector(`.gradeitem[data-stu="${stu.id}"][data-sa="${S.exam.sa.indexOf(q) + 1}"]`);
    if (!old) return null;
    const n = await gradeItem(stu, q, studs, opts);
    old.replaceWith(n);
    return n;
  }

  function pendingPanel(stu, q, p, card, studs) {
    const flags = [];
    if (!p.legible) flags.push(el('span', { class: 'badge bad' }, 'Illegible or blank'));
    if (p.confidence !== 'high') flags.push(el('span', { class: 'badge ' + (p.confidence === 'low' ? 'bad' : 'mid') }, p.confidence + ' confidence'));
    else flags.push(el('span', { class: 'badge' }, 'high confidence'));
    return el('div', { class: 'aipanel', 'data-conf': p.confidence },
      el('div', { class: 'row wrap' }, el('strong', {}, `AI suggestion: ${U.fmt(p.points)} / ${U.fmt(q.max)}`), flags, el('span', { class: 'muted small' }, 'Pending, not counted until accepted')),
      (p.rubricItems || []).length ? el('ul', { class: 'rubriclist small' }, p.rubricItems.map(r => el('li', {}, `${r.item}: ${U.fmt(r.earned)} / ${U.fmt(r.max)}`))) : null,
      p.comment ? el('div', { class: 'small' }, 'Comment: ', el('em', {}, p.comment)) : null,
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn small primary aiaccept', onclick: () => applySuggestion(stu, q, studs, 'accepted') }, 'Accept'),
        el('button', { class: 'btn small aiedit', onclick: () => applySuggestion(stu, q, studs, 'edited') }, 'Edit'),
        el('button', { class: 'btn small danger aireject', onclick: async () => { delete stu.aiPending[q.id]; await saveStudent(stu); await rerenderCard(stu, q, studs); } }, 'Reject')));
  }

  // Accept: points + comment + marks become normal teacher annotations. Edit: the same, then the teacher adjusts.
  async function applySuggestion(stu, q, studs, mode, rerender = true) {
    const p = stu.aiPending && stu.aiPending[q.id]; if (!p) return;
    const { lq } = saPage(stu, q);
    stu.sa = stu.sa || {}; stu.ink = stu.ink || {};
    const sa = stu.sa[q.id] = stu.sa[q.id] || { pts: null, comments: [], note: '' };
    sa.pts = Math.max(0, Math.min(+q.max || 0, Math.round((+p.points || 0) * 2) / 2));
    const c = String(p.comment || '').trim();
    if (c) {
      if (presetsOf(q).includes(c)) { if (!sa.comments.includes(c)) sa.comments = [...sa.comments, c]; }
      else sa.note = sa.note ? sa.note + '; ' + c : c;
    }
    const ink = stu.ink[lq.page] = stu.ink[lq.page] || [];
    ink.push(...AI.toInk(p.marks, lq, q.id));
    sa.ai = mode; sa.aiModel = p.model || '';
    delete stu.aiPending[q.id];
    await saveStudent(stu);
    if (!rerender) return;
    const n = await rerenderCard(stu, q, studs, { edited: mode === 'edited' });
    if (n && mode === 'edited') { n.scrollIntoView({ block: 'center' }); const ni = n.querySelector('input.note'); if (ni) ni.focus(); }
  }

  function aiBar(q, studs, list) {
    const st = S.settings, ai = st.ai;
    const box = el('div', { class: 'card aibar', id: 'aiBar' });
    if (!aiReady()) { box.appendChild(el('p', { class: 'small' }, 'AI suggestions need the Apps Script URL and token in Settings > Google Drive / Sheets.')); return box; }
    const prog = el('progress', { id: 'aiProg', max: 1, value: 0 });
    const msg = el('span', { id: 'aiMsg', class: 'small' }, `Model: ${AI.modelOf(ai) || 'automatic'}. Up to ${ai.rpm} requests per minute.`);
    const btnRun = el('button', { class: 'btn primary', id: 'btnAiSuggest' }, 'Suggest grades (AI)');
    const btnStop = el('button', { class: 'btn danger', id: 'btnAiStop', disabled: true, onclick: () => { AIR.stop = true; msg.textContent = 'Stopping after the current answer...'; } }, 'Stop');
    const btnAll = el('button', { class: 'btn', id: 'btnAiAcceptHigh', onclick: async () => {
      let n = 0;
      for (const stu of studs) { const p = stu.aiPending && stu.aiPending[q.id]; if (p && p.confidence === 'high' && p.legible) { await applySuggestion(stu, q, studs, 'accepted', false); n++; } }
      for (const stu of studs) await rerenderCard(stu, q, studs);
      toast(`${n} high-confidence suggestion(s) accepted`, 'good');
    } }, 'Accept all high-confidence');
    btnRun.onclick = () => runSuggest(q, studs, { prog, msg, btnRun, btnStop }).catch(err => { msg.textContent = 'Error: ' + err.message; });
    box.appendChild(el('div', { class: 'row wrap' }, btnRun, btnStop, btnAll, prog, msg));
    box.appendChild(el('p', { class: 'small muted' }, 'Only the cropped answer box is sent (no name or ID). Suggestions are pending until you accept them.'));
    return box;
  }

  async function runSuggest(q, studs, ui) {
    if (AIR.running) return;
    const st = S.settings, ai = st.ai;
    const { prog, msg, btnRun, btnStop } = ui;
    const setMsg = t => { msg.textContent = t; };
    if (!ai.models.length && !ai.model) {
      setMsg('Loading models...');
      const r = await AI.post(st.cloudUrl, st.cloudToken, { action: 'aiModels' });
      if (!r.ok) { setMsg('Could not load models: ' + r.error); return; }
      ai.models = r.models; await saveSettings();
    }
    const model = AI.modelOf(ai);
    if (!model) { setMsg('No Gemini model available.'); return; }
    // teacher-graded examples of this question (teacher's own grades first), up to 4
    const graded = studs.filter(s => s.sa && s.sa[q.id] && s.sa[q.id].pts !== null && s.sa[q.id].pts !== undefined && saPage(s, q).scan)
      .sort((a, b) => (!!a.sa[q.id].ai - !!b.sa[q.id].ai));
    const examples = [];
    for (const s of graded.slice(0, 4)) {
      const { lq, scan } = saPage(s, q);
      const g = s.sa[q.id];
      examples.push({ imageB64: AI.boxCrop(await imgOf(scan), lq).b64, points: g.pts, comment: [...(g.comments || []), g.note || ''].map(t => String(t).trim()).filter(Boolean).join('; ') });
    }
    const todo = studs.filter(s => { const g = s.sa && s.sa[q.id]; return (!g || g.pts === null || g.pts === undefined) && !(s.aiPending && s.aiPending[q.id]) && saPage(s, q).scan; });
    if (!todo.length) { setMsg('No ungraded answers left for this question.'); return; }
    AIR.running = true; AIR.stop = false;
    btnRun.disabled = true; btnStop.disabled = false;
    prog.max = todo.length; prog.value = 0;
    const cap = Math.max(1, +ai.dailyCap || AI.DEFAULTS.dailyCap);
    let done = 0, errors = 0, warned = false, why = '';
    const retries = new Map();
    try {
      for (let i = 0; i < todo.length; i++) {
        if (AIR.stop) { why = 'Stopped.'; break; }
        const stu = todo[i];
        const used = await AI.today();
        if (used >= cap) { why = `Daily limit reached (${used} of ${cap} requests today). Stopped; continue tomorrow or raise the limit in Settings.`; break; }
        if (used >= cap - AI.WARN_MARGIN && !warned) { warned = true; toast(`AI requests today: ${used} of ${cap}. Close to the daily limit.`, 'bad'); }
        const go_ = await AI.pace(ai.rpm, () => AIR.stop, w => setMsg(`Answer ${i + 1} of ${todo.length}: waiting ${Math.ceil(w / 1000)} s (pacing)`));
        if (!go_) { why = 'Stopped.'; break; }
        setMsg(`Answer ${i + 1} of ${todo.length}: asking ${model}...`);
        const { lq, scan } = saPage(stu, q);
        const crop = AI.boxCrop(await imgOf(scan), lq);
        await AI.bump();
        let r;
        try {
          r = await AI.post(st.cloudUrl, st.cloudToken, {
            action: 'aiGrade', model, prompt: q.prompt || '', maxPoints: +q.max || 0, answerKey: q.modelAnswer || q.key || '', rubric: q.rubric || '',
            presetComments: presetsOf(q), examples, imageB64: crop.b64
          });
        } catch (err) { r = { ok: false, error: 'Network error: ' + err.message }; }
        if (!r.ok && r.rateLimited) {
          if (r.dailyQuota) { why = 'Google reports the daily free quota is used up. Stopped; try again tomorrow.'; break; }
          retries.set(stu.id, (retries.get(stu.id) || 0) + 1);
          if (retries.get(stu.id) > 4) { why = 'Still rate limited after several pauses. Stopped.'; break; }
          const secs = Math.min(120, Math.max(2, +r.retryAfter || 30));
          const until = Date.now() + secs * 1000;
          while (Date.now() < until && !AIR.stop) { setMsg(`Rate limited by Google. Paused, resuming in ${Math.ceil((until - Date.now()) / 1000)} s`); await U.sleep(250); }
          AI.resetPace();
          i--; continue;
        }
        if (!r.ok) {
          errors++;
          setMsg(`Answer ${i + 1}: ${r.error}`);
          if (errors >= 3) { why = 'Stopped after 3 errors: ' + r.error; break; }
          continue;
        }
        stu.aiPending = stu.aiPending || {};
        stu.aiPending[q.id] = { ...r.result, model, at: Date.now() };
        await saveStudent(stu);
        await rerenderCard(stu, q, studs);
        done++; prog.value = done;
      }
    } finally {
      AIR.running = false; AIR.stop = false;
      btnRun.disabled = false; btnStop.disabled = true;
    }
    setMsg(`${done} suggestion(s) ready${errors ? `, ${errors} error(s)` : ''}. ${why} Requests today: ${await AI.today()} of ${cap}.`.replace(/\s+/g, ' ').trim());
  }

  // ---------------- Results / preview / export ----------------
  async function viewResults(v) {
    const e = S.exam, lay = L();
    const studs = S.students.slice();
    const graded = studs.map(s => ({ stu: s, g: gradeOf(s) })).sort((a, b) => Grade.sortKey(a.g).localeCompare(Grade.sortKey(b.g)));
    v.appendChild(el('h2', {}, 'Results'));
    if (!graded.length) { v.appendChild(el('div', { class: 'card' }, 'No students scanned yet.')); return; }
    const tot = graded.map(x => x.g.pct).sort((a, b) => a - b);
    const mean = tot.reduce((a, b) => a + b, 0) / tot.length;
    const med = tot.length % 2 ? tot[(tot.length - 1) / 2] : (tot[tot.length / 2 - 1] + tot[tot.length / 2]) / 2;
    const incomplete = graded.filter(x => !x.g.complete).length;
    v.appendChild(el('div', { class: 'card stats' },
      stat('Students', graded.length), stat('Mean', U.fmt(mean) + '%'), stat('Median', U.fmt(med) + '%'),
      stat('High', U.fmt(tot[tot.length - 1]) + '%'), stat('Low', U.fmt(tot[0]) + '%'), stat('Incomplete', incomplete)));
    const ex = el('div', { class: 'card' }, el('h3', {}, 'Export'),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnCombined', onclick: () => exportCombined(graded) }, 'Combined class PDF'),
        el('button', { class: 'btn', id: 'btnAllPdfs', onclick: () => exportAll(graded) }, 'All student PDFs'),
        el('button', { class: 'btn', id: 'btnCsv', onclick: () => exportCSV(graded) }, 'CSV gradebook'),
        el('button', { class: 'btn', id: 'btnXlsx', onclick: () => exportXLSX(graded) }, 'Excel gradebook'),
        el('button', { class: 'btn', id: 'btnCloud', onclick: () => cloudSave(graded) }, 'Save to Google Drive')),
      el('div', { id: 'exportProgress', class: 'small muted' }),
      incomplete ? el('p', { class: 'warntext small' }, `${incomplete} student(s) are not completely graded; their status is shown in the gradebook.`) : null);
    v.appendChild(ex);
    const tbl = el('table', { class: 'gradebook', id: 'gradebook' },
      el('thead', {}, el('tr', {}, ['#', 'ID', 'Name', 'MC', 'Written', 'Total', '%', 'Status', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, graded.map((x, i) => el('tr', { 'data-stu': x.stu.id },
        el('td', {}, i + 1), el('td', {}, x.g.id), el('td', {}, x.g.name),
        el('td', {}, `${U.fmt(x.g.mcTotal)}/${U.fmt(x.g.mcMax)}`), el('td', {}, `${U.fmt(x.g.saTotal)}/${U.fmt(x.g.saMax)}`),
        el('td', {}, `${U.fmt(x.g.total)}/${U.fmt(x.g.max)}`), el('td', {}, U.fmt(x.g.pct)),
        el('td', { class: x.g.complete ? 'okc' : 'badc' }, x.g.status),
        el('td', {}, el('div', { class: 'row tight' },
          el('button', { class: 'btn small', onclick: () => preview(x.stu) }, 'View'),
          el('button', { class: 'btn small', onclick: () => exportStudent(x.stu) }, 'PDF')))))));
    v.appendChild(el('div', { class: 'card scrollx' }, tbl));
    v.appendChild(el('div', { id: 'previewBox' }));
  }
  function stat(k, val) { return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, String(val))); }

  async function renderStudentPages(stu, scale = 1) {
    const g = gradeOf(stu);
    const out = [];
    for (let p = 1; p <= L().pageCount; p++) {
      const scan = g.pages[p];
      const im = scan ? await imgOf(scan) : null;
      const c = await Annot.renderPage(im, S.exam, L(), g, stu, p, { scale });
      if (!scan) {
        const ctx = c.getContext('2d'); ctx.fillStyle = '#888'; ctx.font = `${Math.round(40 * scale)}px sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(`Page ${p} was not scanned`, c.width / 2, c.height / 2);
      }
      out.push(c);
    }
    return { g, pages: out };
  }

  async function preview(stu) {
    const box = $('#previewBox'); box.innerHTML = '';
    const { g, pages } = await renderStudentPages(stu, 0.7);
    const ovr = el('div', { class: 'card' }, el('h3', {}, 'Answer overrides'),
      el('div', { class: 'overrides' }, S.exam.mc.map((q, i) => {
        const r = g.mc[q.id];
        const sel = el('select', { 'data-q': i + 1 }, el('option', { value: '' }, 'Scan: ' + (r.read === 'single' ? (gradeOf(stu).mc[q.id].answer || r.read) : r.read)),
          q.choices.map((c, k) => el('option', { value: Layout.LETTERS[k], selected: r.override === Layout.LETTERS[k] }, Layout.LETTERS[k])),
          el('option', { value: 'BLANK', selected: r.override === 'BLANK' }, 'Blank'), el('option', { value: 'MULTI', selected: r.override === 'MULTI' }, 'Multiple'));
        sel.onchange = async () => { if (sel.value) stu.mcOverride[q.id] = sel.value; else delete stu.mcOverride[q.id]; await saveStudent(stu); preview(stu); };
        return el('label', { class: 'ovr ' + r.state }, `${i + 1}. key ${q.answer || '?'} `, sel);
      })));
    box.appendChild(el('div', { class: 'card' }, el('div', { class: 'row between' }, el('h3', {}, `Preview: ${g.id} ${g.name} - ${U.fmt(g.total)}/${U.fmt(g.max)} (${U.fmt(g.pct)}%)`), el('button', { class: 'btn small', onclick: () => { box.innerHTML = ''; } }, 'Close')),
      el('div', { class: 'previewpages', id: 'previewPages' }, pages.map((c, i) => { c.className = 'pv'; c.dataset.page = i + 1; return c; }))));
    box.appendChild(ovr);
    box.scrollIntoView({ behavior: 'smooth' });
  }

  function fileBase(g) { return U.safeName(`${S.exam.title} - ${g.name || g.id || 'student'}`); }
  async function studentPdf(stu) {
    const { g, pages } = await renderStudentPages(stu, 1);
    const doc = Export.pdfFromCanvases(pages, `${S.exam.title} - ${g.name || g.id}`);
    return { g, doc };
  }
  async function exportStudent(stu) {
    const { g, doc } = await studentPdf(stu);
    U.download(doc.output('blob'), fileBase(g) + '.pdf');
  }
  async function exportAll(graded) {
    const p = $('#exportProgress');
    for (let i = 0; i < graded.length; i++) {
      p.textContent = `Student PDF ${i + 1} / ${graded.length}`;
      await exportStudent(graded[i].stu);
      await U.sleep(400);
    }
    p.textContent = `${graded.length} PDFs downloaded.`;
  }
  async function exportCombined(graded) {
    const p = $('#exportProgress');
    const doc = Export.newDoc();
    doc.setProperties({ title: S.exam.title + ' - class', creator: 'Exam Grader' });
    let first = true;
    for (let i = 0; i < graded.length; i++) {
      p.textContent = `Rendering student ${i + 1} / ${graded.length}`;
      const { pages } = await renderStudentPages(graded[i].stu, 1);
      pages.forEach(c => { Export.addCanvasPage(doc, c, first); first = false; });
      await U.sleep(0);
    }
    U.download(doc.output('blob'), U.safeName(`${S.exam.title} - class`) + '.pdf');
    p.textContent = `Combined PDF: ${graded.length} students, ${graded.length * L().pageCount} pages.`;
  }
  function gradebook(graded) {
    const header = Grade.header(S.exam);
    const rows = graded.map(x => Grade.row(S.exam, x.g));
    return { header, rows };
  }
  function exportCSV(graded) {
    const { header, rows } = gradebook(graded);
    U.download(new Blob([Export.csv([header, ...rows])], { type: 'text/csv' }), U.safeName(S.exam.title + ' - gradebook') + '.csv');
  }
  function itemStats(graded) {
    const rows = [['Question', 'Key', 'Points', '% correct', ...Layout.LETTERS.map(l => 'Chose ' + l), 'Blank', 'Multiple', 'Review']];
    S.exam.mc.forEach((q, i) => {
      const cnt = { blank: 0, multiple: 0, review: 0 }; const ch = {}; let ok = 0;
      graded.forEach(x => { const r = x.g.mc[q.id]; if (r.state === 'correct') ok++; if (r.answer) ch[r.answer] = (ch[r.answer] || 0) + 1; if (cnt[r.state] !== undefined) cnt[r.state]++; });
      rows.push([i + 1, q.answer, +q.points || 0, graded.length ? Math.round(ok / graded.length * 1000) / 10 : 0, ...Layout.LETTERS.map(l => ch[l] || 0), cnt.blank, cnt.multiple, cnt.review]);
    });
    return rows;
  }
  function exportXLSX(graded) {
    const { header, rows } = gradebook(graded);
    const buf = Export.xlsx(header, rows, S.exam.title || 'Grades', itemStats(graded));
    U.download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), U.safeName(S.exam.title + ' - gradebook') + '.xlsx');
  }
  async function cloudSave(graded) {
    const st = S.settings, p = $('#exportProgress');
    if (!st.cloudUrl) { toast('Set the Apps Script web app URL in Settings first', 'bad'); go('settings'); return; }
    const exam = { id: S.exam.id, title: S.exam.title, course: S.exam.course, school: S.exam.school, version: S.exam.version };
    try {
      for (let i = 0; i < graded.length; i++) {
        p.textContent = `Uploading PDF ${i + 1} / ${graded.length}`;
        const { g, doc } = await studentPdf(graded[i].stu);
        const b64 = doc.output('datauristring').split(',')[1];
        await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'savePdf', exam, filename: fileBase(g) + '.pdf', b64 });
      }
      const { header, rows } = gradebook(graded);
      p.textContent = 'Saving gradebook to Google Sheets...';
      const r = await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'saveGrades', exam, header, rows });
      p.textContent = `Saved ${graded.length} PDFs and ${rows.length} gradebook rows to Google Drive.` + (r.url ? ' Sheet: ' + r.url : '');
      toast('Saved to Google Drive', 'good');
    } catch (err) { p.textContent = 'Cloud save failed: ' + err.message; toast('Cloud save failed', 'bad'); }
  }

  // ---------------- Settings ----------------
  async function viewSettings(v) {
    const st = S.settings;
    const sInp = (key, attrs = {}) => { const i = el('input', attrs); i.value = st[key] ?? ''; i.oninput = () => { st[key] = attrs.type === 'number' ? +i.value : i.value; saveSettings(); }; return i; };
    const oInp = key => { const i = el('input', { type: 'number', step: 0.01, min: 0, max: 1, class: 'narrow', id: 'omr_' + key }); i.value = st.omr[key]; i.oninput = () => { st.omr[key] = +i.value; saveSettings(); }; return i; };
    v.appendChild(el('h2', {}, 'Settings'));
    v.appendChild(el('div', { class: 'card grid2' }, el('h3', { class: 'span2' }, 'Defaults for new exams'),
      field('School / institution', sInp('school', { id: 's_school' })), field('Course', sInp('course')), field('Teacher', sInp('teacher')),
      field('Student ID digits', sInp('idDigits', { type: 'number', min: 1, max: 12 }))));
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Bubble reading'),
      el('p', { class: 'small muted' }, 'Fill levels are measured from 0 (blank paper) to 1 (as dark as the corner squares).'),
      el('div', { class: 'row wrap' }, field('Filled at or above', oInp('hi')), field('Blank below', oInp('lo')), field('Erasure gap', oInp('erase')), field('Blur warning below', sInp('blurMin', { type: 'number', class: 'narrow' }))),
      el('button', { class: 'btn small', onclick: () => { st.omr = { ...CV.DEFAULT_TH }; saveSettings(); go('settings'); } }, 'Reset defaults')));
    const cloudMsg = el('span', { class: 'small', id: 'cloudMsg' });
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Google Drive / Sheets (optional)'),
      el('p', { class: 'small muted' }, 'Deploy the provided Apps Script (server/Code.gs) as a web app, then paste its URL and the shared token here. Without it, everything stays on this device.'),
      field('Apps Script web app URL', sInp('cloudUrl', { id: 's_cloudUrl', placeholder: 'https://script.google.com/macros/s/.../exec' })),
      field('Shared token', sInp('cloudToken', { id: 's_cloudToken', type: 'password' })),
      el('div', { class: 'row' }, el('button', { class: 'btn', id: 'btnPing', onclick: async () => {
        cloudMsg.textContent = 'Testing...';
        try { const r = await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'ping' }); cloudMsg.textContent = 'Connected: ' + (r.message || 'ok'); }
        catch (err) { cloudMsg.textContent = 'Failed: ' + err.message; }
      } }, 'Test connection'), cloudMsg)));
    v.appendChild(await aiSettingsCard());
    const est = await DB.estimate();
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Data and backup'),
      el('p', { class: 'small muted' }, est ? `Storage used: ${(est.usage / 1048576).toFixed(1)} MB of ${(est.quota / 1048576).toFixed(0)} MB available to this site.` : 'Storage estimate unavailable.'),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn', id: 'btnBackup', onclick: () => exportBackup(true) }, 'Export backup (with scans)'),
        el('button', { class: 'btn', onclick: () => exportBackup(false) }, 'Export backup (no scans)'),
        el('label', { class: 'btn' }, 'Restore backup', el('input', { type: 'file', id: 'restoreInput', accept: '.json,application/json', class: 'hidden', onchange: ev => importBackup(ev.target.files[0]) }))),
      el('div', { class: 'row' }, el('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Delete ALL exams, scans and grades on this device?')) return;
        if (!confirm('Really delete everything? Export a backup first if unsure.')) return;
        for (const e of S.exams) await DB.deleteExam(e.id);
        S.exams = []; S.exam = null; S.scans = []; S.students = []; buildNav(); go('exams');
      } }, 'Delete all data'))));
  }

  async function aiSettingsCard() {
    const st = S.settings, ai = st.ai;
    const card = el('div', { class: 'card', id: 'aiSettings' }, el('h3', {}, 'AI suggestions (Google Gemini)'));
    if (!aiReady()) card.appendChild(el('p', { class: 'small warntext', id: 'aiNeedServer' }, 'Needs the Apps Script URL and token above, with a GEMINI_KEY script property on that server.'));
    const on = el('input', { type: 'checkbox', id: 'ai_on', checked: !!ai.enabled });
    on.onchange = () => { ai.enabled = on.checked; saveSettings(); };
    const sel = el('select', { id: 'ai_model' });
    const fillModels = () => {
      sel.innerHTML = '';
      const auto = AI.pickDefault(ai.models);
      sel.appendChild(el('option', { value: '' }, 'Automatic' + (auto ? ': ' + auto : ' (load models first)')));
      ai.models.forEach(m => sel.appendChild(el('option', { value: m, selected: ai.model === m }, m)));
      if (ai.model && !ai.models.includes(ai.model)) sel.appendChild(el('option', { value: ai.model, selected: true }, ai.model));
    };
    fillModels();
    sel.onchange = () => { ai.model = sel.value; saveSettings(); };
    const num = (key, attrs) => { const i = el('input', { type: 'number', class: 'narrow', ...attrs }); i.value = ai[key]; i.oninput = () => { if (+i.value > 0) { ai[key] = +i.value; saveSettings(); } }; return i; };
    const msg = el('span', { class: 'small', id: 'aiTestMsg' });
    const loadModels = async () => {
      msg.textContent = 'Contacting the server...';
      try {
        const r = await AI.post(st.cloudUrl, st.cloudToken, { action: 'aiModels' });
        if (!r.ok) { msg.textContent = 'Failed: ' + r.error; return; }
        ai.models = r.models || []; await saveSettings(); fillModels();
        msg.textContent = `Connected. ${ai.models.length} models available; using ${AI.modelOf(ai) || 'none'}.`;
      } catch (err) { msg.textContent = 'Failed: ' + err.message; }
    };
    const used = await AI.today();
    card.appendChild(el('label', { class: 'small' }, on, ' Suggest grades for written answers (button on the Grade screen, by question)'));
    card.appendChild(el('div', { class: 'row wrap' },
      field('Model', sel),
      field('Requests per minute', num('rpm', { id: 'ai_rpm', min: 1, max: 60 })),
      field('Daily limit', num('dailyCap', { id: 'ai_cap', min: 1, max: 100000 }), `Used today: ${used}`)));
    card.appendChild(el('div', { class: 'row wrap' },
      el('button', { class: 'btn', id: 'btnAiTest', disabled: !aiReady(), onclick: loadModels }, 'Test connection and load models'), msg));
    card.appendChild(el('div', { class: 'small muted ainote' },
      el('p', {}, 'Google\'s free tier allows a limited number of requests per minute and per day for each model (often around 10 to 30 per minute and a few hundred to about a thousand per day; Google changes these limits). One answer is one request. The app slows itself down and stops at the daily limit set here.'),
      el('p', {}, 'Only the cropped image of the answer box is sent, together with the question, answer key, rubric, preset comments and up to 4 of your graded answers to the same question as examples. Student names, IDs and the cover page are never sent.'),
      el('p', {}, 'On Google\'s free tier, submitted content may be used by Google to improve its products and may be read by human reviewers. You are responsible for following your school\'s privacy rules (for example FERPA) before using this feature. Every suggestion must be accepted by you before it counts.')));
    return card;
  }

  async function exportBackup(withScans) {
    const exams = await DB.all('exams');
    const students = await DB.all('students');
    const scans = [];
    for (const s of await DB.all('scans')) {
      const c = { ...s };
      if (withScans && s.blob) c.blob = await U.blobToDataURL(s.blob); else delete c.blob;
      scans.push(c);
    }
    const data = { app: 'examgrader', version: 1, exported: new Date().toISOString(), settings: S.settings, exams, students, scans };
    U.download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `examgrader-backup-${new Date().toISOString().slice(0, 10)}.json`);
  }
  async function importBackup(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'examgrader') throw new Error('Not an Exam Grader backup');
      for (const e of data.exams || []) await DB.put('exams', e);
      for (const s of data.students || []) await DB.put('students', s);
      for (const s of data.scans || []) { if (typeof s.blob === 'string') s.blob = await U.dataURLToBlob(s.blob); await DB.put('scans', s); }
      S.exams = (await DB.all('exams')).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      if (S.exam) await selectExam(S.exam.id, false);
      buildNav(); toast(`Restored ${data.exams.length} exam(s)`, 'good'); go('exams');
    } catch (err) { toast('Restore failed: ' + err.message, 'bad'); }
  }

  // ---------------- Help ----------------
  function viewHelp(v) {
    const steps = [
      ['Set up', 'Exams > New exam. Enter school, course, title, date, version and the number of student-ID digits. Add multiple-choice questions one by one or with Bulk paste, set the correct answers and points. Add written-response questions with maximum points and box height.'],
      ['Print', 'Print > check the preflight result > Download exam PDF. Print at actual size on US Letter. Download the answer key PDF if you want one.'],
      ['Scan', 'Scan > Start camera. Lay each page flat with the four black corner squares visible. The outline turns green and the page is captured after it is held still. Scan the cover first, then that student\'s other pages, then the next cover. Or upload scanner PDFs / photos.'],
      ['Check pages', 'On the Scan screen each student shows the handwritten name, the read ID and the page chips. Fix the ID, page numbers or move pages to another student (drag a page onto a student card or use "Move to").'],
      ['Review', 'Review lists bubbles that were too light or doubly marked. Choose the intended answer. Unreviewed questions get no mark and no points.'],
      ['Grade written work', 'Grade > by question or by student. Tap points (half points available), add preset or typed comments, and write on the answer with the pen or stamp a check or cross. Everything saves automatically.'],
      ['AI suggestions (optional)', 'Settings > AI suggestions: turn it on after adding GEMINI_KEY to the Apps Script server. On Grade > By question, grade a few answers yourself, then use "Suggest grades (AI)". Each suggestion is pending (dashed marks) until you Accept, Edit or Reject it; pending suggestions are not counted in totals or exports.'],
      ['Export', 'Results > View a student to see the marked pages and override any answer. Export each student\'s PDF, the combined class PDF, CSV or Excel gradebook, or Save to Google Drive after setting it up in Settings.'],
      ['Backup', 'Settings > Export backup regularly. Data lives only in this browser until you export or save to Drive.']
    ];
    v.appendChild(el('h2', {}, 'Help'));
    v.appendChild(el('div', { class: 'card' }, el('ol', { class: 'help' }, steps.map(([t, d]) => el('li', {}, el('strong', {}, t + ': '), d)))));
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Tips for reliable reading'), el('ul', {},
      el('li', {}, 'Use a dark pencil or pen and fill the bubble completely.'),
      el('li', {}, 'Avoid strong shadows across the corner squares; even daylight works best.'),
      el('li', {}, 'The small squares at the top of each page identify the exam and page number, so pages may be scanned in any orientation.'),
      el('li', {}, 'Camera scanning needs HTTPS or localhost. The app works offline after the first visit.'))));
  }

  // expose a small hook for automated tests
  window.ExamGrader = { S, go, selectExam, parseBulk, gradeOf, renderStudentPages, saveExam, commitBatch, makeScan };
  window.addEventListener('DOMContentLoaded', boot);
})();
