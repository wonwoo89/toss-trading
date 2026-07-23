import { useEffect, useState } from 'react';
import { api } from '../api/client';

const POLL_MS = 30_000;

/**
 * AI 자동매매가 실행 중인 종목 집합 — 단일종목 트레이더(enabled)의 종목 +
 * 백그라운드 엔진(전역 enabled)의 활성 종목. 자산/포트폴리오 목록의 ★ 표시용.
 * 30초 폴링(가벼운 설정 조회 2건).
 */
export function useAutomatedSymbols(): Set<string> {
  const [symbols, setSymbols] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const next = new Set<string>();
      try {
        const auto = (await api.getAutoConfig()).result;
        if (auto.config.enabled) {
          for (const s of auto.config.symbols) {
            if (s.active) next.add(s.symbol.toUpperCase());
          }
        }
      } catch {
        // 조회 실패 — 이번 주기는 건너뜀
      }
      try {
        const live = (await api.getLiveTraderStatus()).result;
        if (live.config.enabled && live.config.symbol) next.add(live.config.symbol.toUpperCase());
      } catch {
        // 조회 실패 — 이번 주기는 건너뜀
      }
      if (!cancelled) {
        setSymbols((prev) => {
          // 내용이 같으면 기존 참조 유지(불필요한 리렌더 방지)
          if (prev.size === next.size && [...next].every((s) => prev.has(s))) return prev;
          return next;
        });
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return symbols;
}
