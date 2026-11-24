(function () {
  'use strict';
  var rootEl = document.getElementById('widget-root');
  if (!rootEl) return;
  var verifyOrigin = rootEl.getAttribute('data-verify');
  var token = rootEl.getAttribute('data-token');
  var kind = rootEl.getAttribute('data-widget');
  var statusEl = document.querySelector('[role="status"]');
  if (!verifyOrigin || !token) return;

  function postJson(path, body) {
    var init = {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'strict-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    };
    return fetch(verifyOrigin + '/api' + path, init).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }

  if (kind === 'spinner') {
    var timer = setInterval(function () {
      postJson('/settle/' + encodeURIComponent(token), {}).then(function (res) {
        if (res && (res.state === 'settled' || res.state === 'complete')) {
          clearInterval(timer);
          if (statusEl) statusEl.textContent = 'Settled';
        }
      }).catch(function () {});
    }, 250);
    return;
  }

  var chain = Promise.resolve();
  var active = null;
  var selected = new Set();

  function send(path, body) {
    chain = chain.then(function () { return postJson(path, body); });
    return chain;
  }

  function submit() {
    send('/verify/' + encodeURIComponent(token), { cells: Array.from(selected) }).then(function (res) {
      if (res && res.accepted) {
        if (statusEl) statusEl.textContent = 'Accepted';
        return send('/settle/' + encodeURIComponent(token), {}).then(function (settled) {
          if (statusEl && settled && settled.state === 'settled') {
            statusEl.textContent = 'Settled';
          }
        });
      }
      if (statusEl) statusEl.textContent = 'Verification remains';
    }).catch(function () {});
  }

  ['pointerdown', 'pointerup', 'pointermove', 'click', 'keydown', 'keyup'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var el = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!el) return;
      if (type === 'pointermove' && !active) return;
      var target = el.getAttribute('data-target') || (el.classList.contains('tile') ? 'tile' : '');
      if (!target) return;
      var boxEl = target === 'slider' ? document.querySelector('.puzzle') : el;
      if (!boxEl) return;
      var box = boxEl.getBoundingClientRect();
      var cellAttr = el.getAttribute('data-cell');
      send('/input/' + encodeURIComponent(token), {
        type: type,
        trusted: e.isTrusted === true,
        x: box.width ? (e.clientX - box.x) / box.width : 0,
        y: box.height ? (e.clientY - box.y) / box.height : 0,
        cell: cellAttr === null ? null : Number(cellAttr),
        target: target,
        key: e.key || null,
        pointer_id: typeof e.pointerId === 'number' ? e.pointerId : 1,
        widget_width: box.width,
        widget_height: box.height,
        frame_width: window.innerWidth,
        frame_height: window.innerHeight,
        client_ms: performance.now(),
      });
      if (type === 'pointerdown') {
        active = el;
        if (target === 'slider' && typeof el.setPointerCapture === 'function') {
          try { el.setPointerCapture(e.pointerId); } catch (_) {}
        }
      }
      if (type === 'pointermove' && target === 'slider') {
        var left = Math.max(0, Math.min(440, e.clientX - box.x - 20));
        el.style.left = left + 'px';
      }
      if (type === 'pointerup') {
        active = null;
        if (target === 'hold' || target === 'slider') submit();
      }
      if (type === 'click' && e.isTrusted) {
        if (target === 'tile') {
          var n = Number(cellAttr);
          if (selected.has(n)) selected.delete(n); else selected.add(n);
          el.classList.toggle('selected');
        } else if (target === 'checkbox' || target === 'verify') {
          submit();
        }
      }
    });
  });
})();
