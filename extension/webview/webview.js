(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  marked.setOptions({ gfm: true, breaks: false });
  let state = { currentPath: null };

  function post(message) { vscode.postMessage(message); }

  function buildToc(main) {
    const list = document.getElementById('toc-list');
    list.innerHTML = '';
    const headings = main.querySelectorAll('h2, h3');
    if (!headings.length) { document.getElementById('toc').style.display = 'none'; return; }
    document.getElementById('toc').style.display = '';
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = 'sec-' + index;
      const li = document.createElement('li');
      li.className = heading.tagName === 'H3' ? 'lvl3' : 'lvl2';
      const a = document.createElement('a');
      a.href = '#' + heading.id;
      a.textContent = heading.textContent;
      a.addEventListener('click', (e) => { e.preventDefault(); heading.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function renderPage(page) {
    state.currentPath = page.path;
    document.getElementById('title').textContent = page.title;
    const badges = document.getElementById('badges');
    badges.innerHTML = '';
    if (page.protected) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '🔒 protected';
      badges.appendChild(badge);
    }
    if (page.quality === 'degraded') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '⚠ degraded';
      badges.appendChild(badge);
    }
    const main = document.getElementById('page');
    main.innerHTML = marked.parse(page.markdown);

    // Wrap code blocks into .code-frame (mermaid into .mermaid-frame) BEFORE hljs.
    main.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      const langMatch = code && code.className.match(/language-([\w+-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const frame = document.createElement('div');
      if (lang === 'mermaid') {
        frame.className = 'mermaid-frame';
      } else {
        frame.className = 'code-frame';
        if (lang) {
          const label = document.createElement('span');
          label.className = 'lang';
          label.textContent = lang;
          frame.appendChild(label);
        }
      }
      pre.parentNode.insertBefore(frame, pre);
      frame.appendChild(pre);
    });

    main.querySelectorAll('pre code').forEach(block => { try { hljs.highlightElement(block); } catch { /* non-code */ } });
    // Links: internal .md links navigate in-panel; in-page anchors smooth-scroll; the rest open externally.
    main.querySelectorAll('a[href]').forEach(anchor => {
      anchor.addEventListener('click', (event) => {
        const href = anchor.getAttribute('href') || '';
        if (href.startsWith('#')) {
          event.preventDefault();
          const target = document.getElementById(href.slice(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        event.preventDefault();
        if (/^[a-z]+:\/\//i.test(href)) {
          post({ command: 'openExternal', href });
        } else {
          post({ command: 'navigate', href });
        }
      });
    });
    buildToc(main);
    // Render mermaid after the DOM is populated.
    if (window.mermaid) {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.body.classList.contains('vscode-dark') ? 'dark' : 'default' });
      window.mermaid.run({ nodes: main.querySelectorAll('pre code.language-mermaid') }).catch(() => { /* leave fenced */ });
    }
    vscode.setState(state);
  }

  document.getElementById('edit-source').addEventListener('click', () => post({ command: 'editSource', path: state.currentPath }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.command === 'show' && message.page) renderPage(message.page);
  });
}());
