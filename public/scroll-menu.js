// "Scroll To" menu in the filter section of the Quote Accuracy pages: a button that opens a short list of the page's sections,
// and a click glides to that section. The page gives it the ids of the sections in order; the first one ('sec-top') is the top of the page.
// Opening the menu marks the section you are looking at now. Loaded before Alpine starts (a plain script, not deferred).

// Where the page's own content starts on screen: below the top bar, and below the pinned block (.acc-sticky) when the page has one
// and it is pinned at this window size. A section is scrolled to just under this line, so it is never hidden behind either.
// docTop = where the section is in the page (for a jump): the pinned block shrinks once the page is scrolled far enough
// (public/sticky-compact.js), so a jump that goes that far is measured against the shrunk block.
function scrollTopOffset(docTop) {
  var bar = document.querySelector('.topbar');
  var y = bar ? bar.getBoundingClientRect().bottom : 0;
  var pin = document.querySelector('.acc-sticky');
  if (pin && window.getComputedStyle(pin).position === 'sticky') {
    var h = pin.offsetHeight;
    var info = window.accStickyInfo ? window.accStickyInfo() : null;
    if (info && docTop !== undefined) h = docTop - y - info.compactH - 12 > info.threshold ? info.compactH : info.fullH;
    y += h;
  }
  return Math.max(y, 0);
}

// The sticky block sits under the top bar: tell the stylesheet how tall the bar is (it can wrap on a narrow window)
window.addEventListener('DOMContentLoaded', function () {
  var bar = document.querySelector('.topbar');
  if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
});

function scrollMenu(ids) {
  var TOP = 'sec-top';
  var smooth = function () {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  };
  return {
    open: false,
    active: ids && ids.length ? ids[0] : '',
    toggle: function () {
      this.open = !this.open;
      if (this.open) this.active = this.current();
    },
    // the section being read: the last one whose top edge has scrolled up to just under the pinned area (or the top third of the window)
    current: function () {
      var cur = ids[0];
      var line = Math.max(window.innerHeight * 0.35, scrollTopOffset() + 40);
      for (var i = 1; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el && el.getBoundingClientRect().top <= line) cur = ids[i];
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && ids.length > 1) {
        var last = document.getElementById(ids[ids.length - 1]);
        if (last) cur = ids[ids.length - 1];
      }
      return cur;
    },
    go: function (id) {
      this.open = false;
      this.active = id;
      if (id === TOP) {
        window.scrollTo({ top: 0, behavior: smooth() });
        return;
      }
      var el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'DETAILS') el.open = true; // a fold-away section is opened as you arrive
      var docTop = el.getBoundingClientRect().top + window.scrollY;
      var top = docTop - scrollTopOffset(docTop) - 12;
      window.scrollTo({ top: Math.max(top, 0), behavior: smooth() });
    },
  };
}
