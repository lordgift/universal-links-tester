const form = document.querySelector('#check-form');
const input = document.querySelector('#domain');
const button = form.querySelector('button');
const results = document.querySelector('#results');

const STATUS_LABEL = { pass: 'ผ่าน', warn: 'ควรตรวจสอบ', fail: 'ไม่ผ่าน' };
const FINDING_ICON = { pass: '✓', warn: '!', fail: '✕', info: 'i' };

/** สร้าง element แบบปลอดภัย: children ที่เป็น string จะถูกใส่เป็น text node */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' },
    el('table', {},
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, c))))),
    ),
  );
}

function aasaSummary(summary) {
  const extras = [
    ['webcredentials', summary.webcredentials],
    ['appclips', summary.appclips],
  ].filter(([, apps]) => apps.length);

  return el('div', { class: 'summary' },
    summary.applinks.length > 0 && table(
      ['App ID', 'รูปแบบ', 'จำนวนกฎ'],
      summary.applinks.flatMap((d) =>
        d.appIDs.map((id) => [el('code', {}, id), d.format, String(d.rules)]),
      ),
    ),
    extras.map(([name, apps]) =>
      el('p', { class: 'extra' }, el('strong', {}, `${name}: `), apps.join(', ')),
    ),
  );
}

function androidSummary(summary) {
  return el('div', { class: 'summary' },
    summary.targets.length > 0 && table(
      ['Package', 'SHA-256 fingerprint'],
      summary.targets.map((t) => [el('code', {}, t.packageName), el('code', { class: 'fingerprint' }, t.sha256)]),
    ),
    summary.debug && el('details', { class: 'debug' },
      el('summary', {}, 'debugString จาก Google'),
      el('pre', {}, summary.debug),
    ),
  );
}

function rawDetails(response) {
  const statusLine = response.error
    ? `Error: ${response.error}`
    : `HTTP ${response.status} ${response.statusText} · ${response.ms} ms · ${response.bytes} bytes`;
  const body = response.json !== undefined
    ? JSON.stringify(response.json, null, 2)
    : response.preview;

  return el('details', { class: 'raw' },
    el('summary', {}, 'ดู response ดิบ'),
    el('p', { class: 'status-line' }, statusLine),
    response.headers && el('pre', {},
      Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    ),
    body && el('pre', {}, body),
  );
}

function card(title, rep, renderSummary) {
  const { response } = rep;
  return el('section', { class: `card status-${rep.status}` },
    el('header', { class: 'card-head' },
      el('div', { class: 'card-title' },
        el('h3', {}, title),
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
    rep.summary && renderSummary(rep.summary),
    rawDetails(response),
  );
}

function renderResults(data) {
  results.replaceChildren(
    el('p', { class: 'meta' },
      'ผลตรวจ ', el('strong', {}, data.domain),
      ` · ${new Date(data.checkedAt).toLocaleString('th-TH')}`,
    ),
    el('div', { class: 'platforms' },
      el('section', { class: 'platform' },
        el('h2', {}, 'iOS', el('span', {}, 'Apple App Site Association')),
        card('ไฟล์บนเว็บ', data.apple.origin, aasaSummary),
        card('Apple CDN', data.apple.cdn, aasaSummary),
      ),
      el('section', { class: 'platform' },
        el('h2', {}, 'Android', el('span', {}, 'Digital Asset Links')),
        card('ไฟล์บนเว็บ', data.android.origin, androidSummary),
        card('Google Digital Asset Links API', data.android.google, androidSummary),
      ),
    ),
  );
}

async function check(value) {
  const domain = value.trim();
  if (!domain) return;

  button.disabled = true;
  button.textContent = 'กำลังตรวจสอบ…';
  results.replaceChildren(el('p', { class: 'meta' }, 'กำลังดึงไฟล์จากเว็บ, Apple CDN และ Google…'));

  try {
    const res = await fetch(`/api/check?domain=${encodeURIComponent(domain)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    input.value = data.domain;
    history.replaceState(null, '', `?domain=${encodeURIComponent(data.domain)}`);
    renderResults(data);
  } catch (err) {
    results.replaceChildren(el('p', { class: 'error' }, `ตรวจสอบไม่สำเร็จ: ${err.message}`));
  } finally {
    button.disabled = false;
    button.textContent = 'ตรวจสอบ';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  check(input.value);
});

const initialDomain = new URLSearchParams(location.search).get('domain');
if (initialDomain) {
  input.value = initialDomain;
  check(initialDomain);
}
