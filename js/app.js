/* Exam Grader - application UI */
'use strict';

(() => {
  const { $, $$, el, uid, toast, esc } = U;
  const S = { settings: null, exams: [], exam: null, scans: [], students: [], view: 'exams', imgCache: new Map(), cam: null, session: { studentId: null } };
  const DEFAULT_SETTINGS = {
    school: '', course: '', teacher: '', idDigits: 7,
    omr: { ...CV.DEFAULT_TH }, blurMin: 12, cloudUrl: '', cloudToken: '', comments: ['Good work', 'Show your work', 'Check units', 'Incomplete answer', 'Sign error'],
    autoApprove: false
  };
  const VIEWS = [
    ['exams', 'Exams'], ['template', 'Exam template'], ['setup', 'Setup'], ['print', 'Print'], ['scan', 'Scan'], ['review', 'Review'],
    ['grade', 'Grade'], ['results', 'Results'], ['settings', 'Settings'], ['help', 'Help']
  ];

  const SUBVIEWS = { make: 'template', import: 'template' };   // screens reached from Exam template (its menu item stays lit)

  // ---------------- boot ----------------
  async function boot() {
    S.settings = Object.assign({}, DEFAULT_SETTINGS, await DB.getKV('settings', {}));
    S.settings.omr = Object.assign({}, CV.DEFAULT_TH, S.settings.omr || {});
    S.settings.ai = Object.assign({}, AI.DEFAULTS, S.settings.ai || {});
    S.exams = (await DB.all('exams')).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const last = await DB.getKV('currentExam', null);
    if (last && S.exams.find(e => e.id === last)) await selectExam(last, false);
    buildNav();
    renderQ();
    const hv = location.hash.replace('#', '');
    go(VIEWS.some(v => v[0] === hv) || SUBVIEWS[hv] ? hv : (S.exam ? 'scan' : 'exams'));
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
    PAGECACHE.clear();
    await DB.setKV('currentExam', id);
    if (render) buildNav();
    await loadQueue();
  }

  function go(view) {
    if (S.cam && view !== 'scan') stopCamera();
    S.view = view;
    history.replaceState(null, '', '#' + view);
    $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === (SUBVIEWS[view] || view)));
    const v = $('#view'); v.innerHTML = '';
    const needExam = !['exams', 'template', 'import', 'settings', 'help'].includes(view);
    if (needExam && !S.exam) {
      v.appendChild(el('div', { class: 'card' }, el('h2', {}, 'No exam selected'), el('p', {}, 'Create or open an exam first.'), el('button', { class: 'btn primary', onclick: () => go('exams') }, 'Go to Exams')));
      return;
    }
    const fn = { exams: viewExams, template: viewTemplate, make: viewMake, import: viewImport, setup: viewSetup, print: viewPrint, scan: viewScan, review: viewReview, grade: viewGrade, results: viewResults, settings: viewSettings, help: viewHelp }[view];
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
  // any teacher change to a student's grading reopens an approved student as Draft
  function markDraft(stu) { if (stu && stu.status === 'approved') { stu.status = 'draft'; stu.reopenedAt = Date.now(); stu.approvedAt = null; } }
  // a teacher change to one written answer: it becomes teacher-graded, its flag is resolved, a queued AI job for it is dropped
  function teacherEdit(stu, qid) {
    stu.sa = stu.sa || {};
    const sa = stu.sa[qid];
    if (sa) { sa.source = 'teacher'; sa.edited = true; delete sa.flag; }
    markDraft(stu);
    dropJob(stu.id, qid);
  }
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

  function viewSetup(v, embedded) {
    const e = S.exam;
    const changed = S.scans.length && e.printedSig && e.printedSig !== geomSig(e.layout);
    if (!embedded) v.appendChild(el('div', { class: 'row between' }, el('h2', {}, 'Exam setup'), el('span', { id: 'saveState', class: 'muted small' }, 'Changes save automatically')));
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
    v.appendChild(keyCard());

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
        el('p', { class: 'small muted' }, 'Paste questions in the Exam template format. Start each question with its number ("1." or "1)"), each choice with a letter ("A.", "b)" or "(c)"). Mark the correct choice with * or "(correct)", or add "Answer: C" under the question or an "Answer key" list (1-B 2-C) at the end. Written questions start with "SA1." and may have Key:, Rubric: and Lines: lines. An answer key string (for example ABDCE...) overrides the marks.'),
        el('textarea', { id: 'bulkText', rows: 10, placeholder: '1. Which element has the highest electronegativity?\nA. Oxygen\n*B. Fluorine\nC. Chlorine\nD. Nitrogen' }),
        el('div', { class: 'row wrap' },
          el('input', { id: 'bulkKey', placeholder: 'Answer key string, e.g. ABDCE (optional)' }),
          el('label', { class: 'small' }, el('input', { type: 'checkbox', id: 'bulkReplace' }), ' Replace existing questions'),
          el('button', { class: 'btn primary', id: 'btnBulkAdd', onclick: () => {
            const qs = parseBulk($('#bulkText').value, $('#bulkKey').value);
            const sa = qs.sa || [];
            if (!qs.length && !sa.length) { toast('No questions recognised', 'bad'); return; }
            if ($('#bulkReplace').checked) e.mc = [...qs]; else e.mc.push(...qs);
            if (sa.length) { e.sa.push(...sa); renderSA(); }
            saveSoon(); renderMC(); toast(qs.length + ' questions added' + (sa.length ? `, ${sa.length} written` : ''));
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
              field('Typed model answer (optional)', inp(q, 'modelAnswer', { multiline: true, rows: 3, class: 'sa-model', placeholder: 'What a full-credit answer contains' }), 'Optional: supplements the model answer written in this box on the uploaded key'),
              field('Typed rubric (optional)', inp(q, 'rubric', { multiline: true, rows: 3, class: 'sa-rubric', placeholder: '2 pts correct product; 1 pt balanced; 1 pt units' }), 'Optional: points per element, one per line or separated by ;'))),
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
    if (!embedded) v.appendChild(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { await saveExam(); go('print'); } }, 'Continue to Print')));
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

  // Bulk paste: the Exam template importer's parser (template format, "1)" / "a)" / "(a)" variants, "*" or "(correct)",
  // "Answer: C" lines, an "Answer key" list); written questions ("SA1. ...") come back in .sa
  function parseBulk(text, keyStr) {
    const r = Maker.parse(text);
    if (r.sa.some(q => q.fromMC)) return parseBulkSimple(text, keyStr);   // keep choice-less items as MC rows, as before
    const ex = Maker.toExam({}, { mc: r.mc, sa: r.sa, fields: {} });
    ex.mc.forEach((q, i) => { if (r.mc[i].points === null) q.points = 1; });
    const k = String(keyStr || '').toUpperCase().replace(/[^A-E]/g, '');
    k.split('').forEach((c, i) => { if (ex.mc[i]) ex.mc[i].answer = c; });
    const qs = ex.mc; qs.sa = ex.sa;
    return qs;
  }
  function parseBulkSimple(text, keyStr) {
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
      el('button', { class: 'btn primary', id: 'btnTemplatePdf', onclick: () => downloadExamPdf() }, 'Download exam PDF'),
      el('button', { class: 'btn', id: 'btnKeyPdf', onclick: () => downloadKeyPdf() }, 'Download answer key PDF'),
      el('button', { class: 'btn', id: 'btnLayoutJson', onclick: () => U.download(new Blob([JSON.stringify({ exam: e.id, layout: lay }, null, 1)], { type: 'application/json' }), U.safeName(e.title) + ' - layout.json') }, 'Download layout manifest')));
    const prev = el('div', { class: 'thumbs', id: 'printPreview' }, el('p', { class: 'muted' }, 'Rendering preview...'));
    v.appendChild(el('div', { class: 'card' }, el('h3', {}, 'Preview'), prev));
    await renderTemplateThumbs(prev);
  }

  // shared by Print and Make exam
  async function downloadExamPdf() {
    const e = S.exam;
    await saveExam();
    const lay = L();
    const doc = Layout.buildPDF(e, lay, {});
    e.printedSig = geomSig(lay); await saveExam(false);
    U.download(doc.output('blob'), U.safeName(e.title) + ' - exam.pdf');
  }
  async function downloadKeyPdf() {
    await saveExam();
    const doc = Layout.buildPDF(S.exam, L(), { key: true });
    U.download(doc.output('blob'), U.safeName(S.exam.title) + ' - answer key.pdf');
  }
  let thumbJob = 0;
  async function renderTemplateThumbs(prev, scale = 0.55) {
    const job = ++thumbJob;
    try {
      const doc = Layout.buildPDF(S.exam, L(), {});
      const pdf = await pdfjsLib.getDocument({ data: doc.output('arraybuffer') }).promise;
      const figs = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const vp = page.getViewport({ scale });
        const c = CV.canvasOf(Math.round(vp.width), Math.round(vp.height));
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        figs.push(el('figure', { class: 'thumb' }, c, el('figcaption', {}, 'Page ' + p)));
        if (job !== thumbJob) return;
      }
      prev.innerHTML = ''; figs.forEach(f => prev.appendChild(f));
    } catch (err) { prev.innerHTML = ''; prev.appendChild(el('p', { class: 'warntext' }, 'Preview unavailable: ' + err.message)); }
  }

  // ---------------- Exam template: download a Word template, make an exam here, or upload an existing exam ----------------
  function aiImportOn() { return aiOn(); }
  function viewTemplate(v) {
    v.appendChild(el('h2', {}, 'Exam template'));
    v.appendChild(el('p', { class: 'muted' }, 'Start here. Type an exam in the app, or bring one you already have; either way you get a printable bubble exam that this app scans and grades.'));
    const status = el('div', { class: 'small', id: 'impStatus', role: 'status', 'aria-live': 'polite' });
    const up = el('input', { type: 'file', id: 'tplUpload', class: 'hidden', multiple: true, accept: '.docx,.pdf,.txt,.jpg,.jpeg,.png,application/pdf,text/plain,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      onchange: ev => { const f = Array.from(ev.target.files || []); ev.target.value = ''; if (f.length) importFiles(f, status); } });
    v.appendChild(el('div', { class: 'tplcards' },
      el('div', { class: 'card tplcard' },
        el('h3', {}, 'Download blank template'),
        el('p', { class: 'small' }, 'A Word file laid out the way the importer reads it: header fields, multiple-choice questions with the correct choice starred, and written questions with points, key, rubric and box size. Fill it in, then use Upload my exam.'),
        el('a', { class: 'btn', id: 'btnTplDocx', href: 'templates/exam-template.docx', download: 'Exam template.docx' }, 'Download template (.docx)')),
      el('div', { class: 'card tplcard' },
        el('h3', {}, 'Make exam'),
        el('p', { class: 'small' }, 'Type the questions, choices, correct answers and points here, watch the printed pages update, then print. The exam PDF and the answer key are generated for you.'),
        el('div', { class: 'row wrap' },
          el('button', { class: 'btn primary', id: 'btnMakeExam', onclick: async () => { const ex = newExam(); S.exam = ex; await saveExam(); await selectExam(ex.id); buildNav(); go('make'); } }, 'Make exam'),
          S.exam ? el('button', { class: 'btn', id: 'btnMakeCurrent', onclick: () => go('make') }, 'Edit "' + (S.exam.title || 'current exam').slice(0, 28) + '"') : null)),
      el('div', { class: 'card tplcard' },
        el('h3', {}, 'Upload my exam'),
        el('p', { class: 'small' }, 'Word (.docx), PDF, text, or photos of the pages. The questions are copied into the template; you check them before the exam is created. Figures are not copied.'),
        el('label', { class: 'btn primary', for: 'tplUpload' }, 'Upload my exam', up),
        el('p', { class: 'small muted' }, aiImportOn() ? 'AI reading is on: scanned pages and unusual layouts are read with Gemini through your server.' : 'Scanned pages and unusual layouts need AI reading (Settings > AI). Typed documents in the template format work without it.'),
        status)));
  }

  async function importFiles(files, status) {
    const say = t => { if (status) status.textContent = t; };
    try {
      say('Reading ' + files.map(f => f.name).join(', ') + '...');
      const src = await Maker.readFiles(files, say);
      const det = Maker.parse(src.text);
      docWarnings(det, src);
      S.imp = { src, det, res: det, ai: null, aiError: '', busy: '' };
      const n = det.mc.length + det.sa.length;
      const loose = det.skipped.filter(x => x.why !== 'before the first question').length;
      const incomplete = n === 0 || src.scanned > 0 || loose >= 5 || (det.mc.length > 0 && det.mc.filter(q => q.choices.length < 2).length > det.mc.length / 2);
      S.imp.incomplete = incomplete;
      say('');
      go('import');
      if (incomplete && aiImportOn()) await runAiImport();
    } catch (err) { console.error(err); say('Could not read the file: ' + err.message); toast('Could not read the file', 'bad'); }
  }
  function docWarnings(res, src) {
    if (src.figures) res.warnings.push({ level: 'warn', msg: `The document contains ${src.figures} picture(s) or figure(s). Figures are not copied; add them by hand.` });
    if (src.scanned && res.source !== 'ai') res.warnings.push({ level: 'warn', msg: `${src.scanned} page(s) are images without a text layer (scans or photos). They can only be read with AI reading` + (aiImportOn() ? '.' : ' (Settings > AI grading > tick the box).') });
  }
  async function runAiImport() {
    const imp = S.imp; if (!imp || imp.busy) return;
    const st = S.settings, ai = st.ai;
    imp.busy = 'Starting AI reading...'; imp.aiError = '';
    const upd = t => { imp.busy = t; const b = $('#impAiStatus'); if (b) b.textContent = t; };
    if (S.view === 'import') go('import');
    try {
      if (!AI.modelOf(ai)) {
        upd('Loading the model list...');
        const r = await AI.post(st.cloudUrl, st.cloudToken, { action: 'aiModels' });
        if (!r.ok) throw new Error(r.error || 'Could not load models');
        ai.models = r.models || []; await saveSettings();
      }
      const res = await Maker.aiRead(imp.src, { post: p => AI.post(st.cloudUrl, st.cloudToken, p), model: AI.modelOf(ai), rpm: ai.rpm, onStatus: upd });
      docWarnings(res, imp.src);
      imp.ai = res; imp.res = res;
    } catch (err) { console.error(err); imp.aiError = err.message; }
    imp.busy = '';
    if (S.view === 'import') go('import');
  }

  function viewImport(v) {
    const imp = S.imp;
    if (!imp) { go('template'); return; }
    const r = imp.res, L_ = Maker.LET;
    const nKey = r.mc.filter(q => q.correct !== null && q.correct !== undefined).length;
    const warns = r.warnings.filter(w => w.level !== 'info'), infos = r.warnings.filter(w => w.level === 'info');
    v.appendChild(el('h2', {}, 'Check the imported questions'));
    v.appendChild(el('div', { class: 'card', id: 'impSummary' },
      el('p', {}, el('strong', {}, imp.src.name), el('span', { class: 'muted' }, ' | read by ' + (r.source === 'ai' ? `AI (Gemini, ${r.requests} request${r.requests > 1 ? 's' : ''}): compare with your document` : 'the document parser'))),
      el('p', { id: 'impCounts' }, `${r.mc.length} multiple choice (${nKey} with the correct answer), ${r.sa.length} written.`),
      imp.busy ? el('p', { class: 'warntext', id: 'impAiStatus' }, imp.busy) : null,
      imp.aiError ? el('p', { class: 'warntext', id: 'impAiError' }, 'AI reading failed: ' + imp.aiError) : null,
      !aiImportOn() && imp.incomplete ? el('p', { class: 'small muted' }, 'Some of this document could not be read automatically. Turn on AI reading in Settings (Apps Script server with a Gemini key) to read scans and unusual layouts, or fix the document using the blank template format.') : null,
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnImpCreate', disabled: !(r.mc.length + r.sa.length) || !!imp.busy, onclick: () => createFromImport() }, 'Create exam from this'),
        aiImportOn() ? el('button', { class: 'btn', id: 'btnImpAI', disabled: !!imp.busy, onclick: () => runAiImport() }, imp.ai ? 'Read again with AI' : 'Use AI to read my exam') : null,
        imp.ai && r.source === 'ai' ? el('button', { class: 'btn', id: 'btnImpParser', onclick: () => { imp.res = imp.det; go('import'); } }, 'Show document parser result') : null,
        imp.ai && r.source !== 'ai' ? el('button', { class: 'btn', id: 'btnImpShowAI', onclick: () => { imp.res = imp.ai; go('import'); } }, 'Show AI result') : null,
        el('button', { class: 'btn', onclick: () => go('template') }, 'Choose another file'))));
    if (warns.length || infos.length || r.skipped.length) {
      v.appendChild(el('div', { class: 'card ' + (warns.length ? 'warn' : ''), id: 'impWarnings' },
        el('h3', {}, warns.length ? `Check these (${warns.length})` : 'Notes'),
        el('ul', { class: 'warnlist' }, [...warns, ...infos].map(w => el('li', { class: w.level === 'info' ? 'muted' : '' }, w.msg, w.raw ? el('div', { class: 'rawtext' }, w.raw) : null))),
        r.skipped.length ? el('details', { id: 'impSkipped' }, el('summary', {}, `Text not imported (${r.skipped.length} line${r.skipped.length > 1 ? 's' : ''}): check that no question is in it`),
          el('ul', { class: 'warnlist' }, r.skipped.map(x => el('li', {}, el('span', { class: 'rawtext' }, x.raw), el('span', { class: 'muted small' }, ' (' + x.why + ')'))))) : null));
    }
    const mcBox = el('div', { class: 'card', id: 'impMC' }, el('h3', {}, `Multiple choice (${r.mc.length})`));
    r.mc.forEach((q, i) => {
      mcBox.appendChild(el('div', { class: 'impq', 'data-i': i },
        el('div', { class: 'qnum' }, (i + 1) + '.'),
        el('div', { class: 'qbody' },
          el('div', { class: 'impstem' }, q.stem || el('em', { class: 'muted' }, '(no question text)'), q.points ? el('span', { class: 'muted small' }, ` (${U.fmt(q.points)} pt${q.points === 1 ? '' : 's'})`) : null),
          el('ol', { class: 'impchoices' }, q.choices.map((c, k) => el('li', { class: 'impchoice' + (k === q.correct ? ' correct' : '') + (k >= 5 ? ' over' : '') },
            el('span', { class: 'bub' }, L_[k] || '?'), el('span', {}, c), k === q.correct ? el('strong', { class: 'oktext' }, ' correct') : null))),
          q.correct === null || q.correct === undefined ? el('div', { class: 'warntext small nokey' }, 'Correct answer not marked') : null)));
    });
    v.appendChild(mcBox);
    const saBox = el('div', { class: 'card', id: 'impSA' }, el('h3', {}, `Written (${r.sa.length})`));
    r.sa.forEach((q, i) => {
      saBox.appendChild(el('div', { class: 'impq sa', 'data-i': i },
        el('div', { class: 'qnum' }, 'SA' + (i + 1)),
        el('div', { class: 'qbody' },
          el('div', { class: 'impstem' }, q.prompt || el('em', { class: 'muted' }, '(no prompt)')),
          el('div', { class: 'small muted' }, [`${q.points ? U.fmt(q.points) : '5 (default)'} points`, `box ${q.lines || '6 (default)'} lines`].join(' | ')),
          q.key ? el('div', { class: 'small' }, el('strong', {}, 'Key: '), q.key) : null,
          q.rubric ? el('div', { class: 'small' }, el('strong', {}, 'Rubric: '), q.rubric) : null)));
    });
    v.appendChild(saBox);
  }
  async function createFromImport() {
    const imp = S.imp; if (!imp) return;
    const ex = Maker.toExam(newExam(), imp.res);
    S.exam = ex; await saveExam(); await selectExam(ex.id); buildNav();
    toast(`Exam created: ${ex.mc.length} multiple choice, ${ex.sa.length} written`, 'good');
    go('make');
  }

  async function viewMake(v) {
    const e = S.exam;
    const pfBox = el('div', { class: 'small', id: 'makePreflight' });
    const prev = el('div', { class: 'thumbs', id: 'makePreview' }, el('p', { class: 'muted' }, 'Rendering preview...'));
    const refresh = async () => {
      await saveExam();
      const lay = L(), pf = lay.preflight, miss = e.mc.filter(q => !q.answer).length;
      pfBox.className = 'small ' + (pf.ok ? 'oktext' : 'warntext');
      pfBox.textContent = `${lay.pageCount} pages, ${e.mc.length} multiple choice, ${e.sa.length} written. ` + (pf.ok ? 'Preflight passed.' : 'Preflight found problems: ' + pf.messages.slice(0, 3).join('; ')) + (miss ? ` ${miss} question(s) have no correct answer.` : '');
      prev.appendChild(el('p', { class: 'muted small' }, 'Updating...'));
      await renderTemplateThumbs(prev, 0.5);
    };
    v.appendChild(el('div', { class: 'card makebar' },
      el('div', { class: 'row between' }, el('h2', { class: 'nomargin' }, 'Make exam'), el('span', { id: 'saveState', class: 'muted small' }, 'Changes save automatically')),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnMakePrint', onclick: () => downloadExamPdf() }, 'Print / download exam PDF'),
        el('button', { class: 'btn', id: 'btnMakeKey', onclick: () => downloadKeyPdf() }, 'Download answer key PDF'),
        el('button', { class: 'btn', id: 'btnMakeRefresh', onclick: refresh }, 'Refresh preview')),
      pfBox));
    const left = el('div', { class: 'makeedit' });
    const right = el('div', { class: 'makeprev' }, el('div', { class: 'card' }, el('h3', {}, 'Printed pages'), prev));
    v.appendChild(el('div', { class: 'makegrid' }, left, right));
    viewSetup(left, true);
    await refresh();
  }

  // ---------------- Scan ----------------
  function viewScan(v) {
    const lay = L();
    v.appendChild(el('div', { class: 'row between' }, el('h2', {}, 'Scan pages'), el('span', { class: 'muted small' }, `${lay.pageCount} pages per student`)));
    v.appendChild(keyCard());
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
      el('h3', {}, 'Upload student scans'),
      el('p', { class: 'small muted' }, 'PDF files from a scanner or photos of pages. Each file may hold one student or a whole class; a cover page starts a new student. Grading starts automatically.'),
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
      idIn.onchange = async () => { stu.idOverride = idIn.value.trim(); markDraft(stu); await saveStudent(stu); renderGroups(); };
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
      card.addEventListener('drop', async ev => { ev.preventDefault(); card.classList.remove('drop'); const id = ev.dataTransfer.getData('text/plain'); const sc = S.scans.find(s => s.id === id); if (sc) { markDraft(S.students.find(x => x.id === sc.studentId)); markDraft(stu); await DB.putMany('students', S.students); sc.studentId = stu.id; await DB.put('scans', sc); renderGroups(); afterIngest(); } });
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
      markDraft(S.students.find(x => x.id === s.studentId)); markDraft(S.students.find(x => x.id === id)); await DB.putMany('students', S.students);
      s.studentId = id || null; await DB.put('scans', s); renderGroups(); afterIngest();
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

  // decode every page of a PDF or image file and call fn(drawable, width, height, label)
  async function eachPage(f, p, fn) {
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
        await fn(c, c.width, c.height, f.name + ' p' + i, i - 1);
        page.cleanup();
        await U.sleep(0);
      }
      pdf.destroy();
    } else {
      if (p) p.textContent = `${f.name}`;
      const bm = await U.blobToImage(f);
      await fn(bm, bm.width, bm.height, f.name, null);
      if (bm.close) bm.close();
    }
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
        await eachPage(f, p, async (src, w, h, label, idx) => {
          batch.push(await makeScan(src, w, h, batchSeq, idx === null ? batch.length : idx, label));
        });
      }
      await commitBatch(batch, true);
      total += batch.length;
    }
    if (p) p.textContent = `Processed ${total} page(s).`;
    toast(`Processed ${total} page(s)`);
    renderGroups();
    await afterIngest(true);
  }

  // automatic pipeline after new pages: multiple choice is graded on the fly (OMR + key); written answers go to the AI queue
  async function afterIngest(announce) {
    if (!S.exam) return;
    const n = enqueueMissing();
    const nStu = S.students.length;
    if (announce && nStu) {
      const ungraded = S.students.reduce((a, s) => a + gradeOf(s).ungraded, 0);
      if (n) toast(`${nStu} student(s): multiple choice graded. AI is grading ${n} written answer(s) in the background.`, 'good');
      else if (ungraded && S.exam.sa.length) toast(`${nStu} student(s): multiple choice graded. ${ungraded} written answer(s) need grading${aiOn() ? '' : ' (AI grading is off)'}.`);
      else toast(`${nStu} student(s) graded. Review on Results, then approve.`, 'good');
    }
    autoApproveSoon(S.students);
  }

  async function commitBatch(batch, fileMode) {
    const good = batch.filter(s => s.ok && s.page && !s.foreign);
    const last = S.students.slice().sort((a, b) => b.key - a.key)[0];
    const created = Grade.group(good, S.students, fileMode ? (last && last.id) : (S.session.studentId || (last && last.id)), S.exam.id, nextKey());
    for (const st of created) { S.students.push(st); await saveStudent(st); }
    for (const s of batch) { S.scans.push(s); await DB.put('scans', s); }
    return created;
  }

  // ---------------- Answer key upload (a filled copy of the exam: shaded bubbles + model answer and rubric in each box) ----------------
  function keyCard() {
    const card = el('div', { class: 'card keycard', id: 'keyCard' },
      el('h3', {}, 'Answer key'),
      el('p', { class: 'small muted' }, 'Print a blank copy of the exam, shade the correct bubbles, and write (or type onto the PDF) the model answer and the rubric with points per element inside each written-answer box. Upload that copy here (PDF or photos, any page order). It is read as the answer key, never as a student. Uploading a new key regrades everything.'),
      el('div', { class: 'row wrap' },
        el('label', { class: 'btn primary', id: 'btnUploadKey' }, 'Upload key',
          el('input', { type: 'file', id: 'keyInput', multiple: true, accept: 'application/pdf,image/*', class: 'hidden', onchange: ev => {
            const files = Array.from(ev.target.files); ev.target.value = '';
            ingestKey(files).catch(err => { console.error(err); const p = $('#keyProgress'); if (p) p.textContent = 'Error: ' + err.message; toast('Key upload failed: ' + err.message, 'bad'); });
          } })),
        el('span', { class: 'small muted', id: 'keyProgress' })),
      el('div', { id: 'keySummary' }));
    renderKeySummary(card.querySelector('#keySummary'));
    return card;
  }

  function keyFlags(e) {
    const ks = e.keyScan; if (!ks) return [];
    return e.mc.map((q, i) => ({ q, i, r: ks.mc[q.id] })).filter(x => x.r && x.r.status !== 'single' && !x.r.confirmed);
  }

  function renderKeySummary(box) {
    box = box || $('#keySummary'); if (!box) return;
    box.innerHTML = '';
    const e = S.exam, ks = e.keyScan, lay = L();
    const keyStr = e.mc.map(q => q.answer || '?').join('');
    const grouped = keyStr.replace(/(.{5})(?=.)/g, '$1 ');
    if (!ks) {
      box.appendChild(el('p', { class: 'small' }, 'No key uploaded yet. Multiple choice uses the answers set in Setup', e.mc.length ? ': ' : '.', e.mc.length ? el('code', { id: 'keyString' }, grouped) : null,
        e.sa.length ? '. Written answers use the typed model answer and rubric only.' : ''));
      return;
    }
    const nRead = e.mc.filter(q => ks.mc[q.id] && ks.mc[q.id].status === 'single').length;
    const flags = keyFlags(e);
    box.appendChild(el('div', { class: 'small' }, el('strong', {}, 'Multiple-choice key: '), el('code', { id: 'keyString' }, grouped)));
    box.appendChild(el('p', { class: 'small muted', id: 'keyStats' }, `Read from the key copy (${new Date(ks.at).toLocaleString()}): ${nRead} of ${e.mc.length} answers read from the shaded bubbles; key pages ${ks.pages.join(', ') || 'none'}.` + (flags.length ? ` ${flags.length} need your confirmation.` : '')));
    if (flags.length) {
      const fl = el('div', { class: 'keyflags', id: 'keyFlags' });
      flags.forEach(({ q, i, r }) => {
        const why = r.status === 'missing' ? 'page not in the key upload' : r.status === 'blank' ? 'no bubble shaded' : r.status === 'multiple' ? `several bubbles shaded (${r.marked.join(', ')})` : `unclear mark (${(r.marked || []).join(', ') || 'light'})`;
        fl.appendChild(el('div', { class: 'keyflag', 'data-q': i + 1 },
          el('div', { class: 'small' }, el('strong', {}, `Question ${i + 1}: `), why, '. Current key: ', el('strong', {}, q.answer || 'none')),
          r.crop ? el('img', { class: 'keycrop', src: r.crop, alt: `Key copy of question ${i + 1}` }) : null,
          el('div', { class: 'row wrap tight' }, q.choices.map((c, k) => el('button', { class: 'btn small' + (q.answer === Layout.LETTERS[k] ? ' primary' : ''), 'data-key-choice': Layout.LETTERS[k], onclick: async () => {
            q.answer = Layout.LETTERS[k]; r.confirmed = q.answer; await saveExam(false); keyChanged('Key for question ' + (i + 1) + ' confirmed', false);
          } }, Layout.LETTERS[k])))));
      });
      box.appendChild(el('div', { class: 'card warn' }, el('h3', {}, 'Confirm these key answers'), fl));
    }
    if (e.sa.length) {
      box.appendChild(el('div', { class: 'keythumbs', id: 'keyThumbs' }, e.sa.map((q, i) => {
        const k = ks.sa[q.id];
        return el('figure', { class: 'keythumb', 'data-sa': i + 1 },
          k ? el('img', { src: 'data:image/jpeg;base64,' + k.b64, alt: `Key and rubric for SA${i + 1}` }) : el('div', { class: 'nothumb' }, 'no key image'),
          el('figcaption', {}, `SA${i + 1} (${U.fmt(q.max)} pts)` + (k ? '' : ': not in the key upload; typed key only')));
      })));
    }
    if ((ks.warnings || []).length) box.appendChild(el('ul', { class: 'warnlist small', id: 'keyWarnings' }, ks.warnings.map(w => el('li', {}, w))));
  }

  async function ingestKey(files) {
    if (!files.length) return;
    const p = $('#keyProgress');
    const lay = L(), e = S.exam;
    const got = {}, warnings = [];
    for (const f of files) {
      await eachPage(f, p, async (src, w, h, label) => {
        const res = CV.processSource(src, w, h);
        if (!res.ok) { warnings.push(`${label}: ${res.reason}`); return; }
        if (!res.page) { warnings.push(`${label}: page code unreadable`); return; }
        if (res.hash !== lay.hash) { warnings.push(`${label}: belongs to a different exam or version`); return; }
        if (res.page > lay.pageCount) { warnings.push(`${label}: page number beyond this exam`); return; }
        if (got[res.page]) { warnings.push(`${label}: page ${res.page} appears twice; the first copy is used`); return; }
        const c = CV.canvasOf(Layout.RW, Layout.RH);
        c.getContext('2d').putImageData(res.rect, 0, 0);
        got[res.page] = { c, rg: res.rg };
      });
    }
    if (p) p.textContent = 'Reading the key...';
    const ks = { at: Date.now(), pages: Object.keys(got).map(Number).sort((a, b) => a - b), mc: {}, sa: {}, warnings };
    for (const [pg, { c, rg }] of Object.entries(got)) {
      const pn = +pg;
      if (lay.mc.some(q => q.page === pn)) {
        const a = CV.analyzePage(rg, lay, pn, S.settings.omr);
        for (const [qid, r] of Object.entries(a.mc)) {
          const lq = lay.mc.find(m => m.qid === qid);
          const rec = { status: r.status, choice: r.choice, marked: r.marked, ds: r.ds };
          if (r.status !== 'single') rec.crop = cropCanvas(c, 11, lq.top - 1.5, 185, lq.h + 1, 0.6).toDataURL('image/jpeg', 0.75);
          ks.mc[qid] = rec;
        }
      }
      lay.sa.filter(sq => sq.page === pn).forEach(lq => { ks.sa[lq.qid] = AI.boxCrop(c, lq); });
    }
    const missingPages = [];
    for (let pn = 2; pn <= lay.pageCount; pn++) if (!got[pn]) missingPages.push(pn);
    if (missingPages.length) warnings.push(`Key page(s) ${missingPages.join(', ')} not found in the upload.`);
    e.mc.forEach(q => {
      if (!ks.mc[q.id]) ks.mc[q.id] = { status: 'missing', choice: null, marked: [] };
      const r = ks.mc[q.id];
      if (r.status === 'single') q.answer = r.choice;
    });
    e.keyScan = ks;
    await saveExam(false);
    const nRead = e.mc.filter(q => ks.mc[q.id].status === 'single').length;
    if (p) p.textContent = `Key read: ${nRead} of ${e.mc.length} multiple-choice answers, ${Object.keys(ks.sa).length} of ${e.sa.length} written-answer keys.`;
    keyChanged('Answer key uploaded');
  }

  // a new or corrected key regrades everything: MC is recomputed on the fly, AI-graded written answers are re-queued
  async function keyChanged(msg, regradeSA = true) {
    let reopened = 0;
    for (const stu of S.students) { if (stu.status === 'approved') { markDraft(stu); reopened++; await saveStudent(stu); } }
    let n = 0;
    if (regradeSA && aiOn()) {
      const pairs = [];
      S.students.forEach(stu => S.exam.sa.forEach(q => { if (!isTeacher(stu.sa && stu.sa[q.id]) && saPage(stu, q).scan) pairs.push([stu, q]); }));
      n = enqueue(pairs, true);
      runQueue();
    }
    renderKeySummary();
    if (S.view === 'results') refreshDash();
    toast(msg + (S.students.length ? `. Multiple choice regraded${n ? `; AI is regrading ${n} written answer(s)` : ''}${reopened ? `; ${reopened} approved student(s) set back to Draft` : ''}.` : '.'), 'good');
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
      afterIngest(false);
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
            crop, el('div', { class: 'row' }, idIn, el('button', { class: 'btn primary', onclick: async () => { stu.idOverride = idIn.value.trim(); markDraft(stu); await saveStudent(stu); render(); } }, 'Confirm ID'))));
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
            q.choices.map((c, k) => el('button', { class: 'btn choicebtn' + (r.answer === Layout.LETTERS[k] ? ' primary' : ''), 'data-choice': Layout.LETTERS[k], onclick: async () => { stu.mcOverride[q.id] = Layout.LETTERS[k]; markDraft(stu); await saveStudent(stu); render(); } }, Layout.LETTERS[k])),
            el('button', { class: 'btn', 'data-choice': 'BLANK', onclick: async () => { stu.mcOverride[q.id] = 'BLANK'; markDraft(stu); await saveStudent(stu); render(); } }, 'Blank'),
            el('button', { class: 'btn', 'data-choice': 'MULTI', onclick: async () => { stu.mcOverride[q.id] = 'MULTI'; markDraft(stu); await saveStudent(stu); render(); } }, 'Multiple (wrong)'));
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

  // ---------------- Grade (written answers): review and correct the automatic grades ----------------
  const GS = { mode: 'question', q: 0, stu: 0, tool: 'pen', focus: null };
  async function viewGrade(v) {
    const e = S.exam;
    v.appendChild(el('h2', {}, 'Written answers'));
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
    modeSel.onchange = () => { GS.mode = modeSel.value; go('grade'); };
    pick.onchange = () => { if (GS.mode === 'question') GS.q = +pick.value; else GS.stu = +pick.value; renderList(); };
    let token = 0;
    const renderList = async () => {
      const my = ++token;
      list.innerHTML = '';
      aiBox.innerHTML = '';
      aiBox.appendChild(gradeInfoBar(studs));
      const pairs = GS.mode === 'question' ? studs.map(s => [s, e.sa[GS.q]]) : e.sa.map(q => [studs[GS.stu], q]);
      for (const [stu, q] of pairs) {
        const item = await gradeItem(stu, q, studs);
        if (my !== token) return;
        list.appendChild(item);
      }
      if (GS.focus) {
        const f = list.querySelector(`.gradeitem[data-stu="${GS.focus.stu}"][data-sa="${GS.focus.sa}"]`);
        GS.focus = null;
        if (f) { f.classList.add('focus'); f.scrollIntoView({ block: 'center' }); }
      }
    };
    await renderList();
  }

  function gradeInfoBar(studs) {
    const box = el('div', { class: 'card aibar small', id: 'aiBar' });
    if (!aiOn()) {
      box.appendChild(el('p', {}, aiReady() ? 'Automatic AI grading is off (Settings > AI grading). Grade the written answers here.' : 'Written answers are graded by AI automatically once the Apps Script server and AI grading are set up in Settings. Until then, grade them here.'));
      return box;
    }
    box.appendChild(el('p', {}, 'Written answers are graded automatically by AI as drafts (marks and points in red). Change anything you like: your changes mark the item as teacher-graded. Flagged items are listed under Results > Needs attention.'));
    if (GS.mode === 'question') {
      const q = S.exam.sa[GS.q];
      box.appendChild(el('div', { class: 'row wrap' }, el('button', { class: 'btn small', id: 'btnAiRerunQ', onclick: () => {
        if (!confirm(`Re-run AI on SA${GS.q + 1} for all students? Teacher grades on this question are replaced.`)) return;
        const n = enqueue(studs.filter(s => saPage(s, q).scan).map(s => [s, q]), true); runQueue(); toast(`${n} answer(s) queued for AI`);
        go('grade');
      } }, 'Re-run AI on this question (all students)')));
    }
    return box;
  }

  async function gradeItem(stu, q, studs, opts = {}) {
    const e = S.exam, lay = L();
    const lq = lay.sa.find(s => s.qid === q.id);
    const qi = e.sa.indexOf(q);
    const g0 = gradeOf(stu);
    const scan = g0.pages[lq.page];
    const card = el('div', { class: 'card gradeitem', 'data-stu': stu.id, 'data-sa': qi + 1 });
    const badges = el('span', { class: 'row tight wrap badges' });
    card.appendChild(el('div', { class: 'row between wrap' }, el('strong', {}, `Student ${studs.indexOf(stu) + 1} ${g0.id ? '(' + g0.id + ')' : ''} ${g0.name || ''} - SA${qi + 1}`), el('span', { class: 'row tight wrap' }, badges, el('span', { class: 'ptsnow muted' }, ''))));
    if (!scan) { card.appendChild(el('p', { class: 'warntext' }, `Page ${lq.page} has not been scanned for this student.`)); return card; }
    const im = await imgOf(scan);
    const PX = Layout.PX, R = lq.region;
    const cv = CV.canvasOf(Math.round(R.w * PX), Math.round(R.h * PX));
    cv.className = 'inkcanvas';
    card.appendChild(cv);
    stu.sa = stu.sa || {}; stu.ink = stu.ink || {};
    const sa = stu.sa[q.id] = stu.sa[q.id] || { pts: null, comments: [], note: '' };
    const drawBadges = () => {
      badges.innerHTML = '';
      const r = gradeOf(stu).sa[q.id];
      const queued = Q.jobs.some(j => j.stu === stu.id && j.q === q.id);
      if (queued) badges.appendChild(el('span', { class: 'badge mid srcbadge', 'data-src': 'queued' }, 'Queued for AI'));
      if (r.pts === null) badges.appendChild(el('span', { class: 'badge bad srcbadge', 'data-src': 'none' }, r.flag === 'error' ? 'AI failed: needs grading' : 'Needs grading'));
      else badges.appendChild(el('span', { class: 'badge srcbadge' + (r.source === 'ai' ? ' ai' : ''), 'data-src': r.source }, r.source === 'ai' ? 'AI' : 'Teacher'));
      if (r.flag === 'low') badges.appendChild(el('span', { class: 'badge bad flagbadge' }, 'Low confidence'));
      if (r.flag === 'illegible') badges.appendChild(el('span', { class: 'badge bad flagbadge' }, 'Illegible or blank'));
    };
    const redraw = async () => {
      const full = CV.canvasOf(Layout.RW, Layout.RH);
      const g = gradeOf(stu);
      await Annot.renderPage(im, e, lay, g, stu, lq.page, { canvas: full });
      cv.getContext('2d').drawImage(full, R.x * PX, R.y * PX, cv.width, cv.height, 0, 0, cv.width, cv.height);
      card.querySelector('.ptsnow').textContent = sa.pts === null || sa.pts === undefined ? 'not graded' : `${U.fmt(sa.pts)} / ${U.fmt(q.max)}`;
      drawBadges();
    };
    // every teacher action: teacher-edited, back to Draft if approved
    const save = async () => { teacherEdit(stu, q.id); await saveStudent(stu); markSaved(); await redraw(); refreshDash(); };
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
      el('button', { class: 'btn small', onclick: async () => { if (!confirm('Clear all ink on this answer?')) return; stu.ink[lq.page] = (stu.ink[lq.page] || []).filter(k => k.q !== q.id); await save(); } }, 'Clear ink'),
      aiReady() ? el('button', { class: 'btn small airerun', onclick: async () => {
        enqueue([[stu, q]], true); await runQueue(); drawBadges(); toast('Queued for AI');
      } }, 'Re-run AI on this question') : null);
    if (sa.source === 'ai' && sa.aiRes) {
      const a = sa.aiRes;
      card.appendChild(el('div', { class: 'aipanel small', 'data-conf': a.confidence },
        el('div', {}, el('strong', {}, `AI draft: ${U.fmt(sa.pts)} / ${U.fmt(q.max)}`), ` (${a.legible === false ? 'illegible or blank' : a.confidence + ' confidence'}${a.model ? ', ' + a.model : ''})`),
        (a.rubricItems || []).length ? el('ul', { class: 'rubriclist' }, a.rubricItems.map(r => el('li', {}, `${r.item}: ${U.fmt(r.earned)} / ${U.fmt(r.max)}`))) : null));
    }
    card.appendChild(el('div', { class: 'label small muted' }, 'Points'));
    card.appendChild(ptsRow);
    card.appendChild(chips);
    card.appendChild(note);
    card.appendChild(inkTools);
    await redraw();
    return card;
  }

  // ---------------- Automatic AI grading queue (Gemini through the Apps Script server) ----------------
  // Runs in the background across views; its job list is stored so it resumes after a reload.
  const Q = { examId: null, jobs: [], total: 0, done: 0, running: false, pause: false, msg: '', blocked: '', finished: '' };
  function aiReady() { const st = S.settings; return !!(st.cloudUrl && st.cloudToken); }
  function aiOn() { return !!(S.settings.ai && S.settings.ai.enabled && aiReady()); }
  function presetsOf(q) { return Array.from(new Set([...(q.comments || []), ...(S.exam.comments || [])])); }
  function saPage(stu, q) { const lq = L().sa.find(s => s.qid === q.id); return { lq, scan: lq ? gradeOf(stu).pages[lq.page] : null }; }
  function isTeacher(g) { return !!g && g.pts !== null && g.pts !== undefined && g.pts !== '' && (g.source === 'teacher' || (!g.source && g.ai !== 'accepted')); }
  function needsAI(stu, q) {
    const g = stu.sa && stu.sa[q.id];
    if (g && g.pts !== null && g.pts !== undefined && g.pts !== '') return false;   // graded (AI or teacher)
    if (g && g.flag === 'error') return false;                                        // AI failed: the teacher grades it
    return !!saPage(stu, q).scan;
  }
  async function rerenderCard(stu, q, studs, opts = {}) {
    const old = document.querySelector(`.gradeitem[data-stu="${stu.id}"][data-sa="${S.exam.sa.indexOf(q) + 1}"]`);
    if (!old) return null;
    const n = await gradeItem(stu, q, studs, opts);
    old.replaceWith(n);
    return n;
  }

  async function loadQueue() {
    if (!S.exam) return;
    const d = await DB.getKV('aiq:' + S.exam.id, null);
    Object.assign(Q, { examId: S.exam.id, jobs: (d && d.jobs) || [], total: (d && d.total) || 0, done: (d && d.done) || 0, pause: false, msg: '', blocked: '', finished: '' });
    if (!Q.jobs.length) { Q.total = 0; Q.done = 0; }
    renderQ();
    if (Q.jobs.length) runQueue();
  }
  function persistQ() { if (Q.examId) return DB.setKV('aiq:' + Q.examId, { jobs: Q.jobs, total: Q.total, done: Q.done }); }
  function enqueue(pairs, force) {
    if (!S.exam || Q.examId !== S.exam.id) return 0;
    let n = 0;
    if (!Q.jobs.length) { Q.total = 0; Q.done = 0; }
    for (const [stu, q] of pairs) {
      const ex = Q.jobs.find(j => j.stu === stu.id && j.q === q.id);
      if (ex) { if (force) ex.force = true; continue; }
      Q.jobs.push({ stu: stu.id, q: q.id, force: !!force, n: 0 }); n++;
    }
    Q.total += n; Q.finished = '';
    persistQ(); renderQ();
    return n;
  }
  function dropJob(stuId, qid) {
    const i = Q.jobs.findIndex(j => j.stu === stuId && j.q === qid);
    if (i > 0 || (i === 0 && !Q.inflight)) { Q.jobs.splice(i, 1); Q.total = Math.max(Q.done, Q.total - 1); persistQ(); renderQ(); }
    else if (i === 0) Q.jobs[0].cancel = true;
  }
  function enqueueMissing() {
    if (!aiOn() || !S.exam) return 0;
    const pairs = [];
    S.students.forEach(stu => S.exam.sa.forEach(q => { if (needsAI(stu, q)) pairs.push([stu, q]); }));
    const n = enqueue(pairs, false);
    runQueue();
    return n;
  }

  function renderQ() {
    const box = $('#aiq'); if (!box) return;
    box.innerHTML = '';
    const active = Q.jobs.length > 0;
    if (!active && !Q.finished) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (!active) {
      box.appendChild(el('div', { class: 'aiqrow' }, el('span', { id: 'aiqText' }, Q.finished),
        el('button', { class: 'btn small', onclick: () => go('results') }, 'Results'),
        el('button', { class: 'btn small', id: 'aiqHide', onclick: () => { Q.finished = ''; renderQ(); } }, 'Hide')));
      return;
    }
    const why = !aiOn() ? 'paused: AI grading is off or the server is not set up (Settings)' : Q.blocked ? Q.blocked : Q.pause ? 'paused' : Q.msg;
    box.appendChild(el('div', { class: 'aiqrow' },
      el('span', { id: 'aiqText' }, `AI grading written answers: ${Q.done} of ${Q.total}`),
      el('progress', { id: 'aiqProg', max: Math.max(1, Q.total), value: Q.done }),
      el('span', { class: 'small aiqmsg', id: 'aiqMsg' }, why || ''),
      (Q.pause || Q.blocked) ? el('button', { class: 'btn small', id: 'aiqResume', onclick: () => { Q.pause = false; Q.blocked = ''; renderQ(); runQueue(); } }, 'Resume')
        : el('button', { class: 'btn small', id: 'aiqPause', onclick: () => { Q.pause = true; Q.msg = 'Pausing after the current answer...'; renderQ(); } }, 'Pause')));
  }
  const setQ = t => { Q.msg = t; const m = $('#aiqMsg'); if (m && !Q.blocked && !Q.pause) m.textContent = t; };

  async function runQueue() {
    if (Q.running || !Q.jobs.length || !aiOn() || Q.pause || Q.blocked) { renderQ(); return; }
    const st = S.settings, ai = st.ai, examId = Q.examId;
    Q.running = true;
    let errorsInRow = 0;
    const studs = () => S.students.slice().sort((a, b) => a.key - b.key);
    try {
      if (!ai.models.length && !ai.model) {
        setQ('Loading models...');
        const r = await AI.post(st.cloudUrl, st.cloudToken, { action: 'aiModels' });
        if (!r.ok) { Q.blocked = 'Could not load models: ' + r.error; return; }
        ai.models = r.models; await saveSettings();
      }
      const model = AI.modelOf(ai);
      if (!model) { Q.blocked = 'No Gemini model available.'; return; }
      const cap = () => Math.max(1, +ai.dailyCap || AI.DEFAULTS.dailyCap);
      let warned = false;
      const retries = new Map();
      while (Q.jobs.length && !Q.pause && aiOn() && S.exam && S.exam.id === examId) {
        const job = Q.jobs[0];
        const stu = S.students.find(s => s.id === job.stu), q = S.exam.sa.find(x => x.id === job.q);
        const skip = () => { Q.jobs.shift(); Q.total = Math.max(Q.done, Q.total - 1); persistQ(); renderQ(); };
        if (!stu || !q || !saPage(stu, q).scan || (!job.force && !needsAI(stu, q))) { skip(); continue; }
        const used = await AI.today();
        if (used >= cap()) { Q.blocked = `Daily limit reached (${used} of ${cap()} requests today). Raise it in Settings or resume tomorrow.`; break; }
        if (used >= cap() - AI.WARN_MARGIN && !warned) { warned = true; toast(`AI requests today: ${used} of ${cap()}. Close to the daily limit.`, 'bad'); }
        const ok = await AI.pace(ai.rpm, () => Q.pause || !aiOn(), w => setQ(`waiting ${Math.ceil(w / 1000)} s (pacing)`));
        if (!ok) break;
        setQ(`asking ${model}...`);
        const { lq, scan } = saPage(stu, q);
        const crop = AI.boxCrop(await imgOf(scan), lq);
        const keyImg = S.exam.keyScan && S.exam.keyScan.sa && S.exam.keyScan.sa[q.id];
        await AI.bump();
        Q.inflight = true;
        let r;
        try {
          r = await AI.post(st.cloudUrl, st.cloudToken, {
            action: 'aiGrade', model, prompt: q.prompt || '', maxPoints: +q.max || 0, answerKey: q.modelAnswer || q.key || '', rubric: q.rubric || '',
            presetComments: presetsOf(q), examples: [], imageB64: crop.b64, keyImageB64: keyImg ? keyImg.b64 : undefined
          });
        } catch (err) { r = { ok: false, error: 'Network error: ' + err.message }; }
        finally { Q.inflight = false; }
        if (!S.exam || S.exam.id !== examId) break;
        if (!r.ok && r.rateLimited) {
          if (r.dailyQuota) { Q.blocked = 'Google reports the daily free quota is used up. Resume tomorrow.'; break; }
          retries.set(job, (retries.get(job) || 0) + 1);
          if (retries.get(job) > 4) { Q.blocked = 'Still rate limited after several pauses.'; break; }
          const secs = Math.min(120, Math.max(2, +r.retryAfter || 30));
          const until = Date.now() + secs * 1000;
          while (Date.now() < until && !Q.pause) { setQ(`rate limited by Google, resuming in ${Math.ceil((until - Date.now()) / 1000)} s`); await U.sleep(250); }
          AI.resetPace();
          continue;
        }
        if (job.cancel) { skip(); continue; }   // the teacher graded it meanwhile
        if (!r.ok) {
          errorsInRow++; job.n = (job.n || 0) + 1;
          setQ(`error: ${r.error}`);
          Q.jobs.shift();
          if (job.n >= 3) {
            stu.sa = stu.sa || {};
            const sa = stu.sa[q.id] = stu.sa[q.id] || { pts: null, comments: [], note: '' };
            if (sa.pts === null || sa.pts === undefined) { sa.flag = 'error'; sa.aiError = r.error; await saveStudent(stu); }
            Q.done++;
          } else Q.jobs.push(job);
          persistQ(); renderQ();
          if (errorsInRow >= 5) { Q.blocked = 'Stopped after repeated errors: ' + r.error; break; }
          continue;
        }
        errorsInRow = 0;
        await applyAI(stu, q, { ...r.result, model }, lq);
        Q.jobs.shift(); Q.done++;
        await persistQ();
        renderQ();
        if (S.view === 'grade') await rerenderCard(stu, q, studs());
        refreshDash();
        if (!Q.jobs.some(j => j.stu === stu.id)) autoApproveSoon([stu]);
      }
    } finally {
      Q.running = false;
      if (!Q.jobs.length && Q.total) {
        const flagged = S.students.reduce((a, s) => a + gradeOf(s).saFlags, 0);
        Q.finished = `AI grading finished: ${Q.done} answer(s) graded${flagged ? `, ${flagged} flagged for attention` : ''}.`;
        Q.total = 0; Q.done = 0; persistQ();
        refreshDash();
      }
      renderQ();
    }
  }

  // AI result -> draft grade with red-pen annotations (points in the score box, comment, check/cross/circle/underline)
  async function applyAI(stu, q, p, lq) {
    stu.sa = stu.sa || {}; stu.ink = stu.ink || {};
    const sa = stu.sa[q.id] = { pts: null, comments: [], note: '' };
    sa.pts = Math.max(0, Math.min(+q.max || 0, Math.round((+p.points || 0) * 2) / 2));
    const c = String(p.comment || '').trim();
    if (c) { if (presetsOf(q).includes(c)) sa.comments = [c]; else sa.note = c; }
    sa.source = 'ai'; sa.edited = false;
    sa.aiRes = { points: p.points, rubricItems: p.rubricItems || [], comment: c, legible: p.legible !== false, confidence: p.confidence, model: p.model || '', at: Date.now() };
    if (p.legible === false) { sa.pts = 0; sa.flag = 'illegible'; }
    else if (p.confidence === 'low') sa.flag = 'low';
    const ink = stu.ink[lq.page] = (stu.ink[lq.page] || []).filter(k => !(k.ai && k.q === q.id));
    ink.push(...AI.toInk(p.marks, lq, q.id));
    markDraft(stu);
    await saveStudent(stu);
  }

  // ---------------- Results / preview / export ----------------
  async function viewResults(v) {
    v.appendChild(el('h2', {}, 'Results'));
    if (!S.students.length) { v.appendChild(el('div', { class: 'card' }, 'No students scanned yet.')); return; }
    v.appendChild(el('div', { id: 'dashWrap' }));
    v.appendChild(el('div', { class: 'card', id: 'approveCard' },
      el('h3', {}, 'Approve'),
      el('p', { class: 'small muted' }, 'Approving generates each student\'s marked PDF, the combined class PDF and the Excel and CSV gradebooks' + (aiReady() ? ', and saves them to Google Drive / Sheets.' : '. Set up the Google server in Settings to save them to Drive automatically.')),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnApproveAll', onclick: () => approveStudents(S.students.filter(s => s.status !== 'approved')) }, 'Approve all'),
        el('span', { id: 'approveProgress', class: 'small muted' }, GEN.progress || '')),
      el('div', { id: 'approveSummary' })));
    const ex = el('div', { class: 'card' }, el('h3', {}, 'Export now (any status)'),
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn', id: 'btnCombined', onclick: () => exportCombined(sortedGraded()) }, 'Combined class PDF'),
        el('button', { class: 'btn', id: 'btnAllPdfs', onclick: () => exportAll(sortedGraded()) }, 'All student PDFs'),
        el('button', { class: 'btn', id: 'btnCsv', onclick: () => exportCSV(sortedGraded()) }, 'CSV gradebook'),
        el('button', { class: 'btn', id: 'btnXlsx', onclick: () => exportXLSX(sortedGraded()) }, 'Excel gradebook'),
        el('button', { class: 'btn', id: 'btnCloud', onclick: () => cloudSave(sortedGraded()) }, 'Save to Google Drive')),
      el('div', { id: 'exportProgress', class: 'small muted' }));
    v.appendChild(ex);
    v.appendChild(el('div', { id: 'previewBox' }));
    renderDash();
    await renderApproveSummary();
  }
  function sortedGraded() {
    return S.students.map(s => ({ stu: s, g: gradeOf(s) })).sort((a, b) => Grade.sortKey(a.g).localeCompare(Grade.sortKey(b.g)));
  }
  const refreshDash = (() => { let t; return () => { if (S.view !== 'results') return; clearTimeout(t); t = setTimeout(renderDash, 250); }; })();

  function renderDash() {
    const box = $('#dashWrap'); if (!box) return;
    const e = S.exam;
    const graded = sortedGraded();
    const studs = S.students.slice().sort((a, b) => a.key - b.key);
    box.innerHTML = '';
    const tot = graded.map(x => x.g.pct).sort((a, b) => a - b);
    const mean = tot.reduce((a, b) => a + b, 0) / tot.length;
    const med = tot.length % 2 ? tot[(tot.length - 1) / 2] : (tot[tot.length / 2 - 1] + tot[tot.length / 2]) / 2;
    const nApproved = graded.filter(x => x.g.approved).length;
    const nAttn = graded.filter(x => x.g.attention).length;
    box.appendChild(el('div', { class: 'card stats' },
      stat('Students', graded.length), stat('Mean', U.fmt(mean) + '%'), stat('Median', U.fmt(med) + '%'),
      stat('High', U.fmt(tot[tot.length - 1]) + '%'), stat('Low', U.fmt(tot[0]) + '%'), stat('Need attention', nAttn), stat('Approved', `${nApproved} / ${graded.length}`)));
    // needs attention
    const items = [];
    graded.forEach(({ stu, g }) => {
      const n = studs.indexOf(stu) + 1, who = `Student ${n}${g.id ? ' (' + g.id + ')' : ''}${g.name ? ' ' + g.name : ''}`;
      if (!g.idOk) items.push({ who, what: 'student ID needs checking', kind: 'id', open: () => go('review') });
      if (g.missing.length) items.push({ who, what: `missing page ${g.missing.join(', ')}`, kind: 'page', open: () => go('scan') });
      if (g.dups) items.push({ who, what: `${g.dups} duplicate page(s)`, kind: 'page', open: () => go('scan') });
      e.mc.forEach((q, i) => { const r = g.mc[q.id]; if (r.state === 'review') items.push({ who, what: `Q${i + 1}: unclear bubble`, kind: 'mc', open: () => go('review') }); });
      e.sa.forEach((q, i) => {
        const r = g.sa[q.id];
        const queued = Q.jobs.some(j => j.stu === stu.id && j.q === q.id);
        const open = () => { GS.mode = 'question'; GS.q = i; GS.focus = { stu: stu.id, sa: i + 1 }; go('grade'); };
        if (r.flag === 'low') items.push({ who, what: `SA${i + 1}: low AI confidence (draft ${U.fmt(r.pts)} / ${U.fmt(q.max)})`, kind: 'sa', sa: i + 1, stu: stu.id, open });
        else if (r.flag === 'illegible') items.push({ who, what: `SA${i + 1}: illegible or blank (draft 0 / ${U.fmt(q.max)})`, kind: 'sa', sa: i + 1, stu: stu.id, open });
        else if (r.pts === null && !queued && saPage(stu, q).scan) items.push({ who, what: `SA${i + 1}: ${r.flag === 'error' ? 'AI failed, needs grading' : 'needs grading'}`, kind: 'sa', sa: i + 1, stu: stu.id, open });
      });
    });
    box.appendChild(el('div', { class: 'card' + (items.length ? ' warn' : ' ok'), id: 'attention' },
      el('h3', {}, `Needs attention (${items.length})`),
      items.length ? el('ul', { class: 'attnlist', id: 'attentionList' }, items.slice(0, 200).map(it => el('li', { class: 'attn ' + it.kind, 'data-stu': it.stu || '', 'data-sa': it.sa || '' },
        el('span', {}, el('strong', {}, it.who), ': ' + it.what), el('button', { class: 'btn small', onclick: it.open }, 'Open'))))
        : el('p', { class: 'small' }, Q.jobs.length ? 'Nothing flagged so far; AI grading is still running.' : 'Nothing flagged. Review anything you like, or approve.')));
    // dashboard table
    const tbl = el('table', { class: 'gradebook', id: 'gradebook' },
      el('thead', {}, el('tr', {}, ['#', 'ID', 'Name', 'MC', 'Written', 'Total', '%', 'Flags', 'Status', ...e.sa.map((q, i) => 'SA' + (i + 1)), ''].map(h => el('th', {}, h)))),
      el('tbody', {}, graded.map((x, i) => {
        const g = x.g;
        return el('tr', { 'data-stu': x.stu.id, 'data-status': g.approval },
          el('td', {}, i + 1), el('td', {}, g.id), el('td', {}, g.name),
          el('td', {}, `${U.fmt(g.mcTotal)}/${U.fmt(g.mcMax)}`), el('td', {}, `${U.fmt(g.saTotal)}/${U.fmt(g.saMax)}`),
          el('td', {}, `${U.fmt(g.total)}/${U.fmt(g.max)}`), el('td', {}, U.fmt(g.pct)),
          el('td', { class: 'flags ' + (g.attention ? 'badc' : 'okc'), title: g.status }, String(g.attention)),
          el('td', { class: 'status ' + (g.approved ? 'okc' : '') }, g.approval),
          e.sa.map((q, k) => {
            const r = g.sa[q.id];
            const queued = Q.jobs.some(j => j.stu === x.stu.id && j.q === q.id);
            const label = queued ? 'Queued' : r.pts === null ? 'Ungraded' : (r.source === 'ai' ? 'AI' : 'Teacher');
            return el('td', { class: 'src', 'data-sa': k + 1 }, el('button', { class: 'linkbtn srcbtn ' + label.toLowerCase(), title: 'Open this answer', onclick: () => { GS.mode = 'question'; GS.q = k; GS.focus = { stu: x.stu.id, sa: k + 1 }; go('grade'); } }, label + (r.pts !== null ? ' ' + U.fmt(r.pts) : '') + (r.flag && r.pts !== null ? ' !' : '')));
          }),
          el('td', {}, el('div', { class: 'row tight' },
            el('button', { class: 'btn small', onclick: () => preview(x.stu) }, 'View'),
            e.sa.length ? el('button', { class: 'btn small', onclick: () => { GS.mode = 'student'; GS.stu = studs.indexOf(x.stu); go('grade'); } }, 'Open') : null,
            el('button', { class: 'btn small', onclick: () => exportStudent(x.stu) }, 'PDF'),
            g.approved ? el('button', { class: 'btn small btnreopen', title: 'Set back to Draft (not auto-approved again)', onclick: async () => { markDraft(x.stu); x.stu.held = true; await saveStudent(x.stu); renderDash(); } }, 'Reopen')
              : el('button', { class: 'btn small primary btnapprove', onclick: () => approveStudents([x.stu]) }, 'Approve'))));
      })));
    box.appendChild(el('div', { class: 'card scrollx' }, tbl));
  }

  // ---------------- Approval: Draft -> Approved, then automatic PDFs, gradebooks and Drive saving ----------------
  const GEN = { chain: Promise.resolve(), progress: '', busy: 0 };
  const PAGECACHE = new Map();   // student id -> { stamp, urls: [jpeg data URLs] } (memory only)
  const AUTO = { set: new Set(), t: null };
  function autoApproveSoon(list) {
    if (!S.settings.autoApprove || !S.exam) return;
    (list || []).forEach(s => AUTO.set.add(s.id));
    clearTimeout(AUTO.t);
    AUTO.t = setTimeout(() => {
      const ids = AUTO.set; AUTO.set = new Set();
      const ok = S.students.filter(s => ids.has(s.id) && s.status !== 'approved' && !s.held && !Q.jobs.some(j => j.stu === s.id) && gradeOf(s).attention === 0);
      if (ok.length) approveStudents(ok, true);
    }, 700);
  }

  async function approveStudents(list, auto = false) {
    GEN.busy++;
    try { return await approveInner(list, auto); } finally { GEN.busy--; }
  }
  async function approveInner(list, auto) {
    const busy = list.filter(s => Q.jobs.some(j => j.stu === s.id));
    const ok = list.filter(s => !busy.includes(s));
    if (busy.length) toast(`${busy.length} student(s) are still being graded by AI; approve them when it finishes.`, 'bad');
    if (!ok.length) { if (!busy.length) toast('Everyone is already approved.'); return; }
    const now = Date.now();
    for (const s of ok) { s.status = 'approved'; s.approvedAt = now; delete s.held; await saveStudent(s); }
    toast(`${ok.length} student(s) ${auto ? 'auto-' : ''}approved. Generating PDFs and gradebooks...`, 'good');
    renderDash();
    return generateOutputs();
  }

  function outKey() { return 'out:' + S.exam.id; }
  async function loadOut() { return (await DB.getKV(outKey(), null)) || { students: {}, examId: S.exam.id }; }

  // serialized: approvals during a run trigger another run afterwards
  function generateOutputs() {
    const examId = S.exam.id;
    GEN.chain = GEN.chain.then(() => (S.exam && S.exam.id === examId ? doGenerate() : null)).catch(err => { console.error(err); toast('Generating outputs failed: ' + err.message, 'bad'); setGen(''); });
    return GEN.chain;
  }
  function setGen(t) { GEN.progress = t; const p = $('#approveProgress'); if (p) p.textContent = t; }

  async function studentUrls(stu) {
    const c = PAGECACHE.get(stu.id);
    if (c && c.stamp === stu.approvedAt) return c.urls;
    const r = await renderStudentPages(stu, 1);
    const urls = r.pages.map(cv => cv.toDataURL('image/jpeg', 0.86));
    PAGECACHE.set(stu.id, { stamp: stu.approvedAt, urls });
    return urls;
  }

  async function doGenerate() {
    const e = S.exam, st = S.settings;
    const graded = sortedGraded().filter(x => x.g.approved);
    const out = await loadOut();
    for (const id of Object.keys(out.students)) if (!graded.some(x => x.stu.id === id)) delete out.students[id];
    const fresh = [];
    const used = new Set();
    for (let i = 0; i < graded.length; i++) {
      const { stu, g } = graded[i];
      let name = fileBase(g) + '.pdf';
      if (used.has(name)) name = U.safeName(`${e.title} - ${g.name || 'student'} ${g.id || i + 1}`) + '.pdf';
      used.add(name);
      const ent = out.students[stu.id];
      if (ent && ent.stamp === stu.approvedAt && ent.name === name && ent.blob) continue;
      setGen(`Student PDF ${i + 1} of ${graded.length}: ${g.name || g.id || 'student'}`);
      const urls = await studentUrls(stu);
      const doc = Export.newDoc();
      doc.setProperties({ title: `${e.title} - ${g.name || g.id}`, creator: 'Exam Grader' });
      urls.forEach((u, k) => Export.addJpegPage(doc, u, k === 0));
      out.students[stu.id] = { name, blob: doc.output('blob'), stamp: stu.approvedAt, total: g.total };
      fresh.push(stu.id);
      await U.sleep(0);
    }
    let classPages = 0;
    if (graded.length) {
      setGen('Building the class PDF...');
      const doc = Export.newDoc();
      doc.setProperties({ title: e.title + ' - class', creator: 'Exam Grader' });
      for (let i = 0; i < graded.length; i++) {
        setGen(`Class PDF: student ${i + 1} of ${graded.length}`);
        const urls = await studentUrls(graded[i].stu);
        urls.forEach(u => { Export.addJpegPage(doc, u, classPages === 0); classPages++; });
        await U.sleep(0);
      }
      out.classPdf = { name: U.safeName(`${e.title} - class`) + '.pdf', blob: doc.output('blob'), pages: classPages };
      const { header, rows } = gradebook(graded);
      out.csv = { name: U.safeName(e.title + ' - gradebook') + '.csv', blob: new Blob([Export.csv([header, ...rows])], { type: 'text/csv' }) };
      out.xlsx = { name: U.safeName(e.title + ' - gradebook') + '.xlsx', blob: new Blob([Export.xlsx(header, rows, e.title || 'Grades', itemStats(graded))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) };
    } else { delete out.classPdf; delete out.csv; delete out.xlsx; }
    out.at = Date.now(); out.count = graded.length; out.fresh = fresh.length;
    out.cloud = null;
    if (graded.length && st.cloudUrl && st.cloudToken) {
      const exam = { id: e.id, title: e.title, course: e.course, school: e.school, version: e.version };
      const b64 = async blob => (await U.blobToDataURL(blob)).split(',')[1];
      try {
        let n = 0;
        for (const id of fresh) {
          const ent = out.students[id];
          setGen(`Saving to Google Drive: ${ent.name}`);
          await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'savePdf', exam, filename: ent.name, b64: await b64(ent.blob) });
          n++;
        }
        setGen('Saving the class PDF to Google Drive...');
        const rc = await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'savePdf', exam, filename: out.classPdf.name, b64: await b64(out.classPdf.blob) });
        setGen('Saving the gradebook to Google Sheets...');
        const { header, rows } = gradebook(graded);
        const rg = await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'saveGrades', exam, header, rows });
        out.cloud = { ok: true, pdfs: n + 1, rows: rows.length, sheet: rg.url || '', folder: rc.folder || '' };
      } catch (err) { out.cloud = { ok: false, error: err.message }; }
    }
    await DB.setKV(outKey(), out);
    setGen('');
    await renderApproveSummary(out);
    if (out.cloud && !out.cloud.ok) toast('Saving to Google Drive failed: ' + out.cloud.error, 'bad');
    else toast(`Done: ${graded.length} approved student(s), PDFs and gradebooks ready${out.cloud ? ' and saved to Google Drive' : ''}.`, 'good');
  }

  function outFiles(out) {
    const files = [];
    Object.values(out.students).forEach(s => files.push({ name: 'Student PDFs/' + s.name, data: s.blob }));
    if (out.classPdf) files.push({ name: out.classPdf.name, data: out.classPdf.blob });
    if (out.xlsx) files.push({ name: out.xlsx.name, data: out.xlsx.blob });
    if (out.csv) files.push({ name: out.csv.name, data: out.csv.blob });
    return files;
  }

  async function renderApproveSummary(out) {
    const box = $('#approveSummary'); if (!box || !S.exam) return;
    out = out || await loadOut();
    box.innerHTML = '';
    if (!out.at || !out.count) return;
    const n = Object.keys(out.students).length;
    const cloud = out.cloud;
    box.appendChild(el('div', { class: 'card ok summary', id: 'genSummary' },
      el('p', {}, el('strong', {}, `Generated ${new Date(out.at).toLocaleString()}: `),
        `${n} approved student PDF(s), the class PDF (${out.classPdf ? out.classPdf.pages : 0} pages), the Excel and CSV gradebooks.`),
      cloud ? el('p', { class: cloud.ok ? '' : 'warntext' }, cloud.ok ? `Saved to Google Drive: ${cloud.pdfs} PDF(s) this time and ${cloud.rows} gradebook row(s) in Google Sheets.` : `Saving to Google Drive failed: ${cloud.error}`,
        cloud.ok && cloud.sheet ? el('a', { href: cloud.sheet, target: '_blank', rel: 'noopener' }, ' Open the sheet') : null) : null,
      el('div', { class: 'row wrap' },
        el('button', { class: 'btn primary', id: 'btnZip', onclick: async () => {
          const o = await loadOut();
          const blob = await Export.zip(outFiles(o));
          U.download(blob, U.safeName(S.exam.title + ' - graded') + '.zip');
        } }, 'Download all (ZIP)'),
        out.classPdf ? el('button', { class: 'btn small', id: 'dlClass', onclick: () => U.download(out.classPdf.blob, out.classPdf.name) }, 'Class PDF') : null,
        out.xlsx ? el('button', { class: 'btn small', id: 'dlXlsx', onclick: () => U.download(out.xlsx.blob, out.xlsx.name) }, 'Excel') : null,
        out.csv ? el('button', { class: 'btn small', id: 'dlCsv', onclick: () => U.download(out.csv.blob, out.csv.name) }, 'CSV') : null)));
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
        sel.onchange = async () => { if (sel.value) stu.mcOverride[q.id] = sel.value; else delete stu.mcOverride[q.id]; markDraft(stu); await saveStudent(stu); preview(stu); refreshDash(); };
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
      field('Apps Script web app URL', sInp('cloudUrl', { id: 's_cloudUrl', autocomplete: 'off', name: 'eg-server-url', placeholder: 'https://script.google.com/macros/s/.../exec' })),
      field('Shared token', sInp('cloudToken', { id: 's_cloudToken', type: 'password', autocomplete: 'new-password', name: 'eg-shared-token' })),
      el('div', { class: 'row' }, el('button', { class: 'btn', id: 'btnPing', onclick: async () => {
        cloudMsg.textContent = 'Testing...';
        try { const r = await Export.cloudPost(st.cloudUrl, st.cloudToken, { action: 'ping' }); cloudMsg.textContent = 'Connected: ' + (r.message || 'ok'); }
        catch (err) { cloudMsg.textContent = 'Failed: ' + err.message; }
      } }, 'Test connection'), cloudMsg)));
    v.appendChild(await aiSettingsCard());
    const autoAp = el('input', { type: 'checkbox', id: 's_autoApprove', checked: !!st.autoApprove });
    autoAp.onchange = () => { st.autoApprove = autoAp.checked; saveSettings(); };
    v.appendChild(el('div', { class: 'card', id: 'approveSettings' }, el('h3', {}, 'Approval'),
      el('label', { class: 'small' }, autoAp, ' Auto-approve when no flags'),
      el('p', { class: 'small muted' }, 'When on, a student is approved automatically as soon as everything is graded and nothing needs attention (no unclear bubbles, ID or page problems, low-confidence or illegible AI grades). Approval generates the PDFs and gradebooks and saves them to Google Drive if it is set up. Off by default.')));
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
    const card = el('div', { class: 'card', id: 'aiSettings' }, el('h3', {}, 'AI grading of written answers (Google Gemini)'));
    if (!aiReady()) card.appendChild(el('p', { class: 'small warntext', id: 'aiNeedServer' }, 'Needs the Apps Script URL and token above, with a GEMINI_KEY script property on that server.'));
    const on = el('input', { type: 'checkbox', id: 'ai_on', checked: !!ai.enabled });
    on.onchange = () => { ai.enabled = on.checked; saveSettings(); if (ai.enabled) { enqueueMissing(); runQueue(); } else renderQ(); };
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
    card.appendChild(el('label', { class: 'small' }, on, ' Grade written answers automatically with AI after scanning (drafts you can review)'));
    card.appendChild(el('div', { class: 'row wrap' },
      field('Model', sel),
      field('Requests per minute', num('rpm', { id: 'ai_rpm', min: 1, max: 60 })),
      field('Daily limit', num('dailyCap', { id: 'ai_cap', min: 1, max: 100000 }), `Used today: ${used}`)));
    card.appendChild(el('div', { class: 'row wrap' },
      el('button', { class: 'btn', id: 'btnAiTest', disabled: !aiReady(), onclick: loadModels }, 'Test connection and load models'), msg));
    card.appendChild(el('div', { class: 'small muted ainote' },
      el('p', {}, 'Google\'s free tier allows a limited number of requests per minute and per day for each model (often around 10 to 30 per minute and a few hundred to about a thousand per day; Google changes these limits). One answer is one request. The app slows itself down and stops at the daily limit set here.'),
      el('p', {}, 'For each written answer, only the cropped image of the student\'s answer box is sent, together with the same box from your uploaded key (model answer and rubric), the question, any typed key or rubric, and the preset comments. Student names, IDs and the cover page are never sent.'),
      el('p', {}, 'On Google\'s free tier, submitted content may be used by Google to improve its products and may be read by human reviewers. You are responsible for following your school\'s privacy rules (for example FERPA) before using this feature. AI grades are drafts: nothing is final until you approve.')));
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
      ['Make the exam', 'Exam template: download the blank Word template, or click Make exam to type the questions in the app with a live preview of the printed pages, or Upload my exam (Word, PDF, text or page photos) to copy an existing exam into the template. Check the imported questions, then Create exam. Print / download exam PDF gives the bubble exam; Download answer key PDF gives the key. Figures are not copied: add them by hand.'],
      ['Set up exam', 'Exams > New exam. Enter school, course, title, date, version and the number of student-ID digits. Add multiple-choice questions (one by one or with Bulk paste) with points, and written-response questions with maximum points and box height. Typed model answers and rubrics are optional.'],
      ['Print', 'Print > check the preflight result > Download exam PDF. Print at actual size on US Letter.'],
      ['Upload key', 'Take one blank copy, shade the correct bubbles, and write (or type onto the PDF) the model answer and the rubric with points per element inside every written-answer box. Setup or Scan > Upload key (PDF or photos, any page order). The app reads the multiple-choice key from the bubbles and keeps each box as that question\'s key and rubric. Confirm any key answers it could not read. Uploading a new key regrades everything.'],
      ['Scan students', 'Scan > Upload student scans (scanner PDFs or photos; one file per student or the whole class) or use the camera. Everything is graded automatically: bubbles are read and marked, and when AI grading is set up (Settings), every written answer is graded by AI in the background with red-pen marks, points and a comment. The progress bar under the menu shows the queue; it keeps going while you move around and resumes after a reload.'],
      ['Review (optional)', 'Results shows every student with score, multiple-choice and written subtotals, flags, status and whether each written answer was graded by AI or by you. "Needs attention" lists unclear bubbles, ID or page problems, and low-confidence or illegible AI grades (illegible answers get 0 until you change them). Open any student or question to change points, comments or marks; your changes mark the item as teacher-graded. Use "Re-run AI on this question" if needed.'],
      ['Approve', 'Results > Approve all (or Approve per student). Approving generates each student\'s marked PDF, the combined class PDF and the Excel and CSV gradebooks, and saves them to Google Drive / Sheets when the server is set up; otherwise use Download all (ZIP). Editing an approved student sets it back to Draft; approve again to regenerate. Settings > Approval can auto-approve students with no flags.'],
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
  window.ExamGrader = { S, Q, go, selectExam, parseBulk, importFiles, runAiImport, gradeOf, renderStudentPages, saveExam, commitBatch, makeScan, approveStudents, runQueue, loadOut: () => loadOut(), genChain: () => GEN.chain, genBusy: () => GEN.busy + (AUTO.set.size ? 1 : 0) };
  window.addEventListener('DOMContentLoaded', boot);
})();
