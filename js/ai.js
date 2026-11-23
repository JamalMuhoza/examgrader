/* Exam Grader - optional AI grading suggestions (Google Gemini through the teacher's own Apps Script server).
 * Only the cropped answer box of a written question is sent. Suggestions stay pending until the teacher accepts them. */
'use strict';

const AI = (() => {
  const PENDING = 'rgb(226,107,118)';     // lighter red, drawn dashed, for not-yet-accepted marks
  const DEFAULTS = { enabled: false, model: '', models: [], rpm: 12, dailyCap: 480 };
  const WARN_MARGIN = 30;                  // warn this many requests before the daily cap (450 of 480)
  const SKIP = /(tts|image|live|audio|embed|thinking|computer|vision|aqa|learnlm|nano|banana)/i;

  // default model: highest-version stable flash-lite, else flash, else gemma
  function pickDefault(names) {
    names = (names || []).filter(n => !SKIP.test(n));
    const ver = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : -1; };
    const unstable = n => /(preview|exp|experimental)/i.test(n);
    for (const re of [/flash-lite/i, /flash/i, /gemma/i]) {
      const c = names.filter(n => re.test(n));
      if (!c.length) continue;
      const stable = c.filter(n => !unstable(n));
      const pool = stable.length ? stable : c;
      pool.sort((a, b) => (ver(b) - ver(a)) || (/latest/.test(a) - /latest/.test(b)) || (a.length - b.length) || a.localeCompare(b));
      return pool[0];
    }
    return names[0] || '';
  }
  function modelOf(ai) { return ai.model || pickDefault(ai.models); }

  // ---- per-day request counter (local to this device) ----
  function day() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  async function today() { const c = await DB.getKV('aiDay', null); return c && c.day === day() ? c.n : 0; }
  async function bump() { const n = (await today()) + 1; await DB.setKV('aiDay', { day: day(), n }); return n; }

  // ---- client-side pacer: at most rpm requests per minute ----
  let lastAt = 0;
  async function pace(rpm, stopped, onWait) {
    const gap = 60000 / Math.max(1, +rpm || DEFAULTS.rpm);
    for (;;) {
      const wait = lastAt + gap - Date.now();
      if (wait <= 0) break;
      if (stopped()) return false;
      if (onWait) onWait(wait);
      await U.sleep(Math.min(wait, 250));
    }
    if (stopped()) return false;
    lastAt = Date.now();
    return true;
  }
  function resetPace() { lastAt = Date.now(); }

  // ---- POST to the Apps Script server; returns the JSON even when ok:false (rate limits) ----
  async function post(url, token, payload) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: token || '', ...payload }), redirect: 'follow' });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return { ok: false, error: 'Server did not return JSON: ' + txt.slice(0, 120) }; }
  }

  // ---- answer box crop from the rectified scan (never the cover page, never the name/ID area) ----
  function boxCrop(img, lq, maxW = 900) {
    const PX = Layout.PX, b = lq.box;
    const sw = b.w * PX, sh = b.h * PX;
    const k = Math.min(1, maxW / sw);
    const c = CV.canvasOf(Math.round(sw * k), Math.round(sh * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.filter = 'grayscale(1)';
    ctx.drawImage(img, b.x * PX, b.y * PX, sw, sh, 0, 0, c.width, c.height);
    ctx.filter = 'none';
    return { b64: c.toDataURL('image/jpeg', 0.82).split(',')[1], w: c.width, h: c.height };
  }

  // ---- mark geometry: fractions of the box -> page pixels, kept inside the box ----
  function geom(m, lq) {
    const PX = Layout.PX, b = lq.box;
    const bx = b.x * PX, by = b.y * PX, bw = b.w * PX, bh = b.h * PX;
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const fx = cl(+m.x || 0, 0, 1), fy = cl(+m.y || 0, 0, 1);
    if (m.type === 'circle') {
      const rx = cl(((+m.w || 0.14) * bw) / 2, 3 * PX, bw / 2 - 1), ry = cl(((+m.h || 0.2) * bh) / 2, 2.5 * PX, bh / 2 - 1);
      return { type: 'circle', cx: cl(bx + fx * bw, bx + rx + 1, bx + bw - rx - 1), cy: cl(by + fy * bh, by + ry + 1, by + bh - ry - 1), rx, ry };
    }
    if (m.type === 'underline') {
      const len = cl((+m.w || 0.3) * bw, 8 * PX, bw - 2 * PX);
      const x0 = cl(bx + fx * bw, bx + PX, bx + bw - len - PX);
      return { type: 'underline', x0, x1: x0 + len, y: cl(by + fy * bh, by + 2 * PX, by + bh - 1.5 * PX) };
    }
    // check / cross stamps: the glyph extends about 6 mm left and 5 mm up of its anchor (see Annot.check)
    return { type: m.type, x: cl(bx + fx * bw, bx + 6.5 * PX, bx + bw - 2.5 * PX), y: cl(by + fy * bh, by + 5.5 * PX, by + bh - 3.5 * PX) };
  }

  // marks -> regular teacher ink items (stamps and pen strokes), flagged ai:true internally
  function toInk(marks, lq, qid) {
    const out = [];
    (marks || []).forEach((m, i) => {
      const g = geom(m, lq);
      const R = U.rng(qid + ':' + i + ':' + m.type);
      const id = U.uid('k');
      if (g.type === 'check' || g.type === 'cross') out.push({ id, type: g.type, x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10, q: qid, ai: true });
      else if (g.type === 'circle') {
        const pts = [], n = 36, a0 = R() * Math.PI * 2;
        for (let k = 0; k <= n + 3; k++) {
          const a = a0 + (k / n) * Math.PI * 2, wob = 1 + (R() - 0.5) * 0.04;
          pts.push([Math.round((g.cx + Math.cos(a) * g.rx * wob) * 10) / 10, Math.round((g.cy + Math.sin(a) * g.ry * wob) * 10) / 10]);
        }
        out.push({ id, type: 'pen', pts, w: 3, q: qid, ai: true });
      } else if (g.type === 'underline') {
        const pts = [], n = 14;
        for (let k = 0; k <= n; k++) pts.push([Math.round((g.x0 + (g.x1 - g.x0) * k / n) * 10) / 10, Math.round((g.y + Math.sin(k * 0.9) * 0.6 + (R() - 0.5)) * 10) / 10]);
        out.push({ id, type: 'pen', pts, w: 3, q: qid, ai: true });
      }
    });
    return out;
  }

  // dashed preview of pending marks on a canvas showing lq.region (ox, oy = region origin in page px)
  function drawPending(ctx, marks, lq, ox, oy) {
    const PX = Layout.PX, s = PX * 1.3;
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.strokeStyle = PENDING; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash([7, 5]);
    (marks || []).forEach(m => {
      const g = geom(m, lq);
      ctx.beginPath();
      if (g.type === 'check') { ctx.moveTo(g.x - 4.3 * s, g.y - 0.9 * s); ctx.lineTo(g.x - 2.5 * s, g.y + 1.7 * s); ctx.lineTo(g.x + 0.9 * s, g.y - 3.7 * s); }
      else if (g.type === 'cross') { ctx.moveTo(g.x - 1.9 * s, g.y - 1.9 * s); ctx.lineTo(g.x + 1.9 * s, g.y + 2 * s); ctx.moveTo(g.x + 1.8 * s, g.y - 2 * s); ctx.lineTo(g.x - 1.8 * s, g.y + 1.9 * s); }
      else if (g.type === 'circle') ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
      else if (g.type === 'underline') { ctx.moveTo(g.x0, g.y); ctx.lineTo(g.x1, g.y); }
      ctx.stroke();
    });
    ctx.restore();
  }

  return { DEFAULTS, WARN_MARGIN, PENDING, pickDefault, modelOf, today, bump, pace, resetPace, post, boxCrop, geom, toInk, drawPending };
})();
