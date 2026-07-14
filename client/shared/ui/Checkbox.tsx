import type { InputHTMLAttributes, ReactNode } from 'react';
import { Typography } from './Typography';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  /** 체크박스 우측 라벨. */
  label?: ReactNode;
  /** 체크 상태 변경 콜백 — boolean 을 바로 전달. */
  onChange?: (checked: boolean) => void;
}

/**
 * 체크박스 — 공통 컴포넌트. label 요소로 감싸 어디를 눌러도 토글되고,
 * 박스와 라벨을 플렉스 중앙 정렬해 수직 정렬이 항상 맞는다(모바일 어긋남 수정).
 * 박스 모양은 전역 input[type='checkbox'] 스타일(직접 그린 네모)을 그대로 사용.
 */
export function Checkbox({ label, onChange, className, title, ...rest }: CheckboxProps) {
  return (
    <label className={['ui-checkbox', className ?? ''].filter(Boolean).join(' ')} title={title}>
      <input type="checkbox" onChange={(e) => onChange?.(e.target.checked)} {...rest} />
      {label !== undefined && label !== null && (
        <Typography size={12} className="ui-checkbox__label">
          {label}
        </Typography>
      )}
    </label>
  );
}
