(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  marked.setOptions({ gfm: true, breaks: false });
  let state = { currentPath: null };

  function post(message) { vscode.postMessage(message); }

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
    main.querySelectorAll('pre code').forEach(block => { try { hljs.highlightElement(block); } catch { /* non-code */ } });
    // Links: internal .md links navigate in-panel; the rest open externally.
    main.querySelectorAll('a[href]').forEach(anchor => {
      anchor.addEventListener('click', (event) => {
        const href = anchor.getAttribute('href') || '';
        if (href.startsWith('#')) return; // in-page anchors: default behavior
        event.preventDefault();
        if (/^[a-z]+:\/\//i.test(href)) {
          post({ command: 'openExternal', href });
        } else {
          post({ command: 'navigate', href });
        }
      });
    });
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
