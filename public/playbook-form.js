(function () {
  'use strict';

  // Playbook lead capture: same FormSubmit inbox as the newsletter signup,
  // with name and phone added so every lead can be followed up personally.
  var endpoint = 'https://formsubmit.co/ajax/promofinder@4ourmedia.com';

  document.querySelectorAll('[data-playbook-form]').forEach(function (form) {
    if (typeof window.fetch !== 'function') return;
    var name = form.querySelector('[name="name"]');
    var email = form.querySelector('[name="email"]');
    var phone = form.querySelector('[name="phone"]');
    var consent = form.querySelector('[name="consent"]');
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('[data-playbook-status]');
    var download = document.getElementById('playbook-download');
    var pending = false;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (pending) return;
      name.value = name.value.trim();
      email.value = email.value.trim();
      phone.value = phone.value.trim();
      if (!form.reportValidity() || !consent.checked) return;
      if (form.querySelector('[name="_honey"]').value) return;

      pending = true;
      button.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = 'Sending your request…';
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 15000);
      try {
        var payload = {
          name: name.value,
          email: email.value,
          phone: phone.value,
          consent: consent.value,
          source: form.querySelector('[name="source"]').value,
          _subject: 'Sponsor Finder Playbook download',
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
        form.style.display = 'none';
        if (download) download.classList.remove('hidden');
        status.textContent = 'Thanks! Your request was received. Your download is ready below.';
      } catch {
        status.textContent = 'Your request could not be confirmed. Please try again, or email promofinder@4ourmedia.com.';
      } finally {
        clearTimeout(timeout);
        pending = false;
        button.disabled = false;
        form.setAttribute('aria-busy', 'false');
      }
    });
  });
})();
