/** US 주식 최소 호가단위(Reg NMS Rule 612): $1 이상은 $0.01, $1 미만은 $0.0001(서브-페니). */
export function tickSizeFor(price: number) {
  return price < 1 ? 0.0001 : 0.01;
}

/** USD 지정가를 해당 가격대의 호가단위로 내림한다($1 이상 센트, $1 미만 서브-페니). */
export function floorToTick(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return value;
  const inv = Math.round(1 / tickSizeFor(value)); // 0.01→100, 0.0001→10000 (부동소수 오차 방지)
  return Math.floor(value * inv) / inv;
}

/** USD 지정가를 호가단위로 올림한다 — 목표가 이상을 보장해야 하는 수익률 매도 지정가 등. */
export function ceilToTick(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return value;
  const inv = Math.round(1 / tickSizeFor(value));
  // 곱셈 부동소수 오차로 정확히 틱에 있는 값이 한 틱 더 올라가지 않게 미세 보정
  return Math.ceil(value * inv - 1e-9) / inv;
}
