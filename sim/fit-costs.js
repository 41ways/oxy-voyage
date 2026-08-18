"use strict";
/* ══════════════════════════════════════════════════════════════════
   소모량 곡선 역산기
   ─ "구역별 탈락률을 일정하게" 만들려면, 소모량을 그 구역 정산 직전
     산소 분포의 같은 백분위에 놓으면 된다. 소모량 = p15면 15%가 탈락.
   ─ 다만 남은 산소가 다음 구역으로 넘어가므로 자기참조라, 몇 번 돌려 수렴시킴.
   실행: node sim/fit-costs.js [목표탈락률%] [판수] [반복]
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

var ARCH = {
  순수:{ o2:20, culture:19, purge:18, lens:14, align:16, antenna:6, tank:8 },
  자기장:{ coil:20, culture:19, purge:18, lens:14, align:16, antenna:6 },
  배관:{ duct:20, culture:19, purge:18, lens:14, align:16, turbine:8 },
  통신:{ antenna:20, culture:19, purge:18, lens:14, align:16, navcom:8 },
  군체:{ larva:20, culture:17, purge:16, lens:12, align:14 },
  온실:{ hydro:18, water:15, solar:14, culture:12, crew:6 },
  오염:{ incin:20, kit:18, mold:16, culture:12, reactor:8 },
  정비반:{ bot:20, part:15, oil:15, culture:12, fuel:6 },
  밀수:{ tool:20, cargo:18, mastercode:20, culture:12 },
  광맥:{ ore:20, drill:18, hole:12, nano:10, culture:12, fuel:6 },
  증폭:{ reactor:20, coolant:18, culture:12, turbine:10, ore:8 },
  도박:{ critical:20, wormhole:18, emergency:16, align:14, leak:9, parasite:8, hole:8, mold:7, o2:5, water:4, ration:4 },
  긴축:{ coupon:20, culture:10, o2:6, fuel:6, ration:4, water:4 },
  잡식:null,
};
var NAMES = Object.keys(ARCH);
function greedyBase(id){ var d=E.SYMBOLS[id]; return Math.max(0,d.base) + (d.effect?3:0); }

/* 한 판. 각 구역 정산 직전의 보유 산소를 기록해서 돌려줌 */
function playOne(table, rnd, bank, capRound){
  var deck = E.START_DECK.map(E.mkEntry), cells = E.makeCells();
  var st = { cells:cells, deck:deck, debt:{ mul:1, add:0 } };
  var coins = 0, round = 1, cost = E.costFor(1);

  while (round <= capRound){
    for (var s=0; s<E.spinsFor(round); s++){
      E.fillCells(cells, st.deck, rnd);
      coins = Math.max(0, coins + E.resolve(st, rnd).total);
      if (s < E.spinsFor(round)-1){
        var ch = E.rollChoices(3, rnd, round), best=-1, bv=0;
        for (var i=0;i<ch.length;i++){
          var v = table ? (table[ch[i]]||0) : greedyBase(ch[i]);
          if (v > bv){ bv = v; best = i; }
        }
        if (best >= 0) st.deck.push(E.mkEntry(ch[best]));
      }
    }
    var due = Math.max(0, cost - E.costCutOf(st.deck, cost));
    (bank[round] = bank[round] || []).push(coins);      // 정산 직전 잔고
    if (coins < due) break;
    coins -= due;

    if (st.deck.length > 14){                            // 정비 한 장
      var cnt = {};
      for (var i=0;i<st.deck.length;i++) cnt[st.deck[i].id] = (cnt[st.deck[i].id]||0)+1;
      var worst=null, wn=0;
      for (var id in cnt){
        if (table ? (table[id]||0) > 0 : false) continue;
        if (cnt[id] > wn){ wn = cnt[id]; worst = id; }
      }
      if (worst) for (var i=0;i<st.deck.length;i++)
        if (st.deck[i].id === worst){ if (rnd() >= (E.SYMBOLS[worst].sticky||0)) st.deck.splice(i,1); break; }
    }
    round++;
    cost = Math.round(E.costFor(round)*st.debt.mul) + st.debt.add;
    st.debt.mul = 1; st.debt.add = 0;
  }
  return round;
}

function quantile(arr, q){
  if (!arr.length) return null;
  var a = arr.slice().sort(function(x,y){ return x-y; });
  return a[Math.min(a.length-1, Math.max(0, Math.floor(a.length*q)))];
}

var DROP  = (parseFloat(process.argv[2]) || 15) / 100;   // 목표 탈락률
var GAMES = parseInt(process.argv[3], 10) || 250;
var ITERS = parseInt(process.argv[4], 10) || 4;
var FIT_FROM = 8;    // 1~7구역은 손대지 않음 (초반 관문은 따로 설계한 값)
var CAP = 34;

for (var it=1; it<=ITERS; it++){
  var bank = {}, reached = {};
  for (var n=0;n<NAMES.length;n++){
    var rnd = mulberry32(31337 + n*7919 + it*101);
    for (var g=0; g<GAMES; g++){
      var r = playOne(ARCH[NAMES[n]], rnd, bank, CAP);
      reached[r] = (reached[r]||0)+1;
    }
  }
  // 잔고 분포의 목표 백분위로 소모량을 다시 놓음
  var prev = E.COSTS[FIT_FROM-2];
  for (var r=FIT_FROM; r<=CAP; r++){
    var b = bank[r];
    if (!b || b.length < 30) break;                        // 표본이 얇으면 중단
    var want = quantile(b, DROP);
    if (want == null) break;
    want = Math.max(want, Math.round(prev*1.05));           // 반드시 오르게
    var cur = E.COSTS[r-1] || prev*1.2;
    var next = Math.round((cur*0.45 + want*0.55) / 10) * 10;  // 진동 억제용 완화
    E.COSTS[r-1] = next;
    prev = next;
  }
  for (var r=CAP+1; r<=40; r++) E.COSTS[r-1] = Math.round(E.COSTS[r-2]*1.25/10)*10;
}

// ── 결과 확인
var bank = {}, tot = {};
for (var n=0;n<NAMES.length;n++){
  var rnd = mulberry32(555 + n*7919);
  for (var g=0; g<GAMES*2; g++) playOne(ARCH[NAMES[n]], rnd, bank, CAP);
}
console.log('목표 탈락률 ' + Math.round(DROP*100) + '% · 구역별 실제 탈락률\n');
console.log('   구역   소모량     도달판수   탈락률');
for (var r=1; r<=28; r++){
  var b = bank[r]; if (!b || !b.length) break;
  var cost = E.costFor(r);
  var fail = 0;
  for (var i=0;i<b.length;i++) if (b[i] < cost) fail++;
  console.log('   ' + String(r).padStart(3) + '  ' + String(cost).padStart(8) +
              String(b.length).padStart(11) + '   ' + (fail/b.length*100).toFixed(0).padStart(3) + '%' +
              '   ' + '█'.repeat(Math.round(fail/b.length*40)));
}
console.log('\nvar COSTS = [');
for (var i=0;i<30;i+=10)
  console.log('  ' + E.COSTS.slice(i,i+10).join(', ') + ',');
console.log('];');
