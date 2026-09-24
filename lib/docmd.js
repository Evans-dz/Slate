/* Slate docs: the markdown a doc's body is stored in, and the block model that the
   editor, Read mode and the project doc tabs all work from.

   One module, two consumers — index.html loads it as window.SlateDocMd, and the
   round-trip tests require() it in node — so the grammar the tests prove is the
   grammar the app runs. The DOM half at the bottom only runs in a browser.

   The body stays one plain markdown string. Nothing about storage changed when
   the rich editor arrived: an old build shows the markers raw but keeps them
   intact, and a doc that is opened and closed untouched is never rewritten.

   Model
     Block = {t:"p", lines:[Runs]} | {t:"quote", lines:[Runs]}
           | {t:"h", lv:1..3, runs:Runs}
           | {t:"list", items:[{d, k:"ul"|"ol", n?, ck?, lines:[Runs]}]}
           | {t:"code", lang, code:[string]} | {t:"hr"}
     and every block carries gap: how many blank lines sit above it. A gap of 0
     means "the line right under the one above" — the same Copy unit, which is
     how a prompt can be a sentence and then a list and still copy as one.
     Runs  = [{x:text, m:marks, a:href}], marks drawn from "bisuhc" in that order:
     bold italic strike underline highlight code. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SlateDocMd = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function rep(c, n){ return n > 0 ? new Array(n + 1).join(c) : ""; }
  function runLen(s, i, c){ var j = i; while(s.charAt(j) === c) j++; return j - i; }

  /* ---------- block grammar ----------
     The split rules are the ones docBlocks() always had — a blank line, a fence
     and a heading line each end a block — because that split is where every
     existing Copy button starts and stops. CommonMark would move them: it merges
     single line breaks, reads a line of --- under text as a heading underline and
     splits blocks at list starts, and prompts rely on all three not happening. */
  var HEAD_RE  = /^(#{1,3})\s/;
  var FENCE_RE = /^(`{3,})(.*)$/;
  var ITEM_RE  = /^([ \t]*)([-*]|\d{1,9}[.)])[ \t]+(.*)$/;
  var CHECK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
  var QUOTE_RE = /^>/;
  var CONT_RE  = /^[ \t]+\S/;
  var HR_RE    = /^-{3,}[ \t]*$/;
  var TEXTY    = {p:1, list:1, quote:1};

  function parse(text){
    var lines = String(text == null ? "" : text).replace(/\r/g, "").split("\n");
    var out = [], buf = [], gap = 0, fence = null;
    function flush(){
      if(!buf.length) return;
      var bs = bufferBlocks(buf);
      bs[0].gap = gap;
      gap = 0;
      for(var k = 0; k < bs.length; k++) out.push(bs[k]);
      buf = [];
    }
    for(var i = 0; i < lines.length; i++){
      var l = lines[i];
      if(fence){
        if(fence.close.test(l)){ out.push(codeBlock(fence)); fence = null; }
        else fence.body.push(l);
        continue;
      }
      var fm = FENCE_RE.exec(l);
      if(fm){
        flush();
        var n = fm[1].length;
        /* a plain ``` fence closes at any line starting with ```, exactly as the
           old splitter did; a longer one (which the serialiser writes when the code
           itself holds ```) needs a matching bare fence */
        fence = { lang: fm[2].replace(/`/g, "").trim(), body: [], gap: gap, line: i,
                  close: n === 3 ? /^```/ : new RegExp("^`{" + n + ",}[ \\t]*$") };
        gap = 0;
        continue;
      }
      if(!l.trim()){ flush(); gap++; continue; }
      if(HEAD_RE.test(l)){
        flush();
        out.push({ t:"h", lv: HEAD_RE.exec(l)[1].length, runs: inline(l.replace(/^#{1,3}\s*/, ""), false),
                   gap: gap, line: i });
        gap = 0;
        continue;
      }
      buf.push({ x: l, i: i });
    }
    // an unclosed fence at the very end still holds its code; an empty one is nothing
    if(fence && fence.body.length) out.push(codeBlock(fence));
    flush();
    return normDoc(out);
  }
  function codeBlock(f){ return { t:"code", lang: f.lang, code: f.body, gap: f.gap, line: f.line }; }

  /* one run of non-blank lines: paragraph lines, list lines and quote lines,
     each run its own block, all tight to each other */
  function bufferBlocks(buf){
    if(buf.length === 1 && HR_RE.test(buf[0].x)) return [{ t:"hr", line: buf[0].i }];
    var parts = [], cur = null;
    buf.forEach(function(L){
      var cls = ITEM_RE.test(L.x) ? "list"
              : QUOTE_RE.test(L.x) ? "quote"
              : (cur && cur.t === "list" && CONT_RE.test(L.x)) ? "list" : "p";
      if(!cur || cur.t !== cls){ cur = { t: cls, rows: [] }; parts.push(cur); }
      cur.rows.push(L);
    });
    var out = [];
    parts.forEach(function(pt){
      if(pt.t === "list") listBlocks(pt.rows).forEach(function(b){ out.push(b); });
      else if(pt.t === "quote") out.push({ t:"quote", line: pt.rows[0].i,
        lines: pt.rows.map(function(L){ return inline(L.x.replace(/^> ?/, ""), false); }) });
      else out.push({ t:"p", line: pt.rows[0].i,
        lines: pt.rows.map(function(L){ return inline(L.x, true); }) });
    });
    out.forEach(function(b){ b.gap = 0; });
    return out;
  }

  function listBlocks(rows){
    var items = [], stack = [];
    rows.forEach(function(L){
      var m = ITEM_RE.exec(L.x);
      if(!m){ items[items.length - 1].lines.push(inline(L.x.replace(/^[ \t]+/, ""), true)); return; }
      var ind = m[1].replace(/\t/g, "  ").length;
      while(stack.length && stack[stack.length - 1] >= ind) stack.pop();
      var it = { d: stack.length, k: /\d/.test(m[2]) ? "ol" : "ul", lines: [], line: L.i };
      stack.push(ind);
      var txt = m[3];
      if(it.k === "ol") it.n = parseInt(m[2], 10);
      else {
        var c = CHECK_RE.exec(txt);
        if(c){ it.ck = c[1] !== " "; txt = c[2] || ""; }
      }
      it.lines.push(inline(txt, false));
      items.push(it);
    });
    var blocks = [], cur = null;
    items.forEach(function(it){
      if(!cur || (it.d === 0 && it.k !== cur.items[0].k)){ cur = { t:"list", items: [], line: it.line }; blocks.push(cur); }
      cur.items.push(it);
    });
    return blocks;
  }

  /* ---------- inline grammar ----------
     **b** *i* _i_ <u>u</u> ~~s~~ ==h== `c` [text](url). The delimiters follow
     CommonMark's flanking rules, so 2*3*4, x == y, a ~~ b, snake_case and
     __init__ in an old prompt stay literal. Only exactly <u> and </u> are tags;
     <instructions> and every other angle bracket is text. Links are http, https,
     mailto and tel only — anything else stays text. */
  var SPECIAL   = "\\`<[]*_~=";
  var INLINE_ESC = "*_~=`[]<";
  var LS_ESC    = "#->";
  var LINK_END  = /^\]\(((?:https?:\/\/|mailto:|tel:)[^\s()<>]*)\)/i;
  var PUNCT_RE  = /[!-\/:-@\[-`{-~\u00A1-\u00BF\u2010-\u2027\u2030-\u205E\u3000-\u303F]/;
  var ORDER     = "bisuhc";
  function isWs(ch){ return !ch || /\s/.test(ch); }
  function isPn(ch){ return !!ch && PUNCT_RE.test(ch); }

  /* Is a run of backslashes that follows `before` and precedes `nx` an escape?
     Only in front of a character that could otherwise be syntax — so a regex's
     \d, a path's C:\Users and JSON's \\n in an old prompt keep every backslash.
     `ls` marks a paragraph line, where #, - and > at the start, and the dot of
     "1." after digits, can also be escaped. The serialiser asks the very same
     question, which is what keeps the two in step. */
  function escRun(before, nx, ls){
    if(!nx) return false;
    if(INLINE_ESC.indexOf(nx) > -1) return true;
    if(ls && LS_ESC.indexOf(nx) > -1 && /^[ \t]*$/.test(before)) return true;
    if(ls && (nx === "." || nx === ")") && /^[ \t]*\d{1,9}$/.test(before)) return true;
    return false;
  }

  function inline(s, ls){
    s = String(s == null ? "" : s);
    var toks = [], i = 0, n = s.length, m, k;
    function text(x){ if(x) toks.push({ k:"t", x: x }); }
    while(i < n){
      var c = s.charAt(i);
      if(c === "\\"){
        var bk = runLen(s, i, "\\"), nx = s.charAt(i + bk);
        if(escRun(s.slice(0, i), nx, ls)){
          text(rep("\\", bk >> 1));
          if(bk & 1){ text(nx); i += bk + 1; } else i += bk;
        } else { text(s.substr(i, bk)); i += bk; }
        continue;
      }
      if(c === "`"){
        var r = runLen(s, i, "`"), close = findTicks(s, i + r, r);
        if(close > -1){
          var code = s.slice(i + r, close);
          if(code.length >= 2 && code.charAt(0) === " " && code.charAt(code.length - 1) === " " && /[^ ]/.test(code)) code = code.slice(1, -1);
          toks.push({ k:"code", x: code });
          i = close + r;
          continue;
        }
        text(s.substr(i, r)); i += r;
        continue;
      }
      if(c === "<"){
        if(s.substr(i, 3) === "<u>"){ toks.push({ k:"tag", close:false, x:"<u>" }); i += 3; continue; }
        if(s.substr(i, 4) === "</u>"){ toks.push({ k:"tag", close:true, x:"</u>" }); i += 4; continue; }
        text("<"); i++;
        continue;
      }
      if(c === "["){ toks.push({ k:"lb", x:"[" }); i++; continue; }
      if(c === "]"){
        m = LINK_END.exec(s.slice(i));
        if(m){ toks.push({ k:"le", href: m[1], x: m[0] }); i += m[0].length; continue; }
        text("]"); i++;
        continue;
      }
      if(c === "*" || c === "_" || c === "~" || c === "="){
        var rl = runLen(s, i, c), before = s.charAt(i - 1), after = s.charAt(i + rl);
        var lf = !isWs(after) && (!isPn(after) || isWs(before) || isPn(before));
        var rf = !isWs(before) && (!isPn(before) || isWs(after) || isPn(after));
        /* * may sit inside a word (un*believ*able), but not between digits: 2*3*4
           and 2**10 are arithmetic. _, ~~ and == never open or close inside a word,
           so snake_case, __init__, x==y and a~~b in an old prompt stay what they were. */
        var wordy = lf && rf, digits = /\d/.test(before) && /\d/.test(after);
        if(c === "*") toks.push({ k:"d", ch:c, n:rl, orig:rl, open: lf && !digits, close: rf && !digits });
        else if(c === "_" ? rl === 1 : rl === 2)
          toks.push({ k:"d", ch:c, n:rl, orig:rl, open: lf && (!wordy || isPn(before)), close: rf && (!wordy || isPn(after)) });
        else text(s.substr(i, rl));
        i += rl;
        continue;
      }
      var j = i + 1;
      while(j < n && SPECIAL.indexOf(s.charAt(j)) < 0) j++;
      text(s.slice(i, j));
      i = j;
    }

    /* links first: brackets pair innermost-first, and a link can't hold a link */
    var lb = [], links = [];
    for(k = 0; k < toks.length; k++){
      if(toks[k].k === "lb") lb.push(k);
      else if(toks[k].k === "le" && lb.length){
        var o = lb.pop();
        if(o + 1 === k) continue;                  // "[](url)" stays literal: no invisible links
        links.push({ o: o, c: k, href: toks[k].href });
        toks[o].used = toks[k].used = true;
        lb = [];
      }
    }
    var inLink = [];
    links.forEach(function(L){ for(var q = L.o + 1; q < L.c; q++) inLink[q] = L; });
    var segs = [[]], pairs = [];
    for(k = 0; k < toks.length; k++) if(!inLink[k] && !toks[k].used) segs[0].push(k);
    links.forEach(function(L){ var seg = []; for(var q = L.o + 1; q < L.c; q++) seg.push(q); segs.push(seg); });
    segs.forEach(function(seg){ pairUp(toks, seg, pairs); });

    var runs = [];
    for(k = 0; k < toks.length; k++){
      var t = toks[k], x;
      if(t.k === "t" || t.k === "code") x = t.x;
      else if(t.k === "d") x = rep(t.ch, t.n);
      else if(t.used) continue;
      else x = t.x;
      if(!x) continue;
      var mk = "";
      for(var p = 0; p < pairs.length; p++){
        if(pairs[p].o < k && k < pairs[p].c && mk.indexOf(pairs[p].m) < 0) mk += pairs[p].m;
      }
      if(t.k === "code") mk += "c";
      runs.push({ x: x, m: sortMarks(mk), a: inLink[k] ? inLink[k].href : "" });
    }
    return runs;
  }
  function findTicks(s, from, r){
    for(var j = from; j < s.length;){
      if(s.charAt(j) === "`"){ var q = runLen(s, j, "`"); if(q === r) return j; j += q; }
      else j++;
    }
    return -1;
  }

  /* CommonMark's delimiter pass, cut down: * gives i (1) or b (2), _ gives i,
     ~~ gives s, == gives h; <u></u> pair like brackets */
  function pairUp(toks, seg, pairs){
    var open = [];
    seg.forEach(function(k){
      var t = toks[k];
      if(t.k !== "tag") return;
      if(!t.close) open.push(k);
      else if(open.length){ var o = open.pop(); pairs.push({ o: o, c: k, m: "u" }); toks[o].used = t.used = true; }
    });
    var ds = seg.filter(function(k){ return toks[k].k === "d"; });
    for(var ci = 0; ci < ds.length; ci++){
      var C = toks[ds[ci]];
      while(C.close && C.n > 0){
        var found = -1;
        for(var oi = ci - 1; oi >= 0; oi--){
          var O = toks[ds[oi]];
          if(O.ch !== C.ch || !O.open || O.n <= 0) continue;
          if(C.ch === "*" && (O.close || C.open) && (O.orig + C.orig) % 3 === 0 &&
             !(O.orig % 3 === 0 && C.orig % 3 === 0)) continue;
          found = oi;
          break;
        }
        if(found < 0) break;
        var O2 = toks[ds[found]];
        var use = C.ch === "*" ? (O2.n >= 2 && C.n >= 2 ? 2 : 1) : C.ch === "_" ? 1 : 2;
        pairs.push({ o: ds[found], c: ds[ci],
                     m: C.ch === "*" ? (use === 2 ? "b" : "i") : C.ch === "_" ? "i" : C.ch === "~" ? "s" : "h" });
        O2.n -= use;
        C.n -= use;
        for(var q = found + 1; q < ci; q++){ toks[ds[q]].open = toks[ds[q]].close = false; }
      }
    }
  }

  function sortMarks(m){
    var out = "";
    for(var i = 0; i < ORDER.length; i++) if(m.indexOf(ORDER.charAt(i)) > -1) out += ORDER.charAt(i);
    return out;
  }

  /* ---------- normalising: what "the same document" means ---------- */
  var OK_HREF = /^(https?:\/\/|mailto:|tel:)/i;
  function cleanHref(h){
    h = String(h == null ? "" : h).trim();
    if(!OK_HREF.test(h)) return "";
    return h.replace(/[\s()<>]/g, function(c){ return "%" + ("0" + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2); });
  }
  function pushRun(out, x, m, a){
    var p = out[out.length - 1];
    if(p && p.m === m && p.a === a) p.x += x;
    else out.push({ x: x, m: m, a: a });
  }
  /* bold, italic, strike, underline and highlight never start or end on a space:
     a delimiter next to a space can't open or close, so the space steps outside */
  function edgeTrim(runs, test){
    var cs = [];
    runs.forEach(function(r){ for(var i = 0; i < r.x.length; i++) cs.push({ ch: r.x.charAt(i), m: r.m, a: r.a }); });
    "bisuh".split("").forEach(function(mk){
      var i = 0;
      while(i < cs.length){
        if(cs[i].m.indexOf(mk) < 0){ i++; continue; }
        var j = i;
        while(j < cs.length && cs[j].m.indexOf(mk) > -1) j++;
        var a = i, b = j - 1;
        while(a <= b && cs[a].m.indexOf("c") < 0 && test(cs[a].ch)){ cs[a].m = cs[a].m.replace(mk, ""); a++; }
        while(b >= a && cs[b].m.indexOf("c") < 0 && test(cs[b].ch)){ cs[b].m = cs[b].m.replace(mk, ""); b--; }
        i = j;
      }
    });
    var out = [];
    cs.forEach(function(c){ pushRun(out, c.ch, c.m, c.a); });
    return out;
  }
  function spaceCh(ch){ return /\s/.test(ch); }
  function normRuns(runs){
    var out = [];
    (runs || []).forEach(function(r){
      if(!r || r.x == null) return;
      var x = String(r.x).replace(/\r/g, "").replace(/\n/g, " ");
      if(x) pushRun(out, x, sortMarks(r.m || ""), r.a ? cleanHref(r.a) : "");
    });
    out = edgeTrim(out, spaceCh);
    /* a link that only shows its own address is plain text: display links it anyway */
    var res = [];
    for(var i = 0; i < out.length; i++){
      var r = out[i];
      if(r.a && !r.m && r.x === r.a && /^https?:\/\//i.test(r.a) &&
         !(out[i - 1] && out[i - 1].a === r.a) && !(out[i + 1] && out[i + 1].a === r.a)) r = { x: r.x, m: "", a: "" };
      pushRun(res, r.x, r.m, r.a);
    }
    return res;
  }
  function blankRuns(r){
    for(var i = 0; i < r.length; i++) if(r[i].m.indexOf("c") > -1 || r[i].x.trim()) return false;
    return true;
  }
  function ltrim(r){
    r = r.map(function(x){ return { x: x.x, m: x.m, a: x.a }; });
    while(r.length && r[0].m.indexOf("c") < 0){
      var t = r[0].x.replace(/^\s+/, "");
      if(t){ r[0].x = t; break; }
      r.shift();
    }
    return r;
  }
  function runsText(r){ var s = ""; for(var i = 0; i < r.length; i++) s += r[i].x; return s; }
  function runsEqual(a, b){
    if(a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++) if(a[i].x !== b[i].x || a[i].m !== b[i].m || a[i].a !== b[i].a) return false;
    return true;
  }

  function normDoc(bs){
    /* The editor holds a paragraph one element per line, each line after the
       first tight to the one above. Join those lines before anything else, so an
       empty line among them reads as what it is — a blank line, the break
       between two blocks — rather than as a line that was dropped. */
    var raw = [];
    (bs || []).forEach(function(b){
      if(!b) return;
      var prev = raw[raw.length - 1];
      if(b.t === "p" || b.t === "quote"){
        if(prev && prev.t === b.t && b.gap != null && (b.gap | 0) === 0){ prev.lines = prev.lines.concat(b.lines || []); return; }
        raw.push({ t: b.t, lines: (b.lines || []).slice(), gap: b.gap, line: b.line });
      } else raw.push(b);
    });
    var out = [], carry = 0;
    raw.forEach(function(b){
      var gap = b.gap == null ? 1 : Math.max(0, b.gap | 0), lead = 0, trail = 0;
      if(b.t === "p"){
        /* blank lines at a paragraph's edges are the blank lines around it (a bare
           ">" in a quote is not: it was always just part of its block) */
        var ls = b.lines.map(normRuns);
        while(ls.length && blankRuns(ls[0])){ ls.shift(); lead = 1; }
        while(ls.length && blankRuns(ls[ls.length - 1])){ ls.pop(); trail = 1; }
        b = { t: b.t, lines: ls, line: b.line };
        if(!ls.length && (lead || trail)){ carry = Math.max(carry, gap, 1); return; }
      }
      var made = normBlock(b);
      /* a block that turns out to be empty (a bare "- ") still held the blank
         line above it, or the block under it would glue onto the one before */
      if(!made.length){ carry = Math.max(carry, gap); return; }
      made.forEach(function(nb, i){
        if(!i) nb.gap = Math.max(gap, carry, lead);
        out.push(nb);
      });
      carry = trail;
    });
    var res = [];
    out.forEach(function(b){
      var prev = res[res.length - 1];
      if(!prev){ b.gap = 0; res.push(b); return; }
      // a divider is only a divider standing alone between blank lines
      if(b.t === "hr" || prev.t === "hr") b.gap = Math.max(1, b.gap);
      if(b.gap === 0 && TEXTY[prev.t] && TEXTY[b.t]){
        if(prev.t === b.t && b.t !== "list"){ prev.lines = prev.lines.concat(b.lines); return; }
        if(prev.t === "list" && b.t === "list" && b.items[0].k === prev.items[0].k){
          prev.items = prev.items.concat(b.items);
          number(prev.items);
          return;
        }
        // an indented line right under a list would read back as part of its last item
        if(prev.t === "list" && b.t === "p" && /^[ \t]/.test(runsText(b.lines[0]))) b.gap = 1;
      }
      res.push(b);
    });
    return res;
  }
  function normBlock(b){
    var keepLine = function(nb){ if(b.line != null) nb.line = b.line; return nb; };
    if(b.t === "p"){
      var outp = [], cur = [];
      (b.lines || []).forEach(function(r){
        r = normRuns(r);
        // a blank line inside a paragraph is what separates two blocks
        if(blankRuns(r)){ if(cur.length){ outp.push({ t:"p", lines: cur, gap: 1 }); cur = []; } }
        else cur.push(r);
      });
      if(cur.length) outp.push({ t:"p", lines: cur, gap: 1 });
      if(outp.length) keepLine(outp[0]);
      return outp;
    }
    if(b.t === "h"){
      var hr = ltrim(normRuns(b.runs));
      return blankRuns(hr) ? [] : [keepLine({ t:"h", lv: Math.max(1, Math.min(3, b.lv | 0 || 1)), runs: hr })];
    }
    if(b.t === "quote"){
      var ql = (b.lines || []).map(normRuns);
      while(ql.length && blankRuns(ql[0])) ql.shift();
      while(ql.length && blankRuns(ql[ql.length - 1])) ql.pop();
      return ql.length ? [keepLine({ t:"quote", lines: ql })] : [];
    }
    // a change of list type splits one list into two, still tight to each other
    if(b.t === "list") return normList(b.items).map(function(l, i){ l.gap = 0; return i ? l : keepLine(l); });
    if(b.t === "code"){
      var code = [];
      (b.code || []).forEach(function(l){ String(l).replace(/\r/g, "").split("\n").forEach(function(x){ code.push(x); }); });
      if(code.length === 1 && code[0] === "") code = [];
      return [keepLine({ t:"code", lang: String(b.lang || "").replace(/[`\r\n]/g, "").trim(), code: code })];
    }
    if(b.t === "hr") return [keepLine({ t:"hr" })];
    return [];
  }
  function normList(items){
    var lists = [], cur = null, prevD = -1;
    (items || []).forEach(function(it){
      var ls = (it.lines || []).map(function(r){ return ltrim(normRuns(r)); })
                               .filter(function(r){ return !blankRuns(r); });
      if(!ls.length) return;
      var k = it.k === "ol" ? "ol" : "ul";
      var d = Math.max(0, Math.min(it.d | 0, prevD + 1));
      if(cur && d === 0 && cur.items[0].k !== k) cur = null;
      if(!cur){ cur = { t:"list", items: [] }; lists.push(cur); d = 0; }
      var ni = { d: d, k: k, lines: ls };
      if(k === "ol"){ var n = parseInt(it.n, 10); ni.n = isNaN(n) || n < 0 ? 1 : Math.min(n, 999999999); }
      else if(it.ck === true || it.ck === false) ni.ck = it.ck;
      if(it.line != null) ni.line = it.line;
      cur.items.push(ni);
      prevD = d;
    });
    lists.forEach(function(l){ number(l.items); });
    return lists;
  }
  /* a numbered list counts on from its first number, so what Read mode shows and
     what Copy hands out are always the same numbers */
  function number(items){
    var st = [];
    items.forEach(function(it){
      if(st.length > it.d + 1) st.length = it.d + 1;
      var s = st[it.d];
      if(s && s.k === it.k){ if(it.k === "ol") it.n = Math.min(++s.n, 999999999); }
      else st[it.d] = { k: it.k, n: it.k === "ol" ? it.n : 0 };
    });
  }

  /* ---------- serialiser ---------- */
  var MK_OPEN  = { b:"**", i:"*", s:"~~", u:"<u>", h:"==" };
  var MK_CLOSE = { b:"**", i:"*", s:"~~", u:"</u>", h:"==" };
  var STACK = ["b", "i", "s", "u", "h"];

  function codeSpan(x){
    var max = 0, m, re = /`+/g;
    while((m = re.exec(x))) max = Math.max(max, m[0].length);
    var f = rep("`", max + 1);
    var pad = (x.charAt(0) === "`" || x.charAt(x.length - 1) === "`" ||
              (x.length >= 2 && x.charAt(0) === " " && x.charAt(x.length - 1) === " " && /[^ ]/.test(x))) ? " " : "";
    return f + pad + x + pad + f;
  }
  /* runs -> pieces: the author's text (lit, may need escaping) and syntax */
  function pieces(runs){
    var out = [], stack = [];
    function close(key){ out.push({ s: key.charAt(0) === "@" ? "](" + key.slice(1) + ")" : MK_CLOSE[key], lit: false }); }
    function open(key){ out.push({ s: key.charAt(0) === "@" ? "[" : MK_OPEN[key], lit: false }); }
    runs.forEach(function(r){
      var want = [];
      if(r.a) want.push("@" + r.a);
      STACK.forEach(function(k){ if(r.m.indexOf(k) > -1) want.push(k); });
      var keep = 0;
      while(keep < stack.length && want.indexOf(stack[keep]) > -1) keep++;
      while(stack.length > keep) close(stack.pop());
      want.forEach(function(k){ if(stack.indexOf(k) < 0){ open(k); stack.push(k); } });
      out.push(r.m.indexOf("c") > -1 ? { s: codeSpan(r.x), lit: false } : { s: r.x, lit: true });
    });
    while(stack.length) close(stack.pop());
    return out;
  }
  /* level 0 escapes nothing it doesn't have to; level 1 escapes every character
     that could be read as syntax. Backslash runs are doubled exactly where the
     parser would otherwise read them as escapes. */
  function emit(ps, level, ls){
    var cs = [];
    ps.forEach(function(p){ for(var i = 0; i < p.s.length; i++) cs.push({ c: p.s.charAt(i), lit: p.lit }); });
    var out = "";
    for(var i = 0; i < cs.length; i++){
      var ch = cs[i];
      if(!ch.lit){ out += ch.c; continue; }
      if(ch.c === "\\"){
        var j = i;
        while(j < cs.length && cs[j].lit && cs[j].c === "\\") j++;
        var k = j - i, nx = j < cs.length ? cs[j].c : "";
        out += rep("\\", escRun(out, nx, ls) ? 2 * k : k);
        i = j - 1;
        continue;
      }
      out += (level > 0 && INLINE_ESC.indexOf(ch.c) > -1) ? "\\" + ch.c : ch.c;
    }
    return out;
  }
  /* what a line must not look like, given where it sits */
  function fixLine(s, kind){
    var m;
    if(kind === "p" || kind === "p1"){
      if(HEAD_RE.test(s) || QUOTE_RE.test(s) || /^```/.test(s) || (kind === "p1" && HR_RE.test(s))) return "\\" + s;
    }
    if(kind === "p" || kind === "p1" || kind === "lc"){
      if((m = /^([ \t]*)[-*][ \t]/.exec(s))) return m[1] + "\\" + s.slice(m[1].length);
      if((m = /^([ \t]*\d{1,9})[.)][ \t]/.exec(s))) return m[1] + "\\" + s.slice(m[1].length);
    }
    if(kind === "li-ul" && /^\[[ xX]\]([ \t]|$)/.test(s)) return "\\" + s;
    return s;
  }
  function lineOk(s, target, kind){
    var ls = kind === "p" || kind === "p1" || kind === "lc";
    if(!runsEqual(normRuns(inline(s, ls)), target)) return false;
    if(kind === "p" || kind === "p1") return !(HEAD_RE.test(s) || ITEM_RE.test(s) || QUOTE_RE.test(s) || FENCE_RE.test(s) || (kind === "p1" && HR_RE.test(s)));
    if(kind === "lc") return !ITEM_RE.test(s);
    if(kind === "li-ul") return !CHECK_RE.test(s);
    return true;
  }
  /* degraded spellings, tried only when the exact one can't be written: a mark
     that begins or ends on punctuation next to a letter has no delimiter form
     ("a(*x*)b" works, "a*(x)*b" doesn't), so the punctuation steps outside; after
     that marks go, and last of all links and code — text is never dropped */
  function keepMarks(runs, keep){
    return normRuns(runs.map(function(r){
      var m = "";
      for(var i = 0; i < r.m.length; i++) if(keep.indexOf(r.m.charAt(i)) > -1) m += r.m.charAt(i);
      return { x: r.x, m: m, a: keep.indexOf("a") > -1 ? r.a : "" };
    }));
  }
  function serLine(runs, kind){
    var ls = kind === "p" || kind === "p1" || kind === "lc";
    var targets = [runs];
    [normRuns(edgeTrim(runs, isPn)), keepMarks(runs, "ac"), keepMarks(runs, "")].forEach(function(t){
      if(!runsEqual(t, targets[targets.length - 1])) targets.push(t);
    });
    for(var ti = 0; ti < targets.length; ti++){
      for(var lv = 0; lv < 2; lv++){
        var s = fixLine(emit(pieces(targets[ti]), lv, ls), kind);
        if(lineOk(s, targets[ti], kind)) return s;
      }
    }
    return fixLine(emit([{ s: runsText(runs), lit: true }], 1, ls), kind);
  }
  function fenceFor(code){
    var max = 2;
    code.forEach(function(l){ var r = runLen(l, 0, "`"); if(r > max) max = r; });
    return rep("`", max + 1);
  }
  function serList(items){
    var out = [], st = [];
    items.forEach(function(it){
      st.length = it.d;
      var ind = it.d ? st[it.d - 1].ind + st[it.d - 1].w : 0;
      var mk = it.k === "ol" ? it.n + "." : "-";
      st.push({ ind: ind, w: mk.length + 1 });
      var first = it.ck != null
        ? "[" + (it.ck ? "x" : " ") + "] " + serLine(it.lines[0], "li")
        : serLine(it.lines[0], it.k === "ul" ? "li-ul" : "li");
      out.push(rep(" ", ind) + mk + " " + first);
      for(var i = 1; i < it.lines.length; i++) out.push(rep(" ", ind + mk.length + 1) + serLine(it.lines[i], "lc"));
    });
    return out.join("\n");
  }
  /* `alone`: nothing tight above or below, so a one-line paragraph is a whole
     block by itself — and a lone --- line there would read back as a divider */
  function serBlock(b, alone){
    if(b.t === "h") return rep("#", b.lv) + " " + serLine(b.runs, "h");
    if(b.t === "hr") return "---";
    if(b.t === "code"){ var f = fenceFor(b.code); return f + b.lang + "\n" + (b.code.length ? b.code.join("\n") + "\n" : "") + f; }
    if(b.t === "quote") return b.lines.map(function(r){ var s = serLine(r, "q"); return s ? "> " + s : ">"; }).join("\n");
    if(b.t === "list") return serList(b.items);
    var kind = alone && b.lines.length === 1 ? "p1" : "p";
    return b.lines.map(function(r){ return serLine(r, kind); }).join("\n");
  }
  function serialize(blocks){
    var bs = normDoc(blocks), out = "";
    bs.forEach(function(b, i){
      if(i) out += rep("\n", b.gap + 1);
      var next = bs[i + 1];
      var alone = !(i && b.gap === 0 && TEXTY[bs[i - 1].t]) && !(next && next.gap === 0 && TEXTY[next.t]);
      out += serBlock(b, alone);
    });
    return out;
  }

  /* ---------- plain text: Copy, search, previews ----------
     Copy hands over what you see: no ** or <u>, list markers kept, a link as
     "text (address)". Code is copied exactly as written. */
  function plainRuns(runs){
    var out = "", i = 0;
    while(i < runs.length){
      var r = runs[i];
      if(!r.a){ out += r.x; i++; continue; }
      var t = "", j = i;
      while(j < runs.length && runs[j].a === r.a){ t += runs[j].x; j++; }
      var shown = r.a.replace(/^(mailto|tel):/i, "");
      out += (t === r.a || t === shown) ? t : t + " (" + shown + ")";
      i = j;
    }
    return out;
  }
  function plainBlock(b){
    if(b.t === "h") return plainRuns(b.runs);
    if(b.t === "code") return b.code.join("\n");
    if(b.t === "hr") return "";
    if(b.t === "list") return b.items.map(function(it){
      var mk = it.k === "ol" ? it.n + ". " : it.ck != null ? (it.ck ? "- [x] " : "- [ ] ") : "- ";
      var pad = rep(" ", it.d * 2);
      return it.lines.map(function(r, i){ return pad + (i ? rep(" ", mk.length) : mk) + plainRuns(r); }).join("\n");
    }).join("\n");
    return b.lines.map(plainRuns).join("\n");
  }
  /* Copy units: a heading, a divider or a code block stands alone; tight
     paragraphs, lists and quotes copy together */
  function units(blocks){
    var out = [], cur = null;
    blocks.forEach(function(b, i){
      var texty = !!TEXTY[b.t];
      if(texty && cur && cur.texty && b.gap === 0) cur.blocks.push(b);
      else { cur = { texty: texty, t: texty ? "text" : b.t, blocks: [b], at: i }; out.push(cur); }
    });
    return out;
  }
  function unitText(u){ return u.blocks.map(plainBlock).join("\n"); }
  /* a heading plus everything under it, up to the next heading at its level or above */
  function sectionText(blocks, at){
    var h = blocks[at], parts = [plainRuns(h.runs)], cur = null;
    for(var i = at + 1; i < blocks.length; i++){
      var b = blocks[i];
      if(b.t === "h" && b.lv <= h.lv) break;
      var t = plainBlock(b);
      if(cur !== null && b.gap === 0 && TEXTY[b.t] && TEXTY[blocks[i - 1].t]) parts[parts.length - 1] += "\n" + t;
      else if(t) parts.push(t);
      cur = t;
    }
    return parts.join("\n\n");
  }
  var plainMemo = { keys: [], vals: {} };
  function plain(text){
    var key = String(text == null ? "" : text);
    if(Object.prototype.hasOwnProperty.call(plainMemo.vals, key)) return plainMemo.vals[key];
    var out = units(parse(key)).map(unitText).filter(function(t){ return t; }).join("\n\n");
    plainMemo.keys.push(key);
    plainMemo.vals[key] = out;
    if(plainMemo.keys.length > 80) delete plainMemo.vals[plainMemo.keys.shift()];
    return out;
  }

  /* Tick a checklist line in the stored text, touching that one character and
     nothing else. The line number came from an earlier render, so it is checked
     again here: if a save from the other device moved things, nothing changes. */
  function toggleTask(body, line, expect, checked){
    body = String(body == null ? "" : body);
    var found = null;
    parse(body).forEach(function(b){
      if(b.t === "list") b.items.forEach(function(it){ if(it.line === line && it.ck != null) found = it; });
    });
    if(!found || plainRuns(found.lines[0]) !== expect) return null;
    var lines = body.split("\n"), L = lines[line];
    var m = /^([ \t]*[-*][ \t]+\[)[ xX]\]/.exec(L || "");
    if(!m) return null;
    lines[line] = m[1] + (checked ? "x" : " ") + L.slice(m[1].length + 1);
    return lines.join("\n");
  }

  /* ======================= DOM: browser only ======================= */

  /* The editor's highlight is a background colour, because that is what
     hiliteColor can apply, toggle and undo natively. This exact colour is only a
     marker — CSS paints the themed --mark over it — and it is matched by value,
     not by string, since engines format colours differently. */
  var HL = "rgb(255, 229, 102)";
  function isHL(bg){
    var m = /rgba?\(\s*(\d+)[^\d]+(\d+)[^\d]+(\d+)/.exec(bg || "");
    return !!m && Math.abs(m[1] - 255) < 3 && Math.abs(m[2] - 229) < 3 && Math.abs(m[3] - 102) < 3;
  }
  var TAG_FOR = { b:"b", i:"i", s:"s", u:"u", c:"code" };

  /* runs -> nodes. Built with createElement and text nodes only, never HTML.
     opts.editor: the live editor's spelling (highlight as a background span);
     otherwise Read mode (<mark>, links open in a new tab). opts.text(host, x)
     renders plain text — Read mode passes richText so #tags stay live. */
  function inlineInto(parent, runs, opts){
    opts = opts || {};
    var d = parent.ownerDocument;
    runs.forEach(function(r){
      var outer = null, inner = null;
      function wrap(e){ if(inner) inner.appendChild(e); else outer = e; inner = e; }
      if(r.a){
        var a = d.createElement("a");
        a.setAttribute("href", r.a);
        if(!opts.editor){ a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "mdlink"; }
        wrap(a);
      }
      for(var i = 0; i < ORDER.length; i++){
        var mk = ORDER.charAt(i);
        if(r.m.indexOf(mk) < 0) continue;
        if(mk === "h"){
          var h;
          if(opts.editor){ h = d.createElement("span"); h.style.backgroundColor = HL; }
          else h = d.createElement("mark");
          wrap(h);
        } else wrap(d.createElement(TAG_FOR[mk]));
      }
      var host = inner || parent;
      if(opts.text && !r.a && r.m.indexOf("c") < 0) opts.text(host, r.x);
      else host.appendChild(d.createTextNode(r.x));
      if(outer) parent.appendChild(outer);
    });
  }
  function linesInto(e, lines, opts){
    lines.forEach(function(r, i){
      if(i) e.appendChild(e.ownerDocument.createElement("br"));
      inlineInto(e, r, opts);
    });
  }
  /* one block -> one element. opts.task(li, item) may return the node an item's
     text goes into (Read mode wraps it with a checkbox). */
  function renderBlock(b, opts, d){
    opts = opts || {};
    d = d || opts.doc || document;
    var e;
    if(b.t === "h"){ e = d.createElement("h" + b.lv); inlineInto(e, b.runs, opts); }
    else if(b.t === "hr") e = d.createElement("hr");
    else if(b.t === "code"){
      e = d.createElement("pre");
      if(b.lang) e.setAttribute("data-lang", b.lang);
      /* lines joined with <br>, not "\n": HTML drops a newline straight after
         <pre>, so a code block starting with a blank line would lose it on paste */
      b.code.forEach(function(l, i){
        if(i) e.appendChild(d.createElement("br"));
        if(l) e.appendChild(d.createTextNode(l));
      });
      // an empty last line needs something to put the caret on
      if(opts.editor && (!b.code.length || b.code[b.code.length - 1] === "")) e.appendChild(d.createElement("br"));
    }
    else if(b.t === "quote"){ e = d.createElement("blockquote"); linesInto(e, b.lines, opts); }
    else if(b.t === "list") e = listEl(b.items, opts, d);
    else { e = d.createElement("p"); linesInto(e, b.lines, opts); }
    return e;
  }
  function listEl(items, opts, d){
    var root = null, st = [];
    items.forEach(function(it){
      if(st.length > it.d + 1) st.length = it.d + 1;
      var lvl = st[it.d];
      if(!lvl || lvl.tag !== it.k){
        var L = d.createElement(it.k);
        if(it.k === "ol" && it.n !== 1) L.setAttribute("start", String(it.n));
        if(it.d === 0) root = root || L;
        else st[it.d - 1].li.appendChild(L);
        lvl = st[it.d] = { tag: it.k, list: L, li: null };
      }
      var li = d.createElement("li");
      var host = li;
      if(it.k === "ul" && it.ck != null){
        li.setAttribute("data-task", it.ck ? "1" : "0");
        if(opts.task) host = opts.task(li, it) || li;
      }
      linesInto(host, it.lines, opts);
      lvl.list.appendChild(li);
      lvl.li = li;
    });
    return root;
  }
  /* the editor's content for a model; data-gap records a tight or extra-spaced
     block (absent means the usual one blank line) */
  function toDom(blocks, opts){
    opts = opts || {};
    var d = opts.doc || document;
    var f = d.createDocumentFragment();
    normDoc(blocks).forEach(function(b, i){
      var els = [];
      /* In the editor a paragraph or quote is one element per line, so the
         browser's heading, list and quote commands each act on exactly the line
         they were used on; the lines after the first are tight (data-gap="0"). */
      if(opts.editor && (b.t === "p" || b.t === "quote")){
        b.lines.forEach(function(r){
          var e = d.createElement(b.t === "p" ? "p" : "blockquote");
          if(r.length) inlineInto(e, r, opts); else e.appendChild(d.createElement("br"));
          els.push(e);
        });
      } else els.push(renderBlock(b, opts, d));
      els.forEach(function(e, j){
        if(j) e.setAttribute("data-gap", "0");
        else if(i && b.gap !== 1) e.setAttribute("data-gap", String(b.gap));
        f.appendChild(e);
      });
    });
    if(opts.editor && !f.firstChild){
      var p = d.createElement("p");
      p.appendChild(d.createElement("br"));
      f.appendChild(p);
    }
    return f;
  }

  /* ---- DOM -> model. Tolerant on purpose: it reads whatever the browser's own
     editing produced, which is not what toDom wrote — WebKit and Chrome make <b>
     or a font-weight span, <strike> or <s>, a <div> or a <p>, "\n" or <br>,
     depending on the command and the engine. Whatever they make, what is on
     screen is what gets saved.
     mode "live" is our editor; mode "paste" is foreign HTML, where whitespace
     collapses, inline styles count, Google Docs' bold-normal wrapper is undone,
     Word's fake list paragraphs become lists and a page's link underline is not
     the author's underline. */
  var BLOCKS = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|CAPTION|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|ADDRESS|FIGURE|FIGCAPTION|DL|DT|DD|CENTER|FORM|FIELDSET|DETAILS|SUMMARY|LISTING|XMP)$/;
  var SKIP = /^(SCRIPT|STYLE|TEMPLATE|IFRAME|OBJECT|EMBED|VIDEO|AUDIO|CANVAS|SVG|IMG|PICTURE|SOURCE|INPUT|BUTTON|SELECT|OPTION|TEXTAREA|NOSCRIPT|META|LINK|TITLE|HEAD|COLGROUP|COL|MATH)$/;
  var INLINE_EL = /^(SPAN|FONT|MARK|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|SUB|SUP|SMALL|BIG|A|CODE)$/;
  function isClear(c){ return !c || c === "transparent" || c === "initial" || c === "inherit" || c === "unset" || /rgba\([^)]*,\s*0\)$/.test(c); }
  function isWhite(c){ return /^(white|#fff(fff)?|rgb\(255,\s*255,\s*255\))$/i.test(c); }
  function addM(m, k){ return m.indexOf(k) > -1 ? m : m + k; }
  function delM(m, k){ return m.replace(k, ""); }
  function styleOf(el){ return (el.getAttribute && el.getAttribute("style")) || ""; }

  function marksOf(el, ctx, mode){
    var m = ctx.m, a = ctx.a, t = el.nodeName;
    if(t === "B" || t === "STRONG") m = addM(m, "b");
    if(t === "I" || t === "EM" || t === "CITE" || t === "VAR" || t === "DFN") m = addM(m, "i");
    if(t === "U" || t === "INS") m = addM(m, "u");
    if(t === "S" || t === "STRIKE" || t === "DEL") m = addM(m, "s");
    if(t === "MARK") m = addM(m, "h");
    if(t === "CODE" || t === "KBD" || t === "SAMP" || t === "TT") m = addM(m, "c");
    if(t === "A"){ var h = cleanHref(el.getAttribute("href")); if(h) a = h; }
    // the editor's own inline code is a <font face="monospace">; a pasted Courier is code too
    if(t === "FONT" && /mono|courier|consolas|menlo/i.test(el.getAttribute("face") || "")) m = addM(m, "c");
    if(styleOf(el)){
      var st = el.style, fw = st.fontWeight, fs = st.fontStyle;
      var td = st.textDecorationLine || st.textDecoration || "", bg = st.backgroundColor;
      if(fw === "bold" || fw === "bolder" || +fw >= 600) m = addM(m, "b");
      else if(fw === "normal" || fw === "lighter" || (+fw && +fw < 600)) m = delM(m, "b");
      if(fs === "italic" || fs === "oblique") m = addM(m, "i");
      else if(fs === "normal") m = delM(m, "i");
      if(/underline/.test(td)) m = addM(m, "u");
      if(/line-through/.test(td)) m = addM(m, "s");
      if(mode === "live"){
        /* only the colour our own command writes: an engine that copies the page
           background into a span while merging blocks must not invent a highlight */
        if(isHL(bg)) m = addM(m, "h");
        else if(bg && isClear(bg)) m = delM(m, "h");
        /* at the start of a paragraph Chrome inserts <code> as a span carrying
           code's computed style; the editor shows that as code, so it is code */
        if(/monospace/i.test(st.fontFamily || "")) m = addM(m, "c");
      } else {
        // a highlighted word, not a page's panel background
        if(INLINE_EL.test(t) && bg && !isClear(bg) && !isWhite(bg)) m = addM(m, "h");
        if(/mono|courier|consolas|menlo/i.test(st.fontFamily || "")) m = addM(m, "c");
      }
    }
    if(mode !== "live" && a) m = delM(m, "u");
    return { m: m, a: a };
  }

  function Sink(mode){ this.mode = mode; this.lines = [[]]; }
  Sink.prototype.text = function(x, ctx){
    if(this.mode === "paste"){
      // HTML collapses whitespace across neighbouring text, not just within it
      x = x.replace(/[ \t\n\r\f\u00A0]+/g, " ");
      var line = this.lines[this.lines.length - 1], last = line[line.length - 1];
      if(x.charAt(0) === " " && (!last || / $/.test(last.x))) x = x.slice(1);
    }
    else x = x.replace(/\r/g, "").replace(/\u00A0/g, " ");
    var parts = this.mode === "paste" ? [x] : x.split("\n");
    for(var i = 0; i < parts.length; i++){
      if(i) this.br();
      if(parts[i]) this.lines[this.lines.length - 1].push({ x: parts[i], m: ctx.m, a: ctx.a });
    }
  };
  Sink.prototype.raw = function(x, ctx){ this.lines[this.lines.length - 1].push({ x: x, m: ctx.m, a: ctx.a }); };
  Sink.prototype.br = function(){ this.lines.push([]); };
  Sink.prototype.edge = function(){ if(this.lines[this.lines.length - 1].length) this.br(); };
  Sink.prototype.out = function(){
    if(this.mode === "paste") return this.lines.map(trimEdges);
    /* an engine ends a block with one extra <br> or "\n" so its last line has
       height; that one is not a line anyone typed */
    var ls = this.lines.slice();
    if(ls.length > 1 && !ls[ls.length - 1].length) ls.pop();
    return ls;
  };
  Sink.prototype.empty = function(){
    for(var i = 0; i < this.lines.length; i++) if(!blankRuns(this.lines[i])) return false;
    return true;
  };
  function trimEdges(r){
    r = ltrim(r);
    while(r.length && r[r.length - 1].m.indexOf("c") < 0){
      var t = r[r.length - 1].x.replace(/\s+$/, "");
      if(t){ r[r.length - 1] = { x: t, m: r[r.length - 1].m, a: r[r.length - 1].a }; break; }
      r.pop();
    }
    return r;
  }
  function msoIgnore(el){ return /mso-list:\s*ignore/i.test(styleOf(el)); }

  /* everything inside `node` as lines of runs (nested blocks become line breaks) */
  function inlineWalk(node, ctx, sink, onList){
    for(var c = node.firstChild; c; c = c.nextSibling){
      if(c.nodeType === 3){ sink.text(c.nodeValue, ctx); continue; }
      if(c.nodeType !== 1) continue;
      var t = c.nodeName;
      if(SKIP.test(t) || (sink.mode !== "live" && msoIgnore(c))) continue;
      if(t === "BR"){ sink.br(); continue; }
      if((t === "UL" || t === "OL") && onList){ onList(c, ctx); continue; }
      if(t === "LI" && onList && onList.li){ onList.li(c, ctx); continue; }
      if(BLOCKS.test(t)){
        sink.edge();
        if(t === "PRE"){
          preText(c).split("\n").forEach(function(l, i){ if(i) sink.br(); if(l) sink.raw(l, { m: addM(ctx.m, "c"), a: ctx.a }); });
        } else if(t === "TD" || t === "TH"){
          inlineWalk(c, marksOf(c, ctx, sink.mode), sink, onList);
          sink.text(" | ", ctx);
          continue;
        } else inlineWalk(c, marksOf(c, ctx, sink.mode), sink, onList);
        sink.edge();
        continue;
      }
      inlineWalk(c, marksOf(c, ctx, sink.mode), sink, onList);
    }
  }
  /* a <pre>'s text with <br> as a newline, less the one trailing newline an
     engine keeps only so the caret has a last line to sit on */
  function preText(el){
    var out = "";
    (function walk(n){
      for(var c = n.firstChild; c; c = c.nextSibling){
        if(c.nodeType === 3) out += c.nodeValue.replace(/\r/g, "");
        else if(c.nodeType === 1){
          if(c.nodeName === "BR") out += "\n";
          else if(BLOCKS.test(c.nodeName)){ if(out && !/\n$/.test(out)) out += "\n"; walk(c); }
          else if(!SKIP.test(c.nodeName)) walk(c);
        }
      }
    })(el);
    return out.replace(/\n$/, "");
  }
  function listFrom(listEl, d, ctx, mode, items){
    var k = listEl.nodeName === "OL" ? "ol" : "ul";
    var n = parseInt(listEl.getAttribute("start"), 10);
    if(isNaN(n)) n = 1;
    var idx = 0;
    function newItem(li){
      var it = { d: d, k: k, lines: [[]] };
      if(k === "ol") it.n = n + idx;
      idx++;
      if(li){
        var lvl = mode !== "live" ? parseInt(li.getAttribute("aria-level"), 10) : NaN;
        if(lvl > 0) it.d = lvl - 1;
        if(k === "ul"){
          var ck = li.getAttribute("data-task");
          if(ck === "1" || ck === "0") it.ck = ck === "1";
          else if(mode !== "live"){
            var ac = li.getAttribute("aria-checked");
            if(ac === "true" || ac === "false") it.ck = ac === "true";
            var box = li.querySelector && li.querySelector("input[type=checkbox]");
            if(box && box.closest("li") === li) it.ck = !!(box.checked || box.hasAttribute("checked"));
          }
        }
      }
      items.push(it);
      return it;
    }
    for(var c = listEl.firstChild; c; c = c.nextSibling){
      // engines nest an indented list as a sibling of the items, not inside one
      if(c.nodeType === 1 && (c.nodeName === "UL" || c.nodeName === "OL")){ listFrom(c, d + 1, ctx, mode, items); continue; }
      if(c.nodeType === 3 && !c.nodeValue.trim()) continue;
      if(c.nodeType === 1 && SKIP.test(c.nodeName)) continue;
      var it = newItem(c.nodeType === 1 && c.nodeName === "LI" ? c : null);
      var sink = new Sink(mode), cur = it;
      var onList = function(sub, cx){
        cur.lines = sink.out();
        listFrom(sub, d + 1, cx, mode, items);
        cur = { d: d, k: k, lines: [[]] };
        items.push(cur);
        sink = new Sink(mode);
      };
      onList.li = function(li, cx){
        cur.lines = sink.out();
        cur = newItem(li);
        sink = new Sink(mode);
        inlineWalk(li, marksOf(li, cx, mode), sink, onList);
        cur.lines = sink.out();
        cur = { d: d, k: k, lines: [[]] };
        items.push(cur);
        sink = new Sink(mode);
      };
      if(c.nodeType === 3) sink.text(c.nodeValue, ctx);
      else inlineWalk(c, marksOf(c, ctx, mode), sink, onList);
      cur.lines = sink.out();
    }
  }
  function msoLevel(el){
    if(el.nodeType !== 1 || !/^(P|DIV|H[1-6])$/.test(el.nodeName)) return 0;
    var st = styleOf(el), m = /mso-list:[^;"]*?level(\d+)/i.exec(st);
    if(m) return +m[1];
    return /MsoListParagraph/.test(el.className || "") ? 1 : 0;
  }
  function msoOrdered(el){
    var ign = null;
    (function find(n){
      for(var c = n.firstChild; c && !ign; c = c.nextSibling){
        if(c.nodeType === 1){ if(msoIgnore(c)) ign = c; else find(c); }
      }
    })(el);
    var mk = ign ? ign.textContent.replace(/\u00A0/g, " ").trim() : "";
    return /^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]$/.test(mk) ? (parseInt(mk, 10) || 1) : 0;
  }
  /* pasted: a Google Docs, Notes or Gmail paste marks its line breaks as
     margin-less paragraphs or bare divs, and those are one block; an ordinary
     page's paragraphs are separate blocks */
  function tightPaste(el){
    if(el.nodeName === "DIV") return true;
    if(!/^(P|UL|OL)$/.test(el.nodeName)) return false;
    var st = el.style;
    return !!st && st.marginTop !== "" && parseFloat(st.marginTop) === 0 &&
           st.marginBottom !== "" && parseFloat(st.marginBottom) === 0;
  }

  function fromDom(root, mode){
    mode = mode || "live";
    var blocks = [], sink = null, sinkEl = null, blank = 0, mso = null;
    function gapFor(el){
      if(mode === "live"){
        var g = el && el.getAttribute ? el.getAttribute("data-gap") : null;
        return g != null && /^\d{1,2}$/.test(g) ? +g : 1;
      }
      if(blank) return blank;
      return el && tightPaste(el) ? 0 : 1;
    }
    function push(b, el){ b.gap = gapFor(el); blank = 0; mso = null; blocks.push(b); }
    function endPara(){
      if(!sink) return;
      if(mode !== "live" && sink.empty()) blank++;   // an empty paragraph in a paste is a blank line
      else push({ t:"p", lines: sink.out() }, sinkEl);
      sink = null;
    }
    function para(el){ if(!sink){ sink = new Sink(mode); sinkEl = el; } return sink; }
    function walk(node, ctx, owner){
      for(var c = node.firstChild; c; c = c.nextSibling){
        if(c.nodeType === 3){
          if(sink || c.nodeValue.trim() || mode === "live") para(owner).text(c.nodeValue, ctx);
          continue;
        }
        if(c.nodeType !== 1) continue;
        var t = c.nodeName;
        if(SKIP.test(t) || (mode !== "live" && msoIgnore(c))) continue;
        if(t === "BR"){
          if(!sink && mode !== "live") blank++;
          else para(owner).br();
          continue;
        }
        if(mode !== "live" && msoLevel(c)){
          endPara();
          var ms = new Sink(mode);
          inlineWalk(c, marksOf(c, ctx, mode), ms, null);
          var num = msoOrdered(c);
          var item = { d: msoLevel(c) - 1, k: num ? "ol" : "ul", lines: ms.out() };
          if(num) item.n = num;
          if(mso && blocks[blocks.length - 1] === mso){ mso.items.push(item); blank = 0; }
          else { var lb = { t:"list", items: [item] }; push(lb, c); mso = lb; }
          continue;
        }
        if(/^H[1-6]$/.test(t)){
          endPara();
          var hs = new Sink(mode);
          inlineWalk(c, marksOf(c, ctx, mode), hs, null);
          var runs = [];
          hs.out().forEach(function(r, i){ if(i && r.length && runs.length) runs.push({ x:" ", m:"", a:"" }); runs = runs.concat(r); });
          if(blankRuns(normRuns(runs))){ if(mode !== "live") blank++; }
          else push({ t:"h", lv: Math.min(3, +t.charAt(1)), runs: runs }, c);
          continue;
        }
        if(t === "UL" || t === "OL"){
          endPara();
          var items = [];
          listFrom(c, 0, ctx, mode, items);
          push({ t:"list", items: items }, c);
          continue;
        }
        if(t === "BLOCKQUOTE"){
          endPara();
          var qs = new Sink(mode);
          inlineWalk(c, marksOf(c, ctx, mode), qs, function(sub, cx){
            var its = [];
            listFrom(sub, 0, cx, mode, its);
            its.forEach(function(it){
              qs.edge();
              it.lines.forEach(function(r, i){ if(i) qs.br(); qs.lines[qs.lines.length - 1] = qs.lines[qs.lines.length - 1].concat(r); });
            });
            qs.edge();
          });
          push({ t:"quote", lines: qs.out() }, c);
          continue;
        }
        if(t === "PRE"){
          endPara();
          var tx = preText(c);
          push({ t:"code", lang: c.getAttribute("data-lang") || "", code: tx ? tx.split("\n") : [] }, c);
          continue;
        }
        if(t === "HR"){ endPara(); push({ t:"hr" }, c); continue; }
        if(t === "TABLE"){
          endPara();
          var ts = new Sink(mode);
          Array.prototype.forEach.call(c.querySelectorAll("tr"), function(tr){
            ts.edge();
            var cells = [];
            Array.prototype.forEach.call(tr.children, function(td){
              var cs = new Sink(mode);
              inlineWalk(td, marksOf(td, ctx, mode), cs, null);
              cells.push(cs.out().filter(function(r){ return r.length; })
                .reduce(function(a, r){ return a.length ? a.concat([{ x:" ", m:"", a:"" }], r) : r; }, []));
            });
            cells.forEach(function(r, i){
              if(i) ts.text(" | ", { m:"", a:"" });
              ts.lines[ts.lines.length - 1] = ts.lines[ts.lines.length - 1].concat(r);
            });
          });
          push({ t:"p", lines: ts.out() }, c);
          continue;
        }
        if(BLOCKS.test(t)){
          endPara();
          walk(c, marksOf(c, ctx, mode), c);
          endPara();
          continue;
        }
        walk(c, marksOf(c, ctx, mode), owner);   // inline element: transparent, carries its marks
      }
    }
    walk(root, { m:"", a:"" }, null);
    endPara();
    return normDoc(blocks);
  }
  /* foreign HTML, parsed where nothing in it can run or load. A copy out of
     Slate's own editor is marked, and read the way the editor itself is read, so
     its blank lines and tight lines come back exactly. */
  function fromHtml(html){
    var doc = new DOMParser().parseFromString(String(html == null ? "" : html), "text/html");
    var own = doc.body.querySelector("[data-slate-doc]");
    return own ? fromDom(own, "live") : fromDom(doc.body, "paste");
  }

  return {
    parse: parse, serialize: serialize, normDoc: normDoc, normRuns: normRuns, inline: inline,
    plain: plain, plainRuns: plainRuns, plainBlock: plainBlock, units: units, unitText: unitText,
    sectionText: sectionText, toggleTask: toggleTask, runsText: runsText, runsEqual: runsEqual,
    cleanHref: cleanHref,
    renderBlock: renderBlock, inlineInto: inlineInto, toDom: toDom, fromDom: fromDom, fromHtml: fromHtml,
    HL: HL, isHL: isHL
  };
});
