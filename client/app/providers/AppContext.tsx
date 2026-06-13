import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../shared/api/client';
import { toNumber, unwrapResult } from '../lib/parse';
import type { Account } from '../types';

interface AppContextValue {
  accounts: Account[];
  selectedAccountSeq?: string;
  setSelectedAccountSeq: (accountSeq: string) => void;
  buyingPower?: number;
  setBuyingPower: (value?: number) => void;
  totalMarketValue?: number;
  setTotalMarketValue: (value?: number) => void;
  exchangeRate?: number;
  isReady: boolean;
  bootstrapError: string | null;
}

const AppContext = createContext<AppContextValue | null>(null);

let bootstrapPromise: Promise<void> | null = null;

export function AppProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountSeq, setSelectedAccountSeq] = useState<string>();
  const [buyingPower, setBuyingPower] = useState<number>();
  const [totalMarketValue, setTotalMarketValue] = useState<number>();
  const [exchangeRate, setExchangeRate] = useState<number>();
  const [isReady, setIsReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const accountsRes = await api.getAccounts();
        const accountList = unwrapResult(accountsRes).map((account) => ({
          accountSeq: account.accountSeq,
          accountNo: account.accountNo,
          accountName: account.accountType ?? account.accountNo,
        }));

        setAccounts(accountList);
        setSelectedAccountSeq(String(accountList[0]?.accountSeq ?? ''));

        const exchangeRes = await api.getExchangeRate();
        setExchangeRate(toNumber(unwrapResult(exchangeRes).rate));
      })();
    }

    bootstrapPromise
      .then(() => {
        setBootstrapError(null);
        setIsReady(true);
      })
      .catch((error: unknown) => {
        bootstrapPromise = null;
        setBootstrapError(error instanceof Error ? error.message : '초기화에 실패했습니다.');
      });
  }, []);

  useEffect(() => {
    if (!isReady || !selectedAccountSeq) return;

    void api
      .getBuyingPower(selectedAccountSeq)
      .then((res) => setBuyingPower(toNumber(unwrapResult(res).cashBuyingPower)))
      .catch(() => {});
  }, [isReady, selectedAccountSeq]);

  const value = useMemo(
    () => ({
      accounts,
      selectedAccountSeq,
      setSelectedAccountSeq,
      buyingPower,
      setBuyingPower,
      totalMarketValue,
      setTotalMarketValue,
      exchangeRate,
      isReady,
      bootstrapError,
    }),
    [
      accounts,
      bootstrapError,
      buyingPower,
      exchangeRate,
      isReady,
      selectedAccountSeq,
      totalMarketValue,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppProvider');
  }
  return context;
}

export function useRequireAccountSeq() {
  const { selectedAccountSeq } = useAppContext();

  return useCallback(() => {
    if (!selectedAccountSeq) {
      throw new Error('계좌를 먼저 선택해 주세요.');
    }
    return selectedAccountSeq;
  }, [selectedAccountSeq]);
}
