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
const opacitySlider = document.getElementById("opacitySlider");
const placeTitle = document.getElementById("placeTitle");
const placePrecision = document.getElementById("placePrecision");
const placeDate = document.getElementById("placeDate");
const pastLabel = document.getElementById("pastLabel");
const startBtn = document.getElementById("startBtn");
const welcome = document.getElementById("welcome");
const resetBtn = document.getElementById("resetBtn");
const hideBtn = document.getElementById("hideBtn");
const errorBox = document.getElementById("errorBox");

let state = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.55 };
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
  setTimeout(() => msg.classList.remove("visible"), 3800);
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
    setGuidance("Ce point ne possède pas encore de position GPS.", "warning", "⚠");
    return;
  }

  if (!currentGps) {
    setGuidance("Autorisez la localisation pour rejoindre le point de vue.", "info", "📍");
    return;
  }

  const metres = haversineMetres(
    currentGps.lat,
    currentGps.lon,
    targetGps.lat,
    targetGps.lon
  );
  const radius = Number(settings.rayon || 15);

  if (metres > radius) {
    alignmentMessageShown = false;
    setGuidance(
      `Vous êtes à ${Math.round(metres)} m du point de vue. Rejoignez les empreintes.`,
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
  const azTol = Number(settings.toleranceAzimut || 15);

  if (Math.abs(azDiff) > azTol) {
    alignmentMessageShown = false;
    const direction = azDiff > 0 ? "vers la droite" : "vers la gauche";
    setGuidance(
      `Tournez ${direction} d’environ ${Math.round(Math.abs(azDiff))}°.`,
      "warning",
      azDiff > 0 ? "→" : "←"
    );
    return;
  }

  if (targetOri.pitch != null && currentOrientation.pitch != null) {
    const pitchDiff = Number(targetOri.pitch) - currentOrientation.pitch;
    const pitchTol = Number(settings.tolerancePitch || 6);

    if (Math.abs(pitchDiff) > pitchTol) {
      alignmentMessageShown = false;
      const action = pitchDiff > 0
        ? "Inclinez un peu plus le téléphone vers le haut."
        : "Inclinez un peu plus le téléphone vers le bas.";
      setGuidance(action, "warning", pitchDiff > 0 ? "↑" : "↓");
      return;
    }
  }

  if (targetOri.roll != null && currentOrientation.roll != null) {
    const rollDiff = Number(targetOri.roll) - currentOrientation.roll;
    const rollTol = Number(settings.toleranceRoll || 6);

    if (Math.abs(rollDiff) > rollTol) {
      alignmentMessageShown = false;
      const action = rollDiff > 0
        ? "Inclinez légèrement le téléphone vers la droite."
        : "Inclinez légèrement le téléphone vers la gauche.";
      setGuidance(action, "warning", "↔");
      return;
    }
  }

  setGuidance("Position et orientation correctes.", "ok", "✓");
  showAlignedMessage();
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
    pastLabel.textContent = "Autrefois";

    const imageFile =
      activePoint?.image || view.image || `${photoNumber}.png`;
    oldPhoto.src = assetUrl(`images/${imageFile}`);
  } catch (error) {
    placeTitle.textContent = `Vue ${photoNumber}`;
    placePrecision.textContent = "";
    placeDate.textContent = "Autrefois";
    pastLabel.textContent = "Autrefois";
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
  let azimut = null;

  if (typeof event.webkitCompassHeading === "number") {
    azimut = event.webkitCompassHeading;
  } else if (typeof event.alpha === "number") {
    azimut = normalize360(360 - event.alpha);
  }

  currentOrientation = {
    azimut,
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
      0.2,
      Math.min(6, startState.scale * (newDistance / startDistance))
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

opacitySlider.addEventListener("input", event => {
  state.opacity = Number(event.target.value);
  applyTransform();
});

resetBtn.addEventListener("click", () => {
  state = {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 0.55
  };

  opacitySlider.value = state.opacity;
  oldPhoto.classList.remove("hidden-photo");
  hideBtn.textContent = "◉ Masquer";
  applyTransform();
});

hideBtn.addEventListener("click", () => {
  oldPhoto.classList.toggle("hidden-photo");
  hideBtn.textContent = oldPhoto.classList.contains("hidden-photo")
    ? "◉ Afficher"
    : "◉ Masquer";
});

startBtn.addEventListener("click", startCameraAndGuidance);
oldPhoto.addEventListener("load", hideError);
oldPhoto.addEventListener("error", () => {
  showError(`Image introuvable : ${oldPhoto.src}`);
});

loadViewAndPoint().then(applyTransform);


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

