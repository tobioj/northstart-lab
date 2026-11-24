(function () {
  'use strict';

  function attachVisualCursor() {
    if (!document.body || document.querySelector('.ns-mouse-cursor')) return;
    var cursor = document.createElement('div');
    cursor.className = 'ns-mouse-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cursor);
    function move(e) {
      cursor.style.display = 'block';
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    }
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerdown', function (e) {
      move(e);
      cursor.classList.add('pressed');
      var ring = document.createElement('div');
      ring.className = 'ns-mouse-click';
      ring.style.left = e.clientX + 'px';
      ring.style.top = e.clientY + 'px';
      document.body.appendChild(ring);
      setTimeout(function () { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 350);
    }, true);
    document.addEventListener('pointerup', function () {
      cursor.classList.remove('pressed');
    }, true);
    document.addEventListener('pointerleave', function () {
      cursor.style.display = 'none';
      cursor.classList.remove('pressed');
    });
  }
  if (document.body) attachVisualCursor();
  else document.addEventListener('DOMContentLoaded', attachVisualCursor, { once: true });

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
  if (scenario && scenario.getAttribute('data-oracle') === 'true') {
    var oVerify = scenario.getAttribute('data-verify');
    var oToken = scenario.getAttribute('data-token');
    var oComplete = scenario.getAttribute('data-complete');
    if (oVerify && oToken && oComplete) {
      var poll = setInterval(function () {
        fetch(oVerify + '/api/status/' + encodeURIComponent(oToken), {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'strict-origin',
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s) {
            if (s && (s.state === 'settled' || s.state === 'complete')) {
              clearInterval(poll);
              say('Scenario settled');
              window.location.replace(oComplete);
            }
          })
          .catch(function () {});
      }, 200);
    }
    return;
  }

  var completeNotice = document.getElementById('continuation');
  if (completeNotice) {
    var recurUrl = completeNotice.getAttribute('data-recur-url');
    if (recurUrl) {
      setTimeout(function () { window.location.replace(recurUrl); }, 350);
    }
  }

  var complete = document.getElementById('complete-button');
  if (!scenario || !complete) return;
  var verify = scenario.getAttribute('data-verify');
  var token = scenario.getAttribute('data-token');
  var next = scenario.getAttribute('data-continue');

  // The signed progress proof from each step is sent with the next one, so the steps can be
  // served by different server instances. It lives only in this variable (no storage).
  var proof = null;

  function call(step, body) {
    var init = { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'strict-origin', headers: {} };
    if (body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (proof) init.headers['x-northstar-proof'] = proof;
    return fetch(verify + '/api/' + step + '/' + encodeURIComponent(token), init).then(function (r) {
      if (!r.ok) throw new Error(step + ' ' + r.status);
      return r.json();
    }).then(function (state) { proof = state.proof || proof; return state; });
  }

  complete.addEventListener('click', function () {
    complete.disabled = true;
    say('Completing scenario');
    call('input', { value: 'acknowledged' })
      .then(function () { return call('verify'); })
      .then(function () { return call('settle'); })
      .then(function () { say('Scenario settled'); window.location.assign(next + '?p=' + encodeURIComponent(proof)); })
      .catch(function (e) { say('Scenario failed: ' + e.message); complete.disabled = false; });
  });
})();
