// One customer's page: the pinned top block (heading, dates, filters, cards) shrinks once the page has been scrolled a little and
// grows back near the top. All it does here is switch the class "is-compact" on the block (.acc-sticky); the look of both states, and the
// animation between them, are in app.css. It only works where the block is pinned (a wide, tall window); elsewhere it does nothing.
//
// The page below must not jump when the block gets shorter, so the block keeps taking up its full height in the page: while it is
// shrunk its bottom margin makes up the difference (the two change together, so nothing slides under the reader's eyes). It shrinks only
// once the page has scrolled by that difference, which is the moment the content below has reached the shrunk block's lower edge.
(function () {
  var pin = null;
  var mq = window.matchMedia('(min-width: 1751px) and (min-height: 800px)');
  var fullH = 0;
  var compactH = 0;
  var compact = false;
  var queued = false;

  // The block's height in each state, read without animating (both states are measured within one frame, so nothing is painted).
  function measure() {
    var was = compact;
    pin.classList.add('no-anim');
    pin.classList.remove('is-compact');
    pin.style.marginBottom = '0px';
    fullH = pin.offsetHeight;
    pin.classList.add('is-compact');
    compactH = pin.offsetHeight;
    if (!was) pin.classList.remove('is-compact');
    pin.style.marginBottom = was ? (fullH - compactH) + 'px' : '0px';
    void pin.offsetHeight;
    pin.classList.remove('no-anim');
  }

  // how far the page must be scrolled before the block shrinks
  function threshold() {
    return Math.max(fullH - compactH, 60);
  }

  function setCompact(on, instant) {
    if (on === compact) return;
    compact = on;
    if (instant) pin.classList.add('no-anim');
    pin.classList.toggle('is-compact', on);
    pin.style.marginBottom = on ? (fullH - compactH) + 'px' : '0px';
    if (instant) {
      void pin.offsetHeight;
      pin.classList.remove('no-anim');
    }
  }

  function evaluate(instant) {
    queued = false;
    if (!mq.matches) {
      setCompact(false, true);
      return;
    }
    var y = window.scrollY;
    var t = threshold();
    if (!compact && y > t) setCompact(true, instant);
    else if (compact && y < t - 40) setCompact(false, instant); // a little slack, so it does not flicker at the edge
  }

  function onScroll() {
    if (queued) return;
    queued = true;
    window.setTimeout(function () { evaluate(false); }, 30); // a short timer, not a frame callback: it also runs while the window is in the background
  }

  // the scroll memory has just put the page back where it was: settle into the right size at once, without animating
  window.accStickySettle = function () {
    if (pin) evaluate(true);
  };

  // used by the Scroll To menu, to stop a section under the block, whichever size it will be by then
  window.accStickyInfo = function () {
    return pin ? { fullH: fullH, compactH: compactH, threshold: threshold(), compact: compact } : null;
  };

  window.addEventListener('DOMContentLoaded', function () {
    pin = document.querySelector('.acc-sticky');
    if (!pin) return;
    measure();
    evaluate(true); // a page reloaded part-way down opens already shrunk
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () {
      measure();
      evaluate(true);
    });
    if (mq.addEventListener) mq.addEventListener('change', function () { measure(); evaluate(true); });
  });
})();
