// 주문 폼 키보드 단축키 안내. 데스크톱 헤더(테마 토글 옆)에 한 곳으로 모아 노출한다.
// 입력창에 포커스가 없을 때만 동작하는 단축키들이다(실제 핸들러는 OrderForm 에 있음).
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'A', label: '직접 매수 실행' },
  { keys: 'S', label: '직접 매도 실행' },
  { keys: 'Option + 1 ~ 9', label: '보유종목 빠른 이동' },
  { keys: '1 ~ 5', label: '수량 10·25·50·75·100%' },
  { keys: 'W', label: '수량 최대(100%)' },
  { keys: '+ / −', label: '수량 ±1' },
  { keys: '[ / ]', label: '가격 모드 이전 / 다음' },
  { keys: 'Tab', label: '다음 입력 항목' },
];

export function KeyboardShortcutsHelp() {
  return (
    <div className="order-shortcuts">
      <button
        type="button"
        className="order-shortcuts__trigger"
        aria-label="키보드 단축키 보기"
        aria-describedby="order-shortcuts-panel"
      >
        <span aria-hidden="true">⌨</span> 단축키
      </button>
      <div id="order-shortcuts-panel" role="tooltip" className="order-shortcuts__panel">
        <div className="order-shortcuts__title">키보드 단축키</div>
        <ul className="order-shortcuts__list">
          {SHORTCUTS.map((shortcut) => (
            <li key={shortcut.label}>
              <kbd className="order-shortcuts__keys">{shortcut.keys}</kbd>
              <span className="order-shortcuts__desc">{shortcut.label}</span>
            </li>
          ))}
        </ul>
        <div className="order-shortcuts__note">입력창에 포커스가 없을 때 동작합니다.</div>
      </div>
    </div>
  );
}
