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
