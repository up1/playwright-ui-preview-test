// Visual test runner: steps through a Playwright spec statement by statement,
// highlighting the code lines and focusing the matching element in the webview.
(function () {
  const TIMEOUT = 5000;
  const SPEEDS = { slow: 1200, normal: 600, fast: 150 };
  const ACTIONS = new Set([
    'click', 'dblclick', 'fill', 'type', 'pressSequentially', 'clear', 'press',
    'check', 'uncheck', 'hover', 'focus', 'selectOption', 'waitFor', 'waitForSelector',
  ]);
  const LOCATOR_KINDS = {
    locator: 'css', getByText: 'text', getByRole: 'role', getByLabel: 'label',
    getByPlaceholder: 'placeholder', getByTestId: 'testid', getByAltText: 'alt', getByTitle: 'title',
  };

  let running = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- Parsing ----------------

  function skipString(src, i) {
    const q = src[i++];
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    return i + 1;
  }

  // Splits source into top-level `await ...;` statements with their line ranges.
  function extractStatements(src) {
    const out = [];
    const lineOf = (offset) => src.slice(0, offset).split('\n').length;
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
      if (src.startsWith('await', i) && !/[\w$]/.test(src[i - 1] || '') && !/[\w$]/.test(src[i + 5] || '')) {
        let depth = 0;
        let j = i + 5;
        while (j < src.length) {
          const d = src[j];
          if (d === '"' || d === "'" || d === '`') { j = skipString(src, j); continue; }
          if ('([{'.includes(d)) depth++;
          else if (')]}'.includes(d)) { if (depth === 0) break; depth--; }
          else if (d === ';' && depth === 0) break;
          j++;
        }
        out.push({ text: src.slice(i + 5, j).trim(), startLine: lineOf(i), endLine: lineOf(j - 1) });
        i = j;
        continue;
      }
      i++;
    }
    return out;
  }

  // Splits on `sep` at depth 0, ignoring separators inside strings and brackets.
  function splitTop(s, sep) {
    const parts = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(s, i) - 1; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === sep && depth === 0) { parts.push(s.slice(last, i)); last = i + 1; }
    }
    parts.push(s.slice(last));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function matchParen(s, i) {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') { i = skipString(s, i) - 1; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i;
    }
    return s.length;
  }

  // `page.locator('#a').fill('x')` -> [{name:'page'}, {name:'locator', args}, {name:'fill', args}]
  function parseChain(text) {
    const segs = [];
    let i = 0;
    const ws = () => { while (/\s/.test(text[i])) i++; };
    while (i < text.length) {
      ws();
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
      if (!m) return null;
      i += m[0].length;
      ws();
      let args = null;
      if (text[i] === '(') {
        const end = matchParen(text, i);
        args = text.slice(i + 1, end);
        i = end + 1;
        ws();
      }
      segs.push({ name: m[0], args });
      if (text[i] === '.') { i++; continue; }
      if (i < text.length) return null;
    }
    return segs;
  }

  function parseValue(raw, ctx) {
    raw = raw.trim();
    const parts = splitTop(raw, '+');
    if (parts.length > 1) {
      const vals = parts.map((p) => parseValue(p, ctx));
      return vals.some((v) => typeof v !== 'string') ? undefined : vals.join('');
    }
    if (/^(['"])[\s\S]*\1$/.test(raw)) {
      return raw.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
    }
    if (/^`[^`$]*`$/.test(raw)) return raw.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (raw === '__dirname') return ctx.dirname;
    const re = /^\/(.+)\/([gimsuy]*)$/s.exec(raw);
    if (re) return { regex: re[1], flags: re[2] };
    if (raw.startsWith('{') && raw.endsWith('}')) {
      const obj = {};
      for (const pair of splitTop(raw.slice(1, -1), ',')) {
        const idx = pair.indexOf(':');
        if (idx < 0) continue;
        obj[pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, '')] = parseValue(pair.slice(idx + 1), ctx);
      }
      return obj;
    }
    return undefined;
  }

  const parseArgs = (args, ctx) => splitTop(args || '', ',').map((a) => parseValue(a, ctx));

  function buildLocator(segs, ctx) {
    const steps = [];
    for (const s of segs) {
      if (s.name === 'page' || s.name === 'heal') continue;
      const args = parseArgs(s.args, ctx);
      if (LOCATOR_KINDS[s.name]) {
        if (args[0] === undefined) return null;
        const opts = (args[1] && typeof args[1] === 'object' && !args[1].regex && args[1]) || {};
        steps.push({ kind: LOCATOR_KINDS[s.name], value: args[0], name: opts.name, exact: !!opts.exact });
      } else if (s.name === 'first') steps.push({ kind: 'nth', value: 0 });
      else if (s.name === 'last') steps.push({ kind: 'nth', value: -1 });
      else if (s.name === 'nth') steps.push({ kind: 'nth', value: args[0] });
      else return null;
    }
    return steps.length ? steps : null;
  }

  // Turns a statement into a runnable command, or null if unsupported.
  function interpret(text, ctx) {
    const chain = parseChain(text);
    if (!chain) return null;

    if (chain[0].name === 'expect' && chain[0].args != null) {
      const inner = parseChain(chain[0].args);
      const locator = inner && buildLocator(inner, ctx);
      let rest = chain.slice(1);
      const not = rest[0]?.name === 'not';
      if (not) rest = rest.slice(1);
      if (!locator || rest.length !== 1 || rest[0].args == null) return null;
      return { type: 'expect', locator, matcher: rest[0].name, args: parseArgs(rest[0].args, ctx), not };
    }

    if (chain[0].name !== 'page') return null;
    const segs = chain.filter((s) => s.name !== 'page' && s.name !== 'heal');
    const last = segs[segs.length - 1];
    if (!last || last.args == null) return null;
    const args = parseArgs(last.args, ctx);

    if (segs.length === 1) {
      if (last.name === 'goto') return typeof args[0] === 'string' ? { type: 'goto', url: args[0] } : null;
      if (last.name === 'waitForTimeout') return { type: 'wait', ms: Number(args[0]) || 0 };
      if (!ACTIONS.has(last.name) || typeof args[0] !== 'string') return null;
      // page.fill(selector, value) — the value is the last argument, which also
      // covers page.heal.fill(selector, description, value).
      const value = args.length > 1 ? args[args.length - 1] : undefined;
      return { type: 'action', action: last.name, locator: [{ kind: 'css', value: args[0] }], value };
    }

    const locator = buildLocator(segs.slice(0, -1), ctx);
    if (!locator || !ACTIONS.has(last.name)) return null;
    return { type: 'action', action: last.name, locator, value: args[0] };
  }

  function describe(cmd) {
    if (cmd.type === 'goto') return `goto ${cmd.url}`;
    if (cmd.type === 'wait') return `wait ${cmd.ms}ms`;
    const loc = cmd.locator
      .map((s) => (s.kind === 'nth' ? `nth(${s.value})` : `${s.kind}=${fmt(s.value)}${s.name ? ` name=${fmt(s.name)}` : ''}`))
      .join(' >> ');
    if (cmd.type === 'expect') return `expect(${loc})${cmd.not ? '.not' : ''}.${cmd.matcher}(${cmd.args.map(fmt).join(', ')})`;
    return `${cmd.action} ${loc}${cmd.value !== undefined && cmd.action !== 'click' ? ` ${fmt(cmd.value)}` : ''}`;
  }

  const fmt = (v) => (v && v.regex ? `/${v.regex}/${v.flags}` : JSON.stringify(v));

  // ---------------- In-page script (runs inside the webview) ----------------

  function pageRunner(p) {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const matchText = (actual, expected, exact) => {
      actual = norm(actual);
      if (expected && expected.regex) return new RegExp(expected.regex, expected.flags).test(actual);
      expected = norm(String(expected));
      return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
    };
    const labelText = (el) => norm([...(el.labels || [])].map((l) => l.innerText).join(' ') || el.getAttribute('aria-label'));
    const accName = (el) =>
      norm(el.getAttribute('aria-label') || labelText(el) || el.innerText || el.value || el.getAttribute('title') || '');
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const ROLES = {
      button: 'button,[role=button],input[type=button],input[type=submit],input[type=reset]',
      link: 'a[href],[role=link]',
      textbox: 'input:not([type]),input[type=text],input[type=email],input[type=password],input[type=search],' +
        'input[type=tel],input[type=url],input[type=number],textarea,[role=textbox]',
      checkbox: 'input[type=checkbox],[role=checkbox]',
      radio: 'input[type=radio],[role=radio]',
      heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
      combobox: 'select,[role=combobox]',
      img: 'img,[role=img]',
      listitem: 'li,[role=listitem]',
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'NOSCRIPT']);
    const byText = (root, text, exact) =>
      [...root.querySelectorAll('*')].filter(
        (el) => !SKIP.has(el.tagName) && matchText(el.innerText, text, exact) &&
          ![...el.children].some((c) => !SKIP.has(c.tagName) && matchText(c.innerText, text, exact))
      );
    const all = (root, sel) => [...root.querySelectorAll(sel)];

    const find = (root, s) => {
      switch (s.kind) {
        case 'css':
          if (/^text=/.test(s.value)) return byText(root, s.value.slice(5).replace(/^["']|["']$/g, ''), false);
          try { return all(root, s.value); } catch { return byText(root, s.value, false); }
        case 'text': return byText(root, s.value, s.exact);
        case 'role':
          return all(root, ROLES[s.value] || `[role="${s.value}"]`)
            .filter((el) => s.name == null || matchText(accName(el), s.name, s.exact));
        case 'label': return all(root, 'input,textarea,select,[aria-label]').filter((el) => matchText(labelText(el), s.value, s.exact));
        case 'placeholder': return all(root, '[placeholder]').filter((el) => matchText(el.placeholder, s.value, s.exact));
        case 'testid': return all(root, `[data-testid="${CSS.escape(s.value)}"]`);
        case 'alt': return all(root, '[alt]').filter((el) => matchText(el.alt, s.value, s.exact));
        case 'title': return all(root, '[title]').filter((el) => matchText(el.title, s.value, s.exact));
      }
      return [];
    };

    let els = [document];
    for (const s of p.steps) {
      if (s.kind === 'nth') {
        const i = s.value < 0 ? els.length + s.value : s.value;
        els = els[i] ? [els[i]] : [];
      } else {
        els = [...new Set(els.flatMap((root) => find(root, s)))];
      }
    }

    const el = els[0];
    const info = { count: els.length };
    if (el) {
      if (p.scroll) el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const text = norm(el.innerText).slice(0, 24);
      info.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      info.visible = visible(el);
      info.label = el.id ? `id="${el.id}"` : `<${el.tagName.toLowerCase()}>${text ? ` "${text}"` : ''}`;
      info.actual = 'value' in el && el.tagName !== 'BUTTON' ? el.value : norm(el.innerText);
    }

    if (p.expect) {
      const { matcher, args, not } = p.expect;
      let pass;
      switch (matcher) {
        case 'toBeVisible': pass = !!el && info.visible; break;
        case 'toBeHidden': pass = !el || !info.visible; break;
        case 'toHaveText': pass = !!el && matchText(el.innerText, args[0], true); break;
        case 'toContainText': pass = !!el && matchText(el.innerText, args[0], false); break;
        case 'toHaveValue': pass = !!el && matchText(el.value, args[0], true); break;
        case 'toBeChecked': pass = !!el && !!el.checked; break;
        case 'toBeEnabled': pass = !!el && !el.disabled; break;
        case 'toBeDisabled': pass = !!el && !!el.disabled; break;
        case 'toBeFocused': pass = !!el && document.activeElement === el; break;
        case 'toHaveCount': pass = info.count === args[0]; info.actual = info.count; break;
        case 'toHaveClass': pass = !!el && matchText(el.className, args[0], false); break;
        case 'toHaveAttribute':
          pass = !!el && el.hasAttribute(args[0]) && (args[1] === undefined || matchText(el.getAttribute(args[0]), args[1], true));
          break;
        default: info.error = `Unsupported matcher: ${matcher}`; return info;
      }
      info.pass = not ? !pass : pass;
      return info;
    }

    if (p.action) {
      if (!el) { info.error = 'Element not found'; return info; }
      const { type, value } = p.action;
      const fire = (name, Ctor = Event, init = {}) => el.dispatchEvent(new Ctor(name, { bubbles: true, ...init }));
      const setValue = (v) => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter ? setter.call(el, v) : (el.value = v);
        fire('input');
        fire('change');
      };
      switch (type) {
        case 'click': el.focus?.(); el.click(); break;
        case 'dblclick': el.click(); fire('dblclick', MouseEvent); break;
        case 'fill': case 'type': case 'pressSequentially': el.focus(); setValue(String(value ?? '')); break;
        case 'clear': el.focus(); setValue(''); break;
        case 'check': if (!el.checked) el.click(); break;
        case 'uncheck': if (el.checked) el.click(); break;
        case 'hover': fire('mouseover', MouseEvent); fire('mouseenter', MouseEvent, { bubbles: false }); break;
        case 'focus': el.focus(); break;
        case 'selectOption': setValue(String(value)); break;
        case 'press':
          el.focus?.();
          ['keydown', 'keypress', 'keyup'].forEach((n) => fire(n, KeyboardEvent, { key: value }));
          if (value === 'Enter' && el.form) el.form.requestSubmit();
          break;
      }
      info.done = true;
    }
    return info;
  }

  // ---------------- Host side ----------------

  const evalInPage = (payload) =>
    $('webview').executeJavaScript(`(${pageRunner.toString()})(${JSON.stringify(payload)})`);

  async function poll(fn, ok, message) {
    const deadline = Date.now() + TIMEOUT;
    let last;
    while (Date.now() < deadline) {
      if (running?.cancelled) throw new Error('Stopped');
      try {
        last = await fn();
        if (last?.error) throw new Error(last.error);
        if (ok(last)) return last;
      } catch (err) {
        if (err.message.startsWith('Unsupported')) throw err;
      }
      await sleep(200);
    }
    const received = last?.actual !== undefined ? ` (received ${JSON.stringify(last.actual)})` : '';
    throw new Error(`${message}${received} after ${TIMEOUT}ms`);
  }

  async function waitForLoad() {
    const webview = $('webview');
    if (!webview.isLoading()) return;
    await Promise.race([
      new Promise((r) => webview.addEventListener('did-stop-loading', r, { once: true })),
      sleep(TIMEOUT),
    ]);
  }

  function lineEls(step) {
    const view = $('code-view');
    const out = [];
    for (let n = step.startLine; n <= step.endLine; n++) if (view.children[n - 1]) out.push(view.children[n - 1]);
    return out;
  }

  function markLines(step, cls) {
    document.querySelectorAll('.code-view .run-active').forEach((el) => el.classList.remove('run-active'));
    lineEls(step).forEach((el) => {
      el.classList.remove('run-pass', 'run-fail', 'run-skip');
      el.classList.add(cls);
    });
  }

  function clearOverlay() {
    $('target-box').hidden = true;
    $('connector').innerHTML = '';
  }

  // Code anchor: the string literal of the locator inside the statement, or the end of the first line.
  function anchorPoint(step) {
    const lines = lineEls(step);
    const needle = step.cmd.locator?.[0]?.value;
    for (const line of lines) {
      for (const tok of line.querySelectorAll('.tok-str')) {
        if (typeof needle === 'string' && tok.textContent.includes(needle)) return tok.getBoundingClientRect();
      }
    }
    return lines[0]?.lastElementChild?.getBoundingClientRect();
  }

  function showTarget(step, info) {
    clearOverlay();
    if (!info?.rect) return;
    const wv = $('webview').getBoundingClientRect();
    const x = wv.left + info.rect.x;
    const y = wv.top + info.rect.y;
    if (y + info.rect.height < wv.top || y > wv.bottom || x > wv.right || x + info.rect.width < wv.left) return;

    const box = $('target-box');
    Object.assign(box.style, {
      left: `${x - 4}px`, top: `${y - 4}px`,
      width: `${info.rect.width + 8}px`, height: `${info.rect.height + 8}px`,
    });
    box.querySelector('.badge').textContent = info.label;
    box.hidden = false;

    const a = anchorPoint(step);
    if (!a) return;
    const x1 = a.right + 6;
    const y1 = a.top + a.height / 2;
    const x2 = x - 4;
    const y2 = y + info.rect.height / 2;
    const dx = Math.max(60, (x2 - x1) * 0.5);
    $('connector').innerHTML = `
      <path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" />
      <circle cx="${x1}" cy="${y1}" r="4" class="hollow" />
      <circle cx="${x2}" cy="${y2}" r="4" />`;
  }

  async function execute(step) {
    const { cmd } = step;
    const delay = SPEEDS[$('speed').value] ?? SPEEDS.normal;
    const webview = $('webview');

    if (cmd.type === 'goto') {
      clearOverlay();
      const url = new URL(cmd.url, webview.getURL()).href;
      await webview.loadURL(url).catch((err) => { throw new Error(`Navigation failed: ${err.message}`); });
      return sleep(delay);
    }
    if (cmd.type === 'wait') return sleep(Math.min(cmd.ms, 10000));

    const steps = cmd.locator;
    const expectsAbsence = cmd.type === 'expect' && (cmd.not || cmd.matcher === 'toBeHidden' || cmd.matcher === 'toHaveCount');
    if (!expectsAbsence) {
      const info = await poll(() => evalInPage({ steps, scroll: true }), (r) => r.rect && r.visible, 'Element not visible');
      showTarget(step, info);
      await sleep(delay);
    }

    if (cmd.type === 'expect') {
      const expect = { matcher: cmd.matcher, args: cmd.args, not: cmd.not };
      const info = await poll(() => evalInPage({ steps, expect }), (r) => r.pass, `Expectation ${cmd.matcher} failed`);
      if (info.rect) showTarget(step, info);
    } else {
      const info = await evalInPage({ steps, action: { type: cmd.action, value: cmd.value } });
      if (info.error) throw new Error(info.error);
      await sleep(150);
      await waitForLoad();
    }
    await sleep(delay / 2);
  }

  async function run() {
    if (running) return print('Visual run already in progress.\n', 'err');
    const file = state.currentFile;
    if (!file) return print('Select a test file first.\n', 'err');

    const name = file.split(/[\\/]/).pop();
    await showFile(file, name); // re-render to reset highlights
    const res = await window.api.readFile(file);
    if (res.error) return print(res.error + '\n', 'err');

    const ctx = { dirname: file.replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/') };
    const steps = extractStatements(res.content).map((s) => ({ ...s, cmd: interpret(s.text, ctx) }));
    if (!steps.length) return print('No `await` statements found in this file.\n', 'err');

    running = { cancelled: false };
    clearOverlay();
    print(`▶ Visual run: ${name}\n`, 'cmd');
    const counts = { passed: 0, failed: 0, skipped: 0 };

    for (const step of steps) {
      if (running.cancelled) break;
      markLines(step, 'run-active');
      lineEls(step)[0]?.scrollIntoView({ block: 'center' });

      if (!step.cmd) {
        markLines(step, 'run-skip');
        print(`  - line ${step.startLine}: skipped (unsupported statement)\n`, 'muted');
        counts.skipped++;
        continue;
      }
      try {
        await execute(step);
        markLines(step, 'run-pass');
        print(`  ✓ line ${step.startLine}: ${describe(step.cmd)}\n`, 'ok');
        counts.passed++;
      } catch (err) {
        markLines(step, 'run-fail');
        print(`  ✗ line ${step.startLine}: ${describe(step.cmd)}\n    ${err.message}\n`, 'err');
        counts.failed++;
        break;
      }
    }

    const stopped = running.cancelled ? ' (stopped)' : '';
    print(`${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped${stopped}\n`, counts.failed ? 'err' : 'ok');
    running = null;
  }

  function stop() {
    if (running) running.cancelled = true;
  }

  window.addEventListener('resize', clearOverlay);
  document.addEventListener('DOMContentLoaded', () => {
    $('code-view').addEventListener('scroll', () => !running && clearOverlay());
  });

  window.visualRunner = { run, stop, clearOverlay, isRunning: () => !!running };
})();
