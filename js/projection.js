/* ============================================================
   PROJECTION.JS — image pipeline + projection orchestration
   Ties the image pipeline (runPipeline), the raytracer, auto-depth,
   and the flat-layout export builders (nested acrylic layout / Box
   Mode wrap strip) together, and triggers 3D + 2D preview redraws.
   Depends on: state/sourceImg (app.js), raycastPanel/computeProjection
   (raytracer.js), removeSmallComponents (coverage.js), marchingSquares
   /panelCutoutPaths/etc (contour.js), rebuild3DScene/renderPanels
   (preview3d.js), showToast/hideToast (ui.js)
   ============================================================ */

const AUTO_DEPTH_MARGIN = 10; // mm of structural margin added beyond LED Z when Depth is on Auto

function syncAutoDepth(){
  // Depth only ever needs to reach LED Z — anything deeper is dead panel
  // area that can never receive light back onto the wall (see LED Position
  // notes). When Auto is on, Depth just tracks LED Z + a fixed margin.
  if(!state.autoDepth) return;
  const lo = parseFloat($('boxD').min), hi = parseFloat($('boxD').max);
  const newD = Math.min(hi, Math.max(lo, state.ledZ + AUTO_DEPTH_MARGIN));
  if(newD !== state.boxD){
    state.boxD = newD;
    $('boxD').value = newD;
    $('v-boxD').value = Math.round(newD);
  }
}

function toggleAutoDepth(){
  state.autoDepth = !state.autoDepth;
  $('t-autoDepth').classList.toggle('on', state.autoDepth);
  const slider = $('boxD'), input = $('v-boxD'), hint = $('autoDepthHint');
  slider.disabled = state.autoDepth;
  input.disabled = state.autoDepth;
  slider.style.opacity = state.autoDepth ? '0.4' : '1';
  input.style.opacity = state.autoDepth ? '0.4' : '1';
  if(state.autoDepth){
    syncAutoDepth();
    hint.textContent = `On — hugs the deepest actual cutout content (never past LED Z) + ${AUTO_DEPTH_MARGIN}mm margin.`;
  } else {
    hint.textContent = 'Off — Depth is set manually.';
  }
  forceRecompute('geom');
}

// Scans a panel's finished mask for the deepest row (largest v, i.e. closest
// to the front opening) that actually has a cutout pixel. Returns -1 if the
// panel has no cutout at all.
function findPanelMaxRow(p){
  for(let row=p.h-1; row>=0; row--){
    for(let col=0; col<p.w; col++){
      if(p.mask[row*p.w+col]===1) return row;
    }
  }
  return -1;
}

// Content-aware Depth: instead of trusting only the theoretical LED-Z upper
// bound (which is often much deeper than any silhouette content actually
// reaches — the wasted-material gap reported earlier), measure how deep the
// real cutouts go across all 4 side panels and hug THAT instead.
function measureTightDepth(proj, currentBoxD){
  const sideKeys = ['top','bottom','left','right'];
  let maxRow=-1, refH=0;
  for(const k of sideKeys){
    const p = proj.panels[k];
    refH = p.h; // identical for every side panel (= boxD * PX_PER_MM)
    const r = findPanelMaxRow(p);
    if(r>maxRow) maxRow=r;
  }
  if(maxRow<0 || refH<=0) return null; // no cutout anywhere — keep the theoretical bound instead
  const vMM = ((maxRow+1)/refH) * currentBoxD;
  const lo = parseFloat($('boxD').min), hi = parseFloat($('boxD').max);
  let tight = vMM + AUTO_DEPTH_MARGIN;
  tight = Math.max(tight, state.deviceH + AUTO_DEPTH_MARGIN); // never shrink past the clearance zone
  tight = Math.min(hi, Math.max(lo, tight));
  return Math.ceil(tight);
}

/* ============================================================
   UI WIRING
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

// Heavy work only ever runs on RELEASE (change event) or a typed/committed
// value — never on every 'input' tick while dragging. Continuously
// recomputing mid-drag (even debounced) was what made sliders feel choppy,
// especially at high Shadow Scale where a single recompute can take
// noticeably longer — which also made offset/position changes look like
// they "did nothing" (the recompute just hadn't caught up yet).
let recomputeTimer=null;
function runHeavy(kind){
  clearTimeout(recomputeTimer);
  showToast(kind==='image' ? 'Processing image…' : 'Updating…');
  recomputeTimer = setTimeout(()=>{
    try{
      if(kind==='image') runPipeline(); else computeProjectionAndRender();
    } catch(err){
      console.error('Recompute failed:', err);
      showToast('Error: could not update');
      setTimeout(hideToast, 2000);
      return;
    }
    hideToast();
  }, 30);
}
function forceRecompute(kind){ runHeavy(kind); }

/* ============================================================
   PIPELINE: threshold -> noise removal -> mask
   ============================================================ */
function runPipeline(){
  if(!state.hasImage && !sourceImg) sourceImg = buildPlaceholderSilhouette();
  const res = Math.round(state.resolution);

  // SVGs (and occasionally other files) can report naturalWidth/naturalHeight
  // as 0 when no explicit width/height/viewBox is set. Fall back to a sane
  // square default instead of letting NaN propagate through the mask sizing.
  const rawW = sourceImg.naturalWidth || sourceImg.width || 0;
  const rawH = sourceImg.naturalHeight || sourceImg.height || 0;
  const iw = rawW > 0 ? rawW : 800;
  const ih = rawH > 0 ? rawH : 800;

  let mw,mh;
  if(iw>=ih){ mw=res; mh=Math.max(1,Math.round(res*ih/iw)); } else { mh=res; mw=Math.max(1,Math.round(res*iw/ih)); }

  const off = document.createElement('canvas'); off.width=mw; off.height=mh;
  const octx = off.getContext('2d');
  octx.fillStyle = '#ffffff'; octx.fillRect(0,0,mw,mh);
  octx.drawImage(sourceImg,0,0,mw,mh);
  const data = octx.getImageData(0,0,mw,mh).data;

  const mask = new Uint8Array(mw*mh);
  const cutoff = state.thresholdEnabled ? state.threshold : 128; // fixed neutral midpoint when threshold adjustment is off
  for(let i=0;i<mw*mh;i++){
    const r=data[i*4],g=data[i*4+1],b=data[i*4+2],a=data[i*4+3];
    const lum = 0.299*r+0.587*g+0.114*b;
    let v = (a<10) ? 0 : (lum < cutoff ? 1 : 0);
    if(state.invert) v = 1-v;
    mask[i]=v;
  }
  if(state.noise>0) removeSmallComponents(mask, mw, mh, state.noise, state.noiseMode);

  state.mask=mask; state.maskW=mw; state.maskH=mh;
  renderSourceCanvas();
  computeProjectionAndRender();
}

function renderSourceCanvas(){
  const cv = $('srcCanvas'); const mw=state.maskW, mh=state.maskH;
  cv.width=mw; cv.height=mh;
  const ctx = cv.getContext('2d');
  const imgData = ctx.createImageData(mw,mh);
  for(let i=0;i<mw*mh;i++){
    const v = state.mask[i]; const c = v? 12:236;
    imgData.data[i*4]=c; imgData.data[i*4+1]=v?18:242; imgData.data[i*4+2]=v?16:238; imgData.data[i*4+3]=255;
  }
  ctx.putImageData(imgData,0,0);
  cv.style.width = '100%'; cv.style.maxWidth='420px';
}

/* ============================================================
   RENDERING
   ============================================================ */
function computeProjectionAndRender(){
  syncAutoDepth(); // sets Depth to the theoretical LED-Z + margin upper bound, if Auto is on
  let proj = computeProjection();
  if(state.autoDepth){
    const tight = measureTightDepth(proj, state.boxD);
    if(tight !== null && tight < state.boxD){
      state.boxD = tight;
      $('boxD').value = tight;
      $('v-boxD').value = Math.round(tight);
      proj = computeProjection(); // re-run once at the tighter depth for accurate final geometry
    }
  }
  state.panels = proj;
  rebuild3DScene(proj);
  renderPanels(proj);
  updateClearanceWarning();
}

function updateClearanceWarning(){
  // A panel can only ever receive light between the wall (v=0) and the LED's
  // own depth (v=ledZ) — a point light can't cast back onto a wall from a
  // panel point that's further from the wall than the light itself. So if
  // Device Clearance reaches (or passes) LED Z, that panel has zero usable
  // depth left and will come out completely blank, regardless of the artwork.
  const box = $('clearanceWarning');
  if(state.deviceH >= state.ledZ){
    box.classList.remove('hidden');
    box.textContent = `Device Clearance (${Math.round(state.deviceH)}mm) is at or beyond LED Z (${Math.round(state.ledZ)}mm) — a panel can only show cutouts between the wall and the LED's own depth, so every panel will come out fully blank. Raise LED Z above ${Math.round(state.deviceH)}mm to leave room for the silhouette.`;
  } else if(state.ledZ - state.deviceH < 15){
    box.classList.remove('hidden');
    box.textContent = `Only ${Math.round(state.ledZ-state.deviceH)}mm of usable depth is left between Device Clearance and LED Z — the cutout area will be very thin. Consider raising LED Z.`;
  } else {
    box.classList.add('hidden');
  }
}

/* ============================================================
   EXPORT
   ============================================================ */
function buildPipeBoxStrip(){
  // Box Mode export: ONE continuous strip, width = exact box circumference
  // (boxW + boxH + boxW + boxH), height = the panel depth. No finger joints
  // (this gets printed on paper and wrapped/glued around an existing
  // plastic box or pipe) — plus dashed guide lines at each of the 3 internal
  // corners so the person knows exactly where to fold/align the paper.
  const proj = state.panels;
  const boxW=state.boxW, boxH=state.boxH, boxD=state.boxD;
  const depth = proj.effectiveDepth || boxD;

  // Mirror flags fixed to match actual seam geometry (verified numerically):
  // going clockwise Top->Right->Bottom->Left, only Right and Bottom need
  // their content reversed for the shared corner to land at the same
  // absolute position as its neighbor. Top and Left already run the correct
  // direction naturally. (Previously Top/Bottom were mirrored and Right/Left
  // weren't — that put the Top-Right seam's shared corner pixels ~150mm
  // apart instead of touching.)
  const seq = [
    {key:'top',    dimW:boxW, mirror:false},
    {key:'right',  dimW:boxH, mirror:true},
    {key:'bottom', dimW:boxW, mirror:true},
    {key:'left',   dimW:boxH, mirror:false}
  ];

  let xCursor = 0;
  const placed = [];
  const guides = []; // vertical dashed corner-reference lines, drawn separately from the cut paths

  seq.forEach((s) => {
    const localW = s.dimW;
    const outline = buildPlainOutline(localW, depth);
    const cutouts = getCutoutPolygonsMM(proj.panels[s.key], localW, boxD);

    const mirror = s.mirror;
    const tOutline = outline.map(([x, y]) => [x + xCursor, y]); // never mirrored (matches the acrylic-mode convention)
    const tCutouts = cutouts.map(poly => poly.map(([x, y]) => {
      const mx = mirror ? (localW - x) : x;
      return [mx + xCursor, y];
    }));

    placed.push({ key: s.key, outline: tOutline, cutouts: tCutouts, x0: xCursor, x1: xCursor + localW });
    xCursor += localW;
    guides.push([[xCursor,0],[xCursor,depth]]); // corner guide at the end of this panel
  });

  guides.pop(); // the last one is the strip's own outer-right edge, not an internal corner — drop it

  const totalW = xCursor, totalH = depth;
  return { placed, totalW, totalH, guides };
}

function buildNestedLayout(){
  if(state.boxMode) return buildPipeBoxStrip();
  const proj = state.panels;
  const boxW=state.boxW, boxH=state.boxH, boxD=state.boxD, thick=state.thick, tab=state.tab;
  // When Invert Cutout trims the panels shorter than the declared box depth,
  // every side panel's OUTLINE (not the hole data, which is unaffected)
  // should stop there too — otherwise the leftover rectangular frame beyond
  // the content is exactly what was casting the unwanted boxy/"X" shape.
  const depth = proj.effectiveDepth || boxD;

  // Strip order per spec: Top, Right, Bottom, Left, zero-gap, left to right.
  // Mirror flags fixed to match actual seam geometry (verified numerically):
  // only Right and Bottom need their content reversed for the shared corner
  // to land at the same absolute position as its neighbor. Previously
  // Top/Bottom were mirrored and Right/Left weren't, which put the Top-Right
  // seam's shared corner pixels far apart instead of touching.
  const seq = [
    {key:'top',    dimW:boxW, mirror:false},
    {key:'right',  dimW:boxH, mirror:true},
    {key:'bottom', dimW:boxW, mirror:true},
    {key:'left',   dimW:boxH, mirror:false}
  ];

  // NOTE on mirroring: only the CUTOUT silhouette is mirrored for Top/Bottom
  // (so the artwork reads correctly once folded into 3D) — the structural
  // outline/finger-joints are left un-mirrored. Mirroring the outline too
  // would swap which physical edge ends up touching which neighbor in the
  // flat layout and break every adjacency assumption below.

  const sidePanelWallPhase = false; // baseline phase for every side panel's wall-side (back-plate-facing) edge

  function cutoutsFor(key, dimW){
    return getCutoutPolygonsMM(proj.panels[key], dimW, boxD);
  }

  // The wrap-around seam (Top's left edge <-> Left's right edge) is the one
  // seam that is NOT adjacent in the flat strip, so it can't literally share
  // one path — its phases are matched explicitly via matingPhase() instead.
  const nWrap = tabCount(depth, tab);
  const topLeftPhase = false;
  const leftRightPhase = matingPhase(nWrap, topLeftPhase);

  let xCursor = 0;
  let carryLeftEdge = null; // the previous panel's right edge, reused verbatim as this panel's left edge
  const placed = [];

  seq.forEach((s, i) => {
    const localW = s.dimW;
    const top = zigzag('h', 0, 0, localW, thick, tab, -1, sidePanelWallPhase);
    const bottom = flatEdge('h', depth, localW, 0); // front/opening face: always flat, zero interlock

    let left, right;
    if (i === 0) {
      // Top panel's own left edge = one half of the wrap-around seam
      left = zigzag('v', 0, depth, 0, thick, tab, -1, topLeftPhase);
    } else {
      // Shared seam: literally the same points as the previous panel's right
      // edge (just reversed for correct winding) — cannot collide with itself.
      left = carryLeftEdge;
    }

    if (i === seq.length - 1) {
      // Left panel's right edge = the other half of the wrap-around seam,
      // phase computed to be the exact complement of Top's left edge.
      right = zigzag('v', localW, 0, depth, thick, tab, 1, leftRightPhase);
    } else {
      right = zigzag('v', localW, 0, depth, thick, tab, 1, sidePanelWallPhase);
      // Reuse the exact same curve (just reversed + re-based to this panel's
      // local x=0) as the NEXT panel's left edge. Subtracting localW (not
      // forcing every point to 0) is what preserves the tab bumps — the two
      // edges are then mathematically the same dividing line, so there is no
      // separate "phase" to get wrong and no way for them to collide.
      carryLeftEdge = right.slice().reverse().map(([x, y]) => [x - localW, y]);
    }

    const outline = top.concat(right.slice(1)).concat(bottom.slice(1)).concat(left.slice(1));
    const cutouts = cutoutsFor(s.key, localW);

    const mirror = s.mirror;
    const tOutline = outline.map(([x, y]) => [x + xCursor, y]); // never mirrored
    const tCutouts = cutouts.map(poly => poly.map(([x, y]) => {
      const mx = mirror ? (localW - x) : x; // mirror the silhouette content only
      return [mx + xCursor, y];
    }));

    placed.push({ key: s.key, outline: tOutline, cutouts: tCutouts, x0: xCursor, x1: xCursor + localW });
    xCursor += localW;
  });

  const stripW = xCursor, stripH = depth;

  // --- Back Plate: nested beneath the Top panel's footprint to reuse sheet
  // area. NOTE: a small gap is required here — the Back Plate's own top edge
  // has finger-joint teeth (it mates with Top's WALL-side edge in the real
  // 3D assembly), but in this flat layout it merely sits near Top's FRONT/
  // OPENING edge, which is deliberately flat. Placing them with zero gap let
  // the teeth overlap straight into that flat line, corrupting the cut path.
  // The Back Plate itself always stays full boxW x boxH — it mounts flush to
  // the wall regardless of how short the side panels get trimmed.
  //
  // Phase fix: the Back Plate's edges and each side panel's wall edge are
  // BOTH traversed in the same left-to-right direction (unlike the
  // wrap-around seam, which runs in opposite directions) — so the correct
  // mating phase is simply the opposite, always. matingPhase()'s even/odd
  // rule doesn't apply here; using it was wrong whenever the tooth count came
  // out even (e.g. the default boxW=200mm/tab=10mm -> exactly 20 teeth ->
  // teeth collided instead of interlocking on assembly).
  const backPhases = { top:true, bottom:true, left:true, right:true };
  const backOutlineLocal = buildBackPlateOutline(boxW, boxH, thick, tab, backPhases);
  const backGap = thick + 3; // clears the top-edge teeth (which protrude by `thick`) plus a safety buffer
  const backX0 = placed[0].x0; // sits under the Top panel (also width boxW)
  const backY0 = stripH + backGap;
  const backOutline = backOutlineLocal.map(([x, y]) => [x + backX0, y + backY0]);
  const wireHoleR = Math.max(3, thick * 1.5);
  const wireHole = regularPolygon(boxW/2 + backX0, boxH/2 + backY0, wireHoleR, 28);
  placed.push({ key:'back', outline: backOutline, cutouts:[wireHole], x0:backX0, x1:backX0+boxW });

  const totalW = stripW;
  const totalH = stripH + backGap + boxH;
  return { placed, totalW, totalH, guides:[] };
}
