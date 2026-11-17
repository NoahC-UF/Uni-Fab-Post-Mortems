// Settings > Customer Tiers and Account Managers: sends the chosen spreadsheet to the server as the raw file, then reloads the
// page with the result (or shows what was wrong with the file).
(function () {
  var form = document.getElementById('orgImport');
  if (!form) return;
  var msg = document.getElementById('orgMsg');
  var show = function (text) { msg.textContent = text; msg.hidden = false; };

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.hidden = true;
    var input = document.getElementById('orgFile');
    var file = input.files && input.files[0];
    if (!file) return show('Choose a file first.');
    if (!/\.(xlsx|csv)$/i.test(file.name)) return show('Choose an Excel (.xlsx) or CSV (.csv) file.');
    if (file.size > 5000000) return show('That file is too big (5 MB is the most).');
    var mode = document.getElementById('orgMode').value;
    if (mode === 'replace' && !window.confirm('Replace the whole customer list with "' + file.name + '"? Customers that are not in the file will be removed from the list.')) return;

    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    var url = '/settings/customer-org/import?mode=' + encodeURIComponent(mode) + '&filename=' + encodeURIComponent(file.name);
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-csrf-token': form.getAttribute('data-csrf') }, body: file })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }, function () { return { status: r.status, body: null }; }); })
      .then(function (r) {
        if (r.body && r.body.ok) {
          window.location.href = '/settings?ok=' + encodeURIComponent(r.body.message) + '#customer-org';
        } else {
          show((r.body && (r.body.error || r.body.message)) || 'The import did not work (error ' + r.status + '). Reload the page and try again.');
          button.disabled = false;
        }
      })
      .catch(function () { show('The import could not reach the server. Check the connection and try again.'); button.disabled = false; });
  });
})();
