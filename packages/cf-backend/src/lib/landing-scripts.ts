/**
 * The landing's behaviour, as CSP-safe inline scripts.
 *
 * The page ships prerendered and finished; these scripts add what markup
 * cannot carry. Each one is written to leave the prerendered state on screen
 * when it does not run: no script, a blocked script, or a reader who asked
 * for reduced motion all get the designed still rather than a blank.
 */

/** Nav theme toggle. Mirrors the app's top-bar control: one button, sun or
 *  moon by current mode, writes the same storage key the pre-paint script
 *  reads, flips `data-mode` and `color-scheme` in place. No flash: the
 *  pre-paint script pinned the mode before first paint. */
export const MODE_TOGGLE_SCRIPT = `
(() => {
  const buttons = document.querySelectorAll('[data-mode-toggle]');
  if (buttons.length === 0) return;
  const paint = () => {
    const light = document.documentElement.dataset.mode === 'light';
    for (const b of buttons) {
      b.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
      for (const icon of b.querySelectorAll('[data-icon]')) {
        icon.style.display = (icon.dataset.icon === 'moon') === light ? '' : 'none';
      }
    }
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next = document.documentElement.dataset.mode === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-mode', next);
      document.documentElement.style.colorScheme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
      paint();
    });
  }
  paint();
})();`;

/** The hero claim types itself through six phrases — in at human cadence,
 *  hold, out, next. The server ships phrase one COMPLETE, so a reader with
 *  no script reads the strongest claim and nothing can ever overlap: one
 *  span is rewritten in place. Reduced motion never starts it. */
export const TYPEWRITER_SCRIPT = `
(() => {
  const phrases = ${JSON.stringify(['get better with use.', 'craft their own tools.', 'command scored swarms.', 'work while you sleep.', 'improve their prompts.', 'run cloud, or local.'])};
  const el = document.querySelector('[data-typewriter]');
  if (el === null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let phraseI = 0, len = phrases[0].length, typing = false;
  const caret = el.querySelector('[data-caret]');
  const render = () => {
    el.firstChild?.remove();
    el.insertBefore(document.createTextNode(phrases[phraseI].slice(0, len)), caret);
  };
  const step = () => {
    const p = phrases[phraseI];
    let d = 50;
    if (typing) {
      if (len < p.length) { len += 1; d = 42 + Math.random() * 46; }
      else { typing = false; d = 2600; }
    } else {
      if (len > 0) { len -= 1; d = 20; }
      else { typing = true; phraseI = (phraseI + 1) % phrases.length; d = 420; }
    }
    render();
    setTimeout(step, d);
  };
  setTimeout(() => { len = 0; typing = true; render(); step(); }, 2600);
})();`;

/**
 * The hero figure: the owner's procedural tree from his artifact
 * (buildTree + draw), ported line-for-line, with two serving changes.
 * Colours are re-read from tokens when the mode attribute moves, so a theme
 * toggle re-inks the canvas live; reduced motion draws ONE settled frame
 * instead of animating. INTERIM data note stands: MotionRedesign2's
 * recorded-data module replaces this script wholesale.
 */
export const HERO_TREE_SCRIPT = `
(() => {
  const canvas = document.getElementById('hero-tree');
  if (canvas === null) return;
  const statusEl = document.querySelector('[data-hero-status]');
  const tabs = document.querySelectorAll('[data-hero-tabs] [data-mode]');
  const tokenName = { ACCENT: '--c-accent', SHEEN: '--c-accent-fg', INK: '--c-text-2', FAINT: '--c-text-3', GOOD: '--c-success', PANEL: '--c-surface' };
  let ACCENT, SHEEN, INK, GOOD, PANEL;
  const FAINT = '#4A423A', DIM_INK = '#4A423A';
  const resolveInk = () => {
    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => {
      const v = css.getPropertyValue(name).trim();
      return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
    };
    ACCENT = read(tokenName.ACCENT, '#E0A458');
    SHEEN = read(tokenName.SHEEN, '#E3D2AE');
    INK = read(tokenName.INK, '#A2968A');
    GOOD = read(tokenName.GOOD, '#8FBC8B');
    PANEL = read(tokenName.PANEL, '#181512');
  };
  resolveInk();

  let mode = 'optimise';
  let nodes = [], winner = null, winPath = new Set(), labeled = new Set();
  let totalAppear = 0, cycle = 0, t0 = performance.now(), raf = 0;

  const buildTree = (m) => {
    const seed = m === 'research' ? 7 : m === 'ideate' ? 13 : 42;
    const rng = (() => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    nodes = [];
    const W = 1120, H = 880;
    const add = (parent, depth, x, y) => {
      const n = { id: nodes.length, parent, depth, x, y, score: null, children: [] };
      nodes.push(n);
      if (parent !== null) nodes[parent].children.push(n.id);
      return n;
    };
    labeled = new Set(); winner = null; winPath = new Set();
    if (m === 'ideate') {
      const root = add(null, 0, W / 2, 130);
      for (let i = 0; i < 5; i++) add(root.id, 1, 150 + i * (W - 300) / 4, H - 300);
      nodes.forEach((n, i) => { n.appear = 350 + i * 550; });
    } else if (m === 'research') {
      const root = add(null, 0, W / 2, 120);
      const scores = [0.34, 0.82, 0.61, 0.90];
      const cells = scores.map((sc, i) => {
        const c = add(root.id, 1, 170 + i * (W - 340) / 3, H / 2 - 60);
        c.score = sc; return c;
      });
      const top = [...cells].sort((x, y) => y.score - x.score).slice(0, 2);
      top.forEach((c) => {
        for (let j = 0; j < 3; j++) {
          const ch = add(c.id, 2, c.x - 110 + j * 110, H - 240);
          ch.score = Math.min(0.97, c.score + rng() * 0.1 - 0.02);
        }
      });
      nodes.forEach((n, i) => { n.appear = 350 + i * 520; });
      const leaves = nodes.filter((n) => n.depth === 2);
      winner = leaves.reduce((a, b) => (a.score > b.score ? a : b), leaves[0]);
      const path = [];
      for (let n = winner; n; n = n.parent === null ? null : nodes[n.parent]) path.push(n.id);
      winPath = new Set(path);
      nodes.forEach((n) => { if (n.score != null) labeled.add(n.id); });
    } else {
      const levels = 5, topY = 100, bottom = H - 170;
      const mk = (parent, depth, xMin, xMax) => {
        const x = (xMin + xMax) / 2;
        const y = topY + (bottom - topY) * (depth / (levels - 1));
        const n = add(parent, depth, x, y);
        if (depth < levels - 1) {
          let k = depth === 0 ? 3 : (rng() < 0.55 ? 2 : 1);
          if (depth === 1 && rng() < 0.4) k = 3;
          const step = (xMax - xMin) / k;
          for (let i = 0; i < k; i++) {
            if (depth > 0 && rng() < 0.3) continue;
            mk(n.id, depth + 1, xMin + i * step, xMin + (i + 1) * step);
          }
        }
        return n;
      };
      mk(null, 0, 60, W - 60);
      const order = [...nodes].sort((a, b) => a.depth - b.depth || a.x - b.x);
      order.forEach((n, i) => { n.appear = 350 + i * 420 + rng() * 180; });
      nodes.forEach((n) => { n.score = Math.round(320 - n.depth * 48 - rng() * 40); });
      const leaves = nodes.filter((n) => n.children.length === 0);
      const won = leaves.reduce((a, b) => (a.score < b.score ? a : b));
      won.score = 112;
      const path = [];
      for (let n = won; n; n = n.parent === null ? null : nodes[n.parent]) path.push(n.id);
      winner = won; winPath = new Set(path);
      const sorted = leaves.slice().sort((a, b) => a.x - b.x);
      let lastX = -1e9;
      for (const l of sorted) {
        if (l.x - lastX >= 90) { labeled.add(l.id); lastX = l.x; }
      }
      labeled.add(winner.id);
    }
    totalAppear = Math.max(...nodes.map((n) => n.appear));
    cycle = totalAppear + 4800;
  };

  const phases = (m) => m === 'research'
    ? ['COVERING', 'JUDGING', 'BUDGET → TOP CELLS']
    : m === 'ideate'
      ? ['FANNING OUT', '5 CANDIDATES', 'ALL RETURNED · UNRANKED']
      : ['EXPANDING', 'MEASURING', 'WINNER · 112 MS'];

  const mix = (hex, pct) => 'color-mix(in srgb, ' + hex + ' ' + Math.round(pct * 100) + '%, transparent)';
  const draw = (tAbs) => {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const t = tAbs % cycle;
    const P = phases(mode);
    const phase = t < totalAppear + 600 ? P[0] : (t < totalAppear + 2200 ? P[1] : P[2]);
    if (statusEl !== null && statusEl.textContent !== phase) statusEl.textContent = phase;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = mix(INK, 12);
    for (let x = 20; x < W; x += 44) for (let y = 20; y < H; y += 44) ctx.fillRect(x, y, 2, 2);
    const measured = t > totalAppear + 600;
    const won = t > totalAppear + 2200 && winner !== null;
    const winProg = won ? Math.min(1, (t - totalAppear - 2200) / 900) : 0;
    for (const n of nodes) {
      if (n.parent === null) continue;
      const p = nodes[n.parent];
      const ap = Math.min(1, Math.max(0, (t - n.appear) / 500));
      if (ap <= 0) continue;
      const onPath = won && winPath.has(n.id) && winPath.has(p.id);
      ctx.strokeStyle = onPath ? mix(ACCENT, 0.25 + 0.75 * winProg) : mix(DIM_INK, 0.9);
      ctx.lineWidth = onPath ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 10);
      const ex = p.x + (n.x - p.x) * ap, ey = p.y + 10 + (n.y - 10 - (p.y + 10)) * ap;
      ctx.bezierCurveTo(p.x, p.y + 10 + (ey - p.y - 10) * 0.5, ex, ey - (ey - p.y - 10) * 0.4, ex, ey);
      ctx.stroke();
    }
    ctx.font = '19px "Fragment Mono", monospace';
    for (const n of nodes) {
      const ap = Math.min(1, Math.max(0, (t - n.appear) / 400));
      if (ap <= 0) continue;
      const isRoot = n.parent === null;
      const isWin = winner !== null && n.id === winner.id;
      const onPath = won && winPath.has(n.id);
      const r = (isRoot ? 13 : n.children.length === 0 ? 9 : 7.5) * (0.5 + 0.5 * ap);
      const fresh = t - n.appear < 900;
      if (fresh && !measured) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 7 + 4 * Math.sin(t / 180), 0, 7);
        ctx.strokeStyle = mix(ACCENT, 0.25); ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
      if (isWin && won) {
        ctx.fillStyle = ACCENT; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 8 + 3 * Math.sin(t / 250), 0, 7);
        ctx.strokeStyle = mix(ACCENT, 0.5 * winProg); ctx.lineWidth = 1.5; ctx.stroke();
      } else if (onPath) {
        ctx.fillStyle = PANEL; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.stroke();
      } else if (isRoot) {
        ctx.fillStyle = PANEL; ctx.fill(); ctx.strokeStyle = SHEEN; ctx.lineWidth = 2; ctx.stroke();
      } else {
        ctx.fillStyle = PANEL; ctx.fill(); ctx.strokeStyle = measured ? DIM_INK : INK; ctx.lineWidth = 1.4; ctx.stroke();
      }
      if (measured && ap >= 1 && n.score != null && labeled.has(n.id)) {
        const good = mode === 'optimise' ? n.score <= 140 : n.score >= 0.75;
        ctx.fillStyle = isWin && won ? ACCENT : (good ? GOOD : FAINT);
        ctx.textAlign = 'center';
        ctx.fillText(mode === 'optimise' ? n.score + 'ms' : n.score.toFixed(2), n.x, n.y + 38);
        ctx.textAlign = 'left';
      }
    }
    ctx.fillStyle = FAINT;
    const topLabel = mode === 'research'
      ? 'objective: coverage key · scored by judge ensemble'
      : mode === 'ideate'
        ? 'preset: ideate · depth 1 · 5 branches · unranked'
        : 'objective: p95_latency ↓ 120ms · verifier: bench.p95';
    ctx.fillText(topLabel, 40, 46);
    if (won) {
      ctx.fillStyle = ACCENT;
      const bottomLabel = mode === 'research'
        ? 'budget flows to the highest-scored cells'
        : 'winner: 112ms · measured, not judged';
      ctx.fillText(bottomLabel, 40, H - 36);
    }
  };

  const setTab = (m) => {
    if (m === mode) return;
    mode = m;
    for (const tab of tabs) {
      const active = tab.dataset.mode === m;
      tab.style.color = active ? ACCENT : FAINT;
      tab.style.borderBottom = active ? '1px solid ' + mix(ACCENT, 0.5) : '1px solid transparent';
    }
    buildTree(m);
    t0 = performance.now();
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => setTab(tab.dataset.mode));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(tab.dataset.mode); }
    });
  }

  buildTree(mode);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // The finished search, drawn once: the won state at rest.
    draw(totalAppear + 2200 + 900);
    if (statusEl !== null) statusEl.textContent = phases(mode)[2];
  } else {
    let running = true;
    const loop = (now) => {
      if (!running) return;
      draw(now - t0);
      raf = requestAnimationFrame(loop);
    };
    document.addEventListener('visibilitychange', () => {
      running = document.visibilityState === 'visible';
      if (running) requestAnimationFrame(loop);
    });
    raf = requestAnimationFrame(loop);
  }
  // Live re-ink on theme change: the mode attribute is the theme store's own
  // output, so observing it costs nothing and needs no store import.
  new MutationObserver(() => {
    resolveInk();
    for (const tab of tabs) {
      const active = tab.dataset.mode === mode;
      tab.style.color = active ? ACCENT : FAINT;
    }
    draw(totalAppear + 2200 + 900);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
})();`;

/**
 * The interactive previews (§03): beats reveal rows one at a time while the
 * figure is on screen, hold the finished state briefly, then restart — and
 * park completely under prefers-reduced-motion, where every beat ships on.
 * The prerender sends ALL beats visible, so no script still reads the whole
 * sequence as a transcript.
 */
export const PREVIEW_SCRIPT = `
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const STEP = 900;
  const HOLD = 3200;
  for (const fig of document.querySelectorAll('[data-preview]')) {
    const beats = [...fig.querySelectorAll('[data-beat]')];
    if (beats.length === 0) continue;
    const total = Math.max(...beats.map((b) => Number(b.dataset.beat))) + 1;
    let intervalId = 0;
    let timeoutId = 0;
    const show = (upto) => {
      for (const b of beats) b.toggleAttribute('data-beat-shown', Number(b.dataset.beat) < upto);
    };
    const run = () => {
      let at = 0;
      show(0);
      intervalId = setInterval(() => {
        at += 1;
        if (at > total) {
          clearInterval(intervalId);
          show(total + 1);
          timeoutId = setTimeout(run, HOLD);
          at = -2;
        } else show(at);
      }, STEP);
    };
    new IntersectionObserver((entries) => {
      const on = entries[0].isIntersecting;
      if (on && !intervalId) run();
      if (!on) { clearInterval(intervalId); clearTimeout(timeoutId); intervalId = 0; show(total + 1); }
    }, { threshold: 0.35 }).observe(fig);
  }
})();`;
