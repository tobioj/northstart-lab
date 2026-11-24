// HTML rendering and Content-Security-Policy for the three role origins. Pure string work, no I/O.

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

// Official provider widget loaders. Used ONLY in the opt-in real-widget mode
// (NORTHSTAR_REAL_WIDGETS=true); by default every lane is a controlled fixture on the widget origin.
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

function serialize(d) {
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/**
 * CSP per response kind.
 *   parent-page      scenario / start / continuation documents on the parent origin
 *   widget-frame     frame documents on the widget origin (framable ONLY by the parent origin)
 *   locked           everything else (JSON, scripts, images, errors): nothing may load or frame it
 * @param {'parent-page'|'widget-frame'|'locked'} kind
 * @param {{origins?: {parent: string, widget: string, verify: string}, usesWidget?: boolean, usesVerify?: boolean, realWidget?: string}} opts
 */
export function contentSecurityPolicy(kind, { origins, usesWidget = false, usesVerify = false, realWidget = null } = {}) {
  if (kind === 'parent-page') {
    const d = {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'frame-src': ["'none'"],
      'connect-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    };
    if (usesWidget) {
      d['script-src'].push(origins.widget);
      d['img-src'].push(origins.widget);
      d['frame-src'] = [origins.widget];
    }
    if (usesVerify) d['connect-src'] = [origins.verify];
    const widget = realWidget && WIDGETS[realWidget];
    if (widget) {
      for (const [k, v] of Object.entries(widget.csp)) {
        d[k] = [...d[k].filter((x) => x !== "'none'"), ...v];
      }
    }
    return serialize(d);
  }
  if (kind === 'widget-frame') {
    return serialize({
      'default-src': ["'none'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': [origins.parent],
    });
  }
  if (kind === 'oracle-widget-frame') {
    return serialize({
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'"],
      'connect-src': [origins.verify],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': [origins.parent],
    });
  }
  return serialize({ 'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"] });
}

/**
 * Render an oracle scenario page on the parent origin.
 */
export function renderOracleParentPage({ origins, spec, token, widgetUrls }) {
  const scripts = (widgetUrls.scripts || [])
    .map((src) => `<script src="${escapeHtml(src)}" defer></script>`)
    .join('\n');
  if (spec.surface === 'clear') {
    return [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
      '<title>Ready</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/page.js" defer></script></head>',
      '<body><main><h1>Ready</h1><p id="continuation">Workflow may continue</p></main></body></html>',
    ].join('\n');
  }
  if (spec.pageText) {
    return [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
      `<title>Access notice</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/page.js" defer></script>${scripts}</head>`,
      `<body><main><h1>${escapeHtml(spec.pageText)}</h1></main></body></html>`,
    ].join('\n');
  }
  const frameSrc = (widgetUrls.frames || [])[0] || '';
  if (spec.widget === 'passive') {
    const width = spec.frameWidth || 200;
    const height = spec.frameHeight || 60;
    return [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
      `<title>Ready</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/page.js" defer></script>${scripts}</head>`,
      `<body><main><h1>Ready</h1><p id="continuation">Workflow may continue</p><iframe class="oracle-passive-frame" title="Privacy badge" src="${escapeHtml(frameSrc)}" width="${width}" height="${height}"></iframe></main></body></html>`,
    ].join('\n');
  }
  const width = spec.frameWidth || 540;
  const height = spec.frameHeight || 660;
  const completeUrl = `${origins.parent}/complete/${token}`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
    `<title>Verification</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/page.js" defer></script>${scripts}</head>`,
    '<body><main>',
    '  <h1>Verification</h1>',
    `  <section id="scenario" data-oracle="true" data-verify="${escapeHtml(origins.verify)}" data-token="${escapeHtml(token)}" data-complete="${escapeHtml(completeUrl)}">`,
    `    <iframe class="oracle-frame" title="Verification" src="${escapeHtml(frameSrc)}" width="${width}" height="${height}"></iframe>`,
    '    <p id="page-status" role="status" aria-live="polite">Verification pending</p>',
    '  </section>',
    '</main></body></html>',
  ].join('\n');
}

/**
 * Render an interactive widget frame on the widget origin for an oracle run.
 */
export function renderOracleWidgetFrame({ origins, record, token }) {
  const kind = record.widget;
  if (kind === 'passive') {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Privacy badge</title></head><body><p>Privacy badge</p></body></html>';
  }
  const rootAttrs = `id="widget-root" data-verify="${escapeHtml(origins.verify)}" data-token="${escapeHtml(token)}" data-widget="${escapeHtml(kind)}"`;
  let inner = '';
  if (kind === 'spinner') {
    inner = '<h2>Checking browser</h2><p>Checking your browser...</p><p class="status" role="status"></p>';
  } else if (kind === 'grid3' || kind === 'grid4') {
    const size = kind === 'grid4' ? 4 : 3;
    const step = 480 / size;
    const imgUrl = `/images/${record.provider_lane}/${token}/puzzle.svg`;
    const tiles = [];
    for (let i = 0; i < size * size; i += 1) {
      const left = (i % size) * step;
      const top = Math.floor(i / size) * step;
      tiles.push(`<button type="button" class="tile" data-cell="${i}" aria-label="Tile ${i + 1}" style="left:${left}px;top:${top}px;width:${step}px;height:${step}px"></button>`);
    }
    inner = [
      '<h2>Select all blue triangles</h2>',
      `<div class="puzzle"><img src="${escapeHtml(imgUrl)}" alt="Selection puzzle" draggable="false">${tiles.join('')}</div>`,
      '<button type="button" class="verify" data-target="verify">Verify selection</button>',
      '<p class="status" role="status"></p>',
    ].join('\n');
  } else if (kind === 'slider') {
    const imgUrl = `/images/${record.provider_lane}/${token}/puzzle.svg`;
    inner = [
      '<h2>Drag the purple handle onto the green target</h2>',
      `<div class="puzzle"><img src="${escapeHtml(imgUrl)}" alt="Slider puzzle" draggable="false"><button type="button" class="handle" data-target="slider" aria-label="Drag handle"></button></div>`,
      '<p class="status" role="status"></p>',
    ].join('\n');
  } else {
    const target = kind === 'hold' ? 'hold' : 'checkbox';
    const label = target === 'hold' ? 'Press and hold' : 'Click to verify';
    inner = [
      '<h2>Verification</h2>',
      `<button type="button" class="${target}" data-target="${target}">${label}</button>`,
      '<p class="status" role="status"></p>',
    ].join('\n');
  }
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
    '<title>Verification control</title><link rel="stylesheet" href="/assets/widget.css"><script src="/assets/widget.js" defer></script></head>',
    `<body><div ${rootAttrs}>${inner}</div></body></html>`,
  ].join('\n');
}

/**
 * Render the post-settlement /complete/{token} continuation page on the parent origin.
 */
export function renderCompletePage({ recurUrl = null } = {}) {
  const attr = recurUrl ? ` data-recur-url="${escapeHtml(recurUrl)}"` : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">',
    '<title>Ready</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/page.js" defer></script></head>',
    `<body><main><h1>Ready</h1><p id="continuation"${attr}>Workflow may continue</p></main></body></html>`,
  ].join('\n');
}

/**
 * Render a parent-origin document.
 * @param {object} o
 * @param {object} o.templates
 * @param {{title: string, summary?: string, notice?: string}} o.page
 * @param {{id: string}} o.build
 * @param {string} o.environment
 * @param {string} o.controlUrl
 * @param {{scripts?: string[], frames?: string[], images?: string[], frameSize?: number[]}} [o.widgetUrls]  absolute widget-origin URLs; frameSize = exact [w, h] of the frames
 * @param {{kind: string, siteKey: string}} [o.realWidget]
 * @param {{verifyOrigin: string, token: string, continueUrl: string}} [o.scenario]
 */
export function renderParentPage({ templates, page, build, environment, controlUrl, widgetUrls = {}, realWidget = null, scenario = null, status = null }) {
  const head = [];
  const body = [];
  for (const src of widgetUrls.scripts || []) head.push(`<script src="${escapeHtml(src)}" defer></script>`);
  const size = widgetUrls.frameSize ? ` width="${Number(widgetUrls.frameSize[0])}" height="${Number(widgetUrls.frameSize[1])}"` : '';
  for (const src of widgetUrls.frames || []) body.push(`  <iframe src="${escapeHtml(src)}" title="Fixture frame" loading="eager"${size}></iframe>`);
  for (const src of widgetUrls.images || []) body.push(`  <img src="${escapeHtml(src)}" alt="" width="40" height="40">`);
  const widget = realWidget && WIDGETS[realWidget.kind];
  if (widget) {
    head.push(`<script src="${escapeHtml(widget.script)}" async defer></script>`);
    body.push(`  <div class="widget"><div class="${widget.className}" data-sitekey="${escapeHtml(realWidget.siteKey)}"></div></div>`);
  }
  if (scenario) {
    body.push(
      `  <section id="scenario" data-verify="${escapeHtml(scenario.verifyOrigin)}" data-token="${escapeHtml(scenario.token)}" data-continue="${escapeHtml(scenario.continueUrl)}">`,
      '    <p class="actions"><button type="button" id="complete-button">Complete scenario</button></p>',
      '  </section>',
    );
  }
  return fill(templates.layout, {
    TITLE: escapeHtml(page.title),
    SUMMARY: escapeHtml(page.summary || ''),
    NOTICE: page.notice ? `<p class="notice">${escapeHtml(page.notice)}</p>` : '',
    STATE: status ? `<div><dt>Scenario state</dt><dd id="scenario-state">${escapeHtml(status)}</dd></div>` : '',
    BUILD: escapeHtml(build.id),
    ENVIRONMENT: escapeHtml(environment),
    CONTROL_URL: escapeHtml(controlUrl),
    HEAD: head.join('\n'),
    BODY: body.join('\n'),
  });
}
