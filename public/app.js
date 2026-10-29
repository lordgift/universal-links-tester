const form = document.querySelector('#check-form');
const input = document.querySelector('#domain');
const submitBtn = document.querySelector('#submit-btn');
const results = document.querySelector('#results');
const recentBar = document.querySelector('#recent-bar');
const themeToggle = document.querySelector('#theme-toggle');

const STATUS_LABEL = { pass: 'ผ่าน', warn: 'ควรตรวจสอบ', fail: 'ไม่ผ่าน' };
const FINDING_ICON = { pass: '✓', warn: '!', fail: '✕', info: 'i' };
const RECENT_KEY = 'ult_recent_domains';
const THEME_KEY = 'ult_theme';

// ---------- Theme & Shortcuts ----------

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  themeToggle?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const isDark =
      current === 'dark' ||
      (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    input.focus();
    input.select();
  }
});

// ---------- DOM Helper ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'oninput') node.addEventListener('input', value);
    else if (key === 'hidden') node.hidden = Boolean(value);
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

function copyButton(text, label = 'คัดลอก') {
  const btn = el('button', {
    type: 'button',
    class: 'copy-mini',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = '✓ คัดลอกแล้ว';
        setTimeout(() => { btn.textContent = prev; }, 1400);
      } catch {
        // ignore
      }
    },
  }, label);
  return btn;
}

// ---------- Recent History ----------

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecent(domain) {
  const list = [domain, ...getRecent().filter((d) => d !== domain)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  renderRecent();
}

function renderRecent() {
  const list = getRecent();
  if (!list.length) {
    recentBar.hidden = true;
    return;
  }
  recentBar.hidden = false;
  recentBar.replaceChildren(
    el('span', { class: 'quick-label' }, 'ล่าสุด:'),
    list.map((d) =>
      el('button', {
        type: 'button',
        class: 'chip',
        onclick: () => {
          input.value = d;
          check(d);
        },
      }, d),
    ),
  );
}

document.querySelectorAll('[data-domain]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = btn.getAttribute('data-domain');
    input.value = d;
    check(d);
  });
});

// ---------- AASA Deep Link Rule Matcher ----------

function globToRegex(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re);
}

function formatRuleItem(rule) {
  if (typeof rule === 'string') {
    const isNot = rule.trim().startsWith('NOT ');
    return { text: rule, exclude: isNot };
  }
  if (rule && typeof rule === 'object') {
    const parts = [];
    if (rule['/']) parts.push(`path: ${rule['/']}`);
    if (rule['?']) parts.push(`query: ${JSON.stringify(rule['?'])}`);
    if (rule['#']) parts.push(`#${rule['#']}`);
    if (rule.comment) parts.push(`/* ${rule.comment} */`);
    return {
      text: parts.join(' ') || JSON.stringify(rule),
      exclude: Boolean(rule.exclude),
    };
  }
  return { text: String(rule), exclude: false };
}

function evaluateAasaPath(summary, rawPathInput) {
  if (!summary?.applinks?.length) return { supported: false, reason: 'ไม่มีข้อมูลกฎ applinks' };
  let urlObj;
  try {
    const normalized = rawPathInput.startsWith('/') ? rawPathInput : `/${rawPathInput}`;
    urlObj = new URL(normalized, 'https://example.com');
  } catch {
    return { supported: false, reason: 'รูปแบบ Path ไม่ถูกต้อง' };
  }

  const pathname = urlObj.pathname;
  const matches = [];

  for (const group of summary.applinks) {
    for (const rule of group.rulesList || []) {
      if (typeof rule === 'string') {
        const isNot = rule.trim().startsWith('NOT ');
        const pat = isNot ? rule.trim().slice(4).trim() : rule.trim();
        if (globToRegex(pat).test(pathname)) {
          matches.push({
            allowed: !isNot,
            appIDs: group.appIDs,
            ruleText: rule,
          });
          break;
        }
      } else if (rule && typeof rule === 'object') {
        const pathPat = rule['/'] ?? '*';
        const pathOk = globToRegex(pathPat).test(pathname);
        let queryOk = true;
        if (rule['?'] && typeof rule['?'] === 'object') {
          for (const [k, v] of Object.entries(rule['?'])) {
            const actual = urlObj.searchParams.get(k);
            if (actual === null || !globToRegex(String(v)).test(actual)) {
              queryOk = false;
              break;
            }
          }
        }
        if (pathOk && queryOk) {
          matches.push({
            allowed: !rule.exclude,
            appIDs: group.appIDs,
            ruleText: formatRuleItem(rule).text,
          });
          break;
        }
      }
    }
  }

  const allowedMatch = matches.find((m) => m.allowed);
  const excludedMatch = matches.find((m) => !m.allowed);

  if (excludedMatch && !allowedMatch) {
    return {
      matched: false,
      excluded: true,
      detail: `ถูกยกเว้น (Exclude) ด้วยกฎ ${excludedMatch.ruleText}`,
    };
  }
  if (allowedMatch) {
    return {
      matched: true,
      detail: `เปิดแอป ${allowedMatch.appIDs[0]} (ตรงกับกฎ ${allowedMatch.ruleText})`,
    };
  }
  return {
    matched: false,
    detail: `ไม่ตรงกับกฎใดเลยใน ${summary.applinks.length} กลุ่มกฎ (จะเปิดใน Safari แทน)`,
  };
}

// ---------- Propagation Pipeline Cards ----------

function renderCacheMeter(cache, labelPrefix = 'CDN Cache TTL') {
  if (!cache || !cache.maxAgeFormatted) return null;
  const pct = cache.percentRemaining ?? 100;
  return el('div', { class: 'cache-meter' },
    el('div', { class: 'cache-meter-head' },
      el('span', {}, `${labelPrefix}: ${cache.maxAgeFormatted}`),
      cache.remainingFormatted
        ? el('span', {}, `ผ่านไป ${cache.ageFormatted} · เหลือ ~${cache.remainingFormatted} (${pct}%)`)
        : el('span', {}, `maxAge ${cache.maxAgeFormatted}`),
    ),
    cache.remainingFormatted && el('div', { class: 'cache-bar-track' },
      el('div', { class: 'cache-bar-fill', style: `width: ${pct}%` }),
    ),
  );
}

function renderPipelineOverview(data) {
  const appleSync = data.apple.cdn.meta?.syncState ?? 'unavailable';
  const appleLabel = data.apple.cdn.meta?.syncLabel ?? 'ไม่ทราบสถานะ';
  const androidSync = data.android.google.meta?.syncState ?? 'unavailable';
  const androidLabel = data.android.google.meta?.syncLabel ?? 'ไม่ทราบสถานะ';

  const arrowClass = (s) => (s === 'synced' ? 'arrow-synced' : s === 'out_of_sync' || s === 'cdn_only' ? 'arrow-warn' : 'arrow-fail');

  return el('section', { class: 'pipeline-grid' },
    // iOS Pipeline
    el('div', { class: 'pipeline-card' },
      el('div', { class: 'pipeline-top' },
        el('div', { class: 'pipeline-platform' }, ' iOS Universal Links Propagation'),
        el('span', { class: `sync-pill sync-${appleSync}` }, appleLabel),
      ),
      el('div', { class: 'pipeline-nodes' },
        el('div', { class: `p-node node-${data.apple.origin.status}` },
          el('div', { class: 'p-node-label' }, '1. Origin Server'),
          el('div', { class: 'p-node-status' },
            el('span', {}, STATUS_LABEL[data.apple.origin.status]),
            el('code', {}, data.apple.origin.response.status ? `HTTP ${data.apple.origin.response.status}` : 'Error'),
          ),
          el('div', { class: 'p-node-meta' },
            data.apple.origin.summary
              ? `${data.apple.origin.summary.allAppIDs.length} App IDs · ${data.apple.origin.response.ms} ms`
              : `${data.apple.origin.response.ms ?? '-'} ms`,
          ),
        ),
        el('div', { class: 'p-connector' },
          el('span', {}, appleSync === 'synced' ? 'MATCH' : 'SYNC'),
          el('div', { class: `p-arrow ${arrowClass(appleSync)}` }),
        ),
        el('div', { class: `p-node node-${data.apple.cdn.status}` },
          el('div', { class: 'p-node-label' }, '2. Apple Edge CDN'),
          el('div', { class: 'p-node-status' },
            el('span', {}, STATUS_LABEL[data.apple.cdn.status]),
            el('code', {}, data.apple.cdn.response.status ? `HTTP ${data.apple.cdn.response.status}` : 'Error'),
          ),
          el('div', { class: 'p-node-meta' },
            data.apple.cdn.summary
              ? `${data.apple.cdn.summary.allAppIDs.length} App IDs · ${data.apple.cdn.response.ms} ms`
              : `${data.apple.cdn.response.ms ?? '-'} ms`,
          ),
        ),
      ),
      renderCacheMeter(data.apple.cdn.meta?.cache, 'Apple CDN Cache'),
    ),

    // Android Pipeline
    el('div', { class: 'pipeline-card' },
      el('div', { class: 'pipeline-top' },
        el('div', { class: 'pipeline-platform' }, '🤖 Android App Links Propagation'),
        el('span', { class: `sync-pill sync-${androidSync}` }, androidLabel),
      ),
      el('div', { class: 'pipeline-nodes' },
        el('div', { class: `p-node node-${data.android.origin.status}` },
          el('div', { class: 'p-node-label' }, '1. Origin Server'),
          el('div', { class: 'p-node-status' },
            el('span', {}, STATUS_LABEL[data.android.origin.status]),
            el('code', {}, data.android.origin.response.status ? `HTTP ${data.android.origin.response.status}` : 'Error'),
          ),
          el('div', { class: 'p-node-meta' },
            data.android.origin.summary
              ? `${data.android.origin.summary.targets.length} Fingerprints · ${data.android.origin.response.ms} ms`
              : `${data.android.origin.response.ms ?? '-'} ms`,
          ),
        ),
        el('div', { class: 'p-connector' },
          el('span', {}, androidSync === 'synced' ? 'MATCH' : 'SYNC'),
          el('div', { class: `p-arrow ${arrowClass(androidSync)}` }),
        ),
        el('div', { class: `p-node node-${data.android.google.status}` },
          el('div', { class: 'p-node-label' }, '2. Google AssetLinks API'),
          el('div', { class: 'p-node-status' },
            el('span', {}, STATUS_LABEL[data.android.google.status]),
            el('code', {}, data.android.google.response.status ? `HTTP ${data.android.google.response.status}` : 'Error'),
          ),
          el('div', { class: 'p-node-meta' },
            data.android.google.summary
              ? `${data.android.google.summary.targets.length} Fingerprints · ${data.android.google.response.ms} ms`
              : `${data.android.google.response.ms ?? '-'} ms`,
          ),
        ),
      ),
      renderCacheMeter(data.android.google.meta?.cache, 'Google API Cache'),
    ),
  );
}

// ---------- Interactive Deep Link Path Simulator ----------

function renderPathTester(data) {
  const hasOriginRules = data.apple.origin.summary?.applinks?.length > 0;
  const hasCdnRules = data.apple.cdn.summary?.applinks?.length > 0;
  if (!hasOriginRules && !hasCdnRules) return null;

  const initialPath = data.initialPath || '/watch?v=dQw4w9WgXcQ';
  const resultContainer = el('div', { class: 'path-results' });

  function updateMatch(pathVal) {
    const originEval = evaluateAasaPath(data.apple.origin.summary, pathVal);
    const cdnEval = evaluateAasaPath(data.apple.cdn.summary, pathVal);

    resultContainer.replaceChildren(
      el('div', { class: `path-res-box ${originEval.matched ? 'match-yes' : 'match-no'}` },
        el('strong', {}, 'ผลจำลองบนไฟล์เว็บต้นทาง (Origin): '),
        el('div', {}, originEval.detail || originEval.reason),
      ),
      el('div', { class: `path-res-box ${cdnEval.matched ? 'match-yes' : 'match-no'}` },
        el('strong', {}, 'ผลจำลองบน Apple CDN (เครื่องผู้ใช้จริง): '),
        el('div', {}, cdnEval.detail || cdnEval.reason),
      ),
    );
  }

  const pathInput = el('input', {
    type: 'text',
    value: initialPath,
    placeholder: '/path/to/page?query=1',
    oninput: (e) => updateMatch(e.target.value),
  });

  updateMatch(initialPath);

  return el('section', { class: 'path-tester' },
    el('div', { class: 'path-tester-head' },
      el('h3', {}, '🔗 ทดสอบจำลอง URL Path กับกฎ iOS Universal Links (Origin vs Apple CDN)'),
      el('span', { class: 'checked-time' }, 'พิมพ์ Path เพื่อเช็คว่าจะเปิดแอปหรือเปิด Safari'),
    ),
    el('div', { class: 'path-tester-controls' },
      el('div', { class: 'path-input-group' },
        el('span', { class: 'path-domain-prefix' }, `https://${data.domain}`),
        pathInput,
      ),
    ),
    resultContainer,
  );
}

// ---------- Card Summaries & Tabs ----------

function renderAppIdPill(appId) {
  const dot = appId.indexOf('.');
  if (dot === 10) {
    return el('span', { class: 'appid-pill' },
      el('strong', { title: 'Apple Team ID' }, appId.slice(0, 10)),
      appId.slice(10),
    );
  }
  return el('span', { class: 'appid-pill' }, appId);
}

function aasaSummaryView(summary) {
  if (!summary) return el('p', { class: 'checked-time' }, 'ไม่มีข้อมูล JSON ที่นำมาสรุปได้');
  const extras = [
    ['webcredentials', summary.webcredentials],
    ['appclips', summary.appclips],
  ].filter(([, apps]) => apps?.length);

  return el('div', { class: 'summary' },
    summary.applinks.map((group, idx) => {
      const formattedRules = (group.rulesList || []).map(formatRuleItem);
      const previewRules = formattedRules.slice(0, 10);
      return el('div', { class: 'app-group' },
        el('div', { class: 'app-group-head' },
          el('div', { class: 'app-ids-list' }, group.appIDs.map(renderAppIdPill)),
          el('span', { class: 'endpoint-tag' }, `กลุ่ม #${idx + 1} · ${group.format} (${group.rules} กฎ)`),
        ),
        previewRules.length > 0 && el('div', { class: 'rules-preview' },
          previewRules.map((r) =>
            el('span', { class: `rule-chip ${r.exclude ? 'rule-exclude' : ''}` },
              r.exclude ? `EXCLUDE ${r.text}` : r.text,
            ),
          ),
          formattedRules.length > 10 && el('span', { class: 'rule-chip' }, `+อีก ${formattedRules.length - 10} กฎ`),
        ),
      );
    }),
    extras.map(([name, apps]) =>
      el('p', { class: 'extra' }, el('strong', {}, `${name} (${apps.length}): `), el('code', {}, apps.join(', '))),
    ),
  );
}

function androidSummaryView(summary) {
  if (!summary) return el('p', { class: 'checked-time' }, 'ไม่มีข้อมูล Statement ที่นำมาสรุปได้');
  return el('div', { class: 'summary' },
    summary.targets.length > 0 && el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Package Name'),
            el('th', {}, 'SHA-256 Certificate Fingerprint'),
          ),
        ),
        el('tbody', {},
          summary.targets.map((t) =>
            el('tr', {},
              el('td', {}, el('code', {}, t.packageName)),
              el('td', {},
                el('div', { class: 'fingerprint-row' },
                  el('span', {}, t.sha256),
                  copyButton(t.sha256, 'Copy'),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    summary.debug && el('div', { style: 'margin-top: 12px;' },
      el('div', { class: 'code-toolbar' },
        el('strong', { style: 'font-size: 0.82rem;' }, 'Google Diagnostic Debug Log'),
        copyButton(summary.debug, 'คัดลอก Debug Log'),
      ),
      el('pre', {}, summary.debug),
    ),
  );
}

function renderHeadersTab(response) {
  const headers = response.headers ? Object.entries(response.headers) : [];
  if (!headers.length) return el('p', { class: 'checked-time' }, 'ไม่มีข้อมูล HTTP Headers');
  const priorityKeys = new Set([
    'content-type',
    'cache-control',
    'age',
    'expires',
    'etag',
    'last-modified',
    'apple-failure-reason',
    'location',
    'server',
  ]);
  const sorted = [...headers].sort(([a], [b]) => {
    const pa = priorityKeys.has(a.toLowerCase()) ? 0 : 1;
    const pb = priorityKeys.has(b.toLowerCase()) ? 0 : 1;
    return pa - pb || a.localeCompare(b);
  });

  return el('div', { class: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Header'), el('th', {}, 'Value'))),
      el('tbody', {},
        sorted.map(([k, v]) =>
          el('tr', {},
            el('td', {}, el('code', {}, k)),
            el('td', { style: 'overflow-wrap: anywhere;' }, el('code', {}, v)),
          ),
        ),
      ),
    ),
  );
}

function renderRawTab(response) {
  const body =
    response.json !== undefined
      ? JSON.stringify(response.json, null, 2)
      : response.preview || '(ไม่มีเนื้อหา Response Body)';
  const curlCmd = `curl -i "${response.url}"`;

  return el('div', {},
    el('div', { class: 'code-toolbar' },
      el('span', { class: 'checked-time' },
        response.error
          ? `Error: ${response.error}`
          : `HTTP ${response.status} · ${response.ms} ms · ${response.bytes} bytes`,
      ),
      el('div', { style: 'display: flex; gap: 6px;' },
        copyButton(curlCmd, 'Copy cURL'),
        copyButton(body, 'Copy JSON'),
      ),
    ),
    el('pre', {}, body),
  );
}

function renderCompareTab(originRep, cdnRep, isApple) {
  const syncState = cdnRep.meta?.syncState;
  if (syncState === 'synced') {
    return el('div', { class: 'path-res-box match-yes' },
      el('strong', {}, '✓ ข้อมูลตรงกัน 100% (Fully Propagated)'),
      el('div', {}, isApple
        ? 'เนื้อหา JSON บน Apple CDN ตรงกับไฟล์ .well-known/apple-app-site-association บนเว็บต้นทางทุกประการ'
        : 'รายการ Package Name และ SHA-256 Fingerprint บน Google API ตรงกับไฟล์ .well-known/assetlinks.json บนเว็บต้นทางทุกประการ'),
    );
  }

  if (isApple) {
    const originIds = new Set(originRep.summary?.allAppIDs || []);
    const cdnIds = new Set(cdnRep.summary?.allAppIDs || []);
    const onlyOrigin = [...originIds].filter((x) => !cdnIds.has(x));
    const onlyCdn = [...cdnIds].filter((x) => !originIds.has(x));

    return el('div', { class: 'summary' },
      el('p', { class: 'checked-time' }, `สถานะ: ${cdnRep.meta?.syncLabel || 'ไม่ตรงกัน'}`),
      onlyOrigin.length > 0 && el('div', { class: 'app-group' },
        el('strong', {}, `มีบนเว็บต้นทาง แต่ยังไม่อยู่บน Apple CDN (${onlyOrigin.length}): `),
        el('div', { class: 'app-ids-list', style: 'margin-top:6px;' }, onlyOrigin.map(renderAppIdPill)),
      ),
      onlyCdn.length > 0 && el('div', { class: 'app-group' },
        el('strong', {}, `ค้างอยู่บน Apple CDN แต่ลบออกจากเว็บต้นทางแล้ว (${onlyCdn.length}): `),
        el('div', { class: 'app-ids-list', style: 'margin-top:6px;' }, onlyCdn.map(renderAppIdPill)),
      ),
      !onlyOrigin.length && !onlyCdn.length && el('p', {}, 'App ID เหมือนกัน แต่รายละเอียดกฎ (paths / components) หรือโครงสร้าง JSON ต่างกัน ดูได้ในแท็บ Raw JSON'),
    );
  }

  const missing = cdnRep.summary?.missing || [];
  const stale = cdnRep.summary?.stale || [];
  return el('div', { class: 'summary' },
    el('p', { class: 'checked-time' }, `สถานะ: ${cdnRep.meta?.syncLabel || 'ไม่ตรงกัน'}`),
    missing.length > 0 && el('div', { class: 'app-group' },
      el('strong', {}, `มีบนเว็บต้นทาง แต่ Google ยังไม่เห็น (${missing.length}):`),
      missing.map((t) => el('div', { class: 'fingerprint-row' }, `${t.packageName} (${t.sha256})`)),
    ),
    stale.length > 0 && el('div', { class: 'app-group' },
      el('strong', {}, `ค้างอยู่บน Google แต่ไม่มีบนเว็บต้นทางแล้ว (${stale.length}):`),
      stale.map((t) => el('div', { class: 'fingerprint-row' }, `${t.packageName} (${t.sha256})`)),
    ),
  );
}

function card(title, tagLabel, rep, renderSummary, compareTabFn = null) {
  const { response } = rep;
  const tabs = [
    { id: 'summary', label: 'สรุปกฎ & App', content: () => renderSummary(rep.summary) },
    ...(compareTabFn ? [{ id: 'compare', label: 'เทียบ Origin vs CDN', content: compareTabFn }] : []),
    { id: 'headers', label: `Headers (${Object.keys(response.headers || {}).length})`, content: () => renderHeadersTab(response) },
    { id: 'raw', label: 'Raw JSON & cURL', content: () => renderRawTab(response) },
  ];

  const tabButtons = [];
  const tabPanels = [];

  tabs.forEach((t, idx) => {
    const panel = el('div', { class: 'tab-panel', hidden: idx !== 0 }, t.content());
    const btn = el('button', {
      type: 'button',
      class: `tab-btn ${idx === 0 ? 'active' : ''}`,
      onclick: () => {
        tabButtons.forEach((b) => b.classList.remove('active'));
        tabPanels.forEach((p) => { p.hidden = true; });
        btn.classList.add('active');
        panel.hidden = false;
      },
    }, t.label);
    tabButtons.push(btn);
    tabPanels.push(panel);
  });

  return el('section', { class: `card status-${rep.status}` },
    el('div', { class: 'card-body' },
      el('header', { class: 'card-head' },
        el('div', { class: 'card-title' },
          el('div', { class: 'card-title-row' },
            el('h3', {}, title),
            el('span', { class: 'endpoint-tag' }, tagLabel),
          ),
          el('a', { class: 'url', href: response.url, target: '_blank', rel: 'noopener noreferrer' }, response.url),
        ),
        el('span', { class: `badge badge-${rep.status}` }, STATUS_LABEL[rep.status]),
      ),
      el('ul', { class: 'findings' },
        rep.findings.map((f) =>
          el('li', { class: `finding finding-${f.level}` },
            el('span', { class: 'icon', 'aria-hidden': 'true' }, FINDING_ICON[f.level]),
            el('span', {}, f.message),
          ),
        ),
      ),
    ),
    el('div', { class: 'tabs-bar' }, tabButtons),
    tabPanels,
  );
}

// ---------- Main Results Renderer ----------

function renderResults(data) {
  const shareUrl = `${location.origin}/?domain=${encodeURIComponent(data.domain)}`;

  results.replaceChildren(
    // Top Result Bar
    el('div', { class: 'result-header' },
      el('div', { class: 'result-domain-info' },
        el('span', { class: 'domain-title' }, data.domain),
        el('span', { class: 'checked-time' }, `ตรวจสอบเมื่อ ${new Date(data.checkedAt).toLocaleString('th-TH')}`),
      ),
      el('div', { class: 'result-actions' },
        copyButton(shareUrl, '🔗 คัดลอกลิงก์ผลตรวจ'),
        el('button', {
          type: 'button',
          class: 'btn-secondary',
          onclick: () => check(data.domain),
        }, '↻ ตรวจสอบซ้ำ'),
      ),
    ),

    // Redirect Suggestion Banner (e.g. youtube.com -> www.youtube.com)
    data.suggestedRedirectDomain && el('div', { class: 'redirect-banner' },
      el('div', { class: 'redirect-banner-text' },
        el('span', {}, '⚠️'),
        el('span', {},
          `โดเมน ${data.domain} มีการ Redirect ไปยัง `,
          el('strong', {}, data.suggestedRedirectDomain),
          ' (ทั้ง Apple และ Android ไม่รองรับการ Redirect ของไฟล์ .well-known)',
        ),
      ),
      el('button', {
        type: 'button',
        class: 'btn-redirect',
        onclick: () => {
          input.value = data.suggestedRedirectDomain;
          check(data.suggestedRedirectDomain);
        },
      }, `สลับไปตรวจ ${data.suggestedRedirectDomain} →`),
    ),

    // Visual Propagation Pipeline
    renderPipelineOverview(data),

    // Interactive Deep Link Path Simulator
    renderPathTester(data),

    // Detailed Platform Cards
    el('div', { class: 'platforms' },
      el('section', { class: 'platform' },
        el('div', { class: 'platform-header' },
          el('h2', {}, ' iOS Universal Links', el('span', { class: 'sub' }, 'Apple App Site Association')),
        ),
        card('ไฟล์บนเว็บต้นทาง', 'Origin · /.well-known/apple-app-site-association', data.apple.origin, aasaSummaryView),
        card('Apple Edge CDN', 'Propagated CDN · cdn-apple.com', data.apple.cdn, aasaSummaryView, () =>
          renderCompareTab(data.apple.origin, data.apple.cdn, true),
        ),
      ),
      el('section', { class: 'platform' },
        el('div', { class: 'platform-header' },
          el('h2', {}, '🤖 Android App Links', el('span', { class: 'sub' }, 'Digital Asset Links')),
        ),
        card('ไฟล์บนเว็บต้นทาง', 'Origin · /.well-known/assetlinks.json', data.android.origin, androidSummaryView),
        card('Google Digital Asset Links API', 'Propagated API · googleapis.com', data.android.google, androidSummaryView, () =>
          renderCompareTab(data.android.origin, data.android.google, false),
        ),
      ),
    ),
  );
}

// ---------- Check Action ----------

async function check(value) {
  const raw = value.trim();
  if (!raw) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'กำลังดึงข้อมูล…';
  results.replaceChildren(
    el('div', { class: 'skeleton-wrap' },
      el('div', { class: 'skeleton-box', style: 'height: 64px;' }),
      el('div', { class: 'pipeline-grid' },
        el('div', { class: 'skeleton-box', style: 'height: 180px;' }),
        el('div', { class: 'skeleton-box', style: 'height: 180px;' }),
      ),
      el('div', { class: 'platforms' },
        el('div', { class: 'skeleton-box', style: 'height: 320px;' }),
        el('div', { class: 'skeleton-box', style: 'height: 320px;' }),
      ),
    ),
  );

  try {
    const res = await fetch(`/api/check?domain=${encodeURIComponent(raw)}`);
    if (!res.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`API ตอบ HTTP ${res.status} ที่ไม่ใช่ JSON (ตรวจว่า /api/check ถูก deploy แล้ว)`);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    input.value = data.initialPath ? `${data.domain}${data.initialPath}` : data.domain;
    history.replaceState(null, '', `?domain=${encodeURIComponent(data.domain)}`);
    saveRecent(data.domain);
    renderResults(data);
  } catch (err) {
    results.replaceChildren(el('div', { class: 'error-box' }, `ตรวจสอบไม่สำเร็จ: ${err.message}`));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'ตรวจสอบทันที';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  check(input.value);
});

initTheme();
renderRecent();

const initialDomain = new URLSearchParams(location.search).get('domain');
if (initialDomain) {
  input.value = initialDomain;
  check(initialDomain);
}
