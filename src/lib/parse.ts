export function unwrapResult<T>(payload: { result?: T }): T {
  if (payload.result === undefined) {
    throw new Error('API 응답에 result가 없습니다.')
  }
  return payload.result
}

export function toNumber(value?: string | number | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}