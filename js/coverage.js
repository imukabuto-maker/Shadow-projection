/* ============================================================
   COVERAGE.JS — binary mask morphology / cleanup
   Small-component removal (denoise) + dilate/erode/close used to
   clean up both the source silhouette mask and per-panel projection
   masks before they go to contour extraction.
   ============================================================ */

function removeSmallComponents(mask,w,h,minSize,mode){
  const visited = new Uint8Array(w*h);
  const targets=[];
  if(mode==='white'||mode==='both') targets.push(0);
  if(mode==='black'||mode==='both') targets.push(1);
  const stack = new Int32Array(w*h); 
  for(const targetVal of targets){
    for(let start=0; start<w*h; start++){
      if(visited[start]||mask[start]!==targetVal) continue;
      let sp=0; stack[sp++]=start; visited[start]=1;
      const comp=[];
      while(sp>0){
        const idx=stack[--sp]; comp.push(idx);
        const x=idx%w, y=(idx/w)|0;
        if(x>0){ const n=idx-1; if(!visited[n]&&mask[n]===targetVal){visited[n]=1; stack[sp++]=n;} }
        if(x<w-1){ const n=idx+1; if(!visited[n]&&mask[n]===targetVal){visited[n]=1; stack[sp++]=n;} }
        if(y>0){ const n=idx-w; if(!visited[n]&&mask[n]===targetVal){visited[n]=1; stack[sp++]=n;} }
        if(y<h-1){ const n=idx+w; if(!visited[n]&&mask[n]===targetVal){visited[n]=1; stack[sp++]=n;} }
      }
      if(comp.length < minSize){
        const flip = targetVal===0?1:0;
        for(const idx of comp) mask[idx]=flip;
      }
    }
  }
}

const PX_PER_MM = 8; // panel raster density (raised from 4 -> preserves thin details like a sword blade)

/* ---------- morphological closing (dilate -> erode) ----------
   Fills 1px pinholes / reconnects near-touching pixels BEFORE marching-squares
   runs, so thin details don't fragment into jagged, broken red cut lines. */
function dilateMask(mask,w,h){
  const out = new Uint8Array(w*h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let v = mask[y*w+x];
      if(!v){
        for(let dy=-1;dy<=1 && !v;dy++){
          for(let dx=-1;dx<=1 && !v;dx++){
            const nx=x+dx, ny=y+dy;
            if(nx>=0&&ny>=0&&nx<w&&ny<h&&mask[ny*w+nx]) v=1;
          }
        }
      }
      out[y*w+x]=v;
    }
  }
  return out;
}
function erodeMask(mask,w,h){
  const out = new Uint8Array(w*h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let v = mask[y*w+x];
      if(v){
        for(let dy=-1;dy<=1 && v;dy++){
          for(let dx=-1;dx<=1 && v;dx++){
            const nx=x+dx, ny=y+dy;
            if(nx<0||ny<0||nx>=w||ny>=h||!mask[ny*w+nx]) v=0;
          }
        }
      }
      out[y*w+x]=v;
    }
  }
  return out;
}
function closeMask(mask,w,h,iterations){
  let m=mask;
  for(let i=0;i<iterations;i++) m=dilateMask(m,w,h);
  for(let i=0;i<iterations;i++) m=erodeMask(m,w,h);
  return m;
}
