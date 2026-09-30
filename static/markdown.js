/* =========================================================
   Minimal markdown renderer + syntax highlighter (vanilla)
   Exposes: window.MD.render(text), window.MD.highlight(code, lang)
   ========================================================= */

const MD_SENTINEL = '\u0001';

function mdEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mdEscapeAttr(s) {
  return mdEscape(s).replace(/"/g, '&quot;');
}

/* ---------------- syntax highlighting ---------------- */

const MD_LANGS = {
  javascript: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'await async break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity', t: 'Array Object String Number Boolean Symbol Date RegExp Error TypeError Promise Map Set WeakMap JSON Math Intl console window document globalThis' },
  python: { lc: '#', k: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None match case self cls', t: 'int float str bool list dict set tuple bytes object type' },
  bash: { lc: '#', k: 'if then else elif fi for while do done case esac function return export local readonly source alias unset shift exit set trap', t: 'echo cd ls cat grep sed awk curl ssh sudo python3 pip npm node git docker make mkdir rm cp mv chmod chown' },
  json: { k: 'true false null' },
  go: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false', t: 'string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 byte rune float32 float64 bool error any' },
  rust: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while true false', t: 'String Vec Option Result Box HashMap i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize bool char str' },
  java: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var volatile while true false null', t: 'int long short byte char float double boolean void String Integer Long Double Boolean Object List Map Set' },
  cpp: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'alignas alignof auto break case catch class const constexpr continue default delete do else enum explicit export extern for friend goto if inline namespace new noexcept operator private protected public register return sizeof static struct switch template this throw try typedef typename union using virtual volatile while true false nullptr', t: 'int long short char float double bool void size_t string vector map set auto' },
  csharp: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while true false null var', t: 'int long short char float double bool void string object Task List Dictionary' },
  swift: { cb: '\\/\\*', ce: '\\*\\/', lc: '\\/\\/', k: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var where while as catch defer do else fallthrough for guard if in repeat return switch throw throws try nil true false', t: 'Int Double Float String Bool Character Array Dictionary Set Any AnyObject' },
  php: { lc: '\\/\\/', k: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null', t: 'int float string bool array object mixed void self' },
  sql: { lc: '\\-\\-', k: 'select from where insert into values update set delete create table drop alter add column primary key foreign references unique not null and or join left right inner outer on group by order having limit offset as distinct count sum avg min max union all index view begin commit rollback', t: 'int integer varchar text date timestamp boolean serial uuid json jsonb' },
  css: { cb: '\\/\\*', ce: '\\*\\/' },
  scss: { cb: '\\/\\*', ce: '\\*\\/' },
  html: { cb: '<!--', ce: '-->', xml: true },
  xml: { cb: '<!--', ce: '-->', xml: true },
  yaml: { lc: '#', k: 'true false null yes no on off' },
  yml: { lc: '#', k: 'true false null yes no on off' },
  toml: { lc: '#', k: 'true false' },
  ini: { lc: '#', k: 'true false' },
  dockerfile: { lc: '#', k: 'FROM RUN CMD COPY ADD ENTRYPOINT ENV EXPOSE WORKDIR VOLUME USER ARG LABEL ONBUILD STOP SIGNAL HEALTHCHECK AS' },
  markdown: { md: true, k: 'true false null' },
};

const MD_ALIAS = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'javascript', tsx: 'javascript',
  node: 'javascript', typescript: 'javascript',
  py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  yml: 'yaml', scss: 'scss', golang: 'go', rs: 'rust', cs: 'csharp', 'c#': 'csharp',
  dockerfile: 'dockerfile', htm: 'html', svg: 'xml', md: 'markdown',
};

function mdLangKey(lang) {
  const raw = String(lang || '').toLowerCase().trim();
  const key = MD_ALIAS[raw] || raw;
  return MD_LANGS[key] ? key : null;
}

const MD_RE_CACHE = {};

function mdRegex(key, spec) {
  if (MD_RE_CACHE[key]) return MD_RE_CACHE[key];
  const parts = [];
  if (spec.cb) parts.push(`(?<cblock>${spec.cb}[\\s\\S]*?${spec.ce})`);
  if (spec.lc) parts.push(`(?<cline>${spec.lc}[^\\n]*)`);
  else if (spec.md) parts.push('(?<cline>^[ \\t]*#{1,6}[^\\n]*)');
  if (spec.xml) parts.push('(?<tag><\\/?[A-Za-z][\\w:.-]*)');
  parts.push('(?<num>\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?\\b)');
  if (spec.k) parts.push(`(?<key>\\b(?:${spec.k})\\b)`);
  if (spec.t) parts.push(`(?<type>\\b(?:${spec.t})\\b)`);
  parts.push('(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())');
  parts.push('(?<op>[+\\-*/%=<>!&|^~?:]+)');
  return (MD_RE_CACHE[key] = new RegExp(parts.join('|'), 'gm'));
}

/*  Strings are pulled out first so comment markers inside them stay intact. */
function mdHighlight(code, lang) {
  const src = String(code == null ? '' : code);
  const key = mdLangKey(lang);

  const strings = [];
  let work = src.replace(
    /`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (m) => {
      strings.push(m);
      return `${MD_SENTINEL}${strings.length - 1}${MD_SENTINEL}`;
    }
  );

  const spec = key ? MD_LANGS[key] : null;

  if (spec && (spec.k || spec.t || spec.cb || spec.lc || spec.xml)) {
    const re = mdRegex(key, spec);
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(work)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += mdEscape(work.slice(last, m.index));
      const g = m.groups || {};
      const cls = g.cblock || g.cline ? 'com'
        : g.tag ? 'tag'
        : g.num ? 'num'
        : g.key ? 'key'
        : g.type ? 'type'
        : g.fn ? 'fn'
        : 'op';
      out += `<span class="tok-${cls}">${mdEscape(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    out += mdEscape(work.slice(last));
    work = out;
  } else {
    work = mdEscape(work);
  }

  return work.replace(
    new RegExp(`${MD_SENTINEL}(\\d+)${MD_SENTINEL}`, 'g'),
    (_, i) => `<span class="tok-str">${mdEscape(strings[+i])}</span>`
  );
}

/* ---------------- inline ---------------- */

function mdInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `${MD_SENTINEL}${codes.length - 1}${MD_SENTINEL}`;
  });

  s = mdEscape(s);

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
    `<img src="${mdEscapeAttr(url)}" alt="${mdEscapeAttr(alt)}" loading="lazy">`);

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    `<a href="${mdEscapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);

  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  s = s.replace(new RegExp(`${MD_SENTINEL}(\\d+)${MD_SENTINEL}`, 'g'),
    (_, i) => `<code class="inline">${mdEscape(codes[+i])}</code>`);

  return s;
}

/* ---------------- blocks ---------------- */

function mdCodeBlock(code, lang) {
  const l = String(lang || '').toLowerCase();
  const label = mdLangKey(l) ? l : (l ? l : 'text');
  return (
    `<div class="code">` +
      `<div class="code-bar"><span>${mdEscape(label)}</span>` +
      `<button type="button" data-copy-code>copy</button></div>` +
      `<pre><code>${mdHighlight(code, l)}</code></pre>` +
    `</div>`
  );
}

function mdParseList(lines, start) {
  const first = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  const ordered = /\d/.test(first[2]);
  const base = first[1].length;
  const openTag = ordered ? '<ol>' : '<ul>';
  const out = [openTag];

  let text = [];
  let sub = [];
  let i = start;

  const flush = () => {
    if (!text.length && !sub.length) return;
    let body = mdInline(text.join('\n'));
    if (sub.length) body += mdRender(sub.join('\n'));
    out.push(`<li>${body}</li>`);
    text = [];
    sub = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);

    if (m && m[1].length < base) break;

    if (m && m[1].length === base) {
      flush();
      text = [m[3]];
      i++;
      continue;
    }

    if (m && m[1].length > base) {
      sub.push(line.slice(Math.min(base + 2, m[1].length)));
      i++;
      continue;
    }

    if (!line.trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = j < lines.length ? lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+/) : null;
      if (next && next[1].length > base) { i = j; continue; }
      break;
    }

    text.push(line.trim());
    i++;
  }

  flush();
  out.push(ordered ? '</ol>' : '</ul>');
  return { html: out.join(''), next: i };
}

function mdParseTable(lines, start) {
  const split = (row) =>
    row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

  const head = split(lines[start]);
  const align = split(lines[start + 1]).map((c) => {
    if (/^:.*:$/.test(c)) return 'center';
    if (/:$/.test(c)) return 'right';
    return 'left';
  });

  let html = '<table><thead><tr>';
  head.forEach((cell, n) => {
    html += `<th style="text-align:${align[n] || 'left'}">${mdInline(cell)}</th>`;
  });
  html += '</tr></thead><tbody>';

  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    const cells = split(lines[i]);
    html += '<tr>';
    cells.forEach((cell, n) => {
      html += `<td style="text-align:${align[n] || 'left'}">${mdInline(cell)}</td>`;
    });
    html += '</tr>';
    i++;
  }
  html += '</tbody></table>';
  return { html, next: i };
}

function mdRender(src) {
  const lines = String(src == null ? '' : src)
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (para.length) {
      out.push(`<p>${mdInline(para.join('\n'))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const marker = fence[1][0];
      const closer = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{3,}\\s*$`);
      const buf = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(mdCodeBlock(buf.join('\n'), fence[2]));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*&gt;|^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*(&gt;|>)/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*(&gt;|>)\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdRender(buf.join('\n'))}</blockquote>`);
      continue;
    }

    const isDelim = /^\s*\|?[\s:|-]{3,}\|?[\s:|-]*$/.test(line) && line.includes('-');
    if (line.includes('|') && i + 1 < lines.length && isDelim && lines[i + 1].includes('|')) {
      flush();
      const t = mdParseTable(lines, i);
      out.push(t.html);
      i = t.next;
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const l = mdParseList(lines, i);
      out.push(l.html);
      i = l.next;
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }

  flush();
  return out.join('');
}

window.MD = {
  render: mdRender,
  highlight: mdHighlight,
  escape: mdEscape,
};