/* Exam Grader - PDF / CSV / XLSX export and optional Google Apps Script cloud saving */
'use strict';

const Export = (() => {
  // Build one jsPDF document from rendered page canvases
  function newDoc() {
    const { jsPDF } = window.jspdf;
    return new jsPDF({ unit: 'pt', format: 'letter', compress: true });
  }
  function addCanvasPage(doc, canvas, first) {
    if (!first) doc.addPage('letter', 'portrait');
    const url = canvas.toDataURL('image/jpeg', 0.86);
    doc.addImage(url, 'JPEG', 0, 0, 612, 792, undefined, 'FAST');
  }

  // pages: array of canvases (one per exam page, in order)
  function pdfFromCanvases(canvases, title) {
    const doc = newDoc();
    doc.setProperties({ title: title || 'Graded exam', creator: 'Exam Grader' });
    canvases.forEach((c, i) => addCanvasPage(doc, c, i === 0));
    return doc;
  }

  function csv(rows) {
    return rows.map(r => r.map(v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n') + '\r\n';
  }

  function xlsx(header, rows, sheetName, stats) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map(h => ({ wch: Math.max(8, Math.min(28, String(h).length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Grades').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    if (stats) {
      const ws2 = XLSX.utils.aoa_to_sheet(stats);
      XLSX.utils.book_append_sheet(wb, ws2, 'Item analysis');
    }
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  // ---------- Cloud (Google Apps Script web app) ----------
  async function cloudPost(url, token, payload) {
    const body = JSON.stringify({ token: token || '', ...payload });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('Server did not return JSON: ' + txt.slice(0, 120)); }
    if (!j.ok) throw new Error(j.error || 'Server error');
    return j;
  }

  return { pdfFromCanvases, newDoc, addCanvasPage, csv, xlsx, cloudPost };
})();
