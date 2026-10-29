# 점프대 범위 판정 중복

`lib/roadster-sim/map.ts`의 `rampHeightAt`이 `rampAt`과 같은 점프대 범위 판정을 반복하고, `rampAt`이 돌려주는 `along`은 아무도 읽지 않는다. 동작에는 문제가 없고, 두 판정을 하나로 합치면 정리된다. (코드 리뷰 low에서 나온 지적)
