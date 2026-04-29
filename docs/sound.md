# 사운드 시스템 핸드오프

다른 환경에서 작업 재개할 때 여기서 시작하세요.

## 한눈에 보기

- **방향성**: hit/kill만 — 발사음/캐스팅음 없음. 비주얼이 발사를 표현하므로 사운드는 "맞았다/죽었다"만 담당.
- **테마**: ATOM (원자/양자/핵). 모두 procedural — 외부 샘플 파일 0개.
- **사운드 랩**: 페이지 로드 시 `AtomSoundLab` 오버레이가 먼저 뜸. 후보 10종 미리듣기 + ×5/×10 stagger 테스트 가능. "게임 시작" 누르면 닫힘.

## 1단계 스킬 사운드 매핑

| 스킬 | 패턴 | 사운드 | API |
|---|---|---|---|
| 물 (장판 슬로우) | 30프레임 펄스 | graviton-thud | `playHitField(count)` |
| 흙 (모래지옥) | 30프레임 펄스 | graviton-thud | `playHitField(count)` |
| 불 (화염방사) | 10프레임 콘 | graviton-thud | `playHitField(count)` |
| 빛 (관통 빔) | 빔 발사 시 | isotope-warp | `playHitBeam(count)` |
| 전기 (체인) | 최대 10 stagger | isotope-warp | `playHitChain(count)` |
| 암흑 (중력 우물) | 40프레임 펄스 | graviton-thud | `playHitField(count)` |

`count`는 이번 펄스/샷에 맞은 적 수. **타격당 한 번씩** 사운드가 stagger되어 재생됩니다.

처치음(`playKill`)은 일반/보스 분기로 `killEnemy()` 한 곳에서 자동 호출.

## 파일 위치

```
src/sound/
├── context.ts          # AudioContext, master gain, limiter
├── primitives.ts       # playNoise/playOsc/playCrackleBurst/group
├── gameSounds.ts       # playHitField/playHitBeam/playHitChain/playHit/playKill
├── atomVariants.ts     # 10종 ATOM 변종 (gravitonThud, isotopeWarp 등)
└── AtomSoundLab.tsx    # 초기 화면 미리듣기 패널
```

호출부는:
- `src/game/engine.ts` 5180~5470 — 1단계 스킬 hit
- `src/game/engine.ts` 5794 — `killEnemy()` 안에서 `playKill`

## 튜닝 포인트 (자주 만질 곳)

| 파라미터 | 위치 | 현재값 | 의미 |
|---|---|---|---|
| 마스터 볼륨 | `context.ts` master.gain | 0.23 | 게임 전체 볼륨 |
| Limiter threshold | `context.ts` limiter | -8dB | 누적 피크 잡는 기준 |
| 필드 stagger gap | `gameSounds.ts` `playHitField` | 70ms | 펄스 내 사운드 간격 |
| 필드 cap | `gameSounds.ts` `MAX_FIELD_SOUNDS` | 5 | 펄스당 최대 사운드 수 |
| 빔 stagger gap | `gameSounds.ts` `playHitBeam` | 60ms | 관통 적 사이 간격 |
| 빔 cap | `gameSounds.ts` `MAX_BEAM_SOUNDS` | 6 | 관통 시 최대 사운드 |
| 체인 stagger | `gameSounds.ts` `playHitChain` | 80ms | 전기 체인 링크 간격 |

**stagger gap 가이드**: 50ms 미만(20Hz+) = "buzz/grind"로 융합돼 들림. 50~100ms = "분리된 비트". 너무 길면 펄스 사이 누적 발생.

## 누적 폭주 방지 장치 (이미 적용됨)

1. **Master limiter** (`context.ts`) — DynamicsCompressor가 destination 직전에 위치. 단발은 영향 없고 누적 피크만 깎음.
2. **Per-instance freq 지터** — `gravitonThud`, `isotopeWarp`, `coreCollapse` 모두 발사마다 freq ±5~10% 랜덤. 동일 위상 누적(공명/클리핑) 방지.
3. **Cap** — `playHitField` 5개, `playHitBeam` 6개로 제한. 50마리 장판에 들어와도 5개만 들림 (시각 피드백이 나머지 커버).

## 남은 작업 (TODO)

### 우선순위 높음
- [ ] **2단계/3단계 콤보 스킬 사운드** — `src/game/effects/{Element1+Element2}Effect.ts` 41+개 파일들. 현재 사운드 호출 없음. 콤보별 매핑 또는 fallback `playHit()` 결정 필요.
- [ ] **액티브 스킬 사운드** — `TidalWaveSkill`, `InfernoSkill`, `EarthquakeSkill`, `ThunderStormSkill`, `LightJudgmentSkill`, `AbyssSkill`. 큰 스킬이라 `core-collapse` 같은 묵직한 사운드 어울릴 듯.
- [ ] **플레이어 피격음** — 자기가 맞을 때 사운드 없음. 생존 게임이라 중요한 피드백.

### 우선순위 중간
- [ ] **처치음에 ATOM 변종 사용** — 현재 `playKill`이 인라인 합성. 일반=`atomicDecay`, 보스=`coreCollapse` 사용으로 통일 검토.
- [ ] **불(fire) 별도 처리** — 10프레임(167ms) 펄스라 `playHitField`의 70ms × 5 = 350ms가 다음 펄스를 넘김. fire만 짧은 gap(예: 25ms × cap 3) 또는 단일 사운드로 분리 검토.
- [ ] **AtomSoundLab 출시 전 기본 닫기** — 사운드 확정되면 `App.tsx`의 `useState(true)` → `false`로 변경 또는 dev-only 토글.

### 우선순위 낮음
- [ ] **`@pixi/sound` 의존성 제거** — `samplePlayer.ts` 삭제로 더 이상 사용 안 함. `package.json`에서 prune 가능.
- [ ] **레거시 `playHit()` 정리** — 1단계 스킬은 모두 per-element 함수로 전환됨. 2/3단계 콤보 매핑 끝나면 `playHit()` 제거 검토.

## 결정 로그 (왜 이렇게 됐나)

- **샘플 파일 → procedural** — 6속성 × 조합(C(6,2)=15, C(6,3)=20)이라 속성별 샘플 작성/수급 비현실적. Web Audio 합성으로 무한 변주.
- **속성별 사운드 → 공통 사운드** — 콤보 무기마다 새 사운드 만들 필요 없음. 비주얼이 속성을 표현하니 사운드는 "타격감"만 담당.
- **마스터 볼륨 0.23** — 사용자 요청. 0.7 기본은 너무 컸음.
- **Limiter는 보호용 한계기** — 게임 오디오 표준. 개별 사운드의 동적 영역엔 영향 없음, 누적 피크만 잡음.
- **Stagger 50ms 이상** — 인간 청각의 "roughness" 인지 영역(20-40Hz) 회피. 그 아래는 "드득드득" 버즈로 들림.

## 빠른 시작

```bash
npm install
npm run dev
```

페이지 열리면 ATOM Sound Lab이 자동으로 뜸. 후보 들어보고 "게임 시작" 누르면 게임 진입.

타입체크: `npx tsc -b`

## 진행 시 권장 순서

1. **현재 상태 확인** — `npm run dev` 실행, 1단계 스킬 6종 모두 발동해서 사운드 정상 동작 체크
2. **남은 작업 중 우선순위 선택** — 위 TODO 목록에서 하나
3. **수정 → 타입체크 → 들어보기** 사이클
4. **튜닝 시 주의** — `playHitField`의 gap/cap 두 개가 가장 민감. 한 번에 한 개씩 조정해서 효과 확인
