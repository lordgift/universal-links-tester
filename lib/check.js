import { isDeepStrictEqual } from 'node:util';

const FETCH_TIMEOUT_MS = 10_000;
const AASA_MAX_BYTES = 128 * 1024;
const RAW_PREVIEW_CHARS = 4000;
const USER_AGENT = 'universal-links-tester/1.0';
const HANDLE_ALL_URLS = 'delegate_permission/common.handle_all_urls';

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const APP_ID_RE = /^[A-Z0-9]{10}\.\S+$/;
const SHA256_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i;

// ---------- helpers ----------

/** รับได้ทั้ง "example.com", "https://example.com/path" แล้วคืน hostname ที่ปลอดภัย หรือ null */
function parseDomain(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return HOSTNAME_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

async function fetchRaw(url) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: 'application/json, */*;q=0.8' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      url,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers),
      bytes: buf.length,
      text: buf.toString('utf8'),
      ms: elapsed(),
    };
  } catch (err) {
    return { url, error: describeFetchError(err), ms: elapsed() };
  }
}

function describeFetchError(err) {
  if (err.name === 'TimeoutError') return `หมดเวลา (เกิน ${FETCH_TIMEOUT_MS / 1000} วินาที)`;
  if (err.cause?.code) return `${err.cause.code}: ${err.cause.message}`;
  return err.message;
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function formatDuration(sec) {
  if (sec < 60) return `${sec} วินาที`;
  if (sec < 3600) return `${Math.floor(sec / 60)} นาที`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
}

// HTTP/2 ไม่มี status text จึงต้องกันไม่ให้ต่อท้ายเป็นช่องว่าง
const statusLabel = (res) => [res.status, res.statusText].filter(Boolean).join(' ');

function cacheNote(headers) {
  const maxAge = Number(/max-age=(\d+)/.exec(headers['cache-control'] ?? '')?.[1]);
  if (!Number.isFinite(maxAge)) return null;
  const age = Number(headers.age) || 0;
  return `CDN แคชผลนี้ไว้ ${formatDuration(maxAge)} (ผ่านไปแล้ว ${formatDuration(age)} · เหลือราว ${formatDuration(Math.max(maxAge - age, 0))})`;
}

const LEVEL_RANK = { info: 0, pass: 0, warn: 1, fail: 2 };

function worst(findings) {
  const rank = Math.max(0, ...findings.map((f) => LEVEL_RANK[f.level]));
  return rank === 2 ? 'fail' : rank === 1 ? 'warn' : 'pass';
}

function collector() {
  const findings = [];
  return { findings, add: (level, message) => findings.push({ level, message }) };
}

/** ตัด body ดิบออก แล้วแนบ json ที่ parse แล้ว หรือ preview ของข้อความแทน */
function publicResponse(res, json) {
  const { text, ...rest } = res;
  if (text === undefined) return rest;
  return json !== undefined ? { ...rest, json } : { ...rest, preview: text.slice(0, RAW_PREVIEW_CHARS) };
}

function report(res, findings, { json, summary } = {}) {
  return { status: worst(findings), findings, summary, response: publicResponse(res, json) };
}

/** เช็คว่าได้ 200 ตรงๆ (ไม่ redirect) คืน true ถ้าไปต่อได้ */
function checkHttp(res, add, redirectNote) {
  if (res.error) {
    add('fail', `เชื่อมต่อไม่ได้ — ${res.error}`);
    return false;
  }
  if (res.status >= 300 && res.status < 400) {
    add('fail', `ได้ HTTP ${res.status} redirect ไป ${res.headers.location ?? '(ไม่ระบุ)'} — ${redirectNote}`);
    return false;
  }
  if (res.status !== 200) {
    add('fail', `ได้ HTTP ${statusLabel(res)} (ต้องเป็น 200)`);
    return false;
  }
  add('pass', `HTTP 200 ภายใน ${res.ms} ms`);
  return true;
}

// ---------- iOS: apple-app-site-association ----------

function summarizeAasa(json) {
  return {
    applinks: arr(json?.applinks?.details).map((d) => ({
      appIDs: Array.isArray(d.appIDs) ? d.appIDs : d.appID ? [d.appID] : [],
      format: Array.isArray(d.components) ? 'components' : Array.isArray(d.paths) ? 'paths' : '-',
      rules: arr(d.components).length || arr(d.paths).length,
    })),
    webcredentials: arr(json?.webcredentials?.apps),
    appclips: arr(json?.appclips?.apps),
  };
}

function validateAasa(json, add) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    add('fail', 'เนื้อหาต้องเป็น JSON object');
    return;
  }
  if (!json.applinks) {
    add('fail', 'ไม่มี key "applinks" — Universal Links จะไม่ทำงาน');
    return;
  }
  const { applinks } = summarizeAasa(json);
  const appIDs = applinks.flatMap((d) => d.appIDs);
  if (appIDs.length === 0) {
    add('fail', 'applinks.details ว่าง หรือไม่มี appID / appIDs');
    return;
  }
  for (const id of appIDs.filter((id) => !APP_ID_RE.test(id))) {
    add('warn', `App ID "${id}" ไม่อยู่ในรูปแบบ <TeamID 10 ตัว>.<Bundle ID>`);
  }
  add('pass', `applinks ครอบคลุม ${appIDs.length} app`);
}

function analyzeAasaOrigin(res) {
  const { findings, add } = collector();
  let json;
  if (checkHttp(res, add, 'Apple ไม่ follow redirect ไฟล์ต้องอยู่ที่ URL นี้ตรงๆ')) {
    const type = res.headers['content-type'] ?? '';
    if (!type.includes('application/json')) add('warn', `Content-Type เป็น "${type || 'ไม่ระบุ'}" ควรเป็น application/json`);
    if (res.bytes > AASA_MAX_BYTES) add('fail', `ขนาดไฟล์ ${kb(res.bytes)} เกิน 128 KB ที่ Apple กำหนด`);
    const parsed = parseJson(res.text);
    if (parsed.ok) {
      json = parsed.value;
      validateAasa(json, add);
    } else {
      add('fail', `JSON ไม่ถูกต้อง — ${parsed.error}`);
    }
  }
  return report(res, findings, { json, summary: json && summarizeAasa(json) });
}

function analyzeAppleCdn(res, originJson) {
  const { findings, add } = collector();
  let json;
  if (res.error) {
    add('fail', `เชื่อมต่อ Apple CDN ไม่ได้ — ${res.error}`);
  } else if (res.status === 200) {
    add('pass', 'Apple CDN มีไฟล์ของโดเมนนี้แล้ว');
    const parsed = parseJson(res.text);
    if (parsed.ok) {
      json = parsed.value;
      if (originJson === undefined) {
        add('warn', 'CDN ยังมีไฟล์อยู่ แต่ดึงไฟล์จากเว็บต้นทางไม่ได้ จึงเทียบเนื้อหาไม่ได้');
      } else if (isDeepStrictEqual(json, originJson)) {
        add('pass', 'เนื้อหาตรงกับไฟล์บนเว็บแล้ว (propagate เรียบร้อย)');
      } else {
        add('warn', 'เนื้อหายังไม่ตรงกับไฟล์บนเว็บ — CDN อาจยังแคชเวอร์ชันเก่าอยู่ ต้องรอ Apple ดึงไฟล์ใหม่');
      }
    } else {
      add('fail', `JSON จาก CDN ไม่ถูกต้อง — ${parsed.error}`);
    }
  } else {
    add('fail', `Apple CDN ตอบ HTTP ${statusLabel(res)}`);
    const reason = res.headers['apple-failure-reason'];
    if (reason) add('fail', `เหตุผลจาก Apple: ${reason}`);
  }
  const note = !res.error && cacheNote(res.headers);
  if (note) add('info', note);
  return report(res, findings, { json, summary: json && summarizeAasa(json) });
}

// ---------- Android: assetlinks.json ----------

const targetKey = (t) => `${t.packageName}|${String(t.sha256).toUpperCase()}`;

function analyzeAssetlinksOrigin(res) {
  const { findings, add } = collector();
  let json;
  let targets;
  if (checkHttp(res, add, 'Android ไม่ยอมรับ redirect ไฟล์ต้องอยู่ที่ URL นี้ตรงๆ')) {
    const type = res.headers['content-type'] ?? '';
    if (!type.includes('application/json')) add('fail', `Content-Type เป็น "${type || 'ไม่ระบุ'}" ต้องเป็น application/json`);
    const parsed = parseJson(res.text);
    if (!parsed.ok) {
      add('fail', `JSON ไม่ถูกต้อง — ${parsed.error}`);
    } else if (!Array.isArray(parsed.value)) {
      json = parsed.value;
      add('fail', 'เนื้อหาต้องเป็น JSON array ของ statement');
    } else {
      json = parsed.value;
      const appStatements = json.filter(
        (s) => arr(s?.relation).includes(HANDLE_ALL_URLS) && s.target?.namespace === 'android_app',
      );
      for (const s of appStatements.filter((s) => arr(s.target.sha256_cert_fingerprints).length === 0)) {
        add('fail', `"${s.target.package_name}" ไม่มี sha256_cert_fingerprints`);
      }
      targets = appStatements.flatMap((s) =>
        arr(s.target.sha256_cert_fingerprints).map((sha256) => ({ packageName: s.target.package_name, sha256 })),
      );
      for (const t of targets.filter((t) => !SHA256_RE.test(t.sha256))) {
        add('warn', `Fingerprint ของ "${t.packageName}" ไม่อยู่ในรูปแบบ AA:BB:... (32 bytes)`);
      }
      if (targets.length) add('pass', `พบ ${targets.length} app/fingerprint ที่ใช้ handle_all_urls`);
      else add('fail', 'ไม่มี statement "handle_all_urls" สำหรับ android_app');
    }
  }
  return report(res, findings, { json, summary: targets && { targets } });
}

function analyzeGoogle(res, originTargets) {
  const { findings, add } = collector();
  if (res.error) {
    add('fail', `เชื่อมต่อ Google API ไม่ได้ — ${res.error}`);
    return report(res, findings);
  }
  const parsed = parseJson(res.text);
  if (!parsed.ok) {
    add('fail', `Google API ตอบ HTTP ${res.status} ที่ไม่ใช่ JSON`);
    return report(res, findings);
  }
  const json = parsed.value;
  const debug = json.debugString?.trim() || undefined;

  if (res.status !== 200) {
    add('fail', `Google API ตอบ HTTP ${res.status}: ${json.error?.message ?? res.statusText}`);
    return report(res, findings, { json, summary: { targets: [], debug } });
  }
  if (arr(json.errorCode).length) {
    add('fail', `Google ดึงไฟล์ไม่สำเร็จ: ${json.errorCode.join(', ')}`);
  }

  const targets = arr(json.statements)
    .filter((s) => s.relation === HANDLE_ALL_URLS && s.target?.androidApp)
    .map((s) => ({
      packageName: s.target.androidApp.packageName,
      sha256: s.target.androidApp.certificate?.sha256Fingerprint ?? '',
    }));

  if (targets.length === 0) {
    if (!arr(json.errorCode).length) add('fail', 'Google ไม่พบ statement "handle_all_urls" ของโดเมนนี้');
  } else {
    add('pass', `Google เห็น ${targets.length} app/fingerprint แล้ว`);
    if (originTargets) {
      const googleKeys = new Set(targets.map(targetKey));
      const originKeys = new Set(originTargets.map(targetKey));
      const missing = originTargets.filter((t) => !googleKeys.has(targetKey(t)));
      const stale = targets.filter((t) => !originKeys.has(targetKey(t)));
      for (const t of missing) add('warn', `มีในไฟล์บนเว็บแต่ Google ยังไม่เห็น: ${t.packageName}`);
      for (const t of stale) add('warn', `Google ยังเห็นรายการที่ไม่มีในไฟล์บนเว็บแล้ว: ${t.packageName}`);
      if (!missing.length && !stale.length) add('pass', 'ตรงกับไฟล์บนเว็บแล้ว (propagate เรียบร้อย)');
    }
  }

  const maxAge = Math.round(parseFloat(json.maxAge));
  if (Number.isFinite(maxAge)) add('info', `Google แคชผลนี้ไว้ราว ${formatDuration(maxAge)}`);
  return report(res, findings, { json, summary: { targets, debug } });
}

// ---------- HTTP ----------

export async function handleCheck(searchParams) {
  const domain = parseDomain(searchParams.get('domain'));
  if (!domain) return [400, { error: 'โดเมนไม่ถูกต้อง ลองใส่แบบ example.com' }];

  const googleUrl = new URL('https://digitalassetlinks.googleapis.com/v1/statements:list');
  googleUrl.searchParams.set('source.web.site', `https://${domain}`);
  googleUrl.searchParams.set('relation', HANDLE_ALL_URLS);

  const [aasa, cdn, assetlinks, google] = await Promise.all(
    [
      `https://${domain}/.well-known/apple-app-site-association`,
      `https://app-site-association.cdn-apple.com/a/v1/${domain}`,
      `https://${domain}/.well-known/assetlinks.json`,
      googleUrl.href,
    ].map(fetchRaw),
  );

  const aasaReport = analyzeAasaOrigin(aasa);
  const assetlinksReport = analyzeAssetlinksOrigin(assetlinks);
  return [
    200,
    {
      domain,
      checkedAt: new Date().toISOString(),
      apple: { origin: aasaReport, cdn: analyzeAppleCdn(cdn, aasaReport.response.json) },
      android: { origin: assetlinksReport, google: analyzeGoogle(google, assetlinksReport.summary?.targets) },
    },
  ];
}
