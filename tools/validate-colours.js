/* tools/validate-colours.js (final: Slate Crisp palette on the redesign token contract, oklch projectColor) - computes (never estimates) WCAG 2.x contrast for every
   Slate colour pair that matters, in both themes and for every accent, plus
   OKLab separation for the chart series and a full 360-hue sweep of
   projectColor(). Exit code 1 if anything fails.
   Run: node tools/validate-colours.js     (add --before to also audit the old palette)
   It reads the live tokens out of index.html, so it checks what actually ships. */
"use strict";

/* ---------------- the palette under test ---------------- */
var THEMES = {
  light: {
    paper:"#F4F5F7", panel:"#FFFFFF", panel2:"#EFF1F4", raised:"#FFFFFF", sunken:"#EFF1F4",
    note:"#FBF7EC", noteEdge:"#D6C79B",
    ink:"#1B1E24", ink2:"#3F4552", muted:"#5C6371", faint:"#838A97",
    line:"#C6CCD5", lineSoft:"#E3E6EB", lineStrong:"#868D9A",
    danger:"#C42B2B", dangerSoft:"#FDECEC", onDanger:"#FFFFFF",
    good:"#177A41", goodSoft:"#E4F4EA",
    warn:"#965A00", warnSoft:"#FDF0DB",
    mark:"#FFE58A", codeBg:"#F1F3F6", quoteBar:"#868D9A",
    vizTodo:"#86B6EF", vizDoing:"#2A78D6", vizDone:"#104281"
  },
  dark: {
    paper:"#1A1C20", panel:"#202329", panel2:"#2B2F37", raised:"#272B32", sunken:"#1C1E23",
    note:"#2A2822", noteEdge:"#4A4536",
    ink:"#E8EAEE", ink2:"#C5CAD3", muted:"#9CA3AF", faint:"#767D8A",
    line:"#444A55", lineSoft:"#2E3239", lineStrong:"#737A87",
    danger:"#F2857A", dangerSoft:"#3B2426", onDanger:"#1A1C20",
    good:"#52C48C", goodSoft:"#1B3328",
    warn:"#E3A342", warnSoft:"#3A2E1A",
    mark:"#574710", codeBg:"#1C1E23", quoteBar:"#737A87",
    vizTodo:"#184F95", vizDoing:"#3987E5", vizDone:"#9EC5F4"
  }
};

/* first entry is the default; it must not be green */
var ACCENTS = [
  { id:"cobalt", label:"Cobalt",
    light:{ accent:"#2F5FD9", accentInk:"#2449B8", accentSoft:"#E8EEFD", onAccent:"#FFFFFF" },
    dark: { accent:"#3E68E0", accentInk:"#A3B8FF", accentSoft:"#263355", onAccent:"#FFFFFF" } },
  { id:"violet", label:"Violet",
    light:{ accent:"#6A45D6", accentInk:"#5733C0", accentSoft:"#EFEAFD", onAccent:"#FFFFFF" },
    dark: { accent:"#7856E6", accentInk:"#C3B3FF", accentSoft:"#2F2852", onAccent:"#FFFFFF" } },
  { id:"teal", label:"Teal",
    light:{ accent:"#0E7780", accentInk:"#0B636B", accentSoft:"#DFF2F3", onAccent:"#FFFFFF" },
    dark: { accent:"#0E7C86", accentInk:"#6FD2DA", accentSoft:"#17363A", onAccent:"#FFFFFF" } },
  { id:"ember", label:"Ember",
    light:{ accent:"#C2410C", accentInk:"#A8380A", accentSoft:"#FDEDE4", onAccent:"#FFFFFF" },
    dark: { accent:"#C2440F", accentInk:"#FFAE85", accentSoft:"#3D281E", onAccent:"#FFFFFF" } },
  { id:"rose", label:"Rose",
    light:{ accent:"#C0265E", accentInk:"#A61F50", accentSoft:"#FCE7EF", onAccent:"#FFFFFF" },
    dark: { accent:"#CC3068", accentInk:"#FFA3C3", accentSoft:"#3F2231", onAccent:"#FFFFFF" } },
  { id:"forest", label:"Forest",
    light:{ accent:"#1B7A45", accentInk:"#16673A", accentSoft:"#E3F3E9", onAccent:"#FFFFFF" },
    dark: { accent:"#1C7D47", accentInk:"#7ED6A3", accentSoft:"#1B3427", onAccent:"#FFFFFF" } },
  { id:"graphite", label:"Graphite",
    light:{ accent:"#3D4350", accentInk:"#2F3440", accentSoft:"#ECEEF2", onAccent:"#FFFFFF" },
    dark: { accent:"#687080", accentInk:"#D3D8E0", accentSoft:"#31353D", onAccent:"#FFFFFF" } }
];

/* slot order: blue, orange, magenta, green, sky, gold, violet, teal - the same hue family per slot in
   both themes. Red is left out on purpose: it means late/danger in Slate. */
var CHART = {
  light: ["#2E62C9","#A74A04","#AE4090","#40A138","#067396","#AC7809","#7F62D5","#129E8E"],
  dark:  ["#3F75DD","#C05708","#B84999","#4CAD43","#059BC9","#B88213","#987CF2","#0F9485"]
};

/* Read the live tokens out of index.html, so this checks what actually ships —
   the tables above are only the fallback when run outside the repo. Also fails if
   the account menu's JS swatch list has drifted from the CSS accent blocks. */
var DRIFT = [];
(function loadFromApp(){
  var fs = require("fs"), path = require("path");
  var file = path.join(__dirname, "..", "index.html");
  if(!fs.existsSync(file)) return;
  var html = fs.readFileSync(file, "utf8");
  function block(re){ var m = html.match(re); return m ? m[1] : ""; }
  function vars(css){
    var o = {};
    css.replace(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\b/g, function(_, k, v){ o[k] = v.toUpperCase(); });
    return o;
  }
  var rootCss = block(/\n:root\{([\s\S]*?)\n\}/);
  var light = vars(rootCss), dark = vars(block(/\n:root\[data-theme="dark"\]\{([\s\S]*?)\n\}/));
  var MAP = { "panel-2":"panel2", "ink-2":"ink2", "viz-1":"vizDoing" };
  function camel(k){ return k.replace(/-([a-z0-9])/g, function(_, c){ return c.toUpperCase(); }); }
  [["light", light], ["dark", dark]].forEach(function(p){
    Object.keys(p[1]).forEach(function(k){
      var key = MAP[k] || camel(k);
      if(key in THEMES[p[0]]) THEMES[p[0]][key] = p[1][k];
    });
    var ch = [];
    for(var i = 1; i <= 8; i++) if(p[1]["chart-" + i]) ch.push(p[1]["chart-" + i]);
    if(ch.length === 8) CHART[p[0]] = ch;
  });
  function accFrom(css){
    var v = vars(css);
    return { light:{ accent:v["acc-l"], accentInk:v["acc-ink-l"], accentSoft:v["acc-soft-l"], onAccent:v["on-acc-l"] },
             dark: { accent:v["acc-d"], accentInk:v["acc-ink-d"], accentSoft:v["acc-soft-d"], onAccent:v["on-acc-d"] } };
  }
  var js = (html.match(/var ACCENTS = \[([\s\S]*?)\];/) || ["", ""])[1];
  var rows = js.match(/\{[^}]*\}/g) || [];
  var list = rows.map(function(r, idx){
    var id = (r.match(/id:"([^"]+)"/) || [])[1], label = (r.match(/label:"([^"]+)"/) || [])[1];
    var a = idx === 0 ? accFrom(rootCss) : accFrom(block(new RegExp(':root\\[data-accent="' + id + '"\\]\\{([\\s\\S]*?)\\n\\}')));
    a.id = id; a.label = label;
    var jl = ((r.match(/light:"(#[0-9A-Fa-f]{6})"/) || [])[1] || "").toUpperCase();
    var jd = ((r.match(/dark:"(#[0-9A-Fa-f]{6})"/) || [])[1] || "").toUpperCase();
    if(jl !== a.light.accent || jd !== a.dark.accent) DRIFT.push(id + ": JS swatch " + jl + "/" + jd + " vs CSS " + a.light.accent + "/" + a.dark.accent);
    return a;
  });
  if(list.length) ACCENTS = list;
})();

/* projectColor(): each role is a target relative luminance Y at a fixed HSL
   saturation. Lightness is solved per hue so every hue lands on the same Y. */
var PROJECT = {
  light:{ base:{s:.58, y:.19}, ink:{s:.55, y:.085}, soft:{s:.62, y:.83} },
  dark: { base:{s:.55, y:.25}, ink:{s:.48, y:.43},  soft:{s:.34, y:.034} }
};

/* the palette being replaced, for the before/after column */
var BEFORE = {
  light:{ paper:"#F4F2ED", panel:"#FFFFFF", note:"#EFE9DB", ink:"#1B1A17", muted:"#7C776C",
          line:"#DEDAD1", lineSoft:"#E9E5DD", accent:"#2C5849", accentInk:"#2C5849",
          accentSoft:"#E1EAE5", onAccent:"#FFFFFF", danger:"#8C3A2B" },
  dark: { paper:"#141619", panel:"#1C1F23", note:"#241F17", ink:"#E8E6E0", muted:"#94918A",
          line:"#2D3137", lineSoft:"#24272C", accent:"#84B9A4", accentInk:"#9CCBB7",
          accentSoft:"#22322C", onAccent:"#1C1F23", danger:"#D08878" }
};

/* ---------------- colour maths ---------------- */
function rgb(h){ h = h.replace("#",""); return [0,2,4].map(function(i){ return parseInt(h.slice(i,i+2),16)/255; }); }
function lin(c){ return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
function lumRgb(c){ return 0.2126*lin(c[0]) + 0.7152*lin(c[1]) + 0.0722*lin(c[2]); }
function lum(h){ return lumRgb(rgb(h)); }
function ratioY(a, b){ var hi = Math.max(a,b), lo = Math.min(a,b); return (hi+0.05)/(lo+0.05); }
function contrast(a, b){ return ratioY(lum(a), lum(b)); }
function toHex(c){ return "#" + c.map(function(v){ var s = Math.round(Math.max(0,Math.min(1,v))*255).toString(16); return s.length<2?"0"+s:s; }).join("").toUpperCase(); }

/* HSL -> sRGB, exactly as the browser computes hsl() */
function hsl(h, s, l){
  function f(n){ var k = (n + h/30) % 12, a = s*Math.min(l,1-l); return l - a*Math.max(-1, Math.min(k-3, 9-k, 1)); }
  return [f(0), f(8), f(4)];
}
/* the function proposed for index.html: lightness solved for a target luminance */
function hslAtLum(h, s, y){
  var lo = 0, hi = 1;
  for(var i=0;i<22;i++){ var mid = (lo+hi)/2; if(lumRgb(hsl(h,s,mid)) < y) lo = mid; else hi = mid; }
  return hsl(h, s, (lo+hi)/2);
}

/* OKLab + Machado 2009 CVD simulation, severity 1.0 (same model as the dataviz validator) */
var MACHADO = {
  protan:[[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
  deutan:[[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]]
};
function linv(h){ return rgb(h).map(lin); }
function oklab(v){
  var l = Math.cbrt(0.4122214708*v[0]+0.5363325363*v[1]+0.0514459929*v[2]);
  var m = Math.cbrt(0.2119034982*v[0]+0.6806995451*v[1]+0.1073969566*v[2]);
  var s = Math.cbrt(0.0883024619*v[0]+0.2817188376*v[1]+0.6299787005*v[2]);
  return [0.2104542553*l+0.7936177850*m-0.0040720468*s,
          1.9779984951*l-2.4285922050*m+0.4505937099*s,
          0.0259040371*l+0.7827717662*m-0.8086757660*s];
}
function sim(h, k){ var v = linv(h), M = MACHADO[k];
  return M.map(function(r){ return Math.max(0,Math.min(1, r[0]*v[0]+r[1]*v[1]+r[2]*v[2])); }); }
function dE(a, b, k){ var A = oklab(k ? sim(a,k) : linv(a)), B = oklab(k ? sim(b,k) : linv(b));
  return 100*Math.hypot(A[0]-B[0], A[1]-B[1], A[2]-B[2]); }
function okL(h){ return oklab(linv(h))[0]; }
function okC(h){ var o = oklab(linv(h)); return Math.hypot(o[1], o[2]); }
var BAND = { light:[0.43,0.77], dark:[0.48,0.67] };   /* dataviz-skill OKLCH L bands */

/* ---------------- reporting ---------------- */
var fails = 0, rows = [];
function check(theme, what, fg, bg, min, ratio){
  var r = ratio != null ? ratio : contrast(fg, bg);
  var ok = r >= min - 1e-9;
  if(!ok) fails++;
  rows.push(pad(theme,6) + pad(what,44) + pad(r.toFixed(2)+":1",9) + pad(">= "+min,8) + (ok ? "pass" : "FAIL"));
}
function pad(s,n){ s = String(s); while(s.length<n) s += " "; return s; }
function head(t){ rows.push(""); rows.push("== " + t); }

/* ---------------- 1. core tokens ---------------- */
["light","dark"].forEach(function(m){
  var T = THEMES[m];
  head("CORE TOKENS - " + m);
  check(m,"ink on paper",            T.ink,T.paper,7);
  check(m,"ink on panel",            T.ink,T.panel,7);
  check(m,"ink on raised (cards)",   T.ink,T.raised,7);
  check(m,"ink on sunken (columns)", T.ink,T.sunken,7);
  check(m,"ink on panel-2 (hover, table head)",            T.ink,T.panel2,7);
  check(m,"ink on note",             T.ink,T.note,7);
  check(m,"ink on mark (highlight)", T.ink,T.mark,7);
  check(m,"ink on codeBg",           T.ink,T.codeBg,7);
  check(m,"paper on ink (toast)",    T.paper,T.ink,7);
  check(m,"ink2 on panel",           T.ink2,T.panel,7);
  check(m,"ink2 on raised",          T.ink2,T.raised,7);
  check(m,"muted on paper",          T.muted,T.paper,4.5);
  check(m,"muted on panel",          T.muted,T.panel,4.5);
  check(m,"muted on raised",         T.muted,T.raised,4.5);
  check(m,"muted on sunken",         T.muted,T.sunken,4.5);
  check(m,"muted on note",           T.muted,T.note,4.5);
  check(m,"muted on lineSoft (chip)",T.muted,T.lineSoft,4.5);
  check(m,"muted on panel-2",          T.muted,T.panel2,4.5);
  check(m,"faint on panel (placeholder)",T.faint,T.panel,3);
  check(m,"faint on paper",          T.faint,T.paper,3);
  check(m,"danger on panel",         T.danger,T.panel,4.5);
  check(m,"danger on paper",         T.danger,T.paper,4.5);
  check(m,"danger on raised",        T.danger,T.raised,4.5);
  check(m,"danger on dangerSoft",    T.danger,T.dangerSoft,4.5);
  check(m,"onDanger on danger (button)",T.onDanger,T.danger,4.5);
  check(m,"good on panel",        T.good,T.panel,4.5);
  check(m,"good on goodSoft",  T.good,T.goodSoft,4.5);
  check(m,"warn on panel",        T.warn,T.panel,4.5);
  check(m,"warn on warnSoft",  T.warn,T.warnSoft,4.5);
  check(m,"line vs panel",           T.line,T.panel,1.5);
  check(m,"line vs raised (card edge)",T.line,T.raised,1.5);
  check(m,"line vs sunken (well, like paper)",T.line,T.sunken,1.35);
  check(m,"line vs paper",           T.line,T.paper,1.35);
  check(m,"noteEdge vs note",        T.noteEdge,T.note,1.5);
  check(m,"lineSoft vs panel (divider)",T.lineSoft,T.panel,1.15);
  check(m,"lineStrong vs panel (control ring)",T.lineStrong,T.panel,3);
  check(m,"lineStrong vs raised",    T.lineStrong,T.raised,3);
  check(m,"panel vs paper (surface step)",T.panel,T.paper,1.05);
  check(m,"raised vs sunken (card on column)",T.raised,T.sunken,1.08);
  check(m,"good fill vs line-soft track",       T.good,T.lineSoft,3);
  check(m,"warn fill vs line-soft track",       T.warn,T.lineSoft,3);
  check(m,"danger fill vs line-soft track",     T.danger,T.lineSoft,3);
  check(m,"viz-doing vs panel",                 T.vizDoing,T.panel,3);
  check(m,"viz-doing vs raised",                T.vizDoing,T.raised,3);
  check(m,"viz-doing vs line-soft track",       T.vizDoing,T.lineSoft,3);
  check(m,"viz-done vs panel",                  T.vizDone,T.panel,3);
  check(m,"viz-done vs raised",                 T.vizDone,T.raised,3);
  check(m,"viz-todo vs viz-done (ends of ramp)",T.vizTodo,T.vizDone,3);
  check(m,"ink on viz-todo (label inside)",     T.ink,T.vizTodo,4.5);
  check(m,"quote-bar vs panel",                 T.quoteBar,T.panel,3);
  check(m,"panel-2 vs panel (surface step)",    T.panel2,T.panel,1.08);
});

/* ---------------- 2. accents ---------------- */
ACCENTS.forEach(function(a, i){
  ["light","dark"].forEach(function(m){
    var T = THEMES[m], A = a[m];
    head("ACCENT " + (i+1) + " " + a.label + (i===0?" (default)":"") + " - " + m);
    check(m,"accentInk on panel",      A.accentInk,T.panel,4.5);
    check(m,"accentInk on accentSoft", A.accentInk,A.accentSoft,4.5);
    check(m,"onAccent on accent",      A.onAccent,A.accent,4.5);
    check(m,"accentInk on paper",      A.accentInk,T.paper,4.5);
    check(m,"accentInk on raised",     A.accentInk,T.raised,4.5);
    check(m,"ink on accentSoft (selected row)",T.ink,A.accentSoft,7);
    check(m,"accent vs panel (fill/focus ring)",A.accent,T.panel,3);
    check(m,"accent vs paper",         A.accent,T.paper,3);
    check(m,"muted on accentSoft (.rail-item.on .ct)",T.muted,A.accentSoft,4.5);
    check(m,"focus ring accentInk vs raised",  A.accentInk,T.raised,3);
    check(m,"focus ring accentInk vs sunken",  A.accentInk,T.sunken,3);
    check(m,"focus ring accentInk vs note",    A.accentInk,T.note,3);
    check(m,"focus ring accentInk vs panel-2",   A.accentInk,T.panel2,3);
  });
});
var dflt = rgb(ACCENTS[0].light.accent);
var green = dflt[1] > dflt[0] && dflt[1] > dflt[2];
rows.push(""); rows.push("default accent is " + ACCENTS[0].label + " " + ACCENTS[0].light.accent + (green ? "  FAIL: green" : "  (not green) pass"));
if(green) fails++;

/* ---------------- 3. chart series ---------------- */
["light","dark"].forEach(function(m){
  var P = CHART[m], T = THEMES[m];
  head("CHART SERIES - " + m + " (on panel " + T.panel + ")");
  P.forEach(function(c,i){ check(m,"chart-"+(i+1)+" "+c+" vs panel (OKLCH L "+okL(c).toFixed(2)+")",c,T.panel,3); });
  P.forEach(function(c,i){ check(m,"chart-"+(i+1)+" "+c+" vs raised",c,T.raised,3); });
  P.forEach(function(c,i){ var L = okL(c), inb = L >= BAND[m][0] && L <= BAND[m][1];
    check(m,"chart-"+(i+1)+" OKLCH L "+L.toFixed(3)+" in band "+BAND[m].join("-"),null,null,1,inb?1:0);
    check(m,"chart-"+(i+1)+" OKLCH chroma x100 (floor 10)",null,null,10,okC(c)*100); });
  var adjN = 99, adjC = 99, allN = 99, allC = 99, wN = "", wC = "", wAN = "", wAC = "";
  for(var i=0;i<P.length;i++) for(var j=i+1;j<P.length;j++){
    var n = dE(P[i],P[j]), c = Math.min(dE(P[i],P[j],"protan"), dE(P[i],P[j],"deutan"));
    if(j===i+1){ if(n<adjN){adjN=n;wN=(i+1)+"-"+(j+1);} if(c<adjC){adjC=c;wC=(i+1)+"-"+(j+1);} }
    if(n<allN){allN=n;wAN=(i+1)+"-"+(j+1);} if(c<allC){allC=c;wAC=(i+1)+"-"+(j+1);}
  }
  check(m,"adjacent normal-vision dE (worst "+wN+")",null,null,15,adjN);
  check(m,"adjacent CVD dE protan/deutan (worst "+wC+")",null,null,8,adjC);
  check(m,"all-pairs normal-vision dE (worst "+wAN+")",null,null,10,allN);
  var pn = 99, pc = 99; for(var a=0;a<4;a++) for(var b=a+1;b<4;b++){ pn = Math.min(pn, dE(P[a],P[b])); pc = Math.min(pc, dE(P[a],P[b],"protan"), dE(P[a],P[b],"deutan")); }
  check(m,"slots 1-4 all-pairs normal-vision dE",null,null,15,pn);
  check(m,"slots 1-4 all-pairs CVD dE",null,null,8,pc);
  rows.push(m+"  info: all 8 slots all-pairs CVD dE worst "+wAC+" = "+allC.toFixed(1)+" - scatter/legend-only charts cap at 4 series, else direct labels");
});

/* ---------------- 4. projectColor() across every hue (oklch, as shipped) ----------------
   These four functions are copied verbatim into index.html. Lightness comes from
   the --ph-l / --ph-ink-l / --ph-soft-l tokens; PH_L must equal them. */
var PH_L   = { dot:[0.56, 0.68], ink:[0.44, 0.82], soft:[0.945, 0.31] };   /* [light, dark] */
var PH_CAP = { dot:0.15, ink:0.13, soft:0.045 };
var phChroma = {};
function phInSrgb(L, C, h){
  var a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  var l = L + 0.3963377774 * a + 0.2158037573 * b,
      m = L - 0.1055613458 * a - 0.0638541728 * b,
      s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  var R =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return R >= 0 && R <= 1 && G >= 0 && G <= 1 && B >= 0 && B <= 1;
}
function projectChroma(kind, h){
  var key = kind + h;
  if(phChroma[key] != null) return phChroma[key];
  var L = PH_L[kind], lo = 0, hi = 0.4, i, mid;
  for(i = 0; i < 20; i++){ mid = (lo + hi) / 2; if(phInSrgb(L[0], mid, h) && phInSrgb(L[1], mid, h)) lo = mid; else hi = mid; }
  return (phChroma[key] = Math.round(Math.min(PH_CAP[kind], lo * 0.92) * 1000) / 1000);
}
/* what the browser paints for oklch(L C h): linear sRGB -> 8-bit -> Y */
function okPaint(L, C, h){
  var a=C*Math.cos(h*Math.PI/180), b=C*Math.sin(h*Math.PI/180);
  var l=L+0.3963377774*a+0.2158037573*b, m=L-0.1055613458*a-0.0638541728*b, s=L-0.0894841775*a-1.2914855480*b;
  l=l*l*l; m=m*m*m; s=s*s*s;
  var v=[4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s];
  var inG = v.every(function(x){ return x>=-1e-6 && x<=1+1e-6; });
  var q = v.map(function(x){ var c=Math.max(0,Math.min(1,x)); return Math.round((c<=0.0031308?12.92*c:1.055*Math.pow(c,1/2.4)-0.055)*255)/255; });
  return { inG:inG, rgb:q, Y:lumRgb(q), hex:toHex(q) };
}
var PMIN = { "ink on soft (chip)":5, "ink on paper":5, "ink on panel":5, "ink on raised":5, "ink on sunken":5, "ink on panel2":5,
             "dot vs paper":3, "dot vs panel":3, "dot vs raised":3, "dot vs panel2":3, "dot vs accentSoft (selected rail row, all accents)":3,
             "soft vs panel (tint visible)":1.08 };
["light","dark"].forEach(function(m, ti){
  var T = THEMES[m], w = {}, gam = 0, Yd = [], Yi = [];
  function keep(k,x,h){ if(!(k in w) || x < w[k][0]) w[k] = [x,h]; }
  for(var t=0; t<3600; t++){
    var h = t/10;
    var d = okPaint(PH_L.dot[ti], projectChroma("dot",h), h), ink = okPaint(PH_L.ink[ti], projectChroma("ink",h), h), soft = okPaint(PH_L.soft[ti], projectChroma("soft",h), h);
    if(!d.inG || !ink.inG || !soft.inG) gam++;
    Yd.push(d.Y); Yi.push(ink.Y);
    keep("ink on soft (chip)", ratioY(ink.Y,soft.Y), h);
    ["paper","panel","raised","sunken","panel2"].forEach(function(k){ keep("ink on "+k, ratioY(ink.Y,lum(T[k])), h); });
    ["paper","panel","raised","panel2"].forEach(function(k){ keep("dot vs "+k, ratioY(d.Y,lum(T[k])), h); });
    ACCENTS.forEach(function(a){ keep("dot vs accentSoft (selected rail row, all accents)", ratioY(d.Y,lum(a[m].accentSoft)), h); });
    keep("soft vs panel (tint visible)", ratioY(soft.Y,lum(T.panel)), h);
  }
  head("projectColor() oklch - " + m + " - every hue 0.0..359.9 (L dot "+PH_L.dot[ti]+", ink "+PH_L.ink[ti]+", soft "+PH_L.soft[ti]+")");
  check(m,"colours outside sRGB (must be 0)",null,null,0,-gam);
  var sp = function(a){ return (Math.max.apply(null,a)+.05)/(Math.min.apply(null,a)+.05); };
  check(m,"dot luminance spread across hues (<= 1.25x)",null,null,-1.25,-sp(Yd));
  check(m,"ink luminance spread across hues (<= 1.25x)",null,null,-1.25,-sp(Yi));
  Object.keys(PMIN).forEach(function(k){ check(m, k + " (worst hue " + w[k][1].toFixed(1) + ")", null, null, PMIN[k], w[k][0]); });
  rows.push("   samples (golden-angle index: dot / ink / soft): " + [0,1,2,3,4,5,6,7].map(function(i){ var h=Math.round(((i*137.508)%360)*10)/10;
    return "#"+i+" "+h+"deg "+okPaint(PH_L.dot[ti],projectChroma("dot",h),h).hex+" "+okPaint(PH_L.ink[ti],projectChroma("ink",h),h).hex+" "+okPaint(PH_L.soft[ti],projectChroma("soft",h),h).hex; }).join(" | "));
});

/* distinctness of the first N projects (golden angle now runs in OKLCH hue) - info */
(function(){
  function dEhex(a,b){ var A=oklab(linv(a)), B=oklab(linv(b)); return 100*Math.hypot(A[0]-B[0],A[1]-B[1],A[2]-B[2]); }
  [8,12,16].forEach(function(N){
    var cs=[]; for(var i=0;i<N;i++){ var h=Math.round(((i*137.508)%360)*10)/10; cs.push(okPaint(PH_L.dot[0],projectChroma("dot",h),h).hex); }
    var n=99; for(var a=0;a<N;a++) for(var b=a+1;b<N;b++) n=Math.min(n,dEhex(cs[a],cs[b]));
    rows.push("   info: first "+N+" projects, closest pair of dots dE "+n.toFixed(1)+" (the HSL golden angle gave 2.7-3.3 by project 8)");
  });
})();

/* ---------------- 5. the old palette, for comparison (informational) ---------------- */
if(process.argv.indexOf("--before") > -1){
  var old = [];
  ["light","dark"].forEach(function(m){
    var B = BEFORE[m];
    function o(what, fg, bg, min){ var r = contrast(fg,bg); old.push(pad(m,6)+pad(what,30)+pad(r.toFixed(2)+":1",9)+pad(">= "+min,8)+(r>=min?"pass":"below")); }
    o("ink on paper",B.ink,B.paper,7); o("ink on panel",B.ink,B.panel,7);
    o("muted on paper",B.muted,B.paper,4.5); o("muted on panel",B.muted,B.panel,4.5);
    o("muted on note",B.muted,B.note,4.5); o("muted on lineSoft (chip)",B.muted,B.lineSoft,4.5);
    o("accentInk on panel",B.accentInk,B.panel,4.5); o("accentInk on accentSoft",B.accentInk,B.accentSoft,4.5);
    o("onAccent on accent",B.onAccent,B.accent,4.5); o("danger on panel",B.danger,B.panel,4.5);
    o("line vs panel",B.line,B.panel,1.5); o("line vs paper",B.line,B.paper,1.35);
    o("lineSoft vs panel",B.lineSoft,B.panel,1.15);
    var cur = sweep(m, function(h,k){
      var dark = m === "dark";
      if(k==="ink")  return hsl(h, .42, dark ? .72 : .30);
      if(k==="soft") return dark ? hsl(h,.30,.18) : hsl(h,.46,.92);
      return dark ? hsl(h,.38,.58) : hsl(h,.44,.40);
    });
    ["ink on soft (chip)","base vs panel (dot/bar)"].forEach(function(k){
      old.push(pad(m,6)+pad("OLD projectColor "+k,30)+" worst "+cur[k][0].toFixed(2)+":1 at hue "+cur[k][1]);
    });
  });
  rows.push(""); rows.push("== BEFORE (current palette, informational)"); rows = rows.concat(old);
}

DRIFT.forEach(function(d){ rows.push("FAIL  accent drift  " + d); fails++; });
console.log(rows.join("\n"));
console.log("\n" + (fails ? fails + " FAILURE(S)" : "ALL CHECKS PASS"));
process.exit(fails ? 1 : 0);
