import type { InputHTMLAttributes } from 'react';

interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
}

/**
 * 토글 스위치 — on/off 설정용(체크박스의 스위치 형태).
 * 실제 입력은 숨긴 checkbox(role=switch)로 접근성을 유지한다.
 */
export function Switch({ checked, onChange, className, disabled, ...rest }: SwitchProps) {
  return (
    <label
      className={[
        'ui-switch',
        checked ? 'is-on' : '',
        disabled ? 'is-disabled' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        {...rest}
      />
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
    </label>
  );
}
