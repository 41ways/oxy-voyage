# 우주탐험

슬롯머신 로그라이크. 릴을 굴려 나온 심볼(elements)의 시너지로 산소를 만들고,
구역이 끝날 때 생명유지장치가 산소를 가져간다. 못 대면 표류 — 얼마나 멀리 갔나가 기록.

의존성 없음. `index.html` 하나 열면 끝.

```bash
open index.html
```

## 구조

| 구간 | 하는 일 |
|---|---|
| `SYMBOLS` | 심볼 테이블. 게임의 내용물은 전부 여기 |
| `resolve()` | 칸마다 `effect(c)` 훅을 순서대로 실행 |
| `rollReels()` / `draw()` | 릴 연출 + canvas 렌더 |
| `settleLifeSupport()` | 구역 정산, 정비, 다음 구역 |

## 심볼 추가하는 법

`SYMBOLS`에 항목 하나 붙이면 뽑기 목록·툴팁·화물칸에 자동으로 붙는다.

```js
solar:{ e:'☀️', n:'태양광 패널', base:1, r:'common', d:'인접한 심볼이 서로 전부 다르면 +5',
  effect(c){ const a=c.adj(); if(!a.length) return;
    if(new Set(a.map(o=>o.entry.id)).size === a.length) c.addSelf(5); } },
```

필드

- `e` 이모지 / `n` 이름 / `base` 기본값 / `r` 등급(`common` `uncommon` `rare` `legend`) / `d` 설명
- `baseOf(entry)` 기본값이 인스턴스마다 다를 때 (수경재배처럼 자라는 것)
- `badge(entry)` 칸 좌상단에 띄울 짧은 글자 (남은 턴, 누적치)
- `costCut` 구역 소모량을 깎아주는 심볼
- `noOffer: true` 뽑기 목록에 안 뜸 (부화·변신으로만 얻는 것)

`effect(c)`에서 쓸 수 있는 것

| 호출 | 설명 |
|---|---|
| `c.self` | 지금 칸 |
| `c.adj(...ids)` | 인접 8칸 (id 주면 필터) |
| `c.all/row/col(...ids)` | 판 전체 / 같은 행 / 같은 열 |
| `c.emptyAdj()` | 인접한 빈칸 수 |
| `c.addSelf(n)` `c.add(t,n)` `c.mul(t,m)` | 값 조작 |
| `c.kill(t)` | 파괴 (화물칸에서도 영구 제거) |
| `c.morph(t,id)` | 다른 심볼로 변신 |
| `c.gain(n)` | 칸과 무관하게 산소 획득 |
| `c.deckAdd(id)` | 화물칸에 심볼 추가 |
| `c.link(t)` | 연출용으로 칸을 묶음 (조회 계열은 자동) |
| `c.rand()` `c.note(msg)` | 난수, 항해일지 한 줄 |

조회 계열(`adj` `all` `row` `col`)이 돌려준 칸과 `add/mul/kill`의 대상은 자동으로
연출 링크에 묶인다. 점수를 하나씩 보여줄 때 "얘 때문에 이만큼"이 같이 빛나는 게 이것.

효과는 왼쪽 위 칸부터 순서대로 실행된다. 그래서 **먼저 죽으면 효과를 못 쓴다**.

## 현재 상태 (v0.1)

- 흔함 10종 + 부화 전용 1종만 투입. 보통/희귀/전설은 논의하면서 채우는 중
- 아이템·유물 없음, 기록은 localStorage
