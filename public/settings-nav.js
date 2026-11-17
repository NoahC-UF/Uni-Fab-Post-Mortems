// Settings page: the jump menu on the left lights up the section you are reading, and "Recent Syncs" stays open
// (or closed) when the sync panel refreshes itself while a sync is running.
(function () {
  var nav = document.getElementById('settingsNav');
  if (!nav) return;

  var links = function () { return Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]')); };
  var targetOf = function (a) { return a.hash ? document.getElementById(a.hash.slice(1)) : null; };

  // A link you clicked stays lit until you scroll yourself: the last sections cannot always reach the top of the window.
  var pinned = null;
  ['wheel', 'touchmove', 'keydown'].forEach(function (ev) { window.addEventListener(ev, function () { pinned = null; }, { passive: true }); });

  // Light up the last section whose top has scrolled past the top bar; hide links to sections that are not on the page.
  var update = function () {
    var current = null;
    links().forEach(function (a) {
      var el = targetOf(a);
      a.hidden = !el;
      if (el && el.getBoundingClientRect().top <= 110) current = a;
    });
    if (pinned && !pinned.hidden) current = pinned;
    if (!current) current = links().filter(function (a) { return !a.hidden; })[0] || null;
    links().forEach(function (a) { a.classList.toggle('on', a === current); });
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('hashchange', update);

  // A link to a fold opens it.
  nav.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    var el = a && targetOf(a);
    if (el && el.tagName === 'DETAILS') el.open = true;
    if (a) {
      pinned = a;
      update();
    }
  });

  // The sync panel swaps itself every few seconds during a sync: remember whether Recent Syncs was open.
  var syncLogOpen = false;
  document.addEventListener('toggle', function (e) { if (e.target && e.target.id === 'recent-syncs') syncLogOpen = e.target.open; }, true);
  document.body.addEventListener('htmx:afterSettle', function () {
    var d = document.getElementById('recent-syncs');
    if (d && syncLogOpen) d.open = true;
    update();
  });

  // opened straight from a link such as /settings#recent-syncs
  var landed = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  if (landed && landed.tagName === 'DETAILS') landed.open = true;

  update();
})();
