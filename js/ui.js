/* ============================================================
   UI.JS — DOM wiring, toggles, image upload, export modal
   Depends on: state/$ (app.js), forceRecompute/runPipeline (projection.js)
   ============================================================ */

/* ============================================================
   UI WIRING CONFIG
   ============================================================ */
const sliderMap = [
  ['threshold','threshold',0,'image'], ['noise','noise',0,'image'], ['resolution','resolution',0,'image'],
  ['smoothing','smoothing',1,'geom'], ['boxW','boxW',0,'geom'], ['boxH','boxH',0,'geom'], ['boxD','boxD',0,'geom'],
  ['ledZ','ledZ',0,'geom'], ['ledX','ledX',0,'geom'], ['ledY','ledY',0,'geom'], ['deviceH','deviceH',0,'geom'],
  ['scale','scale',1,'geom'], ['offX','offX',0,'geom'], ['offY','offY',0,'geom'], ['boxRot','boxRot',0,'geom'], ['shadowRot','shadowRot',0,'geom'],
  ['thick','thick',1,'geom'], ['tab','tab',0,'geom']
];
const labelIdMap = { threshold:'v-threshold', noise:'v-noise', resolution:'v-res', smoothing:'v-smooth',
  boxW:'v-boxW', boxH:'v-boxH', boxD:'v-boxD', ledZ:'v-ledZ', ledX:'v-ledX', ledY:'v-ledY', deviceH:'v-deviceH',
  scale:'v-scale', offX:'v-offX', offY:'v-offY', boxRot:'v-boxRot', shadowRot:'v-shadowRot',
  thick:'v-thick', tab:'v-tab' };

function toggleSection(id){ $(id).classList.toggle('collapsed'); }
function toggleBool(key){
  state[key] = !state[key];
  $('t-invert').classList.toggle('on', state.invert);
  forceRecompute('image');
}

function toggleInvertCutout(){
  state.invertCutout = !state.invertCutout;
  $('t-invertCutout').classList.toggle('on', state.invertCutout);
  forceRecompute('geom');
}

function toggleBoxMode(){
  state.boxMode = !state.boxMode;
  $('t-boxMode').classList.toggle('on', state.boxMode);
  $('thickTabGroup').style.display = state.boxMode ? 'none' : '';
  $('boxModeHint').textContent = state.boxMode
    ? "On — Back Plate is skipped, panel outlines are plain (no finger joints), and Export gives one continuous wrap-around strip sized to the box's exact circumference, ready to print and glue/tape on."
    : "Off — designs a laser-cut acrylic box from scratch, with finger-joint interlocks and a Back Plate. Turn on if you already have a plastic box/tube and just want a wrap-around paper pattern to drill or cut by hand.";
  forceRecompute('geom');
}

function toggleThresholdEnabled(){
  state.thresholdEnabled = !state.thresholdEnabled;
  $('t-thresholdEnabled').classList.toggle('on', state.thresholdEnabled);
  const slider = $('threshold'), input = $('v-threshold'), hint = $('thresholdEnabledHint');
  slider.disabled = !state.thresholdEnabled;
  input.disabled = !state.thresholdEnabled;
  slider.style.opacity = state.thresholdEnabled ? '1' : '0.4';
  input.style.opacity = state.thresholdEnabled ? '1' : '0.4';
  hint.textContent = state.thresholdEnabled
    ? "On — the slider below adjusts the black/white cutoff. Turn off if your image is already a clean silhouette (e.g. pre-edited elsewhere) and you don't want it re-thresholded."
    : "Off — using your image's black/white pixels as-is (fixed midpoint, ignoring the slider). Best for images already prepared as a clean silhouette elsewhere.";
  forceRecompute('image');
}
function showToast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); }
function hideToast(){ $('toast').classList.remove('show'); }
function loadImageFile(file){
  showToast('Processing image…');

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = ()=>{
    sourceImg = img;
    state.hasImage = true;
    // Yield to the browser first so the "Processing…" toast actually paints
    // before we run the heavy synchronous threshold/ray-tracing pipeline.
    setTimeout(()=>{
      try{
        runPipeline();
        hideToast();
      } catch(err){
        console.error('Pipeline failed:', err);
        showToast('Error: could not process this image');
        setTimeout(hideToast, 2500);
      } finally {
        URL.revokeObjectURL(url);
      }
    }, 50);
  };

  img.onerror = ()=>{
    console.error('Image failed to load:', file && file.name);
    showToast('Error: Invalid image file');
    setTimeout(hideToast, 2500);
    URL.revokeObjectURL(url);
    // Don't touch state.hasImage / sourceImg — keep whatever was working before.
  };

  img.src = url;
}

/* build a default placeholder silhouette so the app has something to show before upload */
function buildPlaceholderSilhouette(){
  const c = document.createElement('canvas'); c.width=400; c.height=400;
  const ctx = c.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,400,400);
  ctx.fillStyle='#000';
  ctx.beginPath();
  ctx.arc(200,150,70,0,Math.PI*2); // head
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(140,210); ctx.quadraticCurveTo(120,320,150,380); ctx.lineTo(250,380);
  ctx.quadraticCurveTo(280,320,260,210); ctx.closePath(); ctx.fill();
  const img = new Image(); img.src = c.toDataURL();
  return img;
}

function openExport(){ $('exportModal').classList.remove('hidden'); }
function closeExport(){ $('exportModal').classList.add('hidden'); }

/* ============================================================
   INIT UI — wires all DOM event listeners. Called once from
   app.js after every module has finished loading, so this never
   has to worry about <script> tag load order.
   ============================================================ */
function initUI(){
  sliderMap.forEach(([elId,key,decimals,kind])=>{
    const slider = $(elId);
    const oldLabel = $(labelIdMap[key]);

    // Upgrade the read-only value span into a typable number input.
    const input = document.createElement('input');
    input.type = 'number';
    input.id = oldLabel.id;
    input.className = 'valinput';
    input.inputMode = 'decimal';
    input.min = slider.min; input.max = slider.max;
    input.step = slider.step && slider.step !== 'any' ? slider.step : (decimals ? (1/Math.pow(10,decimals)) : 1);
    input.value = decimals ? parseFloat(slider.value).toFixed(decimals) : Math.round(parseFloat(slider.value));
    oldLabel.replaceWith(input);

    function applyValue(v){
      const lo=parseFloat(slider.min), hi=parseFloat(slider.max);
      if(isNaN(v)) v = state[key];
      v = Math.min(hi, Math.max(lo, v));
      state[key]=v;
      slider.value=v;
      input.value = decimals ? v.toFixed(decimals) : Math.round(v);
      if(key==='thick'){ $('v-ledCorrection').textContent = (state.thick*2).toFixed(1); }
      return v;
    }

    // Dragging: ONLY move the thumb + update the number field. No geometry
    // recompute at all here — this is what keeps the drag itself perfectly smooth.
    slider.addEventListener('input', ()=>{ applyValue(parseFloat(slider.value)); });
    // Release: the one and only point where the heavy recompute actually runs.
    slider.addEventListener('change', ()=>{ applyValue(parseFloat(slider.value)); forceRecompute(kind); });
    // Typed value: commit on Enter or on leaving the field.
    input.addEventListener('change', ()=>{ applyValue(parseFloat(input.value)); forceRecompute(kind); });
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ input.blur(); } });
  });
  $('v-ledCorrection').textContent = (state.thick*2).toFixed(1);


  document.querySelectorAll('#seg-dots button').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.querySelectorAll('#seg-dots button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active'); state.noiseMode = b.dataset.v; forceRecompute('image');
    });
  });

  $('dropZone').addEventListener('click', ()=> $('fileInput').click());
  $('fileInput').addEventListener('change', (e)=>{
    const f = e.target.files[0]; if(!f) return;
    $('fileLabel').textContent = f.name;
    loadImageFile(f);
  });

  $('btnExport').addEventListener('click', openExport);
  $('exportModal').addEventListener('click', (e)=>{ if(e.target.id==='exportModal') closeExport(); });
}
