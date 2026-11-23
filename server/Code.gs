/**
 * Exam Grader - Google Apps Script web app for saving graded PDFs to Drive and grades to Sheets.
 *
 * Requests: HTTP POST, body = JSON text (sent as text/plain to avoid a CORS preflight):
 *   { token, action: 'ping' }
 *   { token, action: 'savePdf',    exam: {id,title,...}, filename, b64 }
 *   { token, action: 'saveGrades', exam: {id,title,...}, header: [...], rows: [[...], ...] }
 *   { token, action: 'aiModels' }
 *   { token, action: 'aiGrade', model, prompt, maxPoints, answerKey, rubric, presetComments: [...],
 *     examples: [{ imageB64, points, comment }], imageB64, keyImageB64 }
 *   keyImageB64 (optional): the teacher's answer-key copy of the same answer box (model answer + rubric written in it).
 * Responses: JSON { ok: true, ... } or { ok: false, error }.
 *
 * Script properties (Project Settings > Script properties):
 *   TOKEN      = <your shared secret>            (required)
 *   GEMINI_KEY = <Google AI Studio API key>      (only for the optional AI grading suggestions)
 * The Gemini key stays on the server; the web app never sees it.
 */

var ROOT_FOLDER = 'Exam Grader';
var BOOK_NAME = 'Exam Grader - Gradebook';

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token) return out_({ ok: false, error: 'Script property TOKEN is not set' });
    if (req.token !== token) return out_({ ok: false, error: 'Invalid token' });
    // AI actions only call Google's API: no Drive/Sheets writes, so they do not take the lock
    if (req.action === 'aiModels') return out_(aiModels_());
    if (req.action === 'aiGrade') return out_(aiGrade_(req));
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

// ======================= AI grading suggestions (Google Gemini API) =======================

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';

function geminiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!k) throw new Error('Script property GEMINI_KEY is not set (Project Settings > Script properties)');
  return k;
}

// List models that support generateContent. Returns { ok, models: ['gemini-2.5-flash-lite', ...] }
function aiModels_() {
  var key = geminiKey_();
  var names = [], pageToken = '', guard = 0;
  do {
    var url = GEMINI_BASE + 'models?pageSize=1000&key=' + encodeURIComponent(key) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var code = res.getResponseCode(), body = parseJson_(res.getContentText());
    if (code !== 200) return apiError_(code, body, res);
    (body.models || []).forEach(function (m) {
      var methods = m.supportedGenerationMethods || [];
      if (methods.indexOf('generateContent') >= 0) names.push(String(m.name || '').replace(/^models\//, ''));
    });
    pageToken = body.nextPageToken || '';
  } while (pageToken && ++guard < 10);
  return { ok: true, models: names };
}

var AI_RULES = [
  'You are assisting a teacher who grades handwritten answers on paper exams. Your grade is applied as a draft grade; the teacher can review and correct it before approving.',
  'If an ANSWER KEY AND RUBRIC image is given, it is the teacher\'s own key copy of this answer box: it contains the model answer and the grading rubric (points per element). Read it first and grade the student answer against it; it takes precedence over any typed answer key or rubric. Award points only for what the student wrote in the student image, never for the content of the key image itself.',
  'Grade ONLY what is actually written in the answer image. Do not give credit for ideas the student did not write, and do not guess or infer text you cannot read.',
  'If the answer is blank, crossed out entirely, or unreadable, set legible=false, points=0, confidence="low" and say so briefly in the comment.',
  'Use the rubric (from the key image and/or the typed rubric): award each rubric element only when it is clearly present. points must equal the sum of rubricItems earned, between 0 and the maximum, in steps of 0.5.',
  'Be aware of chemistry and biochemistry notation: subscripts and superscripts (H2O, Ca2+, 10^-5), charges, arrows (->, <=>), states (s), (l), (g), (aq), significant figures, units, structural sketches, graphs with labelled axes. Accept equivalent correct notation; check units and balancing when the rubric asks for them.',
  'comment: one short sentence in the teacher\'s voice addressed to the student (at most about 12 words). If one of the preset comments fits, use it exactly, word for word.',
  'confidence: "high" only when the handwriting is clear and the rubric applies unambiguously; otherwise "medium" or "low".',
  'marks: up to 6 pen marks the teacher could place on the answer image: "check" next to a correct step, "cross" next to an error, "circle" around an error, "underline" under a key phrase. x and y are fractions (0 to 1) of the answer image width and height: the centre for check, cross and circle, the left start point for underline. w and h are optional fractions (circle size, underline length). Put marks on or beside the writing they refer to, never outside the image.',
  'The teacher-graded examples (if any) show how this teacher applies the rubric; match their strictness.'
].join('\n');

var AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    points: { type: 'NUMBER' },
    rubricItems: { type: 'ARRAY', items: { type: 'OBJECT', properties: { item: { type: 'STRING' }, earned: { type: 'NUMBER' }, max: { type: 'NUMBER' } }, required: ['item', 'earned', 'max'] } },
    comment: { type: 'STRING' },
    legible: { type: 'BOOLEAN' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    marks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      type: { type: 'STRING', enum: ['check', 'cross', 'circle', 'underline'] },
      x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, w: { type: 'NUMBER' }, h: { type: 'NUMBER' } }, required: ['type', 'x', 'y'] } }
  },
  required: ['points', 'rubricItems', 'comment', 'legible', 'confidence', 'marks']
};

function aiGrade_(req) {
  var key = geminiKey_();
  var model = String(req.model || '').replace(/^models\//, '');
  if (!/^[\w.\-]+$/.test(model)) return { ok: false, error: 'No valid model name given' };
  if (!req.imageB64) return { ok: false, error: 'imageB64 (the answer box image) is required' };
  var max = Math.max(0, Number(req.maxPoints) || 0);
  var gemma = /gemma/i.test(model);
  var presets = (req.presetComments || []).map(String).filter(function (c) { return c.trim(); }).slice(0, 30);
  var keyImg = req.keyImageB64 ? String(req.keyImageB64) : '';
  var ctx = [
    'QUESTION: ' + String(req.prompt || '(not given)'),
    'MAXIMUM POINTS: ' + max,
    'ANSWER KEY / MODEL ANSWER: ' + (String(req.answerKey || '').trim() || (keyImg ? '(see the ANSWER KEY AND RUBRIC image)' : '(none given; use your subject knowledge)')),
    'RUBRIC: ' + (String(req.rubric || '').trim() || (keyImg ? '(see the ANSWER KEY AND RUBRIC image)' : '(none given; award points for correctness and completeness)')),
    'PRESET COMMENTS: ' + (presets.length ? presets.map(function (c) { return '"' + c + '"'; }).join('; ') : '(none)')
  ].join('\n');
  var parts = [];
  if (gemma) parts.push({ text: AI_RULES + '\n\nReply with ONLY one JSON object, no other text, with exactly these keys: ' +
    '{"points": number, "rubricItems": [{"item": string, "earned": number, "max": number}], "comment": string, "legible": boolean, ' +
    '"confidence": "high"|"medium"|"low", "marks": [{"type": "check"|"cross"|"circle"|"underline", "x": number, "y": number, "w": number, "h": number}]}' });
  parts.push({ text: ctx });
  (req.examples || []).slice(0, 4).forEach(function (ex, i) {
    if (!ex || !ex.imageB64) return;
    parts.push({ text: 'TEACHER-GRADED EXAMPLE ' + (i + 1) + ': the teacher gave ' + Number(ex.points) + ' / ' + max + ' points' + (ex.comment ? ' with the comment "' + String(ex.comment) + '"' : '') + '.' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: String(ex.imageB64) } });
  });
  if (keyImg) {
    parts.push({ text: 'ANSWER KEY AND RUBRIC written by the teacher (image of the teacher\'s key copy of this answer box: the model answer and the points for each rubric element). This is NOT the student answer:' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: keyImg } });
  }
  parts.push({ text: 'STUDENT ANSWER TO GRADE (image of the student\'s answer box only; grade this image against the answer key and rubric):' });
  parts.push({ inline_data: { mime_type: 'image/jpeg', data: String(req.imageB64) } });

  var body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0 } };
  if (!gemma) {
    body.systemInstruction = { parts: [{ text: AI_RULES }] };
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = AI_SCHEMA;
  }
  var res = UrlFetchApp.fetch(GEMINI_BASE + 'models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), data = parseJson_(res.getContentText());
  if (code !== 200) return apiError_(code, data, res);
  if (data.promptFeedback && data.promptFeedback.blockReason) return { ok: false, error: 'Gemini blocked the request: ' + data.promptFeedback.blockReason };
  var cand = (data.candidates || [])[0];
  var text = cand && cand.content && cand.content.parts ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
  if (!text) return { ok: false, error: 'Gemini returned no answer' + (cand && cand.finishReason ? ' (finish reason ' + cand.finishReason + ')' : '') };
  var obj = extractJson_(text);
  if (!obj) return { ok: false, error: 'Could not read JSON from the model reply: ' + text.slice(0, 160) };
  return { ok: true, result: normalizeAi_(obj, max), usage: data.usageMetadata || null, model: model };
}

function parseJson_(t) { try { return JSON.parse(t); } catch (e) { return {}; } }

// Robust JSON extraction for models without a JSON mode (Gemma): strips code fences and prose around the object
function extractJson_(text) {
  var t = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch (e) { /* continue */ }
  var start = t.indexOf('{');
  while (start >= 0) {
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < t.length; i++) {
      var c = t.charAt(i);
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch (e2) { break; }
      }
    }
    start = t.indexOf('{', start + 1);
  }
  return null;
}

function clamp01_(v) { v = Number(v); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
function half_(v, max) { v = Number(v); if (!isFinite(v)) v = 0; return Math.max(0, Math.min(max, Math.round(v * 2) / 2)); }

function normalizeAi_(o, max) {
  var legible = o.legible !== false;
  var conf = ['high', 'medium', 'low'].indexOf(o.confidence) >= 0 ? o.confidence : 'low';
  var items = (Array.isArray(o.rubricItems) ? o.rubricItems : []).slice(0, 12).map(function (r) {
    var m = Math.max(0, Number(r && r.max) || 0);
    return { item: String((r && r.item) || '').slice(0, 160), earned: Math.max(0, Math.min(m || max, Number(r && r.earned) || 0)), max: m };
  });
  var marks = (Array.isArray(o.marks) ? o.marks : []).filter(function (m) {
    return m && ['check', 'cross', 'circle', 'underline'].indexOf(m.type) >= 0;
  }).slice(0, 8).map(function (m) {
    var x = { type: m.type, x: clamp01_(m.x), y: clamp01_(m.y) };
    if (m.w !== undefined && m.w !== null) x.w = clamp01_(m.w);
    if (m.h !== undefined && m.h !== null) x.h = clamp01_(m.h);
    return x;
  });
  var points = legible ? half_(o.points, max) : 0;
  return {
    points: points, rubricItems: items, comment: String(o.comment || '').trim().slice(0, 200),
    legible: legible, confidence: legible ? conf : 'low', marks: legible ? marks : []
  };
}

function apiError_(code, body, res) {
  var err = (body && body.error) || {};
  var msg = err.message || ('HTTP ' + code);
  if (code === 429) {
    var retry = 0;
    (err.details || []).forEach(function (d) {
      if (d && /RetryInfo/.test(d['@type'] || '') && d.retryDelay) retry = parseFloat(d.retryDelay) || retry;
    });
    if (!retry) { var h = res.getHeaders ? res.getHeaders() : {}; retry = parseFloat(h['Retry-After'] || h['retry-after']) || 30; }
    var daily = /PerDay|per day|daily/i.test(JSON.stringify(err.details || []) + ' ' + msg);
    return { ok: false, rateLimited: true, dailyQuota: daily, retryAfter: Math.ceil(retry), error: 'Gemini rate limit: ' + msg };
  }
  if (code === 400 && /API key not valid/i.test(msg)) return { ok: false, error: 'GEMINI_KEY is not a valid API key' };
  return { ok: false, status: code, error: 'Gemini error ' + code + ': ' + msg };
}
