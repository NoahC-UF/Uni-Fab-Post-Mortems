// Column help: hover over a table's column title to see what the column means. Only loaded when the person has
// "Column help" on (Your Account). Works for ordinary tables (<th>) and for the Flagged Jobs grid (Tabulator),
// whose headings are drawn by script, so the listening is done on the whole page.
//
// Lookup order for a heading: its own data-help text, then "scope.heading" (scope comes from the nearest
// data-help-scope), then "heading". The text list is embedded in the page (#columnHelpData).
(function () {
  var data = {};
  try {
    data = JSON.parse(document.getElementById('columnHelpData').textContent) || {};
  } catch (e) {
    return;
  }

  var key = function (text) {
    return String(text || '').replace(/[▲▼▴▾]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  };

  var headingOf = function (target) {
    if (!target || !target.closest) return null;
    if (target.closest('.tabulator-header-filter, .tabulator-col-resize-handle, input, select, button')) return null; // not the title itself
    return target.closest('th, .tabulator-col');
  };

  var textFor = function (head) {
    if (head.dataset && head.dataset.help) return head.dataset.help;
    var titleEl = head.classList.contains('tabulator-col') ? head.querySelector('.tabulator-col-title') : head;
    var label = key(titleEl ? titleEl.textContent : '');
    if (!label) return '';
    var scopeEl = head.closest('[data-help-scope]');
    var scope = scopeEl ? scopeEl.getAttribute('data-help-scope') : '';
    return (scope && data[scope + '.' + label]) || data[label] || '';
  };

  var tip = null;
  var timer = null;
  var current = null;

  var hide = function () {
    clearTimeout(timer);
    timer = null;
    current = null;
    if (tip) tip.hidden = true;
  };

  var show = function (head, text) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'col-tip no-print';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.hidden = false;
    var r = head.getBoundingClientRect();
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6); // no room below: show above
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  };

  document.addEventListener('mouseover', function (e) {
    var head = headingOf(e.target);
    if (head === current) return;
    hide();
    if (!head) return;
    var text = textFor(head);
    if (!text) return;
    current = head;
    timer = setTimeout(function () {
      show(head, text);
    }, 250);
  });
  document.addEventListener('mouseout', function (e) {
    if (current && !(e.relatedTarget && current.contains(e.relatedTarget))) hide();
  });
  // Clicking (sorting), scrolling or typing in a filter box: get out of the way.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('beforeprint', hide);
})();
