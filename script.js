const params = new URLSearchParams(window.location.search);
const photoNumber = params.get("photo") || "1";
const calibrationMode = params.get("calibration") === "1";

function getAppBaseUrl() {
  const path = window.location.pathname;
  if (path.endsWith("/")) return window.location.origin + path;
  const lastPart = path.split("/").pop() || "";
  if (lastPart.includes(".")) {
    return window.location.origin + path.substring(0, path.lastIndexOf("/") + 1);
  }
  return window.location.origin + path + "/";
}

const APP_BASE = getAppBaseUrl();
function assetUrl(relativePath) {
  return new URL(relativePath, APP_BASE).href;
}

const camera = document.getElementById("camera");
const oldPhoto = document.getElementById("oldPhoto");
const placeTitle = document.getElementById("placeTitle");
const placePrecision = document.getElementById("placePrecision");
const placeDate = document.getElementById("placeDate");
const startBtn = document.getElementById("startBtn");
const welcome = document.getElementById("welcome");
const resetBtn = document.getElementById("resetBtn");
const errorBox = document.getElementById("errorBox");
const comparisonSurface = document.getElementById("comparisonSurface");
const comparisonDivider = document.getElementById("comparisonDivider");
const adjustBtn = document.getElementById("adjustBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const guidanceBtn = document.getElementById("guidanceBtn");

// V10.1 — La photographie n’est accessible qu’à proximité du point de vue.
const PHOTO_TRIGGER_RADIUS_METRES = 20;
let photoAccessGranted = calibrationMode;

function setPhotoAccess(granted) {
  photoAccessGranted = Boolean(granted) || calibrationMode;
  document.body.classList.toggle("gps-photo-locked", !photoAccessGranted);
  if (!photoAccessGranted && typeof photoViewOpen !== "undefined" && photoViewOpen) {
    setPhotoView(false);
  }

  // Empêche également toute interaction invisible avec la comparaison.
  comparisonSurface.setAttribute("aria-hidden", photoAccessGranted ? "false" : "true");
}

// Hors mode calibration, la photo reste masquée jusqu’à une position GPS valide.
setPhotoAccess(calibrationMode);

let state = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, reveal: 50 };
let pointers = new Map();
let startState = { ...state };
let startDistance = 0;
let startAngle = 0;
let startCenter = { x: 0, y: 0 };

let activePoint = null;
let currentGps = null;
let currentOrientation = { azimut: null, pitch: null, roll: null };
let gpsWatchId = null;
let orientationListening = false;
let alignmentMessageShown = false;
let orientationAlignedNotified = false;
const AZIMUT_SMOOTHING_FACTOR = 0.18;
let smoothedAzimut = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function hideError() {
  errorBox.style.display = "none";
}

function applyTransform() {
  oldPhoto.style.opacity = state.opacity;
  oldPhoto.style.transform =
    `translate(calc(-50% + ${state.x}px), calc(-50% + ${state.y}px)) ` +
    `scale(${state.scale}) rotate(${state.rotation}deg)`;

  const reveal = Math.max(0, Math.min(100, Number(state.reveal)));
  oldPhoto.style.clipPath = `inset(0 ${100 - reveal}% 0 0)`;
  comparisonDivider.style.left = `${reveal}%`;

  if (photoViewOpen) {
    oldPhoto.style.opacity = "1";
    oldPhoto.style.clipPath = "none";
  }
}

function distance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function angle(a, b) {
  return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI;
}

function center(a, b) {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2
  };
}

function createGuidanceUI() {
  if (document.getElementById("guidanceBox")) return;

  const box = document.createElement("div");
  box.id = "guidanceBox";
  box.innerHTML = `
    <span id="guidanceIcon">📍</span>
    <span id="guidanceText">Initialisation du guidage…</span>
    <button id="closeGuidanceBtn" type="button" aria-label="Fermer le guidage GPS">Fermer</button>
  `;
  document.body.appendChild(box);

  const aligned = document.createElement("div");
  aligned.id = "alignedMessage";
  aligned.textContent = "Vous êtes au point de vue du photographe.";
  document.body.appendChild(aligned);
}

function setGuidance(text, status = "info", icon = "📍") {
  const box = document.getElementById("guidanceBox");
  const textEl = document.getElementById("guidanceText");
  const iconEl = document.getElementById("guidanceIcon");
  if (!box || !textEl || !iconEl) return;
  box.className = status;
  textEl.textContent = text;
  iconEl.textContent = icon;
}

function showAlignedMessage() {
  if (alignmentMessageShown) return;
  alignmentMessageShown = true;
  const msg = document.getElementById("alignedMessage");
  if (!msg) return;
  msg.classList.add("visible");
  setTimeout(() => msg.classList.remove("visible"), 1000);
}

function normalize360(value) {
  return ((value % 360) + 360) % 360;
}

function signedAngleDifference(current, target) {
  return ((target - current + 540) % 360) - 180;
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function evaluateGuidance() {
  if (calibrationMode || !activePoint) return;

  const targetGps = activePoint.gps;
  const targetOri = activePoint.orientation || {};
  const settings = activePoint.reglages || {};

  if (!targetGps || targetGps.lat == null || targetGps.lon == null) {
    setPhotoAccess(false);
    setGuidance("Ce point ne possède pas encore de position GPS.", "warning", "⚠");
    return;
  }

  if (!currentGps) {
    setPhotoAccess(false);
    setGuidance("Autorisez la localisation pour rejoindre le point de vue.", "info", "📍");
    return;
  }

  const metres = haversineMetres(
    currentGps.lat,
    currentGps.lon,
    targetGps.lat,
    targetGps.lon
  );

  // Le rayon d’affichage est volontairement fixé à 20 m, indépendamment
  // des anciens rayons éventuellement présents dans points.json.
  const isInsidePhotoRadius =
    Number.isFinite(metres) && metres <= PHOTO_TRIGGER_RADIUS_METRES;

  setPhotoAccess(isInsidePhotoRadius);

  if (!isInsidePhotoRadius) {
    alignmentMessageShown = false;
    orientationAlignedNotified = false;
    setGuidance(
      `Vous êtes à ${Math.round(metres)} m du point de vue. Approchez-vous à moins de ${PHOTO_TRIGGER_RADIUS_METRES} m pour afficher la photographie.`,
      "warning",
      "📍"
    );
    return;
  }

  if (targetOri.azimut == null) {
    setGuidance("Position correcte. Ajustez maintenant la photographie.", "ok", "✓");
    showAlignedMessage();
    return;
  }

  if (currentOrientation.azimut == null) {
    setGuidance("Position correcte. Autorisez la boussole pour être guidé.", "info", "🧭");
    return;
  }

  const azDiff = signedAngleDifference(
    currentOrientation.azimut,
    Number(targetOri.azimut)
  );
  // Une tolérance d’au moins ±15° évite de demander un alignement au degré près.
  const azTol = Math.max(15, Number(settings.toleranceAzimut || 15));
  const absAzDiff = Math.abs(azDiff);

  if (absAzDiff > azTol) {
    orientationAlignedNotified = false;
    const direction = azDiff > 0 ? "vers la droite" : "vers la gauche";
    const instruction = absAzDiff > 30
      ? `Tournez franchement ${direction}.`
      : `Tournez légèrement ${direction}.`;
    setGuidance(
      instruction,
      "warning",
      azDiff > 0 ? "→" : "←"
    );
    return;
  }

  if (targetOri.pitch != null && currentOrientation.pitch != null) {
    const pitchDiff = Number(targetOri.pitch) - currentOrientation.pitch;
    const pitchTol = Math.max(8, Number(settings.tolerancePitch || 8));

    if (Math.abs(pitchDiff) > pitchTol) {
      const action = pitchDiff > 0
        ? "Inclinez un peu plus le téléphone vers le haut."
        : "Inclinez un peu plus le téléphone vers le bas.";
      setGuidance(action, "warning", pitchDiff > 0 ? "↑" : "↓");
      return;
    }
  }

  if (targetOri.roll != null && currentOrientation.roll != null) {
    const rollDiff = Number(targetOri.roll) - currentOrientation.roll;
    const rollTol = Math.max(8, Number(settings.toleranceRoll || 8));

    if (Math.abs(rollDiff) > rollTol) {
      const action = rollDiff > 0
        ? "Inclinez légèrement le téléphone vers la droite."
        : "Inclinez légèrement le téléphone vers la gauche.";
      setGuidance(action, "warning", "↔");
      return;
    }
  }

  setGuidance("Orientation correcte. Vous êtes au point de vue.", "ok", "✓");
  showAlignedMessage();
  if (!orientationAlignedNotified) {
    orientationAlignedNotified = true;
    if (typeof navigator.vibrate === "function") navigator.vibrate(120);
  }
}

async function loadViewAndPoint() {
  try {
    const [viewsResponse, pointsResponse] = await Promise.all([
      fetch(assetUrl("vues.json"), { cache: "no-store" }),
      fetch(assetUrl("points.json"), { cache: "no-store" })
    ]);

    const views = await viewsResponse.json();
    const pointData = await pointsResponse.json();
    const view = views[photoNumber] || views["1"];
    activePoint =
      (pointData.points || []).find(point => String(point.id) === String(photoNumber)) ||
      null;

    placeTitle.textContent =
      activePoint?.titre || view.titre || `Vue ${photoNumber}`;
    placePrecision.textContent =
      activePoint?.precision || view.precision || "";
    placeDate.textContent =
      activePoint?.date || view.date || "Autrefois";

    const imageFile =
      activePoint?.image || view.image || `${photoNumber}.png`;
    oldPhoto.src = assetUrl(`images/${imageFile}`);
  } catch (error) {
    placeTitle.textContent = `Vue ${photoNumber}`;
    placePrecision.textContent = "";
    placeDate.textContent = "Autrefois";
    oldPhoto.src = assetUrl(`images/${photoNumber}.png`);
    activePoint = null;
  }
}

function startGpsGuidance() {
  if (calibrationMode) return;

  if (!navigator.geolocation) {
    setGuidance("La localisation GPS n’est pas disponible sur cet appareil.", "warning", "⚠");
    return;
  }

  if (gpsWatchId !== null) return;

  gpsWatchId = navigator.geolocation.watchPosition(
    position => {
      currentGps = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy
      };
      evaluateGuidance();
    },
    () => {
      currentGps = null;
      setPhotoAccess(false);
      setGuidance("Autorisez la localisation dans les réglages du navigateur.", "warning", "⚠");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1500,
      timeout: 12000
    }
  );
}

function handleOrientation(event) {
  let rawAzimut = null;

  if (typeof event.webkitCompassHeading === "number") {
    rawAzimut = normalize360(event.webkitCompassHeading);
  } else if (typeof event.alpha === "number") {
    rawAzimut = normalize360(360 - event.alpha);
  }

  if (rawAzimut !== null) {
    if (smoothedAzimut === null) {
      smoothedAzimut = rawAzimut;
    } else {
      // Lissage circulaire : évite le saut entre 359° et 0°.
      const delta = signedAngleDifference(smoothedAzimut, rawAzimut);
      smoothedAzimut = normalize360(smoothedAzimut + delta * AZIMUT_SMOOTHING_FACTOR);
    }
  }

  currentOrientation = {
    azimut: smoothedAzimut,
    pitch: typeof event.beta === "number" ? event.beta : null,
    roll: typeof event.gamma === "number" ? event.gamma : null
  };
  evaluateGuidance();
}

async function startOrientationGuidance() {
  if (calibrationMode || orientationListening) return;

  try {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        setGuidance("La boussole n’a pas été autorisée.", "info", "🧭");
        return;
      }
    }

    window.addEventListener("deviceorientation", handleOrientation, true);
    orientationListening = true;
  } catch (error) {
    setGuidance("La boussole n’est pas disponible sur cet appareil.", "info", "🧭");
  }
}

async function startCameraAndGuidance() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });

    camera.srcObject = stream;
    welcome.classList.add("hidden");

    if (!calibrationMode) {
      createGuidanceUI();
      await startOrientationGuidance();
      startGpsGuidance();
      evaluateGuidance();
    }
  } catch (error) {
    showError(
      "Impossible d’ouvrir la caméra. Autorisez la caméra dans les réglages du navigateur."
    );
  }
}

oldPhoto.addEventListener("pointerdown", event => {
  oldPhoto.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, event);
  startState = { ...state };

  const pts = [...pointers.values()];
  if (pts.length === 1) {
    startCenter = { x: pts[0].clientX, y: pts[0].clientY };
  }

  if (pts.length === 2) {
    startDistance = distance(pts[0], pts[1]);
    startAngle = angle(pts[0], pts[1]);
    startCenter = center(pts[0], pts[1]);
  }
});

oldPhoto.addEventListener("pointermove", event => {
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

    state.scale = Math.max(
      0.5,
      Math.min(3, startState.scale * (newDistance / Math.max(1, startDistance)))
    );
    state.rotation = startState.rotation + (newAngle - startAngle);
    state.x = startState.x + (newCenter.x - startCenter.x);
    state.y = startState.y + (newCenter.y - startCenter.y);
  }

  applyTransform();
});

["pointerup", "pointercancel", "pointerleave"].forEach(eventName => {
  oldPhoto.addEventListener(eventName, event => {
    pointers.delete(event.pointerId);

    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      startState = { ...state };
      startCenter = {
        x: remaining.clientX,
        y: remaining.clientY
      };
    }
  });
});

let comparisonMode = true;
let comparisonPointerId = null;
let photoViewOpen = false;

function setPhotoView(open) {
  photoViewOpen = Boolean(open) && photoAccessGranted;
  document.body.classList.toggle("photo-view", photoViewOpen);
  adjustBtn.classList.toggle("is-photo-view", photoViewOpen);
  adjustBtn.setAttribute(
    "aria-label",
    photoViewOpen
      ? "Revenir à la vue en réalité augmentée"
      : "Afficher la photographie ancienne en plein écran"
  );
  adjustBtn.title = photoViewOpen ? "Retour à la vue actuelle" : "Voir la photographie ancienne";
  applyTransform();
}

function updateRevealFromPointer(event) {
  const width = Math.max(1, window.innerWidth);
  state.reveal = Math.max(0, Math.min(100, (event.clientX / width) * 100));
  applyTransform();
}

comparisonSurface.addEventListener("pointerdown", event => {
  if (!comparisonMode) return;
  comparisonPointerId = event.pointerId;
  comparisonSurface.setPointerCapture(event.pointerId);
  updateRevealFromPointer(event);
});

comparisonSurface.addEventListener("pointermove", event => {
  if (!comparisonMode || event.pointerId !== comparisonPointerId) return;
  updateRevealFromPointer(event);
});

["pointerup", "pointercancel"].forEach(eventName => {
  comparisonSurface.addEventListener(eventName, event => {
    if (event.pointerId === comparisonPointerId) {
      comparisonPointerId = null;
    }
  });
});

adjustBtn.addEventListener("click", () => {
  setPhotoView(!photoViewOpen);
});

resetBtn.addEventListener("click", () => {
  state = {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    reveal: 50
  };

  setPhotoView(false);
  applyTransform();
});

startBtn.addEventListener("click", startCameraAndGuidance);
oldPhoto.addEventListener("load", hideError);
oldPhoto.addEventListener("error", () => {
  showError(`Image introuvable : ${oldPhoto.src}`);
});

loadViewAndPoint().then(() => { state.reveal = 50; applyTransform(); });


/* =========================================================
   V7.1 — CALIBRATION GUIDÉE + EXPORT JSON
   Ouvrir : ?photo=1&calibration=1
   ========================================================= */

(function(){
  const params = new URLSearchParams(window.location.search);
  const calibrationMode = params.get("calibration") === "1";
  if (!calibrationMode) return;

  const currentPhoto = params.get("photo") || "1";

  let lastGps = null;
  let lastOrientation = { azimut:null, pitch:null, roll:null };
  let savedData = null;

  function round(value, digits=6){
    if(value === null || value === undefined || Number.isNaN(value)) return null;
    return Number(value.toFixed(digits));
  }

  function gpsOk(){
    return lastGps && lastGps.accuracy <= 8;
  }

  function orientationOk(){
    return lastOrientation.azimut !== null &&
           lastOrientation.pitch !== null &&
           lastOrientation.roll !== null;
  }

  function stepInfo(){
    if(!lastGps) return {step:"1 / 4", text:"📍 Autorisez le GPS puis attendez la position.", ok:false};
    if(!gpsOk()) return {step:"1 / 4", text:`📍 Précision GPS : ± ${Math.round(lastGps.accuracy)} m. Attendez si possible moins de 8 m.`, ok:false};
    if(!orientationOk()) return {step:"2 / 4", text:"🧭 Activez les capteurs puis orientez le téléphone vers la photographie.", ok:false};
    return {step:"3 / 4", text:"✓ GPS et orientation actifs. Cadrez la photographie ancienne puis enregistrez.", ok:true};
  }

  function makePanel(){
    const hint = document.createElement("div");
    hint.id = "calibrationHint";
    hint.textContent = "Mode calibration administrateur";
    document.body.appendChild(hint);

    const panel = document.createElement("div");
    panel.id = "calibrationPanel";
    panel.innerHTML = `
      <h2>Calibration</h2>
      <p id="calStep" class="cal-step">Étape 1 / 4</p>
      <div id="calGuide" class="cal-guide">Initialisation…</div>

      <div class="cal-grid">
        <div class="cal-item"><span class="cal-label">Latitude</span><span id="calLat" class="cal-value">—</span></div>
        <div class="cal-item"><span class="cal-label">Longitude</span><span id="calLon" class="cal-value">—</span></div>
        <div class="cal-item"><span class="cal-label">Précision GPS</span><span id="calAcc" class="cal-value">—</span></div>
        <div class="cal-item"><span class="cal-label">Azimut</span><span id="calAzimut" class="cal-value">—</span></div>
        <div class="cal-item"><span class="cal-label">Inclinaison</span><span id="calPitch" class="cal-value">—</span></div>
        <div class="cal-item"><span class="cal-label">Roulis</span><span id="calRoll" class="cal-value">—</span></div>
      </div>

      <div class="cal-actions">
        <button id="calEnableSensors" type="button" class="secondary">Activer capteurs</button>
        <button id="calSave" type="button">Enregistrer</button>
        <button id="calDownload" type="button" class="secondary">Télécharger JSON</button>
        <button id="calCopy" type="button" class="secondary">Copier</button>
      </div>

      <textarea id="calibrationOutput" readonly></textarea>
    `;
    document.body.appendChild(panel);

    document.getElementById("calEnableSensors").addEventListener("click", enableOrientation);
    document.getElementById("calSave").addEventListener("click", saveCalibration);
    document.getElementById("calDownload").addEventListener("click", downloadCalibration);
    document.getElementById("calCopy").addEventListener("click", copyCalibration);
  }

  function updatePanel(){
    const info = stepInfo();
    const guide = document.getElementById("calGuide");
    document.getElementById("calStep").textContent = `Étape ${info.step}`;
    guide.textContent = info.text;
    guide.className = info.ok ? "cal-guide ok" : "cal-guide";

    if(lastGps){
      document.getElementById("calLat").textContent = round(lastGps.lat, 6);
      document.getElementById("calLon").textContent = round(lastGps.lon, 6);
      document.getElementById("calAcc").textContent = `± ${Math.round(lastGps.accuracy)} m`;
    }

    if(lastOrientation.azimut !== null) document.getElementById("calAzimut").textContent = `${round(lastOrientation.azimut, 1)}°`;
    if(lastOrientation.pitch !== null) document.getElementById("calPitch").textContent = `${round(lastOrientation.pitch, 1)}°`;
    if(lastOrientation.roll !== null) document.getElementById("calRoll").textContent = `${round(lastOrientation.roll, 1)}°`;
  }

  function startGps(){
    if(!navigator.geolocation){
      alert("GPS indisponible sur cet appareil.");
      return;
    }

    navigator.geolocation.watchPosition(
      pos => {
        lastGps = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        updatePanel();
      },
      () => alert("Autorisez la localisation pour calibrer le point."),
      {enableHighAccuracy:true, maximumAge:1000, timeout:12000}
    );
  }

  async function enableOrientation(){
    try{
      if(typeof DeviceOrientationEvent !== "undefined" &&
         typeof DeviceOrientationEvent.requestPermission === "function"){
        const permission = await DeviceOrientationEvent.requestPermission();
        if(permission !== "granted"){
          alert("Autorisez les capteurs de mouvement.");
          return;
        }
      }
      window.addEventListener("deviceorientation", handleOrientation, true);
      document.getElementById("calEnableSensors").textContent = "Capteurs actifs";
      updatePanel();
    }catch(e){
      alert("Impossible d’activer les capteurs sur cet appareil.");
    }
  }

  function handleOrientation(event){
    let azimut = event.webkitCompassHeading || event.alpha;
    if(azimut !== null && azimut !== undefined){
      if(event.webkitCompassHeading){
        azimut = event.webkitCompassHeading;
      }else{
        azimut = (360 - azimut) % 360;
      }
    }

    lastOrientation = {
      azimut: azimut,
      pitch: event.beta,
      roll: event.gamma
    };
    updatePanel();
  }

  function buildCalibration(){
    return {
      id: currentPhoto,
      nom: `Point ${currentPhoto}`,
      gps: lastGps ? {
        lat: round(lastGps.lat, 7),
        lon: round(lastGps.lon, 7),
        precision: Math.round(lastGps.accuracy)
      } : null,
      orientation: {
        azimut: round(lastOrientation.azimut, 1),
        pitch: round(lastOrientation.pitch, 1),
        roll: round(lastOrientation.roll, 1)
      },
      reglages: {
        rayon: 15,
        toleranceAzimut: 15,
        tolerancePitch: 6,
        toleranceRoll: 6
      }
    };
  }

  function saveCalibration(){
    savedData = buildCalibration();
    const output = document.getElementById("calibrationOutput");
    output.value = JSON.stringify(savedData, null, 2);
    output.classList.add("visible");
    document.getElementById("calGuide").textContent = "✓ Point enregistré. Vous pouvez copier ou télécharger le JSON.";
    document.getElementById("calGuide").className = "cal-guide ok";
  }

  function copyCalibration(){
    if(!savedData) saveCalibration();
    const text = JSON.stringify(savedData, null, 2);
    if(navigator.clipboard){
      navigator.clipboard.writeText(text).then(() => alert("JSON copié."));
    }else{
      alert("Copie automatique indisponible. Copiez le texte affiché.");
    }
  }

  function downloadCalibration(){
    if(!savedData) saveCalibration();
    const text = JSON.stringify(savedData, null, 2);
    const blob = new Blob([text], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `calibration-${currentPhoto}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  makePanel();
  startGps();

  setTimeout(() => {
    const startBtn = document.getElementById("startBtn");
    if(startBtn) startBtn.click();
  }, 700);
})();




let guidanceManuallyHidden = false;

function getGuidanceBox() {
  return document.getElementById("guidanceBox");
}

function setGuidanceVisible(visible) {
  const box = getGuidanceBox();
  if (!box) return;
  guidanceManuallyHidden = !visible;
  box.classList.toggle("guidance-hidden", !visible);
  if (guidanceBtn) {
    guidanceBtn.hidden = visible;
    guidanceBtn.setAttribute("aria-pressed", String(visible));
    guidanceBtn.setAttribute("aria-label", "Afficher le guidage GPS");
    guidanceBtn.title = "Guidage GPS";
  }
  if (typeof showControls === "function") showControls();
}

document.addEventListener("click", event => {
  const closeButton = event.target.closest("#closeGuidanceBtn");
  if (!closeButton) return;
  event.preventDefault();
  event.stopPropagation();
  setGuidanceVisible(false);
}, true);

guidanceBtn?.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  setGuidanceVisible(true);
});

const guidanceObserver = new MutationObserver(() => {
  const box = getGuidanceBox();
  if (box && guidanceManuallyHidden) box.classList.add("guidance-hidden");
});
guidanceObserver.observe(document.body, { childList: true, subtree: true });

async function toggleFullscreen() {
  try {
    try { screen.orientation?.unlock?.(); } catch (_) {}
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    const root = document.documentElement;
    if (root.requestFullscreen) {
      await root.requestFullscreen({ navigationUI: "hide" });
      return;
    }

    // Repli pour certains navigateurs mobiles : réduit la barre d'adresse.
    window.scrollTo({ top: 1, behavior: "smooth" });
    document.body.classList.add("pseudo-fullscreen");
    showControls();
    setTimeout(() => {
      alert("Pour un vrai plein écran permanent, ajoutez ce site à l’écran d’accueil puis ouvrez-le depuis son icône.");
    }, 150);
  } catch (error) {
    window.scrollTo({ top: 1, behavior: "smooth" });
    document.body.classList.add("pseudo-fullscreen");
  }
}

fullscreenBtn?.addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  if (fullscreenBtn) {
    fullscreenBtn.classList.toggle("is-fullscreen-active", active);
    fullscreenBtn.setAttribute("aria-label", active ? "Quitter le plein écran" : "Passer en plein écran");
    fullscreenBtn.title = active ? "Quitter" : "Plein écran";
  }
  try { screen.orientation?.unlock?.(); } catch (_) {}
  document.body.classList.toggle("is-fullscreen", active);
  showControls();
});

window.addEventListener("orientationchange", () => {
  try { screen.orientation?.unlock?.(); } catch (_) {}
  document.body.classList.add("orientation-changing");
  setTimeout(() => {
    window.scrollTo(0, 1);
    document.body.classList.remove("orientation-changing");
    applyTransform();
    if (typeof showControls === "function") showControls();
  }, 320);
});



let controlsHideTimer = null;
let controlsPinned = false;

function fullscreenActive() {
  return Boolean(document.fullscreenElement) ||
         document.body.classList.contains("pseudo-fullscreen") ||
         document.body.classList.contains("is-fullscreen");
}

function hideControls() {
  if (!fullscreenActive() || controlsPinned) return;
  document.body.classList.add("controls-hidden");
}

function showControls() {
  document.body.classList.remove("controls-hidden");
  clearTimeout(controlsHideTimer);
  if (fullscreenActive() && !controlsPinned) {
    controlsHideTimer = setTimeout(hideControls, 2600);
  }
}

function registerActivity(event) {
  if (event.target.closest("button, input, #guidanceBox")) {
    controlsPinned = true;
    clearTimeout(controlsHideTimer);
    setTimeout(() => {
      controlsPinned = false;
      showControls();
    }, 800);
    return;
  }
  showControls();
}

["pointerdown", "touchstart", "mousemove", "keydown"].forEach(eventName => {
  document.addEventListener(eventName, registerActivity, { passive: true });
});
window.addEventListener("orientationchange", showControls);

window.addEventListener("load", () => { try { screen.orientation?.unlock?.(); } catch (_) {} setGuidanceVisible(true); showControls(); });

/* =========================================================
   V12 — AUDIOGUIDE + TEXTES FR/EN
   ========================================================= */
(function () {
  const audioBtn = document.getElementById("audioBtn");
  const textBtn = document.getElementById("textBtn");
  const textModal = document.getElementById("textModal");
  const closeTextBtn = document.getElementById("closeTextBtn");
  const closeTextBottomBtn = document.getElementById("closeTextBottomBtn");
  const langFrBtn = document.getElementById("langFrBtn");
  const langEnBtn = document.getElementById("langEnBtn");
  const heritageText = document.getElementById("heritageText");
  const textModalTitle = document.getElementById("textModalTitle");

  if (!audioBtn || !textBtn || !textModal || !heritageText) return;

  const viewNumber = String(photoNumber || "1").replace(/[^0-9]/g, "") || "1";
  const narration = new Audio(assetUrl(`audio/V${viewNumber}.mp3`));
  narration.preload = "metadata";
  let bilingualText = { fr: "", en: "" };
  let currentLanguage = "fr";

  function setAudioState(isPlaying) {
    audioBtn.classList.toggle("is-playing", isPlaying);
    audioBtn.setAttribute("aria-pressed", isPlaying ? "true" : "false");
    audioBtn.setAttribute("aria-label", isPlaying ? "Arrêter la voix off" : "Écouter la voix off");
    audioBtn.title = isPlaying ? "Arrêter la voix off" : "Écouter la voix off";
  }

  function stopNarration() {
    narration.pause();
    narration.currentTime = 0;
    setAudioState(false);
  }

  audioBtn.addEventListener("click", async () => {
    if (!narration.paused) {
      stopNarration();
      return;
    }
    try {
      await narration.play();
      setAudioState(true);
    } catch (error) {
      showError("La voix off ne peut pas être lancée. Touchez à nouveau le bouton haut-parleur.");
    }
  });

  narration.addEventListener("ended", () => setAudioState(false));
  narration.addEventListener("pause", () => {
    if (narration.currentTime === 0 || narration.ended) setAudioState(false);
  });
  narration.addEventListener("error", () => {
    setAudioState(false);
    showError(`Voix off introuvable : audio/V${viewNumber}.mp3`);
  });

  function splitBilingualText(rawText) {
    const normalized = rawText.replace(/\r\n/g, "\n").trim();
    const blocks = normalized.split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean);
    if (blocks.length < 2) return { fr: normalized, en: "English translation unavailable." };

    let englishStart = 1;
    for (let i = 1; i < blocks.length; i += 1) {
      if (/\b(the|built|located|formerly|between|from|until|on the|place du fort was|grande rue)\b/i.test(blocks[i])) {
        englishStart = i;
        break;
      }
    }
    return {
      fr: blocks.slice(0, englishStart).join("\n\n"),
      en: blocks.slice(englishStart).join("\n\n")
    };
  }

  async function loadText() {
    try {
      const response = await fetch(assetUrl(`textes/T${viewNumber}.txt`), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bilingualText = splitBilingualText(await response.text());
    } catch (error) {
      bilingualText = {
        fr: "Le texte de ce point de vue est momentanément indisponible.",
        en: "The text for this viewpoint is temporarily unavailable."
      };
    }
  }

  function renderLanguage(language) {
    currentLanguage = language;
    const isFrench = language === "fr";
    langFrBtn.classList.toggle("active", isFrench);
    langEnBtn.classList.toggle("active", !isFrench);
    langFrBtn.setAttribute("aria-selected", isFrench ? "true" : "false");
    langEnBtn.setAttribute("aria-selected", isFrench ? "false" : "true");
    heritageText.textContent = isFrench ? bilingualText.fr : bilingualText.en;
    heritageText.lang = language;
  }

  function openTextModal() {
    textModalTitle.textContent = placeTitle?.textContent || "Texte du point de vue";
    renderLanguage(currentLanguage);
    textModal.hidden = false;
    textModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("text-open");
    closeTextBtn.focus();
  }

  function closeTextModal() {
    textModal.hidden = true;
    textModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("text-open");
    textBtn.focus();
  }

  textBtn.addEventListener("click", openTextModal);
  closeTextBtn.addEventListener("click", closeTextModal);
  closeTextBottomBtn.addEventListener("click", closeTextModal);
  langFrBtn.addEventListener("click", () => renderLanguage("fr"));
  langEnBtn.addEventListener("click", () => renderLanguage("en"));
  textModal.addEventListener("click", event => {
    if (event.target === textModal) closeTextModal();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !textModal.hidden) closeTextModal();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !narration.paused) stopNarration();
  });

  loadText();
})();
