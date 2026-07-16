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
export const VOLUME_PROFILE_BIN_CHOICES = [10, 20, 30, 50] as const;

/** 매물대 구간 수(기본 30). 허용 목록 밖 값은 30으로 정규화. */
export function getStoredVolumeProfileBins(): number {
  try {
    const parsed = Number(localStorage.getItem(BINS_STORAGE_KEY));
    if ((VOLUME_PROFILE_BIN_CHOICES as readonly number[]).includes(parsed)) return parsed;
  } catch {
    // ignore storage read errors
  }
  return 30;
}

export function setStoredVolumeProfileBins(bins: number) {
  try {
    localStorage.setItem(BINS_STORAGE_KEY, String(bins));
  } catch {
    // ignore storage write errors
  }
}
