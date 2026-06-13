// trade feature barrel (FSD)
// 향후 order submission, take-profit, trade actions 등을 이 슬라이스로 이동

export {
  useSymbolTrading as useTrading,
  HOLDINGS_POLL_MS,
  // 기타 trading 관련 constants / hooks 는 여기서 re-export
  // trading page에서는 const data = useTrading({ symbol, accountSeq, ... }) 로 사용
} from '../../shared/hooks/useSymbolTrading';

// TODO: 이곳에 useOrderSubmission, useTradeActions 등 feature 전용 훅으로 점진 이동 예정
