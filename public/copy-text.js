// Any button with a data-copy attribute copies that text to the clipboard (the job page's Copy Path button).
// The modern clipboard needs a secure page (https or localhost); this app is often opened as http://<pc name>:8080 on the office
// network, so fall back to the old way: select the text in a hidden box and copy.
(function () {
  function copyText(text, doc, nav) {
    doc = doc || document;
    nav = nav || navigator;
    var legacy = function () {
      var box = doc.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.top = '0';
      box.style.opacity = '0';
      doc.body.appendChild(box);
      box.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      doc.body.removeChild(box);
      return ok;
    };
    if (nav.clipboard && nav.clipboard.writeText && (typeof window === 'undefined' || window.isSecureContext !== false)) {
      return nav.clipboard.writeText(text).then(function () { return true; }, function () { return legacy(); });
    }
    return Promise.resolve(legacy());
  }
  if (typeof window !== 'undefined') window.copyText = copyText;
  if (typeof module !== 'undefined') module.exports = { copyText: copyText };

  if (typeof document === 'undefined') return;
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!b) return;
    e.preventDefault();
    var was = b.getAttribute('data-label') || b.textContent;
    b.setAttribute('data-label', was);
    copyText(b.getAttribute('data-copy')).then(function (ok) {
      b.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { b.textContent = was; }, 2000);
    });
  });
})();
