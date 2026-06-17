import { useMemo } from 'react';
import { useAppContext } from '../../app/providers/AppContext';

/**
 * 헤더의 계좌 요약(총 계좌·환율) 표시에 쓰는 파생값.
 * 데스크톱 인라인 표시(HeaderAccountBalance)와 모바일 '내 계좌' 드롭다운
 * (HeaderAccountMenu)이 동일 계산을 공유하도록 한 곳으로 모았다.
 */
export function useAccountSummary() {
  const { isReady, buyingPower, totalMarketValue, exchangeRate } = useAppContext();

  const totalAccountValue = useMemo(() => {
    if (buyingPower === undefined && totalMarketValue === undefined) return undefined;
    return (buyingPower ?? 0) + (totalMarketValue ?? 0);
  }, [buyingPower, totalMarketValue]);

  const totalAccountValueKrw = useMemo(() => {
    if (totalAccountValue === undefined || exchangeRate === undefined) return undefined;
    return totalAccountValue * exchangeRate;
  }, [exchangeRate, totalAccountValue]);

  return { isReady, exchangeRate, totalAccountValue, totalAccountValueKrw };
}
