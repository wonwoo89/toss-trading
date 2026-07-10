import { Link } from 'react-router-dom';
import { MobileLayoutToggle } from './MobileLayoutToggle';
import { ThemeToggle } from './ThemeToggle';
import { WakeLockToggle } from './WakeLockToggle';

/**
 * v2(하단 탭) 레이아웃의 설정 탭. 헤더 제거로 갈 곳을 잃은 컨트롤들을 모아 표시:
 * 테마 · 화면 꺼짐 방지 · 레이아웃 전환(v1 복귀) · 백테스트 진입.
 */
export function MobileSettingsPanel() {
  return (
    <section className="mobile-settings-panel" aria-label="설정">
      <div className="mobile-settings-row">
        <span className="mobile-settings-row__label">테마 (라이트/다크)</span>
        <ThemeToggle />
      </div>
      <div className="mobile-settings-row">
        <span className="mobile-settings-row__label">화면 꺼짐 방지</span>
        <WakeLockToggle />
      </div>
      <div className="mobile-settings-row">
        <span className="mobile-settings-row__label">신규 레이아웃 (끄면 기존 화면)</span>
        <MobileLayoutToggle />
      </div>
      <div className="mobile-settings-row">
        <span className="mobile-settings-row__label">신호 백테스트</span>
        <Link className="mobile-settings-row__link" to="/backtest">
          열기
        </Link>
      </div>
    </section>
  );
}
