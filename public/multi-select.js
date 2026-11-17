// The Tier filter on the Customers and Operations & Materials pages: a button that opens a list of tick boxes, so more than one
// tier can be picked (A and B, say). Nothing ticked = all tiers. The page gives it the choices ({ v, label }) and what is ticked now.
// Loaded before Alpine starts (a plain script, not deferred), so tierPicker exists when the page is set up.
function tierPicker(choices, selected) {
  return {
    open: false,
    sel: (selected || []).slice(),
    // the button's words: "All Tiers", "Tier A", or "Tier A, Tier B"
    text: function () {
      if (!this.sel.length) return 'All Tiers';
      var names = (choices || []).filter(function (c) { return this.sel.indexOf(c.v) >= 0; }, this).map(function (c) { return c.label; });
      return names.join(', ');
    },
  };
}
