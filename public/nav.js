(function () {
  'use strict';

  var PROMO_KEY = 'speakly_v1_dismissed';

  // --- Color map for inline active styles ---
  var COLOR = {
    emerald: { color: '#34d399', bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.28)' },
    orange:  { color: '#fb923c', bg: 'rgba(249,115,22,0.12)',  border: 'rgba(249,115,22,0.28)'  },
    purple:  { color: '#c084fc', bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.28)'  },
    blue:    { color: '#60a5fa', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.28)'  },
    amber:   { color: '#fbbf24', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.28)'  },
    pink:    { color: '#f472b6', bg: 'rgba(236,72,153,0.12)',  border: 'rgba(236,72,153,0.28)'  },
    teal:    { color: '#2dd4bf', bg: 'rgba(20,184,166,0.12)',  border: 'rgba(20,184,166,0.28)'  },
    rose:    { color: '#fb7185', bg: 'rgba(244,63,94,0.12)',   border: 'rgba(244,63,94,0.28)'   },
    violet:  { color: '#a78bfa', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.28)'  },
    lime:    { color: '#a3e635', bg: 'rgba(132,204,22,0.12)', border: 'rgba(132,204,22,0.28)'  },
    cyan:    { color: '#22d3ee', bg: 'rgba(6,182,212,0.12)',  border: 'rgba(6,182,212,0.28)'   },
    sky:     { color: '#38bdf8', bg: 'rgba(14,165,233,0.12)', border: 'rgba(14,165,233,0.28)'  }
  };

  // --- Speakly promo bar ---
  function injectPromoBar(nav) {
    var bar = document.createElement('div');
    bar.id = 'speakly-bar';
    bar.style.cssText = [
      'display:flex','align-items:center','justify-content:center',
      'padding:7px 40px 7px 12px',
      'background:linear-gradient(90deg,rgba(109,40,217,0.08),rgba(139,92,246,0.06) 50%,rgba(109,40,217,0.08))',
      'border-bottom:1px solid rgba(139,92,246,0.2)',
      'font-size:0.72rem','font-family:inherit','color:#c4b5fd',
      'position:relative','min-height:32px','box-sizing:border-box','width:100%'
    ].join(';');

    var link = document.createElement('a');
    link.href = 'https://www.genspark.ai/speakly/invite/ZjEwYTVjYjdMZjA3ZkxlZjQ0TDc3OTNjOWIzMjVkYkw5ODJh';
    link.target = '_blank';
    link.rel = 'noopener sponsored';
    link.style.cssText = 'display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:inherit;flex-wrap:wrap;justify-content:center;line-height:1.4;text-align:center;';

    var txt = document.createElement('span');
    txt.innerHTML = 'I\u2019ve found <strong>Genspark Speakly</strong> incredibly smooth \u2014 doubled my work efficiency.';

    var badge = document.createElement('span');
    badge.textContent = 'Get free membership \u2192';
    badge.style.cssText = 'display:inline-flex;align-items:center;padding:2px 9px;border-radius:100px;background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.38);color:#a78bfa;font-weight:600;font-size:0.68rem;white-space:nowrap;flex-shrink:0;';

    link.appendChild(txt);
    link.appendChild(badge);

    var dismiss = document.createElement('button');
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#7c3aed;cursor:pointer;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:5px;padding:0;font-size:14px;line-height:1;font-family:inherit;';
    dismiss.innerHTML = '&#x2715;';
    dismiss.addEventListener('mouseenter', function () { this.style.color = '#c4b5fd'; });
    dismiss.addEventListener('mouseleave', function () { this.style.color = '#7c3aed'; });

    bar.appendChild(link);
    bar.appendChild(dismiss);
    nav.insertBefore(bar, nav.firstChild);

    dismiss.addEventListener('click', function () {
      try { localStorage.setItem(PROMO_KEY, '1'); } catch (e) {}
      bar.style.overflow = 'hidden';
      bar.style.maxHeight = bar.scrollHeight + 'px';
      bar.offsetHeight;
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

  // --- Tools list ---
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
    { href: '/youtube-downloader', label: 'YouTube Downloader', color: 'orange' },
    { href: '/services',   label: 'Social Services',    color: 'sky'     },
    { href: '/linkcheck',  label: 'Link Checker',       color: 'sky'     }
  ];

  function ensureDesktopYouTubeDownloaderLink(navInner) {
    var strip = navInner ? navInner.querySelector('.tool-strip') : null;
    if (!strip) return;

    var existing = strip.querySelector('a[href="/youtube-downloader"]');
    if (existing) return;

    var activePath = getActivePath();
    var link = document.createElement('a');
    link.href = '/youtube-downloader';
    link.className = activePath === '/youtube-downloader'
      ? 'tool-chip chip-active-amber'
      : 'tool-chip';
    link.textContent = 'YouTube Downloader';

    var before = strip.querySelector('a[href="/services"]');
    if (before) strip.insertBefore(link, before);
    else strip.appendChild(link);
  }

  function ensureDesktopServicesLink(navInner) {
    var strip = navInner ? navInner.querySelector('.tool-strip') : null;
    if (!strip) return;

    var existing = strip.querySelector('a[href="/services"]');
    if (existing) return;

    var activePath = getActivePath();
    var link = document.createElement('a');
    link.href = '/services';
    link.className = (activePath === '/services' || activePath.indexOf('/services-') === 0)
      ? 'tool-chip chip-active-sky'
      : 'tool-chip';
    link.textContent = 'Social Services';

    var before = strip.querySelector('a[href="/linkcheck"]');
    if (before) strip.insertBefore(link, before);
    else strip.appendChild(link);
  }

  function getActivePath() {
    var p = window.location.pathname;
    if (p.length > 1 && p.slice(-1) === '/') p = p.slice(0, -1);
    return p || '/';
  }

  function isMobile() { return window.innerWidth < 768; }

  function applyMobileMode(toolStrip, btn) {
    if (toolStrip) toolStrip.style.display = 'none';
    btn.style.display = 'flex';
  }

  function applyDesktopMode(toolStrip, btn, menu) {
    if (toolStrip) toolStrip.style.display = '';
    btn.style.display = 'none';
    menu.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
    var bars = btn.querySelectorAll('span');
    if (bars.length === 3) {
      bars[0].style.transform = '';
      bars[1].style.opacity = '1';
      bars[2].style.transform = '';
    }
  }

  function injectHamburger(navTop, navInner) {
    var toolStrip = navInner.querySelector('.tool-strip');

    var btn = document.createElement('button');
    btn.id = 'navHamburger';
    btn.setAttribute('aria-label', 'Toggle navigation menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.style.cssText = 'display:none;flex-direction:column;justify-content:center;align-items:center;gap:4px;width:38px;height:38px;border-radius:8px;border:1px solid rgba(51,65,85,0.55);background:rgba(15,23,42,0.45);cursor:pointer;padding:0;flex-shrink:0;';
    for (var i = 0; i < 3; i++) {
      var barEl = document.createElement('span');
      barEl.style.cssText = 'display:block;width:16px;height:1.5px;background:#94a3b8;border-radius:2px;transition:transform 0.22s,opacity 0.22s;';
      btn.appendChild(barEl);
    }
    navTop.appendChild(btn);

    var menu = document.createElement('div');
    menu.id = 'navMobileMenu';
    menu.style.cssText = 'display:none;padding:10px 0 14px;border-top:1px solid rgba(51,65,85,0.3);';

    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';

    var activePath = getActivePath();
    tools.forEach(function (t) {
      var isActive = (t.href === '/')
        ? (activePath === '/')
        : (activePath === t.href || activePath.indexOf(t.href + '/') === 0);
      var c = COLOR[t.color] || COLOR.emerald;
      var a = document.createElement('a');
      a.href = t.href;
      a.textContent = t.label;
      a.style.cssText = [
        'display:flex','align-items:center','padding:9px 11px','border-radius:9px',
        'font-size:0.78rem',
        'font-weight:' + (isActive ? '600' : '500'),
        'color:' + (isActive ? c.color : '#64748b'),
        'background:' + (isActive ? c.bg : 'rgba(15,23,42,0.4)'),
        'border:1px solid ' + (isActive ? c.border : 'rgba(51,65,85,0.4)'),
        'text-decoration:none','white-space:nowrap','overflow:hidden','text-overflow:ellipsis',
        'font-family:inherit','box-sizing:border-box'
      ].join(';');
      if (!isActive) {
        a.addEventListener('mouseenter', function () { this.style.color = '#cbd5e1'; this.style.background = 'rgba(30,41,59,0.6)'; });
        a.addEventListener('mouseleave', function () { this.style.color = '#64748b'; this.style.background = 'rgba(15,23,42,0.4)'; });
      }
      grid.appendChild(a);
    });

    menu.appendChild(grid);
    navInner.appendChild(menu);

    btn.addEventListener('click', function () {
      var isOpen = menu.style.display === 'block';
      var bars = btn.querySelectorAll('span');
      if (isOpen) {
        menu.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        bars[0].style.transform = ''; bars[1].style.opacity = '1'; bars[2].style.transform = '';
      } else {
        menu.style.display = 'block';
        btn.setAttribute('aria-expanded', 'true');
        bars[0].style.transform = 'translateY(5.5px) rotate(45deg)';
        bars[1].style.opacity = '0';
        bars[2].style.transform = 'translateY(-5.5px) rotate(-45deg)';
      }
    });

    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        menu.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        var bars = btn.querySelectorAll('span');
        bars[0].style.transform = ''; bars[1].style.opacity = '1'; bars[2].style.transform = '';
      }
    });

    if (isMobile()) { applyMobileMode(toolStrip, btn); }
    else            { applyDesktopMode(toolStrip, btn, menu); }

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (isMobile()) { applyMobileMode(toolStrip, btn); }
        else            { applyDesktopMode(toolStrip, btn, menu); }
      }, 80);
    });
  }

  // --- Init ---
  var siteNav  = document.querySelector('.site-nav');
  var navTop   = document.querySelector('.site-nav-top');
  var navInner = document.querySelector('.site-nav-inner');

  if (siteNav) {
    try { if (!localStorage.getItem(PROMO_KEY)) injectPromoBar(siteNav); } catch (e) {}
  }

  if (navTop && navInner) {
    ensureDesktopYouTubeDownloaderLink(navInner);
    ensureDesktopServicesLink(navInner);
    injectHamburger(navTop, navInner);
  }
}());
