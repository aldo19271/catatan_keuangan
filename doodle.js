/* Gerak & hiasan tema doodle: pegas (spring) ala Framer Motion, garis "mendidih" tangan, coretan yang digambar,
   bintang/squiggle melayang. Murni tambahan visual: tidak menyentuh logika aplikasi. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const root = document.documentElement;
  const SPR = (getComputedStyle(root).getPropertyValue('--spr') || '').trim() || 'cubic-bezier(.3,1.5,.5,1)';
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
  const can = (n) => n && n.animate;

  /* 1. filter "kasar": garis grafik bergetar seperti digambar tangan (animasi stop-motion ~5 fps) */
  const defs = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute' });
  const flt = el('filter', { id: 'rough', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
  const turb = el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.03', numOctaves: '2', seed: '2', result: 'n' }, flt);
  el('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '3.4' }, flt);
  document.body.prepend(defs);
  let seed = 2;
  setInterval(() => { if (!document.hidden) turb.setAttribute('seed', String((seed = seed % 5 + 1))); }, 200);

  /* 2. hiasan melayang di belakang halaman */
  const bg = document.createElement('div'); bg.className = 'doodle-bg'; bg.setAttribute('aria-hidden', 'true'); document.body.prepend(bg);
  const SHAPES = [
    ['M12 2 L15 9 L22 10 L17 15 L18.5 22 L12 18.5 L5.5 22 L7 15 L2 10 L9 9 Z', '#ffd84d'],       // bintang
    ['M2 12 C6 4,10 20,14 12 S22 4,26 12', '#ff8fc3'],                                              // squiggle
    ['M12 3 a9 9 0 1 0 .1 0', '#7cc4ff'],                                                           // lingkaran
    ['M12 3 V21 M3 12 H21', '#5ee6a8'],                                                             // tambah
    ['M3 18 C10 4,16 4,22 12 M22 12 L15 11 M22 12 L20 19', '#ff8a2b'],                              // panah melengkung
    ['M3 20 L9 6 L15 20 L21 6', '#ffd84d'],                                                         // zigzag
  ];
  const spots = [[7, 12], [86, 8], [92, 38], [4, 52], [80, 66], [14, 82], [60, 90], [46, 5], [30, 40], [70, 28]];
  spots.forEach(([x, y], i) => {
    const [d, c] = SHAPES[i % SHAPES.length];
    const s = el('svg', { viewBox: '0 0 28 24', width: 26 + (i % 3) * 8, height: 22 + (i % 3) * 7, style: `left:${x}%;top:${y}%;stroke:${c}` }, bg);
    el('path', { d }, s);
    if (can(s)) s.animate([
      { transform: 'translate(0,0) rotate(-8deg)' },
      { transform: `translate(${(i % 2 ? 1 : -1) * 14}px,${12 + (i % 4) * 5}px) rotate(10deg)` },
    ], { duration: 5200 + i * 700, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out', delay: -i * 900 });
  });

  /* 3. coretan garis bawah judul: digambar saat tampil */
  const SCRIBBLE = 'M2 7 C14 1,22 12,34 6 S54 2,66 7 S86 11,98 5 S118 3,130 7';
  const addScrib = (host) => {
    if (host.dataset.scrib) return; host.dataset.scrib = '1';
    const s = el('svg', { viewBox: '0 0 132 12', class: 'scrb', 'aria-hidden': 'true' });
    const p = el('path', { d: SCRIBBLE, pathLength: '1', 'stroke-dasharray': '1', 'stroke-dashoffset': '0' }, s);
    host.after(s); s._p = p;
    if ('IntersectionObserver' in window) io.observe(s);
  };
  const draw = (s) => { const p = s._p; if (can(p)) p.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 900, easing: 'cubic-bezier(.3,.8,.3,1)', delay: 150 }); };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) draw(e.target); }), { threshold: 0.6 }) : null;
  const SCRIB_SEL = '.top h1, .stc h2';
  const scanScrib = (n) => { if (n.matches && n.matches(SCRIB_SEL)) addScrib(n); n.querySelectorAll && n.querySelectorAll(SCRIB_SEL).forEach(addScrib); };

  /* 4. pegas saat ditekan (whileTap): mengecil lalu memantul kembali */
  const TAP = 'button:not(:disabled):not(.fab):not(.bar-btn), .day, .gcard, .tx-main';
  const springBack = (t, from) => { t.getAnimations().forEach((a) => { if (a._tap) a.cancel(); });
    const a = t.animate([{ scale: from }, { scale: 1 }], { duration: 650, easing: SPR }); a._tap = true; };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest(TAP); if (!t || !can(t)) return;
    t.getAnimations().forEach((a) => { if (a._tap) a.cancel(); });
    const a = t.animate([{ scale: 1 }, { scale: 0.92 }], { duration: 110, fill: 'forwards', easing: 'ease-out' }); a._tap = true; t._down = true;
  }, { passive: true });
  const up = (e) => { const t = e.target.closest && e.target.closest(TAP); if (t && t._down) { t._down = false; springBack(t, 0.92); } };
  document.addEventListener('pointerup', up, { passive: true });
  document.addEventListener('pointercancel', up, { passive: true });

  /* 5. kemunculan catatan: melompat masuk bergantian */
  const pop = (n, i) => { if (!can(n)) return;
    n.animate([{ translate: '-18px 10px', rotate: '-2deg', scale: 0.94 }, { translate: '0 0', rotate: '0deg', scale: 1 }], { duration: 700, easing: SPR, delay: Math.min(i, 8) * 55, fill: 'backwards' }); };
  const popAll = (host) => { let i = 0; const list = host.matches && host.matches('.tx') ? [host] : host.querySelectorAll ? host.querySelectorAll('.tx') : []; list.forEach((n) => pop(n, i++)); };

  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; scanScrib(n); popAll(n); } })
    .observe(document.body, { childList: true, subtree: true });
  scanScrib(document.body);

  /* 6. logo goyang saat disentuh */
  document.addEventListener('click', (e) => { const l = e.target.closest && e.target.closest('.logo'); if (l && can(l)) l.animate([{ rotate: '0deg' }, { rotate: '-24deg' }, { rotate: '14deg' }, { rotate: '0deg' }], { duration: 700, easing: 'ease-in-out' }); });
})();
