(function () {
  'use strict';

  // FormSubmit integration: destination inbox is activated through FormSubmit's first confirmation email.
  var endpoint = 'https://formsubmit.co/ajax/promofinder@4ourmedia.com';

  document.querySelectorAll('[data-newsletter-form]').forEach(function (form) {
    if (typeof window.fetch !== 'function') return;
    var email = form.querySelector('[name="email"]');
    var consent = form.querySelector('[name="consent"]');
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('[data-newsletter-status]');
    var pending = false;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (pending) return;
      email.value = email.value.trim();
      if (!form.reportValidity() || !consent.checked) return;
      if (form.querySelector('[name="_honey"]').value) return;

      pending = true;
      button.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = 'Sending your signup…';
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 15000);
      try {
        var payload = {
          email: email.value,
          consent: consent.value,
          source: form.querySelector('[name="source"]').value,
          _subject: 'PromoFinder email updates signup',
          _template: 'table',
          _honey: ''
        };
        var response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Submission failed');
        var result = await response.json();
        if (result.success !== true && result.success !== 'true') throw new Error('Submission not confirmed');
        form.reset();
        status.textContent = 'Thanks! Your signup request was received. You can request removal at any time.';
      } catch {
        status.textContent = 'Your signup could not be confirmed. Please try again, or email promofinder@4ourmedia.com.';
      } finally {
        clearTimeout(timeout);
        pending = false;
        button.disabled = false;
        form.setAttribute('aria-busy', 'false');
      }
    });
  });
})();
