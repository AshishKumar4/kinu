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
 * Reveal the React-rendered search graph. The server sends every graph in its
 * finished state, so no script and reduced motion both retain the full figure.
 * The first viewport entry walks optimise once; a tab click selects and replays
 * that preset. Nothing loops by itself.
 */
export const HERO_TREE_SCRIPT = `
(() => {
  const root = document.querySelector('[data-hero-search]');
  if (root === null) return;
  const status = root.querySelector('[data-ht-status]');
  const tabs = [...root.querySelectorAll('[data-ht-tab]')];
  const graphs = [...root.querySelectorAll('.ht-graph')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };
  const halt = () => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    root.removeAttribute('data-playing');
  };
  const settle = (graph) => {
    for (const element of graph.querySelectorAll('[data-arrive]')) {
      element.setAttribute('data-shown', '');
    }
    graph.setAttribute('data-measured', '');
    if (!graph.hasAttribute('data-unranked')) graph.setAttribute('data-lit', '');
  };
  const select = (preset, animate) => {
    halt();
    const graph = graphs.find((candidate) => candidate.dataset.preset === preset);
    if (graph === undefined) return;
    for (const candidate of graphs) {
      candidate.toggleAttribute('data-live', candidate === graph);
      if (candidate !== graph) settle(candidate);
    }
    for (const tab of tabs) {
      tab.toggleAttribute('data-lit', tab.dataset.htTab === preset);
    }
    if (!animate || reduced) {
      settle(graph);
      if (status !== null) status.textContent = graph.dataset.phaseEnd ?? '';
      return;
    }
    for (const element of graph.querySelectorAll('[data-arrive]')) {
      element.removeAttribute('data-shown');
    }
    graph.removeAttribute('data-measured');
    graph.removeAttribute('data-lit');
    root.setAttribute('data-playing', '');
    if (status !== null) status.textContent = graph.dataset.phaseStart ?? '';
    const elements = [...graph.querySelectorAll('[data-arrive]')];
    const beats = [...new Set(elements.map((element) => Number(element.dataset.arrive)))]
      .sort((a, b) => a - b);
    let at = 0;
    const reveal = () => {
      const beat = beats[at];
      for (const element of elements) {
        if (Number(element.dataset.arrive) === beat) element.setAttribute('data-shown', '');
      }
      at += 1;
      if (at < beats.length) {
        later(reveal, 240);
        return;
      }
      later(() => {
        graph.setAttribute('data-measured', '');
        if (status !== null) status.textContent = graph.dataset.phaseMid ?? '';
        later(() => {
          if (!graph.hasAttribute('data-unranked')) graph.setAttribute('data-lit', '');
          root.removeAttribute('data-playing');
          if (status !== null) status.textContent = graph.dataset.phaseEnd ?? '';
        }, 900);
      }, 500);
    };
    reveal();
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.htTab, true));
  }
  if (reduced) {
    select('optimise', false);
  } else {
    new IntersectionObserver((entries, observer) => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      select('optimise', true);
    }, { threshold: 0.3 }).observe(root);
  }
})();`;

/**
 * Drive the two DOM previews as small interfaces, not looping slideshows.
 * Each runs once when first seen. Chapter buttons, pause/resume and replay
 * expose the state directly; reduced motion keeps the complete interface.
 */
export const PREVIEW_SCRIPT = `
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STEP = 900;
  for (const fig of document.querySelectorAll('[data-preview]')) {
    const beats = [...fig.querySelectorAll('[data-beat]')];
    if (beats.length === 0) continue;
    const total = Math.max(...beats.map((beat) => Number(beat.dataset.beat))) + 1;
    const toggle = fig.querySelector('[data-preview-toggle]');
    let at = total;
    let timer = 0;
    let paused = false;
    let started = false;
    const stop = () => {
      clearTimeout(timer);
      timer = 0;
    };
    const label = (text, disabled = false) => {
      if (toggle === null) return;
      toggle.textContent = text;
      toggle.toggleAttribute('disabled', disabled);
    };
    const show = (upto) => {
      at = Math.max(0, Math.min(total, upto));
      for (const beat of beats) {
        beat.toggleAttribute('data-beat-shown', Number(beat.dataset.beat) < at);
      }
      for (const button of fig.querySelectorAll('[data-preview-go]')) {
        button.toggleAttribute('data-lit', Number(button.dataset.previewGo) === at);
      }
    };
    const step = () => {
      if (paused) return;
      if (at >= total) {
        stop();
        fig.removeAttribute('data-preview-running');
        label('done', true);
        return;
      }
      show(at + 1);
      timer = setTimeout(step, STEP);
    };
    const run = () => {
      stop();
      paused = false;
      fig.setAttribute('data-preview-running', '');
      show(0);
      label('pause');
      step();
    };
    for (const button of fig.querySelectorAll('[data-preview-go]')) {
      button.addEventListener('click', () => {
        stop();
        fig.setAttribute('data-preview-running', '');
        paused = true;
        show(Number(button.dataset.previewGo));
        label('resume');
      });
    }
    fig.querySelector('[data-preview-replay]')?.addEventListener('click', run);
    toggle?.addEventListener('click', () => {
      if (paused) {
        paused = false;
        label('pause');
        step();
      } else {
        paused = true;
        stop();
        label('resume');
      }
    });
    if (reduced) {
      show(total);
      label('motion off', true);
      continue;
    }
    new IntersectionObserver((entries, observer) => {
      if (!entries[0].isIntersecting || started) return;
      started = true;
      observer.disconnect();
      run();
    }, { threshold: 0.35 }).observe(fig);
  }
})();`;
