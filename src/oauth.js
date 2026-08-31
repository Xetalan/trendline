'use strict';

/* Oura redirect target.

   Oura only whitelists https redirect URIs, so the authorization code lands
   on this hosted page rather than back inside the app. The page shows the
   code for the user to paste into Trendline, which then exchanges it for
   tokens. That works identically on desktop and Android, with no App Links
   or custom-scheme registration to get wrong.

   The code alone is useless without the client secret, which never leaves
   the user's device - so displaying it here is safe. */

(function () {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  const desc = params.get('error_description');

  const title = document.getElementById('title');
  const msg = document.getElementById('msg');
  const body = document.getElementById('body');

  if (error) {
    title.textContent = 'Oura declined';
    title.classList.add('err');
    msg.textContent = desc || error;
    body.innerHTML = '<p class="step">Go back to Trendline and try Connect Oura again. '
      + 'If it keeps failing, check that the redirect URI on your Oura application '
      + 'exactly matches this page&rsquo;s address.</p>';
    return;
  }

  if (!code) {
    title.textContent = 'Nothing to do here';
    msg.textContent = 'This page is where Oura sends you after you approve access. '
      + 'Open it from Trendline rather than directly.';
    return;
  }

  title.textContent = 'Approved';
  msg.textContent = 'Copy this code and paste it into Trendline to finish connecting.';
  body.innerHTML = `
    <div class="code" id="code"></div>
    <button id="copy">Copy code</button>
    <p class="step">Then: Trendline &rarr; Settings &rarr; Oura ring &rarr; paste into
      <strong>Authorization code</strong> &rarr; Finish connecting.</p>
    <p class="step">The code is single-use and expires in a few minutes. If it stops
      working, just tap Connect Oura again.</p>`;

  document.getElementById('code').textContent = code;

  document.getElementById('copy').addEventListener('click', async () => {
    const btn = document.getElementById('copy');
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = 'Copied';
    } catch (_) {
      // Clipboard API needs a secure context and permission; selecting the
      // text is a dependable fallback.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('code'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Selected — copy it';
    }
    setTimeout(() => { btn.textContent = 'Copy code'; }, 2500);
  });
}());
