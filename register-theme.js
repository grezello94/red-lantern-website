(() => {
  const key = 'red-lantern-register-theme';
  let theme = 'dark';
  try { if (localStorage.getItem(key) === 'light') theme = 'light'; } catch {}
  function apply(next) {
    theme = next === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f7fb' : '#020617');
    const button = document.getElementById('register-theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(theme === 'light'));
      button.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} mode`);
      button.querySelector('[data-theme-label]').textContent = theme === 'light' ? 'Light mode' : 'Dark mode';
      button.querySelector('[aria-hidden]').textContent = theme === 'light' ? '☀' : '☾';
    }
  }
  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(theme);
    document.getElementById('register-theme-toggle')?.addEventListener('click', () => {
      apply(theme === 'dark' ? 'light' : 'dark');
      try { localStorage.setItem(key, theme); } catch {}
    });
  });
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();
