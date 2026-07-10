import type { ButtonHTMLAttributes } from 'react';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 선택 상태 — 보더 없이 배경 틴트·글자색으로 표현. */
  selected?: boolean;
}

/**
 * 칩 — 선택/해제 상태가 있는 리스팅 아이템(수량 비율·익절률 옵션 등).
 * 미니멀·보더리스: 선택 시 액센트 틴트 배경 + 액센트 글자색.
 */
export function Chip({ selected = false, className, type, ...rest }: ChipProps) {
  const classes = ['ui-chip', selected ? 'is-selected' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return <button type={type ?? 'button'} aria-pressed={selected} className={classes} {...rest} />;
}
