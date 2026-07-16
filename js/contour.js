/* ============================================================
   CONTOUR.JS — marching squares + path simplification + panel
   outline / finger-joint (interlock) geometry.
   Turns a binary panel mask into clean cut-ready SVG path data,
   and builds the structural outlines (with or without tabs) for
   side panels, the Back Plate, and Box Mode's plain rectangles.
   Depends on: state (app.js)
   ============================================================ */

/* ---------- marching squares ---------- */
const MS_TABLE = {
  1:[['L','B']], 2:[['B','R']], 3:[['L','R']], 4:[['T','R']],
  5:[['T','R'],['L','B']], 6:[['T','B']], 7:[['T','L']], 8:[['T','L']],
  9:[['T','B']], 10:[['T','L'],['R','B']], 11:[['T','R']], 12:[['L','R']],
  13:[['R','B']], 14:[['B','L']]
};
function edgePoint(name,gx,gy){
  if(name==='T') return [gx+0.5,gy];
  if(name==='R') return [gx+1,gy+0.5];
  if(name==='B') return [gx+0.5,gy+1];
  return [gx,gy+0.5];
}
function marchingSquares(mask,w,h){
  const S=(x,y)=> (x<0||y<0||x>=w||y>=h) ? 0 : mask[y*w+x];
  const segs=[];
  for(let gy=-1; gy<h; gy++){
    for(let gx=-1; gx<w; gx++){
      const tl=S(gx,gy), tr=S(gx+1,gy), br=S(gx+1,gy+1), bl=S(gx,gy+1);
      const c = tl*8+tr*4+br*2+bl*1;
      if(c===0||c===15) continue;
      const pairs = MS_TABLE[c]; if(!pairs) continue;
      for(const [a,b] of pairs) segs.push([edgePoint(a,gx,gy), edgePoint(b,gx,gy)]);
    }
  }
  // chain into polylines
  const key = p=>p[0].toFixed(2)+','+p[1].toFixed(2);
  const adj = new Map();
  segs.forEach((s,i)=>{
    const k1=key(s[0]), k2=key(s[1]);
    if(!adj.has(k1)) adj.set(k1,[]); if(!adj.has(k2)) adj.set(k2,[]);
    adj.get(k1).push({other:k2, pt:s[1], used:false, segIdx:i});
    adj.get(k2).push({other:k1, pt:s[0], used:false, segIdx:i});
  });
  const usedSeg = new Uint8Array(segs.length);
  const polylines=[];
  for(let i=0;i<segs.length;i++){
    if(usedSeg[i]) continue;
    usedSeg[i]=1;
    let poly=[segs[i][0], segs[i][1]];
    let curKey = key(segs[i][1]);
    let guard=0;
    while(guard++<100000){
      const options = (adj.get(curKey)||[]).filter(o=>!usedSeg[o.segIdx]);
      if(options.length===0) break;
      const opt = options[0];
      usedSeg[opt.segIdx]=1;
      poly.push(opt.pt);
      curKey = key(opt.pt);
      if(curKey === key(poly[0])) break;
    }
    if(poly.length>=3) polylines.push(poly);
  }
  return polylines;
}
function douglasPeuckerOpen(points, eps){
  // Standard DP for an OPEN chain (start != end). Safe to call on any
  // sub-piece produced by douglasPeucker() below.
  if(points.length<3) return points;
  const [x1,y1]=points[0], [x2,y2]=points[points.length-1];
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  let maxD=-1, idx=-1;
  for(let i=1;i<points.length-1;i++){
    const [x0,y0]=points[i];
    const d = (len<1e-9)
      ? Math.hypot(x0-x1, y0-y1)                              // degenerate chord fallback
      : Math.abs(dy*x0 - dx*y0 + x2*y1 - y2*x1)/len;
    if(d>maxD){ maxD=d; idx=i; }
  }
  if(maxD>eps){
    const left = douglasPeuckerOpen(points.slice(0,idx+1), eps);
    const right = douglasPeuckerOpen(points.slice(idx), eps);
    return left.slice(0,-1).concat(right);
  }
  return [points[0], points[points.length-1]];
}
function douglasPeucker(pts, eps){
  // marchingSquares() always returns CLOSED loops (first point === last
  // point). Running plain DP straight on that makes the very first
  // start/end "chord" have zero length, which made the whole shape collapse
  // to a single point at ANY eps > 0 — the red cutout line vanishing bug.
  // Fix: split the loop into two arcs at the point farthest from the start,
  // simplify each arc as an OPEN chain, then stitch them back together —
  // this keeps the loop's real shape intact no matter how high eps goes.
  if(pts.length<4 || eps<=0) return pts;
  const [x0,y0]=pts[0];
  let farI=1, farD=-1;
  for(let i=1;i<pts.length-1;i++){
    const d = Math.hypot(pts[i][0]-x0, pts[i][1]-y0);
    if(d>farD){ farD=d; farI=i; }
  }
  const partA = douglasPeuckerOpen(pts.slice(0, farI+1), eps);
  const partB = douglasPeuckerOpen(pts.slice(farI), eps);
  return partA.slice(0,-1).concat(partB);
}
function smoothPathD(pts, closed, offsetX, offsetY, scaleToMM){
  // Straight-line path only (M/L) — no Bezier. Douglas-Peucker already removed
  // the pixel-noise vertices, so the remaining polyline is clean enough to
  // cut directly: no curve-fitting artifacts, no self-crossing risk.
  if(pts.length<2) return '';
  const P = pts.map(p=>[ (p[0]*scaleToMM)+offsetX, (p[1]*scaleToMM)+offsetY ]);
  let d = `M ${P[0][0].toFixed(3)} ${P[0][1].toFixed(3)} `;
  for(let i=1;i<P.length;i++) d += `L ${P[i][0].toFixed(3)} ${P[i][1].toFixed(3)} `;
  if(closed) d += 'Z';
  return d;
}
function panelCutoutPaths(panelMask, w, h, dimW, dimD){
  const polys = marchingSquares(panelMask, w, h);
  const pxPerMM = w/dimW;
  const eps = state.smoothing * pxPerMM * 0.5;
  return polys.map(poly=>{
    const simplified = douglasPeucker(poly, eps);
    return smoothPathD(simplified, true, 0, 0, 1/pxPerMM);
  }).filter(d=>d.length>0);
}

/* ---------- finger joints ---------- */

// Number of teeth for an edge of the given length. Using the SAME formula
// on both sides of a joint guarantees both edges get the same tooth count,
// which is required for them to interlock without collisions.
function tabCount(len, tabWidth){ return Math.max(1, Math.round(Math.abs(len)/tabWidth)); }

// Given the tooth count of a joint and the phase already used on one side,
// returns the phase the MATING side must use so male/female alternate
// correctly (no two tabs ever land on the same segment).
//  - even tooth count  -> mating side uses the SAME starting phase
//  - odd  tooth count  -> mating side uses the OPPOSITE starting phase
// (This falls out of walking the same edge from both ends: with an even
// tab count the parity lines back up; with an odd count it flips.)
function matingPhase(n, basePhase){ return (n % 2 === 0) ? basePhase : !basePhase; }

function zigzag(axis, fixed, start, end, thickness, tabWidth, outward, startOut){
  // axis 'v' => vertical edge (x fixed, y runs start..end); axis 'h' => horizontal edge (y fixed, x runs start..end)
  // start/end may run in either direction (start>end is valid, used for edges
  // traversed "backwards" to keep the outline's overall winding order).
  const total = end-start;
  const n = tabCount(total, tabWidth);   // always based on absolute length -> fixes a bug where
  const step = total/n;                  // reversed edges used to collapse to a single tooth
  const pts=[];
  let out = !!startOut;
  const pushPt=(a,b)=>{ pts.push(axis==='v'?[a,b]:[b,a]); };
  pushPt(fixed, start);
  for(let i=0;i<n;i++){
    const s0=start+i*step, s1=start+(i+1)*step;
    const f = out ? fixed+outward*thickness : fixed;
    pushPt(f, s0); pushPt(f, s1);
    out=!out;
  }
  pushPt(fixed, end);
  return pts;
}
function flatEdge(axis, fixed, start, end){
  // Plain straight edge, no interlock — used for the front/opening face.
  return axis==='v' ? [[fixed,start],[fixed,end]] : [[start,fixed],[end,fixed]];
}

function buildPanelOutline(localW, localD, thickness, tabWidth){
  // Standalone side-panel outline (used for the on-screen preview cards).
  // top   = wall side  -> finger joint (mates with the Back Plate)
  // right/left = circumferential seams -> finger joint (mate with neighboring side panels)
  // bottom = front/opening -> FLAT, no interlock at all (open face, nothing to lock)
  const top = zigzag('h', 0, 0, localW, thickness, tabWidth, -1, false);
  const right = zigzag('v', localW, 0, localD, thickness, tabWidth, 1, false);
  const bottom = flatEdge('h', localD, localW, 0);
  const left = zigzag('v', 0, localD, 0, thickness, tabWidth, -1, true);
  return top.concat(right.slice(1)).concat(bottom.slice(1)).concat(left.slice(1));
}

function buildPlainOutline(localW, localD){
  // Box Mode: no interlock at all — the person is wrapping printed paper
  // around a box/pipe they already own, so the panel boundary is just a
  // plain rectangle (a cut/drill guide), not a self-supporting joint.
  return [[0,0],[localW,0],[localW,localD],[0,localD],[0,0]];
}

function buildBackPlateOutline(boxW, boxH, thickness, tabWidth, phases){
  // Back Plate: fully blank panel (no cutout), interlocks on all 4 sides
  // with the wall-side edge of Top/Right/Bottom/Left respectively.
  // These edges are traversed in the SAME direction as the corresponding
  // side panel's wall edge (both left-to-right along their own u-axis), so
  // the correct mating phase is simply the opposite of the side panel's
  // phase — not matingPhase()'s even/odd rule, which is only for
  // reversed-direction seams like the wrap-around joint.
  const top    = zigzag('h', 0, 0, boxW, thickness, tabWidth, -1, phases.top);
  const right  = zigzag('v', boxW, 0, boxH, thickness, tabWidth, 1, phases.right);
  const bottom = zigzag('h', boxH, boxW, 0, thickness, tabWidth, 1, phases.bottom);
  const left   = zigzag('v', 0, boxH, 0, thickness, tabWidth, -1, phases.left);
  return top.concat(right.slice(1)).concat(bottom.slice(1)).concat(left.slice(1));
}

function regularPolygon(cx,cy,r,n){
  // Straight-line circle approximation (N-gon) — kept polygonal on purpose
  // so it flows through the same M/L-only path + DXF/PDF writers as every
  // other cut path, with no separate arc-handling code path to maintain.
  const pts=[];
  for(let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2;
    pts.push([cx+r*Math.cos(a), cy+r*Math.sin(a)]);
  }
  return pts;
}

function pathDFromPoints(pts, close){
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} `;
  for(let i=1;i<pts.length;i++) d+= `L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} `;
  if(close) d+='Z';
  return d;
}

/* ============================================================
   3D PREVIEW (Three.js) — rotate by drag, zoom by wheel/pinch.
   Panels are built as extruded shapes with real holes cut from the SAME
   cutout polygons used for the laser-cut export, so this is a genuine
   preview of the actual geometry, not a decorative mockup.
   ============================================================ */
const scene3D = { ready:false };

function polygonAreaMM(poly){
  let a=0;
  for(let i=0;i<poly.length;i++){
    const [x1,y1]=poly[i], [x2,y2]=poly[(i+1)%poly.length];
    a += x1*y2 - x2*y1;
  }
  return Math.abs(a)/2;
}

function getCutoutPolygonsMM(panelData, dimW, boxD){
  const cutPolys = marchingSquares(panelData.mask, panelData.w, panelData.h);
  const pxPerMM = panelData.w/dimW;
  const eps = state.smoothing*pxPerMM*0.5;
  return cutPolys
    .map(poly => douglasPeucker(poly, eps).map(pt => [pt[0]/pxPerMM, pt[1]/pxPerMM]))
    .filter(poly => poly.length>=3);
}

function smoothDFromMMPoints(poly){
  // Straight-line polygon only (M/L) — matches smoothPathD; no curve fitting,
  // so exported cut paths are exactly the simplified polyline, nothing more.
  if(poly.length<2) return '';
  let d = `M ${poly[0][0].toFixed(3)} ${poly[0][1].toFixed(3)} `;
  for(let i=1;i<poly.length;i++) d += `L ${poly[i][0].toFixed(3)} ${poly[i][1].toFixed(3)} `;
  return d+'Z';
}
