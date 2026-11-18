// Remembers which section of the page you were reading when you change a filter or the dates (the page reloads), and takes you back to it.
// The page lists its sections in the filter form (data-sections, the same list the Scroll To menu uses). Just before the page is left by
// Apply Filters, Reset, a date button, Month / Quarter or the Show box, the section being read is noted (and how far into it you were),
// and when the same page opens again it is scrolled back to that spot. Only a few seconds of memory: a later visit starts at the top.
(function () {
  var KEY = 'accScrollMemory';
  var FRESH_MS = 60000;

  function sections() {
    var form = document.querySelector('form.acc-form[data-sections]');
    return form ? form.getAttribute('data-sections').split(',').filter(Boolean) : [];
  }
  function edge(docTop) {
    return typeof scrollTopOffset === 'function' ? scrollTopOffset(docTop) : 0; // below the top bar and the pinned block (scroll-menu.js)
  }

  // the section being read: the last one whose top has scrolled up to just under the pinned area (or the top third of the window)
  function reading() {
    var line = Math.max(window.innerHeight * 0.35, edge() + 40);
    var found = null;
    sections().forEach(function (id) {
      if (id === 'sec-top') return;
      var el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= line) found = id;
    });
    return found;
  }

  function save() {
    try {
      var id = reading();
      if (!id) {
        window.sessionStorage.removeItem(KEY); // at the top of the page: nothing to go back to
        return;
      }
      var el = document.getElementById(id);
      var docTop = el.getBoundingClientRect().top + window.scrollY;
      window.sessionStorage.setItem(KEY, JSON.stringify({
        path: window.location.pathname,
        id: id,
        delta: docTop - window.scrollY - edge(docTop), // where the section's top sits against the pinned edge: negative = you were this far into it
        open: el.tagName === 'DETAILS' && el.open,
        at: Date.now(),
      }));
    } catch (e) { /* no storage (private window): the page just opens at the top */ }
  }

  // leaving the page by a filter, a date button, a Month / Quarter link or the Show box (not by a link to another page or to an anchor)
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.matches && e.target.matches('form.acc-form')) save();
  }, true);
  document.addEventListener('change', function (e) {
    if (e.target && e.target.closest && e.target.closest('.acc-pick')) save();
  }, true);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
    var u;
    try { u = new URL(a.href, window.location.href); } catch (err) { return; }
    if (u.origin === window.location.origin && u.pathname === window.location.pathname && !u.hash) save();
  }, true);

  var pending = null;
  function apply() {
    var el = document.getElementById(pending.id);
    if (!el) return;
    if (pending.open && el.tagName === 'DETAILS') el.open = true;
    var docTop = el.getBoundingClientRect().top + window.scrollY;
    var y = Math.max(docTop - edge(docTop) - pending.delta, 0);
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: y, behavior: 'auto' }); // at once: nothing to watch
    if (typeof window.accStickySettle === 'function') window.accStickySettle(); // the pinned block takes its size for this spot without animating
  }

  window.addEventListener('DOMContentLoaded', function () {
    try {
      var raw = window.sessionStorage.getItem(KEY);
      window.sessionStorage.removeItem(KEY);
      pending = raw ? JSON.parse(raw) : null;
    } catch (e) { pending = null; }
    if (!pending || pending.path !== window.location.pathname || Date.now() - pending.at > FRESH_MS) {
      pending = null;
      return;
    }
    apply();
  });
  // pictures and charts may settle the layout a little after the first go: once more when everything has loaded
  window.addEventListener('load', function () {
    if (pending) apply();
  });
})();
