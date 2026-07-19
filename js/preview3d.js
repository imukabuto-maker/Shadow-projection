/* ============================================================
   PREVIEW3D.JS — Three.js live preview + flat 2D panel cards
   Purely visual: rebuild3DScene()/updateWallTexture() never touch
   proj.panels, so nothing here can affect the exported cut files.
   Depends on: state (app.js), buildPanelOutline/buildPlainOutline/
   buildBackPlateOutline/panelCutoutPaths/pathDFromPoints (contour.js)
   ============================================================ */

function initThreeScene(){
  if(scene3D.ready || typeof THREE==='undefined') return;
  const canvas = $('scene3d');
  if(!canvas) return;

  const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:false});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04100c);

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);

  scene.add(new THREE.AmbientLight(0x224433, 0.9));
  const ledLight = new THREE.PointLight(0xffcc66, 2.2, 0, 2);
  ledLight.castShadow = true;
  ledLight.shadow.mapSize.set(1024,1024);
  ledLight.shadow.camera.near = 1;
  ledLight.shadow.camera.far = 3000;
  ledLight.shadow.bias = -0.002;
  scene.add(ledLight);
  const ledMesh = new THREE.Mesh(
    new THREE.SphereGeometry(4,12,12),
    new THREE.MeshBasicMaterial({color:0xffcc66})
  );
  scene.add(ledMesh);

  // The wall's appearance is driven entirely by OUR OWN raycasting result
  // (baked into a canvas texture below), not by Three.js's automatic
  // point-light shadow physics. The real shadow system lets light leak
  // around the box's finite panel edges at wide angles (since the panels
  // don't fully enclose the LED) — producing a stray "X" of light on the
  // wall that has nothing to do with the actual cutout data. Using an unlit
  // texture here guarantees the wall only ever shows what our raycasting
  // model says it should, matching the 2D panel layout exactly.
  const wallCanvas = document.createElement('canvas');
  wallCanvas.width = 768; wallCanvas.height = 768;
  const wallTexture = new THREE.CanvasTexture(wallCanvas);
  wallTexture.minFilter = THREE.LinearFilter; // smooth interpolation instead of blocky nearest-neighbor when zoomed in
  wallTexture.magFilter = THREE.LinearFilter;
  const wallMat = new THREE.MeshBasicMaterial({map: wallTexture});
  const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(4000,4000), wallMat);
  wallMesh.receiveShadow = false;
  scene.add(wallMesh);

  const panelGroup = new THREE.Group();
  scene.add(panelGroup);

  const camState = { radius:400, theta:0.7, phi:1.05, target:new THREE.Vector3(0,0,40), minR:80, maxR:2500 };
  function applyCam(){
    const {radius,theta,phi,target} = camState;
    camera.position.set(
      target.x + radius*Math.sin(phi)*Math.sin(theta),
      target.y + radius*Math.cos(phi),
      target.z + radius*Math.sin(phi)*Math.cos(theta)
    );
    camera.lookAt(target);
  }
  function draw(){ applyCam(); renderer.render(scene, camera); }

  // --- pointer drag (mouse + single touch) to orbit ---
  let dragging=false, lastX=0, lastY=0;
  canvas.addEventListener('pointerdown', e=>{ dragging=true; lastX=e.clientX; lastY=e.clientY; try{canvas.setPointerCapture(e.pointerId);}catch(err){} });
  canvas.addEventListener('pointermove', e=>{
    if(!dragging) return;
    const dx=e.clientX-lastX, dy=e.clientY-lastY;
    lastX=e.clientX; lastY=e.clientY;
    camState.theta -= dx*0.008;
    camState.phi = Math.min(Math.PI-0.05, Math.max(0.05, camState.phi - dy*0.008));
    draw();
  });
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>canvas.addEventListener(ev, ()=>{ dragging=false; }));

  // --- wheel zoom (desktop) ---
  canvas.addEventListener('wheel', e=>{
    e.preventDefault();
    camState.radius = Math.min(camState.maxR, Math.max(camState.minR, camState.radius*(1+e.deltaY*0.0012)));
    draw();
  }, {passive:false});

  // --- pinch zoom (two-finger touch) ---
  let pinchStartDist=null, pinchStartRadius=null;
  function touchDist(t){ return Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY); }
  canvas.addEventListener('touchstart', e=>{
    if(e.touches.length===2){ dragging=false; pinchStartDist=touchDist(e.touches); pinchStartRadius=camState.radius; }
  }, {passive:true});
  canvas.addEventListener('touchmove', e=>{
    if(e.touches.length===2 && pinchStartDist){
      e.preventDefault();
      const d = touchDist(e.touches);
      camState.radius = Math.min(camState.maxR, Math.max(camState.minR, pinchStartRadius*(pinchStartDist/d)));
      draw();
    }
  }, {passive:false});
  canvas.addEventListener('touchend', e=>{ if(e.touches.length<2) pinchStartDist=null; }, {passive:true});

  function resize(){
    const w = canvas.clientWidth||300, h = canvas.clientHeight||300;
    if(w<=0||h<=0) return;
    renderer.setSize(w,h,false);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    draw();
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);

  $('btnResetView').addEventListener('click', ()=>{
    camState.theta=0.7; camState.phi=1.05;
    camState.radius = scene3D.defaultRadius || 400;
    draw();
  });

  scene3D.ready = true;
  Object.assign(scene3D, {renderer, scene, camera, ledLight, ledMesh, wallMesh, wallCanvas, wallTexture, panelGroup, camState, draw, resize});
  resize();
}

function pointInPolygonMM(x, y, poly){
  // Standard ray-casting point-in-polygon test.
  let inside = false;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
    if(((yi>y) !== (yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}

function buildPipeMesh3D(pipePanel, R, depth, matColor){
  // Every quad is computed directly in cylindrical coordinates from the
  // start (angle -> R*cos/R*sin, no separate flat-shape-then-bend stage —
  // that approach kept producing distorted geometry). Solid/cutout is
  // decided with a point-in-polygon test against the SAME smooth vector
  // hole outlines (getCutoutPolygonsMM) that drive the 2D "laser-cut panel"
  // card and the exported SVG/DXF/PDF, so cell edges follow the real cutout
  // shape rather than the raw raster mask.
  const circumference = 2*Math.PI*R;
  const holes = getCutoutPolygonsMM(pipePanel, circumference, depth).filter(h => polygonAreaMM(h) > 0.05);

  function isCutout(u, v){
    for(const hole of holes) if(pointInPolygonMM(u, v, hole)) return true;
    return false;
  }

  const segU = 120;
  const segV = Math.max(8, Math.round(depth/2));
  const positions=[], normals=[], indices=[];
  let vi=0;
  for(let i=0;i<segU;i++){
    const u0=(i/segU)*circumference, u1=((i+1)/segU)*circumference;
    const th0=u0/R, th1=u1/R;
    for(let j=0;j<segV;j++){
      const v0=(j/segV)*depth, v1=((j+1)/segV)*depth;
      const uc=(u0+u1)/2, vc=(v0+v1)/2;
      if(isCutout(uc,vc)) continue; // cell falls inside a cutout polygon -> leave a gap
      const p00=[R*Math.cos(th0), R*Math.sin(th0), v0];
      const p10=[R*Math.cos(th1), R*Math.sin(th1), v0];
      const p11=[R*Math.cos(th1), R*Math.sin(th1), v1];
      const p01=[R*Math.cos(th0), R*Math.sin(th0), v1];
      const nx=Math.cos((th0+th1)/2), ny=Math.sin((th0+th1)/2);
      for(const p of [p00,p10,p11,p01]) positions.push(...p);
      for(let k=0;k<4;k++) normals.push(nx,ny,0);
      indices.push(vi,vi+1,vi+2, vi,vi+2,vi+3);
      vi+=4;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals,3));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({color:matColor, side:THREE.DoubleSide});
  return new THREE.Mesh(geo, mat);
}

function buildPanelMesh(polyOutlineMM, holePolysMM, offsetU, thickness, basis, position, matColor){
  const shape = new THREE.Shape();
  polyOutlineMM.forEach(([u,v],i)=>{ const x=u-offsetU; if(i===0) shape.moveTo(x,v); else shape.lineTo(x,v); });
  shape.closePath();
  holePolysMM.forEach(hole=>{
    const path = new THREE.Path();
    hole.forEach(([u,v],i)=>{ const x=u-offsetU; if(i===0) path.moveTo(x,v); else path.lineTo(x,v); });
    path.closePath();
    shape.holes.push(path);
  });
  const geo = new THREE.ExtrudeGeometry(shape, {depth:thickness, bevelEnabled:false, curveSegments:1, steps:1});
  const m = new THREE.Matrix4();
  m.makeBasis(basis.x, basis.y, basis.z);
  m.setPosition(position.x, position.y, position.z);
  geo.applyMatrix4(m);
  const mat = new THREE.MeshBasicMaterial({color:matColor, side:THREE.DoubleSide});
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}

function updateWallTexture(proj, boxW, boxH, boxD, depth){
  const cv = scene3D.wallCanvas;
  const res = cv.width; // 768
  const ctx = cv.getContext('2d');
  const margin = 2.0; // tighter than before -> more effective resolution per mm
  const viewW = proj.wallImgW*margin, viewH = proj.wallImgH*margin;
  const imgData = ctx.createImageData(res,res);

  const cosA=Math.cos(state.boxRot*DEG*-1), sinA=Math.sin(state.boxRot*DEG*-1);
  const Lx=proj.led.x, Ly=proj.led.y, Lz=proj.led.z;
  const DARK=[8,10,9], TEAL=[26,95,80];

  // 2x2 jittered sub-samples per output texel, averaged -> soft/anti-aliased
  // edges instead of hard raster jaggies, and less chance of a thin sliver of
  // content falling entirely between sample points.
  const SS=2, offs=[-0.25,0.25];
  function sampleLit(px,py){
    const wx = (px/res-0.5)*viewW;
    const wy = -(py/res-0.5)*viewH;
    const bx = wx*cosA - wy*sinA;
    const by = wx*sinA + wy*cosA;
    if(proj.isPipe){
      const hit = raycastCylinder(Lx,Ly,Lz, bx,by,0, proj.R, boxD);
      if(!hit) return 0;
      const p = proj.panels.pipe;
      let ppx = Math.floor((hit.u/proj.circumference)*p.w), ppy=Math.floor((hit.v/boxD)*p.h);
      if(ppx>=0&&ppx<p.w&&ppy>=0&&ppy<p.h) return p.mask[ppy*p.w+ppx];
      return 0;
    }
    const hits = raycastPanel(Lx,Ly,Lz, bx,by,0, boxW,boxH,boxD);
    if(!hits) return 0; // no panel intersection = physically behind/blocked by the box -> always dark
    // raycastPanel can return up to two weighted hits (corner-graze tie-break
    // — see raytracer.js). Blend them the same way computeProjection does,
    // so a corner-straddling wall sample softly averages instead of
    // reading one arbitrary panel's data with weight 1.
    let val = 0;
    for(const hit of hits){
      const p = proj.panels[hit.panel];
      let ppx = Math.floor((hit.u/p.dimW)*p.w), ppy=Math.floor((hit.v/boxD)*p.h);
      if(ppx>=0&&ppx<p.w&&ppy>=0&&ppy<p.h) val += p.mask[ppy*p.w+ppx]*hit.weight;
    }
    return val;
  }

  // Build the raw blend-factor grid first (0=dark..1=teal), separately from
  // color conversion, so it can be blurred as plain numbers.
  const tGrid = new Float32Array(res*res);
  for(let py=0; py<res; py++){
    for(let px=0; px<res; px++){
      let litSum=0;
      for(const oy of offs) for(const ox of offs) litSum += sampleLit(px+ox, py+oy);
      tGrid[py*res+px] = litSum/(SS*SS);
    }
  }

  // Blur pass on the wall texture (PURELY VISUAL — never touches proj.panels,
  // so the actual laser-cut mask data / exported files are unaffected). Runs
  // twice with a 5x5 kernel: strong enough to properly smooth the residual
  // seam jaggedness right around the box's own footprint (where the
  // wall<->panel mapping is most compressed), not just take the edge off it.
  function boxBlur5(src){
    const out = new Float32Array(res*res);
    for(let py=0; py<res; py++){
      for(let px=0; px<res; px++){
        let sum=0, count=0;
        for(let dy=-2; dy<=2; dy++){
          const ny=py+dy; if(ny<0||ny>=res) continue;
          for(let dx=-2; dx<=2; dx++){
            const nx=px+dx; if(nx<0||nx>=res) continue;
            sum += src[ny*res+nx]; count++;
          }
        }
        out[py*res+px] = sum/count;
      }
    }
    return out;
  }
  const blurred = boxBlur5(boxBlur5(tGrid));

  for(let py=0; py<res; py++){
    for(let px=0; px<res; px++){
      const t = blurred[py*res+px];
      const idx=(py*res+px)*4;
      imgData.data[idx]   = DARK[0] + (TEAL[0]-DARK[0])*t;
      imgData.data[idx+1] = DARK[1] + (TEAL[1]-DARK[1])*t;
      imgData.data[idx+2] = DARK[2] + (TEAL[2]-DARK[2])*t;
      imgData.data[idx+3] = 255;
    }
  }
  ctx.putImageData(imgData,0,0);
  scene3D.wallTexture.needsUpdate = true;

  // Scale the wall plane so this texture's extent (viewW x viewH physical mm)
  // maps 1:1 onto the plane's surface instead of stretching across the fixed
  // 4000x4000 placeholder geometry.
  scene3D.wallMesh.scale.set(viewW/4000, viewH/4000, 1);
}

function rebuild3DScene(proj){
  try{
    initThreeScene();
    if(!scene3D.ready) return; // three.js failed to load (e.g. offline) — skip silently

    const boxW=state.boxW, boxH=state.boxH, boxD=state.boxD, thick=state.thick;
    const depth = proj.effectiveDepth || boxD; // trimmed shorter than boxD when Invert Cutout removes the dead zone
    const V3 = (x,y,z)=>new THREE.Vector3(x,y,z);

    // clear previous panel meshes
    while(scene3D.panelGroup.children.length){
      const m = scene3D.panelGroup.children.pop();
      m.geometry.dispose(); m.material.dispose();
    }

    const rectOutline = (dimW)=>[[0,0],[dimW,0],[dimW,depth],[0,depth]];
    const panelColor = 0x2a3838;

    if(proj.isPipe){
      const mesh = buildPipeMesh3D(proj.panels.pipe, proj.R, depth, panelColor);
      scene3D.panelGroup.add(mesh);
    } else {
    const defs = [
      { key:'top',    dimW:boxW, offsetU:boxW/2,
        basis:{x:V3(1,0,0), y:V3(0,0,1), z:V3(0,1,0)}, pos:V3(0, boxH/2, 0) },
      { key:'bottom', dimW:boxW, offsetU:boxW/2,
        basis:{x:V3(1,0,0), y:V3(0,0,1), z:V3(0,-1,0)}, pos:V3(0, -boxH/2, 0) },
      { key:'right',  dimW:boxH, offsetU:boxH/2,
        basis:{x:V3(0,1,0), y:V3(0,0,1), z:V3(1,0,0)}, pos:V3(boxW/2, 0, 0) },
      { key:'left',   dimW:boxH, offsetU:boxH/2,
        basis:{x:V3(0,1,0), y:V3(0,0,1), z:V3(-1,0,0)}, pos:V3(-boxW/2, 0, 0) },
    ];
    for(const d of defs){
      const panelData = proj.panels[d.key];
      let holes = getCutoutPolygonsMM(panelData, d.dimW, boxD).filter(h => polygonAreaMM(h) > 0.05);
      let mesh;
      try{
        mesh = buildPanelMesh(rectOutline(d.dimW), holes, d.offsetU, thick, d.basis, d.pos, panelColor);
      } catch(err){
        // A very thin/self-intersecting hole (e.g. a fine sword-blade sliver)
        // can occasionally break triangulation. Don't let that blank the
        // whole preview — fall back to a solid panel for just this one side.
        console.warn(`3D preview: '${d.key}' panel holes failed to build, showing it solid instead.`, err);
        mesh = buildPanelMesh(rectOutline(d.dimW), [], d.offsetU, thick, d.basis, d.pos, panelColor);
      }
      scene3D.panelGroup.add(mesh);
    }

    // back plate: simple solid rect (its own wire-hole is cosmetic, skip in 3D for simplicity)
    // Box Mode / Pipe Mode: no back plate at all — the existing pipe/box is open front AND back.
    if(!state.boxMode && !state.pipeMode){
      const backOutline = [[-boxW/2,-boxH/2],[boxW/2,-boxH/2],[boxW/2,boxH/2],[-boxW/2,boxH/2]];
      const backMesh = buildPanelMesh(backOutline, [], 0, thick,
        {x:V3(1,0,0), y:V3(0,1,0), z:V3(0,0,-1)}, V3(0,0,0), 0x1f2b2b);
      scene3D.panelGroup.add(backMesh);
    }
    } // end flat-panel branch

    // LED position + light
    scene3D.ledLight.position.set(proj.led.x, proj.led.y, proj.led.z);
    scene3D.ledMesh.position.copy(scene3D.ledLight.position);
    // The wall's look now comes entirely from our own texture (below), so the
    // point light no longer needs to cast shadows onto anything but the
    // panels themselves — this is what stops the stray light leaking around
    // the box's finite edges from ever reaching the wall.
    scene3D.ledLight.castShadow = false;

    // wall plane sits just behind the back plate
    scene3D.wallMesh.position.set(0,0,-2);
    updateWallTexture(proj, boxW, boxH, boxD, depth);

    // frame the camera around the box the first time (or if size changed a lot)
    const diag = proj.isPipe ? Math.hypot(proj.R*2, proj.R*2, depth) : Math.hypot(boxW,boxH,depth);
    scene3D.camState.target.set(0,0,depth/2);
    const desiredR = Math.max(150, diag*1.6);
    scene3D.defaultRadius = desiredR;
    if(!scene3D.framedOnce || Math.abs(scene3D.lastDiag-diag) > diag*0.4){
      scene3D.camState.radius = desiredR;
      scene3D.framedOnce = true;
    }
    scene3D.lastDiag = diag;

    scene3D.resize();
    scene3D.draw();
  } catch(err){
    console.error('3D preview failed:', err);
  }
}

function renderPipePanel(proj){
  const grid = $('panelGrid');
  grid.innerHTML='';
  const p = proj.panels.pipe;
  const localW = proj.circumference, localD = proj.effectiveDepth;
  const outline = buildPlainOutline(localW, localD); // pipes never get finger-joint interlock
  const cutouts = panelCutoutPaths(p.mask, p.w, p.h, localW, localD, p.coverage);
  const pad = 4;
  const vbW = localW+pad*2, vbH = localD+pad*2;
  const outlineD = pathDFromPoints(outline.map(pt=>[pt[0]+pad, pt[1]+pad]), true);
  const cutD = cutouts.map(d=>{
    return d.replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (m,a,b)=>`${(parseFloat(a)+pad).toFixed(2)} ${(parseFloat(b)+pad).toFixed(2)}`);
  }).join(' ');
  const clearMM = Math.max(0, Math.min(state.deviceH, localD));
  const clearLineD = clearMM>0
    ? `<line x1="${pad}" y1="${pad+clearMM}" x2="${pad+localW}" y2="${pad+clearMM}" stroke="#ffcc55" stroke-width="0.7" stroke-dasharray="2,1.5"/>
       <text x="${vbW-pad+2}" y="${pad+clearMM-1.5}" font-size="3.4" fill="#ffcc55" text-anchor="end">device ${Math.round(clearMM)}mm</text>`
    : '';

  const card = document.createElement('div');
  card.className='card overflow-hidden col-span-2';
  card.innerHTML = `
    <div class="px-3 pt-3 flex justify-between items-center">
      <span class="text-xs font-semibold">PIPE — UNROLLED WRAP</span>
      <span class="panel-preview-label">${Math.round(localW)}×${Math.round(localD)}MM · R${Math.round(proj.R)}</span>
    </div>
    <div class="p-2">
      <svg viewBox="0 0 ${vbW} ${vbH}" style="width:100%; background:#0c1315; border-radius:8px;">
        <text x="${vbW/2}" y="${pad-4}" font-size="4" fill="#5c716d" text-anchor="middle">WALL SIDE ▲</text>
        <path d="${outlineD}" fill="none" stroke="#3a4a48" stroke-width="0.8"/>
        <path d="${cutD}" fill="none" stroke="#ff3f63" stroke-width="0.9"/>
        ${clearLineD}
        <text x="${vbW/2}" y="${vbH-3}" font-size="4" fill="#5c716d" text-anchor="middle">FRONT / OPENING ▼</text>
      </svg>
    </div>
    <div class="px-3 pb-3 text-xs subtle">Wrap this pattern around the pipe's circumference (${Math.round(localW)}mm) — the left and right edges meet back-to-back at the seam.</div>`;
  grid.appendChild(card);
}

function renderPanels(proj){
  if(proj.isPipe){ renderPipePanel(proj); return; }
  const order = [
    {key:'top', label:'Top', dimW:state.boxW},
    {key:'right', label:'Right', dimW:state.boxH},
    {key:'bottom', label:'Bottom', dimW:state.boxW},
    {key:'left', label:'Left', dimW:state.boxH}
  ];
  const grid = $('panelGrid');
  grid.innerHTML='';
  order.forEach(o=>{
    const p = proj.panels[o.key];
    const localW = o.dimW, localD = proj.effectiveDepth;
    const outline = state.boxMode
      ? buildPlainOutline(localW, localD)
      : buildPanelOutline(localW, localD, state.thick, state.tab);
    const cutouts = panelCutoutPaths(p.mask, p.w, p.h, localW, localD, p.coverage);
    const pad = state.boxMode ? 4 : state.thick+4;
    const vbW = localW+pad*2, vbH = localD+pad*2;
    const outlineD = pathDFromPoints(outline.map(pt=>[pt[0]+pad, pt[1]+pad]), true);
    const cutD = cutouts.map(d=>{
      // shift path (already relative 0..localW,0..localD) by pad
      return d.replace(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g, (m,a,b)=>`${(parseFloat(a)+pad).toFixed(2)} ${(parseFloat(b)+pad).toFixed(2)}`);
    }).join(' ');

    const clearMM = Math.max(0, Math.min(state.deviceH, localD));
    const clearLineD = clearMM>0
      ? `<line x1="${pad}" y1="${pad+clearMM}" x2="${pad+localW}" y2="${pad+clearMM}" stroke="#ffcc55" stroke-width="0.7" stroke-dasharray="2,1.5"/>
         <text x="${vbW-pad+2}" y="${pad+clearMM-1.5}" font-size="3.4" fill="#ffcc55" text-anchor="end">device ${Math.round(clearMM)}mm</text>`
      : '';

    const card = document.createElement('div');
    card.className='card overflow-hidden';
    card.innerHTML = `
      <div class="px-3 pt-3 flex justify-between items-center">
        <span class="text-xs font-semibold">${o.label.toUpperCase()}</span>
        <span class="panel-preview-label">${Math.round(localW)}×${Math.round(localD)}MM</span>
      </div>
      <div class="p-2">
        <svg viewBox="0 0 ${vbW} ${vbH}" style="width:100%; background:#0c1315; border-radius:8px;">
          <text x="${vbW/2}" y="${pad-4}" font-size="4" fill="#5c716d" text-anchor="middle">WALL SIDE ▲</text>
          <path d="${outlineD}" fill="none" stroke="#3a4a48" stroke-width="0.8"/>
          <path d="${cutD}" fill="none" stroke="#ff3f63" stroke-width="0.9"/>
          ${clearLineD}
          <text x="${vbW/2}" y="${vbH-3}" font-size="4" fill="#5c716d" text-anchor="middle">FRONT / OPENING ▼</text>
        </svg>
      </div>`;
    grid.appendChild(card);
  });

  // ---- Back Plate card: blank panel, interlocks on all 4 sides, wire hole only ----
  // Box Mode has no Back Plate at all (the existing pipe/box has no back or
  // front — see Mounting Method), so skip this card entirely.
  if(state.boxMode) return;
  const boxW=state.boxW, boxH=state.boxH, thick=state.thick, tab=state.tab;
  // Back Plate's edges and each side panel's wall edge are BOTH traversed in
  // the same left-to-right direction (unlike the wrap-around seam, where the
  // two mating edges run in opposite directions) — so the correct mating
  // phase is simply the opposite, full stop. matingPhase()'s even/odd rule
  // was derived for reversed-direction seams; using it here was wrong
  // whenever the tooth count came out even (e.g. the very first default:
  // boxW=200mm, tab=10mm -> exactly 20 teeth -> teeth collided instead of
  // interlocking, which is what showed up as a bad fit on assembly).
  const backPhases = {
    top:    true, // opposite of the side panels' own wall-edge phase (false)
    bottom: true,
    left:   true,
    right:  true
  };
  const backOutline = buildBackPlateOutline(boxW, boxH, thick, tab, backPhases);
  const wireHoleR = Math.max(3, thick*1.5);
  const wireHole = regularPolygon(boxW/2, boxH/2, wireHoleR, 28);
  const pad2 = thick+4;
  const vbW2 = boxW+pad2*2, vbH2 = boxH+pad2*2;
  const backOutlineD = pathDFromPoints(backOutline.map(pt=>[pt[0]+pad2, pt[1]+pad2]), true);
  const wireHoleD = pathDFromPoints(wireHole.map(pt=>[pt[0]+pad2, pt[1]+pad2]), true);
  const backCard = document.createElement('div');
  backCard.className='card overflow-hidden';
  backCard.innerHTML = `
    <div class="px-3 pt-3 flex justify-between items-center">
      <span class="text-xs font-semibold">BACK PLATE</span>
      <span class="panel-preview-label">${Math.round(boxW)}×${Math.round(boxH)}MM</span>
    </div>
    <div class="p-2">
      <svg viewBox="0 0 ${vbW2} ${vbH2}" style="width:100%; background:#0c1315; border-radius:8px;">
        <text x="${vbW2/2}" y="${pad2-4}" font-size="4" fill="#5c716d" text-anchor="middle">MOUNTS TO WALL</text>
        <path d="${backOutlineD}" fill="none" stroke="#3a4a48" stroke-width="0.8"/>
        <path d="${wireHoleD}" fill="none" stroke="#ffcc55" stroke-width="0.9"/>
        <text x="${vbW2/2}" y="${vbH2-3}" font-size="4" fill="#5c716d" text-anchor="middle">blank · LED wire hole only</text>
      </svg>
    </div>`;
  grid.appendChild(backCard);
}
