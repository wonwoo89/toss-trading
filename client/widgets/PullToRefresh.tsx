import { useEffect, useRef, useState } from 'react';

/**
 * 끌어당겨 새로고침(터치 전용) — iOS PWA(standalone)에는 브라우저 새로고침 수단이 없어
 * 페이지 최상단에서 아래로 당기면 전체 리로드한다.
 *
 * 오작동 방지(제외 규칙):
 *  - 차트(팬/줌 제스처)와 canvas, 입력 요소, 리사이즈 핸들에서 시작한 터치는 무시
 *  - 내부 스크롤 가능한 조상(호가 본문·모달·로그 패널 등)이 있으면 무시
 *  - 페이지가 최상단(scrollTop ≤ 2)일 때만 동작
 */

const THRESHOLD = 80; // 이만큼 당기면(감쇠 적용 후) 놓았을 때 새로고침
const MAX_PULL = 130;
const DAMPING = 0.45; // 손가락 이동 대비 인디케이터 이동 비율(고무줄 감)

function isExcludedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      '.chart-panel, canvas, input, textarea, select, button, .order-split-handle, .mobile-search-overlay'
    )
  ) {
    return true;
  }
  // 내부 스크롤 컨테이너(호가 본문·모달 등) 안에서 시작한 당김은 그 영역의 스크롤로 존중.
  let el: Element | null = target;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const reset = () => {
      startYRef.current = null;
      pullRef.current = 0;
      setPull(0);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1) return;
      const scroller = document.scrollingElement;
      if (!scroller || scroller.scrollTop > 2) return;
      if (isExcludedTarget(e.target)) return;
      startYRef.current = e.touches[0].clientY;
      pullRef.current = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (refreshingRef.current || startYRef.current === null) return;
      const scroller = document.scrollingElement;
      if (!scroller || scroller.scrollTop > 2) {
        reset();
        return;
      }
      const delta = e.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        if (pullRef.current !== 0) {
          pullRef.current = 0;
          setPull(0);
        }
        return;
      }
      // 바디 러버밴드 대신 인디케이터로 표현(취소 가능한 이벤트만)
      if (e.cancelable) e.preventDefault();
      const next = Math.min(MAX_PULL, delta * DAMPING);
      pullRef.current = next;
      setPull(next);
    };

    const onTouchEnd = () => {
      if (startYRef.current === null) return;
      const reached = pullRef.current >= THRESHOLD;
      startYRef.current = null;
      if (reached && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        window.location.reload();
        return;
      }
      pullRef.current = 0;
      setPull(0);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  if (pull <= 0 && !refreshing) return null;

  const ready = refreshing || pull >= THRESHOLD;
  return (
    <div
      className="pull-refresh"
      aria-hidden="true"
      style={{
        transform: `translate(-50%, ${Math.round(Math.min(pull, MAX_PULL))}px)`,
        opacity: refreshing ? 1 : Math.min(1, pull / 48),
      }}
    >
      <span
        className={`pull-refresh__icon${ready ? ' is-ready' : ''}${refreshing ? ' is-spinning' : ''}`}
      >
        ⟳
      </span>
      <span className="pull-refresh__text">
        {refreshing ? '새로고침 중…' : ready ? '놓으면 새로고침' : '당겨서 새로고침'}
      </span>
    </div>
  );
}
