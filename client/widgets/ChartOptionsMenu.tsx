import { useEffect, useRef, useState } from 'react';

interface ChartOptionsMenuProps {
  realtimeForced?: boolean;
  onRealtimeForcedChange?: (forced: boolean) => void;
  bollingerVisible: boolean;
  onBollingerVisibleChange: (visible: boolean) => void;
  supertrendVisible: boolean;
  onSupertrendVisibleChange: (visible: boolean) => void;
}

const PANEL_WIDTH = 220;

/**
 * 차트 렌더링 옵션(실시간·볼린저·슈퍼트렌드) 드롭다운 팝오버.
 * 툴바에 체크박스를 나열하지 않고 슬라이더 아이콘 버튼 하나로 접는다.
 * chart-panel 이 overflow:hidden 이라 패널은 position:fixed + 트리거 좌표로 띄운다
 * (AutoTradePanel 툴팁과 동일한 클리핑 회피 패턴). 스크롤 시 닫아 위치 어긋남 방지.
 */
export function ChartOptionsMenu({
  realtimeForced,
  onRealtimeForcedChange,
  bollingerVisible,
  onBollingerVisibleChange,
  supertrendVisible,
  onSupertrendVisibleChange,
}: ChartOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (rect) {
          setPos({
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
          });
        }
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <div className="chart-options" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`chart-options__trigger${open ? ' is-open' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        title="차트 표시 옵션"
        onClick={toggleOpen}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
          <circle cx="9" cy="7" r="2.4" />
          <circle cx="15" cy="12" r="2.4" />
          <circle cx="8" cy="17" r="2.4" />
        </svg>
      </button>

      {open && pos && (
        <div
          className="chart-options__panel"
          role="menu"
          aria-label="차트 표시 옵션"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH }}
        >
          {onRealtimeForcedChange && (
            <label
              className="chart-options__row"
              title="켜면 장 세션(프리/데이/애프터/정규)·주말과 무관하게 시세·차트를 계속 갱신합니다."
            >
              <input
                type="checkbox"
                checked={Boolean(realtimeForced)}
                onChange={(e) => onRealtimeForcedChange(e.target.checked)}
              />
              실시간 갱신
            </label>
          )}
          <label className="chart-options__row" title="볼린저밴드 표시 켜기/끄기">
            <input
              type="checkbox"
              checked={bollingerVisible}
              onChange={(e) => onBollingerVisibleChange(e.target.checked)}
            />
            볼린저밴드
          </label>
          <label
            className="chart-options__row"
            title="슈퍼트렌드(ATR 추세선) — 상승=빨강, 하락=파랑"
          >
            <input
              type="checkbox"
              checked={supertrendVisible}
              onChange={(e) => onSupertrendVisibleChange(e.target.checked)}
            />
            슈퍼트렌드
          </label>
        </div>
      )}
    </div>
  );
}
