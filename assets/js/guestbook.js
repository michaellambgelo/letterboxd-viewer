/* Guestbook form + toast, shared by the dashboard and rolodex footers.
 *
 * Posts to a Discord webhook whose URL is injected at deploy time —
 * deploy.yml writes `window.DISCORD_WEBHOOK_URL` into each page's <head>.
 * Locally the URL is absent and submitting shows the "not configured" toast.
 */

(function () {
  'use strict';

  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + type;
    // Force reflow
    void toast.offsetWidth;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = form.querySelector('.btn-submit');
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending...';

      const webhookUrl = window.DISCORD_WEBHOOK_URL;
      if (!webhookUrl) {
        showToast('Webhook not configured', 'error');
        btn.disabled = false;
        btn.textContent = origText;
        return;
      }

      const name = form.querySelector('[name="name"]').value;
      const email = form.querySelector('[name="email"]').value;
      const message = form.querySelector('[name="message"]').value;

      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: 'New Guestbook Entry',
              color: 5814783,
              fields: [
                { name: 'Name', value: name, inline: true },
                { name: 'Email', value: email, inline: true },
                { name: 'Message', value: message },
              ],
              timestamp: new Date().toISOString(),
            }],
          }),
        });

        if (res.ok || res.status === 204) {
          showToast('Message sent successfully!');
          form.reset();
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        showToast('Failed to send message. Please try again.', 'error');
        console.error('Webhook error:', err);
      }

      btn.disabled = false;
      btn.textContent = origText;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initContactForm);
  } else {
    initContactForm();
  }
})();
