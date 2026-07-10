import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Typography } from '../shared/ui/Typography';

interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** 정수만 허용(소수점 입력 차단). 기본 false(소수 허용). */
  integer?: boolean;
  /** 인풋을 설명하는 제목/타이틀(TextField 와 동일 구조). */
  label?: ReactNode;
  /** 인풋 내부 우측 단위 표시(%·주·$ 등). */
  unit?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  title?: string;
}

/**
 * 숫자 입력 필드 — TextField 의 숫자(blur-commit) 변형. 시각 구조는 TextField 와 동일
 * (ui-textfield: [라벨] + [박스(인풋+단위)]).
 *
 * type="number" 의 강제 변환/스피너 대신 문자열 상태로 자유롭게 편집하고,
 * 보정(min/max/정수)은 blur(확정) 시에만 적용한다 — 값을 지우거나 "0." 같은 중간 상태를
 * 입력해도 0.1 등으로 튕기지 않는다.
 *
 * - 가상 키보드: inputMode="decimal"(소수) / "numeric"(정수) — 숫자+소수점만 노출.
 * - 실제 type 은 text 라 number 의 검증/스피너 부작용이 없다.
 * - 편집 중(focus)엔 외부 value 변경으로 입력을 덮어쓰지 않는다(리셋은 blur 후 반영).
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  integer = false,
  label,
  unit,
  className,
  placeholder,
  disabled,
  title,
  'aria-label': ariaLabel,
}: NumberFieldProps) {
  const [text, setText] = useState(() => String(value));
  const focusedRef = useRef(false);
  const inputId = useId();

  // 외부 value 변경(프로그램적 리셋 등)을 반영하되, 사용자가 편집 중일 땐 건드리지 않는다.
  useEffect(() => {
    if (!focusedRef.current && Number(text) !== value) {
      setText(Number.isFinite(value) ? String(value) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 허용 문자만 남긴다: 숫자, (소수 허용 시) 점 1개.
  const sanitize = (raw: string) => {
    let s = raw.replace(integer ? /[^0-9]/g : /[^0-9.]/g, '');
    if (!integer) {
      const dot = s.indexOf('.');
      if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
    }
    return s;
  };

  const inRange = (n: number) =>
    Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max);

  const handleChange = (raw: string) => {
    const s = sanitize(raw);
    setText(s);
    if (s.trim() === '') return; // 빈 값/중간 상태는 보류 — blur 에서 확정
    const n = Number(s);
    if (inRange(n)) onChange(integer ? Math.floor(n) : n); // 범위 내 유효값만 즉시 반영
  };

  // blur: 비었거나 범위 밖이면 보정해 확정(min 으로 클램프, 정수화).
  const commit = () => {
    focusedRef.current = false;
    const n = Number(text);
    let next = text.trim() !== '' && Number.isFinite(n) ? n : (min ?? 0);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (integer) next = Math.floor(next);
    setText(String(next));
    onChange(next);
  };

  return (
    <div className={['ui-textfield', className ?? ''].filter(Boolean).join(' ')} title={title}>
      {label !== undefined && label !== null && (
        <Typography as="label" size={12} className="ui-textfield__label" htmlFor={inputId}>
          {label}
        </Typography>
      )}
      <label className="ui-textfield__box">
        <input
          id={inputId}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          spellCheck={false}
          className="ui-textfield__input"
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          value={text}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={commit}
        />
        {unit && (
          <Typography size={12} className="ui-textfield__unit" aria-hidden="true">
            {unit}
          </Typography>
        )}
      </label>
    </div>
  );
}
