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

// ══════════════════════════════════ 원형별 선호도
/* 값이 클수록 먼저 집음. 0이면 안 집음 (후보 셋 다 0이면 건너뛰기) */
var PREF = {
  도박: {
    critical:15, wormhole:14, align:13, reactor:12, emergency:12, incin:11,
    leak:9, mold:9, coupon:3, hole:8, parasite:7, mastercode:6, ore:3, o2:1,
  },
  성장: {
    hydro:14, larva:12, cargo:11, solar:9, water:8, tool:7,
    coil:6, duct:6, tank:5, o2:3, ration:3,
  },
  안정: {
    aicore:14, ore:12, turbine:11, tank:9, fuel:8, crew:6, navcom:6, nano:6,
    bot:5, ration:4, water:4, coil:4, duct:4, o2:3, oil:3, part:3, solar:2,
  },
  // 조합은 고정표가 아니라 "덱에 짝이 이미 있나"로 점수를 냄 (아래 PARTNERS)
  조합: null,
};

var PARTNERS = {
  ration:['water','crew'], water:['ration','crew','hydro'], crew:['ration','water'],
  part:['bot'], oil:['bot'], bot:['part','oil'],
  cargo:['tool','mastercode'], tool:['cargo'], mastercode:['cargo'],
  mold:['kit','incin'], kit:['mold'], incin:['mold'],
  coil:['coil'], duct:['duct'], larva:['larva'],
  hydro:['water','solar'], solar:['hydro'], o2:['tank'], tank:['o2'],
  reactor:['ore','fuel'], hole:['fuel','ore','leak'], nano:['ore','fuel'],
};

function comboScore(id, deck){
  var ps = PARTNERS[id];
  if (!ps) return 0.5;                       // 짝이 없는 심볼은 최소한만
  var n = 0;
  for (var i=0;i<deck.length;i++)
    if (ps.indexOf(deck[i].id) >= 0) n++;
  return 1 + 2*n;
}

function makePicker(name){
  var table = PREF[name];
  return function(ch, deck){
    var best = -1, bestV = 0;
    for (var i=0;i<ch.length;i++){
      var v = table ? (table[ch[i]] || 0) : comboScore(ch[i], deck);
      if (v > bestV){ bestV = v; best = i; }
    }
    return best;                              // -1이면 건너뛰기
  };
}

/* 정비: 안정·성장·조합은 자기 축에 없는 마이너스 심볼을 버림. 도박은 안 버림 */
function makeTrimmer(name){
  if (name === '도박') return function(){ return null; };
  return function(deck){
    for (var i=0;i<deck.length;i++)
      if (E.SYMBOLS[deck[i].id].base < 0) return deck[i].uid;
    return null;
  };
}

var NAMES = ['도박','조합','성장','안정'];

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
        var ch = E.rollChoices(3, rnd, round);
        var p = pick(ch, state.deck);
        if (p >= 0) state.deck.push(E.mkEntry(ch[p]));
      }
    }

    var due = Math.max(0, cost - E.costCutOf(state.deck, cost));
    tally.tried[round] = (tally.tried[round] || 0) + 1;
    if (coins < due) break;                     // 여기서 표류
    tally.passed[round] = (tally.passed[round] || 0) + 1;

    coins -= due; paid += due;

    var uid = trim(state.deck);
    if (uid != null){
      for (var i=0;i<state.deck.length;i++){
        if (state.deck[i].uid !== uid) continue;
        var sticky = E.SYMBOLS[state.deck[i].id].sticky || 0;
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
var CAP   = 30;

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
var head = '   구역  ';
for (var r=1;r<=10;r++) head += pad(r+'구역', 7);
console.log(head);
for (var n=0; n<NAMES.length; n++){
  var t = res[NAMES[n]].tally;
  var line = '   ' + pad(NAMES[n], 4, true) + '  ';
  for (var r=1;r<=10;r++){
    var tr = t.tried[r] || 0, pa = t.passed[r] || 0;
    line += pad(tr ? Math.round(pa/tr*100) + '%' : '-', 7);
  }
  console.log(line);
}

// ── 도달 구역 / 점수
console.log('\n   원형   도달구역(중앙/평균/상위5%)     점수(중앙/상위5%/최고)');
for (var n=0; n<NAMES.length; n++){
  var d = res[NAMES[n]];
  console.log('   ' + pad(NAMES[n],4,true) + '   ' +
    pad(pct(d.rounds,.5),3) + ' / ' + pad(mean(d.rounds).toFixed(1),5) + ' / ' + pad(pct(d.rounds,.95),3) +
    '            ' +
    pad(pct(d.scores,.5),7) + ' / ' + pad(pct(d.scores,.95),8) + ' / ' + pad(d.scores[d.scores.length-1],9));
}

// ── 원형별로 실제 실린 심볼 (선호표가 의도대로 먹었는지 확인)
console.log('');
for (var n=0; n<NAMES.length; n++){
  var dk = res[NAMES[n]].decks;
  var top = Object.keys(dk).sort(function(a,b){ return dk[b]-dk[a]; }).slice(0, 8);
  console.log('   ' + pad(NAMES[n],4,true) + ' 덱  ' + top.map(function(id){
    return E.SYMBOLS[id].e + E.SYMBOLS[id].n + ' ' + (dk[id]/GAMES).toFixed(1);
  }).join(' · '));
}
