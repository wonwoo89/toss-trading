import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** 활성 상태에 추가할 클래스(예: 'is-danger' — 오토 모드 경고색). */
  activeClassName?: string;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * 세그먼티드 컨트롤 — 배타 선택 옵션 그룹(가격 모드·자동매매 모드 등).
 * 미니멀·보더리스: 트랙(bg-subtle) 위에 활성 아이템만 떠 있는 형태.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={['ui-segmented', className ?? ''].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        const classes = [
          'ui-segmented__item',
          active ? 'is-active' : '',
          active && option.activeClassName ? option.activeClassName : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={classes}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
