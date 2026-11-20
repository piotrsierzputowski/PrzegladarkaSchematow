
pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';
const $=id=>document.getElementById(id);
const REF=/^\d{1,4}[.\-]\d{1,2}$/, MAX_DCOL=6;   // „230.2” (kropka) lub „050-3” (myślnik)
let pdf=null, N=0, cur=1, scale=1, fitMode='w', hl=null, history=[], cache=new Map(), renderTask=null, renderToken=0, pending=null;

/* ---------- Analiza strony (jak w narzędziu do edycji) ---------- */
const inter=(a,b)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
const colsAt=(S,x)=>Object.entries(S.hdr).filter(([c,cx])=>Math.abs(cx-x)<=Math.max(14,.62*S.colw)).map(([c])=>+c);
function extractPageD(pdf,cache,pi){
  if(!cache.has(pi)) cache.set(pi,(async()=>{
    const page=await pdf.getPage(pi+1), [,,W,H]=page.view;
    const tc=await page.getTextContent(), words=[];
    for(const it of tc.items){
      let s=(it.str||'').trim(); if(!s) continue;
      if(s.length<=30&&/^[A-Z0-9\-:_.()\/+,\s]+$/.test(s)) s=s.replace(/\s+/g,'');   // rozstrzelone teksty typu „FL- 01 0- 10 1”
      const [a,b,c,d,e,f]=it.transform, un=Math.hypot(a,b)||1, vn=Math.hypot(c,d)||1;
      const ux=a/un,uy=b/un,vx=c/vn,vy=d/vn,w=it.width,h=it.height||vn,k=.17*h,o0=-k,o1=h+k;
      const xs=[e+vx*o0,e+ux*w+vx*o0,e+vx*o1,e+ux*w+vx*o1], ys=[f+vy*o0,f+uy*w+vy*o0,f+vy*o1,f+uy*w+vy*o1];
      words.push({t:s,x0:Math.min(...xs),x1:Math.max(...xs),y0:H-Math.max(...ys),y1:H-Math.min(...ys)});
    }
    const links=[];
    for(const an of await page.getAnnotations()){
      if(an.subtype!=='Link'||!an.dest) continue;
      const [rx0,ry0,rx1,ry1]=an.rect; if(rx0<-1000) continue;
      let dest=an.dest; try{ if(typeof dest==='string') dest=await pdf.getDestination(dest) }catch(e){continue}
      if(!Array.isArray(dest)) continue;
      let tp; try{ tp=typeof dest[0]==='object'?await pdf.getPageIndex(dest[0]):dest[0] }catch(e){continue}
      links.push({rect:{x0:rx0,x1:rx1,y0:H-ry1,y1:H-ry0},tp});
    }
    let diag=null;
    for(const w of words) if(w.t.toLowerCase()==='diagram:'){
      let best=null;
      for(const x of words){const dy=x.y0-w.y0; if(dy>5&&dy<22&&x.x0>=w.x0-5&&x.x0<=w.x0+70&&!x.t.endsWith(':')&&(!best||dy<best.dy)) best={dy,t:x.t}}
      if(best){diag=best.t;break}
    }
    if(!diag) for(const w of words) if(w.t.toLowerCase()==='sheet'){      // standard SEE: „SHEET” + numer pod spodem
      let best=null;
      for(const x of words){const dy=x.y0-w.y0, cdx=Math.abs((x.x0+x.x1)/2-(w.x0+w.x1)/2); if(dy>1&&dy<25&&cdx<30&&/^\d+$/.test(x.t)&&(!best||dy<best.dy)) best={dy,t:x.t}}
      if(best){diag=best.t;break}
    }
    let loc=null;
    for(const w of words) if(w.t.toLowerCase()==='location:'){
      let best=null;
      for(const x of words){const dy=x.y0-w.y0; if(dy>5&&dy<22&&x.x0>=w.x0-5&&x.x0<=w.x0+70&&!x.t.endsWith(':')&&(!best||dy<best.dy)) best={dy,t:x.t}}
      if(best){loc=best.t;break}
    }
    const rows={};
    for(const x of words) if(/^\d+$/.test(x.t)&&x.y1<110&&+x.t>=1&&+x.t<=99) (rows[Math.round(x.y0)]??=[]).push(x);
    let hdr={}, hdrY=null;
    for(const row of Object.values(rows)){const n={}; for(const x of row) n[+x.t]=(x.x0+x.x1)/2; if(n[1]!==undefined&&Object.keys(n).length>Object.keys(hdr).length){hdr=n;hdrY={y0:Math.min(...row.map(x=>x.y0)),y1:Math.max(...row.map(x=>x.y1))}}}
    const hk=Object.keys(hdr).map(Number).sort((a,b)=>a-b), gp=hk.slice(1).map((c,i)=>hdr[c]-hdr[hk[i]]).sort((a,b)=>a-b), colw=gp.length?gp[gp.length>>1]:56;
    return {words,links,diag,loc,hdr,hdrY,colw,H,W};
  })());
  return cache.get(pi);
}
const extractPage=pi=>extractPageD(pdf,cache,pi);
function nameNear(words,cx,rect,maxgap){
  let best=null;
  for(const x of words){
    if(REF.test(x.t)) continue;
    if(Math.abs((x.x0+x.x1)/2-cx)>9||(x.x1-x.x0)<8||(x.y1-x.y0)<18) continue;
    const gap=Math.max(rect.y0-x.y1,x.y0-rect.y1); if(gap<-1||gap>maxgap) continue;
    if(!best||gap<best.gap) best={gap,t:x.t,w:x};
  }
  return best?{name:best.t,rect:best.w}:{name:null,rect:null};
}
/* Nazwa do wyświetlenia: najbliższy tekst obok odnośnika (także poziomy, np. oznaczenie elementu) */
function wireLabel(words,rect){
  const cx=(rect.x0+rect.x1)/2, cy=(rect.y0+rect.y1)/2; let best=null;
  const take=(sc,t)=>{if(!best||sc<best.sc) best={sc,t}};
  for(const x of words){
    if(REF.test(x.t)||/^[\d.]*\.$|^\.\d*$/.test(x.t)||x.t.length<2&&!/\d/.test(x.t)) continue;
    const horiz=(x.x1-x.x0)>(x.y1-x.y0);
    const dx=Math.abs((x.x0+x.x1)/2-cx), gap=Math.max(rect.y0-x.y1,x.y0-rect.y1,0);
    // tekst nad/pod odnośnikiem (przewód pionowy lub opis poziomy)
    if(dx<=(horiz?Math.max(18,rect.x1-rect.x0):12)&&gap<=(horiz?22:30)) take(gap+dx*.3,x.t);
    // opis poziomy w tym samym wierszu, po lewej lub prawej stronie odnośnika
    if(horiz&&Math.abs((x.y0+x.y1)/2-cy)<=8){
      const hg=x.x1<=rect.x0+3?rect.x0-x.x1:(x.x0>=rect.x1-3?x.x0-rect.x1:null);
      if(hg!==null&&hg<=70) take(hg*.5,x.t);
    }
  }
  return best?best.t:null;
}
/* Standard SEE (odnośnik „050-3”): dwuwierszowa etykieta (drugi wiersz = oznaczenie zacisku) + nazwa przewodu wzdłuż linii */
function wireInfo(words,rect){
  const cx=(rect.x0+rect.x1)/2, cy=(rect.y0+rect.y1)/2, vert=(rect.y1-rect.y0)>(rect.x1-rect.x0);
  let term=null, wire=null;
  for(const x of words){
    if(REF.test(x.t)||x.t.length<2) continue;
    const xc=(x.x0+x.x1)/2, yc=(x.y0+x.y1)/2, xv=(x.y1-x.y0)>(x.x1-x.x0);
    if(vert!==xv) continue;
    const dp=Math.abs((vert?xc-cx:yc-cy)); if(dp>12) continue;
    const a0=vert?'y0':'x0', a1=vert?'y1':'x1';
    const ov=Math.min(rect[a1],x[a1])-Math.max(rect[a0],x[a0]), len=x[a1]-x[a0];
    if(ov>0.3*Math.min(rect[a1]-rect[a0],len)){ if(dp>1&&(!term||dp<term.d)) term={d:dp,t:x.t,w:x} }
    else { const gap=Math.max(rect[a0]-x[a1],x[a0]-rect[a1]); if(gap<=(vert?60:70)&&len>=(vert?12:16)&&(!wire||gap<wire.g)) wire={g:gap,t:x.t,w:x} }
  }
  return {wire:wire&&wire.t, term:term&&term.t, termW:term&&term.w};
}
const unionRect=(a,b)=>b?{x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)}:a;

/* Kandydaci na potencjał docelowy dla odnośnika (po zawężeniu po nazwie przewodu/zacisku) */
async function candsFor(pi,lk){
  const S=await extractPage(pi), T=await extractPage(lk.tp), r=lk.rect;
  const inside=S.words.filter(x=>REF.test(x.t)&&inter(x,r));
  if(!inside.length) return null;
  const rcx=(r.x0+r.x1)/2, rcy=(r.y0+r.y1)/2, d2=a=>Math.hypot((a.x0+a.x1)/2-rcx,(a.y0+a.y1)/2-rcy);
  inside.sort((a,b)=>d2(a)-d2(b));
  const label=inside[0].t, lm=label.match(/^(\d+)([.\-])(\d+)$/), sep=lm[2], tc=+lm[3], std2=sep==='-';
  let sname,wire,term=null,extra=null;
  if(std2){const wi=wireInfo(S.words,inside[0]); sname=wi.wire; term=wi.term; wire=wi.wire||wi.term; extra=wi.wire&&wi.term?wi.term:null}
  else {sname=nameNear(S.words,rcx,r,30).name; wire=sname||wireLabel(S.words,r)}
  let cands=[];
  for(const c of colsAt(S,rcx)){
    const back=`${S.diag}${sep}${c}`;
    for(const x of T.words){
      if(x.t!==back) continue;
      const tcs=colsAt(T,(x.x0+x.x1)/2); if(!tcs.length) continue;
      const dl=Math.min(...tcs.map(k=>Math.abs(tc-k))); if(dl>MAX_DCOL) continue;
      if(lk.tp===pi&&inter(x,r)) continue;
      if(std2){const wi=wireInfo(T.words,x); cands.push({dl,x,name:wi.wire||wi.term,wire:wi.wire,term:wi.term,nrect:unionRect(x,wi.termW)})}
      else{const nn=nameNear(T.words,(x.x0+x.x1)/2,x,60); cands.push({dl,x,name:nn.name,wire:nn.name,term:null,nrect:nn.rect})}
    }
  }
  if(cands.length){const m=Math.min(...cands.map(c=>c.dl)); cands=cands.filter(c=>c.dl===m)}
  // zawężanie po nazwie przewodu, potem po oznaczeniu zacisku
  const narrow=f=>{const k=cands.filter(f); if(k.length&&k.length<cands.length) cands=k};
  if(cands.length>1&&sname) narrow(c=>c.wire===sname);
  return {S,T,label,sep,tc,std2,wire,sname,extra,cands,rcx,rcy};
}
const candKey=c=>Math.round(c.x.x0)+','+Math.round(c.x.y0);
const byPos=(ax,ay,bx,by)=>(Math.round(ax/3)-Math.round(bx/3))||(ay-by);

/* Standard SEE, ostatnia deska ratunku: wszystkie odnośniki z arkusza S na stronę T oraz wszystkie odwołania zwrotne do S na T — parowane wg kolejności */
async function globalPick(C,pi,lk){
  const {S,T}=C, re=new RegExp('^'+S.diag+'-(\\d{1,2})$');
  let B=T.words.filter(w=>re.test(w.t)).map(w=>({w,wire:wireInfo(T.words,w).wire})), A=[];
  for(const l2 of S.links){ if(l2.tp!==lk.tp) continue; const i2=S.words.find(x=>REF.test(x.t)&&inter(x,l2.rect)); if(i2) A.push({l:l2,x:(l2.rect.x0+l2.rect.x1)/2,y:(l2.rect.y0+l2.rect.y1)/2,wire:wireInfo(S.words,i2).wire}) }
  if(!A.length) return null;
  // najpierw po nazwie przewodu (jeśli się powtarza po obu stronach)
  const sw=C.sname;
  if(sw){
    const B2=B.filter(b=>b.wire===sw), A2=A.filter(a=>a.wire===sw);
    if(B2.length&&B2.length===A2.length){A=A2;B=B2}
  }
  if(A.length!==B.length) return null;
  A.sort((a,b)=>byPos(a.x,a.y,b.x,b.y)); B.sort((a,b)=>byPos(a.w.x0,a.w.y0,b.w.x0,b.w.y0));
  const i=A.findIndex(g=>g.l===lk); if(i<0) return null;
  const pick=B[i].w;
  const near=Object.entries(S.hdr).sort((a,b)=>Math.abs(a[1]-C.rcx)-Math.abs(b[1]-C.rcx))[0];
  if(near&&Math.abs(+pick.t.match(re)[1]-+near[0])>2) return null;     // kolumna w odwołaniu musi być zbliżona
  return pick;
}
function candFromWord(T,x){const wi=wireInfo(T.words,x); return {x,name:wi.wire||wi.term,wire:wi.wire,term:wi.term,nrect:unionRect(x,wi.termW)}}

/* Zwraca {rect,name} potencjału docelowego (współrzędne PDF od lewego górnego rogu) albo {fail:…} */
async function findTarget(pi,lk){
  const C=await candsFor(pi,lk); if(!C) return null;
  const {S,T,label,tc,std2,wire,extra}=C; let cands=C.cands;
  const fail=why=>({fail:why,label,col:tc,tp:lk.tp,sname:wire,extra,sdiag:S.diag});
  if(cands.length>1&&!std2) return fail('niejednoznaczne dopasowanie');
  if(cands.length>1){
    // standard SEE: kilka identycznych odwołań zwrotnych — przypisanie wg kolejności (z lewej do prawej)
    const sig=cands.map(candKey).sort().join('|'), group=[];
    for(const l2 of S.links){
      if(l2.tp!==lk.tp) continue;
      const c2=l2===lk?C:await candsFor(pi,l2); if(!c2||!c2.cands.length) continue;
      if(c2.cands.map(candKey).sort().join('|')===sig) group.push({l:l2,x:(l2.rect.x0+l2.rect.x1)/2,y:(l2.rect.y0+l2.rect.y1)/2});
    }
    if(group.length===cands.length){
      group.sort((a,b)=>byPos(a.x,a.y,b.x,b.y));
      cands=[...cands].sort((a,b)=>byPos(a.x.x0,a.x.y0,b.x.x0,b.x.y0));
      cands=[cands[group.findIndex(g=>g.l===lk)]];
    }else{
      const pick=await globalPick(C,pi,lk), hit=pick&&cands.find(c=>c.x===pick);
      if(!hit) return fail('niejednoznaczne dopasowanie');
      cands=[hit];
    }
  }
  if(!cands.length){
    if(!std2) return fail('brak odwołania zwrotnego');
    const pick=await globalPick(C,pi,lk);
    if(!pick) return fail('brak odwołania zwrotnego');
    cands=[candFromWord(T,pick)];
  }
  const c=cands[0];
  return {rect:c.nrect||c.x,name:c.name,label,sname:wire,extra,sdiag:S.diag,swire:C.sname,twire:c.wire};
}

/* ---------- Render ---------- */
async function renderPage(){
  const token=++renderToken;
  if(renderTask){try{renderTask.cancel()}catch(e){}}
  const page=await pdf.getPage(cur), view=$('view');
  if(fitMode==='w') scale=Math.max(.2,(view.clientWidth-34)/page.view[2]);
  else if(fitMode==='h') scale=Math.max(.2,(view.clientHeight-34)/page.view[3]);
  document.querySelectorAll('#fitw,#fith').forEach(b=>b.style.background='');
  if(fitMode) $(fitMode==='w'?'fitw':'fith').style.background='var(--bg)';
  const vp=page.getViewport({scale}), dpr=window.devicePixelRatio||1, cv=$('cv');
  cv.width=Math.floor(vp.width*dpr); cv.height=Math.floor(vp.height*dpr);
  cv.style.width=vp.width+'px'; cv.style.height=vp.height+'px';
  const box=$('pagebox'); box.style.width=vp.width+'px'; box.style.height=vp.height+'px';
  box.classList.remove('hide'); $('empty').classList.add('hide');
  renderTask=page.render({canvasContext:cv.getContext('2d'),viewport:vp,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null});
  renderTask.promise.catch(()=>{});
  const S=await extractPage(cur-1);
  if(token!==renderToken) return;
  // warstwa linków
  const L=$('links'); L.innerHTML='';
  for(const lk of S.links){
    const r=lk.rect, d=document.createElement('div'); d.className='lk';
    Object.assign(d.style,{left:r.x0*scale+'px',top:r.y0*scale+'px',width:Math.max(6,(r.x1-r.x0)*scale)+'px',height:Math.max(6,(r.y1-r.y0)*scale)+'px'});
    d.onclick=ev=>{ev.stopPropagation();followLink(cur-1,lk)};
    L.appendChild(d);
  }
  drawHl(); drawHits(); drawAnn();
  $('pno').value=cur; $('dno').value=S.diag||''; $('info').textContent='/ '+N; $('diag').textContent=S.diag?('Diagram '+S.diag):'';
  $('prev').disabled=cur<=1; $('next').disabled=cur>=N; $('back').disabled=history.length===0;
  try{await renderTask.promise}catch(e){}
  if(token===renderToken&&pending){const p=pending;pending=null;scrollToRect(p)}
}
async function columnRect(pi,col){
  const T=await extractPage(pi), hs=Object.keys(T.hdr).map(Number).sort((a,b)=>a-b);
  if(!(col in T.hdr)||!T.hdrY) return null;
  const gaps=hs.slice(1).map((c,i)=>T.hdr[c]-T.hdr[hs[i]]), w=gaps.length?gaps.sort((a,b)=>a-b)[gaps.length>>1]:56;
  const cx=T.hdr[col], top=T.hdrY.y0-5, bot=T.hdrY.y1+5;
  return {head:{x0:cx-w/2,x1:cx+w/2,y0:top,y1:bot},band:{x0:cx-w/2,x1:cx+w/2,y0:bot,y1:T.H-62}};
}
function drawHl(){
  const el=$('hl'), bd=$('band');
  bd.classList.add('hide');
  if(!hl||hl.page!==cur-1){el.classList.add('hide');return}
  if(hl.band){const b=hl.band;Object.assign(bd.style,{left:b.x0*scale+'px',top:b.y0*scale+'px',width:(b.x1-b.x0)*scale+'px',height:(b.y1-b.y0)*scale+'px'});bd.classList.remove('hide')}
  const m=hl.band?2:4,r=hl.rect;
  Object.assign(el.style,{left:(r.x0-m)*scale+'px',top:(r.y0-m)*scale+'px',width:(r.x1-r.x0+2*m)*scale+'px',height:(r.y1-r.y0+2*m)*scale+'px'});
  el.classList.remove('hide'); el.style.animation='none'; void el.offsetWidth; el.style.animation='';
}
function scrollToRect(r){
  const v=$('view'), box=$('pagebox');
  const cx=box.offsetLeft+(r.x0+r.x1)/2*scale, cy=box.offsetTop+(r.y0+r.y1)/2*scale;
  v.scrollTo({left:cx-v.clientWidth/2,top:cy-v.clientHeight/2,behavior:'smooth'});
}
function say(html,warn){const m=$('msg');m.innerHTML=html;m.classList.toggle('warn',!!warn)}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/* ---------- Nawigacja ---------- */
function pushHistory(){const v=$('view');history.push({page:cur,x:v.scrollLeft,y:v.scrollTop,hl});if(history.length>100)history.shift()}
async function goPage(n,opts={}){
  n=Math.min(N,Math.max(1,n)); if(!opts.noHistory&&n!==cur) pushHistory();
  cur=n; if(opts.clearHl) hl=null; await renderPage();
  if(opts.scroll==='top') $('view').scrollTo({left:$('view').scrollLeft,top:0});
  else if(opts.scroll==='bottom') $('view').scrollTo({left:$('view').scrollLeft,top:1e7});
}
async function followLink(pi,lk){
  say('Szukam potencjału…');
  let t=null; try{t=await findTarget(pi,lk)}catch(e){console.error(e)}
  pushHistory();
  if(t&&!t.fail){
    hl={page:lk.tp,rect:t.rect};
    pending=t.rect; cur=lk.tp+1; await renderPage();
    say(`Z diagramu <b>${esc(t.sdiag??'?')}</b> (strona ${pi+1}): odnośnik <b>${esc(t.label)}</b>${t.sname?' · przewód <b>'+esc(t.sname)+'</b>'+(t.extra?' ('+esc(t.extra)+')':''):''} → potencjał <b>${esc(t.name||t.label)}</b>, diagram ${esc((await extractPage(cur-1)).diag??'?')} (strona ${cur}).`);
  }else{
    const label=t&&t.label, col=t&&t.col, wire=t&&t.sname, wex=t&&t.extra, sdg=t&&t.sdiag;
    const cr=label?await columnRect(lk.tp,col):null;
    hl=cr?{page:lk.tp,rect:cr.head,band:cr.band}:null;
    pending=cr?cr.head:null; cur=lk.tp+1; await renderPage();
    if(!cr) $('view').scrollTo({left:0,top:0});
    const dg=(await extractPage(cur-1)).diag, where=`diagram ${esc(dg??'?')} (strona ${cur})`;
    say(label
      ? `⚠ Z diagramu <b>${esc(sdg??'?')}</b> (strona ${pi+1}): nie znaleziono potencjału dla odnośnika <b>${esc(label)}</b>${wire?' · przewód <b>'+esc(wire)+'</b>'+(wex?' ('+esc(wex)+')':''):''} — ${cr?'zaznaczono kolumnę <b>'+col+'</b> u góry, ':''}${where}.`
      : `⚠ Nie rozpoznano odnośnika na stronie ${pi+1} — przejście na stronę ${cur} bez zaznaczenia.`, true);
  }
}
async function goBack(){
  const h=history.pop(); if(!h) return;
  hl=h.hl; cur=h.page; await renderPage(); $('view').scrollTo({left:h.x,top:h.y}); say('Powrót.');
  $('back').disabled=history.length===0;
}

/* ---------- Otwieranie pliku ---------- */
async function openFile(f){
  try{
    say('Wczytywanie…');
    const data=new Uint8Array(await f.arrayBuffer());
    resetCmp(); curName=f.name; annOpen(f); if(pdf) pdf.destroy();
    pdf=await pdfjsLib.getDocument({data}).promise; N=pdf.numPages; cur=1; hl=null; history=[]; cache=new Map(); fitMode='w';
    $('pno').max=N; ['prev','next','zin','zout','fitw','fith','pno','dno','q','qprev','qnext','cmpb','annb'].forEach(i=>$(i).disabled=false);
    sr={q:'',res:[],idx:-1}; $('q').value=''; qCount(); startScan(); await renderPage(); $('view').scrollTo({left:0,top:0});
    say(`Wczytano „${esc(f.name)}" (${N} stron). Kliknij odnośnik między potencjałami, aby przejść do niego z obramowaniem.`);
  }catch(e){console.error(e);say('Błąd wczytywania pliku: '+esc(e.message||e))}
}
$('file').onchange=e=>{if(e.target.files[0]) openFile(e.target.files[0])};
const v=$('view');
['dragenter','dragover'].forEach(e=>v.addEventListener(e,ev=>{ev.preventDefault();$('empty').classList.add('over')}));
['dragleave','drop'].forEach(e=>v.addEventListener(e,ev=>{ev.preventDefault();$('empty').classList.remove('over')}));
v.addEventListener('drop',ev=>{if(ev.dataTransfer.files[0]) openFile(ev.dataTransfer.files[0])});

/* ---------- Sterowanie ---------- */
$('prev').onclick=()=>goPage(cur-1,{noHistory:true}); $('next').onclick=()=>goPage(cur+1,{noHistory:true});
$('pno').onchange=()=>goPage(+$('pno').value||cur); $('back').onclick=goBack;

/* ---------- Wyszukiwarka tekstu ---------- */
let sr={q:'',res:[],idx:-1}, qTimer=null;
function drawHits(){
  const H=$('hits'); H.innerHTML='';
  sr.res.forEach((h,i)=>{
    if(h.page!==cur-1) return;
    const d=document.createElement('div'); d.className='hit'+(i===sr.idx?' cur':'');
    const r=h.rect;
    Object.assign(d.style,{left:r.x0*scale+'px',top:r.y0*scale+'px',width:(r.x1-r.x0)*scale+'px',height:(r.y1-r.y0)*scale+'px'});
    H.appendChild(d);
  });
}
function qCount(){
  $('qcount').textContent=sr.q?(sr.res.length?`${sr.idx+1} / ${sr.res.length}`:'brak'):'';
  $('qprev').disabled=$('qnext').disabled=!sr.res.length;
}
async function runSearch(jump){
  const q=$('q').value.trim().toLowerCase();
  if(!pdf) return;
  if(!q){sr={q:'',res:[],idx:-1};qCount();drawHits();return}
  if(q===sr.q&&sr.res.length&&jump){return step(1)}
  say('Szukam „'+esc(q)+'”…'); await scanP;
  const res=[];
  for(let i=0;i<N;i++){
    const S=await extractPage(i);
    const qn=q.replace(/\s+/g,'');
    for(const w of S.words){const tl=w.t.toLowerCase(); if(tl.includes(q)||tl.includes(qn)) res.push({page:i,rect:{x0:w.x0,x1:w.x1,y0:w.y0,y1:w.y1}})}
    if(res.length>5000) break;
  }
  if($('q').value.trim().toLowerCase()!==q) return;       // użytkownik zmienił zapytanie w trakcie
  let idx=res.findIndex(h=>h.page>=cur-1);
  sr={q,res,idx:res.length?(idx<0?0:idx):-1}; qCount();
  if(!res.length){drawHits();say(`⚠ Nie znaleziono tekstu <b>${esc(q)}</b>.`,true);return}
  say(`Znaleziono <b>${res.length}</b> wystąpień „${esc(q)}” na ${new Set(res.map(h=>h.page)).size} stronach. Enter — następne, Shift+Enter — poprzednie.`);
  if(jump) showHit();
  else drawHits();
}
async function showHit(){
  const h=sr.res[sr.idx]; if(!h) return;
  qCount();
  if(h.page!==cur-1){pending=h.rect; await goPage(h.page+1,{noHistory:true})}
  else {drawHits(); scrollToRect(h.rect)}
  const dg=(await extractPage(h.page)).diag;
  say(`Wynik <b>${sr.idx+1}</b> z ${sr.res.length}: „${esc($("q").value.trim()||sr.q)}” — diagram ${esc(dg??'?')} (strona ${h.page+1}).`);
}
function step(d){
  if(!sr.res.length) return;
  sr.idx=(sr.idx+d+sr.res.length)%sr.res.length; showHit();
}
$('q').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();clearTimeout(qTimer);
    if($('q').value.trim().toLowerCase()===sr.q&&sr.res.length) step(e.shiftKey?-1:1); else runSearch(true)}
  else if(e.key==='Escape'){$('q').value='';runSearch(false);$('q').blur()}
});
$('q').addEventListener('input',()=>{clearTimeout(qTimer);qTimer=setTimeout(()=>runSearch(false),400)});
$('qnext').onclick=()=>step(1); $('qprev').onclick=()=>step(-1);
addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&pdf){e.preventDefault();$('q').focus();$('q').select()}});

/* ---------- Wybór diagramu ---------- */
let diagMap=new Map(), scanP=null, locMap={};
function startScan(){
  diagMap=new Map(); locMap={}; $('dlist').innerHTML='';
  const my=pdf;
  scanP=(async()=>{
    for(let i=0;i<N&&pdf===my;i++){
      const S=await extractPage(i);
      if(S.diag){ if(!diagMap.has(S.diag)) diagMap.set(S.diag,[]); diagMap.get(S.diag).push(i+1) }
      locMap[i+1]=S.loc||'';
      if(i%6===5) await new Promise(r=>setTimeout(r,0));
    }
    if(pdf!==my) return;
    const keys=[...diagMap.keys()].sort((a,b)=>(parseFloat(a)-parseFloat(b))||a.localeCompare(b));
    $('dlist').innerHTML=keys.map(k=>`<option value="${esc(k)}">strona ${diagMap.get(k).map(n=>n+(locMap[n]?' ('+esc(locMap[n])+')':'')).join(', ')}</option>`).join('');
  })();
}
async function gotoDiagram(){
  const q=$('dno').value.trim(); if(!q) return;
  say('Szukam diagramu '+esc(q)+'…'); await scanP;
  const pages=diagMap.get(q);
  if(!pages){ say(`⚠ W pliku nie ma diagramu <b>${esc(q)}</b>.`,true); $('dno').value=(await extractPage(cur-1)).diag||''; return }
  const here=pages.indexOf(cur), n=here>=0?pages[(here+1)%pages.length]:pages[0];
  await goPage(n,{noHistory:false}); $('view').scrollTo({left:0,top:0});
  say(`Diagram <b>${esc(q)}</b> — strona ${n}${locMap[n]?' ('+esc(locMap[n])+')':''}${pages.length>1?` · ten numer występuje na ${pages.length} stronach: ${pages.map(x=>x+(locMap[x]?' ('+esc(locMap[x])+')':'')).join(', ')} — kolejny Enter przejdzie do następnej`:''}.`);
}
$('dno').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();gotoDiagram()}});
$('dno').addEventListener('input',e=>{ if((e.inputType==='insertReplacementText'||!e.inputType)&&diagMap.has($('dno').value.trim())) gotoDiagram() });
const zoom=f=>{fitMode=null;scale=Math.min(6,Math.max(.2,scale*f));renderPage()};
$('zin').onclick=()=>zoom(1.25); $('zout').onclick=()=>zoom(.8); $('fitw').onclick=()=>{fitMode='w';renderPage().then(()=>$('view').scrollTo({left:0,top:0}))}; $('fith').onclick=()=>{fitMode='h';renderPage().then(()=>$('view').scrollTo({left:0,top:0}))};
addEventListener('keydown',e=>{
  if(!pdf||cmpOpen||e.target.tagName==='INPUT'||e.target.isContentEditable) return;
  if(e.key==='ArrowLeft'&&e.altKey){e.preventDefault();goBack()}
  else if(e.key==='PageDown'||e.key==='ArrowRight'){goPage(cur+1,{noHistory:true})}
  else if(e.key==='PageUp'||e.key==='ArrowLeft'){goPage(cur-1,{noHistory:true})}
  else if(e.key==='+'||e.key==='='){zoom(1.25)} else if(e.key==='-'){zoom(.8)}
  else if(e.key==='Escape'){hl=null;drawHl()}
});
let wheelLock=0;
v.addEventListener('wheel',e=>{
  if(!pdf) return;
  if(e.ctrlKey){e.preventDefault();zoom(e.deltaY<0?1.1:.91);return}
  // przewijanie kolejnych stron: na krawędzi strony kółko przechodzi do następnej/poprzedniej
  const atBottom=v.scrollTop+v.clientHeight>=v.scrollHeight-2, atTop=v.scrollTop<=1, now=Date.now();
  const down=e.deltaY>0&&atBottom&&cur<N, up=e.deltaY<0&&atTop&&cur>1;
  if(!(down||up)) return;
  e.preventDefault();
  if(now<wheelLock){wheelLock=now+220;return}   // wygaszanie bezwładności gładzika
  wheelLock=now+500;
  goPage(cur+(down?1:-1),{noHistory:true,scroll:down?'top':'bottom'});
},{passive:false});
addEventListener('resize',()=>{if(pdf&&fitMode) renderPage()});
// przeciąganie widoku
let drag=null;
v.addEventListener('mousedown',e=>{if(e.button||e.target.classList.contains('lk')||annBlock(e)) return;drag={x:e.clientX,y:e.clientY,l:v.scrollLeft,t:v.scrollTop};v.classList.add('drag')});
addEventListener('mousemove',e=>{if(!drag) return;v.scrollLeft=drag.l-(e.clientX-drag.x);v.scrollTop=drag.t-(e.clientY-drag.y)});
addEventListener('mouseup',()=>{drag=null;v.classList.remove('drag')});

/* ---------- Porównywanie wersji ---------- */
let cmp=null, cmpOpen=false, cmpMode='ov', cmpFit='w', cmpScale=1, curName='', blinkT=null;
const tick=()=>new Promise(r=>setTimeout(r,0));
const DATE_RE=/^(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}(\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}:\d{2}(:\d{2})?)$/;
const cex=(X,i)=>extractPageD(X.doc,X.cache,i);
function resetCmp(){ if(cmp){cmp.run=-1; for(const X of [cmp.A,cmp.B]) if(X&&X.doc!==pdf){try{X.doc.destroy()}catch(e){}}} cmp=null; stopBlink(); }
function cmsg(h){$('cmsg').innerHTML=h}
function stopBlink(){if(blinkT){clearInterval(blinkT);blinkT=null}}

function lumOf(d,n){const L=new Uint8Array(n); for(let i=0,j=0;i<n;i++,j+=4) L[i]=(d[j]*77+d[j+1]*150+d[j+2]*29)>>8; return L}
function dil(m,w,h,r){
  const t=new Uint8Array(w*h), o=new Uint8Array(w*h), cs=new Int32Array(Math.max(w,h)+1);
  for(let y=0;y<h;y++){const b=y*w; cs[0]=0; for(let x=0;x<w;x++) cs[x+1]=cs[x]+m[b+x];
    for(let x=0;x<w;x++){const a=x-r<0?0:x-r, z=x+r+1>w?w:x+r+1; t[b+x]=cs[z]-cs[a]>0?1:0}}
  for(let x=0;x<w;x++){cs[0]=0; for(let y=0;y<h;y++) cs[y+1]=cs[y]+t[y*w+x];
    for(let y=0;y<h;y++){const a=y-r<0?0:y-r, z=y+r+1>h?h:y+r+1; o[y*w+x]=cs[z]-cs[a]>0?1:0}}
  return o;
}
function diffMasks(LA,LB,w,h,r){
  const n=w*h, ia=new Uint8Array(n), ib=new Uint8Array(n);
  for(let i=0;i<n;i++){ia[i]=LA[i]<215?1:0; ib[i]=LB[i]<215?1:0}
  const da=dil(ia,w,h,r), db=dil(ib,w,h,r), rem=new Uint8Array(n), add=new Uint8Array(n);
  for(let i=0;i<n;i++){rem[i]=ia[i]&&!db[i]?1:0; add[i]=ib[i]&&!da[i]?1:0}
  return {rem,add};
}
function clusterMasks(M,w,h,s){      // → prostokąty w pt (układ od lewego górnego rogu)
  const cs=8, gw=Math.ceil(w/cs), gh=Math.ceil(h/cs), cnt=new Int32Array(gw*gh);
  for(let y=0;y<h;y++){const b=y*w, gy=(y/cs|0)*gw; for(let x=0;x<w;x++) if(M.rem[b+x]|M.add[b+x]) cnt[gy+(x/cs|0)]++}
  const act=[]; for(let i=0;i<cnt.length;i++) if(cnt[i]>=2) act.push(i);
  const gap=Math.max(1,Math.round(30*s/cs)), vis=new Uint8Array(cnt.length), regs=[];
  for(const st of act){
    if(vis[st]) continue; vis[st]=1; const q=[st]; let x0=1e9,y0=1e9,x1=-1,y1=-1,px=0;
    while(q.length){
      const c=q.pop(), cx=c%gw, cy=(c/gw)|0; px+=cnt[c];
      if(cx<x0)x0=cx; if(cx>x1)x1=cx; if(cy<y0)y0=cy; if(cy>y1)y1=cy;
      for(let yy=Math.max(0,cy-gap);yy<=Math.min(gh-1,cy+gap);yy++) for(let xx=Math.max(0,cx-gap);xx<=Math.min(gw-1,cx+gap);xx++){
        const k=yy*gw+xx; if(!vis[k]&&cnt[k]>=2){vis[k]=1;q.push(k)}
      }
    }
    if(px<10) continue;
    regs.push({x0:x0*cs/s-3,y0:y0*cs/s-3,x1:(x1+1)*cs/s+3,y1:(y1+1)*cs/s+3,px});
  }
  regs.sort((a,b)=>(Math.round(a.y0/40)-Math.round(b.y0/40))||(a.x0-b.x0));
  return regs;
}
async function rasterCanvas(page,ps,w,h){
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const x=c.getContext('2d',{willReadFrequently:true}); x.fillStyle='#fff'; x.fillRect(0,0,w,h);
  if(page) await page.render({canvasContext:x,viewport:page.getViewport({scale:ps})}).promise;
  return c;
}
function msDiff(a,b){
  const m=new Map(); for(const t of a) m.set(t,(m.get(t)||0)+1);
  const add=[]; for(const t of b){const c=m.get(t)||0; if(c>0) m.set(t,c-1); else add.push(t)}
  const rem=[]; for(const [t,c] of m) for(let k=0;k<c;k++) rem.push(t);
  return {add,rem};
}
const wordsIn=(ws,r)=>ws.filter(w=>w.x1>r.x0-1&&w.x0<r.x1+1&&w.y1>r.y0-1&&w.y0<r.y1+1).map(w=>w.t);

function pairPages(ka,kb){
  const ma=new Map(); ka.forEach((k,i)=>{if(k){if(!ma.has(k))ma.set(k,[]); ma.get(k).push(i)}});
  const used=new Set(), bToA=kb.map(()=>-1), cnt=new Map();
  kb.forEach((k,j)=>{ if(!k) return; const l=ma.get(k); if(!l) return; const c=cnt.get(k)||0; if(c<l.length){bToA[j]=l[c]; used.add(l[c]); cnt.set(k,c+1)} });
  kb.forEach((k,j)=>{ if(bToA[j]<0&&!k&&j<ka.length&&!ka[j]&&!used.has(j)){bToA[j]=j; used.add(j)} });
  const E=kb.map((k,j)=>({a:bToA[j]>=0?bToA[j]:null,b:j,pos:j,key:k||(ka[bToA[j]]||'')}));
  const posA=ka.map(()=>null); E.forEach(e=>{if(e.a!=null) posA[e.a]=e.pos});
  let last=-1;
  ka.forEach((k,i)=>{ if(posA[i]!=null){last=posA[i]; return} E.push({a:i,b:null,pos:last+.5+i*1e-6,key:k}) });
  E.sort((x,y)=>x.pos-y.pos);
  E.forEach((e,i)=>{e.i=i; e.st=e.a==null?'new':e.b==null?'del':'pend'});
  return E;
}
function diffEntry(e){
  const my=cmp;
  if(e.p) return e.p;
  if(e.a==null||e.b==null) return e.p=Promise.resolve({regions:[]});
  return e.p=(async()=>{
    const [pa,pb]=await Promise.all([my.A.doc.getPage(e.a+1),my.B.doc.getPage(e.b+1)]);
    const W=Math.max(pa.view[2],pb.view[2]), H=Math.max(pa.view[3],pb.view[3]), s=1300/W, w=Math.ceil(W*s), h=Math.ceil(H*s);
    const [ca,cb]=await Promise.all([rasterCanvas(pa,s,w,h),rasterCanvas(pb,s,w,h)]);
    const LA=lumOf(ca.getContext('2d').getImageData(0,0,w,h).data,w*h), LB=lumOf(cb.getContext('2d').getImageData(0,0,w,h).data,w*h);
    const M=diffMasks(LA,LB,w,h,Math.max(1,Math.round(2*s)));
    let regs=clusterMasks(M,w,h,s);
    if(regs.length>6){                                   // strony-tabele: wiele zmian po przesunięciu wierszy → łączymy w pasy poziome
      const bands=[]; for(const r of [...regs].sort((a,b)=>a.y0-b.y0)){const L=bands[bands.length-1];
        if(L&&r.y0<L.y1+4){L.x0=Math.min(L.x0,r.x0);L.x1=Math.max(L.x1,r.x1);L.y1=Math.max(L.y1,r.y1);L.px+=r.px} else bands.push({...r})}
      regs=bands;
    }
    const [SA,SB]=await Promise.all([cex(my.A,e.a),cex(my.B,e.b)]), out=[];
    const inT=new Uint8Array(w*h);                       // maska: piksele leżące na tekstach (stary lub nowy)
    for(const wd of [...SA.words,...SB.words]){
      const x0=Math.max(0,Math.floor((wd.x0-2)*s)), x1=Math.min(w,Math.ceil((wd.x1+2)*s)), y0=Math.max(0,Math.floor((wd.y0-2)*s)), y1=Math.min(h,Math.ceil((wd.y1+2)*s));
      for(let y=y0;y<y1;y++) inT.fill(1,y*w+x0,y*w+x1);
    }
    for(const r of regs){
      const wa=wordsIn(SA.words,r), wb=wordsIn(SB.words,r);
      let d=msDiff(wa,wb); const ca=[...wa.join('').replace(/\s+/g,'')], cb=[...wb.join('').replace(/\s+/g,'')], cd=msDiff(ca,cb);
      if(!cd.add.length&&!cd.rem.length) d={add:[],rem:[]};   // te same znaki = inny podział/odstępy tekstu, nie zmiana
      const toks=[...d.add,...d.rem];
      if(toks.length&&toks.every(t=>DATE_RE.test(t))) continue;     // same daty wydruku / modyfikacji
      if(!toks.length){                                              // identyczny tekst, a piksele różne = „duchy” czcionek, nie zmiana
        let tot=0,txt=0; const x0=Math.max(0,Math.floor(r.x0*s)), x1=Math.min(w,Math.ceil(r.x1*s)), y0=Math.max(0,Math.floor(r.y0*s)), y1=Math.min(h,Math.ceil(r.y1*s));
        for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){const i=y*w+x; if(M.rem[i]|M.add[i]){tot++; if(inT[i]) txt++}}
        if(tot&&txt/tot>.85) continue;
      }
      out.push({...r,add:d.add,rem:d.rem});
    }
    return {regions:out};
  })().then(res=>{ if(cmp===my){e.st=res.regions.length?'diff':'same'; e.n=res.regions.length; updItem(e)} return res },
            err=>{console.error(err); if(cmp===my){e.st='err'; updItem(e)} return {regions:[]}});
}

/* --- lista stron --- */
function itemHtml(e){
  const l=e.a==null?`str. ${e.b+1}`:e.b==null?`str. ${e.a+1} <small>(stara)</small>`:`str. ${e.b+1}${e.a!==e.b?` <small>(było ${e.a+1})</small>`:''}`;
  const tg=e.st==='diff'?`<span class="tg diff">${e.n} zm.</span>`:e.st==='del'?'<span class="tg del">usunięta</span>':e.st==='new'?'<span class="tg new">nowa</span>':e.st==='same'?'<small>bez zmian</small>':e.st==='err'?'<small>błąd</small>':'<small>…</small>';
  return `<div>${l}${e.key?`<br><small>diagram ${esc(e.key)}</small>`:''}</div>${tg}`;
}
function visibleEntry(e){return !($('conly').checked&&e.st==='same')}
function renderList(){
  const L=$('citems'); L.innerHTML=''; if(!cmp) return;
  for(const e of cmp.E){const d=document.createElement('div'); d.className='it'+(cmp.cur===e.i?' on':''); d.id='it'+e.i; d.innerHTML=itemHtml(e); d.onclick=()=>showEntry(e.i,0); if(!visibleEntry(e)) d.classList.add('hide'); L.appendChild(d)}
}
function updItem(e){const d=$('it'+e.i); if(!d) return; d.innerHTML=itemHtml(e); d.classList.toggle('hide',!visibleEntry(e))}
function summary(){
  const c={diff:0,same:0,del:0,new:0,pend:0}; for(const e of cmp.E) c[e.st]=(c[e.st]||0)+1;
  return c;
}

/* --- start porównania --- */
function syncNames(){ $('cnA').textContent=cmp?cmp.A.name:'–'; $('cnB').textContent=cmp&&cmp.B?cmp.B.name:'nie wczytano'; $('cswap').disabled=!(cmp&&cmp.B) }
function openCmp(){
  if(!pdf) return;
  if(!cmp||(cmp.A.doc!==pdf&&!(cmp.B&&cmp.B.doc===pdf))){ resetCmp(); cmp={A:{doc:pdf,name:curName,cache,n:N},B:null,E:[],run:0,cur:-1,reg:-1,rt:0}; }
  cmpOpen=true; $('cmp').classList.remove('hide'); syncNames();
  if(!cmp.B){ $('crow').innerHTML=''; $('cempty').classList.remove('hide'); cmsg('Wczytaj drugą wersję PDF, aby porównać ją z otwartą ('+esc(cmp.A.name)+').'); ['cprev','cnext'].forEach(i=>$(i).disabled=true); renderList() }
  else if(cmp.cur>=0) showEntry(cmp.cur,cmp.reg);
}
function closeCmp(){cmpOpen=false; stopBlink(); $('cmp').classList.add('hide')}
async function loadB(f){
  try{
    cmsg('Wczytywanie…');
    const doc=await pdfjsLib.getDocument({data:new Uint8Array(await f.arrayBuffer())}).promise;
    if(cmp.B&&cmp.B.doc!==pdf) try{cmp.B.doc.destroy()}catch(e){}
    cmp.B={doc,name:f.name,cache:new Map(),n:doc.numPages}; startCmp();
  }catch(e){console.error(e); cmsg('Błąd wczytywania pliku: '+esc(e.message||e))}
}
async function startCmp(){
  const my=cmp, run=++my.run; syncNames(); stopBlink();
  my.E=[]; my.cur=-1; my.reg=-1; $('crow').innerHTML=''; $('citems').innerHTML=''; $('cempty').classList.add('hide'); $('cprog').textContent='';
  ['cprev','cnext'].forEach(i=>$(i).disabled=true);
  const keys=async X=>{const r=[]; for(let i=0;i<X.n;i++){ if(my.run!==run) return null; r.push((await cex(X,i)).diag||''); if(i%8===7){cmsg(`Odczyt numerów diagramów… ${r.length}/${X.n} (${esc(X.name)})`); await tick()} } return r};
  const ka=await keys(my.A); if(!ka) return; const kb=await keys(my.B); if(!kb||my.run!==run) return;
  my.E=pairPages(ka,kb); renderList(); ['cprev','cnext'].forEach(i=>$(i).disabled=false);
  cmsg(`Sparowano strony według numerów diagramów: stara ${my.A.n} str., nowa ${my.B.n} str. Trwa analiza różnic…`);
  const first=my.E.findIndex(e=>e.st!=='same'); showEntry(Math.max(0,first),0);
  const todo=my.E.filter(e=>e.st==='pend'); let done=0;
  for(const e of todo){
    if(my.run!==run) return;
    await diffEntry(e); done++; $('cprog').textContent=`Analiza ${done}/${todo.length}…`; await tick();
  }
  if(my.run!==run) return;
  const c=summary(); $('cprog').textContent=`Zmienione: ${c.diff} · bez zmian: ${c.same} · usunięte: ${c.del} · nowe: ${c.new}`;
  if(cmp===my&&cmpOpen) cmsg(`Analiza zakończona: zmienione strony — <b>${c.diff}</b>, bez zmian — ${c.same}, usunięte — ${c.del}, nowe — ${c.new}. Użyj „Następna zmiana" (N), aby przejść po kolei.`);
}

/* --- widok strony --- */
function composite(cA,cB,w,h,ps){
  const LA=lumOf(cA.getContext('2d').getImageData(0,0,w,h).data,w*h), LB=lumOf(cB.getContext('2d').getImageData(0,0,w,h).data,w*h);
  const M=diffMasks(LA,LB,w,h,Math.max(1,Math.round(2*ps)));
  const c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d'), im=x.createImageData(w,h), o=im.data;
  for(let i=0,j=0;i<w*h;i++,j+=4){
    let r=255,g=255,b=255;
    if(M.rem[i]){const a=(255-LA[i])/255; r=255-a*(255-215); g=255-a*(255-20); b=255-a*(255-20)}
    else if(M.add[i]){const a=(255-LB[i])/255; r=255-a*255; g=255-a*(255-150); b=255-a*(255-40)}
    else{const m=Math.min(LA[i],LB[i]); const v=255-(255-m)*.42; r=g=b=v}
    o[j]=r;o[j+1]=g;o[j+2]=b;o[j+3]=255;
  }
  x.putImageData(im,0,0); return c;
}
async function showEntry(i,reg){
  const my=cmp; if(!my||!my.E[i]) return; const e=my.E[i], tok=++my.rt, prev=my.cur; my.cur=i; my.reg=-1; stopBlink();
  document.querySelectorAll('#citems .it.on').forEach(d=>d.classList.remove('on')); const li=$('it'+i); if(li){li.classList.add('on'); li.scrollIntoView({block:'nearest'})}
  cmsg(`Strona ${e.b!=null?e.b+1:e.a+1}${e.key?` · diagram ${esc(e.key)}`:''} — ładowanie…`);
  const [pa,pb]=await Promise.all([e.a!=null?my.A.doc.getPage(e.a+1):null,e.b!=null?my.B.doc.getPage(e.b+1):null]);
  if(tok!==my.rt) return;
  const W=Math.max(pa?pa.view[2]:0,pb?pb.view[2]:0), H=Math.max(pa?pa.view[3]:0,pb?pb.view[3]:0), view=$('cview');
  const sbs=cmpMode==='sbs';
  if(cmpFit==='w') cmpScale=Math.max(.2,((view.clientWidth-34-(sbs?14:0))/(sbs?2:1))/W);
  else if(cmpFit==='h') cmpScale=Math.max(.2,(view.clientHeight-34)/H);
  const sc=cmpScale; let ps=sc*Math.min(2,window.devicePixelRatio||1); if(W*ps>6500) ps=6500/W;
  const w=Math.ceil(W*ps), h=Math.ceil(H*ps);
  const [cA,cB]=await Promise.all([rasterCanvas(pa,ps,w,h),rasterCanvas(pb,ps,w,h)]);
  if(tok!==my.rt) return;
  $('cempty').classList.add('hide'); const row=$('crow'); row.innerHTML=''; $('clg').style.visibility=cmpMode==='ov'?'visible':'hidden';
  const wraps=[], cssW=W*sc, cssH=H*sc;
  const mk=(canvas,label)=>{const d=document.createElement('div'); d.className='cp'; d.style.width=cssW+'px'; d.style.height=cssH+'px'; canvas.style.width=cssW+'px'; canvas.style.height=cssH+'px'; d.appendChild(canvas);
    const b=document.createElement('div'); b.className='cbadge'; b.textContent=label; d.appendChild(b); row.appendChild(d); wraps.push(d); return {d,b}};
  if(cmpMode==='sbs'){ mk(cA,'STARA'); mk(cB,'NOWA') }
  else if(cmpMode==='A') mk(cA,'STARA'); else if(cmpMode==='B') mk(cB,'NOWA');
  else if(cmpMode==='ov'){ mk(composite(cA,cB,w,h,ps),'NAKŁADKA') }
  else { const c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d'); const {b}=mk(c,'STARA'); let f=0;
    const draw=()=>{x.drawImage(f?cB:cA,0,0); b.textContent=f?'NOWA':'STARA'; f^=1}; draw(); blinkT=setInterval(draw,850) }
  my.wraps=wraps; my.sc=sc; my.boxes=[];
  if(e.a==null||e.b==null){ cmsg(`<b>Strona ${e.b==null?e.a+1:e.b+1}${e.key?` (diagram ${esc(e.key)})`:''}</b> — ${e.b==null?'<span class="rm">usunięta w nowej wersji</span> (jest tylko w starej)':'<span class="ad">dodana w nowej wersji</span> (nie ma jej w starej)'}.`); return }
  const res=await diffEntry(e); if(tok!==my.rt) return;
  const rs=res.regions;
  rs.forEach((r,j)=>wraps.forEach((wp,k)=>{const d=document.createElement('div'); d.className='cb'; Object.assign(d.style,{left:r.x0*sc+'px',top:r.y0*sc+'px',width:(r.x1-r.x0)*sc+'px',height:(r.y1-r.y0)*sc+'px'});
    d.innerHTML=`<span>${j+1}</span>`; d.onclick=ev=>{ev.stopPropagation();gotoReg(j)}; wp.appendChild(d); (my.boxes[j]??=[]).push(d)}));
  if(!rs.length){ cmsg(`<b>Strona ${e.b+1}${e.key?` (diagram ${esc(e.key)})`:''}</b> — brak różnic${e.a!==e.b?` (w starej wersji to str. ${e.a+1})`:''}.`); return }
  gotoReg(reg<0?rs.length-1:Math.min(reg,rs.length-1),true);
}
function clip(a,n=40){const s=a.slice(0,n).map(esc).join(' '); return s+(a.length>n?` … (+${a.length-n})`:'')}
async function gotoReg(j,noScroll){
  const my=cmp, e=my.E[my.cur], rs=(await diffEntry(e)).regions, r=rs[j]; if(!r) return; my.reg=j;
  my.boxes.forEach((bs,k)=>bs.forEach(d=>d.classList.toggle('act',k===j)));
  const t=(r.add.length||r.rem.length)?`${r.add.length?`<span class="ad">Dodano:</span> ${clip(r.add)} `:''}${r.rem.length?`<span class="rm">Usunięto:</span> ${clip(r.rem)}`:''}`:'zmiana graficzna (bez zmiany tekstu — np. przesunięty lub dorysowany element)';
  cmsg(`<b>Strona ${e.b+1}${e.a!==e.b?` (było ${e.a+1})`:''}${e.key?` · diagram ${esc(e.key)}`:''} · zmiana ${j+1}/${rs.length}</b> — ${t}`);
  if(noScroll&&false) return;
  const view=$('cview'), wr=my.wraps[0].getBoundingClientRect(), vr=view.getBoundingClientRect(), sc=my.sc;
  const cx=view.scrollLeft+(wr.left-vr.left)+(r.x0+r.x1)/2*sc, cy=view.scrollTop+(wr.top-vr.top)+(r.y0+r.y1)/2*sc;
  view.scrollTo({left:Math.max(0,cx-view.clientWidth/2),top:Math.max(0,cy-view.clientHeight/2)});
}
async function stepChange(d){
  const my=cmp; if(!my||!my.E.length) return; const i=my.cur, r=my.reg+d;
  const rs=i>=0?(await diffEntry(my.E[i])).regions:[];
  if(i>=0&&r>=0&&r<rs.length) return gotoReg(r);
  for(let k=i+d;k>=0&&k<my.E.length;k+=d){
    const e=my.E[k], res=await diffEntry(e);
    if(e.a==null||e.b==null||res.regions.length) return showEntry(k,d>0?0:-1);
  }
  cmsg(d>0?'To ostatnia zmiana w dokumencie.':'To pierwsza zmiana w dokumencie.');
}
const cRe=()=>{if(cmp&&cmp.B&&cmp.cur>=0) showEntry(cmp.cur,cmp.reg)};
$('cmpb').onclick=openCmp; $('cclose').onclick=closeCmp;
$('cfile').onchange=e=>{if(e.target.files[0]) loadB(e.target.files[0]); e.target.value=''};
$('cswap').onclick=()=>{if(cmp&&cmp.B){[cmp.A,cmp.B]=[cmp.B,cmp.A]; startCmp()}};
$('cprev').onclick=()=>stepChange(-1); $('cnext').onclick=()=>stepChange(1);
$('conly').onchange=()=>{if(cmp) cmp.E.forEach(updItem)};
document.querySelectorAll('#cmode button').forEach(b=>b.onclick=()=>{cmpMode=b.dataset.m; document.querySelectorAll('#cmode button').forEach(x=>x.classList.toggle('on',x===b)); cRe()});
const czoom=f=>{cmpFit=null; cmpScale=Math.min(6,Math.max(.2,cmpScale*f)); cRe()};
$('czin').onclick=()=>czoom(1.25); $('czout').onclick=()=>czoom(.8); $('cfw').onclick=()=>{cmpFit='w';cRe()}; $('cfh').onclick=()=>{cmpFit='h';cRe()};
{const cv=$('cview');
 ['dragenter','dragover'].forEach(n=>$('cmp').addEventListener(n,ev=>{ev.preventDefault();$('cempty').classList.add('over')}));
 ['dragleave','drop'].forEach(n=>$('cmp').addEventListener(n,ev=>{ev.preventDefault();$('cempty').classList.remove('over')}));
 $('cmp').addEventListener('drop',ev=>{if(ev.dataTransfer.files[0]&&cmp) loadB(ev.dataTransfer.files[0])});
 let dr=null;
 cv.addEventListener('mousedown',e=>{if(e.button||e.target.closest('.cb')) return; dr={x:e.clientX,y:e.clientY,l:cv.scrollLeft,t:cv.scrollTop}; cv.classList.add('drag')});
 addEventListener('mousemove',e=>{if(!dr) return; cv.scrollLeft=dr.l-(e.clientX-dr.x); cv.scrollTop=dr.t-(e.clientY-dr.y)});
 addEventListener('mouseup',()=>{dr=null; cv.classList.remove('drag')});
 cv.addEventListener('wheel',e=>{if(e.ctrlKey){e.preventDefault(); czoom(e.deltaY<0?1.1:.91)}},{passive:false});
}
addEventListener('keydown',e=>{
  if(!cmpOpen||(e.target.tagName==='INPUT'&&e.target.type!=='checkbox')) return;
  const k=e.key;
  if(k==='Escape') closeCmp();
  else if(k==='n'||k==='N'||k==='ArrowRight'){e.preventDefault(); stepChange(1)}
  else if(k==='p'||k==='P'||k==='ArrowLeft'){e.preventDefault(); stepChange(-1)}
  else if('12345'.includes(k)&&k.length===1){document.querySelectorAll('#cmode button')['12345'.indexOf(k)].click()}
});
addEventListener('resize',()=>{if(cmpOpen&&cmpFit) cRe()});

/* ---------- Notatki (tekst + ołówek), zapisywane poza PDF ---------- */
const ann={tool:'browse',color:'#e60000',w:3,hi:false,show:true,data:{v:1,updated:0,pages:{}},key:null,name:'',fh:null,pendingH:null,undo:[],timer:null,where:'local',size:0,afh:null,adir:null,dirs:[],pendingDirs:[],auto:(()=>{try{return localStorage.getItem('ann:auto')==='1'}catch(e){return false}})()};
ann.dirsReady=idbGet('dirs').then(d=>{if(Array.isArray(d)) ann.dirs=d}).catch(()=>{});
const ANN_COLORS=['#e60000','#0057d8','#0a8a2f','#1c2430','#f5a300'];
const annItems=(p,create)=>{const k=String(p); if(!ann.data.pages[k]){if(!create) return []; ann.data.pages[k]=[]} return ann.data.pages[k]};
const annTotal=()=>Object.values(ann.data.pages).reduce((s,a)=>s+a.length,0);
const annPages=()=>Object.keys(ann.data.pages).filter(k=>ann.data.pages[k].length).map(Number).sort((a,b)=>a-b);
const annBase=()=>ann.name.replace(/\.pdf$/i,'');
const annBlock=e=>!!e.target.closest&&!!e.target.closest('#ann')&&(ann.tool!=='browse'||!!e.target.closest('.note'));
/* IndexedDB: uchwyty plików notatek (pamiętane między sesjami) */
const idbOpen=()=>new Promise((res,rej)=>{const r=indexedDB.open('schematy-notatki',1); r.onupgradeneeded=()=>r.result.createObjectStore('h'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error)});
async function idbGet(k){const d=await idbOpen(); return new Promise((res,rej)=>{const q=d.transaction('h').objectStore('h').get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error)})}
async function idbPut(k,v){const d=await idbOpen(); return new Promise((res,rej)=>{const t=d.transaction('h','readwrite'); t.objectStore('h').put(v,k); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error)})}

function annStat(){
  const n=annItems(cur).length, t=annTotal(), parts=[], af=annBase()+'_notatki_auto.json';
  if(ann.afh) parts.push(`zapis auto w „${esc(ann.afh.name)}”`);
  else if(ann.auto&&ann.adir) parts.push(`zapis auto włączony — plik „${esc(af)}” powstanie przy pierwszej notatce`);
  else if(ann.auto&&ann.pendingDirs.length) parts.push('zapis auto czeka na potwierdzenie dostępu — kliknij „Zapis auto”');
  else if(ann.auto) parts.push('zapis auto: wskaż folder ze schematem (przycisk „Zapis auto”)');
  if(ann.fh) parts.push(`plik „${esc(ann.fh.name)}”`);
  if(ann.pendingH) parts.push(`czekają notatki w pliku „${esc(ann.pendingH.name)}” — kliknij „Wczytaj z pliku…”`);
  if(!parts.length) parts.push('zapisano tylko w tej przeglądarce — użyj „Zapis auto” lub „Zapisz obok schematu…”');
  $('astat').innerHTML=`Notatki: ${n} na tej stronie, ${t} łącznie · ${parts.join(' · ')}`;
  const b=$('aauto'); b.classList.toggle('on',!!(ann.auto&&ann.adir)); b.classList.toggle('pend',!!(ann.auto&&!ann.adir)); b.textContent=ann.auto?(ann.adir?'Zapis auto: wł.':'Zapis auto: potwierdź'):'Zapis auto';
  $('aundo').disabled=!ann.undo.length; $('aprev').disabled=$('anext').disabled=!annPages().length;
}
function annTouch(){ann.data.updated=Date.now(); clearTimeout(ann.timer); ann.timer=setTimeout(annFlush,500); annStat()}
async function annFlush(){
  if(!ann.key) return; const json=JSON.stringify(ann.data);
  try{localStorage.setItem('ann:'+ann.key,json)}catch(e){}
  if(ann.auto&&ann.adir&&!ann.afh&&annTotal()>0){try{ann.afh=await ann.adir.getFileHandle(annBase()+'_notatki_auto.json',{create:true})}catch(e){console.error(e); say('⚠ Nie udało się utworzyć pliku zapisu auto: '+esc(e.message||e),true)}}
  for(const h of [ann.fh,ann.afh]) if(h){try{const w=await h.createWritable(); await w.write(json); await w.close()}catch(e){console.error(e); say('⚠ Nie udało się zapisać pliku notatek: '+esc(e.message||e),true)}}
  annStat();
}
const annPush=()=>{ann.undo.push(JSON.stringify(ann.data.pages)); if(ann.undo.length>80) ann.undo.shift()};
function annUndo(){ if(!ann.undo.length) return; ann.data.pages=JSON.parse(ann.undo.pop()); annTouch(); drawAnn() }

async function annApply(parsed,fh){
  if(!parsed||typeof parsed.pages!=='object') throw new Error('to nie jest plik notatek');
  ann.data={v:1,updated:parsed.updated||0,pages:parsed.pages}; ann.undo=[]; if(fh) ann.fh=fh; ann.pendingH=null; drawAnn(); annStat();
}
async function annReadHandle(h,auto){
  const parsed=JSON.parse(await (await h.getFile()).text());
  if(!ann.data.updated||(parsed.updated||0)>=ann.data.updated){ await annApply(parsed,auto?null:h); if(auto) ann.afh=h }
  else {if(auto) ann.afh=h; else ann.fh=h; ann.pendingH=null; annTouch()}     // lokalna wersja nowsza — nadpisze plik
  annStat();
}
async function annHasPdf(dir){try{return (await (await dir.getFileHandle(ann.name)).getFile()).size===ann.size}catch(e){return false}}
async function annTryDir(dir){
  if(!await annHasPdf(dir)) return false;
  ann.adir=dir; ann.pendingDirs=[];
  try{await annReadHandle(await dir.getFileHandle(annBase()+'_notatki_auto.json'),true)}catch(e){if(e.name!=='NotFoundError') console.warn(e)}
  return true;
}
async function annAutoFind(){
  ann.pendingDirs=[]; ann.adir=null; ann.afh=null;
  for(const dir of ann.dirs){
    let perm='denied'; try{perm=await dir.queryPermission({mode:'readwrite'})}catch(e){}
    if(perm==='granted'){ if(await annTryDir(dir)) return true } else ann.pendingDirs.push(dir);
  }
  return false;
}
async function annAutoClick(){
  if(!ann.key) return;
  if(ann.auto&&ann.adir){ann.auto=false; ann.afh=null; ann.adir=null; try{localStorage.setItem('ann:auto','0')}catch(e){} say('Zapis auto wyłączony. Istniejący plik notatek zostaje w folderze.'); annStat(); return}
  ann.auto=true; try{localStorage.setItem('ann:auto','1')}catch(e){}
  try{
    for(const d of [...ann.pendingDirs]){ if((await d.requestPermission({mode:'readwrite'}))==='granted'&&await annTryDir(d)) break }
    if(!ann.adir){
      if(!window.showDirectoryPicker){ann.auto=false; try{localStorage.setItem('ann:auto','0')}catch(e){} say('⚠ Ta przeglądarka nie pozwala zapisywać plików w folderze — użyj Chrome lub Edge albo „Pobierz kopię”.',true); annStat(); return}
      const dir=await showDirectoryPicker({id:'schematy',mode:'readwrite'});
      if(!await annHasPdf(dir)){ann.auto=false; try{localStorage.setItem('ann:auto','0')}catch(e){} say(`⚠ W wybranym folderze nie ma pliku <b>${esc(ann.name)}</b> (o tym samym rozmiarze). Wskaż folder, w którym leży ten schemat.`,true); annStat(); return}
      let dup=false; for(const d of ann.dirs){try{if(await d.isSameEntry(dir)) dup=true}catch(e){}}
      if(!dup){ann.dirs.push(dir); try{await idbPut('dirs',ann.dirs)}catch(e){console.warn('zapis uchwytu folderu',e)}}
      await annTryDir(dir);
    }
    await annFlush();
    say(ann.afh?`Zapis auto włączony — notatki są w pliku „${esc(ann.afh.name)}” obok schematu i będą wczytywane razem z nim.`:`Zapis auto włączony — plik „${esc(annBase())}_notatki_auto.json” powstanie w folderze ze schematem przy pierwszej notatce i będzie wczytywany razem ze schematem.`);
  }catch(e){ if(e.name!=='AbortError') say('⚠ '+esc(e.message||e),true); if(!ann.adir){ann.auto=false; try{localStorage.setItem('ann:auto','0')}catch(x){}} }
  annStat();
}
async function annOpen(f){
  ann.key=f.name+'|'+f.size; ann.name=f.name; ann.size=f.size; ann.fh=null; ann.pendingH=null; ann.afh=null; ann.adir=null; ann.pendingDirs=[]; ann.undo=[]; ann.data={v:1,updated:0,pages:{}};
  try{const s=localStorage.getItem('ann:'+ann.key); if(s){const p=JSON.parse(s); if(p&&p.pages) ann.data=p}}catch(e){}
  try{
    const h=await idbGet(ann.key);
    if(h){ if((await h.queryPermission({mode:'readwrite'}))==='granted') await annReadHandle(h);
           else {ann.pendingH=h; $('abar').classList.remove('hide'); say(`Do tego schematu są notatki w pliku „${esc(h.name)}”. Kliknij <b>Wczytaj z pliku…</b> w panelu Notatki (przeglądarka prosi o potwierdzenie dostępu).`)} }
  }catch(e){console.warn('notatki: uchwyt',e)}
  await ann.dirsReady;
  if(ann.auto){ try{ await annAutoFind() }catch(e){console.warn(e)}
    if(ann.pendingDirs.length&&!ann.adir){$('abar').classList.remove('hide'); say('Zapis auto: przeglądarka wymaga potwierdzenia dostępu do folderu ze schematami — kliknij <b>Zapis auto: potwierdź</b> w panelu Notatki, aby wczytać notatki.',true)} }
  drawAnn(); annStat();
}
async function annSaveAs(){
  if(!window.showSaveFilePicker) return annDownload();
  try{
    const h=await showSaveFilePicker({suggestedName:annBase()+'.notatki.json',types:[{description:'Notatki do schematu',accept:{'application/json':['.json']}}]});
    ann.fh=h; ann.pendingH=null; try{await idbPut(ann.key,h)}catch(e){} await annFlush();
    say(`Notatki zapisano w pliku „${esc(h.name)}”. Przy następnym otwarciu tego schematu zostaną wczytane (przeglądarka może poprosić o potwierdzenie).`);
  }catch(e){if(e.name!=='AbortError') say('⚠ '+esc(e.message||e),true)}
}
async function annLoad(){
  try{
    if(ann.pendingH){ if((await ann.pendingH.requestPermission({mode:'readwrite'}))==='granted'){await annReadHandle(ann.pendingH); say('Wczytano notatki z pliku.'); return} }
    if(window.showOpenFilePicker){
      const [h]=await showOpenFilePicker({types:[{description:'Notatki do schematu',accept:{'application/json':['.json']}}]});
      await annApply(JSON.parse(await (await h.getFile()).text()),h); try{await idbPut(ann.key,h)}catch(e){} annTouch(); say(`Wczytano notatki z pliku „${esc(h.name)}”.`);
    } else $('aimp').click();
  }catch(e){if(e.name!=='AbortError') say('⚠ Nie udało się wczytać notatek: '+esc(e.message||e),true)}
}
function annDownload(){
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(ann.data,null,1)],{type:'application/json'})); a.download=annBase()+'.notatki.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}

/* --- rysowanie warstwy --- */
const NS='http://www.w3.org/2000/svg', uid=()=>Math.random().toString(36).slice(2,9);
function segDist(px,py,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy; let t=l?((px-a[0])*dx+(py-a[1])*dy)/l:0; t=Math.max(0,Math.min(1,t)); return Math.hypot(px-(a[0]+t*dx),py-(a[1]+t*dy))}
function penEl(it){
  const p=document.createElementNS(NS,'polyline'); p.setAttribute('points',it.pts.map(q=>q[0]+','+q[1]).join(' '));
  p.setAttribute('fill','none'); p.setAttribute('stroke',it.c); p.setAttribute('stroke-width',it.hi?it.w*3.5:it.w); p.setAttribute('stroke-linecap','round'); p.setAttribute('stroke-linejoin','round'); if(it.hi) p.setAttribute('opacity','.35'); return p;
}
function drawAnn(){
  const box=$('pagebox'); if(!box||!pdf) return;
  let L=$('ann'); if(!L){L=document.createElement('div'); L.id='ann'; box.appendChild(L); annWire(L)}
  L.innerHTML=''; L.dataset.tool=ann.tool; L.style.display=(ann.show||ann.tool!=='browse')?'':'none';
  const w=parseFloat(box.style.width)||box.clientWidth, h=parseFloat(box.style.height)||box.clientHeight, items=annItems(cur);
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('viewBox',`0 0 ${w/scale} ${h/scale}`); svg.setAttribute('preserveAspectRatio','none'); L.appendChild(svg);
  for(const it of items) if(it.t==='pen') svg.appendChild(penEl(it));
  for(const it of items) if(it.t==='text') L.appendChild(noteEl(it));
  annStat();
}
function noteEl(it){
  const d=document.createElement('div'); d.className='note'; d.style.borderLeftColor=it.c; d.style.left=it.x*scale+'px'; d.style.top=it.y*scale+'px'; d.style.width=it.w*scale+'px'; d.style.fontSize=Math.max(9,11*scale)+'px';
  d.innerHTML='<div class="nh"><span>⠿ notatka</span><button title="Usuń notatkę">×</button></div><div class="nt" contenteditable="plaintext-only"></div>';
  const nt=d.querySelector('.nt'); nt.textContent=it.text||'';
  let pushed=false;
  nt.addEventListener('focus',()=>{pushed=false});
  nt.addEventListener('input',()=>{if(!pushed){pushed=true; const old=it.text; it.text=''; annPush(); it.text=old} it.text=nt.innerText.replace(/\n$/,''); annTouch()});
  nt.addEventListener('blur',()=>{
    it.w=Math.round(d.offsetWidth/scale*10)/10;
    if(!it.text.trim()){const a=annItems(cur); const i=a.indexOf(it); if(i>=0){a.splice(i,1); annTouch(); drawAnn()}} else annTouch();
  });
  d.querySelector('button').onclick=()=>{annPush(); const a=annItems(cur); a.splice(a.indexOf(it),1); annTouch(); drawAnn()};
  const nh=d.querySelector('.nh'); let g=null;
  nh.addEventListener('pointerdown',ev=>{if(ev.target.tagName==='BUTTON') return; nh.setPointerCapture(ev.pointerId); g={x:ev.clientX,y:ev.clientY,l:it.x,t:it.y,m:false}; ev.stopPropagation()});
  nh.addEventListener('pointermove',ev=>{if(!g) return; if(!g.m){g.m=true; annPush()} it.x=g.l+(ev.clientX-g.x)/scale; it.y=g.t+(ev.clientY-g.y)/scale; d.style.left=it.x*scale+'px'; d.style.top=it.y*scale+'px'});
  nh.addEventListener('pointerup',()=>{if(g&&g.m) annTouch(); g=null});
  d.addEventListener('mousedown',ev=>ev.stopPropagation());
  return d;
}
function annWire(L){
  let stroke=null, prev=null, erasing=false, erasePushed=false;
  const pt=ev=>{const r=L.getBoundingClientRect(); return [(ev.clientX-r.left)/scale,(ev.clientY-r.top)/scale]};
  const eraseAt=ev=>{
    const [x,y]=pt(ev), rad=8/scale, items=annItems(cur); let hit=false;
    for(let i=items.length-1;i>=0;i--){const it=items[i]; if(it.t!=='pen') continue; const r=rad+(it.hi?it.w*1.75:it.w/2);
      let near=it.pts.length===1?Math.hypot(x-it.pts[0][0],y-it.pts[0][1])<=r:false;
      for(let k=1;!near&&k<it.pts.length;k++) near=segDist(x,y,it.pts[k-1],it.pts[k])<=r;
      if(near){if(!erasePushed){annPush(); erasePushed=true} items.splice(i,1); hit=true}}
    if(hit){annTouch(); drawAnn()}
  };
  L.addEventListener('pointerdown',ev=>{
    if(ev.button||ev.target.closest('.note')) return;
    if(ann.tool==='pen'){L.setPointerCapture(ev.pointerId); stroke={t:'pen',id:uid(),c:ann.color,w:ann.w,hi:ann.hi,pts:[pt(ev)]}; prev=penEl(stroke); L.querySelector('svg').appendChild(prev); ev.preventDefault()}
    else if(ann.tool==='erase'){L.setPointerCapture(ev.pointerId); erasing=true; erasePushed=false; eraseAt(ev); ev.preventDefault()}
    else if(ann.tool==='text'){
      const [x,y]=pt(ev); annPush(); const it={t:'text',id:uid(),x:Math.round(x*10)/10,y:Math.round(y*10)/10,w:170,text:'',c:ann.color}; annItems(cur,true).push(it);
      setTool('browse'); drawAnn(); const nts=L.querySelectorAll('.note .nt'); const last=nts[nts.length-1]; if(last) last.focus(); ev.preventDefault();
    }
  });
  L.addEventListener('pointermove',ev=>{
    if(stroke){const p=pt(ev), l=stroke.pts[stroke.pts.length-1]; if(Math.hypot(p[0]-l[0],p[1]-l[1])>.7){stroke.pts.push(p); prev.setAttribute('points',stroke.pts.map(q=>q[0].toFixed(1)+','+q[1].toFixed(1)).join(' '))}}
    else if(erasing) eraseAt(ev);
  });
  const end=()=>{
    if(stroke){stroke.pts=stroke.pts.map(q=>[Math.round(q[0]*10)/10,Math.round(q[1]*10)/10]); if(stroke.pts.length===1) stroke.pts.push([stroke.pts[0][0]+.1,stroke.pts[0][1]]);
      annPush(); annItems(cur,true).push(stroke); stroke=null; prev=null; annTouch(); drawAnn()}
    erasing=false;
  };
  L.addEventListener('pointerup',end); L.addEventListener('pointercancel',end);
}
function setTool(t){
  ann.tool=t; document.querySelectorAll('#atools button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  if(t!=='browse'){ann.show=true; $('ashow').checked=true}
  drawAnn();
}
/* --- sterowanie --- */
{
  const C=$('acols'); ANN_COLORS.forEach((c,i)=>{const b=document.createElement('button'); b.className='ac'+(i?'':' on'); b.style.background=c; b.dataset.c=c; b.title='Kolor'; b.onclick=()=>{ann.color=c; C.querySelectorAll('.ac').forEach(x=>x.classList.toggle('on',x===b))}; C.appendChild(b)});
  document.querySelectorAll('#atools button').forEach(b=>b.onclick=()=>setTool(b.dataset.t));
  $('awid').onchange=e=>ann.w=+e.target.value; $('ahi').onchange=e=>ann.hi=e.target.checked;
  $('aundo').onclick=annUndo; $('ashow').onchange=e=>{ann.show=e.target.checked; drawAnn()};
  $('aauto').onclick=annAutoClick; $('asave').onclick=annSaveAs; $('aload').onclick=annLoad; $('adl').onclick=annDownload;
  $('aimp').onchange=async e=>{const f=e.target.files[0]; e.target.value=''; if(!f) return; try{await annApply(JSON.parse(await f.text()),null); annTouch(); say('Wczytano notatki z pliku.')}catch(err){say('⚠ Nie udało się wczytać notatek: '+esc(err.message),true)}};
  $('aclr').onclick=()=>{if(!annTotal()) return; if(!confirm('Usunąć wszystkie notatki do tego schematu? (można cofnąć przyciskiem „Cofnij”)')) return; annPush(); ann.data.pages={}; annTouch(); drawAnn()};
  const jump=d=>{const ps=annPages(); const n=d>0?ps.find(p=>p>cur):[...ps].reverse().find(p=>p<cur); if(n) goPage(n,{noHistory:true})};
  $('aprev').onclick=()=>jump(-1); $('anext').onclick=()=>jump(1);
  $('annb').onclick=()=>{const a=$('abar'); a.classList.toggle('hide'); if(a.classList.contains('hide')) setTool('browse'); if(pdf) renderPage()};
  addEventListener('keydown',e=>{if(e.ctrlKey&&!e.shiftKey&&e.key.toLowerCase()==='z'&&!$('abar').classList.contains('hide')&&!e.target.isContentEditable&&e.target.tagName!=='INPUT'){e.preventDefault(); annUndo()}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden) annFlush()});
}

/* ---------- Przesuwanie palcem (swipe) między stronami ---------- */
function swipeOn(el,onLeft,onRight,enabled){
  let st=null;
  el.addEventListener('touchstart',e=>{
    if(e.touches.length!==1||(enabled&&!enabled(e))){st=null;return}
    const t=e.touches[0]; st={x:t.clientX,y:t.clientY,t:Date.now(),l:el.scrollLeft,max:el.scrollWidth-el.clientWidth};
  },{passive:true});
  el.addEventListener('touchmove',e=>{if(st&&e.touches.length>1) st=null},{passive:true});
  el.addEventListener('touchend',e=>{
    if(!st) return; const t=e.changedTouches[0], dx=t.clientX-st.x, dy=t.clientY-st.y, s0=st; st=null;
    if(Date.now()-s0.t>800||Math.abs(dx)<60||Math.abs(dx)<1.6*Math.abs(dy)) return;
    // przy powiększonym widoku przesuwanie zwykle przewija poziomo — zmieniamy stronę tylko na krawędzi
    if(s0.max>2&&Math.abs(el.scrollLeft-s0.l)>2) return;
    if(dx<0){ if(s0.max>2&&s0.l<s0.max-2) return; onLeft() } else { if(s0.max>2&&s0.l>2) return; onRight() }
  },{passive:true});
}
swipeOn($('view'),()=>{if(pdf&&cur<N) goPage(cur+1,{noHistory:true,scroll:'top'})},()=>{if(pdf&&cur>1) goPage(cur-1,{noHistory:true,scroll:'top'})},
        e=>pdf&&!(typeof ann!=='undefined'&&ann.tool!=='browse')&&!e.target.closest('.note'));
swipeOn($('cview'),()=>{if(cmp&&cmp.B) stepChange(1)},()=>{if(cmp&&cmp.B) stepChange(-1)});

/* ---------- Otwieranie PDF z adresu przekazanego przez rozszerzenie (?file=URL) ---------- */
(async()=>{
  const m=location.search.match(/^\?file=(.+)$/); if(!m) return;
  let url=m[1]; try{ if(/^https?%3A|^file%3A/i.test(url)) url=decodeURIComponent(url) }catch(e){}
  const name=decodeURIComponent((url.split('#')[0].split('?')[0].split('/').pop())||'schemat.pdf');
  try{
    say('Pobieranie '+esc(name)+'…');
    const r=await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status);
    const buf=await r.arrayBuffer();
    await openFile(new File([buf],name,{type:'application/pdf'}));
    document.title=name+' – Przeglądarka schematów';
  }catch(e){
    console.error(e);
    const f=/^file:/i.test(url);
    say('⚠ Nie udało się otworzyć pliku: '+esc(e.message||e)+(f?'. Dla plików z dysku włącz w ustawieniach rozszerzenia (chrome://extensions → Szczegóły) opcję „Zezwalaj na dostęp do adresów URL plików”.':''),true);
  }
})();
