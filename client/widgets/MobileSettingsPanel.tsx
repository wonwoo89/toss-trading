import { useTheme } from '../app/providers/ThemeContext';
import { useWakeLock } from '../shared/hooks/useWakeLock';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Switch } from '../shared/ui/Switch';
import { Typography } from '../shared/ui/Typography';
import type { ThemePreference } from '../shared/lib/themePreference';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '시스템' },
  { value: 'dark', label: '다크' },
  { value: 'light', label: '라이트' },
];

/**
 * 모바일(하단 탭) 레이아웃의 설정 탭. 헤더 제거로 갈 곳을 잃은 컨트롤들을 모아 표시:
 * 테마(세그먼티드) · 화면 꺼짐 방지(스위치).
 */
export function MobileSettingsPanel() {
  const { preference, setPreference } = useTheme();
  const wakeLock = useWakeLock();

  return (
    <section className="mobile-settings-panel" aria-label="설정">
      <div className="mobile-settings-row">
        <Typography size={14} className="mobile-settings-row__label">테마</Typography>
        <SegmentedControl
          aria-label="테마 선택"
          options={THEME_OPTIONS}
          value={preference}
          onChange={setPreference}
        />
      </div>
      {wakeLock.supported && (
        <div className="mobile-settings-row">
          <Typography size={14} className="mobile-settings-row__label">화면 꺼짐 방지</Typography>
          <Switch
            checked={wakeLock.enabled}
            onChange={() => wakeLock.toggle()}
            aria-label="화면 꺼짐 방지"
          />
        </div>
      )}
    </section>
  );
}
