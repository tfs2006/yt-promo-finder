(function () {
  'use strict';

  var STORAGE_KEY = 'pf_credit_tokens_v1';
  var BALANCE_CACHE_KEY = 'pf_credit_balance_cache_v1';
  var BALANCE_BADGE_ID = 'pfCreditsBadge';

  function safeParse(json, fallback) {
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  }

  function uniqueTokens(tokens) {
    return Array.from(new Set((tokens || []).filter(function (token) {
      return /^cs_[A-Za-z0-9_]+$/.test(token || '');
    }))).slice(0, 8);
  }

  function getTokens() {
    try {
      return uniqueTokens(safeParse(window.localStorage.getItem(STORAGE_KEY) || '[]', []));
    } catch {
      return [];
    }
  }

  function setTokens(tokens) {
    var normalized = uniqueTokens(tokens);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      return normalized;
    }
    return normalized;
  }

  function saveToken(token) {
    var current = getTokens();
    current.unshift(token);
    return setTokens(current);
  }

  function getBalanceCache() {
    try {
      return safeParse(window.localStorage.getItem(BALANCE_CACHE_KEY) || 'null', null);
    } catch {
      return null;
    }
  }

  function setBalanceCache(data) {
    if (!data) return null;
    var payload = {
      totalRemaining: Number(data.totalRemaining || 0),
      balances: Array.isArray(data.balances) ? data.balances : [],
      updatedAt: new Date().toISOString()
    };
    try {
      window.localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify(payload));
    } catch {
      return payload;
    }
    return payload;
  }

  function clearBalanceCache() {
    try {
      window.localStorage.removeItem(BALANCE_CACHE_KEY);
    } catch {
      return;
    }
  }

  function getCachedTotalRemaining() {
    var cached = getBalanceCache();
    return cached ? Number(cached.totalRemaining || 0) : 0;
  }

  function renderCreditsBadge(totalRemaining) {
    if (!document.body) return;

    var badge = document.getElementById(BALANCE_BADGE_ID);
    if (!totalRemaining || totalRemaining <= 0) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('a');
      badge.id = BALANCE_BADGE_ID;
      badge.href = '/credits';
      badge.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:70;display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;border:1px solid rgba(56,189,248,0.35);background:rgba(2,6,23,0.92);box-shadow:0 18px 40px rgba(2,6,23,0.45);backdrop-filter:blur(14px);text-decoration:none;color:#e2e8f0;font-family:inherit;';
      document.body.appendChild(badge);
    }

    badge.innerHTML = [
      '<span style="display:inline-flex;width:32px;height:32px;align-items:center;justify-content:center;border-radius:999px;background:rgba(56,189,248,0.16);color:#7dd3fc;font-weight:800;">C</span>',
      '<span>',
      '  <span style="display:block;font-size:11px;line-height:1;text-transform:uppercase;letter-spacing:0.18em;color:#94a3b8;">Credits</span>',
      '  <span style="display:block;margin-top:4px;font-size:15px;font-weight:700;color:#f8fafc;">' + totalRemaining + ' remaining</span>',
      '</span>'
    ].join('');
  }

  function updateCreditsLinkLabels(totalRemaining) {
    var links = document.querySelectorAll('a[href="/credits"]');
    links.forEach(function (link) {
      if (link.id === BALANCE_BADGE_ID) return;
      if (!link.dataset.baseLabel) {
        link.dataset.baseLabel = (link.textContent || 'Buy Credits').trim() || 'Buy Credits';
      }
      var baseLabel = link.dataset.baseLabel;
      link.textContent = totalRemaining > 0 ? ('Credits: ' + totalRemaining) : baseLabel;
    });
  }

  function refreshIndicators(totalRemaining) {
    var resolved = typeof totalRemaining === 'number' ? totalRemaining : getCachedTotalRemaining();
    updateCreditsLinkLabels(resolved);
    renderCreditsBadge(resolved);
  }

  function buildApiUrl(path, params) {
    var url = new URL(path, window.location.origin);
    Object.entries(params || {}).forEach(function (entry) {
      var key = entry[0];
      var value = entry[1];
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, value);
    });

    var tokens = getTokens();
    if (tokens.length) {
      url.searchParams.set('creditToken', tokens.join(','));
    }

    return url.pathname + url.search;
  }

  async function requestJson(url, options) {
    var response = await fetch(url, options);
    var payload = await response.json().catch(function () {
      return { error: 'Unexpected server response.' };
    });
    if (!response.ok) {
      var err = new Error(payload.error || 'Request failed.');
      err.payload = payload;
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  async function fetchCatalog() {
    return requestJson('/api/credits?action=plans');
  }

  async function fetchBalances() {
    var tokens = getTokens();
    if (!tokens.length) {
      clearBalanceCache();
      refreshIndicators(0);
      return { balances: [], totalRemaining: 0, toolCosts: {}, plans: [] };
    }

    var data = await requestJson('/api/credits?action=balance&tokens=' + encodeURIComponent(tokens.join(',')));
    if (Array.isArray(data.balances)) {
      setTokens(data.balances.map(function (balance) { return balance.token; }));
    }
    setBalanceCache(data);
    refreshIndicators(Number(data.totalRemaining || 0));
    return data;
  }

  async function claimSession(sessionId) {
    var data = await requestJson('/api/credits?action=claim&sessionId=' + encodeURIComponent(sessionId));
    if (data && data.token) {
      saveToken(data.token);
    }
    if (data && data.balance) {
      setBalanceCache({ balances: [data.balance], totalRemaining: Number(data.balance.creditsRemaining || 0) });
      refreshIndicators(Number(data.balance.creditsRemaining || 0));
    }
    return data;
  }

  async function createCheckout(planId) {
    return requestJson('/api/credits?action=checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: planId })
    });
  }

  function formatBalanceHint(balances) {
    if (!Array.isArray(balances) || !balances.length) return '';
    var total = balances.reduce(function (sum, balance) {
      return sum + (balance.creditsRemaining || 0);
    }, 0);
    return '<div class="text-xs mt-3 text-slate-300">Saved balance detected: <span class="font-semibold text-emerald-300">' + total + ' credits</span>.</div>';
  }

  function getPaymentRequiredMarkup(payload, options) {
    var opts = options || {};
    var toolLabel = opts.toolLabel || 'This search';
    var toolCost = payload && payload.toolCost ? payload.toolCost : 1;
    var message = payload && payload.error ? payload.error : (toolLabel + ' now requires credits.');
    var hint = formatBalanceHint(payload && payload.balances);
    return [
      '<div class="flex items-start gap-3">',
      '  <svg class="w-6 h-6 text-sky-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-3.866 0-7 1.79-7 4s3.134 4 7 4 7-1.79 7-4-3.134-4-7-4zm0 0V4m0 12v4m8-8h-4M8 12H4"></path>',
      '  </svg>',
      '  <div>',
      '    <div class="font-semibold text-lg text-white">Free preview used</div>',
      '    <div class="text-sm mt-1 text-slate-200">' + message + '</div>',
      '    <div class="text-sm mt-2 text-sky-200">This request costs ' + toolCost + ' credit' + (toolCost === 1 ? '' : 's') + '.</div>',
           hint,
      '    <div class="mt-4 flex flex-wrap gap-3">',
      '      <a href="/credits" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold transition-colors">Buy Credits</a>',
      '      <a href="/credits" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-600 hover:border-sky-400 text-slate-200 hover:text-white transition-colors">View Plans</a>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function getRateLimitedMarkup() {
    return [
      '<div class="flex items-start gap-3">',
      '  <svg class="w-6 h-6 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">',
      '    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
      '  </svg>',
      '  <div>',
      '    <div class="font-semibold text-lg text-white">Too many requests right now</div>',
      '    <div class="text-sm mt-1 text-amber-200">This tool is temporarily throttled to protect service availability. Wait a minute and try again.</div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function syncAccess(access) {
    if (!access || access.mode !== 'paid' || !access.token) return;

    saveToken(access.token);

    var cached = getBalanceCache();
    var balances = cached && Array.isArray(cached.balances) ? cached.balances.slice() : [];
    var matched = false;
    balances = balances.map(function (balance) {
      if (balance.token !== access.token) return balance;
      matched = true;
      return Object.assign({}, balance, {
        creditsRemaining: Number(access.creditsRemaining || 0),
        creditsTotal: Number(access.creditsTotal || balance.creditsTotal || 0)
      });
    });

    if (!matched) {
      balances.unshift({
        token: access.token,
        planName: 'Credits Pack',
        creditsRemaining: Number(access.creditsRemaining || 0),
        creditsTotal: Number(access.creditsTotal || 0)
      });
    }

    var totalRemaining = balances.reduce(function (sum, balance) {
      return sum + Number(balance.creditsRemaining || 0);
    }, 0);

    setBalanceCache({ balances: balances, totalRemaining: totalRemaining });
    refreshIndicators(totalRemaining);
    fetchBalances().catch(function () { return null; });
  }

  function initCreditsUi() {
    refreshIndicators();
    if (getTokens().length) {
      fetchBalances().catch(function () { return null; });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCreditsUi, { once: true });
  } else {
    initCreditsUi();
  }

  window.PFCredits = {
    buildApiUrl: buildApiUrl,
    claimSession: claimSession,
    createCheckout: createCheckout,
    fetchBalances: fetchBalances,
    fetchCatalog: fetchCatalog,
    getCachedTotalRemaining: getCachedTotalRemaining,
    getPaymentRequiredMarkup: getPaymentRequiredMarkup,
    getRateLimitedMarkup: getRateLimitedMarkup,
    getTokens: getTokens,
    saveToken: saveToken,
    syncAccess: syncAccess,
    setTokens: setTokens
  };
}());