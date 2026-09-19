// Progressive enhancement only: menu toggles and copy buttons. The site is fully usable without it.
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }
  var sideToggle = document.querySelector('.side-toggle');
  var side = document.getElementById('docs-side');
  if (sideToggle && side) {
    sideToggle.addEventListener('click', function () {
      var open = side.classList.toggle('open');
      sideToggle.setAttribute('aria-expanded', String(open));
    });
  }
  document.querySelectorAll('.code .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var pre = btn.parentElement.querySelector('pre');
      var text = pre ? pre.innerText : '';
      var done = function () {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('done');
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
        done();
      }
    });
  });
  // Highlight the current docs section in the "On this page" list.
  var toc = document.querySelectorAll('.toc a');
  if (toc.length && 'IntersectionObserver' in window) {
    var map = {};
    toc.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          toc.forEach(function (a) { a.classList.remove('active'); });
          var a = map[e.target.id];
          if (a) a.classList.add('active');
        }
      });
    }, { rootMargin: '-80px 0px -70% 0px' });
    Object.keys(map).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
