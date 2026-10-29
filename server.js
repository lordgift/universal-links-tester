import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const FETCH_TIMEOUT_MS = 10_000;
const AASA_MAX_BYTES = 128 * 1024;
const RAW_PREVIEW_CHARS = 4000;
const USER_AGENT = 'universal-links-tester/2.0';
const HANDLE_ALL_URLS = 'delegate_permission/common.handle_all_urls';

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const APP_ID_RE = /^[A-Z0-9]{10}\.\S+$/;
const SHA256_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------- helpers ----------

/** รับได้ทั้ง "example.com", "https://example.com/path?x=1" แล้วคืน { domain, initialPath } หรือ null */
function parseInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const url = new URL(hasScheme ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!HOSTNAME_RE.test(host)) return null;
    const fullPath = `${url.pathname}${url.search}${url.hash}`;
    const initialPath = fullPath && fullPath !== '/' ? fullPath : null;
    return { domain: host, initialPath };
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

const statusLabel = (res) => [res.status, res.statusText].filter(Boolean).join(' ');

function extractCacheInfo(headers) {
  if (!headers) return null;
  const cc = headers['cache-control'] ?? '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cc);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
  const age = Number.isFinite(Number(headers.age)) ? Number(headers.age) : 0;
  if (maxAge === null || !Number.isFinite(maxAge)) return null;
  const remaining = Math.max(maxAge - age, 0);
  const percentRemaining = maxAge > 0 ? Math.round((remaining / maxAge) * 100) : 0;
  return {
    maxAge,
    age,
    remaining,
    percentRemaining,
    maxAgeFormatted: formatDuration(maxAge),
    ageFormatted: formatDuration(age),
    remainingFormatted: formatDuration(remaining),
    etag: headers.etag ?? null,
    lastModified: headers['last-modified'] ?? null,
  };
}

function cacheNote(headers) {
  const info = extractCacheInfo(headers);
  if (!info) return null;
  return `CDN แคชผลนี้ไว้ ${info.maxAgeFormatted} (ผ่านไปแล้ว ${info.ageFormatted} · เหลือราว ${info.remainingFormatted})`;
}

function extractRedirectHost(res, currentDomain) {
  if (!res || res.status < 300 || res.status >= 400 || !res.headers?.location) return null;
  try {
    const loc = new URL(res.headers.location, res.url);
    const targetHost = loc.hostname.toLowerCase().replace(/\.$/, '');
    if (HOSTNAME_RE.test(targetHost) && targetHost !== currentDomain) {
      return targetHost;
    }
  } catch {
    // ignore invalid URL
  }
  return null;
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

function publicResponse(res, json) {
  const { text, ...rest } = res;
  if (text === undefined) return rest;
  return json !== undefined ? { ...rest, json } : { ...rest, preview: text.slice(0, RAW_PREVIEW_CHARS) };
}

function report(res, findings, { json, summary, meta } = {}) {
  return { status: worst(findings), findings, summary, meta, response: publicResponse(res, json) };
}

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
  add('pass', `HTTP 200 ภายใน ${res.ms} ms (${kb(res.bytes)})`);
  return true;
}

// ---------- iOS: apple-app-site-association ----------

function normalizeAasaDetails(details) {
  if (Array.isArray(details)) return details;
  if (details && typeof details === 'object') {
    // Legacy format where details is a map of { "TEAM.bundle": { paths: [...] } }
    return Object.entries(details).map(([appID, cfg]) => ({
      appID,
      ...(cfg && typeof cfg === 'object' ? cfg : {}),
    }));
  }
  return [];
}

function summarizeAasa(json) {
  const rawDetails = normalizeAasaDetails(json?.applinks?.details);
  const applinks = rawDetails.map((d) => {
    const appIDs = Array.isArray(d.appIDs) ? d.appIDs : d.appID ? [d.appID] : [];
    const hasComponents = Array.isArray(d.components);
    const hasPaths = Array.isArray(d.paths);
    const format = hasComponents ? 'components' : hasPaths ? 'paths' : '-';
    const rawRules = hasComponents ? d.components : hasPaths ? d.paths : [];
    return {
      appIDs,
      format,
      rules: rawRules.length,
      rulesList: rawRules.slice(0, 100),
    };
  });

  const allAppIDs = [...new Set(applinks.flatMap((d) => d.appIDs))];
  const teamIDs = [...new Set(allAppIDs.map((id) => id.split('.')[0]).filter((t) => /^[A-Z0-9]{10}$/.test(t)))];

  return {
    applinks,
    allAppIDs,
    teamIDs,
    webcredentials: arr(json?.webcredentials?.apps),
    appclips: arr(json?.appclips?.apps),
    substitutionVariables: json?.applinks?.substitutionVariables ?? null,
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
  if (Array.isArray(json.applinks.apps) && json.applinks.apps.length > 0) {
    add('warn', 'applinks.apps ควรเป็น array ว่าง [] ตามสเปกของ Apple');
  }
  const { applinks, allAppIDs } = summarizeAasa(json);
  if (allAppIDs.length === 0) {
    add('fail', 'applinks.details ว่าง หรือไม่มี appID / appIDs');
    return;
  }
  for (const id of allAppIDs.filter((id) => !APP_ID_RE.test(id))) {
    add('warn', `App ID "${id}" ไม่อยู่ในรูปแบบ <TeamID 10 ตัว>.<Bundle ID>`);
  }
  add('pass', `applinks ครอบคลุม ${allAppIDs.length} App ID (${applinks.length} กลุ่มกฎ)`);
}

function analyzeAasaOrigin(res, domain) {
  const { findings, add } = collector();
  let json;
  const redirectHost = extractRedirectHost(res, domain);
  if (checkHttp(res, add, 'Apple ไม่ follow redirect ไฟล์ต้องอยู่ที่ URL นี้ตรงๆ')) {
    const type = res.headers['content-type'] ?? '';
    if (!type.includes('application/json') && !type.includes('application/pkcs7-mime')) {
      add('warn', `Content-Type เป็น "${type || 'ไม่ระบุ'}" ควรเป็น application/json`);
    } else {
      add('pass', `Content-Type: ${type.split(';')[0].trim()}`);
    }
    if (res.bytes > AASA_MAX_BYTES) {
      add('fail', `ขนาดไฟล์ ${kb(res.bytes)} เกินลิมิต 128 KB ที่ Apple กำหนด`);
    }
    const parsed = parseJson(res.text);
    if (parsed.ok) {
      json = parsed.value;
      validateAasa(json, add);
    } else {
      add('fail', `JSON ไม่ถูกต้อง — ${parsed.error}`);
    }
  }
  return report(res, findings, {
    json,
    summary: json && summarizeAasa(json),
    meta: { redirectHost, cache: extractCacheInfo(res.headers) },
  });
}

function analyzeAppleCdn(res, originReport) {
  const { findings, add } = collector();
  const originJson = originReport.response.json;
  let json;
  let syncState = 'unavailable';
  let syncLabel = 'ไม่พบข้อมูลบน Apple CDN';
  const appleFailureReason = res.headers?.['apple-failure-reason'] ?? null;
  const cache = !res.error ? extractCacheInfo(res.headers) : null;

  if (res.error) {
    add('fail', `เชื่อมต่อ Apple CDN ไม่ได้ — ${res.error}`);
  } else if (res.status === 200) {
    add('pass', `Apple CDN ตอบ HTTP 200 ภายใน ${res.ms} ms`);
    const parsed = parseJson(res.text);
    if (parsed.ok) {
      json = parsed.value;
      if (originJson === undefined) {
        syncState = 'cdn_only';
        syncLabel = 'มีแคชบน CDN (แต่ดึงต้นทางไม่ได้)';
        add('warn', 'CDN ยังมีไฟล์แคชอยู่ แต่ดึงไฟล์จากเว็บต้นทางไม่ได้ จึงเทียบเนื้อหาไม่ได้');
      } else if (isDeepStrictEqual(json, originJson)) {
        syncState = 'synced';
        syncLabel = 'Propagated · ข้อมูลตรงกับต้นทาง 100%';
        add('pass', 'เนื้อหาบน Apple CDN ตรงกับไฟล์บนเว็บต้นทางทุกประการ (Propagate เรียบร้อย)');
      } else {
        syncState = 'out_of_sync';
        syncLabel = 'Out of Sync · CDN ยังแคชเวอร์ชันเก่า';
        add('warn', 'เนื้อหายังไม่ตรงกับไฟล์บนเว็บ — Apple CDN ยังแคชเวอร์ชันเก่าอยู่ ต้องรอให้แคชหมดอายุแล้วดึงใหม่');
      }
    } else {
      add('fail', `JSON จาก CDN ไม่ถูกต้อง — ${parsed.error}`);
    }
  } else {
    if (originJson !== undefined) {
      syncState = 'origin_only';
      syncLabel = 'Not Propagated · Apple CDN ดึงไฟล์ไม่สำเร็จ';
    }
    add('fail', `Apple CDN ตอบ HTTP ${statusLabel(res)}`);
    if (appleFailureReason) add('fail', `Apple-Failure-Reason: ${appleFailureReason}`);
  }

  const note = !res.error && cacheNote(res.headers);
  if (note) add('info', note);

  return report(res, findings, {
    json,
    summary: json && summarizeAasa(json),
    meta: {
      syncState,
      syncLabel,
      appleFailureReason,
      cache,
    },
  });
}

// ---------- Android: assetlinks.json ----------

const targetKey = (t) => `${t.packageName}|${String(t.sha256).toUpperCase()}`;

function analyzeAssetlinksOrigin(res, domain) {
  const { findings, add } = collector();
  let json;
  let targets;
  const redirectHost = extractRedirectHost(res, domain);
  if (checkHttp(res, add, 'Android ไม่ยอมรับ redirect ไฟล์ต้องอยู่ที่ URL นี้ตรงๆ')) {
    const type = res.headers['content-type'] ?? '';
    if (!type.includes('application/json')) {
      add('fail', `Content-Type เป็น "${type || 'ไม่ระบุ'}" ต้องเป็น application/json`);
    } else {
      add('pass', `Content-Type: ${type.split(';')[0].trim()}`);
    }
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
        arr(s.target.sha256_cert_fingerprints).map((sha256) => ({
          packageName: s.target.package_name,
          sha256: String(sha256).toUpperCase(),
        })),
      );
      for (const t of targets.filter((t) => !SHA256_RE.test(t.sha256))) {
        add('warn', `Fingerprint ของ "${t.packageName}" ไม่อยู่ในรูปแบบ AA:BB:... (32 bytes)`);
      }
      const uniquePackages = [...new Set(targets.map((t) => t.packageName))];
      if (targets.length) {
        add('pass', `พบ ${ uniquePackages.length } Package (${targets.length} SHA-256 fingerprint) ที่เปิดใช้ handle_all_urls`);
      } else {
        add('fail', 'ไม่มี statement "handle_all_urls" สำหรับ android_app');
      }
    }
  }
  return report(res, findings, {
    json,
    summary: targets && { targets, packageCount: new Set(targets.map((t) => t.packageName)).size },
    meta: { redirectHost, cache: extractCacheInfo(res.headers) },
  });
}

function analyzeGoogle(res, originTargets) {
  const { findings, add } = collector();
  let syncState = 'unavailable';
  let syncLabel = 'ไม่พบข้อมูลบน Google API';

  if (res.error) {
    add('fail', `เชื่อมต่อ Google API ไม่ได้ — ${res.error}`);
    return report(res, findings, { meta: { syncState, syncLabel } });
  }
  const parsed = parseJson(res.text);
  if (!parsed.ok) {
    add('fail', `Google API ตอบ HTTP ${res.status} ที่ไม่ใช่ JSON`);
    return report(res, findings, { meta: { syncState, syncLabel } });
  }
  const json = parsed.value;
  const debug = json.debugString?.trim() || undefined;
  const maxAgeSec = Math.round(parseFloat(json.maxAge));
  const cache = Number.isFinite(maxAgeSec)
    ? {
        maxAge: maxAgeSec,
        maxAgeFormatted: formatDuration(maxAgeSec),
      }
    : null;

  if (res.status !== 200) {
    add('fail', `Google API ตอบ HTTP ${res.status}: ${json.error?.message ?? res.statusText}`);
    return report(res, findings, { json, summary: { targets: [], debug }, meta: { syncState, syncLabel, cache } });
  }
  if (arr(json.errorCode).length) {
    add('fail', `Google ดึงไฟล์ไม่สำเร็จ: ${json.errorCode.join(', ')}`);
  }

  const targets = arr(json.statements)
    .filter((s) => s.relation === HANDLE_ALL_URLS && s.target?.androidApp)
    .map((s) => ({
      packageName: s.target.androidApp.packageName,
      sha256: String(s.target.androidApp.certificate?.sha256Fingerprint ?? '').toUpperCase(),
    }));

  let missing = [];
  let stale = [];

  if (targets.length === 0) {
    if (originTargets?.length) {
      syncState = 'origin_only';
      syncLabel = 'Not Propagated · Google ยังไม่อ่านหรืออ่านไม่สำเร็จ';
    }
    if (!arr(json.errorCode).length) add('fail', 'Google ไม่พบ statement "handle_all_urls" ของโดเมนนี้');
  } else {
    const uniquePackages = [...new Set(targets.map((t) => t.packageName))];
    add('pass', `Google เห็น ${uniquePackages.length} Package (${targets.length} fingerprint) แล้ว`);
    if (originTargets) {
      const googleKeys = new Set(targets.map(targetKey));
      const originKeys = new Set(originTargets.map(targetKey));
      missing = originTargets.filter((t) => !googleKeys.has(targetKey(t)));
      stale = targets.filter((t) => !originKeys.has(targetKey(t)));
      for (const t of missing) add('warn', `มีในไฟล์บนเว็บแต่ Google ยังไม่เห็น: ${t.packageName}`);
      for (const t of stale) add('warn', `Google ยังเห็นรายการที่ไม่มีในไฟล์บนเว็บแล้ว: ${t.packageName}`);
      if (!missing.length && !stale.length) {
        syncState = 'synced';
        syncLabel = 'Propagated · ข้อมูลตรงกับต้นทาง 100%';
        add('pass', 'รายการ Package & Fingerprint ตรงกับไฟล์บนเว็บทุกประการ (Propagate เรียบร้อย)');
      } else {
        syncState = 'out_of_sync';
        syncLabel = 'Out of Sync · ข้อมูลบน Google ยังไม่ตรงกับต้นทาง';
      }
    } else {
      syncState = 'cdn_only';
      syncLabel = 'มีแคชบน Google (แต่ดึงต้นทางไม่ได้)';
      add('warn', 'Google ยังมีข้อมูลแคชอยู่ แต่ดึงไฟล์จากเว็บต้นทางไม่ได้');
    }
  }

  if (cache) add('info', `Google กำหนด maxAge ของผลลัพธ์นี้ไว้ ${cache.maxAgeFormatted}`);
  return report(res, findings, {
    json,
    summary: { targets, packageCount: new Set(targets.map((t) => t.packageName)).size, debug, missing, stale },
    meta: { syncState, syncLabel, cache, errorCodes: arr(json.errorCode) },
  });
}

// ---------- HTTP ----------

async function handleCheck(searchParams) {
  const parsedInput = parseInput(searchParams.get('domain'));
  if (!parsedInput) return [400, { error: 'โดเมนไม่ถูกต้อง ลองใส่แบบ example.com หรือ https://www.example.com/path' }];

  const { domain, initialPath } = parsedInput;

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

  const aasaReport = analyzeAasaOrigin(aasa, domain);
  const cdnReport = analyzeAppleCdn(cdn, aasaReport);
  const assetlinksReport = analyzeAssetlinksOrigin(assetlinks, domain);
  const googleReport = analyzeGoogle(google, assetlinksReport.summary?.targets);

  const suggestedRedirectDomain =
    aasaReport.meta?.redirectHost || assetlinksReport.meta?.redirectHost || null;

  return [
    200,
    {
      domain,
      initialPath,
      suggestedRedirectDomain,
      checkedAt: new Date().toISOString(),
      apple: { origin: aasaReport, cdn: cdnReport },
      android: { origin: assetlinksReport, google: googleReport },
    },
  ];
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/api/check') {
      const [status, body] = await handleCheck(url.searchParams);
      return sendJson(res, status, body);
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}).listen(PORT, () => {
  console.log(`Universal Links Tester → http://localhost:${PORT}`);
});
