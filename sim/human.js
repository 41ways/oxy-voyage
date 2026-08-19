"use strict";
/* ══════════════════════════════════════════════════════════════════
   사람 모델 시뮬레이터
   ─ 봇(strategist.js)은 후보를 실제로 굴려보고 당장의 기댓값을 정확히 잰다.
     사람은 그걸 못 한다. 대신 카드에 적힌 걸 읽고 계획을 세워 밀고 나간다.
     이 비대칭을 그대로 모델에 넣었다:
       · 전방탐색 없음 — 기본값, 짝이 덱에 있나, 이미 몇 장 모았나로 어림
       · 큰 숫자에 혹한다 (설명에 세 자리 수가 보이면 과대평가)
       · 마이너스 기본값을 꺼린다
       · 정족수가 적힌 심볼은 한 장이라도 있으면 목표로 삼는다
       · 한 번 정한 축을 웬만해선 안 바꾼다 (구역마다 12%만 재고)
       · 판단에 편차가 있다 (같은 후보도 ±30%)
   ─ 두 성향: 안정 지향 / 고점 지향
   실행: node sim/human.js [판수] [편향들...]
   ══════════════════════════════════════════════════════════════════ */
var E = require('../engine.js');

function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var AXES = {
  '순수':   { core:['o2'],                 sup:['tank','culture','purge','lens','align','antenna'] },
  '자기장': { core:['coil','anchor'],      sup:['culture','purge','lens','align'] },
  '배관':   { core:['duct','turbine'],     sup:['culture','purge','leak','lens'] },
  '통신':   { core:['antenna','radio','booster'], sup:['navcom','culture','purge','aicore'] },
  '군체':   { core:['larva','alien'],      sup:['pill','culture','purge','parasite'] },
  '온실':   { core:['hydro','bud','bloom'],sup:['water','solar','crew','culture'] },
  '오염':   { core:['mold','incin','kit'], sup:['extin','reactor','purge','culture'] },
  '정비반': { core:['bot','part','oil'],   sup:['fuel','culture','purge'] },
  '밀수':   { core:['cargo','tool','hook','mastercode'], sup:['culture','purge'] },
  '광맥':   { core:['ore','drill'],        sup:['hole','nano','fuel','culture'] },
  '증폭':   { core:['reactor','coolant'],  sup:['ore','turbine','culture','purge'] },
  '웜홀':   { core:['wormhole'],           sup:['lens','culture','purge','align'] },
  '동물':   { core:['rat','cat','dog'],    sup:['crew','pill','culture','turtle'] },
  '다양성': { core:['scope','prism'],      sup:['lens','fuel','ore','navcom'] },
  '저당':   { core:['critical','emergency'],sup:['coupon','coolant','culture','ore'] },
};
var AXIS_NAMES = Object.keys(AXES);
function memberOf(ax, id){
  var a = AXES[ax];
  return a.core.indexOf(id) >= 0 ? 2 : a.sup.indexOf(id) >= 0 ? 1 : 0;
}
var BIGNUM = /\d{3,}/;                       // 설명에 세 자리 수 = 눈에 확 띄는 심볼

/* 두 성향의 차이는 "카드를 어떻게 읽느냐"에 있다
     bignum      설명에 큰 숫자가 보일 때 얼마나 혹하나
     riskShy     마이너스 기본값을 얼마나 꺼리나 (낮을수록 회피)
     quorumPull  문턱이 적힌 카드를 목표로 삼는 강도
     offAxis     정한 축 밖 카드를 얼마나 깎아 보나 (낮을수록 완고)          */
var PROFILES = {
  '안정 지향': { bignum:1.00, riskShy:0.15, quorumPull:0.85, commitAt:4, offAxis:0.90, spread:0.30, floor:16 },
  '고점 지향': { bignum:2.20, riskShy:1.00, quorumPull:3.00, commitAt:3, offAxis:0.25, spread:0.35, floor:11 },
};

function humanScore(id, deck, axis, P, rnd, own){
  var s = E.SYMBOLS[id];
  var v = Math.max(0, s.base) + 2;

  var rel = E.relatedOf(id).ids, partners = 0;
  for (var i=0;i<deck.length;i++) if (rel.indexOf(deck[i].id) >= 0) partners++;
  v += Math.min(partners, 6) * 1.3;          // 짝이 이미 있으면 좋아 보인다
  v += Math.min(own, 8) * 1.1;               // 모으던 걸 계속 모은다 (순도 감각)

  if (BIGNUM.test(s.d)) v *= P.bignum;       // 큰 숫자에 혹함
  if (s.base < 0)       v *= P.riskShy;      // 마이너스는 꺼림
  if (s.quorum){                             // 문턱이 적힌 카드는 목표가 된다
    var goal = s.done || s.quorum;
    v *= own > 0 ? P.quorumPull : 1.15;
    if (own >= goal) v *= 0.8;               // 다 채웠으면 관심이 식음
  }
  if (axis){
    var m = memberOf(axis, id);
    v *= m === 2 ? 1.7 : m === 1 ? 1.3 : P.offAxis;
  }
  return v * (1 - P.spread + 2*P.spread*rnd());
}

function chooseAxis(deck){
  var best=null, bestS=-1;
  for (var i=0;i<AXIS_NAMES.length;i++){
    var ax=AXIS_NAMES[i], sc=0;
    for (var j=0;j<deck.length;j++) sc += memberOf(ax, deck[j].id);
    if (sc > bestS){ bestS=sc; best=ax; }
  }
  return best;
}

function playOne(P, rnd, cap){
  var deck = E.START_DECK.map(E.mkEntry), cells = E.makeCells();
  var st = { cells:cells, deck:deck, debt:{ mul:1, add:0 } };
  var coins=0, paid=0, round=1, cost=E.costFor(1), axis=null;

  while (round <= cap){
    if (round === P.commitAt && !axis) axis = chooseAxis(st.deck);
    else if (axis && rnd() < 0.12) axis = chooseAxis(st.deck);   // 가끔만 재고

    for (var s=0; s<E.spinsFor(round); s++){
      E.fillCells(cells, st.deck, rnd);
      coins = Math.max(0, coins + E.resolve(st, rnd).total);
      if (s < E.spinsFor(round)-1){
        var ch = E.rollChoices(4, rnd, round, st.deck);
        var own = {};
        for (var d=0; d<st.deck.length; d++) own[st.deck[d].id] = (own[st.deck[d].id]||0)+1;
        var best=-1, bestV=6;                                   // 이보다 못하면 그냥 넘김
        for (var i=0;i<ch.length;i++){
          var v = humanScore(ch[i], st.deck, axis, P, rnd, own[ch[i]]||0);
          if (v > bestV){ bestV=v; best=i; }
        }
        if (best >= 0) st.deck.push(E.mkEntry(ch[best]));
      }
    }

    var due = Math.max(0, cost - E.costCutOf(st.deck, cost));
    if (coins < due) break;
    coins -= due; paid += due;

    if (st.deck.length > P.floor){                              // 정비: 축 밖 최다 종류 한 장
      var cnt={};
      for (var i=0;i<st.deck.length;i++) cnt[st.deck[i].id]=(cnt[st.deck[i].id]||0)+1;
      var worst=null, wn=0;
      for (var id in cnt){
        if (axis && memberOf(axis,id) > 0) continue;
        if (E.SYMBOLS[id].quorum && cnt[id] > 0) continue;       // 모으던 문턱 심볼은 안 버림
        if (cnt[id] > wn){ wn=cnt[id]; worst=id; }
      }
      if (worst) for (var i=0;i<st.deck.length;i++)
        if (st.deck[i].id===worst){ if (rnd() >= (E.SYMBOLS[worst].sticky||0)) st.deck.splice(i,1); break; }
    }

    round++;
    cost = Math.round(E.costFor(round)*st.debt.mul) + st.debt.add;
    st.debt.mul=1; st.debt.add=0;
  }

  var cnt={}; st.deck.forEach(function(e){ cnt[e.id]=(cnt[e.id]||0)+1; });
  var q=false, dn=false;
  for (var id in cnt){
    var sy=E.SYMBOLS[id];
    if (sy.quorum && cnt[id] >= sy.quorum) q=true;
    if (sy.done   && cnt[id] >= sy.done)   dn=true;
  }
  return { round:round, score:paid+coins, axis:axis, q:q, dn:dn };
}

function pct(a,p){ var b=a.slice().sort(function(x,y){return x-y;}); return b[Math.min(b.length-1,Math.floor(b.length*p))]; }
function mean(a){ return a.reduce(function(x,y){return x+y;},0)/(a.length||1); }
function pad(s,n,r){ s=String(s); while(s.length<n) s = r ? s+' ' : ' '+s; return s; }

var GAMES = parseInt(process.argv[2],10) || 400;
var BIASES = process.argv.slice(3).map(Number);
if (!BIASES.length) BIASES = [5.0];

console.log('사람 모델 ' + GAMES + '판 · 전방탐색 없음, 카드를 읽고 계획으로 두는 쪽\n');
console.log(' 문턱편향 성향        중앙구역  평균구역  중앙점수   상위25%    상위5%     최고      정족수  완성');
BIASES.forEach(function(b){
  E.setQuorumBias(b);
  Object.keys(PROFILES).forEach(function(pn){
    var P=PROFILES[pn], rnd=mulberry32(4242), R=[],S=[],q=0,dn=0;
    for (var g=0; g<GAMES; g++){
      var o=playOne(P, rnd, 45);
      R.push(o.round); S.push(o.score); if(o.q) q++; if(o.dn) dn++;
    }
    console.log('  ' + pad(b.toFixed(1),5) + '   ' + pad(pn,10,true) +
      pad(pct(R,.5),8) + pad(mean(R).toFixed(1),10) +
      pad(pct(S,.5).toLocaleString(),10) + pad(pct(S,.75).toLocaleString(),10) +
      pad(pct(S,.95).toLocaleString(),10) + pad(pct(S,1).toLocaleString(),11) +
      pad(Math.round(q/GAMES*100)+'%',8) + pad(Math.round(dn/GAMES*100)+'%',6));
  });
});
