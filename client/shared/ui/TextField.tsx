import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Typography } from './Typography';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 인풋을 설명하는 제목/타이틀. 없으면 라벨 영역 생략. */
  label?: ReactNode;
  /** 일반 텍스트 / 넘버형. 넘버형은 소수 키보드(inputMode=decimal)를 띄우되
   *  네이티브 number 의 강제 변환·스피너 부작용을 피하려 실제 type 은 text 를 유지한다. */
  type?: 'text' | 'number';
  /** 인풋 내부 우측 단위 표시(%·주·$ 등). 없으면 공백. */
  unit?: string;
}

/**
 * 텍스트필드 — 디자인 시스템의 기본 인풋.
 * 구조: [라벨] + [박스(인풋 + 단위)]. 박스는 label 요소라 어디를 눌러도 인풋에 포커스된다.
 * 높이는 --control-height 로 버튼·세그먼티드와 정렬. 기본 속성: autoComplete off,
 * spellCheck false (필요 시 props 로 덮어쓰기 가능).
 */
export function TextField({
  label,
  type = 'text',
  unit,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <div className={['ui-textfield', className ?? ''].filter(Boolean).join(' ')}>
      {label !== undefined && label !== null && (
        <Typography as="label" size={12} className="ui-textfield__label" htmlFor={inputId}>
          {label}
        </Typography>
      )}
      <label className="ui-textfield__box">
        <input
          id={inputId}
          type="text"
          inputMode={type === 'number' ? 'decimal' : undefined}
          autoComplete="off"
          spellCheck={false}
          className="ui-textfield__input"
          {...rest}
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
