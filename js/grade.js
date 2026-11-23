/* Exam Grader - scoring, student grouping and gradebook rows */
'use strict';

const Grade = (() => {
  // pages of a student: { pageNo: scan } using the first scan for each page; extras listed as duplicates
  function pagesOf(stu, scans) {
    const mine = scans.filter(s => s.studentId === stu.id).sort((a, b) => (a.batchSeq - b.batchSeq) || (a.seq - b.seq));
    const pages = {}, dups = [], unknown = [];
    for (const s of mine) {
      if (!s.page) { unknown.push(s); continue; }
      if (pages[s.page]) dups.push(s); else pages[s.page] = s;
    }
    return { pages, dups, unknown, all: mine };
  }

  function studentId(stu, pages) {
    if (stu.idOverride) return stu.idOverride;
    const cov = pages[1];
    return cov && cov.idRead ? cov.idRead.value : '';
  }

  function compute(exam, L, stu, scans, roster) {
    const P = pagesOf(stu, scans);
    const out = { mc: {}, sa: {}, mcTotal: 0, saTotal: 0, mcMax: 0, saMax: 0, flags: 0, ungraded: 0, missing: [], dups: P.dups.length, unknown: P.unknown.length };
    for (let p = 1; p <= L.pageCount; p++) if (!P.pages[p]) out.missing.push(p);
    out.id = studentId(stu, P.pages);
    out.idOk = !!stu.idOverride || !!(P.pages[1] && P.pages[1].idRead && P.pages[1].idRead.ok);
    const rmap = rosterMap(roster);
    out.name = stu.nameOverride || rmap[out.id] || '';
    out.inRoster = !!rmap[out.id];
    (exam.mc || []).forEach(q => {
      const lq = L.mc.find(m => m.qid === q.id);
      const pts = +q.points || 0;
      out.mcMax += pts;
      const scan = lq ? P.pages[lq.page] : null;
      const read = scan && scan.omr ? scan.omr[q.id] : null;
      const ov = stu.mcOverride ? stu.mcOverride[q.id] : undefined;
      const r = { key: q.answer || '', read: read ? read.status : 'missing', off: read ? read.off : [0, 0], marked: read ? read.marked : [] };
      let ans = null, state;
      if (ov !== undefined && ov !== null && ov !== '') {
        r.override = ov;
        if (ov === 'BLANK') state = 'blank';
        else if (ov === 'MULTI') { state = 'multiple'; }
        else { ans = ov; state = ov === q.answer ? 'correct' : 'wrong'; }
      } else if (!read) state = 'missing';
      else if (read.status === 'single') { ans = read.choice; state = ans === q.answer ? 'correct' : 'wrong'; }
      else if (read.status === 'blank') state = 'blank';
      else if (read.status === 'multiple') state = 'multiple';
      else state = 'review';
      if (!q.answer && (state === 'correct' || state === 'wrong')) state = 'nokey';
      r.answer = ans; r.state = state;
      r.pts = state === 'correct' ? pts : 0;
      if (state === 'review' || state === 'missing') out.flags++;
      out.mc[q.id] = r;
      out.mcTotal += r.pts;
    });
    out.saFlags = 0;
    (exam.sa || []).forEach(q => {
      const g = (stu.sa && stu.sa[q.id]) || {};
      const max = +q.max || 0;
      out.saMax += max;
      const pts = g.pts === undefined || g.pts === null || g.pts === '' ? null : Math.max(0, Math.min(max, +g.pts));
      if (pts === null) out.ungraded++;
      // source: 'ai' (draft from the automatic AI grading) or 'teacher' (graded or edited by the teacher)
      const source = pts === null ? '' : (g.source || (g.ai === 'accepted' ? 'ai' : 'teacher'));
      const flag = pts !== null && (g.flag === 'low' || g.flag === 'illegible') ? g.flag : (pts === null && g.flag === 'error' ? 'error' : null);
      if (flag && pts !== null) out.saFlags++;
      out.sa[q.id] = { pts, comments: g.comments || [], note: g.note || '', source, flag, aiRes: g.aiRes || null };
      out.saTotal += pts || 0;
    });
    out.total = out.mcTotal + out.saTotal;
    out.max = out.mcMax + out.saMax;
    out.pct = out.max ? Math.round((out.total / out.max) * 1000) / 10 : 0;
    const st = [];
    if (out.missing.length) st.push('missing p.' + out.missing.join(','));
    if (out.flags) st.push(out.flags + ' MC to review');
    if (out.ungraded) st.push(out.ungraded + ' SA ungraded');
    if (out.saFlags) st.push(out.saFlags + ' SA flagged');
    if (!out.idOk) st.push('check ID');
    if (out.dups) st.push(out.dups + ' duplicate page(s)');
    out.complete = st.length === 0;
    // items that need the teacher's attention before approval
    out.attention = out.missing.length + out.flags + out.ungraded + out.saFlags + (out.idOk ? 0 : 1) + out.dups;
    out.approved = stu.status === 'approved';
    out.approval = out.approved ? 'Approved' : 'Draft';
    out.status = out.complete ? 'Complete' : st.join('; ');
    out.pages = P.pages;
    return out;
  }

  function rosterMap(roster) {
    const m = {};
    (roster || []).forEach(r => { if (r.id) m[String(r.id).trim()] = r.name; });
    return m;
  }
  function parseRoster(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(line => {
      const t = line.trim(); if (!t) return;
      const parts = t.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, ''));
      if (parts.length < 2) return;
      let [a, ...rest] = parts;
      let name = rest.join(', ');
      if (!/\d/.test(a) && /\d/.test(parts[parts.length - 1])) { a = parts[parts.length - 1]; name = parts.slice(0, -1).join(', '); }
      if (/^id$/i.test(a) || /student/i.test(a)) return;
      out.push({ id: a.replace(/\s+/g, ''), name });
    });
    return out;
  }

  // Assign a batch of newly ingested scans (in capture order) to students.
  // A cover (page 1) starts a new student. Following pages attach to the current student.
  // Repair: pages that repeat a page number already present in a segment are moved forward
  // to the next segment when that segment lacks them (handles a shuffled packet in a class scan).
  function group(batch, existingStudents, lastStudentId, examId, nextKey) {
    const segs = [];
    let cur = null;
    const lead = [];
    batch.forEach(s => {
      if (s.page === 1) { cur = { stu: null, scans: [s] }; segs.push(cur); }
      else if (cur) cur.scans.push(s);
      else lead.push(s);
    });
    // segment repair
    for (let i = 0; i < segs.length; i++) {
      const seen = new Set(), keep = [], over = [];
      let overflow = false;
      for (const s of segs[i].scans) {
        if (overflow) { over.push(s); continue; }
        if (s.page && seen.has(s.page) && i + 1 < segs.length) { overflow = true; over.push(s); continue; }
        if (s.page) seen.add(s.page);
        keep.push(s);
      }
      if (over.length) {
        const nxt = segs[i + 1], has = new Set(nxt.scans.map(s => s.page));
        const moved = [], stay = [];
        over.forEach(s => (!has.has(s.page) && s.page !== 1 ? moved : stay).push(s));
        segs[i].scans = keep.concat(stay);
        nxt.scans = moved.concat(nxt.scans);
      }
    }
    // pages before the first cover
    const created = [];
    if (lead.length) {
      if (segs.length) {
        const has = new Set(segs[0].scans.map(s => s.page));
        const last = existingStudents.find(s => s.id === lastStudentId);
        lead.forEach(s => {
          if (!has.has(s.page) || !last) { segs[0].scans.push(s); has.add(s.page); }
          else s.studentId = last.id;
        });
      } else if (lastStudentId) lead.forEach(s => { s.studentId = lastStudentId; });
      else {
        const stu = newStudent(examId, nextKey++); created.push(stu);
        lead.forEach(s => { s.studentId = stu.id; });
      }
    }
    segs.forEach(sg => {
      const stu = newStudent(examId, nextKey++); created.push(stu);
      sg.scans.forEach(s => { s.studentId = stu.id; });
    });
    return created;
  }

  function newStudent(examId, key) {
    return { id: U.uid('st_'), examId, key, created: Date.now(), mcOverride: {}, sa: {}, ink: {}, status: 'draft' };
  }

  function header(exam) {
    const h = ['School', 'Course', 'Exam', 'Version', 'Student ID', 'Name (roster)'];
    (exam.mc || []).forEach((q, i) => h.push('Q' + (i + 1)));
    (exam.sa || []).forEach((q, i) => h.push('SA' + (i + 1)));
    h.push('MC subtotal', 'SA subtotal', 'Total', 'Max', 'Percent', 'Status', 'Approval');
    return h;
  }
  function row(exam, g) {
    const r = [exam.school || '', exam.course || '', exam.title || '', exam.version || '', g.id || '', g.name || ''];
    (exam.mc || []).forEach(q => r.push(g.mc[q.id] ? g.mc[q.id].pts : ''));
    (exam.sa || []).forEach(q => r.push(g.sa[q.id] && g.sa[q.id].pts !== null ? g.sa[q.id].pts : ''));
    r.push(g.mcTotal, g.saTotal, g.total, g.max, g.pct, g.status, g.approval);
    return r;
  }
  function sortKey(g) { return (g.name || '~') + '|' + (g.id || ''); }

  return { compute, pagesOf, group, newStudent, parseRoster, rosterMap, header, row, sortKey };
})();
