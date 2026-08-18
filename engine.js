"use strict";
/* ══════════════════════════════════════════════════════════════════
   우주탐험 — 규칙 엔진
   ─ 심볼 테이블과 점수 판정만 들어있음. DOM을 하나도 안 씀.
     브라우저(index.html)와 밸런스 시뮬레이터(sim/balance.js)가 같이 씀 —
     둘이 다른 규칙으로 도는 걸 막으려고 파일을 하나로 유지함
   변경내역
     v0.2  index.html에서 규칙만 떼어냄, 보통/희귀/전설 등급 추가
     v0.5  순도 규칙, 우주 동물·외계인·통신 계열 16종 추가,
           고립돼 있던 심볼 12종에 상호작용 연결
     v0.4  스핀 5회 고정, 수경재배 3단계(🌱 수경재배 → 🌷 꽃봉오리 → 🌸 만개한 꽃),
           원형(도박/조합/성장/안정)별 구역 통과율을 기준으로 재조정
     v0.3  시뮬레이션(sim/balance.js) 결과로 수치 조정 —
           되먹임 제거(비상 배급), 배수 겹침 천장, 희귀도 램프 상한,
           소각로·만능공구 사거리 확대, 임시 배관 강화
   ══════════════════════════════════════════════════════════════════ */

// ══════════════════════════════════ 판 크기
var COLS = 5, ROWS = 4, CELLS = COLS * ROWS;
var LARVA_HATCH = 3;      // 외계 알이 부화하기까지 등장해야 하는 횟수
var HYDRO_BUD = 4;        // 수경재배가 꽃봉오리로 맺히는 지점 (여기까진 물로)
var HYDRO_MAX = 8;        // 꽃봉오리가 꽃으로 피는 지점 (여기부턴 태양광으로)
var COST_CUT_MAX = 0.30;  // 소모량 할인의 합계 천장
var SPIN_MUL_CAP = 3;
/* 순도 배수 — 판 20칸 중 "가장 많이 깔린 한 종류"의 개수로 스핀 총합에 배수.
   덱을 한 종류로 모을수록 커진다. 이게 이 게임의 최고 고점이고,
   동시에 곁가지 픽 하나하나에 눈에 보이는 대가를 붙이는 장치임.
   배수는 하나뿐이라 겹쳐서 지수로 터지지 않음 */
var PURITY = [[1.00,3.0],[0.95,2.3],[0.85,1.7],[0.75,1.4],[0.60,1.15]];
var PURITY_MIN = 8;   // 판에 이만큼은 깔려 있어야 순도를 쳐줌 (3장짜리 덱으로 100% 먹는 걸 막음)
function purityMul(top, filled){
  if (filled < PURITY_MIN) return 1;
  var ratio = top / filled;
  for (var i=0;i<PURITY.length;i++) if (ratio >= PURITY[i][0]) return PURITY[i][1];
  return 1;
}     // 스핀 총합 배수 천장 (임계 반응이 겹쳐서 지수로 터지는 걸 막음)

var RARITY = {
  common:   { label:'흔함', weight:60, color:'var(--common)' },
  uncommon: { label:'보통', weight:27, color:'var(--uncommon)' },
  rare:     { label:'희귀', weight:10, color:'var(--rare)' },
  legend:   { label:'전설', weight:3,  color:'var(--legend)' },
};

/* 구역별 생명유지 소모량.
   손으로 배수를 정하지 않고 sim/fit-costs.js 로 역산한 표임.
   "구역별 탈락률을 일정하게" 만들려면 소모량을 그 구역 정산 직전
   산소 분포의 같은 백분위에 놓으면 된다 — 소모량 = p15면 15%가 떨어짐.
   남은 산소가 다음 구역으로 넘어가 자기참조가 걸리므로 다섯 번 수렴시켰음.
   결과: 8~28구역 탈락률이 13~19%로 고르게 깔림 (심볼 59종 · 선택지 4장 기준).
   9→10구역이 유난히 튀는 건 순도·배양조가 그쯤 붙어서 수입이 계단으로
   오르기 때문 — 소모량을 같이 올려야 탈락률이 평평해진다.
   심볼을 늘리거나 선택지 수를 바꾸면 반드시 다시 맞출 것:
     node sim/fit-costs.js 15 220 5 */
var COSTS = [
  90, 130, 175, 225, 275, 305, 340, 410, 580, 1100,
  1670, 2090, 2480, 2720, 3120, 3340, 3740, 4030, 4490, 4700,
  5020, 5540, 5890, 6530, 6980, 7250, 7540, 7890, 8330, 8930,
];
function costFor(r){
  return r <= COSTS.length
    ? COSTS[r-1]
    : Math.round(COSTS[COSTS.length-1] * Math.pow(1.25, r - COSTS.length));
}
// 스핀 수는 어느 구역이든 5회로 고정.
// 구역마다 스핀이 늘면 픽 기회까지 같이 늘어나 덱이 두 겹으로 세짐
function spinsFor(r){ return 5; }

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
    c.morph(cell,id,keep)  다른 심볼로 변신 (keep이면 자란 정도 등 mem 유지)
    c.gain(n)         칸과 무관하게 산소 직접 획득
    c.spinMul(m)      이번 스핀 총합에 배수 (전체 천장 3배)
    c.purityBoost(n)  순도 판정에서 n개 더 깔린 것으로 쳐줌
    c.topCount()      판에서 가장 많이 깔린 종류의 개수
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
  o2:{ e:'🫧', n:'산소방울', base:1, r:'common', d:'화물칸에 실린 🫧 산소방울 6장당 +1. 판이 꽉 차도 계속 자라는 유일한 축',
    /* 판이 아니라 화물칸 장수를 봄. 판 기준이면 20칸이 다 차는 순간 수입이 멈춰서
       소모량 곡선을 영영 못 넘는다. 🧫 배양조로 덱을 계속 불리는 통일 덱만
       21구역 위로 갈 수 있게 하려고 여기만 이렇게 뚫어둠 */
    effect:function(c){ var k=0;
      for(var i=0;i<c.deck.length;i++) if(c.deck[i].id==='o2') k++;
      if(k>=6) c.addSelf(Math.floor(k/6)); } },

  ration:{ e:'🥫', n:'식량', base:1, r:'common', d:'인접한 💧 정제수 1개당 +2',
    effect:function(c){ var k=c.adj('water').length; if(k) c.addSelf(2*k); } },

  water:{ e:'💧', n:'정제수', base:1, r:'common', d:'인접한 🥫 식량 · 🧑‍🚀 승무원 1개당 +1',
    effect:function(c){ var k=c.adj('ration','crew').length; if(k) c.addSelf(k); } },

  part:{ e:'🔩', n:'볼트', base:2, r:'common', d:'인접한 🤖 정비로봇이 써버림 (자신 파괴, 로봇 +12)',
    effect:function(c){ var bot=c.adj('bot')[0]; if(bot){ c.add(bot,12); c.kill(c.self); } } },

  oil:{ e:'🛢️', n:'윤활유', base:1, r:'common', d:'인접한 🤖 정비로봇 1개당 +2',
    effect:function(c){ var k=c.adj('bot').length; if(k) c.addSelf(2*k); } },

  hydro:{ e:'🌱', n:'수경재배', base:1, r:'common',
    d:'💧 정제수와 인접해야만 자란다 (한 턴에 +1, 최대 +4). 다 자라면 🌷 꽃봉오리가 맺힌다',
    baseOf:function(en){ return 1 + (en.mem.grow||0); },
    badge:function(en){ return '+' + (en.mem.grow || 0); },
    // 물이 여러 개 붙어도 한 턴에 1만 자람 — 물 도배로 폭주하는 걸 막으려고
    effect:function(c){ var en=c.self.entry;
      if(c.adj('water').length && (en.mem.grow||0) < HYDRO_BUD) en.mem.grow = (en.mem.grow||0) + 1;
      if((en.mem.grow||0) >= HYDRO_BUD){ c.morph(c.self,'bud',true); c.note('🌱 꽃봉오리가 맺혔다'); } } },

  bud:{ e:'🌷', n:'꽃봉오리', base:3, r:'common', noOffer:true,
    d:'☀️ 태양광 패널과 인접해야만 자란다. 햇빛을 네 번 받으면 🌸 꽃이 핀다',
    baseOf:function(en){ return 3 + (en.mem.grow||0); },
    // 남은 햇빛 횟수를 보여줌. +N을 그대로 이어받으면 저절로 자라는 것처럼 보임
    badge:function(en){ return '☀️' + (HYDRO_MAX - (en.mem.grow||0)); },
    effect:function(c){ var en=c.self.entry;
      if(c.adj('solar').length && (en.mem.grow||0) < HYDRO_MAX) en.mem.grow = (en.mem.grow||0) + 1;
      if((en.mem.grow||0) >= HYDRO_MAX){ c.morph(c.self,'bloom',true); c.note('🌷 꽃이 폈다'); } } },

  bloom:{ e:'🌸', n:'만개한 꽃', base:18, r:'uncommon', noOffer:true,
    d:'기본 18. 인접한 🌸 만개한 꽃 1개당 +8',
    effect:function(c){ var k=c.adj('bloom').length; if(k) c.addSelf(8*k); } },

  duct:{ e:'🌬️', n:'환기구', base:1, r:'common', d:'상하좌우로 이어붙은 🌬️ 환기구 1개당 +1',
    effect:function(c){ var ch=ductChain(c.cells, c.self); ch.forEach(c.link); if(ch.length) c.addSelf(ch.length); } },

  solar:{ e:'☀️', n:'태양광 패널', base:0, r:'common', d:'인접한 심볼이 서로 전부 다르면 +5',
    effect:function(c){ var a=c.adj(); if(!a.length) return;
      var ids={}, n=0;
      for(var i=0;i<a.length;i++){ var id=a[i].entry.id; if(!ids[id]){ ids[id]=1; n++; } }
      if(n===a.length) c.addSelf(5); } },

  coil:{ e:'🧲', n:'자기 코일', base:1, r:'common', d:'인접한 🧲 자기 코일 1개당 +2',
    effect:function(c){ var k=c.adj('coil').length; if(k) c.addSelf(2*k); } },

  larva:{ e:'🥚', n:'외계 알', base:1, r:'common', d:'3번 등장하면 👾 외계생명으로 부화',
    badge:function(en){ return (LARVA_HATCH - (en.mem.age||0)) + '회'; },
    effect:function(c){ var en=c.self.entry; en.mem.age=(en.mem.age||0)+1;
      if(en.mem.age>=LARVA_HATCH){ c.morph(c.self,'alien'); c.note('🥚 부화했다'); } } },


  // ─── 우주 동물원 · 통신 · 보급 (흔함)
  rat:{ e:'🐁', n:'실험용 쥐', base:1, r:'common',
    d:'15% 확률로 화물칸에 🐁 실험용 쥐가 한 마리 더. 🐈‍⬛ 함선 고양이의 밥',
    effect:function(c){ if(c.rand()<0.15){ c.deckAdd('rat'); c.note('🐁 쥐가 늘었다'); } } },

  cat:{ e:'🐈‍⬛', n:'함선 고양이', base:2, r:'common',
    d:'인접한 🐁 실험용 쥐를 잡아먹고 마리당 +13 (쥐는 화물칸에서 사라진다)',
    effect:function(c){ var t=c.adj('rat');
      for(var i=0;i<t.length;i++){ c.addSelf(13); c.kill(t[i]); } } },

  radio:{ e:'📻', n:'무전기', base:1, r:'common',
    d:'같은 행에 📡 통신 안테나가 있으면 +9',
    effect:function(c){ if(c.row('antenna').length) c.addSelf(9); } },

  pill:{ e:'💊', n:'보급 알약', base:1, r:'common',
    d:'인접한 🧑‍🚀 승무원 · 👾 외계생명 1개당 +3',
    effect:function(c){ var k=c.adj('crew','alien').length; if(k) c.addSelf(3*k); } },

  battery:{ e:'🪫', n:'방전 전지', base:8, r:'common',
    d:'처음엔 8. 등장할 때마다 1씩 닳아 0이 된다',
    baseOf:function(en){ return Math.max(0, 8 - (en.mem.used||0)); },
    badge:function(en){ return '' + Math.max(0, 8 - (en.mem.used||0)); },
    effect:function(c){ var en=c.self.entry; en.mem.used=(en.mem.used||0)+1; } },

  // ═══════════ 보통 — 판을 굴리는 엔진
  bot:{ e:'🤖', n:'정비로봇', base:2, r:'uncommon', d:'인접한 🔩 볼트 · 🛢️ 윤활유 1개당 +5',
    effect:function(c){ var k=c.adj('part','oil').length; if(k) c.addSelf(5*k); } },

  crew:{ e:'🧑‍🚀', n:'승무원', base:2, r:'uncommon', d:'인접한 🥫 식량 · 💧 정제수 1개당 +3',
    effect:function(c){ var k=c.adj('ration','water').length; if(k) c.addSelf(3*k); } },

  fuel:{ e:'🔋', n:'연료전지', base:3, r:'uncommon',
    d:'인접한 ☢️ 반응로 · 🕳️ 미세 블랙홀 1개당 +7. 기본값이 커서 빨아먹히기 좋다',
    effect:function(c){ var k=c.adj('reactor','hole').length; if(k) c.addSelf(7*k); } },

  navcom:{ e:'🖥️', n:'항법 컴퓨터', base:2, r:'uncommon',
    d:'같은 열의 심볼 1개당 +2. 📡 통신 안테나와 인접하면 두 배',
    effect:function(c){ var k=c.col().length; if(!k) return;
      c.addSelf(2*k * (c.adj('antenna').length ? 2 : 1)); } },

  cargo:{ e:'📦', n:'미확인 화물', base:0, r:'uncommon', d:'등장할 때마다 안이 +12씩 불어남. 열기 전엔 0. 오래 묵힐수록 커진다',
    badge:function(en){ return '' + (en.mem.acc || 0); },
    effect:function(c){ var en=c.self.entry; en.mem.acc=(en.mem.acc||0)+12; } },

  tool:{ e:'🛠️', n:'만능공구', base:1, r:'uncommon', d:'판에서 가장 많이 쌓인 📦 미확인 화물 하나를 열어 25 + 쌓인 값',
    effect:function(c){ var t=c.all('cargo'); if(!t.length) return;
      var best=t[0];
      for(var i=1;i<t.length;i++) if((t[i].entry.mem.acc||0) > (best.entry.mem.acc||0)) best=t[i];
      c.addSelf(25 + (best.entry.mem.acc||0)); c.kill(best); } },

  leak:{ e:'🌡️', n:'임시 배관', base:8, r:'uncommon', sticky:0.55,
    d:'혼자면 8, 인접한 🌬️ 환기구 1개당 +7. 대신 인접한 모든 심볼 -2. 버려도 55% 확률로 안 떨어짐',
    effect:function(c){ var d=c.adj('duct').length; if(d) c.addSelf(7*d);
      var a=c.adj(); for(var i=0;i<a.length;i++) c.add(a[i],-2); } },

  mold:{ e:'🦠', n:'곰팡이', base:2, r:'uncommon',
    d:'혼자면 2. 인접한 모든 심볼 -2. 18% 확률로 화물칸에 곰팡이가 하나 더',
    /* 혼자 두면 확실히 손해가 되게(2에 인접 -2) 잡아둠.
       🧰 정비 키트·🔥 소각로가 갖춰지고 나서야 개당 26·45로 터진다.
       그 둘이 보통·희귀라 대체로 4구역 즈음 손에 들어오는데,
       그때부터 도박 덱이 갑자기 편해지는 게 이 심볼의 역할 */
    effect:function(c){ var a=c.adj(); for(var i=0;i<a.length;i++) c.add(a[i],-2);
      if(c.rand()<0.18){ c.deckAdd('mold'); c.note('🦠 곰팡이가 번졌다'); } } },

  kit:{ e:'🧰', n:'정비 키트', base:1, r:'uncommon', d:'인접한 🦠 곰팡이를 없애고 개당 +18',
    effect:function(c){ var t=c.adj('mold');
      for(var i=0;i<t.length;i++){ c.addSelf(18); c.kill(t[i]); } } },

  hole:{ e:'🕳️', n:'미세 블랙홀', base:0, r:'uncommon',
    d:'인접한 심볼을 전부 0으로 만들고, 빨아들인 기본값의 3배를 자기 값으로. 🔋 연료전지처럼 기본값이 큰 심볼을 물려야 이득',
    /* 기준이 "계산된 값"이 아니라 "기본값"인 게 핵심.
       시너지로 잔뜩 부풀린 심볼을 옆에 두면 그 값을 통째로 날리고 기본값만 챙기니 손해고,
       🔋 연료전지·💎 희귀 광물·🌡️ 임시 배관처럼 기본값 자체가 큰 심볼을 물려야 이득.
       배수 계열로 부풀린 판에서도 안 터지는 이유도 같음 */
    effect:function(c){ var a=c.adj();
      for(var i=0;i<a.length;i++){
        var b = baseOf(a[i].entry);
        c.add(a[i], -a[i].val);             // 주변은 전부 0
        if (b > 0) c.addSelf(b*3);
      } } },

  parasite:{ e:'🪱', n:'기생체', base:1, r:'uncommon',
    d:'인접한 심볼 하나에서 8을 빨아 +12. 👾 외계생명에 붙으면 +24',
    effect:function(c){ var host=c.adj('alien'), a=c.adj();
      if(host.length){ c.add(host[0],-8); c.addSelf(24); return; }
      if(!a.length) return;
      var t=a[Math.floor(c.rand()*a.length)]; c.add(t,-8); c.addSelf(12); } },

  coupon:{ e:'🎫', n:'보급 쿠폰', base:-3, r:'uncommon', costCutPct:0.08,
    d:'자체 -3. 대신 화물칸에 있는 1장당 구역 소모량 -8% (합쳐서 최대 -30%)' },

  purge:{ e:'🗑️', n:'폐기 슈트', base:4, r:'uncommon',
    d:'판에 3개 이하로 깔린 종류 중 가장 적은 것을 화물칸에서 영구히 버리고 +10. 🦠 곰팡이를 버리면 +30',
    /* 정비는 구역당 한 장뿐이라, 덱을 한 종류로 몰아가려면 이런 수단이 필요함.
       소수파부터 지우기 때문에 이미 기울어진 덱일수록 잘 듣는다 */
    effect:function(c){
      var a=c.all(), cnt={};
      for(var i=0;i<a.length;i++) cnt[a[i].entry.id]=(cnt[a[i].entry.id]||0)+1;
      var pickId=null, low=99;
      // 판에 3개 이하로만 깔린 종류만 손댐 — 주력까지 지우면 덱이 말라버림
      for(var id in cnt) if(cnt[id] <= 3 && cnt[id] < low && id !== 'purge'){ low=cnt[id]; pickId=id; }
      if(!pickId) return;
      for(var i=0;i<a.length;i++) if(a[i].entry.id===pickId){ c.kill(a[i]); break; }
      c.addSelf(pickId==='mold' ? 30 : 10); c.note('🗑️ '+SYMBOLS[pickId].e+' 한 장 폐기'); } },

  culture:{ e:'🧫', n:'배양조', base:2, r:'common',
    d:'판에서 가장 많이 깔린 종류를 화물칸에 하나 더 만든다. 🪐 중력 렌즈와 인접하면 두 장',
    /* 통일 덱의 엔진. 정비로 종류를 쳐내는 것만으로는 덱이 줄기만 해서,
       "같은 걸 늘리는" 수단이 없으면 순도 덱은 굶어 죽는다 */
    effect:function(c){
      var a=c.all(), cnt={}, best=null, bn=0;
      for(var i=0;i<a.length;i++){ var id=a[i].entry.id; cnt[id]=(cnt[id]||0)+1;
        if(cnt[id]>bn){ bn=cnt[id]; best=id; } }
      if(!best || SYMBOLS[best].noOffer) return;
      var n = c.adj('lens').length ? 2 : 1;
      for(var j=0;j<n;j++) c.deckAdd(best);
      c.note('🧫 '+SYMBOLS[best].e+(n>1?' 두 장':'')+' 배양됨'); } },

  antenna:{ e:'📡', n:'통신 안테나', base:2, r:'uncommon', d:'같은 행·열에 있는 📡 통신 안테나 1개당 +5',
    effect:function(c){ var k=c.row('antenna').length + c.col('antenna').length; if(k) c.addSelf(5*k); } },

  drill:{ e:'⛏️', n:'채굴 드릴', base:2, r:'uncommon', d:'인접한 💎 희귀 광물 1개당 +8 (광물은 그대로)',
    effect:function(c){ var k=c.adj('ore').length; if(k) c.addSelf(8*k); } },

  coolant:{ e:'🧊', n:'냉각재', base:3, r:'uncommon',
    d:'인접한 ☢️ 반응로 1개당 +10. 붙어 있는 반응로는 곰팡이를 안 만든다',
    effect:function(c){ var k=c.adj('reactor').length; if(k) c.addSelf(10*k); } },


  dog:{ e:'🐕', n:'우주견', base:3, r:'uncommon',
    d:'인접한 🐈‍⬛ 함선 고양이 · 🧑‍🚀 승무원 1개당 +5',
    effect:function(c){ var k=c.adj('cat','crew').length; if(k) c.addSelf(5*k); } },

  trader:{ e:'👽', n:'외계 상인', base:0, r:'uncommon',
    d:'판의 심볼 하나를 무작위로 팔아치워 +30 (그 심볼은 화물칸에서도 사라진다)',
    effect:function(c){ var a=c.all(); if(!a.length) return;
      var t=a[Math.floor(c.rand()*a.length)];
      c.addSelf(30); c.kill(t); c.note('👽 '+SYMBOLS[t.entry.id].e+' 팔아치웠다'); } },

  sat:{ e:'🛰️', n:'관측 위성', base:2, r:'uncommon',
    d:'같은 행·열의 빈칸 1개당 +2. 판이 헐거울수록 잘 본다',
    effect:function(c){ var k=0, cells=c.cells;
      for(var i=0;i<cells.length;i++){
        var o=cells[i];
        if(o===c.self || o.entry) continue;
        if(o.r===c.self.r || o.c===c.self.c) k++;
      }
      if(k) c.addSelf(2*k); } },

  extin:{ e:'🧯', n:'소화기', base:2, r:'uncommon',
    d:'인접한 🔥 소각로 · ☢️ 반응로 1개당 +11. 붙어 있는 반응로는 🦠 곰팡이를 안 만든다',
    effect:function(c){ var k=c.adj('incin','reactor').length; if(k) c.addSelf(11*k); } },

  hook:{ e:'🪝', n:'견인 갈고리', base:1, r:'uncommon',
    d:'인접한 📦 미확인 화물의 내용물을 +10씩 더 불린다',
    effect:function(c){ var t=c.adj('cargo');
      for(var i=0;i<t.length;i++){ t[i].entry.mem.acc=(t[i].entry.mem.acc||0)+10; c.link(t[i]); }
      if(t.length) c.addSelf(2*t.length); } },

  // ═══════════ 희귀 — 배수와 폭발
  reactor:{ e:'☢️', n:'반응로', base:3, r:'rare',
    d:'인접한 모든 심볼 2배 (한 칸은 스핀당 한 번만). 대신 15% 확률로 화물칸에 🦠 곰팡이 (🧊 냉각재 · 🧯 소화기가 붙어 있으면 없음)',
    effect:function(c){ var a=c.adj(); for(var i=0;i<a.length;i++) c.mul(a[i],2);
      if(c.adj('coolant','extin').length) return;    // 냉각재·소화기가 붙어 있으면 오염 없음
      if(c.rand()<0.15){ c.deckAdd('mold'); c.note('☢️ 방사선에 곰팡이가 슬었다'); } } },

  turbine:{ e:'🌀', n:'순환 터빈', base:4, r:'rare',
    d:'같은 행의 모든 심볼 +5. 그 행의 🌬️ 환기구 1개당 자신도 +6',
    effect:function(c){ var a=c.row(); for(var i=0;i<a.length;i++) c.add(a[i],5);
      var d=c.row('duct').length; if(d) c.addSelf(6*d); } },

  nano:{ e:'🧬', n:'복제 나노봇', base:0, r:'rare', d:'인접한 심볼 중 가장 큰 값과 같아짐',
    effect:function(c){ var a=c.adj(), m=0;
      for(var i=0;i<a.length;i++) if(a[i].val>m) m=a[i].val;
      if(m) c.addSelf(m); } },

  incin:{ e:'🔥', n:'소각로', base:3, r:'rare', d:'같은 행의 🦠 곰팡이를 전부 태워 개당 +32',
    effect:function(c){ var t=c.row('mold');
      for(var i=0;i<t.length;i++){ c.addSelf(32); c.kill(t[i]); } } },

  tank:{ e:'🫙', n:'예비 산소탱크', base:5, r:'rare', d:'화물칸의 🫧 산소방울 1장당 +2 (최대 +24)',
    effect:function(c){ var k=0;
      for(var i=0;i<c.deck.length;i++) if(c.deck[i].id==='o2') k++;
      if(k) c.addSelf(Math.min(2*k, 24)); } },

  wormhole:{ e:'🌌', n:'웜홀', base:0, r:'rare',
    d:'2% 확률로 +3500, 아니면 +2. 🪐 중력 렌즈와 인접하면 확률이 세 배',
    effect:function(c){ var p = 0.02 * (c.adj('lens').length ? 3 : 1);
      if(c.rand()<p){ c.addSelf(3500); c.note('🌌 웜홀이 열렸다!'); } else c.addSelf(2); } },

  ore:{ e:'💎', n:'희귀 광물', base:9, r:'rare', d:'묵직하게 9' },

  lens:{ e:'🪐', n:'중력 렌즈', base:0, r:'rare',
    d:'판에서 가장 많이 깔린 종류를 찾아, 그 종류 전부에게 개수만큼 더해준다',
    effect:function(c){ var top=c.topCount(); if(top<2) return;
      var a=c.all(), cnt={};
      for(var i=0;i<a.length;i++) cnt[a[i].entry.id]=(cnt[a[i].entry.id]||0)+1;
      for(var i=0;i<a.length;i++) if(cnt[a[i].entry.id]===top) c.add(a[i], top);
      c.addSelf(top); } },


  scope:{ e:'🔭', n:'관측 망원경', base:0, r:'rare',
    d:'판에 깔린 심볼 종류 1가지당 +4. 잡다할수록 좋다 — 순도와 정반대 축',
    effect:function(c){ var a=c.all(), seen={}, k=0;
      for(var i=0;i<a.length;i++){ var id=a[i].entry.id; if(!seen[id]){ seen[id]=1; k++; } }
      if(k) c.addSelf(4*k); } },

  anchor:{ e:'⚓', n:'자기 앵커', base:4, r:'rare',
    d:'인접한 🧲 자기 코일 1개당 +9',
    effect:function(c){ var k=c.adj('coil').length; if(k) c.addSelf(9*k); } },

  booster:{ e:'📶', n:'중계 증폭기', base:3, r:'rare',
    d:'인접한 📡 통신 안테나 · 📻 무전기의 값을 두 배로',
    effect:function(c){ var t=c.adj('antenna','radio');
      for(var i=0;i<t.length;i++) c.mul(t[i],2); } },

  turtle:{ e:'🐢', n:'심우주 거북', base:2, r:'rare',
    d:'등장할 때마다 영구히 +3씩 자란다 (최대 +30). 느리지만 확실하다',
    baseOf:function(en){ return 2 + (en.mem.grow||0); },
    badge:function(en){ return '+' + (en.mem.grow||0); },
    effect:function(c){ var en=c.self.entry;
      if((en.mem.grow||0) < 30) en.mem.grow=(en.mem.grow||0)+3; } },

  // ═══════════ 전설
  mastercode:{ e:'🗝️', n:'마스터 코드', base:5, r:'legend', d:'판 위의 📦 미확인 화물을 전부 열어 개당 60 + 쌓인 값',
    effect:function(c){ var t=c.all('cargo');
      for(var i=0;i<t.length;i++){ c.addSelf(60 + (t[i].entry.mem.acc||0)); c.kill(t[i]); } } },

  aicore:{ e:'🧠', n:'AI 코어', base:10, r:'legend', d:'인접한 심볼 1개당 +6. 그중 🖥️ 항법 컴퓨터는 1개당 +16',
    effect:function(c){ var k=c.adj().length, n=c.adj('navcom').length;
      if(k) c.addSelf(6*k + 10*n); } },

  align:{ e:'✨', n:'초공간 정렬', base:6, r:'legend',
    d:'이번 스핀의 순도를 4개 더 깔린 것으로 쳐준다. 순도가 이미 높을수록 무섭다',
    effect:function(c){ c.purityBoost(4); c.note('✨ 위상이 맞았다'); } },

  critical:{ e:'⚛️', n:'임계 반응', base:0, r:'legend', d:'이번 스핀 총합 2배. 대신 다음 구역 소모량 +30% — 🧊 냉각재가 인접하면 빚이 없다',
    effect:function(c){ c.spinMul(2);
      if(c.adj('coolant').length){ c.note('⚛️ 냉각재가 임계를 잡았다 — 빚 없음'); return; }
      c.debt({mul:1.30}); c.note('⚛️ 임계 돌입 — 다음 구역이 무거워진다'); } },

  emergency:{ e:'🩸', n:'비상 배급', base:0, r:'legend', d:'지금 즉시 +400. 대신 다음 구역 소모량 +35% — 화물칸에 🎫 보급 쿠폰이 있으면 절반만',
    effect:function(c){ c.gain(400);
      var hasCoupon=false;
      for(var i=0;i<c.deck.length;i++) if(c.deck[i].id==='coupon'){ hasCoupon=true; break; }
      c.debt({mul: hasCoupon ? 1.175 : 1.35});
      c.note('🩸 비상 배급 개봉' + (hasCoupon ? ' (쿠폰으로 빚 절반)' : '')); } },


  kraken:{ e:'🦑', n:'우주 크라켄', base:0, r:'legend',
    d:'인접한 심볼을 통째로 삼켜, 각 기본값의 3배를 가져간다 (삼킨 건 화물칸에서도 사라짐)',
    effect:function(c){ var a=c.adj();
      for(var i=0;i<a.length;i++){ var b=baseOf(a[i].entry); c.addSelf(Math.max(0,b)*3); c.kill(a[i]); }
      if(a.length) c.note('🦑 '+a.length+'개를 삼켰다'); } },

  prism:{ e:'🌈', n:'스펙트럼', base:5, r:'legend',
    d:'판에 심볼 종류가 12가지 이상이면 이번 스핀 총합 2배',
    effect:function(c){ var a=c.all(), seen={}, k=0;
      for(var i=0;i<a.length;i++){ var id=a[i].entry.id; if(!seen[id]){ seen[id]=1; k++; } }
      if(k>=12){ c.spinMul(2); c.note('🌈 스펙트럼이 갈라졌다'); } } },

  // ═══════════ 부화로만 나오는 놈 (뽑기 목록엔 안 뜸)
  alien:{ e:'👾', n:'외계생명', base:6, r:'uncommon', noOffer:true,
    d:'인접한 👾 외계생명 1개당 +6. 무리를 지으면 무섭다',
    effect:function(c){ var k=c.adj('alien').length; if(k) c.addSelf(6*k); } },
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
  var extra = { coins:0, notes:[], mul:1, purityBoost:0 };

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
        morph: function(t,id,keepMem){ if(!SYMBOLS[id]) return;
          t.entry.id = id; if(!keepMem) t.entry.mem = {}; t.val = baseOf(t.entry); },
        gain: function(n){ if (!n) return; extra.coins += n; commit(); },
        spinMul: function(m){ extra.mul = Math.min(extra.mul * m, SPIN_MUL_CAP); },
        purityBoost: function(n){ extra.purityBoost += n; },
        topCount: function(){                       // 판에서 가장 많은 종류의 개수
          var cnt = {}, best = 0;
          for (var i=0;i<cells.length;i++){
            if (!alive(cells[i])) continue;
            var id = cells[i].entry.id;
            cnt[id] = (cnt[id]||0) + 1;
            if (cnt[id] > best) best = cnt[id];
          }
          return best;
        },
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

  var total = extra.coins, counts = {}, top = 0;
  for (var i=0; i<cells.length; i++){
    if (!alive(cells[i])) continue;
    total += cells[i].val;
    var id = cells[i].entry.id;
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > top) top = counts[id];
  }
  var filled = 0;
  for (var i=0; i<cells.length; i++) if (alive(cells[i])) filled++;
  var pur = purityMul(top + extra.purityBoost, filled);
  if (extra.mul !== 1) total = Math.round(total * extra.mul);
  if (pur !== 1)       total = Math.round(total * pur);
  return { total: total, notes: extra.notes, mul: extra.mul,
           purity: pur, purityTop: top + extra.purityBoost, filled: filled };
}

function removeFromDeck(deck, entry){
  for (var i=0;i<deck.length;i++)
    if (deck[i].uid === entry.uid){ deck.splice(i,1); return; }
}

/* 화물칸에 그냥 들고만 있어도 소모량을 깎아주는 심볼 (보급 쿠폰) */
function costCutOf(deck, cost){
  var flat = 0, pct = 0;
  for (var i=0;i<deck.length;i++){
    var d = SYMBOLS[deck[i].id];
    if (!d) continue;
    if (d.costCut) flat += d.costCut;
    if (d.costCutPct) pct += d.costCutPct;
  }
  if (pct > COST_CUT_MAX) pct = COST_CUT_MAX;   // 쿠폰 도배로 소모량을 0으로 만드는 걸 막음
  return flat + Math.round((cost || 0) * pct);
}

/* 구역이 깊어질수록 희귀·전설이 잘 나오게.
   1구역은 흔함 판이고(보통이 3장 중 하나 뜰까 말까), 희귀는 2구역부터,
   전설은 3구역부터 얼굴을 비친다. 초반부터 보라색이 쏟아지면
   덱을 고민할 새도 없이 강한 걸 줍는 게임이 되어버림 */
function weightFor(rar, round){
  round = round || 1;
  if (rar === 'uncommon') return Math.min(6 + (round-1) * 6, 30);
  if (rar === 'rare')     return round <= 1 ? 0 : Math.min((round-1) * 2.5, 22);
  if (rar === 'legend')   return round <= 2 ? 0 : Math.min((round-2) * 1.6, 10);
  return 60;
}

/* 어떤 심볼과 엮이는지. 설명문에 서로의 이모지를 쓰고 있으니 거기서 뽑아냄 —
   따로 표를 만들면 설명과 어긋나기 시작해서, 설명을 유일한 출처로 둠.
   내 설명이 가리키는 쪽(주는 관계)과, 남의 설명이 나를 가리키는 쪽(받는 관계)을 합침 */
function relatedOf(id){
  var me = SYMBOLS[id], out = [], selfRef = false;
  if (!me) return { ids: out, selfRef: false };
  for (var other in SYMBOLS){
    var o = SYMBOLS[other];
    var iPointAtIt = me.d.indexOf(o.e) >= 0;
    var itPointsAtMe = o.d.indexOf(me.e) >= 0;
    if (other === id){ selfRef = iPointAtIt; continue; }
    if (iPointAtIt || itPointsAtMe) out.push(other);
  }
  return { ids: out, selfRef: selfRef };
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
  RARITY:RARITY, SYMBOLS:SYMBOLS, START_DECK:START_DECK, COSTS:COSTS, HYDRO_BUD:HYDRO_BUD, HYDRO_MAX:HYDRO_MAX,
  costFor:costFor, spinsFor:spinsFor, mkEntry:mkEntry, baseOf:baseOf,
  shuffle:shuffle, makeCells:makeCells, fillCells:fillCells, resolve:resolve,
  removeFromDeck:removeFromDeck, costCutOf:costCutOf, rollChoices:rollChoices, weightFor:weightFor, relatedOf:relatedOf, purityMul:purityMul, PURITY:PURITY, PURITY_MIN:PURITY_MIN,
  ductChain:ductChain,
};
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
