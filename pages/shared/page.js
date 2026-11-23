(function () {
  'use strict';
  var status = document.getElementById('page-status');
  function say(text) { if (status) status.textContent = text; }

  window.addEventListener('load', function () { say('Page loaded'); });

  var reload = document.getElementById('reload-button');
  if (reload) {
    reload.addEventListener('click', function () { window.location.reload(); });
  }

  // Scenario completion: input -> verify -> settle on the verification origin, then continue.
  // No cookies, no storage; the token is already part of this page's URL.
  var scenario = document.getElementById('scenario');
  var complete = document.getElementById('complete-button');
  if (!scenario || !complete) return;
  var verify = scenario.getAttribute('data-verify');
  var token = scenario.getAttribute('data-token');
  var next = scenario.getAttribute('data-continue');

  function call(step, body) {
    var init = { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'strict-origin' };
    if (body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
    return fetch(verify + '/api/' + step + '/' + encodeURIComponent(token), init).then(function (r) {
      if (!r.ok) throw new Error(step + ' ' + r.status);
      return r.json();
    });
  }

  complete.addEventListener('click', function () {
    complete.disabled = true;
    say('Completing scenario');
    call('input', { value: 'acknowledged' })
      .then(function () { return call('verify'); })
      .then(function () { return call('settle'); })
      .then(function () { say('Scenario settled'); window.location.assign(next); })
      .catch(function (e) { say('Scenario failed: ' + e.message); complete.disabled = false; });
  });
})();
