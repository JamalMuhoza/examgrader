# Exam Grader: class-site API

A page on the same origin (for example `/iob/`, `/bio1/`, `/introchem/`) can print and read the same pages as the Exam Grader app at `/examgrader/`. It loads the app's own modules by URL; nothing is copied.

## 1. Scripts to load (in this order)

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<script src="/examgrader/js/util.js"></script>
<script src="/examgrader/js/layout.js"></script>
<script src="/examgrader/js/cv.js"></script>
<script src="/examgrader/js/grade.js"></script>
<script src="/examgrader/js/eglib.js"></script>
```

- The page must declare `<meta charset="utf-8">` (the scripts contain Unicode characters; without it util.js fails to parse).
- Classic scripts, no modules, no build step. Lazy loading is fine: insert the tags one after another and wait for each `onload`.
- None of them touch IndexedDB or the app UI at load time. `js/app.js`, `js/db.js`, `js/ai.js` are not needed.
- `eglib.js` finds the app folder from its own script URL (`EGLib.base`, e.g. `https://jamalmuhoza.github.io/examgrader/`) and loads the font from `EGLib.base + 'fonts/DejaVuSans.ttf'`.
- After loading, `window.EGLib` exists. The modules are also global names (`Layout`, `CV`, `Grade`, `U`) and are exposed as `EGLib.Layout`, `EGLib.CV`, `EGLib.Grade`, `EGLib.U`.

## 2. The class-site file

The app's "Download for class site" button (Print screen and Exam setup) saves `<title> - class site.json`:

```js
{
  app: 'examgrader',
  format: 1,
  exported: '2026-11-23T18:00:00.000Z',
  check: { hash: 137, pageCount: 4 },   // the app's layout hash and page count; recompute and compare
  exam: { ... },                         // exam definition, below
  keyBoxes: { '<saId>': '<jpeg base64>' },  // teacher's key-box image per written question (only if a key scan was uploaded)
  pdf: '<base64>'                        // the blank printable PDF (application/pdf), identical to "Download exam PDF"
}
```

Base64 strings have no `data:` prefix. `keyBoxes` images are grayscale JPEGs of the answer box only, the same crop as the student crops (section 6).

### Exam definition (`exam`)

The app's own exam object, minus `layout`, `layoutSig`, `printedSig`, `keyScan`, `roster`, `created`, `updated`. Pass it unchanged to the library: the layout depends on every field below.

- `id` (string): exam id. **Part of the page code hash: never change it.**
- `kind` (`'exam'` \| `'quiz'` \| `'homework'`): `exam`: page 1 is a full cover. `quiz` / `homework`: page 1 starts with a header strip (title, date, version, name, score, flat student ID) and the questions follow on page 1. Missing = `'exam'`.
- `title`, `course`, `school`, `teacher` (string): printed text
- `date` (string `YYYY-MM-DD`): printed
- `version` (string (max 4)): printed; **part of the hash**
- `idDigits` (number 1-12): number of student ID digits
- `instructions` (string): cover instructions (exam only; empty = default text)
- `uniText` (boolean): typed text printed with the DejaVu font (affects wrapping, so layout)
- `keepLook` (boolean): print question cut-outs (`look`) instead of typed text (default true when present)
- `mc` (array): multiple-choice questions, in printed order
- `mc[].id` (string): question id (`qid`)
- `mc[].label` (string?): printed number if not `1..n`
- `mc[].stem` (string): question text; `^{..}` superscript, `_{..}` subscript
- `mc[].choices` (string[2..5]): choice texts A..E
- `mc[].answer` (`'A'..'E'` or `''`): correct answer
- `mc[].points` (number): points
- `mc[].imgs`, `mc[].choiceImgs` (`{src: dataURL, wpt, hpt}[]`): figures (size in PDF points)
- `mc[].look`, `mc[].useText` (object, boolean): cut-outs from an imported PDF
- `sa` (array): written (short-answer) questions, in printed order
- `sa[].id` (string): question id (`qid`)
- `sa[].prompt` (string): question text
- `sa[].max` (number): maximum points
- `sa[].lines` (number): answer box height in 8 mm lines
- `sa[].modelAnswer`, `sa[].key` (string): model answer (AI uses `modelAnswer || key`)
- `sa[].rubric` (string): rubric
- `sa[].comments` (string[]): preset comments for this question
- `sa[].img`, `sa[].imgs` (figure objects): figures; `sa[].kind === 'page'` with `img` is a whole written page
- `comments` (string[]): preset comments for all written questions
- `frontPages`, `refPages` (`{id, img}[]`): extra printed pages, never graded

## 3. Setup and layout

```js
await EGLib.init();                    // loads the Unicode font; required before any layout
const L = await EGLib.layout(exam);    // same as Layout.compute(exam) after init()
// check against the file: L.hash === file.check.hash && L.pageCount === file.check.pageCount
```

Always call `init()` (or `layout()`) before `Layout.compute`: the font changes text wrapping, and the app computes layouts with it loaded. A layout computed without it can differ from the printed pages.

Layout object (all units mm, origin top-left of a US Letter page 215.9 x 279.4):

- `L.hash` (0-255), `L.pageCount`, `L.kind`, `L.pages: [{no, kind}]` (`kind`: `cover` | `head` | `mc` | `sa` | `wpage` | `extra` | `ref`).
- `L.cover`: page 1 identity area. `L.cover.compact` is true for quiz/homework.
  - `name {x,y,w,h}`, `score {x,y,w,h}`, `idBox {x,y,w,h}` (whole ID area, for a crop).
  - `id.r` bubble radius, `id.cols[c] = { c, write {x,y,w,h}, bubbles: [{d: 0..9, x, y}] }`, one entry per ID digit, first digit first. Exam: each digit is a vertical column. Quiz/homework (`id.flat`): each digit is a horizontal row of bubbles 0-9 (pitch 6.0 mm, rows 6.2 mm apart, up to two blocks side by side).
- `L.mc[] = { qid, num, label, page, r, top, h, choices: [{label: 'A'.., x, y}] }` bubble centres.
- `L.sa[] = { qid, num, label, page, max, box {x,y,w,h}, scoreBox, comment, region }` answer box geometry.
- `Layout.PX` = 150/25.4 px per mm on the rectified page; rectified page size `Layout.RW` x `Layout.RH` = 1275 x 1650 px.

## 4. Printing

```js
const blob = await EGLib.buildPDF(exam);              // blank printable PDF (Blob, application/pdf)
const key  = await EGLib.buildPDF(exam, { key: true }); // answer key PDF
```

Or use the ready-made `file.pdf` (base64). Print at 100% on US Letter.

## 5. Reading a page image

```js
const r = EGLib.readPage(image, exam, L);   // synchronous; L optional (computed if omitted, but call init() first)
```

`image`: a loaded `HTMLImageElement`, `HTMLCanvasElement`, `ImageBitmap` or `HTMLVideoElement` frame (photo or scan of one page, any rotation up to the four corner squares being visible; upside down is handled). For a PDF of scans, render each page to a canvas (pdf.js) and pass the canvas.

Returns:

```js
{
  ok: true,                  // false: corner squares not found -> { ok:false, reason, pageNo:null, ... }
  pageNo: 1,                 // from the page code; null if unreadable
  examHashOk: true,          // the page belongs to this exam id + version
  id: '1023456',             // page 1 only: student ID read from the bubbles ('?' for an unread digit); null on other pages
  idOk: true,                // page 1: every digit has exactly one clear bubble
  mc: { '<qid>': 'A' },      // questions on this page: 'A'..'E' one answer | '' blank | 'multi' several marks | '?' unclear (needs a human)
  saBoxes: [ { qid, crop, w, h } ],  // written answers on this page: crop = grayscale JPEG base64 (no prefix), w x h px
  omr: { ... }, idRead: { ... },     // raw readings (status, choice, marked, ds) used by gradeMC
  quality: { blur, pxPerMm, contrast, codeMargin },
  warnings: [ '...' ],
  canvas: HTMLCanvasElement  // the rectified page (1275 x 1650), for your own crops or display
}
```

Reject a page when `!r.ok`, `!r.pageNo` or `!r.examHashOk`.

## 6. Student ID (page 1)

The ID is read only from page 1, for every kind (exam cover, or the quiz/homework header strip). `r.id` is the digit string in `idDigits` length; `r.idOk` false means at least one digit was blank, double or unclear (`'?'` in `r.id`). Use page 1 to start a new student, as the app does: the pages that follow page 1 in a batch belong to that student.

## 7. Scoring multiple choice

```js
const g = EGLib.gradeMC(exam, [r1, r2, r3], L);   // all readPage results of ONE student, any order
// g = { id, idOk, score, max, flags, missingPages: [pageNo...],
//       mc: { '<qid>': { answer: 'B' | null, state: 'correct'|'wrong'|'blank'|'multiple'|'review'|'missing'|'nokey', pts, key } } }
```

It runs the app's own `Grade.compute`; `missingPages` lists page 1 and pages with multiple choice that were not supplied. Written answers are not scored here.

## 8. Written answers with AI

For each `r.saBoxes` item send `crop` (student) and `file.keyBoxes[qid]` (teacher key box, if present) with the question's `prompt`, `max`, `modelAnswer || key`, `rubric` and `comments` to your grader. The app sends exactly this to its Apps Script `aiGrade` action:

```js
{ action: 'aiGrade', model, prompt, maxPoints: max, answerKey: modelAnswer || key, rubric,
  presetComments, examples: [], imageB64: crop, keyImageB64: keyBoxes[qid] }
```

Crops never include the name or ID area. To crop any other box yourself: `EGLib.CV.boxCrop(r.canvas, { box: {x, y, w, h} }, maxW = 900)` returns `{ b64, w, h }` (box in mm).

## 9. Example

```js
await EGLib.init();
const file = await (await fetch('quiz2 - class site.json')).json();
const L = await EGLib.layout(file.exam);
if (L.hash !== file.check.hash || L.pageCount !== file.check.pageCount) throw new Error('layout mismatch');
const reads = [];
for (const url of pageImageUrls) reads.push(EGLib.readPage(await EGLib.U.loadImage(url), file.exam, L));
const ok = reads.filter(r => r.ok && r.pageNo && r.examHashOk);
const g = EGLib.gradeMC(file.exam, ok, L);
console.log(g.id, g.score + ' / ' + g.max);
```

`EGLib.version` is 1. The app's service worker caches `js/eglib.js`; the class site does not need its own copy.
