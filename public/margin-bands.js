// Settings > Margin % Colours: the list of thresholds, in percentage points from each customer's own target (add, remove, colour), before it is saved.
// The page gives it the saved bands ({ bands: [{ below, color }], top }) and the most rows allowed.
function marginBandsForm(saved, max) {
  var next = 1;
  var make = function (below, color) { return { id: next++, below: below === null || below === undefined ? '' : String(below), color: color || '#f9a825' }; };
  var bands = (saved && saved.bands) || [];
  return {
    max: max,
    rows: bands.map(function (b) { return make(b.below, b.color); }),
    topOn: !!(saved && saved.top),
    topColor: (saved && saved.top) || '#2e7d32',
    add: function () {
      if (this.rows.length >= this.max) return;
      // start a little above the highest row so a new row is not a duplicate
      var last = this.rows.length ? Number(this.rows[this.rows.length - 1].below) : NaN;
      this.rows.push(make(Number.isFinite(last) ? last + 5 : -10));
    },
    remove: function (i) { this.rows.splice(i, 1); },
    example: function () {
      this.rows = [make(-10, '#c62828'), make(-5, '#ef6c00'), make(0, '#f9a825')];
      this.topOn = true;
      this.topColor = '#2e7d32';
    },
    // how a threshold reads on its sample badge: "-5 pts", "target", "+5 pts"
    label: function (v) {
      var n = Number(v);
      if (!isFinite(n)) return '';
      return n === 0 ? 'target' : (n > 0 ? '+' : '') + n + ' pts';
    },
    // the highest threshold, for the label of the "at or better" sample
    topLabel: function () {
      var nums = this.rows.filter(function (r) { return r.below !== ''; }).map(function (r) { return Number(r.below); }).filter(isFinite);
      return nums.length ? this.label(Math.max.apply(null, nums)) + ' or better' : '';
    },
    // same black-or-white text choice as the server (src/marginBands.js textOn)
    sample: function (hex) {
      var n = parseInt(String(hex).slice(1), 16) || 0;
      var lin = function (c) { var s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      var lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
      return 'background:' + hex + ';color:' + (lum > 0.4 ? '#111111' : '#ffffff');
    },
  };
}
