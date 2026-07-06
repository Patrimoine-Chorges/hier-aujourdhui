const params = new URLSearchParams(window.location.search);
const photoNumber = params.get('photo') || '1';

function getAppBaseUrl() {
  const path = window.location.pathname;
  if (path.endsWith('/')) return window.location.origin + path;
  const lastPart = path.split('/').pop() || '';
  if (lastPart.includes('.')) {
    return window.location.origin + path.substring(0, path.lastIndexOf('/') + 1);
  }
  return window.location.origin + path + '/';
}

const APP_BASE = getAppBaseUrl();
function assetUrl(relativePath) { return new URL(relativePath, APP_BASE).href; }

const camera = document.getElementById('camera');
const oldPhoto = document.getElementById('oldPhoto');
const opacitySlider = document.getElementById('opacitySlider');
const placeTitle = document.getElementById('placeTitle');
const placePrecision = document.getElementById('placePrecision');
const placeDate = document.getElementById('placeDate');
const pastLabel = document.getElementById('pastLabel');
const startBtn = document.getElementById('startBtn');
const welcome = document.getElementById('welcome');
const resetBtn = document.getElementById('resetBtn');
const hideBtn = document.getElementById('hideBtn');
const errorBox = document.getElementById('errorBox');

let state = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.55 };
let pointers = new Map();
let startState = { ...state };
let startDistance = 0;
let startAngle = 0;
let startCenter = { x: 0, y: 0 };

function showError(message) { errorBox.textContent = message; errorBox.style.display = 'block'; }
function hideError() { errorBox.style.display = 'none'; }

function applyTransform() {
  oldPhoto.style.opacity = state.opacity;
  oldPhoto.style.transform =
    `translate(calc(-50% + ${state.x}px), calc(-50% + ${state.y}px)) ` +
    `scale(${state.scale}) rotate(${state.rotation}deg)`;
}

function distance(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function angle(a, b) { return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI; }
function center(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

async function loadView() {
  try {
    const response = await fetch(assetUrl('vues.json'), { cache: 'no-store' });
    const views = await response.json();
    const view = views[photoNumber] || views['1'];

    placeTitle.textContent = view.titre || `Vue ${photoNumber}`;
    placePrecision.textContent = view.precision || '';
    placeDate.textContent = view.date || 'Autrefois';
    pastLabel.textContent = 'Autrefois';

    const imageFile = view.image || `${photoNumber}.png`;
    oldPhoto.src = assetUrl(`images/${imageFile}`);
  } catch (error) {
    placeTitle.textContent = `Vue ${photoNumber}`;
    placePrecision.textContent = '';
    placeDate.textContent = 'Autrefois';
    pastLabel.textContent = 'Autrefois';
    oldPhoto.src = assetUrl(`images/${photoNumber}.png`);
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    camera.srcObject = stream;
    welcome.classList.add('hidden');
  } catch (error) {
    showError('Impossible d’ouvrir la caméra. Autorisez la caméra dans les réglages du navigateur.');
  }
}

oldPhoto.addEventListener('pointerdown', (event) => {
  oldPhoto.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, event);
  startState = { ...state };
  const pts = [...pointers.values()];
  if (pts.length === 1) startCenter = { x: pts[0].clientX, y: pts[0].clientY };
  if (pts.length === 2) {
    startDistance = distance(pts[0], pts[1]);
    startAngle = angle(pts[0], pts[1]);
    startCenter = center(pts[0], pts[1]);
  }
});

oldPhoto.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, event);
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    state.x = startState.x + (pts[0].clientX - startCenter.x);
    state.y = startState.y + (pts[0].clientY - startCenter.y);
  }
  if (pts.length >= 2) {
    const newDistance = distance(pts[0], pts[1]);
    const newAngle = angle(pts[0], pts[1]);
    const newCenter = center(pts[0], pts[1]);
    state.scale = Math.max(0.2, Math.min(6, startState.scale * (newDistance / startDistance)));
    state.rotation = startState.rotation + (newAngle - startAngle);
    state.x = startState.x + (newCenter.x - startCenter.x);
    state.y = startState.y + (newCenter.y - startCenter.y);
  }
  applyTransform();
});

['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
  oldPhoto.addEventListener(eventName, (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      startState = { ...state };
      startCenter = { x: remaining.clientX, y: remaining.clientY };
    }
  });
});

opacitySlider.addEventListener('input', (event) => {
  state.opacity = Number(event.target.value);
  applyTransform();
});

resetBtn.addEventListener('click', () => {
  state = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.55 };
  opacitySlider.value = state.opacity;
  oldPhoto.classList.remove('hidden-photo');
  hideBtn.textContent = '◉ Masquer';
  applyTransform();
});

hideBtn.addEventListener('click', () => {
  oldPhoto.classList.toggle('hidden-photo');
  hideBtn.textContent = oldPhoto.classList.contains('hidden-photo') ? '◉ Afficher' : '◉ Masquer';
});

/* === V6 — GPS + aide d’alignement + message immersif === */

const POINTS_GPS = {
  "1": {
    nom: "Grande Rue",
    lat: 44.54790,
    lon: 6.27790,
    rayon: 15
  }
};

const gpsBox = document.createElement("div");
gpsBox.id = "gpsBox";
document.body.appendChild(gpsBox);

function distanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showGpsMessage(text, ok = false) {
  gpsBox.textContent = text;
  gpsBox.className = ok ? "ok" : "";
}

function startGpsCheck() {
  const point = POINTS_GPS[photoNumber];

  if (!point || !navigator.geolocation) {
    showGpsMessage("GPS indisponible");
    return;
  }

  navigator.geolocation.watchPosition(
    pos => {
      const d = distanceMetres(
        pos.coords.latitude,
        pos.coords.longitude,
        point.lat,
        point.lon
      );

      if (d <= point.rayon) {
        showGpsMessage("✓ Position correcte", true);
        showImmersionMessage();
      } else {
        showGpsMessage(`Vous êtes à ${Math.round(d)} m du point de vue`);
      }
    },
    () => {
      showGpsMessage("Autorisez la localisation pour vous guider");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }
  );
}

let immersionShown = false;

function showImmersionMessage() {
  if (immersionShown) return;
  immersionShown = true;

  const msg = document.createElement("div");
  msg.id = "immersionMsg";
  msg.textContent = "Vous êtes au point de vue du photographe.";
  document.body.appendChild(msg);

  setTimeout(() => {
    msg.classList.add("visible");
  }, 200);

  setTimeout(() => {
    msg.classList.remove("visible");
  }, 4200);
}

/* Lance le GPS après clic sur Commencer */
const oldStartBtn = document.getElementById("startBtn");

if (oldStartBtn) {
  oldStartBtn.addEventListener("click", () => {
    setTimeout(startGpsCheck, 1200);
  });
}

startBtn.addEventListener('click', startCamera);
oldPhoto.addEventListener('load', hideError);
oldPhoto.addEventListener('error', () => { showError(`Image introuvable : ${oldPhoto.src}`); });

loadView().then(applyTransform);
