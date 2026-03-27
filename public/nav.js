(function () {
  'use strict';

  // ─── Speakly promo bar ──────────────────────────────────────────────────────
  var PROMO_KEY = 'speakly_v1_dismissed';

  function injectPromoBar(nav) {
    var bar = document.createElement('div');
    bar.id = 'speakly-bar';
    bar.className = 'speakly-bar';
    bar.innerHTML =
      '<a href="https://www.genspark.ai/speakly/invite/ZjEwYTVjYjdMZjA3ZkxlZjQ0TDc3OTNjOWIzMjVkYkw5ODJh"' +
      ' target="_blank" rel="noopener sponsored" class="speakly-bar-link">' +
        '<svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>' +
        '</svg>' +
        '<span>I\u2019ve found <strong>Genspark Speakly</strong> incredibly smooth \u2014 it\u2019s doubled my work efficiency.</span>' +
        '<span class="speakly-badge">Get free membership \u2192</span>' +
      '</a>' +
      '<button class="speakly-dismiss" aria-label="Dismiss announcement">' +
        '<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>' +
        '</svg>' +
      '</button>';

    nav.insertBefore(bar, nav.firstChild);

    bar.querySelector('.speakly-dismiss').addEventListener('click', function () {
      try { localStorage.setItem(PROMO_KEY, '1'); } catch (e) {}
      bar.style.overflow = 'hidden';
      bar.style.maxHeight = bar.scrollHeight + 'px';
      // Force reflow so the browser registers the starting max-height
      bar.offsetHeight; // eslint-disable-line no-unused-expressions
      bar.style.transition = 'max-height 0.28s ease, opacity 0.28s ease, padding 0.28s ease';
      requestAnimationFrame(function () {
        bar.style.maxHeight = '0';
        bar.style.paddingTop = '0';
        bar.style.paddingBottom = '0';
        bar.style.opacity = '0';
      });
      setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 300);
    });
  }

  // ─── Mobile hamburger menu ───────────────────────────────────────────────────
  var tools = [
    { href: '/',           label: 'Promo Finder',       color: 'emerald' },
    { href: '/domain',     label: 'Domain Search',      color: 'orange'  },
    { href: '/unlisted',   label: 'Unlisted Videos',    color: 'purple'  },
    { href: '/growth',     label: 'Growth Tracker',     color: 'blue'    },
    { href: '/collab',     label: 'Collaborations',     color: 'amber'   },
    { href: '/compare',    label: 'Compare Sponsors',   color: 'pink'    },
    { href: '/rate',       label: 'Rate Estimator',     color: 'teal'    },
    { href: '/viral',      label: 'Viral Detector',     color: 'rose'    },
    { href: '/saturation', label: 'Saturation Score',   color: 'violet'  },
    { href: '/revenue',    label: 'Revenue Calculator', color: 'lime'    },
    { href: '/predictor',  label: 'Perf. Predictor',    color: 'cyan'    },
    { href: '/tiktok',     label: 'TikTok Downloader',  color: 'rose'    },
    { href: '/linkcheck',  label: 'Link Checker',       color: 'sky'     }
  ];

  function getActivePath() {
    var p = window.location.pathname;
    if (p.length > 1 && p.slice(-1) === '/') p = p.slice(0, -1);
    return p || '/';
  }

  function injectHamburger(navTop, navInner) {
    var btn = document.createElement('button');
    btn.className = 'nav-hamburger';
    btn.id = 'navHamburger';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><span></span><span></span>';
    navTop.appendChild(btn);

    var menu = document.createElement('div');
    menu.className = 'nav-mobile-menu';
    menu.id = 'navMobileMenu';

    var grid = document.createElement('div');
    grid.className = 'nav-mobile-grid';

    var activePath = getActivePath();
    tools.forEach(function (t) {
      var isActive = (t.href === '/')
        ? (activePath === '/')
        : (activePath === t.href || activePath.indexOf(t.href + '/') === 0);
      var a = document.createElement('a');
      a.href = t.href;
      a.textContent = t.label;
      a.className = 'nav-mobile-chip' + (isActive ? ' active-' + t.color : '');
      grid.appendChild(a);
    });

    menu.appendChild(grid);
    navInner.appendChild(menu);

    btn.addEventListener('click', function () {
      var isOpen = menu.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', String(isOpen));
    });

    // Close menu when a link is tapped
    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        menu.classList.remove('open');
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  var nav     = document.querySelector('.site-nav');
  var navTop   = document.querySelector('.site-nav-top');
  var navInner = document.querySelector('.site-nav-inner');

  if (nav) {
    try {
      if (!localStorage.getItem(PROMO_KEY)) {
        injectPromoBar(nav);
      }
    } catch (e) {}
  }

  if (navTop && navInner) {
    injectHamburger(navTop, navInner);
  }
}());
