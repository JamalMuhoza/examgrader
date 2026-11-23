/* Exam Grader - shared helpers */
'use strict';

const U = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  function uid(prefix = '') {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return prefix + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // FNV-1a 32 bit
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function hash8(str) { const h = fnv(str); return ((h >>> 24) ^ (h >>> 16) ^ (h >>> 8) ^ h) & 255; }

  // deterministic pseudo random generator (mulberry32)
  function rng(seed) {
    let a = (typeof seed === 'string' ? fnv(seed) : seed) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
  }

  // jsPDF standard fonts are WinAnsi only; map common science characters.
  const SUBS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-' };
  const SUPS = { '⁰': '0', '¹': '1', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };
  const GREEK = { 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'Δ': 'Delta', 'ε': 'epsilon', 'θ': 'theta', 'λ': 'lambda', 'π': 'pi', 'σ': 'sigma', 'ω': 'omega', 'Ω': 'Omega', 'κ': 'kappa', 'ρ': 'rho', 'τ': 'tau', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'η': 'eta', 'ν': 'nu', 'ζ': 'zeta' };
  function pdfText(s) {
    return String(s || '')
      .replace(/[₀-₋]/g, c => SUBS[c] || c)
      .replace(/[⁰-⁻]/g, c => SUPS[c] || c)
      .replace(/[α-ωΔΩ]/g, c => GREEK[c] || c)
      .replace(/[→⟶]/g, '->').replace(/[⇌⇄]/g, '<=>').replace(/←/g, '<-')
      .replace(/[≤]/g, '<=').replace(/[≥]/g, '>=').replace(/[≈]/g, '~').replace(/[−]/g, '-')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—•…]/g, '?');
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function dataURLToBlob(url) { const r = await fetch(url); return r.blob(); }
  function canvasToBlob(canvas, type = 'image/jpeg', q = 0.88) {
    return new Promise(res => canvas.toBlob(b => res(b), type, q));
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  async function blobToImage(blob) {
    if (window.createImageBitmap) { try { return await createImageBitmap(blob); } catch (e) { /* fall through */ } }
    const url = URL.createObjectURL(blob);
    try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function toast(msg, kind = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = el('div', { id: 'toasts' }); document.body.appendChild(box); }
    const t = el('div', { class: 'toast ' + kind, text: msg });
    box.appendChild(t);
    setTimeout(() => t.classList.add('out'), 3800);
    setTimeout(() => t.remove(), 4400);
  }

  return { $, $$, el, uid, fnv, hash8, rng, download, safeName, pdfText, blobToDataURL, dataURLToBlob, canvasToBlob, loadImage, blobToImage, sleep, fmt, esc, toast };
})();
