"use strict";
/* ══════════════════════════════════════════════════════════════════
   밸런스 시뮬레이터
   ─ engine.js를 그대로 불러다 게임을 수천 판 돌려봄. 화면 없이 규칙만 돎
   ─ 보는 것
       1) 도달 구역 분포 — 실력/전략별로 얼마나 벌어지나
       2) 점수 분포 — 중앙값 대비 상위 5%가 얼마나 튀나 (극고점 여지)
       3) 최종 덱 구성 — 다들 같은 덱으로 수렴하면 다양성이 없는 것
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

// 리스크 축 심볼 — 겜블러가 일부러 챙기는 것들
var RISKY = ['mold','leak','reactor','wormhole','critical','emergency','hole','parasite','coupon'];

// ══════════════════════════════════ 덱 평가 (전방 탐색)
/* 덱을 k번 굴려본 평균 산출량. 사본으로만 굴려서 진짜 상태는 안 건드림 */
function evalDeck(deck, k, rnd){
  var cells = E.makeCells(), sum = 0;
  for (var i=0;i<k;i++){
    var clone = deck.map(function(e){
      return { uid:e.uid, id:e.id, mem:Object.assign({}, e.mem) };
    });
    var st = { cells: cells, deck: clone, debt:{ mul:1, add:0 }, cost: EVAL_COST };
    E.fillCells(cells, clone, rnd);
    sum += E.resolve(st, rnd).total;
  }
  return sum / k;
}

// ══════════════════════════════════ 전략
/* pick(choices, deck, rnd) -> 고를 인덱스 (-1이면 건너뛰기)
   trim(deck, rnd)          -> 버릴 uid (null이면 그냥 두기)              */
var LOOK = 6;        // 전방 탐색 스핀 수
var EVAL_COST = 0;   // 전방 탐색 시점의 구역 소모량 (비상 배급이 여기 비례)

var STRATS = {
  // 아무거나 집는 초보
  random: {
    pick: function(ch, deck, rnd){ return Math.floor(rnd()*ch.length); },
    trim: function(){ return null; },
  },

  // 매번 실제로 굴려보고 제일 많이 버는 걸 고르는 최적화 플레이어
  greedy: {
    pick: function(ch, deck, rnd){
      var best = -1, bestV = evalDeck(deck, LOOK, rnd);   // 안 고르는 것도 후보
      for (var i=0;i<ch.length;i++){
        var v = evalDeck(deck.concat([E.mkEntry(ch[i])]), LOOK, rnd);
        if (v > bestV){ bestV = v; best = i; }
      }
      return best;
    },
    trim: function(deck, rnd){
      var base = evalDeck(deck, LOOK, rnd), bestUid = null, bestV = base;
      var seen = {};
      for (var i=0;i<deck.length;i++){
        if (seen[deck[i].id]) continue;
        seen[deck[i].id] = 1;
        var cut = deck.slice(); cut.splice(i,1);
        var v = evalDeck(cut, LOOK, rnd);
        if (v > bestV){ bestV = v; bestUid = deck[i].uid; }
      }
      return bestUid;
    },
  },

  // 마이너스 심볼은 아예 안 받고, 있으면 버리는 안정 지향
  safe: {
    pick: function(ch, deck, rnd){
      var best = -1, bestV = evalDeck(deck, LOOK, rnd);
      for (var i=0;i<ch.length;i++){
        if (E.SYMBOLS[ch[i]].base < 0) continue;
        var v = evalDeck(deck.concat([E.mkEntry(ch[i])]), LOOK, rnd);
        if (v > bestV){ bestV = v; best = i; }
      }
      return best;
    },
    trim: function(deck, rnd){
      for (var i=0;i<deck.length;i++)
        if (E.SYMBOLS[deck[i].id].base < 0) return deck[i].uid;
      return STRATS.greedy.trim(deck, rnd);
    },
  },

  // 폭발력에 웃돈을 얹어 고르는 한탕형. 위험 심볼을 안 버림
  gamble: {
    pick: function(ch, deck, rnd){
      var best = -1, bestV = evalDeck(deck, LOOK, rnd) * 1.05;
      for (var i=0;i<ch.length;i++){
        var v = evalDeck(deck.concat([E.mkEntry(ch[i])]), LOOK, rnd);
        if (RISKY.indexOf(ch[i]) >= 0) v *= 1.35;
        if (v > bestV){ bestV = v; best = i; }
      }
      return best;
    },
    trim: function(deck, rnd){
      var bestUid = STRATS.greedy.trim(deck, rnd);
      if (bestUid == null) return null;
      for (var i=0;i<deck.length;i++)
        if (deck[i].uid === bestUid && RISKY.indexOf(deck[i].id) >= 0) return null;
      return bestUid;
    },
  },

  // 곰팡이를 일부러 키우고 소각로로 태우는 조합 — 이 원형이 성립하는지 확인용
  moldfarm: {
    pick: function(ch, deck, rnd){
      var FARM = ['mold','incin','kit','reactor'];
      var best = -1, bestV = evalDeck(deck, LOOK, rnd) * 1.05;
      for (var i=0;i<ch.length;i++){
        var v = evalDeck(deck.concat([E.mkEntry(ch[i])]), LOOK, rnd);
        if (FARM.indexOf(ch[i]) >= 0) v *= 1.6;
        if (v > bestV){ bestV = v; best = i; }
      }
      return best;
    },
    trim: function(deck, rnd){
      var uid = STRATS.greedy.trim(deck, rnd);
      if (uid == null) return null;
      for (var i=0;i<deck.length;i++)
        if (deck[i].uid === uid && deck[i].id === 'mold') return null;   // 곰팡이는 안 버림
      return uid;
    },
  },

  // 외계 알을 모아 👾 무리를 만드는 장기 투자형 — 원형이 성립하는지 확인용
  swarm: {
    pick: function(ch, deck, rnd){
      var best = -1, bestV = evalDeck(deck, LOOK, rnd) * 1.05;
      for (var i=0;i<ch.length;i++){
        var v = evalDeck(deck.concat([E.mkEntry(ch[i])]), LOOK, rnd);
        if (ch[i] === 'larva') v *= 2.2;
        if (v > bestV){ bestV = v; best = i; }
      }
      return best;
    },
    trim: function(deck, rnd){
      var uid = STRATS.greedy.trim(deck, rnd);
      if (uid == null) return null;
      for (var i=0;i<deck.length;i++)
        if (deck[i].uid === uid && (deck[i].id === 'larva' || deck[i].id === 'alien')) return null;
      return uid;
    },
  },
};

// ══════════════════════════════════ 한 판
function playOne(strat, rnd, capRound){
  var deck  = E.START_DECK.map(E.mkEntry);
  var cells = E.makeCells();
  var state = { cells: cells, deck: deck, debt:{ mul:1, add:0 } };

  var coins = 0, paid = 0, round = 1;
  var cost = E.costFor(1);
  var peakSpin = 0;

  while (round <= capRound){
    var spins = E.spinsFor(round);
    state.cost = cost; EVAL_COST = cost;
    for (var s=0; s<spins; s++){
      E.fillCells(cells, state.deck, rnd);
      var res = E.resolve(state, rnd);
      if (res.total > peakSpin) peakSpin = res.total;
      coins = Math.max(0, coins + res.total);
      if (s < spins - 1){
        var ch = E.rollChoices(3, rnd, round);
        var pick = strat.pick(ch, state.deck, rnd);
        if (pick >= 0) state.deck.push(E.mkEntry(ch[pick]));
      }
    }

    var due = Math.max(0, cost - E.costCutOf(state.deck));
    if (coins < due) break;                       // 여기서 표류
    coins -= due; paid += due;

    var uid = strat.trim(state.deck, rnd);
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

  return { round: round, score: paid + coins, deck: state.deck, peakSpin: peakSpin };
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
var GAMES = parseInt(process.argv[2], 10) || 300;
var CAP   = 40;   // 무한 루프 방지용 상한

console.log('판수 ' + GAMES + ' / 전략별\n');

var deckTally = {};   // 전략 → 심볼 → 최종 덱에 있던 총 장수
var names = Object.keys(STRATS);

for (var n=0; n<names.length; n++){
  var name = names[n];
  var rnd = mulberry32(20260818 + n*7919);
  var rounds = [], scores = [], peaks = [];
  deckTally[name] = {};

  for (var g=0; g<GAMES; g++){
    var out = playOne(STRATS[name], rnd, CAP);
    rounds.push(out.round);
    scores.push(out.score);
    peaks.push(out.peakSpin);
    for (var i=0;i<out.deck.length;i++){
      var id = out.deck[i].id;
      deckTally[name][id] = (deckTally[name][id] || 0) + 1;
    }
  }

  rounds.sort(function(a,b){ return a-b; });
  scores.sort(function(a,b){ return a-b; });
  peaks.sort(function(a,b){ return a-b; });

  console.log('── ' + name);
  console.log('   도달 구역   중앙 ' + pad(pct(rounds,.5),3) + '   평균 ' + pad(mean(rounds).toFixed(1),5) +
              '   하위25% ' + pad(pct(rounds,.25),3) + '   상위5% ' + pad(pct(rounds,.95),3) +
              '   최고 ' + pad(rounds[rounds.length-1],3));
  console.log('   점수        중앙 ' + pad(pct(scores,.5),8) + '   평균 ' + pad(Math.round(mean(scores)),8) +
              '   상위5% ' + pad(pct(scores,.95),9) + '   최고 ' + pad(scores[scores.length-1],10));
  console.log('   최대 스핀   중앙 ' + pad(pct(peaks,.5),6) + '   상위5% ' + pad(pct(peaks,.95),7));

  // 도달 구역 히스토그램
  var hist = {};
  for (var k=0;k<rounds.length;k++) hist[rounds[k]] = (hist[rounds[k]]||0)+1;
  var line = '   분포        ';
  Object.keys(hist).sort(function(a,b){ return a-b; }).forEach(function(r){
    line += r + '구역:' + Math.round(hist[r]/GAMES*100) + '%  ';
  });
  console.log(line);

  // 최종 덱에서 자주 보인 심볼 (판당 평균 장수)
  var tal = deckTally[name];
  var top = Object.keys(tal).sort(function(a,b){ return tal[b]-tal[a]; }).slice(0, 10);
  console.log('   덱 상위     ' + top.map(function(id){
    return E.SYMBOLS[id].e + E.SYMBOLS[id].n + ' ' + (tal[id]/GAMES).toFixed(1);
  }).join(' · '));
  console.log('');
}

// ══════════════════════════════════ 심볼별 채택률
/* 어떤 심볼이 아무도 안 고르는지 = 죽은 심볼. 다양성 점검용 */
console.log('── 심볼 채택률 (greedy 기준, 판당 평균 장수)');
var tg = deckTally.greedy || {};
var all = Object.keys(E.SYMBOLS).filter(function(id){ return !E.SYMBOLS[id].noOffer; });
all.sort(function(a,b){ return (tg[b]||0) - (tg[a]||0); });
var rows = all.map(function(id){
  var v = (tg[id]||0)/GAMES;
  return pad(E.SYMBOLS[id].e + E.SYMBOLS[id].n, 16, true) + pad(v.toFixed(2), 6) +
         '  ' + pad(E.RARITY[E.SYMBOLS[id].r].label, 4, true);
});
for (var i=0;i<rows.length;i+=2) console.log('   ' + pad(rows[i], 30, true) + '   ' + (rows[i+1]||''));
