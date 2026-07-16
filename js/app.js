/* ============================================================
   APP.JS — shared state + bootstrap
   Loaded LAST (see index.html script order). Declares the globals
   every other module reads/writes (state, DEG, $, sourceImg), then
   kicks off initUI() + runPipeline() once everything else is
   already defined.
   ============================================================ */

/* ------------------------------------------------------------
   STATE
   ------------------------------------------------------------ */
const state = {
  threshold:128, thresholdEnabled:true, invert:false, noise:0, noiseMode:'white',
  resolution:640, smoothing:1.5,
  boxW:200, boxH:150, boxD:80,
  ledZ:40, ledX:0, ledY:0, deviceH:0,
  autoDepth:false,
  scale:4.0, offX:0, offY:0, boxRot:0, shadowRot:0,
  thick:3.0, tab:10, invertCutout:false, boxMode:false,
  mask:null, maskW:0, maskH:0,       // processed binary silhouette (1 = silhouette ink)
  hasImage:false,
  panels:null                        // computed panel data {top,bottom,left,right}
};
const DEG = Math.PI/180;

function $(id){ return document.getElementById(id); }

// Holds the currently loaded (or placeholder) source <img>. Declared here
// (not in ui.js) because both ui.js (loadImageFile) and projection.js
// (runPipeline) read/write it.
let sourceImg = null;

/* ------------------------------------------------------------
   INIT — everything else has finished loading by this point,
   since app.js is the last <script src> in index.html.
   ------------------------------------------------------------ */
initUI();
runPipeline();
