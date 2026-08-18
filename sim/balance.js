"use strict";
/* ══════════════════════════════════════════════════════════════════
   밸런스 시뮬레이터 — 원형(archetype)별 통과율 비교
   ─ engine.js를 그대로 불러다 게임을 수천 판 돌림. 화면 없이 규칙만 돎
   ─ 전방탐색으로 "잘 두는 플레이어"를 흉내내는 대신, 축 하나만 고집하는
     네 명을 만들어 붙임. 사람이 실제로 잡는 방향이 그렇고,
     "어떤 축이 더 잘 통과하나"를 비교하려면 이쪽이 맞음
       도박   확률·마이너스·저당 계열만
       조합   덱에 짝이 이미 있는 심볼만
       성장   자라거나 쌓이는 심볼만
       안정   기본값 크고 변수 없는 심볼만
   ─ 핵심 지표는 "구역별 통과율" — 그 구역에 도달한 판 중 몇 %가 넘었나
   실행: node sim/balance.js [판수]
   ══════════════════════════════════════════════════════════════════ */

var E = require('../engine.js');

// ══════════════════════════════════ 난수 (시드 고정 — 돌릴 때마다 같은 결과)
function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ══════════════════════════════════ 원형 12종
/* 각 원형은 "이 심볼들만 집는다"로 정의. 값이 클수록 먼저 집고, 0이면 안 집음.
   purge에 적은 종류는 정비 때 통째로 버림 (덱을 자기 축으로 정제하는 동작) */
var ARCH = {
  순수:   { pick:{ o2:20, culture:19, purge:18, lens:14, align:16, antenna:6, tank:8 } },
  자기장: { pick:{ coil:20, culture:19, purge:18, lens:14, align:16, antenna:6 } },
  배관:   { pick:{ duct:20, culture:19, purge:18, lens:14, align:16, turbine:8 } },
  통신:   { pick:{ antenna:20, culture:19, purge:18, lens:14, align:16, navcom:8 } },
  군체:   { pick:{ larva:20, culture:17, purge:16, lens:12, align:14 } },
  온실:   { pick:{ hydro:18, water:15, solar:14, culture:12, crew:6 } },
  오염:   { pick:{ incin:20, kit:18, mold:16, culture:12, reactor:8 }, keepNeg:true },
  정비반: { pick:{ bot:20, part:15, oil:15, culture:12, fuel:6 } },
  밀수:   { pick:{ tool:20, cargo:18, mastercode:20, culture:12 } },
  광맥:   { pick:{ ore:20, drill:18, hole:12, nano:10, culture:12, fuel:6 } },
  증폭:   { pick:{ reactor:20, coolant:18, culture:12, turbine:10, ore:8 } },
  도박:   { pick:{ critical:20, wormhole:18, emergency:16, align:14, leak:9, parasite:8, hole:8, mold:7, o2:5, water:4, ration:4 }, keepNeg:true },
  긴축:   { pick:{ coupon:20, culture:10, o2:6, fuel:6, ration:4, water:4 }, keepNeg:true },
  잡식:   { pick:null },   // 대조군 — 기본값 큰 것만 무작정 집음
};

function greedyBase(id){
  var d = E.SYMBOLS[id];
  return Math.max(0, d.base) + (d.effect ? 3 : 0);
}

function makePicker(name){
  var table = ARCH[name].pick;
  return function(ch, deck){
    var best = -1, bestV = 0;
    for (var i=0;i<ch.length;i++){
      var v = table ? (table[ch[i]] || 0) : greedyBase(ch[i]);
      if (v > bestV){ bestV = v; best = i; }
    }
    return best;                              // -1이면 건너뛰기
  };
}

/* 정비는 구역당 한 장. 자기 축에 없는 종류 중 가장 많은 것에서 한 장을 뺌.
   덱을 한 종류로 모으는 건 🗑️ 폐기 슈트 쪽 일이고, 정비는 응급 처치에 가까움 */
function makeTrimmer(name){
  var table = ARCH[name].pick, keepNeg = ARCH[name].keepNeg;
  return function(deck){
    if (deck.length <= 14) return null;      // 판(20칸)을 못 채울 만큼 줄이면 손해
    var cnt = {};
    for (var i=0;i<deck.length;i++) cnt[deck[i].id] = (cnt[deck[i].id]||0) + 1;
    var worst = null, worstN = 0;
    for (var id in cnt){
      var mine = table ? (table[id] || 0) : 1;
      if (mine > 0) continue;                                  // 내 축이면 안 버림
      if (keepNeg && E.SYMBOLS[id].base < 0) continue;         // 도박·오염은 마이너스를 안고 감
      if (cnt[id] > worstN){ worstN = cnt[id]; worst = id; }
    }
    return worst;
  };
}

var NAMES = Object.keys(ARCH);

// ══════════════════════════════════ 한 판
function playOne(name, rnd, capRound, tally){
  var pick = makePicker(name), trim = makeTrimmer(name);
  var deck  = E.START_DECK.map(E.mkEntry);
  var cells = E.makeCells();
  var state = { cells: cells, deck: deck, debt:{ mul:1, add:0 } };

  var coins = 0, paid = 0, round = 1;
  var cost = E.costFor(1);

  while (round <= capRound){
    var spins = E.spinsFor(round);
    for (var s=0; s<spins; s++){
      E.fillCells(cells, state.deck, rnd);
      coins = Math.max(0, coins + E.resolve(state, rnd).total);
      if (s < spins - 1){
        var ch = E.rollChoices(4, rnd, round);
        var p = pick(ch, state.deck);
        if (p >= 0) state.deck.push(E.mkEntry(ch[p]));
      }
    }

    var due = Math.max(0, cost - E.costCutOf(state.deck, cost));
    tally.tried[round] = (tally.tried[round] || 0) + 1;
    if (coins < due) break;                     // 여기서 표류
    tally.passed[round] = (tally.passed[round] || 0) + 1;

    coins -= due; paid += due;

    var junk = trim(state.deck);
    if (junk != null){
      var sticky = E.SYMBOLS[junk].sticky || 0;
      for (var i=0;i<state.deck.length;i++){
        if (state.deck[i].id !== junk) continue;
        if (rnd() >= sticky) state.deck.splice(i,1);   // 눌어붙는 심볼은 확률로 남음
        break;
      }
    }

    round++;
    cost = Math.round(E.costFor(round) * state.debt.mul) + state.debt.add;
    state.debt.mul = 1; state.debt.add = 0;
  }

  return { round: round, score: paid + coins, deck: state.deck };
}

// ══════════════════════════════════ 통계 도구
function pct(sorted, p){
  if (!sorted.length) return 0;
  var i = Math.min(sorted.length-1, Math.max(0, Math.round((sorted.length-1)*p)));
  return sorted[i];
}
function mean(a){ return a.reduce(function(x,y){ return x+y; }, 0) / (a.length||1); }
function pad(s, n, right){
  s = String(s);
  while (s.length < n) s = right ? s + ' ' : ' ' + s;
  return s;
}

// ══════════════════════════════════ 실행
var GAMES = parseInt(process.argv[2], 10) || 400;
var CAP   = 60;

var res = {};
for (var n=0; n<NAMES.length; n++){
  var name = NAMES[n];
  var rnd = mulberry32(20260818 + n*7919);
  var tally = { tried:{}, passed:{} };
  var rounds = [], scores = [], decks = {};

  for (var g=0; g<GAMES; g++){
    var out = playOne(name, rnd, CAP, tally);
    rounds.push(out.round);
    scores.push(out.score);
    for (var i=0;i<out.deck.length;i++) decks[out.deck[i].id] = (decks[out.deck[i].id]||0)+1;
  }
  rounds.sort(function(a,b){ return a-b; });
  scores.sort(function(a,b){ return a-b; });
  res[name] = { tally:tally, rounds:rounds, scores:scores, decks:decks };
}

// ── 구역별 통과율 (핵심 지표)
console.log('판수 ' + GAMES + ' · 구역별 통과율 (그 구역에 도달한 판 중 넘어간 %)\n');
var head = '   원형     ';
var COLS_R = [1,2,3,4,5,6,8,10,13,16,18,19,20,21,24];
for (var r=0;r<COLS_R.length;r++) head += pad(COLS_R[r], 5);
console.log(head);
for (var n=0; n<NAMES.length; n++){
  var t = res[NAMES[n]].tally;
  var line = '   ' + pad(NAMES[n], 7, true) + ' ';
  for (var k=0;k<COLS_R.length;k++){
    var r = COLS_R[k], tr = t.tried[r] || 0, pa = t.passed[r] || 0;
    line += pad(tr ? Math.round(pa/tr*100) + '%' : '-', 5);
  }
  console.log(line);
}

// ── 도달 구역 / 점수
console.log('\n   원형   도달구역(중앙/평균/상위5%)     점수(중앙/상위5%/최고)');
for (var n=0; n<NAMES.length; n++){
  var d = res[NAMES[n]];
  console.log('   ' + pad(NAMES[n],7,true) + ' ' +
    pad(pct(d.rounds,.5),3) + ' / ' + pad(mean(d.rounds).toFixed(1),5) + ' / ' + pad(pct(d.rounds,.95),3) +
    '            ' +
    pad(pct(d.scores,.5),7) + ' / ' + pad(pct(d.scores,.95),8) + ' / ' + pad(d.scores[d.scores.length-1],9));
}

// ── 원형별로 실제 실린 심볼 (선호표가 의도대로 먹었는지 확인)
console.log('');
for (var n=0; n<NAMES.length; n++){
  var dk = res[NAMES[n]].decks;
  var top = Object.keys(dk).sort(function(a,b){ return dk[b]-dk[a]; }).slice(0, 8);
  console.log('   ' + pad(NAMES[n],7,true) + ' 덱  ' + top.map(function(id){
    return E.SYMBOLS[id].e + E.SYMBOLS[id].n + ' ' + (dk[id]/GAMES).toFixed(1);
  }).join(' · '));
}
