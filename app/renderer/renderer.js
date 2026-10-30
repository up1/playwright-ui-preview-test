const $ = (id) => document.getElementById(id);

const state = {
  root: null,
  currentFile: null,
  cwd: null,
  runningId: null,
  history: [],
  historyIndex: 0,
};

// ================= Section 1: Browse and show code =================

async function openRoot(dir) {
  state.root = dir;
  $('file-tree').innerHTML = '';
  await renderDir(dir, $('file-tree'), 0);
  setCwd(dir);
}

async function renderDir(dir, container, depth) {
  const entries = await window.api.listDir(dir);
  for (const entry of entries) {
    const node = document.createElement('div');
    node.className = 'node' + (entry.isDir ? ' dir' : '');
    node.textContent = entry.name;
    node.title = entry.path;
    node.style.paddingLeft = 8 + depth * 12 + 'px';
    container.appendChild(node);

    if (entry.isDir) {
      const children = document.createElement('div');
      children.hidden = true;
      container.appendChild(children);
      node.addEventListener('click', async () => {
        const open = node.classList.toggle('open');
        if (open && !children.dataset.loaded) {
          children.dataset.loaded = '1';
          await renderDir(entry.path, children, depth + 1);
        }
        children.hidden = !open;
      });
    } else {
      node.addEventListener('click', () => {
        document.querySelectorAll('.file-tree .node.active').forEach((n) => n.classList.remove('active'));
        node.classList.add('active');
        showFile(entry.path, entry.name);
      });
    }
  }
}

async function showFile(file, name) {
  const view = $('code-view');
  const result = await window.api.readFile(file);
  state.currentFile = file;
  $('code-title').textContent = name;
  $('code-path').textContent = state.root ? file.replace(state.root + '/', '') : file;

  if (result.error) {
    view.innerHTML = `<div class="empty">${result.error}</div>`;
    $('code-info').textContent = '';
    return;
  }

  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const lines = window.highlight(result.content, ext);
  view.innerHTML = lines
    .map((html, i) => `<div class="line"><span class="ln">${i + 1}</span><span>${html || ' '}</span></div>`)
    .join('');
  view.scrollTop = 0;
  $('code-info').textContent = `${lines.length} lines`;
}

$('btn-open').addEventListener('click', async () => {
  const dir = await window.api.openFolder();
  if (dir) openRoot(dir);
});

// ================= Section 2: Terminal =================

const output = $('term-output');
const input = $('term-input');

function setCwd(dir) {
  state.cwd = dir;
  $('term-cwd').textContent = dir;
}

function print(text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  // Strip ANSI escape codes; the terminal renders plain text.
  span.textContent = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

async function runCommand(command) {
  command = command.trim();
  if (!command) return;
  if (state.runningId) {
    print('A command is already running. Press Ctrl+C or Stop first.\n', 'err');
    return;
  }

  state.history.push(command);
  state.historyIndex = state.history.length;
  print(`$ ${command}\n`, 'cmd');

  if (command === 'clear') return (output.innerHTML = '');
  const cd = command.match(/^cd(?:\s+(.*))?$/);
  if (cd) {
    const res = await window.api.cd(state.cwd, cd[1]?.trim());
    res.error ? print(res.error + '\n', 'err') : setCwd(res.cwd);
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.runningId = id;
  await window.api.run(id, command, state.cwd);
}

window.api.onData((id, data) => {
  if (id === state.runningId) print(data);
});

window.api.onExit((id, code) => {
  if (id !== state.runningId) return;
  state.runningId = null;
  print(`[exit ${code}]\n`, code === 0 ? 'ok' : 'err');
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runCommand(input.value);
    input.value = '';
  } else if (e.key === 'ArrowUp' && state.historyIndex > 0) {
    input.value = state.history[--state.historyIndex];
    e.preventDefault();
  } else if (e.key === 'ArrowDown') {
    state.historyIndex = Math.min(state.historyIndex + 1, state.history.length);
    input.value = state.history[state.historyIndex] || '';
    e.preventDefault();
  } else if (e.key === 'c' && e.ctrlKey) {
    stopCommand();
  }
});

output.addEventListener('click', () => {
  if (!window.getSelection().toString()) input.focus();
});

function stopCommand() {
  if (state.runningId) {
    window.api.kill(state.runningId);
    print('^C\n', 'err');
  }
}

// ================= Section 3: Run web in browser =================

const webview = $('webview');
const urlInput = $('url');

function normalizeUrl(value) {
  value = value.trim();
  if (/^(https?|file):\/\//.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/.test(value)) return 'http://' + value;
  return 'https://' + value;
}

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') webview.loadURL(normalizeUrl(urlInput.value));
});
$('nav-back').addEventListener('click', () => webview.canGoBack() && webview.goBack());
$('nav-forward').addEventListener('click', () => webview.canGoForward() && webview.goForward());
$('nav-reload').addEventListener('click', () => webview.reload());

const syncUrl = (e) => (urlInput.value = e.url);
webview.addEventListener('did-navigate', syncUrl);
webview.addEventListener('did-navigate-in-page', syncUrl);

// ================= Bottom steps bar =================

document.querySelectorAll('.steps button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const { cmd, action } = btn.dataset;
    if (cmd) return runCommand(cmd);
    if (action === 'visual') window.visualRunner.run();
    if (action === 'clear') {
      output.innerHTML = '';
      window.visualRunner.clearOverlay();
    }
    if (action === 'stop') {
      window.visualRunner.stop();
      stopCommand();
    }
    if (action === 'run-file') {
      if (!state.currentFile) return print('Select a test file first.\n', 'err');
      runCommand(`npx playwright test "${state.currentFile}"`);
    }
  });
});

// ================= Init =================

(async () => {
  const { folder, url } = await window.api.defaults();
  await openRoot(folder);
  webview.src = url;
  urlInput.value = url;
  print('Welcome to UI Test Studio. Type a command below.\n', 'muted');
  input.focus();
})();
