const WARNING_LABELS: Record<string, string> = {
  CAUTION: '투자유의',
  WARNING: '투자경고',
  RISK: '투자위험',
  DELISTING: '상장폐지 예정',
  SUSPENDED: '거래정지',
  HALTED: '거래중단',
  HIGH_VOLATILITY: '변동성 주의',
  LOW_LIQUIDITY: '유동성 주의',
}

export function formatWarningLabel(warningType: string) {
  return WARNING_LABELS[warningType] ?? warningType
}

export function formatWarningSummary(warnings: string[]) {
  if (warnings.length === 0) return undefined
  return warnings.map(formatWarningLabel).join(' · ')
}