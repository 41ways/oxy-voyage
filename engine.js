"use strict";
/* ══════════════════════════════════════════════════════════════════
   우주탐험 — 규칙 엔진
   ─ 심볼 테이블과 점수 판정만 들어있음. DOM을 하나도 안 씀.
     브라우저(index.html)와 밸런스 시뮬레이터(sim/balance.js)가 같이 씀 —
     둘이 다른 규칙으로 도는 걸 막으려고 파일을 하나로 유지함
   변경내역
     v0.2  index.html에서 규칙만 떼어냄, 보통/희귀/전설 등급 추가
     v0.3  시뮬레이션(sim/balance.js) 결과로 수치 조정 —
           되먹임 제거(비상 배급), 배수 겹침 천장, 희귀도 램프 상한,
           소각로·만능공구 사거리 확대, 임시 배관 강화
   ══════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════ 판 크기
var COLS = 5, ROWS = 4, CELLS = COLS * ROWS;
var LARVA_HATCH = 4;      // 외계 알이 부화하기까지 등장해야 하는 횟수
var HYDRO_MAX = 7;        // 수경재배가 자랄 수 있는 한계
var SPIN_MUL_CAP = 3;     // 스핀 총합 배수 천장 (임계 반응이 겹쳐서 지수로 터지는 걸 막음)

var RARITY = {
  common:   { label:'흔함', weight:60, color:'var(--common)' },
  uncommon: { label:'보통', weight:27, color:'var(--uncommon)' },
  rare:     { label:'희귀', weight:10, color:'var(--rare)' },
  legend:   { label:'전설', weight:3,  color:'var(--legend)' },
};

/* 구역별 생명유지 소모량.
   설계는 "스핀당 얼마를 뽑아야 하나"에서 역산했음 —
     구역 1  17/스핀   시작 덱(12장)이 대충 16쯤 뽑으니 픽을 잘해야 겨우 넘어감
     구역 5  85/스핀   기본 시너지만으론 부족. 조합 하나는 완성돼야 함
     구역 10 350/스핀  배수·파괴 계열 없이는 불가능
     구역 15 1130/스핀 위험한 심볼을 안고 가야 나오는 숫자
   앞구간은 배수를 크게(1.7), 중반은 완만하게(1.25) — 덱이 복리로 세지는데
   초반엔 그 복리가 아직 안 걸려서.
   표 끝(20구역) 이후는 1.32배씩. 여기까지 온 덱은 배수 계열이 겹쳐 있어서
   완만하게 두면 영영 안 끝남 — 실제로 1.26배로 뒀더니 41구역 상한까지 갔음 */
var COSTS = [
  100, 170, 300, 430, 680, 920, 1400, 1850, 2700, 3500,
  4500, 5700, 7200, 9000, 11300, 14000, 17500, 22000, 27500, 34500,
];
function costFor(r){
  return r <= COSTS.length
    ? COSTS[r-1]
    : Math.round(COSTS[COSTS.length-1] * Math.pow(1.32, r - COSTS.length));
}
// 스핀 수는 2구역마다 하나씩 늘려주되 10에서 멈춤
function spinsFor(r){ return Math.min(6 + Math.floor((r-1)/2), 10); }

// ══════════════════════════════════ 심볼 테이블
/*
  effect(c) 안에서 쓸 수 있는 것들:
    c.self            지금 칸
    c.adj(...ids)     인접 8칸 중 살아있는 심볼 (id 주면 필터)
    c.all(...ids)     판 전체
    c.row() / c.col() 같은 행/열 (자기 제외)
    c.emptyAdj()      인접한 빈칸 개수
    c.deck            화물칸 배열 (읽기용)
    c.cells           판 전체 칸 배열 (읽기용)
    c.link(t)         연출용으로 칸을 묶음 (조회 계열은 자동)
    c.addSelf(n)      자기 값 증가
    c.add(cell, n)    남의 값 증가
    c.mul(cell, m)    남의 값 배수
    c.kill(cell)      파괴 — 값 0 + 화물칸에서 영구 제거
    c.morph(cell,id)  다른 심볼로 변신
    c.gain(n)         칸과 무관하게 산소 직접 획득
    c.spinMul(m)      이번 스핀 총합에 배수 (전체 천장 3배)
    c.debt({mul,add}) 다음 구역 소모량에 빚을 남김
    c.deckAdd(id)     화물칸에 심볼 추가
    c.rand()          0~1 난수
    c.note(msg)       항해일지에 한 줄
  실행은 왼쪽 위부터 순서대로. 그래서 "먼저 죽으면 효과 못 씀"이 성립함

  부가 필드
    baseOf(entry)   기본값이 인스턴스마다 다를 때 (자라는 것)
    badge(entry)    칸 좌상단에 띄울 짧은 글자 (남은 턴, 누적치)
    costCut         화물칸에 있는 것만으로 구역 소모량을 깎음
    sticky          정비로 버릴 때 이 확률로 안 버려짐
    noOffer         뽑기 목록에 안 뜸 (부화·변신으로만 얻음)
*/
var SYMBOLS = {
  // ═══════════ 흔함 — 기본 시너지
  o2:{ e:'🫧', n:'산소방울', base:1, r:'common', d:'그냥 1. 하지만 뭉치면 산소통이 된다' },

  ration:{ e:'🥫', n:'식량', base:1, r:'common', d:'인접한 💧 정제수 1개당 +2',
    effect:function(c){ var k=c.adj('water').length; if(k) c.addSelf(2*k); } },

  water:{ e:'💧', n:'정제수', base:1, r:'common', d:'인접한 🥫 식량 · 🧑‍🚀 승무원 1개당 +1',
    effect:function(c){ var k=c.adj('ration','crew').length; if(k) c.addSelf(k); } },

  part:{ e:'🔩', n:'볼트', base:2, r:'common', d:'인접한 🤖 정비로봇이 써버림 (자신 파괴, 로봇 +6)',
    effect:function(c){ var bot=c.adj('bot')[0]; if(bot){ c.add(bot,6); c.kill(c.self); } } },

  oil:{ e:'🛢️', n:'윤활유', base:1, r:'common', d:'인접한 🤖 정비로봇 1개당 +2',
    effect:function(c){ var k=c.adj('bot').length; if(k) c.addSelf(2*k); } },

  hydro:{ e:'🌱', n:'수경재배', base:1, r:'common', d:'💧 정제수와 인접하면 영구히 +1 (한 턴에 1까지, 최대 +7)',
    baseOf:function(en){ return 1 + (en.mem.grow||0); },
    badge:function(en){ return '+' + (en.mem.grow || 0) + (en.mem.grow >= HYDRO_MAX ? ' 만개' : ''); },
    // 물이 여러 개 붙어도 한 턴에 1만 자람 — 물 도배로 폭주하는 걸 막으려고
    effect:function(c){ var en=c.self.entry;
      if(c.adj('water').length && (en.mem.grow||0) < HYDRO_MAX) en.mem.grow = (en.mem.grow||0) + 1; } },

  duct:{ e:'🌬️', n:'환기구', base:1, r:'common', d:'상하좌우로 이어붙은 🌬️ 환기구 1개당 +1',
    effect:function(c){ var ch=ductChain(c.cells, c.self); ch.forEach(c.link); if(ch.length) c.addSelf(ch.length); } },

  solar:{ e:'☀️', n:'태양광 패널', base:0, r:'common', d:'인접한 심볼이 서로 전부 다르면 +5',
    effect:function(c){ var a=c.adj(); if(!a.length) return;
      var ids={}, n=0;
      for(var i=0;i<a.length;i++){ var id=a[i].entry.id; if(!ids[id]){ ids[id]=1; n++; } }
      if(n===a.length) c.addSelf(5); } },

  coil:{ e:'🧲', n:'자기 코일', base:1, r:'common', d:'인접한 🧲 자기 코일 1개당 +2',
    effect:function(c){ var k=c.adj('coil').length; if(k) c.addSelf(2*k); } },

  larva:{ e:'🥚', n:'외계 알', base:1, r:'common', d:'4번 등장하면 👾 외계생명으로 부화',
    badge:function(en){ return (LARVA_HATCH - (en.mem.age||0)) + '회'; },
    effect:function(c){ var en=c.self.entry; en.mem.age=(en.mem.age||0)+1;
      if(en.mem.age>=LARVA_HATCH){ c.morph(c.self,'alien'); c.note('🥚 부화했다'); } } },

  // ═══════════ 보통 — 판을 굴리는 엔진
  bot:{ e:'🤖', n:'정비로봇', base:2, r:'uncommon', d:'인접한 🔩 볼트 · 🛢️ 윤활유 1개당 +3',
    effect:function(c){ var k=c.adj('part','oil').length; if(k) c.addSelf(3*k); } },

  crew:{ e:'🧑‍🚀', n:'승무원', base:2, r:'uncommon', d:'인접한 🥫 식량 · 💧 정제수 1개당 +2',
    effect:function(c){ var k=c.adj('ration','water').length; if(k) c.addSelf(2*k); } },

  fuel:{ e:'🔋', n:'연료전지', base:4, r:'uncommon', d:'조용히 4' },

  navcom:{ e:'🖥️', n:'항법 컴퓨터', base:2, r:'uncommon', d:'같은 열의 심볼 1개당 +2',
    effect:function(c){ var k=c.col().length; if(k) c.addSelf(2*k); } },

  cargo:{ e:'📦', n:'미확인 화물', base:0, r:'uncommon', d:'등장할 때마다 안이 +10씩 불어남. 🛠️ 만능공구가 열어줘야 값이 됨',
    badge:function(en){ return '' + (en.mem.acc || 0); },
    effect:function(c){ var en=c.self.entry; en.mem.acc=(en.mem.acc||0)+10; } },

  tool:{ e:'🛠️', n:'만능공구', base:1, r:'uncommon', d:'판에서 가장 많이 쌓인 📦 미확인 화물 하나를 열어 15 + 쌓인 값',
    effect:function(c){ var t=c.all('cargo'); if(!t.length) return;
      var best=t[0];
      for(var i=1;i<t.length;i++) if((t[i].entry.mem.acc||0) > (best.entry.mem.acc||0)) best=t[i];
      c.addSelf(15 + (best.entry.mem.acc||0)); c.kill(best); } },

  leak:{ e:'🌡️', n:'임시 배관', base:14, r:'uncommon', sticky:0.55,
    d:'혼자면 14. 대신 인접한 모든 심볼 -3. 정비로 버려도 55% 확률로 안 떨어짐',
    effect:function(c){ var a=c.adj(); for(var i=0;i<a.length;i++) c.add(a[i],-3); } },

  mold:{ e:'🦠', n:'곰팡이', base:-3, r:'uncommon',
    d:'인접한 모든 심볼 -2. 12% 확률로 화물칸에 곰팡이가 하나 더',
    effect:function(c){ var a=c.adj(); for(var i=0;i<a.length;i++) c.add(a[i],-2);
      if(c.rand()<0.12){ c.deckAdd('mold'); c.note('🦠 곰팡이가 번졌다'); } } },

  kit:{ e:'🧰', n:'정비 키트', base:1, r:'uncommon', d:'인접한 🦠 곰팡이를 없애고 개당 +22',
    effect:function(c){ var t=c.adj('mold');
      for(var i=0;i<t.length;i++){ c.addSelf(22); c.kill(t[i]); } } },

  hole:{ e:'🕳️', n:'미세 블랙홀', base:0, r:'uncommon', d:'인접한 심볼에서 3씩 빨아들여, 두 배로 불려서 자기 값으로',
    effect:function(c){ var a=c.adj();
      for(var i=0;i<a.length;i++){ c.add(a[i],-3); c.addSelf(6); } } },

  parasite:{ e:'🪱', n:'기생체', base:1, r:'uncommon', d:'인접한 심볼 하나에서 8을 빨아 +12',
    effect:function(c){ var a=c.adj(); if(!a.length) return;
      var t=a[Math.floor(c.rand()*a.length)]; c.add(t,-8); c.addSelf(12); } },

  coupon:{ e:'🎫', n:'보급 쿠폰', base:-3, r:'uncommon', costCut:40,
    d:'자체 -3. 대신 화물칸에 있는 1장당 이번 구역 소모량 -40' },

  // ═══════════ 희귀 — 배수와 폭발
  reactor:{ e:'☢️', n:'반응로', base:3, r:'rare',
    d:'인접한 모든 심볼 2배 (한 칸은 스핀당 한 번만). 대신 15% 확률로 화물칸에 🦠 곰팡이',
    effect:function(c){ var a=c.adj(); for(var i=0;i<a.length;i++) c.mul(a[i],2);
      if(c.rand()<0.15){ c.deckAdd('mold'); c.note('☢️ 방사선에 곰팡이가 슬었다'); } } },

  turbine:{ e:'🌀', n:'순환 터빈', base:4, r:'rare', d:'같은 행의 모든 심볼 +6',
    effect:function(c){ var a=c.row(); for(var i=0;i<a.length;i++) c.add(a[i],6); } },

  nano:{ e:'🧬', n:'복제 나노봇', base:0, r:'rare', d:'인접한 심볼 중 가장 큰 값과 같아짐',
    effect:function(c){ var a=c.adj(), m=0;
      for(var i=0;i<a.length;i++) if(a[i].val>m) m=a[i].val;
      if(m) c.addSelf(m); } },

  incin:{ e:'🔥', n:'소각로', base:3, r:'rare', d:'같은 행의 🦠 곰팡이를 전부 태워 개당 +40',
    effect:function(c){ var t=c.row('mold');
      for(var i=0;i<t.length;i++){ c.addSelf(40); c.kill(t[i]); } } },

  tank:{ e:'🫙', n:'예비 산소탱크', base:6, r:'rare', d:'화물칸의 🫧 산소방울 1장당 +2 (최대 +30)',
    effect:function(c){ var k=0;
      for(var i=0;i<c.deck.length;i++) if(c.deck[i].id==='o2') k++;
      if(k) c.addSelf(Math.min(2*k, 30)); } },

  wormhole:{ e:'🌌', n:'웜홀', base:0, r:'rare', d:'2% 확률로 +5000, 아니면 +2',
    effect:function(c){ if(c.rand()<0.02){ c.addSelf(5000); c.note('🌌 웜홀이 열렸다!'); } else c.addSelf(2); } },

  ore:{ e:'💎', n:'희귀 광물', base:10, r:'rare', d:'묵직하게 10' },

  // ═══════════ 전설
  mastercode:{ e:'🗝️', n:'마스터 코드', base:5, r:'legend', d:'판 위의 📦 미확인 화물을 전부 열어 개당 60 + 쌓인 값',
    effect:function(c){ var t=c.all('cargo');
      for(var i=0;i<t.length;i++){ c.addSelf(60 + (t[i].entry.mem.acc||0)); c.kill(t[i]); } } },

  aicore:{ e:'🧠', n:'AI 코어', base:10, r:'legend', d:'인접한 심볼 1개당 +10',
    effect:function(c){ var k=c.adj().length; if(k) c.addSelf(10*k); } },

  align:{ e:'✨', n:'초공간 정렬', base:0, r:'legend', d:'판에 3개 이상 깔린 심볼 종류마다 +120',
    effect:function(c){ var a=c.all(), cnt={}, k=0;
      for(var i=0;i<a.length;i++) cnt[a[i].entry.id]=(cnt[a[i].entry.id]||0)+1;
      for(var id in cnt) if(cnt[id]>=3) k++;
      if(k) c.addSelf(120*k); } },

  critical:{ e:'⚛️', n:'임계 반응', base:0, r:'legend', d:'이번 스핀 총합 2배. 대신 다음 구역 소모량 +30%',
    effect:function(c){ c.spinMul(2); c.debt({mul:1.30}); c.note('⚛️ 임계 돌입 — 다음 구역이 무거워진다'); } },

  emergency:{ e:'🩸', n:'비상 배급', base:0, r:'legend', d:'지금 즉시 +400. 대신 다음 구역 소모량 +35%',
    effect:function(c){ c.gain(400); c.debt({mul:1.35}); c.note('🩸 비상 배급 개봉'); } },

  // ═══════════ 부화로만 나오는 놈 (뽑기 목록엔 안 뜸)
  alien:{ e:'👾', n:'외계생명', base:6, r:'uncommon', noOffer:true,
    d:'인접한 👾 외계생명 1개당 +8. 무리를 지으면 무섭다',
    effect:function(c){ var k=c.adj('alien').length; if(k) c.addSelf(8*k); } },
};

// 12장. 20칸을 60%만 채워서 태양광·환기구가 자리를 볼 여지를 남김
var START_DECK = ['o2','o2','o2','ration','ration','water','water','water','hydro','duct','solar','coil'];

// ══════════════════════════════════ 유틸
var uidSeq = 0;
function mkEntry(id){ return { uid: ++uidSeq, id: id, mem: {} }; }

function baseOf(entry){
  var d = SYMBOLS[entry.id];
  return d.baseOf ? d.baseOf(entry) : d.base;
}

function shuffle(a, rnd){
  for (var i=a.length-1; i>0; i--){
    var j = Math.floor(rnd() * (i+1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function makeCells(){
  var out = [];
  for (var i=0; i<CELLS; i++)
    out.push({ entry:null, i:i, r:Math.floor(i/COLS), c:i%COLS,
               val:0, dead:false, show:false, flash:0, links:[], boosted:false });
  return out;
}

/* 상하좌우로 이어붙은 환기구 덩어리 전체 (자기 제외).
   대각선은 관이 안 이어진 걸로 봄. 좌우만 보면 세로로 붙여도 아무 일이 안 일어나서
   "이어붙인다"는 감각이 안 살아남 */
function ductChain(cells, cell){
  var at = function(r, c){
    if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return null;
    var o = cells[r*COLS + c];
    return (o && o.entry && o.entry.id === 'duct' && !o.dead) ? o : null;
  };
  var seen = {}, stack = [cell], out = [];
  seen[cell.i] = 1;
  while (stack.length){
    var cur = stack.pop();
    var nb = [at(cur.r-1,cur.c), at(cur.r+1,cur.c), at(cur.r,cur.c-1), at(cur.r,cur.c+1)];
    for (var i=0;i<4;i++){
      var o = nb[i];
      if (!o || seen[o.i]) continue;
      seen[o.i] = 1; out.push(o); stack.push(o);
    }
  }
  return out;
}

/* 화물칸에서 20개를 비복원으로 뽑아 칸에 앉힘. 20보다 적으면 나머진 빈칸.
   앉을 자리도 섞음 — 순서대로 넣으면 화물이 적을 때 위쪽 행에만 몰려서
   태양광·환기구처럼 자리를 보는 심볼이 아예 성립을 안 함 */
function fillCells(cells, deck, rnd){
  var pool  = shuffle(deck.slice(), rnd).slice(0, CELLS);
  var seats = shuffle(cells.map(function(_, i){ return i; }), rnd);
  for (var i=0; i<cells.length; i++){
    var cell = cells[i];
    cell.entry = null; cell.val = 0; cell.dead = false;
    cell.show = false; cell.flash = 0; cell.links = []; cell.boosted = false;
  }
  for (var k=0; k<pool.length; k++){
    var c = cells[seats[k]];
    c.entry = pool[k];
    c.val   = baseOf(pool[k]);
  }
}

// ══════════════════════════════════ 점수 판정
/* state = { cells, deck, debt:{mul,add} }
   반환 { total, notes }. cells/deck/debt를 직접 고침 */
function resolve(state, rnd){
  rnd = rnd || Math.random;
  var cells = state.cells;
  var extra = { coins:0, notes:[], mul:1 };

  var alive = function(cell){ return cell.entry && !cell.dead; };
  var adjacent = function(cell){
    return cells.filter(function(o){
      return o !== cell && Math.abs(o.r-cell.r) <= 1 && Math.abs(o.c-cell.c) <= 1;
    });
  };
  var filt = function(list, ids){
    return list.filter(function(o){
      return alive(o) && (ids.length === 0 || ids.indexOf(o.entry.id) >= 0);
    });
  };

  for (var ci=0; ci<cells.length; ci++){
    var cell = cells[ci];
    if (!alive(cell)) continue;
    var def = SYMBOLS[cell.entry.id];
    if (!def || !def.effect) continue;

    /* 이 칸이 어떤 칸을 쳐다봤는지 기록해둠. 점수를 순서대로 보여줄 때
       "얘 때문에 이만큼"이 같이 빛나게 하려고.
       단, 조회만 하고 아무 일도 안 일어난 경우(태양광 조건 미충족 같은 것)는
       빼야 함 — 점수에 관여도 안 한 게 빛나면 왜 빛나는지 알 수가 없음.
       그래서 조회 결과는 대기줄에 두고, 값이 실제로 움직일 때만 확정 */
    (function(cell){
      var pending = [];
      var hold = function(t){ if (t && t !== cell && pending.indexOf(t) < 0) pending.push(t); };
      var commit = function(){
        for (var i=0;i<pending.length;i++)
          if (cell.links.indexOf(pending[i]) < 0) cell.links.push(pending[i]);
        pending.length = 0;
      };
      var bind = function(t){ hold(t); commit(); };
      var seen = function(list){ list.forEach(hold); return list; };

      SYMBOLS[cell.entry.id].effect({
        self: cell,
        cells: cells,
        deck: state.deck,
        adj: function(){ return seen(filt(adjacent(cell), [].slice.call(arguments))); },
        all: function(){ return seen(filt(cells.filter(function(o){ return o!==cell; }), [].slice.call(arguments))); },
        row: function(){ return seen(filt(cells.filter(function(o){ return o!==cell && o.r===cell.r; }), [].slice.call(arguments))); },
        col: function(){ return seen(filt(cells.filter(function(o){ return o!==cell && o.c===cell.c; }), [].slice.call(arguments))); },
        emptyAdj: function(){ return adjacent(cell).filter(function(o){ return !o.entry; }).length; },
        link: hold,
        addSelf: function(n){ if (!n) return; cell.val += n; commit(); },
        add: function(t,n){ if (!n) return; bind(t); t.val += n; },
        mul: function(t,m){
          if (m === 1 || t.boosted) return;   // 한 칸은 스핀당 한 번만 배수를 먹음
          bind(t); t.val *= m; t.boosted = true;
        },
        kill: function(t){ bind(t); t.dead = true; t.val = 0; removeFromDeck(state.deck, t.entry); },
        morph: function(t,id){ if(!SYMBOLS[id]) return; t.entry.id = id; t.entry.mem = {}; t.val = baseOf(t.entry); },
        gain: function(n){ if (!n) return; extra.coins += n; commit(); },
        spinMul: function(m){ extra.mul = Math.min(extra.mul * m, SPIN_MUL_CAP); },
        debt: function(o){
          if (o.mul) state.debt.mul *= o.mul;
          if (o.add) state.debt.add += o.add;
        },
        deckAdd: function(id){ if (SYMBOLS[id]) state.deck.push(mkEntry(id)); },
        rand: rnd,
        note: function(msg){ extra.notes.push(msg); },
      });
    })(cell);
  }

  var total = extra.coins;
  for (var i=0; i<cells.length; i++) if (alive(cells[i])) total += cells[i].val;
  if (extra.mul !== 1) total = Math.round(total * extra.mul);
  return { total: total, notes: extra.notes, mul: extra.mul };
}

function removeFromDeck(deck, entry){
  for (var i=0;i<deck.length;i++)
    if (deck[i].uid === entry.uid){ deck.splice(i,1); return; }
}

/* 화물칸에 그냥 들고만 있어도 소모량을 깎아주는 심볼 (보급 쿠폰) */
function costCutOf(deck){
  var cut = 0;
  for (var i=0;i<deck.length;i++){
    var d = SYMBOLS[deck[i].id];
    if (d && d.costCut) cut += d.costCut;
  }
  return cut;
}

/* 구역이 깊어질수록 희귀·전설이 잘 나오게.
   이게 없으면 후반에도 흔함만 계속 쌓여서 덱이 복리로 못 자람 —
   즉 "더 깊이 갈수록 더 센 게 나온다"가 극고점 빌드의 유일한 엔진임 */
function weightFor(rar, round){
  round = round || 1;
  if (rar === 'rare')   return Math.min(10 + round * 1.2, 24);
  if (rar === 'legend') return Math.min( 3 + round * 0.6, 10);
  if (rar === 'uncommon') return 27;
  return 60;
}

/* 뽑기 후보 n개. 등급 가중치로 뽑되 중복은 안 나오게 */
function rollChoices(n, rnd, round){
  rnd = rnd || Math.random;
  var pool = [];
  for (var id in SYMBOLS){
    if (SYMBOLS[id].noOffer) continue;
    var w = Math.round(weightFor(SYMBOLS[id].r, round));
    for (var i=0;i<w;i++) pool.push(id);
  }
  var out = [], guard = 0;
  while (out.length < n && pool.length && guard++ < 500){
    var pick = pool[Math.floor(rnd()*pool.length)];
    if (out.indexOf(pick) < 0) out.push(pick);
  }
  return out;
}

// ══════════════════════════════════ 내보내기
var ENGINE = {
  COLS:COLS, ROWS:ROWS, CELLS:CELLS, LARVA_HATCH:LARVA_HATCH,
  RARITY:RARITY, SYMBOLS:SYMBOLS, START_DECK:START_DECK, COSTS:COSTS, HYDRO_MAX:HYDRO_MAX,
  costFor:costFor, spinsFor:spinsFor, mkEntry:mkEntry, baseOf:baseOf,
  shuffle:shuffle, makeCells:makeCells, fillCells:fillCells, resolve:resolve,
  removeFromDeck:removeFromDeck, costCutOf:costCutOf, rollChoices:rollChoices, weightFor:weightFor,
  ductChain:ductChain,
};
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
