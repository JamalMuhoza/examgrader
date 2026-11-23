/**
 * Exam Grader - Google Apps Script web app for saving graded PDFs to Drive and grades to Sheets.
 *
 * Requests: HTTP POST, body = JSON text (sent as text/plain to avoid a CORS preflight):
 *   { token, action: 'ping' }
 *   { token, action: 'savePdf',    exam: {id,title,...}, filename, b64 }
 *   { token, action: 'saveGrades', exam: {id,title,...}, header: [...], rows: [[...], ...] }
 * Responses: JSON { ok: true, ... } or { ok: false, error }.
 *
 * Set the shared secret: Project Settings > Script properties > TOKEN = <your secret>.
 */

var ROOT_FOLDER = 'Exam Grader';
var BOOK_NAME = 'Exam Grader - Gradebook';

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return out_({ ok: false, error: 'Script property TOKEN is not set' });
    if (req.token !== token) return out_({ ok: false, error: 'Invalid token' });
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      switch (req.action) {
        case 'ping': return out_({ ok: true, message: 'Exam Grader server ready', user: Session.getEffectiveUser().getEmail() });
        case 'savePdf': return out_(savePdf_(req));
        case 'saveGrades': return out_(saveGrades_(req));
        default: return out_({ ok: false, error: 'Unknown action: ' + req.action });
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return out_({ ok: true, message: 'Exam Grader server. Use POST.' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function folder_(parent, name) {
  var it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
}

function examName_(exam) {
  var t = String((exam && exam.title) || 'Exam').replace(/[\\\/:*?"<>|]+/g, '-').trim();
  if (exam && exam.version) t += ' (' + exam.version + ')';
  return t.slice(0, 90);
}

function savePdf_(req) {
  if (!req.b64 || !req.filename) return { ok: false, error: 'filename and b64 are required' };
  var root = folder_(null, ROOT_FOLDER);
  var dir = folder_(root, examName_(req.exam));
  var name = String(req.filename).replace(/[\\\/:*?"<>|]+/g, '-');
  var old = dir.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);   // replace an earlier version
  var blob = Utilities.newBlob(Utilities.base64Decode(req.b64), 'application/pdf', name);
  var file = dir.createFile(blob);
  return { ok: true, id: file.getId(), url: file.getUrl(), folder: dir.getUrl() };
}

function book_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOOK_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate */ } }
  var ss = SpreadsheetApp.create(BOOK_NAME);
  var root = folder_(null, ROOT_FOLDER);
  DriveApp.getFileById(ss.getId()).moveTo(root);
  props.setProperty('BOOK_ID', ss.getId());
  return ss;
}

function saveGrades_(req) {
  var header = req.header || [], rows = req.rows || [];
  if (!header.length) return { ok: false, error: 'header is required' };
  var ss = book_();
  var tab = examName_(req.exam).replace(/[\[\]\*\?\/\\:]/g, ' ').slice(0, 95);
  var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
  // update rows by Student ID (column "Student ID"), append new ones
  var idCol = header.indexOf('Student ID');
  var data = sh.getLastRow() > 0 ? sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getValues() : [];
  var existing = {};
  if (data.length > 1 && idCol >= 0 && String(data[0][idCol]) === 'Student ID') {
    for (var r = 1; r < data.length; r++) existing[String(data[r][idCol])] = r;
  } else { data = [header]; }
  data[0] = header;
  rows.forEach(function (row) {
    var key = idCol >= 0 ? String(row[idCol]) : '';
    if (key && existing[key] !== undefined) data[existing[key]] = row;
    else { data.push(row); if (key) existing[key] = data.length - 1; }
  });
  var width = header.length;
  data = data.map(function (row) { var x = row.slice(0, width); while (x.length < width) x.push(''); return x; });
  sh.clearContents();
  sh.getRange(1, 1, data.length, width).setValues(data);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
  return { ok: true, url: ss.getUrl(), sheet: tab, rows: data.length - 1 };
}
