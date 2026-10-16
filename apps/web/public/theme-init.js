// Applies the saved light/dark theme before the first paint, so a dark-mode user never sees a white flash.
// Keep in sync with src/lib/theme.ts (storage key and the sign-in/public pages that always stay light).
(function () {
  try {
    var choice = localStorage.getItem('nx.theme');
    var lightOnly = ['/login', '/register', '/forgot-password', '/reset-password', '/accept-invite', '/f/', '/submit-feedback', '/track'].some(function (p) {
      return location.pathname.indexOf(p) === 0;
    });
    var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark && !lightOnly) document.documentElement.classList.add('dark');
  } catch (e) {
    /* storage blocked: stay light */
  }
})();
