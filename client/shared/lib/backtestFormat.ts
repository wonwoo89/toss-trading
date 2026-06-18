/** 백테스트 결과 표시용 포맷 헬퍼(컴포넌트 파일과 분리해 Fast Refresh 경고 방지). */
export function fmtBacktestPct(value: number, signed = false) {
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function backtestBiasClass(value: number) {
  if (value > 0.0001) return 'backtest-pos';
  if (value < -0.0001) return 'backtest-neg';
  return '';
}
