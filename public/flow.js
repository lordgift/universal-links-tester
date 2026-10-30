// แอนิเมชันอธิบายว่าอุปกรณ์ตรวจ Universal Links / App Links อย่างไร และ request วิ่งไปที่ไหนบ้าง

const section = document.querySelector('.flow');
const svg = section.querySelector('.flow-stage');
const packet = svg.querySelector('.packet');
const packetLabel = svg.querySelector('.packet-label');
const playButton = section.querySelector('[data-action="play"]');
const stepsList = section.querySelector('#flow-steps');
const domainInput = document.querySelector('#domain');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const DWELL_MS = 2600;
const PHASES = { install: 'ตอนติดตั้งหรืออัปเดตแอป', tap: 'ตอนผู้ใช้แตะลิงก์' };

/** เส้นทางของ packet เป็นจุดบน viewBox ของ SVG, label คือจุดกึ่งกลางของป้ายข้อความ */
const ROUTES = {
  sysToRelay: { points: [[165, 120], [300, 120]], wires: ['sys-relay'], label: [232, 42] },
  relayToOrigin: { points: [[540, 120], [620, 120]], wires: ['relay-origin'], label: [580, 42] },
  originToRelay: { points: [[620, 120], [540, 120]], wires: ['relay-origin'], label: [580, 42] },
  relayToSys: { points: [[300, 120], [165, 120]], wires: ['sys-relay'], label: [232, 42] },
  tapToSys: { points: [[150, 40], [150, 95]], wires: [] },
  sysToApp: { points: [[90, 145], [73, 220]], wires: [] },
  sysToWeb: {
    points: [[120, 145], [137, 220], [137, 242], [165, 242], [710, 242], [710, 152]],
    wires: ['browser-origin'],
    label: [437, 222],
  },
};

const PLATFORMS = {
  ios: {
    device: 'iPhone',
    system: 'swcd',
    browser: 'Safari',
    relayTitle: 'Apple CDN',
    relaySub: 'app-site-association.cdn-apple.com',
    rulesTag: 'เก็บกฎไว้แล้ว',
    steps: [
      {
        phase: 'install',
        focus: ['device', 'system'],
        title: 'ติดตั้งหรืออัปเดตแอป',
        text: (d) => `iOS อ่าน Associated Domains ของแอป (applinks:${d}) แล้วเริ่มขอไฟล์ apple-app-site-association ของโดเมนนี้`,
      },
      {
        phase: 'install',
        route: 'sysToRelay',
        kind: 'req',
        label: (d) => `GET /a/v1/${d}`,
        focus: ['system', 'relay'],
        title: 'ขอไฟล์จาก Apple CDN',
        text: () => 'swcd ไม่ได้ไปที่เว็บของคุณตรงๆ แต่ขอไฟล์จาก CDN ของ Apple',
      },
      {
        phase: 'install',
        route: 'relayToOrigin',
        kind: 'req',
        label: () => 'GET /.well-known/apple-app-site-association',
        focus: ['relay', 'origin'],
        title: 'CDN ดึงไฟล์จากเว็บของคุณ',
        text: () => 'ถ้า CDN ยังไม่มีแคชหรือแคชหมดอายุ จะดึงไฟล์จากเว็บต้นทาง ต้องได้ HTTP 200 ทันที ห้าม redirect',
      },
      {
        phase: 'install',
        route: 'originToRelay',
        kind: 'res',
        label: () => '200 · application/json',
        focus: ['origin', 'relay'],
        reveals: 'cache',
        title: 'CDN เก็บแคชไว้',
        text: () => 'Apple CDN แคชไฟล์ไว้ระยะหนึ่ง ถ้าแก้ไฟล์บนเว็บ อุปกรณ์จะยังได้เวอร์ชันเก่าจนกว่าแคชหมดอายุ',
      },
      {
        phase: 'install',
        route: 'relayToSys',
        kind: 'res',
        label: () => 'AASA JSON',
        focus: ['relay', 'system'],
        reveals: 'rules',
        title: 'ส่งไฟล์ให้อุปกรณ์',
        text: () => 'iOS เก็บกฎ paths / components ไว้ในเครื่อง และจะขอไฟล์ใหม่เป็นระยะ',
      },
      {
        phase: 'tap',
        route: 'tapToSys',
        kind: 'local',
        focus: ['system'],
        title: 'ผู้ใช้แตะลิงก์',
        text: (d) => `แตะ https://${d}/product/42 ใน Messages, Mail หรือ Notes แล้ว iOS เทียบ path กับกฎที่เก็บไว้ในเครื่อง ไม่มี request ออกไปไหนเลย (URL ที่พิมพ์เองในแถบที่อยู่ของ Safari จะไม่เปิดแอป)`,
      },
      {
        phase: 'tap',
        route: 'sysToApp',
        kind: 'local',
        focus: ['system', 'app'],
        title: 'ตรงกฎ → เปิดแอป',
        text: () => 'แอปได้รับ URL ผ่าน NSUserActivity (application(_:continue:) หรือ onOpenURL) แล้วพาไปหน้าที่ตรงกัน',
      },
      {
        phase: 'tap',
        route: 'sysToWeb',
        kind: 'req',
        label: () => 'GET /product/42',
        focus: ['browser', 'origin'],
        title: 'ไม่ตรงกฎหรือไม่มีแอป → เปิดเว็บ',
        text: () => 'iOS เปิดลิงก์ใน Safari เป็นหน้าเว็บปกติ เว็บของคุณจึงควรมีหน้านี้รองรับด้วย',
      },
    ],
  },
  android: {
    device: 'Android',
    system: 'domain verifier',
    browser: 'Chrome',
    relayTitle: 'Google Digital Asset Links',
    relaySub: 'digitalassetlinks.googleapis.com',
    rulesTag: 'verified ✓',
    steps: [
      {
        phase: 'install',
        focus: ['device', 'system'],
        title: 'ติดตั้งแอป',
        text: (d) => `Android อ่าน intent-filter ที่มี android:autoVerify="true" และ host ${d} แล้วเริ่มตรวจโดเมน`,
      },
      {
        phase: 'install',
        route: 'sysToRelay',
        kind: 'req',
        label: (d) => `statements:list?source.web.site=https://${d}`,
        focus: ['system', 'relay'],
        title: 'ถาม Google Digital Asset Links',
        text: () => 'บน Android 12 ขึ้นไป ตัวตรวจโดเมนใน Google Play services ถาม API ของ Google แทนการไปที่เว็บตรงๆ (Android รุ่นเก่ากว่าดึงไฟล์จากเว็บเอง)',
      },
      {
        phase: 'install',
        route: 'relayToOrigin',
        kind: 'req',
        label: () => 'GET /.well-known/assetlinks.json',
        focus: ['relay', 'origin'],
        title: 'Google ดึงไฟล์จากเว็บของคุณ',
        text: () => 'ต้องได้ HTTP 200 พร้อม Content-Type: application/json และห้าม redirect',
      },
      {
        phase: 'install',
        route: 'originToRelay',
        kind: 'res',
        label: () => '200 · application/json',
        focus: ['origin', 'relay'],
        reveals: 'cache',
        title: 'Google เก็บแคชไว้',
        text: () => 'Google แคชผลไว้ตาม maxAge ถ้าแก้ไฟล์บนเว็บ อาจต้องรอแคชหมดอายุก่อน',
      },
      {
        phase: 'install',
        route: 'relayToSys',
        kind: 'res',
        label: () => 'statements',
        focus: ['relay', 'system'],
        reveals: 'rules',
        title: 'เทียบ package และ fingerprint',
        text: () => 'เครื่องเทียบ package_name และ SHA-256 ของ certificate ที่เซ็นแอปที่ติดตั้งอยู่ ถ้าตรงกัน โดเมนนี้จะถูกบันทึกว่า verified',
      },
      {
        phase: 'tap',
        route: 'tapToSys',
        kind: 'local',
        focus: ['system'],
        title: 'ผู้ใช้แตะลิงก์',
        text: (d) => `แตะ https://${d}/product/42 แล้ว Android ดูสถานะ verified ที่เก็บไว้ในเครื่อง ไม่ได้ถามเว็บหรือ Google ใหม่`,
      },
      {
        phase: 'tap',
        route: 'sysToApp',
        kind: 'local',
        focus: ['system', 'app'],
        title: 'verified → เปิดแอปทันที',
        text: () => 'แอปได้รับ Intent ACTION_VIEW พร้อม URL โดยไม่มีหน้าต่างให้เลือกแอป',
      },
      {
        phase: 'tap',
        route: 'sysToWeb',
        kind: 'req',
        label: () => 'GET /product/42',
        focus: ['browser', 'origin'],
        title: 'ไม่ verified หรือไม่มีแอป → เปิดเว็บ',
        text: () => 'Android 12 ขึ้นไปเปิดลิงก์ในเบราว์เซอร์ทันที (รุ่นเก่ากว่าอาจขึ้นหน้าต่างให้เลือกแอป)',
      },
    ],
  },
};

const state = { platform: 'ios', index: 0, playing: false, frame: 0, timer: 0 };

function currentDomain() {
  const raw = domainInput.value.trim();
  if (!raw) return 'example.com';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || 'example.com';
  } catch {
    return 'example.com';
  }
}

function setText(key, value) {
  for (const node of svg.querySelectorAll(`[data-text="${key}"]`)) node.textContent = value;
}

/** ปรับขนาดพื้นหลังของป้ายข้อความให้พอดีกับตัวอักษร และไม่ล้นขอบ SVG */
function fitLabel(group, [cx, cy], padX = 10) {
  const text = group.querySelector('text');
  const rect = group.querySelector('rect');
  text.setAttribute('x', 0);
  text.setAttribute('y', 0);
  const box = text.getBBox();
  const width = box.width + padX * 2;
  const left = Math.min(Math.max(cx - width / 2, 8), 812 - width);
  text.setAttribute('x', left + padX);
  text.setAttribute('y', cy + 4);
  rect.setAttribute('x', left);
  rect.setAttribute('y', cy - 11);
  rect.setAttribute('width', width);
  rect.setAttribute('height', 22);
}

function fitChip() {
  const chip = svg.querySelector('.chip');
  const box = chip.querySelector('text').getBBox();
  chip.querySelector('rect').setAttribute('width', box.width + 28);
}

function renderStaticText() {
  const platform = PLATFORMS[state.platform];
  const domain = currentDomain();
  for (const key of ['device', 'system', 'browser', 'relayTitle', 'relaySub', 'rulesTag']) {
    setText(key, platform[key]);
  }
  setText('domain', domain);
  setText('link', `https://${domain}/product/42`);
  fitChip();
}

function renderStepList() {
  const steps = PLATFORMS[state.platform].steps;
  const groups = Object.entries(PHASES).map(([phase, name]) => {
    const wrap = document.createElement('div');
    wrap.className = 'flow-group';
    const heading = document.createElement('p');
    heading.className = 'flow-group-title';
    heading.textContent = name;
    const list = document.createElement('ol');
    steps.forEach((step, i) => {
      if (step.phase !== phase) return;
      if (!list.childElementCount) list.start = i + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = i;
      button.textContent = step.title;
      const item = document.createElement('li');
      item.append(button);
      list.append(item);
    });
    wrap.append(heading, list);
    return wrap;
  });
  stepsList.replaceChildren(...groups);
}

function pointAt(points, t) {
  const segments = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  let remaining = t * segments.reduce((a, b) => a + b, 0);
  for (let i = 0; i < segments.length; i++) {
    if (remaining <= segments[i] || i === segments.length - 1) {
      const k = segments[i] ? Math.min(remaining / segments[i], 1) : 1;
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k];
    }
    remaining -= segments[i];
  }
  return points.at(-1);
}

function routeLength(points) {
  return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function stopTimers() {
  cancelAnimationFrame(state.frame);
  clearTimeout(state.timer);
}

function updatePlayButton() {
  const atEnd = state.index === PLATFORMS[state.platform].steps.length - 1;
  playButton.textContent = state.playing ? '❚❚ หยุด' : atEnd ? '↺ เล่นอีกครั้ง' : '▶ เล่น';
}

/** จอแคบที่ภาพล้นกรอบ: เลื่อนกรอบให้เห็นเส้นทางของขั้นปัจจุบัน */
function followRoute(route) {
  const wrap = svg.parentElement;
  if (wrap.scrollWidth <= wrap.clientWidth) return;
  const xs = (route?.points ?? [[105, 0]]).map(([x]) => x);
  const center = ((Math.min(...xs) + Math.max(...xs)) / 2 / 820) * svg.clientWidth;
  wrap.scrollTo({ left: center - wrap.clientWidth / 2, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function showStep(index) {
  stopTimers();
  const steps = PLATFORMS[state.platform].steps;
  const step = steps[index];
  const route = ROUTES[step.route];
  const domain = currentDomain();
  state.index = index;

  section.querySelector('#flow-phase').textContent = `${index + 1}/${steps.length} · ${PHASES[step.phase]}`;
  section.querySelector('#flow-step-title').textContent = step.title;
  section.querySelector('#flow-step-text').textContent = step.text(domain);

  for (const button of stepsList.querySelectorAll('button')) {
    const i = Number(button.dataset.index);
    button.classList.toggle('is-current', i === index);
    button.classList.toggle('is-done', i < index);
  }

  for (const node of svg.querySelectorAll('[data-node]')) {
    node.classList.toggle('is-focus', step.focus.includes(node.dataset.node));
    node.classList.remove('is-pulse');
  }
  for (const wire of svg.querySelectorAll('[data-wire]')) {
    wire.classList.toggle('is-active', route?.wires.includes(wire.dataset.wire) ?? false);
  }
  const revealed = new Set(steps.slice(0, index + 1).map((s) => s.reveals).filter(Boolean));
  for (const tag of svg.querySelectorAll('[data-tag]')) {
    const name = tag.dataset.tag;
    tag.classList.toggle('is-visible', name === 'chip' ? step.phase === 'tap' : revealed.has(name));
  }

  packet.setAttribute('class', `packet packet-${step.kind ?? 'req'}`);
  packet.toggleAttribute('hidden', !route);
  packetLabel.toggleAttribute('hidden', !(route && step.label));
  if (!packetLabel.hasAttribute('hidden')) {
    packetLabel.querySelector('text').textContent = step.label(domain);
    packetLabel.setAttribute('class', `packet-label packet-label-${step.kind}`);
    fitLabel(packetLabel, route.label);
  }

  updatePlayButton();
  followRoute(route);

  const finish = () => {
    if (step.route === 'tapToSys') svg.querySelector('[data-node="system"]').classList.add('is-pulse');
    if (!state.playing) return;
    state.timer = setTimeout(() => {
      if (state.index < steps.length - 1) showStep(state.index + 1);
      else {
        state.playing = false;
        updatePlayButton();
      }
    }, DWELL_MS);
  };

  if (!route) return finish();

  const place = ([x, y]) => {
    packet.setAttribute('cx', x);
    packet.setAttribute('cy', y);
  };
  if (reducedMotion.matches) {
    place(route.points.at(-1));
    return finish();
  }

  const duration = Math.min(Math.max(routeLength(route.points) * 4, 700), 1800);
  const started = performance.now();
  const tick = (now) => {
    const t = Math.min((now - started) / duration, 1);
    place(pointAt(route.points, ease(t)));
    if (t < 1) state.frame = requestAnimationFrame(tick);
    else finish();
  };
  place(route.points[0]);
  state.frame = requestAnimationFrame(tick);
}

function play() {
  state.playing = true;
  const last = PLATFORMS[state.platform].steps.length - 1;
  showStep(state.index === last ? 0 : state.index);
}

function pause() {
  state.playing = false;
  stopTimers();
  showStep(state.index);
}

function setPlatform(platform) {
  state.platform = platform;
  for (const tab of section.querySelectorAll('[data-platform]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.platform === platform));
  }
  renderStaticText();
  renderStepList();
  showStep(0);
}

playButton.addEventListener('click', () => (state.playing ? pause() : play()));

section.querySelector('[data-action="prev"]').addEventListener('click', () => {
  state.playing = false;
  showStep(Math.max(state.index - 1, 0));
});

section.querySelector('[data-action="next"]').addEventListener('click', () => {
  state.playing = false;
  showStep(Math.min(state.index + 1, PLATFORMS[state.platform].steps.length - 1));
});

stepsList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-index]');
  if (!button) return;
  state.playing = false;
  showStep(Number(button.dataset.index));
});

section.querySelector('.flow-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-platform]');
  if (tab && tab.dataset.platform !== state.platform) {
    const wasPlaying = state.playing;
    setPlatform(tab.dataset.platform);
    if (wasPlaying) play();
  }
});

// อัปเดตชื่อโดเมนในภาพตามที่ผู้ใช้พิมพ์ โดยไม่เริ่มแอนิเมชันใหม่
domainInput.addEventListener('input', () => {
  renderStaticText();
  const step = PLATFORMS[state.platform].steps[state.index];
  section.querySelector('#flow-step-text').textContent = step.text(currentDomain());
  if (!packetLabel.hasAttribute('hidden')) {
    packetLabel.querySelector('text').textContent = step.label(currentDomain());
    fitLabel(packetLabel, ROUTES[step.route].label);
  }
});

setPlatform('ios');

// เล่นอัตโนมัติครั้งแรกที่เลื่อนมาเห็น
if (!reducedMotion.matches) {
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      if (!state.playing && state.index === 0) play();
    }
  }, { threshold: 0.5 });
  observer.observe(svg);
}
