// Minimal syntax highlighter for JS/TS-like code. Returns one HTML string per line.
(function () {
  const KEYWORDS = new Set((
    'async await break case catch class const continue default delete do else export extends ' +
    'false finally for from function if import in instanceof interface let new null of return ' +
    'static super switch this throw true try type typeof undefined var void while yield'
  ).split(' '));

  const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const span = (cls, text) =>
    // Split on newlines so multi-line tokens stay valid per line.
    text.split('\n').map((part) => `<span class="${cls}">${escape(part)}</span>`).join('\n');

  function highlight(code, ext) {
    const isCode = /^(js|jsx|ts|tsx|mjs|cjs|json|py|sh|yml|yaml)$/.test(ext);
    if (!isCode) return escape(code).split('\n');

    let out = '';
    let last = 0;
    code.replace(TOKEN, (match, comment, str, num, fn, word, offset) => {
      // '#' comments only for python/shell/yaml.
      if (comment && comment.startsWith('#') && !/^(py|sh|yml|yaml)$/.test(ext)) return match;
      out += escape(code.slice(last, offset));
      if (comment) out += span('tok-comment', comment);
      else if (str) out += span('tok-str', str);
      else if (num) out += span('tok-num', num);
      else if (fn) out += span(KEYWORDS.has(fn) ? 'tok-kw' : 'tok-fn', fn);
      else if (KEYWORDS.has(word)) out += span('tok-kw', word);
      else out += escape(word);
      last = offset + match.length;
      return match;
    });
    out += escape(code.slice(last));
    return out.split('\n');
  }

  window.highlight = highlight;
})();
