"use strict";
/* ══════════════════════════════════════════════════════════════════
   전략가 시뮬레이터 — "계획하고 빌드업하는 사람"은 어디까지 가나
   ─ 고정 선호표로 두는 원형들과 달리, 매 픽마다 후보를 실제로 덱에 넣고
     몇 스핀 굴려본 뒤(전방탐색) 고른다. 순도·정족수·시너지가 전부
     그 굴림에 반영되므로 따로 점수표를 만들 필요가 없음
   ─ 초반엔 살아남는 값을 집고, 손에 들어온 조각을 보고 축을 정한 뒤
     정비와 🗑️ 폐기 슈트로 축 밖 심볼을 밀어내며 정족수를 채운다
   실행: node sim/strategist.js [판수]
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

/* 축 = 같이 모아야 값이 나오는 심볼 묶음. core는 그 축의 정체성 */
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
function memberOf(axis, id){
  var a = AXES[axis];
  return a.core.indexOf(id) >= 0 ? 2 : a.sup.indexOf(id) >= 0 ? 1 : 0;
}

var LOOK = 6;
/* 덱을 k번 굴려본 평균 산출량. 사본으로만 굴려서 진짜 상태는 안 건드림.
   순도 배수·정족수·시너지가 전부 여기 반영된다 */
function evalDeck(deck, rnd){
  var cells = E.makeCells(), sum = 0;
  for (var i=0;i<LOOK;i++){
    var clone = deck.map(function(e){ return { uid:e.uid, id:e.id, mem:Object.assign({}, e.mem) }; });
    var st = { cells:cells, deck:clone, debt:{ mul:1, add:0 } };
    E.fillCells(cells, clone, rnd);
    sum += E.resolve(st, rnd).total;
  }
  return sum / LOOK;
}

/* 지금 덱이 어느 축에 가장 가까운가. 고점을 노리는 사람은 조각 수만 보지 않고
   "천장이 있는 축"(정족수가 걸린 심볼을 품은 축)에 웃돈을 얹어서 고른다 */
function hasQuorumCore(ax){
  var core = AXES[ax].core;
  for (var k=0;k<core.length;k++) if (E.SYMBOLS[core[k]].quorum) return true;
  return false;
}
function chooseAxis(deck, ceilingBias, onlyQuorum){
  var best = null, bestS = -1;
  for (var i=0;i<AXIS_NAMES.length;i++){
    var ax = AXIS_NAMES[i], sc = 0;
    if (onlyQuorum && !hasQuorumCore(ax)) continue;
    for (var j=0;j<deck.length;j++) sc += memberOf(ax, deck[j].id);
    if (ceilingBias){
      var core = AXES[ax].core;
      for (var k=0;k<core.length;k++) if (E.SYMBOLS[core[k]].quorum) sc += ceilingBias;
    }
    if (sc > bestS){ bestS = sc; best = ax; }
  }
  return best;
}

/* 두 가지 성향
   신중 — 4구역에 축을 정하고, 축 밖도 값이 좋으면 받는다. 덱은 14장 밑으로 안 줄임
   대깨 — 3구역에 정하고 축 밖은 아예 건너뛴다. 덱을 10장까지 깎아 순도를 끌어올림 */
var PROFILES = {
  '신중': { commitAt:4, offAxis:0.75, skipOffAxis:false, floor:14, invest:1.6, ceilingBias:0 },
  '대깨': { commitAt:3, offAxis:0,    skipOffAxis:true,  floor:10, invest:2.6, ceilingBias:2.5 },
  /* 처음부터 "덱을 완성시키겠다"고 정하고 들어가는 쪽.
     시작 덱이 뭘 주든 무시하고 정족수가 걸린 축만 노린다 */
  '완성': { commitAt:2, offAxis:0,    skipOffAxis:true,  floor:10, invest:3.2, ceilingBias:0, onlyQuorum:true },
};

function playOne(rnd, capRound, P){
  var deck = E.START_DECK.map(E.mkEntry), cells = E.makeCells();
  var st = { cells:cells, deck:deck, debt:{ mul:1, add:0 } };
  var coins = 0, paid = 0, round = 1, cost = E.costFor(1), axis = null;

  while (round <= capRound){
    // 3구역까지는 살아남는 값만 보고, 그 다음부터 축을 정해 밀고 간다
    if (round === P.commitAt && !axis) axis = chooseAxis(st.deck, P.ceilingBias, P.onlyQuorum);
    /* 정족수 심볼이 손에 두 장 이상 들어오면 사람은 거기로 갈아탄다.
       뽑기만으로는 6장을 못 모으고 🧫 배양조로 불려야 하므로, 씨앗이 생긴 순간이
       방향을 트는 시점임 */
    if (axis && round >= P.commitAt){
      var cnt={}, i;
      for (i=0;i<st.deck.length;i++) cnt[st.deck[i].id]=(cnt[st.deck[i].id]||0)+1;
      for (i=0;i<AXIS_NAMES.length;i++){
        var ax=AXIS_NAMES[i], core=AXES[ax].core;
        for (var k=0;k<core.length;k++){
          var sy=E.SYMBOLS[core[k]];
          if (sy.quorum && (cnt[core[k]]||0) >= 2 && ax !== axis && !P.onlyQuorum){ axis = ax; break; }
        }
      }
    }

    for (var s=0; s<E.spinsFor(round); s++){
      E.fillCells(cells, st.deck, rnd);
      coins = Math.max(0, coins + E.resolve(st, rnd).total);
      if (s < E.spinsFor(round)-1){
        var ch = E.rollChoices(4, rnd, round, st.deck);
        var best = -1, bestV = evalDeck(st.deck, rnd);      // 안 고르는 것도 후보
        for (var i=0;i<ch.length;i++){
          var v = evalDeck(st.deck.concat([E.mkEntry(ch[i])]), rnd);
          if (axis){
            var m = memberOf(axis, ch[i]);
            /* 축 밖을 전부 쳐내면 덱이 안 커져서 판이 빈다.
               흔함 기본기(산소방울·정제수·식량)는 최소한만 받아둠 */
            if (!m && P.skipOffAxis){
              if (['o2','water','ration'].indexOf(ch[i]) < 0) continue;
              v *= 0.55;
            } else if (!m) v *= P.offAxis;
            if (m) v *= m === 2 ? 1.45 : 1.35;
            if (ch[i] === 'culture' || ch[i] === 'purge') v *= 1.9;   // 복제와 정제가 곧 덱 완성
            /* 정족수 심볼은 문턱을 넘기 전까진 눈앞의 값이 형편없다.
               전방탐색만 믿으면 영영 안 고르게 되므로(국소 최적 함정),
               카드에 적힌 문턱을 읽고 "투자"하는 사람을 흉내냄 */
            var sy = E.SYMBOLS[ch[i]];
            if (m === 2 && sy.quorum){
              var have = 0;
              for (var d=0; d<st.deck.length; d++) if (st.deck[d].id === ch[i]) have++;
              var goal = sy.done || sy.quorum;
              if (have < goal) v *= 1 + P.invest * (1 - have / goal);   // 멀수록 크게 웃돈
            }
          }
          if (v > bestV){ bestV = v; best = i; }
        }
        if (best >= 0) st.deck.push(E.mkEntry(ch[best]));
      }
    }

    var due = Math.max(0, cost - E.costCutOf(st.deck, cost));
    if (coins < due) break;
    coins -= due; paid += due;

    /* 정비: 축 밖 심볼 중 가장 많은 종류를 한 장 밀어냄.
       판(20칸)을 못 채울 만큼 줄이면 손해라 14장 밑으로는 안 건드림 */
    if (st.deck.length > P.floor){
      var cnt = {};
      for (var i=0;i<st.deck.length;i++) cnt[st.deck[i].id] = (cnt[st.deck[i].id]||0)+1;
      var worst = null, wn = 0;
      for (var id in cnt){
        if (axis && memberOf(axis, id) > 0) continue;
        if (cnt[id] > wn){ wn = cnt[id]; worst = id; }
      }
      if (worst) for (var i=0;i<st.deck.length;i++)
        if (st.deck[i].id === worst){ if (rnd() >= (E.SYMBOLS[worst].sticky||0)) st.deck.splice(i,1); break; }
    }

    round++;
    cost = Math.round(E.costFor(round)*st.debt.mul) + st.debt.add;
    st.debt.mul = 1; st.debt.add = 0;
  }
  return { round:round, score:paid+coins, axis:axis, deck:st.deck };
}

function pct(a,p){ var b=a.slice().sort(function(x,y){return x-y;});
  return b[Math.min(b.length-1, Math.floor(b.length*p))]; }
function mean(a){ return a.reduce(function(x,y){return x+y;},0)/(a.length||1); }
function pad(s,n,r){ s=String(s); while(s.length<n) s = r ? s+' ' : ' '+s; return s; }

var GAMES = parseInt(process.argv[2],10) || 300;

Object.keys(PROFILES).forEach(function(pname){
var P = PROFILES[pname];
var rnd = mulberry32(880088);
var rounds=[], scores=[], byAxis={}, quorumHit=0, doneHit=0;

for (var g=0; g<GAMES; g++){
  var o = playOne(rnd, 40, P);
  rounds.push(o.round); scores.push(o.score);
  var a = o.axis || '(미정)';
  (byAxis[a] = byAxis[a] || { n:0, r:[], s:[] });
  byAxis[a].n++; byAxis[a].r.push(o.round); byAxis[a].s.push(o.score);

  // 정족수·완성을 실제로 채웠나
  var cnt={}; o.deck.forEach(function(e){ cnt[e.id]=(cnt[e.id]||0)+1; });
  var hitQ=false, hitD=false;
  for (var id in cnt){
    var sy=E.SYMBOLS[id];
    if (sy.quorum && cnt[id] >= sy.quorum) hitQ=true;
    if (sy.done   && cnt[id] >= sy.done)   hitD=true;
  }
  if (hitQ) quorumHit++;
  if (hitD) doneHit++;
}

console.log('\n══ ' + pname + ' — ' + GAMES + '판 · 전방탐색 ' + LOOK + '스핀 · ' +
            P.commitAt + '구역에 축 확정 · ' + (P.skipOffAxis ? '축 밖은 전부 건너뜀' : '축 밖도 값 좋으면 수용') +
            ' · 덱 하한 ' + P.floor + '장');
console.log('   도달 구역   중앙 ' + pct(rounds,.5) + '   평균 ' + mean(rounds).toFixed(1) +
            '   상위25% ' + pct(rounds,.75) + '   상위5% ' + pct(rounds,.95) + '   최고 ' + pct(rounds,1));
console.log('   점수        중앙 ' + pct(scores,.5).toLocaleString() +
            '   평균 ' + Math.round(mean(scores)).toLocaleString() +
            '   상위25% ' + pct(scores,.75).toLocaleString() +
            '   상위5% ' + pct(scores,.95).toLocaleString() +
            '   최고 ' + pct(scores,1).toLocaleString());
console.log('   정족수를 채운 판 ' + Math.round(quorumHit/GAMES*100) + '%   완성까지 간 판 ' + Math.round(doneHit/GAMES*100) + '%');

console.log('\n   고른 축        판수   중앙 도달   중앙 점수    최고 점수');
Object.keys(byAxis).sort(function(a,b){ return byAxis[b].n - byAxis[a].n; }).forEach(function(a){
  var d = byAxis[a];
  if (d.n < Math.max(3, GAMES*0.02)) return;
  console.log('   ' + pad(a,10,true) + pad(d.n,6) + pad(pct(d.r,.5),10) + '구역' +
              pad(pct(d.s,.5).toLocaleString(),12) + pad(pct(d.s,1).toLocaleString(),13));
});
});
