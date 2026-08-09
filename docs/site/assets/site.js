/* docs.notis.fun — shared behaviour, built to contracts/HOUSE_STYLE.md.
 *
 * Loaded from <head> WITHOUT defer, on purpose. The theme has to be on <html> before the
 * first paint, or every page in a multi-page site flashes Sand before settling into Bistre.
 * A deferred script cannot do that. Everything that needs the DOM waits for DOMContentLoaded.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var STORE = 'notis-theme';

  function stored() {
    try { var t = localStorage.getItem(STORE); return t === 'dark' || t === 'light' ? t : null; }
    catch (e) { return null; }   // private mode, disabled storage — not an error worth raising
  }

  /* Sand is the primary ground, so it is the answer when nobody has expressed a preference.
     A reader whose system asks for dark has expressed one, and long-form reading at night is
     exactly the case it exists for, so that wins over the default. A choice made here wins
     over both, and #dark / #light in the URL wins over everything — the same override the
     landing page carries, which makes a theme linkable and makes it checkable in a headless
     screenshot. A hash view is not a choice, so it is never stored. */
  function resolve() {
    if (location.hash === '#dark' || location.hash === '#light') return location.hash.slice(1);
    var saved = stored();
    if (saved) return saved;
    return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  /* The control names and shows the theme you would switch TO, never the one you are in,
     and lowercase, because the surrounding labels are lowercase. */
  function apply(theme, remember) {
    root.setAttribute('data-theme', theme);
    if (remember) { try { localStorage.setItem(STORE, theme); } catch (e) {} }
    var btn = document.getElementById('theme');
    if (btn) {
      var other = theme === 'dark' ? 'light' : 'dark';
      btn.textContent = other;
      btn.setAttribute('aria-label', 'Switch to ' + other + ' theme');
    }
  }

  apply(resolve(), false);   // before first paint; not remembered, since nobody chose it yet

  document.addEventListener('DOMContentLoaded', function () {
    apply(root.getAttribute('data-theme'), false);   // label the control now that it exists

    /* Restoring a stored preference is not motion. Transitions stay off until the palette
       above has been painted once, otherwise every transitioned property animates from the
       default to the chosen one — a visible flash of the wrong state on every navigation. */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { root.classList.remove('no-anim'); });
    });

    var btn = document.getElementById('theme');
    if (btn) btn.addEventListener('click', function () {
      apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
    });

    /* Mark the current page in the sidebar. The nav is one shared include, so it cannot know
       which page it was served into. */
    var here = location.pathname.replace(/index\.html$/, '') || '/';
    var items = document.querySelectorAll('#siteNav .nav-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('href') === here) {
        items[i].classList.add('active');
        items[i].setAttribute('aria-current', 'page');
      }
    }

    var side = document.getElementById('sidebar');
    var navBtn = document.getElementById('navBtn');
    var backdrop = document.getElementById('backdrop');
    function setNav(open) {
      side.classList.toggle('open', open);
      backdrop.classList.toggle('show', open);
      navBtn.setAttribute('aria-expanded', String(open));
    }
    if (navBtn) navBtn.addEventListener('click', function () { setNav(!side.classList.contains('open')); });
    if (backdrop) backdrop.addEventListener('click', function () { setNav(false); });

    /* A wheel-scrolling reader leaves the pointer parked, and without this whatever lands
       beneath it fires the moment scrolling stops. */
    var idle;
    addEventListener('scroll', function () {
      document.body.classList.add('scrolling');
      clearTimeout(idle);
      idle = setTimeout(function () { document.body.classList.remove('scrolling'); }, 100);
    }, { passive: true });
  });
})();
