// Sends contact forms without leaving the page. Works without this file too (plain form post).
document.querySelectorAll('form[data-form]').forEach(function (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = form.querySelector('[data-form-status]') || document.querySelector('[data-form-status]');
    var button = form.querySelector('button[type=submit], button:not([type])');
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    if (!data.page) data.page = location.pathname;
    if (button) button.disabled = true;
    if (status) status.textContent = 'Sending...';
    fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.reason || j.error || 'failed'); }); })
      .then(function () { form.reset(); if (status) status.textContent = 'Thank you. We have your message and will get back to you soon.'; })
      .catch(function () { if (status) status.textContent = 'That did not send. Please call us instead.'; })
      .finally(function () { if (button) button.disabled = false; });
  });
});
if (/[?&]sent=1/.test(location.search)) {
  var s = document.querySelector('[data-form-status]');
  if (s) s.textContent = 'Thank you. We have your message and will get back to you soon.';
}
