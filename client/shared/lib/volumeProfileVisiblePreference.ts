const STORAGE_KEY = 'toss-trading:chart-volume-profile-visible';

/**
 * 차트 매물대(볼륨 프로파일) 표시 여부. 종목 전환 시 리마운트돼도 유지되도록
 * localStorage 에 영속한다. 기본값은 표시(true) — 명시적으로 끈 경우에만 false.
 */
export function getStoredVolumeProfileVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setStoredVolumeProfileVisible(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? 'true' : 'false');
  } catch {
    // ignore storage write errors
  }
}

const BINS_STORAGE_KEY = 'toss-trading:chart-volume-profile-bins';
export const VOLUME_PROFILE_BINS_MIN = 5;
export const VOLUME_PROFILE_BINS_MAX = 120;
export const VOLUME_PROFILE_BINS_DEFAULT = 30;

export function clampVolumeProfileBins(bins: number): number {
  if (!Number.isFinite(bins)) return VOLUME_PROFILE_BINS_DEFAULT;
  return Math.min(VOLUME_PROFILE_BINS_MAX, Math.max(VOLUME_PROFILE_BINS_MIN, Math.round(bins)));
}

/** 매물대 구간 수 — 지정된 값이 없으면 기본 30. 모든 종목 차트에 동일 적용(전역 저장). */
export function getStoredVolumeProfileBins(): number {
  try {
    const raw = localStorage.getItem(BINS_STORAGE_KEY);
    if (raw === null) return VOLUME_PROFILE_BINS_DEFAULT;
    return clampVolumeProfileBins(Number(raw));
  } catch {
    return VOLUME_PROFILE_BINS_DEFAULT;
  }
}

export function setStoredVolumeProfileBins(bins: number) {
  try {
    localStorage.setItem(BINS_STORAGE_KEY, String(clampVolumeProfileBins(bins)));
  } catch {
    // ignore storage write errors
  }
}
