/* Exam Grader - hand-drawn style red pen annotations on rectified pages */
'use strict';

const Annot = (() => {
  const INK = '#c8101e';
  let fontReady = null;
  function ensureFont() {
    if (!fontReady) {
      fontReady = (async () => {
        try {
          if (!document.fonts) return;
          await Promise.all([document.fonts.load('600 40px Caveat'), document.fonts.load('400 40px Caveat')]);
        } catch (e) { /* fallback fonts */ }
      })();
    }
    return fontReady;
  }
  const FONT = (px, wt = 600) => `${wt} ${px}px Caveat, "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;

  // quadratic bezier sampled into points
  function quad(p0, c, p1, n = 18) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
      out.push([a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1]]);
    }
    return out;
  }
  // stroke with pen pressure taper: thin start, full body, lifting end
  function penStroke(ctx, pts, w, opt = {}) {
    if (pts.length < 2) return;
    const n = pts.length - 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = opt.color || INK;
    const startT = opt.start ?? 0.55, endT = opt.end ?? 0.45;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      let k = 1;
      if (t < 0.18) k = startT + (1 - startT) * (t / 0.18);
      else if (t > 0.78) k = 1 - (1 - endT) * ((t - 0.78) / 0.22);
      ctx.lineWidth = Math.max(0.6, w * k);
      ctx.beginPath(); ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(pts[i + 1][0], pts[i + 1][1]); ctx.stroke();
    }
  }
  function xf(pts, ox, oy, s, rot) {
    const c = Math.cos(rot), sn = Math.sin(rot);
    return pts.map(([x, y]) => [ox + (x * c - y * sn) * s, oy + (x * sn + y * c) * s]);
  }
  const j = (R, a) => (R() - 0.5) * 2 * a;

  // ---- glyphs (coordinates in mm around an anchor, converted by s = px/mm) ----
  function check(ctx, x, y, s, R, w) {
    const sc = s * (0.95 + R() * 0.15), rot = j(R, 0.1);
    const a = [-4.3 + j(R, 0.25), -0.9 + j(R, 0.3)], m = [-2.5 + j(R, 0.2), 1.7 + j(R, 0.2)], e = [0.9 + j(R, 0.3), -3.7 + j(R, 0.3)];
    const p1 = quad(a, [-3.6 + j(R, 0.2), 0.5], m, 10);
    const p2 = quad(m, [-1.3 + j(R, 0.3), -0.4 + j(R, 0.3)], e, 22);
    const pts = xf([...p1, ...p2.slice(1)], x, y, sc, rot);
    penStroke(ctx, pts, w, { start: 0.5, end: 0.3 });
  }
  function cross(ctx, x, y, s, R, w, size = 1) {
    const sc = s * size * (0.95 + R() * 0.12), rot = j(R, 0.12);
    const a1 = [-1.9 + j(R, 0.2), -1.9 + j(R, 0.2)], b1 = [1.9 + j(R, 0.2), 2.0 + j(R, 0.2)];
    const a2 = [1.8 + j(R, 0.2), -2.0 + j(R, 0.2)], b2 = [-1.8 + j(R, 0.2), 1.9 + j(R, 0.2)];
    penStroke(ctx, xf(quad(a1, [0.3 + j(R, 0.3), -0.3 + j(R, 0.4)], b1, 16), x, y, sc, rot), w, { start: 0.6, end: 0.35 });
    penStroke(ctx, xf(quad(a2, [-0.2 + j(R, 0.3), -0.2 + j(R, 0.4)], b2, 16), x, y, sc, rot), w, { start: 0.55, end: 0.3 });
  }
  function dash(ctx, x, y, s, R, w) {
    const pts = quad([-1.7, j(R, 0.2)], [0, -0.5 + j(R, 0.2)], [1.7, 0.2 + j(R, 0.2)], 12);
    penStroke(ctx, xf(pts, x, y, s, j(R, 0.08)), w, { start: 0.6, end: 0.4 });
  }
  // curved arrow from (sx,sy) to (ex,ey) bowing to the left (into the margin)
  function arrow(ctx, sx, sy, ex, ey, s, R, w, laneX0) {
    const dy = ey - sy;
    let cx = Math.min(sx, ex) - (5.0 + Math.min(10, Math.abs(dy) / s * 0.3)) * s;
    cx = Math.max(laneX0 + 0.5 * s, cx);
    const cy = (sy + ey) / 2 + j(R, 0.8) * s;
    const body = quad([sx, sy], [cx, cy], [ex, ey], 30).map(([px, py], i, arr) => {
      const t = i / (arr.length - 1);
      return [px + Math.sin(t * Math.PI) * j(R, 0.15) * s, py];
    });
    penStroke(ctx, body, w, { start: 0.45, end: 0.75 });
    // head: tangent at the end
    const [px, py] = body[body.length - 4];
    const ang = Math.atan2(ey - py, ex - px);
    const L = (1.9 + R() * 0.3) * s, spread = 0.5 + j(R, 0.06);
    const h1 = [ex - L * Math.cos(ang - spread), ey - L * Math.sin(ang - spread)];
    const h2 = [ex - L * Math.cos(ang + spread), ey - L * Math.sin(ang + spread)];
    penStroke(ctx, quad(h1, [(h1[0] + ex) / 2 + j(R, 0.15) * s, (h1[1] + ey) / 2], [ex, ey], 8), w * 0.95, { start: 0.6, end: 0.8 });
    penStroke(ctx, quad([ex, ey], [(h2[0] + ex) / 2, (h2[1] + ey) / 2 + j(R, 0.15) * s], h2, 8), w * 0.95, { start: 0.8, end: 0.45 });
  }
  function hand(ctx, text, x, y, px, R, opt = {}) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(opt.rot ?? j(R, 0.05));
    ctx.font = FONT(px, opt.weight || 600); ctx.fillStyle = INK;
    ctx.textAlign = opt.align || 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  function wrapHand(ctx, text, maxW, px) {
    ctx.font = FONT(px, 400);
    const words = String(text).split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function inkStroke(ctx, st) {
    const p = st.pts; if (!p || !p.length) return;
    ctx.strokeStyle = INK; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = st.w || 3;
    ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
    if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    if (p.length > 1) ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    ctx.stroke();
  }

  // Draw every annotation for one page onto ctx (rectified page px space, 1275x1650)
  // g: graded student (see Grade.compute) ; seed: deterministic per student
  function drawOverlay(ctx, exam, L, g, stu, pageNo, opts = {}) {
    const s = Layout.PX, W = 2.6 * (opts.scale || 1);
    const items = [];
    for (const q of L.mc.filter(q => q.page === pageNo)) {
      const r = g.mc[q.qid]; if (!r) continue;
      const R = U.rng(stu.id + ':' + q.qid);
      const ch = Object.fromEntries(q.choices.map(c => [c.label, c]));
      const off = r.off || [0, 0];
      const px = c => ({ x: c.x * s + off[0], y: c.y * s + off[1] });
      const rad = q.r * s;
      const key = r.key && ch[r.key] ? px(ch[r.key]) : null;
      const laneX0 = q.lane.x0 * s;
      const target = key ? { x: key.x - rad - 0.9 * s, y: key.y } : null;
      if (r.state === 'review') continue;
      if (q.flat) {
        // homework / quiz choices side by side: small marks left of the bubbles
        // the right answer gets a hand-drawn ring (an arrow across the other choices would be hard to read)
        const ring = () => { const rr = rad + 1.1 * s, a0 = -2.2 + j(R, 0.3), pts = [];
          for (let k = 0; k <= 34; k++) { const t = a0 + (k / 34) * (Math.PI * 2 + 0.5); pts.push([key.x + Math.cos(t) * rr * (1 + j(R, 0.03)), key.y + Math.sin(t) * rr * 0.92]); }
          penStroke(ctx, pts, W * 0.9, { start: 0.5, end: 0.4 }); };
        if (r.state === 'correct') { const b = px(ch[r.answer]); check(ctx, b.x - rad - 0.6 * s, b.y + 0.4 * s, s * 0.8, R, W); }
        else if (r.state === 'wrong' || r.state === 'multiple') {
          const marks = (r.state === 'multiple' ? (r.marked || []).filter(l => l !== r.key) : [r.answer]).filter(l => ch[l]);
          marks.forEach(l => { const b = px(ch[l]); cross(ctx, b.x - rad - 2.6 * s, b.y, s, R, W, 0.85); });
          if (key && marks.length) ring();
        } else if (r.state === 'blank') {
          const first = px(q.choices[0]);
          dash(ctx, first.x - rad - 2.6 * s, first.y - 0.2 * s, s, R, W);
          if (key) ring();
        }
        continue;
      }
      if (r.state === 'correct') {
        const b = px(ch[r.answer]);
        check(ctx, b.x - rad - 1.6 * s, b.y + 0.4 * s, s * 1.2, R, W);
      } else if (r.state === 'wrong' || r.state === 'multiple') {
        const marks = (r.state === 'multiple' ? (r.marked || []).filter(l => l !== r.key) : [r.answer]).filter(l => ch[l]);
        marks.forEach(l => { const b = px(ch[l]); cross(ctx, b.x - rad - 3.2 * s, b.y, s, R, W, 1.08); });
        if (target && marks.length) {
          const from = px(ch[marks[0]]);
          let sx = from.x - rad - 6.6 * s, sy = from.y + 0.6 * s;
          if (Math.abs(sy - target.y) < 1.5 * s) sy -= 3.5 * s;
          arrow(ctx, sx, sy, target.x, target.y, s, R, W * 0.92, laneX0);
        }
      } else if (r.state === 'blank') {
        const first = px(q.choices[0]);
        const dy = first.y - 0.2 * s;
        dash(ctx, first.x - rad - 3.0 * s, dy, s, R, W);
        if (target) {
          let sx = first.x - rad - 5.6 * s, sy = dy;
          if (Math.abs(sy - target.y) < 1.5 * s) { sy = target.y - 4.0 * s; sx = first.x - rad - 6.5 * s; }
          arrow(ctx, sx, sy, target.x, target.y, s, R, W * 0.92, laneX0);
        }
      }
    }
    for (const q of L.sa.filter(q => q.page === pageNo)) {
      const r = g.sa[q.qid] || {};
      const R = U.rng(stu.id + ':' + q.qid);
      if (r.pts !== null && r.pts !== undefined) {
        const sb = q.scoreBox;
        const txt = `${U.fmt(r.pts)}/${U.fmt(q.max)}`;
        const fpx = (txt.length > 4 ? 5.0 : 5.8) * s;
        hand(ctx, txt, (sb.x + sb.w / 2 + 0.4) * s, (sb.y + sb.h * 0.5 + fpx / s * 0.36 + 0.6) * s, fpx, R, { align: 'center', rot: -0.05 });
      }
      const text = [...(r.comments || []), r.note || ''].map(t => String(t).trim()).filter(Boolean).join('; ');
      if (text) {
        const c = q.comment;
        let px = 5.2 * s, lines = wrapHand(ctx, text, c.w * s, px);
        while (lines.length > 2 && px > 3.0 * s) { px -= 0.3 * s; lines = wrapHand(ctx, text, c.w * s, px); }
        if (lines.length > 2) { lines = lines.slice(0, 2); lines[1] = lines[1].replace(/\s*\S*$/, '') + '...'; }
        lines.forEach((ln, i) => hand(ctx, ln, c.x * s + 1 * s, c.y * s + px * 0.95 + i * px * 0.95, px, R, { weight: 400, rot: j(R, 0.012) }));
      }
    }
    if (pageNo === 1 && L.cover && g.total !== undefined) {
      const sb = L.cover.score, R = U.rng(stu.id + ':total');
      if (L.cover.compact) {
        // homework / quiz header: "Score ____ / total" in one line; the total goes on the blank, the percent at the right
        hand(ctx, U.fmt(g.total), (sb.x + 23) * s, (sb.y + 6.6) * s, 6.4 * s, R, { align: 'center', rot: -0.03 });
        hand(ctx, `(${U.fmt(g.pct)}%)`, (sb.x + sb.w - 2) * s, (sb.y + 6.6) * s, 3.1 * s, R, { align: 'right', rot: -0.02 });
      } else {
        const cx = (sb.x + sb.w / 2) * s;
        hand(ctx, `${U.fmt(g.total)}/${U.fmt(g.max)}`, cx, (sb.y + 15.5) * s, 11 * s, R, { align: 'center', rot: -0.04 });
        hand(ctx, `(${U.fmt(g.pct)}%)`, cx + 1 * s, (sb.y + 24.5) * s, 6.4 * s, R, { align: 'center', rot: -0.03 });
      }
    }
    // free ink and stamps (teacher)
    const ink = (stu.ink && stu.ink[pageNo]) || [];
    ink.forEach(st => {
      if (st.type === 'check') check(ctx, st.x, st.y, s * 1.3, U.rng(st.id || 'c'), W * 1.1);
      else if (st.type === 'cross') cross(ctx, st.x, st.y, s * 1.3, U.rng(st.id || 'x'), W * 1.1);
      else inkStroke(ctx, st);
    });
  }

  // compose scan image + overlay into a canvas of the rectified size (or scaled)
  async function renderPage(img, exam, L, g, stu, pageNo, opt = {}) {
    await ensureFont();
    const sc = opt.scale || 1;
    const W = Math.round(Layout.RW * sc), H = Math.round(Layout.RH * sc);
    const c = opt.canvas || CV.canvasOf(W, H);
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (img) ctx.drawImage(img, 0, 0, W, H);
    const ov = CV.canvasOf(W, H), octx = ov.getContext('2d');
    octx.scale(sc, sc);
    if (g && stu) drawOverlay(octx, exam, L, g, stu, pageNo);
    ctx.save();
    ctx.globalAlpha = 0.93;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(ov, 0, 0);
    ctx.restore();
    return c;
  }

  return { ensureFont, renderPage, drawOverlay, check, cross, inkStroke, INK };
})();
