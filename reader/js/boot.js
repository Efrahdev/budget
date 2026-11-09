/* Runs before the first paint: picks the reading theme so the page never flashes the wrong colours. */
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('budgetReader.prefs.v1') || '{}') || {}, t = p.theme || 'auto', h = document.documentElement;
    if (t === 'auto') {
      var b = localStorage.getItem('budgetTracker.theme');
      var dark = b === 'dark' || (b !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      t = dark ? 'night' : 'paper';
    }
    h.dataset.rtheme = t;
    try { if (window.parent !== window && window.parent.location.origin === location.origin) h.classList.add('embedded'); } catch (e) {}
  } catch (e) { document.documentElement.dataset.rtheme = 'paper'; }
})();
