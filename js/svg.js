/* ============================================================
   SVG.JS — file export (SVG / DXF / PDF)
   Depends on: state (app.js), closeExport (ui.js),
               smoothDFromMMPoints/pathDFromPoints (contour.js)
   ============================================================ */

function download(filename, content, type){
  const blob = new Blob([content], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function downloadSVG(){
  const {placed, totalW, totalH, guides} = buildNestedLayout();
  let body='';
  for(const p of placed){
    body += `<path d="${pathDFromPoints(p.outline,true)}" fill="none" stroke="#000000" stroke-width="0.2"/>\n`;
    for(const c of p.cutouts) body += `<path d="${smoothDFromMMPoints(c)}" fill="none" stroke="#ff0000" stroke-width="0.15"/>\n`;
  }
  let guideBody='';
  for(const g of (guides||[])){
    guideBody += `<line x1="${g[0][0].toFixed(2)}" y1="${g[0][1].toFixed(2)}" x2="${g[1][0].toFixed(2)}" y2="${g[1][1].toFixed(2)}" stroke="#4488ff" stroke-width="0.15" stroke-dasharray="2,2"/>\n`;
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}mm" height="${totalH}mm" viewBox="0 0 ${totalW} ${totalH}">
<g id="outline-black">${body}</g>
<g id="corner-guides">${guideBody}</g>
</svg>`;
  download('shadowbox-panels.svg', svg, 'image/svg+xml');
  closeExport();
}

function downloadDXF(){
  const {placed, guides} = buildNestedLayout();
  let ents='';
  function poly(pts, layer, closed){
    ents += `0\nLWPOLYLINE\n8\n${layer}\n90\n${pts.length}\n70\n${closed?1:0}\n`;
    for(const [x,y] of pts) ents += `10\n${x.toFixed(3)}\n20\n${(-y).toFixed(3)}\n`;
  }
  for(const p of placed){
    poly(p.outline, 'OUTLINE', true);
    for(const c of p.cutouts) poly(c, 'CUT', true);
  }
  for(const g of (guides||[])) poly(g, 'GUIDE', false);
  const dxf = `0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n0\nEOF\n`;
  download('shadowbox-panels.dxf', dxf, 'application/dxf');
  closeExport();
}

/* minimal vector PDF writer */
function downloadPDF(){
  const {placed, totalW, totalH, guides} = buildNestedLayout();
  const MM=2.834645669;
  let content = '';
  function drawPoly(pts, rgb, closed, dash){
    content += `${rgb[0]} ${rgb[1]} ${rgb[2]} RG\n0.4 w\n`;
    content += dash ? '[2 2] 0 d\n' : '[] 0 d\n';
    pts.forEach(([x,y],i)=>{
      const px=(x*MM).toFixed(2), py=((totalH-y)*MM).toFixed(2);
      content += `${px} ${py} ${i===0?'m':'l'}\n`;
    });
    content += `${closed?'s':'S'}\n`;
  }
  for(const p of placed){
    drawPoly(p.outline, [0,0,0], true, false);
    for(const c of p.cutouts) drawPoly(c, [1,0,0.1], true, false);
  }
  for(const g of (guides||[])) drawPoly(g, [0.27,0.53,1], false, true);

  // Print-scale calibration mark: a line + end-ticks measuring EXACTLY 50mm.
  // Browsers/printers frequently rescale pages ("fit to page", margins,
  // driver scaling) — measure this with a ruler after printing; if it isn't
  // exactly 50mm, the pattern isn't 1:1 and the print settings need fixing
  // (turn off "fit to page", print at 100%/"actual size").
  {
    const mx = 8*MM, my = 8*MM; // 8mm inset from the page's bottom-left corner
    content += `0 0 0 RG\n0.5 w\n[] 0 d\n`;
    content += `${mx.toFixed(2)} ${my.toFixed(2)} m ${(mx+50*MM).toFixed(2)} ${my.toFixed(2)} l S\n`;
    content += `${mx.toFixed(2)} ${(my-1.5*MM).toFixed(2)} m ${mx.toFixed(2)} ${(my+1.5*MM).toFixed(2)} l S\n`;
    content += `${(mx+50*MM).toFixed(2)} ${(my-1.5*MM).toFixed(2)} m ${(mx+50*MM).toFixed(2)} ${(my+1.5*MM).toFixed(2)} l S\n`;
  }

  const w=(totalW*MM).toFixed(2), h=(totalH*MM).toFixed(2);
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << >> >>`);
  objs.push(null); // placeholder for stream (built after)
  const stream = `stream\n${content}endstream`;
  objs[3] = `<< /Length ${content.length} >>\n${stream}`;

  let pdf = '%PDF-1.4\n';
  const offsets=[0];
  objs.forEach((o,i)=>{
    offsets.push(pdf.length);
    pdf += `${i+1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objs.length;i++) pdf += String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  download('shadowbox-panels.pdf', pdf, 'application/pdf');
  closeExport();
}
