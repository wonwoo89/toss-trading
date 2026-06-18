import { Link, useSearchParams } from 'react-router-dom';
import { MultiBacktestPanel } from '../../widgets/MultiBacktestPanel';

export function BacktestPage() {
  const [params] = useSearchParams();
  const symbol = params.get('symbol') ?? undefined;

  return (
    <main className="backtest-page">
      <div className="backtest-head">
        <h1>신호 백테스트</h1>
        <Link to="/" className="backtest-back">
          ← 트레이딩으로
        </Link>
      </div>

      <p className="hint backtest-intro">
        보유 종목을 기본으로 불러와 동일한 전략 설정으로 한꺼번에 검증합니다. 차트 신호(강매수~강매도)를
        과거 캔들에 "그 시점 데이터만으로" 재계산해 적중률·기대값을 봅니다. 결과는 과거 통계일 뿐 미래를
        보장하지 않으며, 매매 권유가 아닙니다.
      </p>

      <MultiBacktestPanel initialExtraSymbol={symbol} />
    </main>
  );
}
