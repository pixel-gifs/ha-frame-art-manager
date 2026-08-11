const express = require('express');
const path = require('path');
const fs = require('fs');

const DEFAULT_DIST = path.join(__dirname, 'collage-ui', 'dist');

/**
 * Mount the built collage builder (collage-ui/dist) at /collage.
 *
 * The React app is built with a relative base ('./'), so every asset URL
 * resolves against the page URL — that is what makes it work both on the
 * bare LAN port and behind the HA ingress prefix. It also means /collage
 * must redirect to /collage/ or relative assets would resolve one level too
 * high — and that redirect must itself be RELATIVE: express.static's own
 * 301 sends an absolute path, which would drop the ingress prefix.
 */
function mountCollageUi(app, distPath = DEFAULT_DIST) {
  app.get('/collage', (req, res, next) => {
    // Express matches '/collage/' here too (strict routing off) — only the
    // slashless form needs the redirect; let the rest fall through to static.
    if (req.path !== '/collage') return next();
    const query = req.url.slice(req.path.length);
    res.redirect(301, `collage/${query}`);
  });

  app.use('/collage', express.static(distPath, { redirect: false }));

  // Anything static didn't satisfy: either the dist was never built (fail
  // loud so the operator knows to build, instead of a bare 404), or it is a
  // client-side path — hand those index.html.
  app.use('/collage', (req, res) => {
    const indexPath = path.join(distPath, 'index.html');
    if (!fs.existsSync(indexPath)) {
      res
        .status(503)
        .type('text/plain')
        .send(
          'Collage UI is not built. Run: cd collage-ui && npm install && npm run build'
        );
      return;
    }
    res.sendFile(indexPath);
  });
}

module.exports = { mountCollageUi };
