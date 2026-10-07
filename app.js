const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const SPEED_DECAY = 7.5;
const RPM_DECAY = 7.5;
const LERP_THRESHOLD = 0.15;
const BASE_CANVAS_W = 310;
const BASE_CANVAS_H = 180;
const S_CX = 110, S_CY = 112;
const S_MAIN_R = 88;
const S_ARC_R = 80.7;
const S_TICK_OUTER = 88;
const S_TICK_MAJ = 79.2;
const S_TICK_MIN = 80.7;
const S_LABEL_R = 67;
const S_NEEDLE_LEN = 77;
const S_CAP_OUTER = 7.3;
const S_CAP_INNER = 3.7;
const S_NEEDLE_W = 2.57;
const R_CX = 235, R_CY = 90;
const R_MAIN_R = 60;
const R_ARC_R = 52.5;
const R_TICK_OUTER = 60;
const R_TICK_INNER = 54;
const R_LABEL_R = 46;
const R_NEEDLE_LEN = 56;
const R_CAP_OUTER = 7.5;
const R_CAP_INNER = 3.75;
const R_NEEDLE_W = 2.1;
const R_UNIT_Y = 123.75;
const R_MULT_Y = 132.75;

let currentSpeed = 0;
let currentRpm = 0;
let currentFuel = 1.0;
let currentHealth = 1.0;
let currentGear = 0;
let currentOdometer = 0;
let currentEngine = false;
let currentHeadlights = 0;
let leftIndicator = false;
let rightIndicator = false;
let seatbeltFastened = false;

// SAMC Link Sync State
let syncState = {
    mode: 'none',        // 'host' | 'client' | 'none'
    role: 'host',        // 'host' | 'client'
    code: '',            // pairing room code
    serverUrl: '',      // websocket server URL
    socket: null,
    connected: false,
    reconnectTimer: null
};
let pendingTelemetry = {};
let telemetryTimeout = null;

let targetSpeedAngle = -110;
let displaySpeedAngle = -110;
let targetRpmAngle = -110;
let displayRpmAngle = -110;
let animRunning = false;
let lastFrame = 0;
let renderDirty = true;

const EL = {};

let mainCanvas, mainCtx;
let bgCanvas, bgCtx;

// Speed-reactive background images. Each stage swaps the image only when a speed band changes.
const SPEED_BG_STAGES = [
    { max: 1,  speed: 'assets/01.png', rpm: 'assets/01.png' },
    { max: 25,  speed: 'assets/02.png', rpm: 'assets/02.png' },
    { max: 50, speed: 'assets/03.png', rpm: 'assets/03.png' },
    { max: 80, speed: 'assets/04.png', rpm: 'assets/04.png' },
    { max: 100, speed: 'assets/05.png', rpm: 'assets/05.png' },
    { max: Infinity, speed: 'assets/06.png', rpm: 'assets/06.png' }
];
let speedBgStage = -1;
let speedBgReady = false;

function getSpeedBgStage(mph) {
    for (let i = 0; i < SPEED_BG_STAGES.length; i++) {
        if (mph <= SPEED_BG_STAGES[i].max) return i;
    }
    return SPEED_BG_STAGES.length - 1;
}

function preloadSpeedBackgrounds() {
    const images = [];
    let pending = 0;

    SPEED_BG_STAGES.forEach(stage => {
        [stage.speed, stage.rpm].forEach(src => {
            const img = new Image();
            pending++;
            img.onload = img.onerror = () => {
                pending--;
                if (pending <= 0) {
                    speedBgReady = true;
                    updateSpeedBackground(0, true);
                }
            };
            img.src = src;
            images.push(img);
        });
    });

    // Keep the image objects alive for the lifetime of the page.
    window.__speedBackgroundImages = images;
}

function updateSpeedBackground(mph, force) {
    const stage = getSpeedBgStage(Math.max(0, Number(mph) || 0));
    if (!force && stage === speedBgStage) return;
    speedBgStage = stage;

    const speedLayer = document.getElementById('speed-bg-speed');
    const rpmLayer = document.getElementById('speed-bg-rpm');
    if (!speedLayer || !rpmLayer) return;

    const cfg = SPEED_BG_STAGES[stage];

    // Fade out, swap the image on the next frame, then fade back in. This gives a
    // lightweight visual transition without adding another canvas layer.
    speedLayer.classList.remove('active');
    rpmLayer.classList.remove('active');
    requestAnimationFrame(function () {
        speedLayer.style.backgroundImage = `url("${cfg.speed}")`;
        rpmLayer.style.backgroundImage = `url("${cfg.rpm}")`;
        requestAnimationFrame(function () {
            speedLayer.classList.add('active');
            rpmLayer.classList.add('active');
        });
    });

    // Small intensity change at higher speeds adds depth without altering the dial geometry.
    const intensity = Math.min(1.12, 1 + Math.max(0, mph - 60) / 600);
    speedLayer.style.filter = `saturate(${intensity.toFixed(2)}) contrast(1.08)`;
    rpmLayer.style.filter = `saturate(${intensity.toFixed(2)}) contrast(1.08)`;
}

const blinkTimers = {};

function d2c(dialDeg) {
    return (dialDeg - 90) * DEG;
}

function drawDialBg(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TWO_PI);
    ctx.fillStyle = 'rgba(10, 10, 10, 0.65)';
    ctx.fill();
}

function drawZoneArcs(ctx, cx, cy, arcR, zones, lineWidth) {
    ctx.lineCap = 'round';
    ctx.lineWidth = lineWidth;
    for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        ctx.beginPath();
        ctx.arc(cx, cy, arcR, d2c(z.start), d2c(z.end), false);
        ctx.strokeStyle = z.color;
        ctx.globalAlpha = z.alpha;
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function drawTicks(ctx, cx, cy, outerR, innerMaj, innerMin, ticks) {
    for (let i = 0; i < ticks.length; i++) {
        const t = ticks[i];
        const rad = t.angle * DEG;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rad);

        ctx.beginPath();
        ctx.moveTo(0, -outerR);
        ctx.lineTo(0, -(t.major ? innerMaj : innerMin));
        ctx.strokeStyle = t.major ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)';
        ctx.lineWidth = t.major ? 1.47 : 0.73;
        ctx.lineCap = 'butt';
        ctx.stroke();

        ctx.restore();
    }
}

function drawLabels(ctx, cx, cy, labelR, labels, font, defaultColor) {
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const rad = l.angle * DEG;
        const lx = cx + labelR * Math.sin(rad);
        const ly = cy - labelR * Math.cos(rad);
        ctx.fillStyle = l.color || defaultColor;
        ctx.fillText(l.text, lx, ly);
    }
}

function drawStaticBuffer() {
    if (!bgCtx) return;

    bgCtx.clearRect(0, 0, BASE_CANVAS_W, BASE_CANVAS_H);

    // 1. Draw unified background (fills the entire merged shape in a single call to prevent transparency overlap)
    bgCtx.beginPath();
    bgCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI);

    const R_LEFT = R_CX - R_MAIN_R;
    bgCtx.moveTo(R_CX + R_MAIN_R, R_CY);
    bgCtx.arc(R_CX, R_CY, R_MAIN_R, Math.PI, 0, false);
    bgCtx.arcTo(R_CX + R_MAIN_R, 180, R_LEFT, 180, 15);
    bgCtx.lineTo(150, 180);
    bgCtx.lineTo(R_LEFT, R_CY);
    bgCtx.closePath();

    bgCtx.fillStyle = 'rgba(0, 0, 0, 0.16)';
    bgCtx.fill();

    // 2. Stroke the RPM background, clipped to the outside of the Speedometer circle so it doesn't draw inside
    bgCtx.save();
    bgCtx.beginPath();
    bgCtx.rect(0, 0, BASE_CANVAS_W, BASE_CANVAS_H);
    bgCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI, true);
    bgCtx.clip();

    bgCtx.beginPath();
    bgCtx.arc(R_CX, R_CY, R_MAIN_R, 0, TWO_PI);

    // Dark outer silhouette outline
    bgCtx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    bgCtx.lineWidth = 2.6;
    bgCtx.stroke();

    // Light inner outline
    bgCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    bgCtx.lineWidth = 1.6;
    bgCtx.stroke();
    bgCtx.restore();

    // 2b. Stroke the Speedometer background outline
    bgCtx.beginPath();
    bgCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI);
    // Dark outer silhouette outline
    bgCtx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    bgCtx.lineWidth = 2.6;
    bgCtx.stroke();

    bgCtx.beginPath();
    bgCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI);
    // Light inner outline
    bgCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    bgCtx.lineWidth = 1.6;
    bgCtx.stroke();

    // 3. Speedometer elements
    drawZoneArcs(bgCtx, S_CX, S_CY, S_ARC_R, [
        { start: -110, end: 10, color: '#2ecc71', alpha: 0.6 },
        { start: 10, end: 50, color: '#f1c40f', alpha: 0.6 },
        { start: 50, end: 110, color: '#e74c3c', alpha: 0.8 },
    ], 2.93);

    const speedTicks = [];
    for (let mph = 0; mph <= 200; mph += 20) {
        speedTicks.push({
            angle: mph * 1.1 - 110,
            major: mph % 40 === 0
        });
    }
    drawTicks(bgCtx, S_CX, S_CY, S_TICK_OUTER, S_TICK_MAJ, S_TICK_MIN, speedTicks);

    const speedLabels = [];
    for (let mph = 0; mph <= 200; mph += 20) {
        speedLabels.push({ angle: mph * 1.1 - 110, text: '' + mph });
    }
    drawLabels(bgCtx, S_CX, S_CY, S_LABEL_R, speedLabels, 'bold 7px Formula1, sans-serif', 'rgba(255,255,255,0.5)');

    // 4. RPM elements (clipped to the outside of the Speedometer circle to prevent overlap with Speedometer ticks/labels)
    bgCtx.save();
    bgCtx.beginPath();
    bgCtx.rect(0, 0, BASE_CANVAS_W, BASE_CANVAS_H);
    bgCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI, true);
    bgCtx.clip();

    drawZoneArcs(bgCtx, R_CX, R_CY, R_ARC_R, [
        { start: 70, end: 110, color: '#e74c3c', alpha: 0.8 },
    ], 2.25);

    const rpmTicks = [];
    for (let v = 0; v <= 11; v++) {
        rpmTicks.push({ angle: v * 20 - 110, major: true });
    }
    drawTicks(bgCtx, R_CX, R_CY, R_TICK_OUTER, R_TICK_INNER, R_TICK_INNER, rpmTicks);

    const rpmLabels = [];
    for (let v = 0; v <= 11; v++) {
        if (v <= 2) continue;
        rpmLabels.push({
            angle: v * 20 - 110,
            text: '' + v,
            color: v >= 7 ? '#ff4757' : undefined
        });
    }
    drawLabels(bgCtx, R_CX, R_CY, R_LABEL_R, rpmLabels, 'bold 7px Formula1, sans-serif', 'rgba(255,255,255,0.5)');

    bgCtx.font = 'bold 7.5px Formula1, sans-serif';
    bgCtx.fillStyle = 'rgba(255,255,255,0.6)';
    bgCtx.textAlign = 'center';
    bgCtx.textBaseline = 'middle';
    bgCtx.fillText('RPM', R_CX, R_UNIT_Y);

    bgCtx.font = '5px Formula1, sans-serif';
    bgCtx.fillStyle = 'rgba(255,255,255,0.3)';
    bgCtx.fillText('x1000', R_CX, R_MULT_Y);
    bgCtx.restore();
}

function drawNeedle(ctx, cx, cy, angleDeg, len, strokeW, capOuter, capInner) {
    const rad = angleDeg * DEG;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -len);
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, capOuter, 0, TWO_PI);
    ctx.fillStyle = '#1e1e1e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, capInner, 0, TWO_PI);
    ctx.fillStyle = '#ff4757';
    ctx.fill();
}

function renderFrame() {
    if (syncState.mode === 'host' && syncState.connected) {
        renderDirty = false;
        return;
    }
    if (!renderDirty || !bgCanvas) return;
    renderDirty = false;

    // 1. Clear main canvas
    mainCtx.clearRect(0, 0, BASE_CANVAS_W, BASE_CANVAS_H);

    // 2. Draw unified static backgrounds (Speedometer + RPM combined)
    mainCtx.drawImage(bgCanvas, 0, 0, BASE_CANVAS_W, BASE_CANVAS_H);

    // 3. Draw RPM needle (clipped to the outside of the Speedometer circle so it never overlaps the Speedometer)
    mainCtx.save();
    mainCtx.beginPath();
    mainCtx.rect(0, 0, BASE_CANVAS_W, BASE_CANVAS_H);
    mainCtx.arc(S_CX, S_CY, S_MAIN_R, 0, TWO_PI, true);
    mainCtx.clip();

    drawNeedle(mainCtx, R_CX, R_CY, displayRpmAngle, R_NEEDLE_LEN, R_NEEDLE_W, R_CAP_OUTER, R_CAP_INNER);
    mainCtx.restore();

    // 4. Draw Gear indicator
    mainCtx.save();
    mainCtx.font = '900 15px Formula1, sans-serif';
    mainCtx.fillStyle = '#ff6b35';
    mainCtx.textAlign = 'center';
    mainCtx.textBaseline = 'middle';

    mainCtx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    mainCtx.shadowBlur = 3;
    mainCtx.shadowOffsetX = 0;
    mainCtx.shadowOffsetY = 1;

    const display = currentGear === 0 ? 'N' : (currentGear === -1 ? 'R' : currentGear.toString());

    mainCtx.fillText(display, 110, 90);
    mainCtx.restore();

    // 5. Draw Speedometer needle
    drawNeedle(mainCtx, S_CX, S_CY, displaySpeedAngle, S_NEEDLE_LEN, S_NEEDLE_W, S_CAP_OUTER, S_CAP_INNER);
}

function animateNeedles(timestamp) {
    const now = timestamp || performance.now();

    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    let needsUpdate = false;

    const sFactor = SPEED_DECAY * dt / (1 + SPEED_DECAY * dt);
    const sDelta = targetSpeedAngle - displaySpeedAngle;
    if (Math.abs(sDelta) > LERP_THRESHOLD) {
        displaySpeedAngle += sDelta * sFactor;
        needsUpdate = true;
    } else if (displaySpeedAngle !== targetSpeedAngle) {
        displaySpeedAngle = targetSpeedAngle;
        needsUpdate = true;
    }

    const rFactor = RPM_DECAY * dt / (1 + RPM_DECAY * dt);
    const rDelta = targetRpmAngle - displayRpmAngle;
    if (Math.abs(rDelta) > LERP_THRESHOLD) {
        displayRpmAngle += rDelta * rFactor;
        needsUpdate = true;
    } else if (displayRpmAngle !== targetRpmAngle) {
        displayRpmAngle = targetRpmAngle;
        needsUpdate = true;
    }

    if (needsUpdate) {
        renderDirty = true;
        renderFrame();
        requestAnimationFrame(animateNeedles);
    } else {

        animRunning = false;
    }
}

function startAnimation() {
    if (syncState.mode === 'host' && syncState.connected) return;
    if (!animRunning) {
        animRunning = true;
        lastFrame = performance.now();
        requestAnimationFrame(animateNeedles);
    }
}

function startBlink(el, intervalMs) {
    const id = el.id;
    if (blinkTimers[id]) return;
    let visible = true;
    blinkTimers[id] = setInterval(function () {
        visible = !visible;
        el.style.opacity = visible ? '1' : '0.2';
    }, intervalMs);
}

function stopBlink(el) {
    const id = el.id;
    if (blinkTimers[id]) {
        clearInterval(blinkTimers[id]);
        delete blinkTimers[id];
        el.style.opacity = '';
    }
}

function broadcastTelemetry(key, value) {
    if (syncState.mode !== 'host' || !syncState.connected) return;
    pendingTelemetry[key] = value;
    if (!telemetryTimeout) {
        telemetryTimeout = setTimeout(function () {
            const dataStr = JSON.stringify({
                type: 'telemetry',
                data: pendingTelemetry
            });

            // Send via PeerJS WebRTC P2P DataChannels if active
            if (peerConnections.length > 0) {
                peerConnections.forEach(function (conn) {
                    if (conn && conn.open) {
                        conn.send(dataStr);
                    }
                });
            }

            // Fallback send via WebSocket socket if active
            if (syncState.socket && syncState.socket.readyState === WebSocket.OPEN) {
                syncState.socket.send(dataStr);
            }

            pendingTelemetry = {};
            telemetryTimeout = null;
        }, 16.6);
    }
}

function setEngine(state) {
    broadcastTelemetry('engine', state);
    currentEngine = state;
    if (EL.indicatorEngine) {
        if (state) {
            EL.indicatorEngine.classList.add('on');
        } else {
            EL.indicatorEngine.classList.remove('on');
        }
    }
}

function setSpeed(speed) {
    broadcastTelemetry('speed', speed);
    currentSpeed = Number(speed);
    if (isNaN(currentSpeed)) currentSpeed = 0;

    const mph = Math.round(currentSpeed * 2.236936);

    if (EL.speedDisplay) EL.speedDisplay.textContent = mph;

    updateSpeedBackground(mph);

    const capped = Math.min(Math.max(mph, 0), 200);
    const angle = capped * 1.1 - 110;
    targetSpeedAngle = isNaN(angle) ? -110 : angle;
    startAnimation();
}

function setRPM(rpm) {
    broadcastTelemetry('rpm', rpm);
    currentRpm = Number(rpm);
    if (isNaN(currentRpm)) currentRpm = 0;

    const rpmVal = currentRpm * 10;

    const angle = rpmVal * 20 - 110;
    const targetAngle = Math.min(Math.max(angle, -110), 110);
    targetRpmAngle = isNaN(targetAngle) ? -110 : targetAngle;
    startAnimation();
}

function setFuel(fuel) {
    broadcastTelemetry('fuel', fuel);
    let fuelNum = Number(fuel);
    if (isNaN(fuelNum)) fuelNum = 0;
    if (currentFuel === fuelNum) return;
    currentFuel = fuelNum;

    if (EL.fuelFill) {
        const safeFuel = Math.max(fuelNum, 0.001);
        EL.fuelFill.style.setProperty('--value', safeFuel);
    }
    if (EL.fuelText) EL.fuelText.textContent = Math.round(fuelNum * 100) + '%';
}

function setHealth(health) {
    broadcastTelemetry('health', health);
    let healthNum = Number(health);
    if (isNaN(healthNum)) healthNum = 0;
    if (currentHealth === healthNum) return;
    currentHealth = healthNum;

    if (EL.healthFill) {
        const safeHealth = Math.max(healthNum, 0.001);
        EL.healthFill.style.setProperty('--value', safeHealth);
    }
    if (EL.healthText) EL.healthText.textContent = Math.round(healthNum * 100) + '%';
}

function setGear(gear) {
    broadcastTelemetry('gear', gear);
    currentGear = gear;
    renderDirty = true;
    renderFrame();
}

function setHeadlights(state) {
    broadcastTelemetry('headlights', state);
    currentHeadlights = state;
    if (EL.indicatorHeadlights) {
        if (state > 0) {
            EL.indicatorHeadlights.classList.add('on');
        } else {
            EL.indicatorHeadlights.classList.remove('on');
        }
    }
}

function setLeftIndicator(state) {
    broadcastTelemetry('leftIndicator', state);
    leftIndicator = state;
    if (EL.indicatorLeft) {
        if (state) {
            EL.indicatorLeft.classList.add('on');
            startBlink(EL.indicatorLeft, 500);
        } else {
            EL.indicatorLeft.classList.remove('on');
            stopBlink(EL.indicatorLeft);
        }
    }
}

function setRightIndicator(state) {
    broadcastTelemetry('rightIndicator', state);
    rightIndicator = state;
    if (EL.indicatorRight) {
        if (state) {
            EL.indicatorRight.classList.add('on');
            startBlink(EL.indicatorRight, 500);
        } else {
            EL.indicatorRight.classList.remove('on');
            stopBlink(EL.indicatorRight);
        }
    }
}

function setSeatbelts(state) {
    broadcastTelemetry('seatbelt', state);
    seatbeltFastened = state;
    if (EL.indicatorSeatbelt) {
        if (!state) {
            EL.indicatorSeatbelt.classList.add('on');
            startBlink(EL.indicatorSeatbelt, 600);
        } else {
            EL.indicatorSeatbelt.classList.remove('on');
            stopBlink(EL.indicatorSeatbelt);
        }
    }
}

function setOdometer(distance) {
    broadcastTelemetry('odometer', distance);
    let distNum = Number(distance);
    if (isNaN(distNum)) distNum = 0;
    currentOdometer = distNum;
    if (EL.odometer) EL.odometer.textContent = distNum.toFixed(1) + ' mi';
}

function setPosition(left, top) {
    if (!dashboardEl) dashboardEl = document.getElementById('speedometer');
    if (!dashboardEl) return;

    const leftVal = typeof left === 'number' ? left + 'px' : left;
    const topVal = typeof top === 'number' ? top + 'px' : top;

    dashboardEl.style.left = leftVal;
    dashboardEl.style.top = topVal;
    dashboardEl.style.bottom = 'auto';
    dashboardEl.style.right = 'auto';
    saveSettings();
}

function setScale(scale) {
    currentScale = Math.min(Math.max(scale, 0.5), 2.0);
    updateScale();
    saveSettings();
}

let dashboardEl = null;
let currentScale = 1.0;

function loadSettings() {
    dashboardEl = document.getElementById('speedometer');
    if (!dashboardEl) return;

    try {
        const settings = JSON.parse(localStorage.getItem('spedo_settings'));
        if (settings) {
            currentScale = typeof settings.scale === 'number' ? settings.scale : 1.0;
            if (typeof settings.left === 'number' && typeof settings.top === 'number') {
                dashboardEl.style.left = settings.left + 'px';
                dashboardEl.style.top = settings.top + 'px';
                dashboardEl.style.bottom = 'auto';
                dashboardEl.style.right = 'auto';
            }
            updateScale();
        }
    } catch (e) {
        console.error('Error loading speedometer settings:', e);
    }
}

function saveSettings() {
    if (!dashboardEl) return;
    const style = window.getComputedStyle(dashboardEl);
    const settings = {
        scale: currentScale,
        left: parseFloat(style.left) || dashboardEl.offsetLeft,
        top: parseFloat(style.top) || dashboardEl.offsetTop
    };
    localStorage.setItem('spedo_settings', JSON.stringify(settings));
}

function updateScale() {
    if (!dashboardEl) return;
    dashboardEl.style.transform = 'scale(' + currentScale + ')';
    dashboardEl.style.transformOrigin = 'center center';
    resizeCanvasForScale();
}

function resetSettings() {
    currentScale = 1.0;
    if (dashboardEl) {
        dashboardEl.style.left = '';
        dashboardEl.style.top = '';
        dashboardEl.style.bottom = '15px';
        dashboardEl.style.right = '15px';
        dashboardEl.style.transform = 'scale(1)';
        dashboardEl.style.transformOrigin = '';
    }
    localStorage.removeItem('spedo_settings');
    resizeCanvasForScale();
}

function resizeCanvasForScale() {
    if (!mainCanvas || !bgCanvas) return;
    var dpr = window.devicePixelRatio || 1;
    var totalScale = currentScale * dpr;

    mainCanvas.width = Math.round(BASE_CANVAS_W * totalScale);
    mainCanvas.height = Math.round(BASE_CANVAS_H * totalScale);
    mainCanvas.style.width = BASE_CANVAS_W + 'px';
    mainCanvas.style.height = BASE_CANVAS_H + 'px';

    bgCanvas.width = Math.round(BASE_CANVAS_W * totalScale);
    bgCanvas.height = Math.round(BASE_CANVAS_H * totalScale);

    mainCtx.scale(totalScale, totalScale);
    bgCtx.scale(totalScale, totalScale);

    drawStaticBuffer();
    renderDirty = true;
    renderFrame();
}

function setupDragging() {
    const dashboard = document.getElementById('speedometer');
    if (!dashboard) return;

    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let initialX = 0, initialY = 0;
    let lastDragX = 0, lastDragY = 0;
    let dragRAF = null;

    dashboard.addEventListener('pointerdown', function (e) {

        if (e.target.closest('.no-drag') || e.target.closest('button')) return;
        isDragging = true;

        initialX = dashboard.offsetLeft;
        initialY = dashboard.offsetTop;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        dashboard.setPointerCapture(e.pointerId);
        dashboard.style.cursor = 'grabbing';
        e.preventDefault();
    });

    dashboard.addEventListener('pointermove', function (e) {
        if (!isDragging) return;
        lastDragX = e.clientX;
        lastDragY = e.clientY;

        if (dragRAF) return;
        dragRAF = requestAnimationFrame(function () {
            dashboard.style.left = (initialX + (lastDragX - dragStartX)) + 'px';
            dashboard.style.top = (initialY + (lastDragY - dragStartY)) + 'px';
            dashboard.style.bottom = 'auto';
            dashboard.style.right = 'auto';
            dragRAF = null;
        });
    });

    dashboard.addEventListener('pointerup', function (e) {
        if (!isDragging) return;
        isDragging = false;
        dashboard.releasePointerCapture(e.pointerId);
        dashboard.style.cursor = '';
        saveSettings();
    });

    dashboard.addEventListener('lostpointercapture', function (e) {
        if (!isDragging) return;
        isDragging = false;
        dashboard.style.cursor = '';
        saveSettings();
    });
}

function setupControls() {
    var btnUp = document.getElementById('btn-scale-up');
    var btnDown = document.getElementById('btn-scale-down');
    var btnReset = document.getElementById('btn-reset');

    if (btnUp) {
        btnUp.addEventListener('click', function (e) {
            e.stopPropagation();
            currentScale = Math.min(currentScale + 0.1, 2.0);
            updateScale();
            saveSettings();
        });
    }

    if (btnDown) {
        btnDown.addEventListener('click', function (e) {
            e.stopPropagation();
            currentScale = Math.max(currentScale - 0.1, 0.5);
            updateScale();
            saveSettings();
        });
    }

    if (btnReset) {
        btnReset.addEventListener('click', function (e) {
            e.stopPropagation();
            resetSettings();
        });
    }
}

function cleanupSpeedometer() {
    for (const id in blinkTimers) {
        if (blinkTimers[id]) {
            clearInterval(blinkTimers[id]);
            delete blinkTimers[id];
        }
    }
    if (EL.indicatorLeft) {
        EL.indicatorLeft.style.opacity = '';
        EL.indicatorLeft.classList.remove('on');
    }
    if (EL.indicatorRight) {
        EL.indicatorRight.style.opacity = '';
        EL.indicatorRight.classList.remove('on');
    }
    if (EL.indicatorSeatbelt) {
        EL.indicatorSeatbelt.style.opacity = '';
        EL.indicatorSeatbelt.classList.remove('on');
    }
    animRunning = false;
}

document.addEventListener('DOMContentLoaded', function () {

    EL.speedDisplay = document.getElementById('speed-display');
    EL.speedUnit = document.getElementById('speed-unit');
    EL.gearDisplay = document.getElementById('gear-display');
    EL.odometer = document.getElementById('odometer');
    EL.fuelFill = document.getElementById('fuel-fill');
    EL.fuelText = document.getElementById('fuel-text');
    EL.healthFill = document.getElementById('health-fill');
    EL.healthText = document.getElementById('health-text');
    EL.indicatorLeft = document.getElementById('indicator-left');
    EL.indicatorRight = document.getElementById('indicator-right');
    EL.indicatorHeadlights = document.getElementById('indicator-headlights');
    EL.indicatorSeatbelt = document.getElementById('indicator-seatbelt');
    EL.indicatorEngine = document.getElementById('indicator-engine');

    mainCanvas = document.getElementById('speedo-canvas');
    mainCtx = mainCanvas.getContext('2d');

    bgCanvas = document.createElement('canvas');
    bgCtx = bgCanvas.getContext('2d');

    document.fonts.ready.then(function () {
        resizeCanvasForScale();
        preloadSpeedBackgrounds();

        setEngine(false);
        setSpeed(0);
        setRPM(0);
        setFuel(1);
        setHealth(1);
        setGear(0);
        setHeadlights(0);
        setLeftIndicator(false);
        setRightIndicator(false);
        setSeatbelts(0);
        setOdometer(0);
    });

    loadSettings();
    setupDragging();
    setupControls();
    setupSyncSystem();
});


/* ==========================================================================\n   Telemetry bridge\n   --------------------------------------------------------------------------\n   Supports browser postMessage / FiveM SendNUIMessage style payloads.\n   Accepted examples:\n     { action: 'vehicle', speed: 12.5, rpm: 0.65, ... }\n     { action: 'vehicle', data: { speed: 12.5, rpm: 0.65, ... } }\n     { type: 'vehicle', speed: 12.5, ... }\n   Speed is m/s by default (same convention as GTA/FiveM GetEntitySpeed).\n   Fuel/health are 0..1 by default; 0..100 values are also accepted.\n   ========================================================================== */

function toBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['false', '0', 'off', 'no', 'disabled'].includes(v)) return false;
        if (['true', '1', 'on', 'yes', 'enabled'].includes(v)) return true;
    }
    return Boolean(value);
}

function normalizeRatio(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n > 1 ? Math.max(0, Math.min(100, n)) / 100 : Math.max(0, Math.min(1, n));
}

function applyTelemetry(data) {
    if (!data || typeof data !== 'object') return;

    const payload = (data.data && typeof data.data === 'object') ? data.data : data;

    if (payload.visible !== undefined) {
        const dashboard = document.getElementById('speedometer');
        if (dashboard) dashboard.style.display = payload.visible ? '' : 'none';
    }

    if (payload.speed !== undefined) {
        let speed = Number(payload.speed);
        if (Number.isFinite(speed)) {
            const unit = String(payload.speedUnit || payload.unit || '').toLowerCase();
            if (unit === 'km/h' || unit === 'kmh' || unit === 'kph') speed /= 3.6;
            else if (unit === 'mph') speed /= 2.236936;
            setSpeed(speed);
        }
    }

    if (payload.rpm !== undefined) setRPM(payload.rpm);
    if (payload.fuel !== undefined) setFuel(normalizeRatio(payload.fuel, currentFuel));
    if (payload.health !== undefined) setHealth(normalizeRatio(payload.health, currentHealth));
    if (payload.gear !== undefined) setGear(Number(payload.gear) || 0);
    if (payload.engine !== undefined) setEngine(toBool(payload.engine));
    if (payload.headlights !== undefined) {
        const lights = typeof payload.headlights === 'boolean' ? (payload.headlights ? 1 : 0) : Number(payload.headlights) || 0;
        setHeadlights(lights);
    }
    if (payload.leftIndicator !== undefined || payload.left !== undefined) {
        setLeftIndicator(toBool(payload.leftIndicator ?? payload.left));
    }
    if (payload.rightIndicator !== undefined || payload.right !== undefined) {
        setRightIndicator(toBool(payload.rightIndicator ?? payload.right));
    }
    if (payload.seatbelt !== undefined || payload.seatbeltFastened !== undefined) {
        setSeatbelts(toBool(payload.seatbelt ?? payload.seatbeltFastened));
    }
    if (payload.odometer !== undefined) setOdometer(payload.odometer);
}

window.addEventListener('message', function (event) {
    try {
        const data = event && event.data;
        if (!data) return;

        if (typeof data === 'string') {
            try { applyTelemetry(JSON.parse(data)); } catch (_) {}
            return;
        }

        const action = typeof data.action === 'string' ? data.action.toLowerCase() : '';
        const type = typeof data.type === 'string' ? data.type.toLowerCase() : '';

        if (['vehicle', 'speedometer', 'update', 'telemetry'].includes(action) || ['vehicle', 'speedometer', 'telemetry'].includes(type) ||
            data.speed !== undefined || data.rpm !== undefined || data.fuel !== undefined ||
            data.health !== undefined || data.gear !== undefined) {
            applyTelemetry(data);
        }

        if (data.action === 'visible') {
            const dashboard = document.getElementById('speedometer');
            if (dashboard) dashboard.classList.toggle('hide', data.visible === false);
        }
    } catch (e) {
        console.error('[SAMC Telemetry] Message handling error:', e);
    }
});

// Optional test mode for GitHub Pages / desktop browser.
// Open index.html?demo=1 to exercise every indicator without FiveM.
function setupDemoMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== '1') return;

    const panel = document.createElement('div');
    panel.id = 'demo-controls';
    panel.innerHTML = `
      <div class="demo-title">SAMC SPEEDO TEST</div>
      <div class="demo-grid">
        <label>Speed <input id="demo-speed" type="range" min="0" max="200" value="80"><span id="demo-speed-v">80 km/h</span></label>
        <label>RPM <input id="demo-rpm" type="range" min="0" max="100" value="55"><span id="demo-rpm-v">5.5k</span></label>
        <label>Fuel <input id="demo-fuel" type="range" min="0" max="100" value="75"><span id="demo-fuel-v">75%</span></label>
        <label>Health <input id="demo-health" type="range" min="0" max="100" value="100"><span id="demo-health-v">100%</span></label>
      </div>
      <div class="demo-buttons">
        <button data-demo="left">LEFT</button><button data-demo="right">RIGHT</button>
        <button data-demo="lights">LIGHTS</button><button data-demo="seatbelt">BELT</button>
        <button data-demo="engine">ENGINE</button>
        <button data-demo="gear" data-value="-1">R</button><button data-demo="gear" data-value="0">N</button><button data-demo="gear" data-value="1">1</button><button data-demo="gear" data-value="2">2</button><button data-demo="gear" data-value="3">3</button><button data-demo="gear" data-value="4">4</button>
      </div>`;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #demo-controls{position:fixed;left:15px;bottom:15px;z-index:20000;width:330px;padding:12px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(12,12,12,.92);color:#fff;font:11px Arial,sans-serif;backdrop-filter:blur(8px)}
      #demo-controls .demo-title{font-weight:700;letter-spacing:1px;margin-bottom:9px;opacity:.8}
      #demo-controls label{display:grid;grid-template-columns:58px 1fr 48px;align-items:center;gap:6px;margin:6px 0}
      #demo-controls input{width:100%}
      #demo-controls span{text-align:right;opacity:.7}
      #demo-controls .demo-buttons{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
      #demo-controls button{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#fff;border-radius:5px;padding:5px 7px;font-size:10px;cursor:pointer}
      #demo-controls button.on{background:#2ecc71;color:#07130b}
    `;
    document.head.appendChild(style);

    let demo = { left:false, right:false, lights:0, seatbelt:true, engine:true, gear:1 };
    const send = () => applyTelemetry({
        speed: Number(document.getElementById('demo-speed').value) / 3.6,
        rpm: Number(document.getElementById('demo-rpm').value) / 100,
        fuel: Number(document.getElementById('demo-fuel').value) / 100,
        health: Number(document.getElementById('demo-health').value) / 100,
        gear: demo.gear, engine: demo.engine, headlights: demo.lights,
        leftIndicator: demo.left, rightIndicator: demo.right, seatbelt: demo.seatbelt,
        odometer: 123.4
    });

    ['speed','rpm','fuel','health'].forEach(name => {
        const input = document.getElementById('demo-' + name);
        input.addEventListener('input', () => {
            const suffix = name === 'speed' ? ' km/h' : name === 'rpm' ? 'k' : '%';
            const val = name === 'rpm' ? (Number(input.value)/10).toFixed(1) : input.value;
            document.getElementById('demo-' + name + '-v').textContent = val + suffix;
            send();
        });
    });

    panel.querySelectorAll('button[data-demo]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.demo;
            if (key === 'gear') demo.gear = Number(btn.dataset.value);
            else if (key === 'engine') demo.engine = !demo.engine;
            else if (key === 'lights') demo.lights = demo.lights ? 0 : 3;
            else if (key === 'seatbelt') demo.seatbelt = !demo.seatbelt;
            else demo[key] = !demo[key];
            btn.classList.toggle('on', key === 'gear' ? false : !!demo[key]);
            send();
        });
    });
    send();
}

document.addEventListener('DOMContentLoaded', setupDemoMode);

window.SAMCSpeedo = {
    update: applyTelemetry,
    setSpeed,
    setRPM,
    setFuel,
    setHealth,
    setGear,
    setEngine,
    setHeadlights,
    setLeftIndicator,
    setRightIndicator,
    setSeatbelts,
    setOdometer,
};

/* ==========================================================================
   SAMC Link Sync System Implementation
   ========================================================================== */

function generateHostCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function showSyncModal() {
    const modal = document.getElementById('sync-panel');
    if (modal) modal.classList.remove('hide');
}

function hideSyncModal() {
    const modal = document.getElementById('sync-panel');
    if (modal) modal.classList.add('hide');
}

function updateSyncStatus(stateClass, text) {
    const dot = document.getElementById('sync-status-dot');
    const txt = document.getElementById('sync-status-text');
    if (dot) {
        dot.className = 'status-dot ' + stateClass;
    }
    if (txt) {
        txt.textContent = text;
    }
}

function updateActivePill(title, subtitle) {
    const pillText = document.getElementById('sync-active-text');
    if (pillText) {
        pillText.innerHTML = title + ' <span style="font-weight:400; opacity:0.65;">(' + subtitle + ')</span>';
    }
}

function resetSpeedometerValues() {
    setEngine(false);
    setSpeed(0);
    setRPM(0);
    setFuel(1);
    setHealth(1);
    setGear(0);
    setHeadlights(0);
    setLeftIndicator(false);
    setRightIndicator(false);
    setSeatbelts(0);
    setOdometer(0);
}

let peerInstance = null;
let peerConnections = [];
let clientConnection = null;

const peerIceServers = {
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelay',
                credential: 'openrelay'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelay',
                credential: 'openrelay'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelay',
                credential: 'openrelay'
            }
        ]
    }
};

function connectPeerJS(role, roomCode) {
    disconnectPeerJS();
    if (syncState.socket) {
        syncState.socket.close();
        syncState.socket = null;
    }

    updateSyncStatus('connecting', 'Connecting P2P...');

    const peerId = 'samc-spedo-' + roomCode.toLowerCase();

    if (typeof Peer === 'undefined') {
        console.warn('[SAMC Sync] PeerJS library not loaded, falling back to WebSocket');
        const defaultWsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + (window.location.hostname || 'localhost') + (window.location.protocol === 'https:' ? '' : ':8080');
        connectWebSocket(defaultWsUrl, role, roomCode);
        return;
    }

    if (role === 'host') {
        try {
            peerInstance = new Peer(peerId, peerIceServers);
        } catch (e) {
            console.error('[SAMC PeerJS] Creation error:', e);
            updateSyncStatus('disconnected', 'P2P Error');
            return;
        }

        peerInstance.on('open', function (id) {
            console.log('[SAMC PeerJS] Host Peer opened with ID:', id);
            syncState.connected = true;
            syncState.mode = 'host';
            syncState.code = roomCode;

            updateSyncStatus('connected', 'Host Connected (P2P)');
            const hostConn = document.getElementById('btn-host-connect');
            const hostDisc = document.getElementById('btn-host-disconnect');
            if (hostConn) hostConn.classList.add('hide');
            if (hostDisc) hostDisc.classList.remove('hide');

            setTimeout(hideSyncModal, 800);
            updateActivePill('Host Ready', 'Waiting for Client...');
        });

        peerInstance.on('connection', function (conn) {
            console.log('[SAMC PeerJS] Client connected to Host');
            peerConnections.push(conn);

            const dashboard = document.getElementById('speedometer');
            if (dashboard) dashboard.classList.add('sync-hidden');
            updateActivePill('Syncing HUD', 'Code: ' + syncState.code);
            const activePill = document.getElementById('sync-active-pill');
            if (activePill) activePill.classList.remove('hide');
            cleanupSpeedometer();

            conn.on('close', function () {
                peerConnections = peerConnections.filter(function (c) { return c !== conn; });
                console.log('[SAMC PeerJS] Client disconnected. Remaining:', peerConnections.length);
                if (peerConnections.length === 0) {
                    const dashboard = document.getElementById('speedometer');
                    if (dashboard) dashboard.classList.remove('sync-hidden');
                    const activePill = document.getElementById('sync-active-pill');
                    if (activePill) activePill.classList.add('hide');
                    renderDirty = true;
                    startAnimation();
                }
            });
        });

        peerInstance.on('error', function (err) {
            console.error('[SAMC PeerJS] Host error:', err);
            updateSyncStatus('disconnected', 'P2P Error: ' + (err.type || 'Connection failed'));
        });

    } else if (role === 'client') {
        try {
            peerInstance = new Peer(peerIceServers);
        } catch (e) {
            console.error('[SAMC PeerJS] Creation error:', e);
            updateSyncStatus('disconnected', 'P2P Error');
            return;
        }

        peerInstance.on('open', function (id) {
            console.log('[SAMC PeerJS] Client Peer opened with ID:', id);
            clientConnection = peerInstance.connect(peerId);

            clientConnection.on('open', function () {
                console.log('[SAMC PeerJS] Client connected to Host:', peerId);
                syncState.connected = true;
                syncState.mode = 'client';
                syncState.code = roomCode;

                updateSyncStatus('connected', 'Client Connected (P2P)');
                localStorage.setItem('spedo_sync_code', roomCode);

                document.getElementById('btn-sync-connect').classList.add('hide');
                document.getElementById('btn-sync-disconnect').classList.remove('hide');
                setTimeout(hideSyncModal, 800);

                const dashboard = document.getElementById('speedometer');
                if (dashboard) dashboard.classList.remove('sync-hidden');
            });

            clientConnection.on('data', function (data) {
                try {
                    const msg = typeof data === 'string' ? JSON.parse(data) : data;
                    if (msg.type === 'telemetry' && syncState.mode === 'client') {
                        const d = msg.data;
                        if (d.engine !== undefined) setEngine(d.engine);
                        if (d.speed !== undefined) setSpeed(d.speed);
                        if (d.rpm !== undefined) setRPM(d.rpm);
                        if (d.fuel !== undefined) setFuel(d.fuel);
                        if (d.health !== undefined) setHealth(d.health);
                        if (d.gear !== undefined) setGear(d.gear);
                        if (d.headlights !== undefined) setHeadlights(d.headlights);
                        if (d.leftIndicator !== undefined) setLeftIndicator(d.leftIndicator);
                        if (d.rightIndicator !== undefined) setRightIndicator(d.rightIndicator);
                        if (d.seatbelt !== undefined) setSeatbelts(d.seatbelt);
                        if (d.odometer !== undefined) setOdometer(d.odometer);
                    }
                } catch (e) {
                    console.error('[SAMC PeerJS] Data parsing error:', e);
                }
            });

            clientConnection.on('close', function () {
                console.log('[SAMC PeerJS] Host connection closed');
                resetSpeedometerValues();
                handleDisconnectState();
            });
        });

        peerInstance.on('error', function (err) {
            console.error('[SAMC PeerJS] Client error:', err);
            updateSyncStatus('disconnected', 'P2P Error: ' + (err.type || 'Host not found'));
        });
    }
}

function disconnectPeerJS() {
    if (clientConnection) {
        clientConnection.close();
        clientConnection = null;
    }
    if (peerConnections && peerConnections.length > 0) {
        peerConnections.forEach(function (c) { if (c) c.close(); });
        peerConnections = [];
    }
    if (peerInstance) {
        peerInstance.destroy();
        peerInstance = null;
    }
}

function connectWebSocket(url, role, roomCode) {
    if (syncState.socket) {
        syncState.socket.close();
    }

    updateSyncStatus('connecting', 'Connecting...');

    try {
        const socket = new WebSocket(url);
        syncState.socket = socket;

        socket.onopen = function () {
            console.log('[SAMC Sync] Connected to broker server.');
            socket.send(JSON.stringify({
                type: 'join',
                room: roomCode,
                role: role
            }));
        };

        socket.onmessage = function (event) {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === 'joined') {
                    syncState.connected = true;
                    syncState.mode = role;
                    syncState.code = roomCode;

                    updateSyncStatus('connected', role === 'host' ? 'Host Connected' : 'Client Connected');

                    localStorage.setItem('spedo_sync_url', url);
                    if (role === 'client') {
                        localStorage.setItem('spedo_sync_code', roomCode);
                    }

                    document.getElementById('btn-sync-connect').classList.add('hide');
                    document.getElementById('btn-sync-disconnect').classList.remove('hide');

                    setTimeout(hideSyncModal, 800);

                    if (role === 'client') {
                        const dashboard = document.getElementById('speedometer');
                        if (dashboard) dashboard.classList.remove('sync-hidden');
                    } else if (role === 'host') {
                        updateActivePill('Host Ready', 'Waiting for Client...');
                    }
                } else if (msg.type === 'client_connected') {
                    if (syncState.mode === 'host') {
                        const dashboard = document.getElementById('speedometer');
                        if (dashboard) {
                            dashboard.classList.add('sync-hidden');
                        }
                        updateActivePill('Syncing HUD', 'Code: ' + syncState.code);
                        const activePill = document.getElementById('sync-active-pill');
                        if (activePill) activePill.classList.remove('hide');

                        cleanupSpeedometer();
                    }
                } else if (msg.type === 'client_disconnected') {
                    if (syncState.mode === 'host') {
                        const dashboard = document.getElementById('speedometer');
                        if (dashboard) {
                            dashboard.classList.remove('sync-hidden');
                        }
                        const activePill = document.getElementById('sync-active-pill');
                        if (activePill) activePill.classList.add('hide');

                        renderDirty = true;
                        startAnimation();
                    }
                } else if (msg.type === 'host_disconnected') {
                    if (syncState.mode === 'client') {
                        resetSpeedometerValues();
                    }
                } else if (msg.type === 'telemetry') {
                    if (syncState.mode === 'client') {
                        const data = msg.data;
                        if (data.engine !== undefined) setEngine(data.engine);
                        if (data.speed !== undefined) setSpeed(data.speed);
                        if (data.rpm !== undefined) setRPM(data.rpm);
                        if (data.fuel !== undefined) setFuel(data.fuel);
                        if (data.health !== undefined) setHealth(data.health);
                        if (data.gear !== undefined) setGear(data.gear);
                        if (data.headlights !== undefined) setHeadlights(data.headlights);
                        if (data.leftIndicator !== undefined) setLeftIndicator(data.leftIndicator);
                        if (data.rightIndicator !== undefined) setRightIndicator(data.rightIndicator);
                        if (data.seatbelt !== undefined) setSeatbelts(data.seatbelt);
                        if (data.odometer !== undefined) setOdometer(data.odometer);
                    }
                } else if (msg.type === 'error') {
                    alert('Sync Error: ' + msg.message);
                    disconnectWebSocket();
                }
            } catch (e) {
                console.error('[SAMC Sync] Message parsing error:', e);
            }
        };

        socket.onclose = function () {
            console.log('[SAMC Sync] WebSocket connection closed.');
            handleDisconnectState();
        };

        socket.onerror = function (err) {
            console.error('[SAMC Sync] WebSocket error:', err);
            updateSyncStatus('disconnected', 'Connection Error');
        };

    } catch (e) {
        console.error('[SAMC Sync] Connection failed:', e);
        updateSyncStatus('disconnected', 'Connection Failed');
    }
}

function disconnectWebSocket() {
    disconnectPeerJS();
    if (syncState.socket) {
        syncState.socket.close();
        syncState.socket = null;
    }
    handleDisconnectState();
}

function handleDisconnectState() {
    syncState.connected = false;
    syncState.mode = 'none';

    updateSyncStatus('disconnected', 'Disconnected');

    const hostConn = document.getElementById('btn-host-connect');
    const hostDisc = document.getElementById('btn-host-disconnect');
    const clientConn = document.getElementById('btn-sync-connect');
    const clientDisc = document.getElementById('btn-sync-disconnect');

    if (hostConn) hostConn.classList.remove('hide');
    if (hostDisc) hostDisc.classList.add('hide');
    if (clientConn) clientConn.classList.remove('hide');
    if (clientDisc) clientDisc.classList.add('hide');

    const dashboard = document.getElementById('speedometer');
    if (dashboard) {
        dashboard.classList.remove('sync-hidden');
    }

    const activePill = document.getElementById('sync-active-pill');
    if (activePill) {
        activePill.classList.add('hide');
    }

    if (syncState.role === 'client') {
        resetSpeedometerValues();
    }
}

function setupSyncSystem() {
    const btnSync = document.getElementById('btn-sync');
    const btnSyncClose = document.getElementById('btn-sync-close');
    const tabHost = document.getElementById('sync-role-host');
    const tabClient = document.getElementById('sync-role-client');
    const panelHost = document.getElementById('sync-host-panel');
    const panelClient = document.getElementById('sync-client-panel');
    const hostCodeText = document.getElementById('sync-host-code');
    const btnCopyCode = document.getElementById('btn-copy-code');
    const clientCodeInput = document.getElementById('sync-client-code-input');
    const serverUrlInput = document.getElementById('sync-server-url');
    const btnConnect = document.getElementById('btn-sync-connect');
    const btnDisconnect = document.getElementById('btn-sync-disconnect');
    const btnRestoreHud = document.getElementById('btn-restore-hud');

    syncState.code = generateHostCode();
    if (hostCodeText) hostCodeText.textContent = syncState.code;

    if (btnSync) {
        btnSync.addEventListener('click', function (e) {
            e.stopPropagation();
            const panel = document.getElementById('sync-panel');
            if (panel) {
                panel.classList.toggle('hide');
            }
        });
    }

    if (btnSyncClose) {
        btnSyncClose.addEventListener('click', function (e) {
            e.stopPropagation();
            hideSyncModal();
        });
    }

    const cachedCode = localStorage.getItem('spedo_sync_code');
    if (cachedCode && clientCodeInput) {
        clientCodeInput.value = cachedCode;
    }

    if (tabHost) {
        tabHost.addEventListener('click', function () {
            syncState.role = 'host';
            tabHost.classList.add('active');
            if (tabClient) tabClient.classList.remove('active');
            if (panelHost) panelHost.classList.remove('hide');
            if (panelClient) panelClient.classList.add('hide');

            syncState.code = generateHostCode();
            if (hostCodeText) hostCodeText.textContent = syncState.code;
        });
    }

    if (tabClient) {
        tabClient.addEventListener('click', function () {
            syncState.role = 'client';
            tabClient.classList.add('active');
            if (tabHost) tabHost.classList.remove('active');
            if (panelClient) panelClient.classList.remove('hide');
            if (panelHost) panelHost.classList.add('hide');
        });
    }

    const btnHostConnect = document.getElementById('btn-host-connect');
    const btnHostDisconnect = document.getElementById('btn-host-disconnect');

    if (btnHostConnect) {
        btnHostConnect.addEventListener('click', function () {
            connectPeerJS('host', syncState.code);
        });
    }

    if (btnHostDisconnect) {
        btnHostDisconnect.addEventListener('click', function () {
            disconnectWebSocket();
        });
    }

    if (btnConnect) {
        btnConnect.addEventListener('click', function () {
            let code = clientCodeInput ? clientCodeInput.value.trim().toUpperCase() : '';
            if (!code || code.length !== 6) {
                alert('Please enter a valid 6-character pairing code');
                return;
            }

            let customUrl = serverUrlInput ? serverUrlInput.value.trim() : '';
            if (customUrl && (customUrl.startsWith('ws://') || customUrl.startsWith('wss://'))) {
                connectWebSocket(customUrl, 'client', code);
            } else {
                connectPeerJS('client', code);
            }
        });
    }

    if (btnDisconnect) {
        btnDisconnect.addEventListener('click', function () {
            disconnectWebSocket();
        });
    }

    if (btnRestoreHud) {
        btnRestoreHud.addEventListener('click', function (e) {
            e.stopPropagation();
            disconnectWebSocket();
        });
    }

    // Auto-connect via URL Query Parameters (useful for CEF games like RageMP)
    const urlParams = new URLSearchParams(window.location.search);
    const paramMode = urlParams.get('mode') || urlParams.get('role'); // 'host' or 'client'
    const paramCode = urlParams.get('code'); // e.g. 'ABC123'
    const paramServer = urlParams.get('server'); // e.g. 'ws://pc-elkom-cachyos:8080'

    if (paramMode) {
        const mode = paramMode.toLowerCase();
        if (mode === 'host') {
            syncState.role = 'host';
            if (tabHost) tabHost.classList.add('active');
            if (tabClient) tabClient.classList.remove('active');
            if (panelHost) panelHost.classList.remove('hide');
            if (panelClient) panelClient.classList.add('hide');

            if (paramCode) {
                syncState.code = paramCode.toUpperCase();
                if (hostCodeText) hostCodeText.textContent = syncState.code;
            }
        } else if (mode === 'client') {
            syncState.role = 'client';
            if (tabClient) tabClient.classList.add('active');
            if (tabHost) tabHost.classList.remove('active');
            if (panelClient) panelClient.classList.remove('hide');
            if (panelHost) panelHost.classList.add('hide');

            if (paramCode) {
                if (clientCodeInput) clientCodeInput.value = paramCode.toUpperCase();
            }
        }

        const finalCode = mode === 'host' ? syncState.code : (paramCode ? paramCode.toUpperCase() : '');

        if (finalCode && finalCode.length === 6) {
            console.log('[SAMC Sync] Auto-connecting from query parameters: Mode=' + mode + ', Room=' + finalCode);
            setTimeout(function () {
                if (paramServer && (paramServer.startsWith('ws://') || paramServer.startsWith('wss://'))) {
                    connectWebSocket(paramServer, mode, finalCode);
                } else {
                    connectPeerJS(mode, finalCode);
                }
            }, 100);
        }
    }
}
