// HTML rendering for lane pages. Pure string work, no I/O.

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (key in values ? values[key] : ''));
}

// Official widget loaders. These are the only third-party resources any lane loads.
export const WIDGETS = {
  hcaptcha: {
    script: 'https://js.hcaptcha.com/1/api.js',
    className: 'h-captcha',
    csp: {
      'script-src': ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
      'frame-src': ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
      'style-src': ['https://hcaptcha.com', 'https://*.hcaptcha.com', "'unsafe-inline'"],
      'connect-src': ['https://hcaptcha.com', 'https://*.hcaptcha.com'],
      'img-src': ['https://hcaptcha.com', 'https://*.hcaptcha.com', 'data:'],
    },
  },
  recaptcha: {
    script: 'https://www.google.com/recaptcha/api.js',
    className: 'g-recaptcha',
    csp: {
      'script-src': ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
      'frame-src': ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
      'style-src': ["'unsafe-inline'"],
      'img-src': ['https://www.gstatic.com/recaptcha/', 'data:'],
    },
  },
};

export function contentSecurityPolicy(lane) {
  const d = {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'frame-src': ["'self'"],
    'connect-src': ["'self'"],
    'frame-ancestors': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  const widget = lane && lane.widget && WIDGETS[lane.widget.kind];
  if (widget) for (const [k, v] of Object.entries(widget.csp)) d[k] = [...d[k], ...v];
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

export function renderLanePage({ templates, page, lane, build, environment, controlUrl, siteKey }) {
  const head = [];
  const body = [];
  for (const src of lane.fixture.scripts) head.push(`<script src="${escapeHtml(src)}" defer></script>`);
  for (const src of lane.fixture.frames) body.push(`  <iframe src="${escapeHtml(src)}" title="Fixture frame" loading="eager"></iframe>`);
  const widget = lane.widget && WIDGETS[lane.widget.kind];
  if (widget) {
    head.push(`<script src="${escapeHtml(widget.script)}" async defer></script>`);
    body.push(`  <div class="widget"><div class="${widget.className}" data-sitekey="${escapeHtml(siteKey)}"></div></div>`);
  }
  return fill(templates.layout, {
    TITLE: escapeHtml(page.title),
    SUMMARY: escapeHtml(page.summary || ''),
    BUILD: escapeHtml(build.id),
    ENVIRONMENT: escapeHtml(environment),
    CONTROL_URL: escapeHtml(controlUrl),
    HEAD: head.join('\n'),
    BODY: body.join('\n'),
  });
}
