import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'neutral' | 'accent' | 'buy' | 'sell' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 색상 변형 — neutral(기본), accent(주요 액션), buy/sell(매수·매도), ghost(저강조). */
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * 액션 버튼 — 미니멀·보더리스 디자인 시스템의 기본 버튼.
 * hover 는 배경 밝기, pressed 는 살짝 눌리는 스케일로 피드백한다.
 * type 기본값은 'button'(폼 안에서 의도치 않은 submit 방지).
 */
export function Button({
  variant = 'neutral',
  size = 'md',
  className,
  type,
  ...rest
}: ButtonProps) {
  const classes = [
    'ui-btn',
    `ui-btn--${variant}`,
    size !== 'md' ? `ui-btn--${size}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return <button type={type ?? 'button'} className={classes} {...rest} />;
}
