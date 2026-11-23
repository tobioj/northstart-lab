(function () {
  'use strict';
  var status = document.getElementById('page-status');
  window.addEventListener('load', function () {
    if (status) status.textContent = 'Page loaded';
  });
  var reload = document.getElementById('reload-button');
  if (reload) {
    reload.addEventListener('click', function () {
      window.location.reload();
    });
  }
})();
