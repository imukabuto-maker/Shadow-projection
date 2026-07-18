/* ============================================================
   RAYTRACER.JS — core ray-casting engine
   For each source-mask pixel, casts a ray from the LED through that
   pixel's wall-plane position and determines which panel (top/right/
   bottom/left) the ray exits through first, then majority-votes that
   into the panel's own raster.
   Depends on: state (app.js)
   ============================================================ 

/* ============================================================
   GEOMETRY ENGINE
   ============================================================ */
// The OLD approach compared the two candidates' t-ratio and only blended
// when they were "tied" — but each candidate's own boundary check used a
// 1e-6 tolerance meant to absorb floating-point noise, not to define a real
// "near corner" zone. In practice that meant the blend almost NEVER
// triggered on real image data (only when a ray landed on the mathematically
// exact corner line), so the starburst was untouched.
//
// This version instead measures, in physical mm, how close the ray's hit
// point is to the EDGE of the wall it landed on (i.e. how close to one of
// the box's 4 corners). Within CORNER_BLEND_MM of an edge, it blends in the
// adjacent wall too, with a weight that ramps smoothly from 0 (at the
// margin) to 0.5 (exactly at the corner) — a real gradient across a
// meaningful band of rays, not an all-or-nothing coin flip on exact hits.
const CORNER_BLEND_MM = 3;

function raycastPanel(Lx,Ly,Lz, Qx,Qy,Qz, boxW,boxH,boxD){
  const dx=Qx-Lx, dy=Qy-Ly, dz=Qz-Lz;
  const cands=[];
  if(Math.abs(dx)>1e-9){
    cands.push({t:(boxW/2-Lx)/dx, type:'right'});
    cands.push({t:(-boxW/2-Lx)/dx, type:'left'});
  }
  if(Math.abs(dy)>1e-9){
    cands.push({t:(boxH/2-Ly)/dy, type:'top'});
    cands.push({t:(-boxH/2-Ly)/dy, type:'bottom'});
  }
  cands.sort((a,b)=>a.t-b.t);

  let primary=null;
  for(const c of cands){
    if(c.t<=1e-6 || c.t>1.000001) continue;
    const px=Lx+dx*c.t, py=Ly+dy*c.t, pz=Lz+dz*c.t;
    if(pz<0||pz>boxD) continue;
    if(c.type==='right'||c.type==='left'){
      if(py< -boxH/2-1e-6 || py>boxH/2+1e-6) continue;
    } else {
      if(px< -boxW/2-1e-6 || px>boxW/2+1e-6) continue;
    }
    primary=c; break;
  }
  if(!primary) return null;

  const px=Lx+dx*primary.t, py=Ly+dy*primary.t, pz=Lz+dz*primary.t;
  const isVertWall = (primary.type==='right'||primary.type==='left');
  const hit1 = isVertWall
    ? {panel:primary.type, u:py+boxH/2, v:pz}
    : {panel:primary.type, u:px+boxW/2, v:pz};

  const distToOwnEdge = isVertWall ? (boxH/2 - Math.abs(py)) : (boxW/2 - Math.abs(px));
  if(distToOwnEdge > CORNER_BLEND_MM) return [{...hit1, weight:1}];

  // Extend the SAME ray to the adjacent wall on this side of the corner,
  // clamping onto that wall's own edge if it lands just past it.
  let adjType, adjHit=null;
  if(isVertWall){
    adjType = py>=0 ? 'top' : 'bottom';
    const tAdj = ((py>=0?boxH/2:-boxH/2)-Ly)/dy;
    if(isFinite(tAdj) && tAdj>1e-6 && tAdj<=1.000001){
      const px2=Lx+dx*tAdj, pz2=Lz+dz*tAdj;
      if(pz2>=0 && pz2<=boxD){
        const pxClamped = Math.max(-boxW/2, Math.min(boxW/2, px2));
        adjHit = {panel:adjType, u:pxClamped+boxW/2, v:pz2};
      }
    }
  } else {
    adjType = px>=0 ? 'right' : 'left';
    const tAdj = ((px>=0?boxW/2:-boxW/2)-Lx)/dx;
    if(isFinite(tAdj) && tAdj>1e-6 && tAdj<=1.000001){
      const py2=Ly+dy*tAdj, pz2=Lz+dz*tAdj;
      if(pz2>=0 && pz2<=boxD){
        const pyClamped = Math.max(-boxH/2, Math.min(boxH/2, py2));
        adjHit = {panel:adjType, u:pyClamped+boxH/2, v:pz2};
      }
    }
  }
  if(!adjHit) return [{...hit1, weight:1}];

  // Blend WITHOUT dropping total energy (unlike an earlier version of this
  // fix): forcing energy toward 0 exactly at the corner made that direction
  // always render as "dark/solid" on the wall, regardless of what the real
  // content there was — since that exact angle is shared by every point
  // along the ray from the box out to the far edge of the wall, that showed
  // up as a hard dark LINE running the full length of the render. Keeping
  // the total at 1 and blending the two panels' actual values instead means
  // the seam shows whatever the real (blended) content is, not a forced-dark
  // stripe — and the wall texture's blur pass (below) is what actually
  // smooths the jaggedness there now.
  const w2 = 0.5*(1 - distToOwnEdge/CORNER_BLEND_MM);
  return [{...hit1, weight:1-w2}, {...adjHit, weight:w2}];
}

function computeProjection(){
  const boxW=state.boxW, boxH=state.boxH, boxD=state.boxD;
  const ledCorrection = state.thick*2;
  const Lx = state.ledX, Ly = state.ledY+ledCorrection, Lz = Math.min(Math.max(state.ledZ,1), boxD-1);

  const mw=state.maskW, mh=state.maskH, mask=state.mask;
  const wallImgW = boxW*state.scale;
  const wallImgH = wallImgW*(mh/mw);
  const cosA=Math.cos(-state.boxRot*DEG), sinA=Math.sin(-state.boxRot*DEG);
  const cosS=Math.cos(state.shadowRot*DEG), sinS=Math.sin(state.shadowRot*DEG);

  // Panel raster density: 8 px/mm was tuned as a baseline at the default
  // Shadow Scale (4x) to preserve thin details (a sword blade) without
  // fragmenting. But a higher Shadow Scale "zooms into" a smaller slice of
  // the artwork onto the same physical panel — more scale means more real
  // source detail lands per mm of panel, and a FIXED panel density starts
  // crushing/aliasing that detail (this was also compounding the starburst
  // at high scale, on top of the corner tie-breaking issue above). Scale the
  // density up past the 4x baseline, capped at 2x (16 px/mm) so panel arrays
  // don't blow up in size/compute on mobile at the top of the Shadow Scale
  // range (12x).
  const PX_PER_MM = Math.min(16, Math.max(8, 8*(state.scale/4)));

  const panelsRaw = {
    top:{w:Math.max(4,Math.round(boxW*PX_PER_MM)), h:Math.max(4,Math.round(boxD*PX_PER_MM)), total:null, lit:null, dimW:boxW},
    bottom:{w:Math.max(4,Math.round(boxW*PX_PER_MM)), h:Math.max(4,Math.round(boxD*PX_PER_MM)), total:null, lit:null, dimW:boxW},
    left:{w:Math.max(4,Math.round(boxH*PX_PER_MM)), h:Math.max(4,Math.round(boxD*PX_PER_MM)), total:null, lit:null, dimW:boxH},
    right:{w:Math.max(4,Math.round(boxH*PX_PER_MM)), h:Math.max(4,Math.round(boxD*PX_PER_MM)), total:null, lit:null, dimW:boxH}
  };
  // Float32 (not Uint32) so a corner-graze ray can deposit a fractional
  // (0.5/0.5) vote across two panels instead of an all-or-nothing integer.
  for(const k in panelsRaw){ panelsRaw[k].total=new Float32Array(panelsRaw[k].w*panelsRaw[k].h); panelsRaw[k].lit=new Float32Array(panelsRaw[k].w*panelsRaw[k].h); }

  // At high Shadow Scale, the wall image is much bigger than the box while
  // the source mask keeps the SAME pixel count — so each panel only catches
  // a thinning, patchier subset of rays, leaving scattered zero-vote "holes"
  // in the panel raster (the speckled/jagged noise seen around the
  // silhouette at high scale). Supersampling the ray grid (independent of
  // the source mask's own resolution) keeps ray density adequate as scale
  // grows, without requiring the user to also raise Raster Resolution.
  // Ray density has to keep up with panel raster density (PX_PER_MM, see
  // above), or most panel pixels between actual ray hits never get sampled
  // at all — a scattered "salt and pepper" of unlit gaps in what should be
  // solid regions. At default settings the gap was roughly 10x (panel
  // pixels ~10x finer than one source-mask pixel), and the old fixed
  // "scale>5 ? 2 : 1" threshold didn't scale with that at all. Compute the
  // supersample factor actually needed to close that gap, capped so the
  // total ray grid (mw*S x mh*S) stays within a mobile-friendly compute
  // budget — full elimination of aliasing isn't always reachable within
  // that budget at extreme settings, but this closes most of the gap
  // instead of leaving it fixed at 1x.
  const idealSuperSample = Math.max((wallImgW*PX_PER_MM)/mw, (wallImgH*PX_PER_MM)/mh);
  // Perf budget capped on TOTAL ray count, not per-axis grid size. The
  // earlier per-axis cap (MAX_RAY_GRID_DIM / max(mw,mh)) unintentionally
  // punished raising Raster Resolution: a bigger mw shrank the cap just as
  // fast as it shrank the ideal supersample need, so past a certain
  // resolution supersample got starved down to 1x again — bringing the
  // undersampling noise right back, worse the higher Raster Resolution was
  // set. Budgeting the TOTAL (mw*S)*(mh*S) ray count instead means a higher
  // native resolution no longer eats its own supersampling headroom.
  const MAX_TOTAL_RAYS = 6_000_000; // mobile-friendly compute budget
  const maxSByBudget = Math.sqrt(MAX_TOTAL_RAYS/(mw*mh));
  const superSample = Math.max(1, Math.min(Math.ceil(idealSuperSample), Math.floor(maxSByBudget)));
  const sw = mw*superSample, sh = mh*superSample;

  for(let sy=0; sy<sh; sy++){
    for(let sx=0; sx<sw; sx++){
      const srcX = Math.min(mw-1, Math.floor(sx/superSample));
      const srcY = Math.min(mh-1, Math.floor(sy/superSample));
      const m = mask[srcY*mw+srcX];
      const nx=(sx+0.5)/sw-0.5, ny=(sy+0.5)/sh-0.5;
      const lx0=nx*wallImgW, ly0=-ny*wallImgH;
      // Shadow Rotation applied first (rotates the artwork), then Box Position
      // X/Y Offset shifts the artwork on the wall independently of the fixed
      // box/LED — this is what was previously missing entirely.
      const lx = lx0*cosS - ly0*sinS + state.offX;
      const ly = lx0*sinS + ly0*cosS + state.offY;
      const qx = lx*cosA - ly*sinA;
      const qy = lx*sinA + ly*cosA;
      const hits = raycastPanel(Lx,Ly,Lz, qx,qy,0, boxW,boxH,boxD);
      if(!hits) continue;
      for(const hit of hits){
        const p = panelsRaw[hit.panel];
        let px = Math.floor((hit.u/p.dimW)*p.w);
        let py = Math.floor((hit.v/boxD)*p.h);
        if(px<0)px=0; if(px>=p.w)px=p.w-1; if(py<0)py=0; if(py>=p.h)py=p.h-1;
        const idx=py*p.w+px;
        p.total[idx]+=hit.weight;
        if(m===0) p.lit[idx]+=hit.weight;
      }
    }
  }

  const result={};
  const clearMM = Math.max(0, Math.min(state.deviceH, boxD)); // never let it exceed the panel's own depth
  const minComponent = Math.max(2,Math.round(PX_PER_MM*PX_PER_MM*0.15));
  for(const k in panelsRaw){
    const p=panelsRaw[k];
    const finalMask=new Uint8Array(p.w*p.h);
    // Raw continuous coverage (0..1), kept BEFORE the 50% hard threshold —
    // handed to marchingSquares() later so it can trace the true sub-pixel
    // edge position instead of always snapping to the cell midpoint. The
    // binary finalMask below still drives cleanup/topology as before; this
    // is purely an additional, non-destructive refinement signal.
    const coverage=new Float32Array(p.w*p.h);
    for(let i=0;i<finalMask.length;i++){
      const ratio = p.total[i]>0 ? (p.lit[i]/p.total[i]) : 0;
      coverage[i]=ratio;
      finalMask[i] = (p.total[i]>0 && ratio>=0.5) ? 1:0;
    }
    // Closing pass kept gentle (1 iteration) — thin, elongated details (like a
    // sword blade) can be only a couple of panel-pixels wide, and a stronger
    // closing + a large noise-removal threshold were quietly eating them.
    const closed = closeMask(finalMask, p.w, p.h, 1);
    removeSmallComponents(closed, p.w, p.h, minComponent, 'both');

    // The v≈0 (wall-side) edge is where content just OUTSIDE the box's own
    // footprint gets compressed into a very thin sliver of panel depth — a
    // handful of panel-pixels there can correspond to a long, winding
    // stretch of the silhouette's actual boundary. That makes it inherently
    // noisy: no amount of smoothing fully cleans it up, because the "noise"
    // is really genuine (but geometrically unstable) detail being crammed
    // into too few pixels. Rather than keep chasing a clean version of it,
    // just don't cut anything in that sliver at all — force it solid, the
    // same way the Device Clearance zone below already blanks out a strip.
    // It's thin enough (a few mm) that this costs essentially no real
    // content anywhere else on the panel.
    const edgeBandMM = 3;
    const edgeBandRows = Math.min(p.h, Math.max(1, Math.round((edgeBandMM/boxD)*p.h)));
    closed.fill(0, 0, p.w*edgeBandRows);

    // Device clearance zone: v (depth) runs 0=wall-side -> boxD=front/opening,
    // which maps to row index 0 -> p.h. Blank out every row inside the
    // reserved depth so the controller/driver never collides with a cutout.
    const clearRows = Math.round((clearMM/boxD)*p.h);
    for(let row=0; row<clearRows && row<p.h; row++){
      const base = row*p.w;
      for(let col=0; col<p.w; col++) closed[base+col]=0;
    }
    // The hard cut above can slice through real content or leave tiny
    // fragments right along that new boundary — clean up again so nothing
    // jagged survives right at the clearance line (this was showing up as a
    // scribbly "noise" patch that looked like a light leak, but was really
    // just an un-cleaned edge artifact from the forced cut).
    removeSmallComponents(closed, p.w, p.h, minComponent, 'both');

    result[k]={mask:closed, coverage, w:p.w, h:p.h, dimW:p.dimW, dimH:boxD, clearMM};
  }

  // Invert Cutout (redefined): instead of poking a hole in the dead zone —
  // which left the panel's own rectangular frame intact all the way to the
  // front opening, and was exactly what cast that unwanted "X" shape in the
  // 3D view — TRIM the panel's own physical depth so the material simply
  // doesn't extend past the deepest real content at all. One shared depth is
  // used for all 4 side panels (the deepest of the four) so the box still
  // closes evenly at the front.
  // NOTE: trimmed right at the content boundary (no extra buffer) per
  // request — only a hairline 1mm is kept, just enough that the very last
  // cutout row doesn't sit exactly on a zero-thickness edge.
  let effectiveDepth = boxD;
  if(state.invertCutout){
    let maxRowAll=-1, refH=0;
    for(const k of ['top','bottom','left','right']){
      const r = findPanelMaxRow(result[k]);
      if(r>maxRowAll) maxRowAll=r;
      refH = result[k].h;
    }
    if(maxRowAll>=0 && refH>0){
      const contentMM = ((maxRowAll+1)/refH)*boxD;
      effectiveDepth = Math.min(boxD, Math.max(clearMM+1, contentMM+1));
    }
  }

  return {panels:result, led:{x:Lx,y:Ly,z:Lz}, wallImgW, wallImgH, effectiveDepth};
}
