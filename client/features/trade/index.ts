// trade feature barrel (FSD)
// 향후 order submission, take-profit, trade actions 등을 이 슬라이스로 이동

export {
  useSymbolTrading,
  HOLDINGS_POLL_MS,
  // 기타 trading 관련 constants / hooks 는 여기서 re-export
} from '../../shared/hooks/useSymbolTrading';

// TODO: 이곳에 useOrderSubmission, useCancelOrder 등 feature hook 추가 예정
