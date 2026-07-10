import type { ElementType, HTMLAttributes } from 'react';

/** 허용 폰트 크기(px) — 이 목록 밖의 크기는 타입 에러로 차단한다. */
export type TypographySize =
  | 10
  | 12
  | 14
  | 16
  | 18
  | 20
  | 24
  | 28
  | 32
  | 36
  | 40
  | 48
  | 52
  | 56;

interface TypographyProps extends HTMLAttributes<HTMLElement> {
  /** 폰트 크기(px). 고정 스케일만 허용. 기본 14. */
  size?: TypographySize;
  /** 렌더 태그 — 의미(문단/제목/인라인)에 맞게 지정. 기본 span. */
  as?: ElementType;
  /** 한 줄 말줄임(ellipsis) 처리. */
  truncate?: boolean;
  /** as="label" 일 때 연결할 컨트롤 id. */
  htmlFor?: string;
}

/**
 * 타이포그래피 컴포넌트 — 텍스트는 이 컴포넌트로만 그린다.
 * - 폰트 크기: 고정 스케일(10~56)만 사용
 * - line-height: 1.5 고정
 * - 크기·행간은 인라인 스타일로 적용해 기존 CSS 클래스의 font-size 를 항상 이긴다
 *   (색·여백·정렬 등은 기존 className 으로 계속 제어)
 */
export function Typography({
  size = 14,
  as: Tag = 'span',
  truncate = false,
  className,
  style,
  ...rest
}: TypographyProps) {
  const classes = ['ui-typo', truncate ? 'ui-typo--truncate' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <Tag
      className={classes}
      style={{ fontSize: `${size}px`, lineHeight: 1.5, ...style }}
      {...rest}
    />
  );
}
